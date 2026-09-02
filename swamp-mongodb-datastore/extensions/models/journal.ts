// Migration journal: every migration the maintenance model runs writes a
// before-image of each record it is about to touch, so the run can be
// reverted later.
//
// Two collections:
//   `_migrations`     — one header per run: kind, dryRun, status, counts.
//   `_migration_ops`  — one doc per touched record: {runId, seq, collection,
//                       _id, before, after}. Written BEFORE the mutation it
//                       describes; a crash mid-run leaves a revertable
//                       partial run whose status is `failed`.
//
// Revert replays a run's ops in reverse. An op is applied only when the
// target's current document still equals the op's after-image — a client
// write that landed after the migration is reported as a conflict and left
// alone unless `force` is set. A run is refused outright when a later,
// non-reverted migration touched any of the same ids; revert that one first.
//
// Control-plane records are journaled as `{_id, sha256}` only, never the
// bytes, because serve's token secrets live there.
//
// Lives in extensions/models/ (never imports from extensions/datastores/):
// packaging ships each entry point's own import graph only.

export type Doc = Record<string, unknown> & { _id: string };

export interface MigrationOp {
  collection: string;
  _id: string;
  before: Doc | null;
  after: Doc | null;
}

export interface OpDoc extends MigrationOp {
  _id: string;
  runId: string;
  seq: number;
  targetId: string;
}

export interface RunDoc {
  _id: string;
  kind: string;
  dryRun: boolean;
  status: "running" | "completed" | "failed" | "reverted";
  startedAt: Date;
  finishedAt: Date | null;
  counts: Record<string, number>;
  meta: Record<string, unknown>;
}

export interface RevertResult {
  runId: string;
  revertRunId: string | null;
  dryRun: boolean;
  opsTotal: number;
  restored: number;
  deleted: number;
  skippedConflicts: string[];
  refused: string | null;
}

/** Driver-shaped port; the real `Collection` satisfies it structurally. */
export interface JournalStore<T extends { _id: string }> {
  find(
    filter?: Record<string, unknown>,
    opts?: { projection?: Record<string, number> },
  ): AsyncIterable<T> & { toArray(): Promise<T[]> };
  findOne(filter?: Record<string, unknown>): Promise<T | null>;
  insertOne(doc: T): Promise<unknown>;
  updateOne(
    filter: Record<string, unknown>,
    update: { $set?: Partial<T> },
    opts?: { upsert?: boolean },
  ): Promise<unknown>;
  bulkWrite(
    ops: Record<string, unknown>[],
    opts?: { ordered?: boolean },
  ): Promise<unknown>;
}

export interface TargetStore {
  findOne(filter: Record<string, unknown>): Promise<Doc | null>;
  replaceOne(
    filter: Record<string, unknown>,
    doc: Doc,
    opts?: { upsert?: boolean },
  ): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
}

export interface Journal {
  start(run: {
    kind: string;
    dryRun: boolean;
    meta?: Record<string, unknown>;
  }): Promise<string>;
  /** Append before/after images. Call BEFORE applying the mutation. */
  record(runId: string, ops: MigrationOp[]): Promise<void>;
  finish(
    runId: string,
    status: "completed" | "failed",
    counts?: Record<string, number>,
  ): Promise<void>;
  get(runId: string): Promise<RunDoc | null>;
  revert(
    runId: string,
    opts?: { dryRun?: boolean; force?: boolean },
  ): Promise<RevertResult>;
}

export interface JournalDeps {
  runs: JournalStore<RunDoc>;
  ops: JournalStore<OpDoc>;
  target: (collection: string) => TargetStore;
  now?: () => Date;
  runId?: () => string;
}

const OPS_BATCH = 500;

export function createJournal(deps: JournalDeps): Journal {
  const now = deps.now ?? (() => new Date());
  const newRunId = deps.runId ?? (() => crypto.randomUUID());

  // Next sequence number per run. Scanned from the collection once per run
  // (a resumed run after a crash), then kept in memory: a fold journals
  // hundreds of batches, and rescanning the ops for every batch would be
  // quadratic in the run's size.
  const seqCursor = new Map<string, number>();
  async function nextSeq(runId: string): Promise<number> {
    const cached = seqCursor.get(runId);
    if (cached !== undefined) return cached;
    let max = -1;
    for await (
      const op of deps.ops.find({ runId }, { projection: { seq: 1 } })
    ) {
      if (op.seq > max) max = op.seq;
    }
    return max + 1;
  }

  async function record(runId: string, ops: MigrationOp[]): Promise<void> {
    if (ops.length === 0) return;
    let seq = await nextSeq(runId);
    seqCursor.set(runId, seq + ops.length);
    for (let i = 0; i < ops.length; i += OPS_BATCH) {
      const batch = ops.slice(i, i + OPS_BATCH).map((op) => ({
        insertOne: {
          document: {
            _id: `${runId}:${seq}`,
            runId,
            seq: seq++,
            collection: op.collection,
            targetId: op._id,
            before: op.before,
            after: op.after,
          },
        },
      }));
      await deps.ops.bulkWrite(batch, { ordered: true });
    }
  }

  async function opsOf(runId: string): Promise<OpDoc[]> {
    const out: OpDoc[] = [];
    for await (const op of deps.ops.find({ runId })) out.push(op);
    return out.sort((a, b) => a.seq - b.seq);
  }

  const journal: Journal = {
    async start({ kind, dryRun, meta }) {
      const runId = newRunId();
      await deps.runs.insertOne({
        _id: runId,
        kind,
        dryRun,
        status: "running",
        startedAt: now(),
        finishedAt: null,
        counts: {},
        meta: meta ?? {},
      });
      return runId;
    },

    record,

    async finish(runId, status, counts) {
      await deps.runs.updateOne({ _id: runId }, {
        $set: { status, finishedAt: now(), counts: counts ?? {} },
      });
    },

    async get(runId) {
      return await deps.runs.findOne({ _id: runId });
    },

    async revert(runId, opts) {
      const dryRun = opts?.dryRun !== false;
      const force = opts?.force === true;
      const run = await deps.runs.findOne({ _id: runId });
      if (run === null) {
        return refused(runId, dryRun, `run ${runId} not found`);
      }
      if (run.status === "reverted") {
        return refused(runId, dryRun, `run ${runId} is already reverted`);
      }
      if (run.status === "running") {
        return refused(runId, dryRun, `run ${runId} is still running`);
      }
      const ops = await opsOf(runId);
      const touched = new Set(ops.map((o) => `${o.collection}:${o.targetId}`));

      // A later migration that touched the same ids must be reverted first.
      // Revert runs are bookkeeping of undo, not migrations; the after-image
      // check below still protects the data they moved.
      for await (
        const later of deps.runs.find({
          startedAt: { $gt: run.startedAt },
          status: { $in: ["completed", "failed"] },
        })
      ) {
        if (later.kind === "revert") continue;
        for await (const op of deps.ops.find({ runId: later._id })) {
          if (touched.has(`${op.collection}:${op.targetId}`)) {
            return refused(
              runId,
              dryRun,
              `run ${later._id} (${later.kind}) touched ${op.collection}:${op.targetId} after this run; revert it first`,
            );
          }
        }
      }

      const result: RevertResult = {
        runId,
        revertRunId: null,
        dryRun,
        opsTotal: ops.length,
        restored: 0,
        deleted: 0,
        skippedConflicts: [],
        refused: null,
      };
      const plan: Array<{ op: OpDoc; current: Doc | null }> = [];
      for (const op of [...ops].reverse()) {
        const store = deps.target(op.collection);
        const current = await store.findOne({ _id: op.targetId });
        if (!force && !(await matchesAfterImage(current, op.after))) {
          result.skippedConflicts.push(`${op.collection}:${op.targetId}`);
          continue;
        }
        plan.push({ op, current });
        if (op.before === null) result.deleted++;
        else result.restored++;
      }
      if (dryRun) return result;

      const revertRunId = await journal.start({
        kind: "revert",
        dryRun: false,
        meta: { revertOf: runId, forced: force },
      });
      result.revertRunId = revertRunId;
      // Journal the revert itself (before = what is there now, after = what
      // we restore), so a revert is revertable too.
      await record(
        revertRunId,
        plan.map(({ op, current }) => ({
          collection: op.collection,
          _id: op.targetId,
          before: current,
          after: op.before,
        })),
      );
      try {
        for (const { op } of plan) {
          const store = deps.target(op.collection);
          if (op.before === null) {
            await store.deleteOne({ _id: op.targetId });
          } else {
            await store.replaceOne({ _id: op.targetId }, op.before, {
              upsert: true,
            });
          }
        }
      } catch (err) {
        await journal.finish(revertRunId, "failed");
        throw err;
      }
      await journal.finish(revertRunId, "completed", {
        restored: result.restored,
        deleted: result.deleted,
        conflicts: result.skippedConflicts.length,
      });
      await deps.runs.updateOne({ _id: runId }, {
        $set: { status: "reverted" },
      });
      // Reverting a revert reinstates the original run's effects, so it
      // becomes revertable again.
      if (run.kind === "revert" && typeof run.meta.revertOf === "string") {
        await deps.runs.updateOne({ _id: run.meta.revertOf }, {
          $set: { status: "completed" },
        });
      }
      return result;
    },
  };
  return journal;
}

function refused(
  runId: string,
  dryRun: boolean,
  reason: string,
): RevertResult {
  return {
    runId,
    revertRunId: null,
    dryRun,
    opsTotal: 0,
    restored: 0,
    deleted: 0,
    skippedConflicts: [],
    refused: reason,
  };
}

// The after-image is either a full document or `{_id, sha256}` for records
// whose bytes must not be journaled (control plane). Either way the question
// is "is the record still what the migration left behind?"
async function matchesAfterImage(
  current: Doc | null,
  after: Doc | null,
): Promise<boolean> {
  if (after === null) return current === null;
  if (current === null) return false;
  const keys = Object.keys(after).filter((k) => k !== "_id");
  if (keys.length === 1 && keys[0] === "sha256") {
    const data = current.data;
    if (data === undefined || data === null) return false;
    return (await sha256Hex(toBytes(data))) === after.sha256;
  }
  return canonical(current) === canonical(after);
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const maybe = data as { buffer?: unknown };
  if (maybe && maybe.buffer instanceof Uint8Array) return maybe.buffer;
  if (maybe && maybe.buffer instanceof ArrayBuffer) {
    return new Uint8Array(maybe.buffer);
  }
  return new TextEncoder().encode(String(data));
}

// Order-independent, type-aware serialisation for document equality.
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    const withBuffer = value as { buffer?: unknown; _bsontype?: string };
    if (
      withBuffer._bsontype === "Binary" &&
      withBuffer.buffer instanceof Uint8Array
    ) {
      return { $bytes: bytesToHex(withBuffer.buffer) };
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = normalize(obj[k]);
    return out;
  }
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

export interface PruneResult {
  runsDeleted: number;
  opsDeleted: number;
  cutoff: string;
}

/**
 * Drops journal runs that finished before `cutoff` (and their ops) so the
 * journal does not grow forever. A run is revertable only while its ops are
 * still here — keep the window at least as long as the tombstone grace.
 * Runs still `running` are never pruned.
 */
/** A JournalStore that can also delete — what pruning needs. */
export type PrunableJournalStore<T extends { _id: string }> =
  & JournalStore<T>
  & {
    deleteMany(filter: Record<string, unknown>): Promise<unknown>;
  };

export async function pruneJournal(
  runs: PrunableJournalStore<RunDoc>,
  ops: PrunableJournalStore<OpDoc>,
  opts: { olderThanMs: number; now?: Date; dryRun?: boolean },
): Promise<PruneResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.olderThanMs);
  const doomed: string[] = [];
  for await (
    const run of runs.find(
      { finishedAt: { $lt: cutoff }, status: { $ne: "running" } },
      { projection: { _id: 1 } },
    )
  ) doomed.push(run._id);
  let opsDeleted = 0;
  for (const runId of doomed) {
    for await (
      const _ of ops.find({ runId }, { projection: { _id: 1 } })
    ) opsDeleted++;
  }
  if (opts.dryRun !== true && doomed.length > 0) {
    await ops.deleteMany({ runId: { $in: doomed } });
    await runs.deleteMany({ _id: { $in: doomed } });
  }
  return {
    runsDeleted: doomed.length,
    opsDeleted,
    cutoff: cutoff.toISOString(),
  };
}
