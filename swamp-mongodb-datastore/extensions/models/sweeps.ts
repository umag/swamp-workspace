// Blob-store maintenance: reclaiming content-addressed bytes that no live
// path doc references any more (repo issue 012).
//
// Why this is needed: `_blobs` is append-only by design. Deduplication is the
// whole point — N agents pushing identical bytes collapse to one doc — so no
// push may ever delete a blob, since it cannot know whether some *other* path
// still points at that hash. Tombstoning a path in `_paths` therefore leaves
// its bytes behind forever. On proxmox-manager that arithmetic had run for
// months: ~21k live files against a `_blobs` collection holding 931k docs and
// 197 GB.
//
// Safety: an orphan sweep races with a concurrent push, which inserts the blob
// *before* upserting the path doc that references it. A sweep landing in that
// window sees an unreferenced hash and deletes bytes a peer is about to point
// at, leaving a live path doc whose hash resolves to nothing.
//
// The global lock is NOT sufficient on its own. Swamp core does not funnel
// every write through the global lock — a sweep of this collection that held
// it still produced a dangling reference from a concurrent push (a
// `workflow-runs/...yaml` upserted mid-sweep). So the real protection is a
// **grace window**: blobs carry `createdAt`, and anything younger than
// `graceMs` is left alone regardless of reachability, because a push that just
// wrote it may not have upserted its path doc yet. Blobs predating the field
// are definitionally old and always eligible.
//
// Take the global lock anyway — it is cheap defense-in-depth against the
// writers that do honor it — but correctness rests on the grace window.
//
// The sweep is deliberately not wired into pushChanged: it is a maintenance
// operation, not a hot-path one.

import type { Collection } from "npm:mongodb@6.17.0";

/** A `_blobs` document, narrowed to the fields the sweep reads. */
export interface BlobDocLike {
  _id: string;
  size: number;
  // Written by pushes from 2026.08.19.1 on. Absent on older docs, which are
  // therefore always past any grace window.
  createdAt?: Date;
}

/** A `_paths` document, narrowed to the fields the sweep reads. */
export interface PathDocLike {
  _id: string;
  hash: string;
  deletedAt: Date | null;
}

// Order matters when running both sweeps: prune tombstones FIRST, then sweep
// blobs. A tombstone is not a blob reference, so dropping tombstones never
// strands bytes — but doing it first means the blob sweep's single pass also
// collects whatever those tombstones were the last trace of.
/** Reminder of the required ordering between the two sweeps. */
export const SWEEP_ORDER_NOTE =
  "Run sweepTombstones before sweepOrphanBlobs; tombstones are not blob references.";

/** Outcome of {@link sweepOrphanBlobs}. */
export interface OrphanSweepResult {
  liveHashes: number;
  blobDocsScanned: number;
  orphanBlobs: number;
  orphanChunks: number;
  bytesReclaimed: number;
  // Unreferenced but inside the grace window, so deliberately spared. A
  // non-zero count here is normal on a busy cluster.
  skippedTooYoung: number;
  deleted: boolean;
}

// One hour: comfortably longer than the gap between a push's blob insert and
// its path upsert, even for a push moving hundreds of MB.
/**
 * Default blob grace window (1h) — comfortably longer than the gap between a
 * push's blob insert and its path upsert, even for a push moving hundreds of MB.
 */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

// 30 days. See sweepTombstones for why this cannot be short.
/**
 * Default tombstone grace window (30d). See {@link sweepTombstones} for why
 * this cannot be short.
 */
export const DEFAULT_TOMBSTONE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Outcome of {@link sweepTombstones}. */
export interface TombstoneSweepResult {
  tombstonesTotal: number;
  tombstonesDeleted: number;
  tombstonesKept: number;
  cutoff: string;
  deleted: boolean;
}

// Hard-deletes tombstoned path docs older than the grace window.
//
// A tombstone is how a deletion reaches peers: pullChanged sees
// `deletedAt != null` and unlinks the local copy. That makes tombstones
// load-bearing, and `_paths` accumulates them forever — on proxmox-manager,
// 855,438 tombstones against 21,171 live docs, so 97.6% of the collection was
// bookkeeping for deletions that every peer had long since applied.
//
// **The grace window is not optional.** Hard-deleting a tombstone makes the
// deletion invisible: a peer whose `lastPulledAt` predates it never learns the
// file is gone, keeps its local copy, and re-uploads it on its next full walk
// — resurrecting deleted data. The window must therefore exceed the longest
// plausible gap between a peer's syncs. This is the same trade-off as
// Cassandra's `gc_grace_seconds`, and the same failure mode if set too low.
//
// Default 30 days: any host syncing at least monthly is safe. A host dormant
// longer than the window should be re-bootstrapped (clear its cache) rather
// than allowed to push stale state.
/**
 * Hard-deletes tombstoned path docs older than the grace window.
 *
 * The grace window is not optional: hard-deleting a tombstone makes the
 * deletion invisible, so a peer whose `lastPulledAt` predates it never learns
 * the file is gone and re-uploads it on its next full walk. Same trade-off as
 * Cassandra's `gc_grace_seconds`, same failure mode if set too low.
 */
export async function sweepTombstones(
  paths: Collection<PathDocLike>,
  opts?: {
    dryRun?: boolean;
    graceMs?: number;
    now?: Date;
  },
): Promise<TombstoneSweepResult> {
  const dryRun = opts?.dryRun === true;
  const graceMs = opts?.graceMs ?? DEFAULT_TOMBSTONE_GRACE_MS;
  const cutoff = new Date((opts?.now ?? new Date()).getTime() - graceMs);

  const tombstonesTotal = await paths.countDocuments({
    deletedAt: { $ne: null },
  });
  const eligible = await paths.countDocuments({
    deletedAt: { $ne: null, $lt: cutoff },
  });

  if (!dryRun && eligible > 0) {
    await paths.deleteMany({ deletedAt: { $ne: null, $lt: cutoff } });
  }

  return {
    tombstonesTotal,
    tombstonesDeleted: dryRun ? 0 : eligible,
    tombstonesKept: tombstonesTotal - eligible,
    cutoff: cutoff.toISOString(),
    deleted: !dryRun,
  };
}

// Chunked blobs store a header under the bare hash and chunks under
// `<hash>:<n>`. A chunk is an orphan exactly when its header's hash is.
/**
 * For a chunk id `<hash>:<n>` returns `<hash>`; for a bare hash returns null.
 * A chunk is an orphan exactly when its header's hash is.
 */
export function chunkParentHash(blobId: string): string | null {
  const colon = blobId.lastIndexOf(":");
  if (colon < 0) return null;
  return blobId.slice(0, colon);
}

const DELETE_BATCH = 1000;

// Collects blobs unreferenced by any *live* path doc.
//
// Tombstoned paths are intentionally not treated as references. A peer whose
// watermark predates the tombstone will pull the tombstone and unlink its
// local copy; it never fetches the bytes (hydrateFile refuses a doc with
// deletedAt set), so keeping them buys nothing.
//
// `dryRun` reports what would go without touching anything — always worth
// running first against a shared cluster.
/**
 * Collects blobs unreferenced by any live path doc.
 *
 * Tombstoned paths are deliberately not treated as references — a peer pulls
 * the tombstone and unlinks locally, never fetching the bytes.
 *
 * Correctness rests on the `createdAt` grace window, not on the global lock:
 * a push inserts a blob before the path doc referencing it, and swamp core
 * does not funnel every write through that lock.
 */
export async function sweepOrphanBlobs(
  paths: Collection<PathDocLike>,
  blobs: Collection<BlobDocLike>,
  opts?: {
    dryRun?: boolean;
    graceMs?: number;
    now?: Date;
    onProgress?: (scanned: number) => void;
  },
): Promise<OrphanSweepResult> {
  const dryRun = opts?.dryRun === true;
  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  const cutoff = (opts?.now ?? new Date()).getTime() - graceMs;

  // Reference set: distinct hashes of live paths. Bounded by the working set
  // (~21k on proxmox-manager), not by the blob store.
  const liveHashes = new Set<string>();
  for await (
    const doc of paths.find(
      { deletedAt: null },
      { projection: { hash: 1 } },
    )
  ) {
    if (typeof doc.hash === "string") liveHashes.add(doc.hash);
  }

  let blobDocsScanned = 0;
  let orphanBlobs = 0;
  let orphanChunks = 0;
  let bytesReclaimed = 0;
  let skippedTooYoung = 0;
  let batch: string[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    if (!dryRun) {
      await blobs.deleteMany({ _id: { $in: batch } });
    }
    batch = [];
  };

  // Stream every blob id + size. Sizes come from the doc rather than
  // collStats so the reclaim figure is exact for the docs we actually remove.
  for await (
    const blob of blobs.find({}, {
      projection: { _id: 1, size: 1, createdAt: 1 },
    })
  ) {
    blobDocsScanned++;
    if (opts?.onProgress && blobDocsScanned % 100_000 === 0) {
      opts.onProgress(blobDocsScanned);
    }
    const parent = chunkParentHash(blob._id);
    const referenced = parent === null
      ? liveHashes.has(blob._id)
      : liveHashes.has(parent);
    if (referenced) continue;

    // Unreferenced, but possibly only because the push that wrote it has not
    // upserted its path doc yet. Docs with no `createdAt` predate the field
    // and are always past the window.
    if (blob.createdAt !== undefined && blob.createdAt.getTime() > cutoff) {
      skippedTooYoung++;
      continue;
    }

    if (parent === null) orphanBlobs++;
    else orphanChunks++;
    bytesReclaimed += blob.size ?? 0;
    batch.push(blob._id);
    if (batch.length >= DELETE_BATCH) await flush();
  }
  await flush();

  return {
    liveHashes: liveHashes.size,
    blobDocsScanned,
    orphanBlobs,
    orphanChunks,
    bytesReclaimed,
    skippedTooYoung,
    deleted: !dryRun,
  };
}

// ---------------------------------------------------------------------------
// Journaled migrations (repo issue: feature parity with @swamp/s3-datastore).
//
// The path-id layout changed in 2026.09.03.1: remote ids are tier-relative
// (`data/...`) and the core namespace only shapes the *local* cache. Older
// clients with a core namespace wrote `<ns>/data/...` ids. `foldNamespacePrefix`
// retires those; `prefixNamespace` is its inverse for the post-upgrade delta;
// `importControlRecords` seeds the `_control` collection from serve's
// filesystem store so existing tokens survive the switch. Every one of them
// writes through the journal (./journal.ts) and is revertable.
//
// Collection names are derived here rather than imported from
// ../datastores/mongodb/config.ts — packaging ships each entry point's own
// import graph only (see maintenance.ts header). migrations_test.ts asserts
// both derivations agree.

import {
  type Journal,
  type MigrationOp,
  sha256Hex as journalSha256,
} from "./journal.ts";

export function controlCollectionNameFor(
  tenantId: string,
  namespace: string,
): string {
  return `t_${tenantId}_r_${namespace}_control`;
}

export function journalCollectionNamesFor(
  tenantId: string,
  namespace: string,
): { runs: string; ops: string } {
  const p = `t_${tenantId}_r_${namespace}`;
  return { runs: `${p}_migrations`, ops: `${p}_migration_ops` };
}

/** A `_paths` document as the migrations read and write it. */
export interface PathRow {
  _id: string;
  hash: string;
  size: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Driver-shaped port over `_paths` for the migrations. */
export interface PathsPort {
  find(
    filter?: Record<string, unknown>,
    opts?: { projection?: Record<string, number> },
  ): AsyncIterable<PathRow>;
  bulkWrite(
    ops: Record<string, unknown>[],
    opts?: { ordered?: boolean },
  ): Promise<unknown>;
}

export interface ClientStamp {
  holder: string;
  version: string;
  at: Date;
}

export interface FoldResult {
  dryRun: boolean;
  refused: string | null;
  runId: string | null;
  scanned: number;
  droppedEqual: number;
  bareWon: number;
  prefixedWon: number;
  created: number;
  tombstonesFolded: number;
}

export interface FoldOptions {
  namespace: string;
  dryRun?: boolean;
  recentWriterMinutes?: number;
  force?: boolean;
  now?: Date;
  clientStamps?: ClientStamp[];
  requiredVersion?: string;
}

const MIGRATION_BATCH = 500;
const STAMP_FRESH_MS = 24 * 60 * 60 * 1000;

/** Numeric dotted-version comparison; CalVer and semver alike. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathDocOf(row: PathRow): Record<string, unknown> & { _id: string } {
  return {
    _id: row._id,
    hash: row.hash,
    size: row.size,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

// Applies a batch: journal first, then bulkWrite. `ops` carry the full
// after-image, so the write is a replace-by-$set of every field.
async function applyBatch(
  paths: PathsPort,
  journal: Journal,
  runId: string,
  ops: MigrationOp[],
): Promise<void> {
  if (ops.length === 0) return;
  await journal.record(runId, ops);
  const writes = ops.map((op) => {
    const after = op.after as (PathRow & Record<string, unknown>) | null;
    if (after === null) return { deleteOne: { filter: { _id: op._id } } };
    return {
      updateOne: {
        filter: { _id: op._id },
        update: {
          $set: {
            hash: after.hash,
            size: after.size,
            updatedAt: after.updatedAt,
            deletedAt: after.deletedAt,
          },
        },
        upsert: true,
      },
    };
  });
  await paths.bulkWrite(writes, { ordered: false });
}

/**
 * Folds legacy `<namespace>/x` path docs onto their tier-relative `x` twin.
 *
 * Rules (P = prefixed doc, B = bare doc):
 *   P live,  B absent/tombstoned-older → B := P's fields; P tombstoned  (created)
 *   P live,  B live, same hash         → P tombstoned                  (droppedEqual)
 *   P live,  B live, B newer or equal  → P tombstoned                  (bareWon)
 *   P live,  B live, P newer           → B := P's fields; P tombstoned  (prefixedWon)
 *   P dead,  B live, B older than P    → B tombstoned at P's time       (tombstonesFolded)
 *   otherwise                          → untouched
 *
 * Blobs are never touched and P is tombstoned, never removed, so content
 * stays reachable and the journal can put everything back.
 *
 * Refuses (no run, no writes) while any prefixed doc was written within
 * `recentWriterMinutes`, or while a client stamp fresher than 24h carries a
 * version below `requiredVersion` — an old client is still writing the old
 * layout. `force` overrides both.
 */
export async function foldNamespacePrefix(
  paths: PathsPort,
  journal: Journal,
  opts: FoldOptions,
): Promise<FoldResult> {
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? new Date();
  const ns = opts.namespace;
  const prefix = `${ns}/`;
  const recentMs = (opts.recentWriterMinutes ?? 30) * 60_000;
  const result: FoldResult = {
    dryRun,
    refused: null,
    runId: null,
    scanned: 0,
    droppedEqual: 0,
    bareWon: 0,
    prefixedWon: 0,
    created: 0,
    tombstonesFolded: 0,
  };

  const prefixFilter = { _id: { $regex: `^${escapeRegex(prefix)}` } };

  if (!opts.force) {
    let fresh: PathRow | null = null;
    for await (
      const row of paths.find({
        ...prefixFilter,
        updatedAt: { $gt: new Date(now.getTime() - recentMs) },
      })
    ) {
      fresh = row;
      break;
    }
    if (fresh) {
      result.refused =
        `recent writer: ${fresh._id} was updated at ${fresh.updatedAt.toISOString()}, within ${
          opts.recentWriterMinutes ?? 30
        } minutes — stop old clients first or pass force`;
      return result;
    }
    const required = opts.requiredVersion;
    if (required) {
      const stale = (opts.clientStamps ?? []).find((s) =>
        s.at.getTime() > now.getTime() - STAMP_FRESH_MS &&
        compareVersions(s.version, required) < 0
      );
      if (stale) {
        result.refused =
          `client ${stale.holder} synced at ${stale.at.toISOString()} with version ${stale.version} < ${required} — upgrade it first or pass force`;
        return result;
      }
    }
  }
  // The run header is created on the first non-empty batch so an empty
  // namespace leaves no journal entry.
  let runId: string | null = null;
  const ensureRun = async (): Promise<string | null> => {
    if (dryRun) return null;
    if (runId === null) {
      runId = await journal.start({
        kind: "fold",
        dryRun,
        meta: { namespace: ns },
      });
      result.runId = runId;
    }
    return runId;
  };

  // Streamed in MIGRATION_BATCH slices: the prefixed set is the whole legacy
  // layout (hundreds of thousands of docs on a real namespace), and nothing
  // below needs more than one batch in memory. Tombstoning a prefixed doc
  // changes no `_id`, so the `_id`-ordered cursor never revisits it.
  const processBatch = async (batch: PathRow[]): Promise<void> => {
    {
      const bareIds = batch.map((p) => p._id.slice(prefix.length));
      const bare = new Map<string, PathRow>();
      for await (const row of paths.find({ _id: { $in: bareIds } })) {
        bare.set(row._id, row);
      }
      const ops: MigrationOp[] = [];
      for (const p of batch) {
        const bareId = p._id.slice(prefix.length);
        const b = bare.get(bareId) ?? null;
        const tombstonedP = { ...pathDocOf(p), deletedAt: now, updatedAt: now };
        if (p.deletedAt !== null) {
          if (
            b !== null && b.deletedAt === null &&
            b.updatedAt.getTime() < p.deletedAt.getTime()
          ) {
            result.tombstonesFolded++;
            ops.push({
              collection: "paths",
              _id: b._id,
              before: pathDocOf(b),
              after: {
                ...pathDocOf(b),
                deletedAt: p.deletedAt,
                updatedAt: now,
              },
            });
          }
          continue;
        }
        if (b === null || (b.deletedAt !== null && b.deletedAt < p.updatedAt)) {
          result.created++;
          ops.push({
            collection: "paths",
            _id: bareId,
            before: b === null ? null : pathDocOf(b),
            after: {
              ...pathDocOf(p),
              _id: bareId,
              deletedAt: null,
              updatedAt: now,
            },
          });
        } else if (b.deletedAt === null && b.hash === p.hash) {
          result.droppedEqual++;
        } else if (b.deletedAt === null && b.updatedAt >= p.updatedAt) {
          result.bareWon++;
        } else if (b.deletedAt === null) {
          result.prefixedWon++;
          ops.push({
            collection: "paths",
            _id: bareId,
            before: pathDocOf(b),
            after: {
              ...pathDocOf(p),
              _id: bareId,
              deletedAt: null,
              updatedAt: now,
            },
          });
        } else {
          // B tombstoned more recently than P was written: P loses.
          result.bareWon++;
        }
        ops.push({
          collection: "paths",
          _id: p._id,
          before: pathDocOf(p),
          after: tombstonedP,
        });
      }
      const id = await ensureRun();
      if (id !== null) {
        await applyBatch(paths, journal, id, ops);
      }
    }
  };

  try {
    let batch: PathRow[] = [];
    for await (const row of paths.find(prefixFilter)) {
      result.scanned++;
      batch.push(row);
      if (batch.length >= MIGRATION_BATCH) {
        await processBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await processBatch(batch);
  } catch (err) {
    if (runId !== null) await journal.finish(runId, "failed", counts(result));
    throw err;
  }
  if (runId !== null) await journal.finish(runId, "completed", counts(result));
  return result;
}

function counts(r: FoldResult): Record<string, number> {
  return {
    scanned: r.scanned,
    droppedEqual: r.droppedEqual,
    bareWon: r.bareWon,
    prefixedWon: r.prefixedWon,
    created: r.created,
    tombstonesFolded: r.tombstonesFolded,
  };
}

export interface PrefixResult {
  dryRun: boolean;
  runId: string | null;
  prefixed: number;
}

/**
 * Inverse of fold for the post-upgrade delta: every tier-relative doc
 * written after `since` gains a `<namespace>/`-prefixed twin (tombstones
 * included), so a client rolled back to the old layout sees it.
 */
export async function prefixNamespace(
  paths: PathsPort,
  journal: Journal,
  opts: { namespace: string; since: Date; dryRun?: boolean; now?: Date },
): Promise<PrefixResult> {
  const dryRun = opts.dryRun !== false;
  const prefix = `${opts.namespace}/`;
  const result: PrefixResult = { dryRun, runId: null, prefixed: 0 };
  const candidates: PathRow[] = [];
  for await (const row of paths.find({ updatedAt: { $gt: opts.since } })) {
    if (row._id.startsWith(prefix)) continue;
    candidates.push(row);
  }
  if (candidates.length === 0) return result;
  const runId = dryRun ? null : await journal.start({
    kind: "prefix",
    dryRun,
    meta: { namespace: opts.namespace, since: opts.since.toISOString() },
  });
  result.runId = runId;
  try {
    for (let i = 0; i < candidates.length; i += MIGRATION_BATCH) {
      const batch = candidates.slice(i, i + MIGRATION_BATCH);
      const ids = batch.map((r) => prefix + r._id);
      const existing = new Map<string, PathRow>();
      for await (const row of paths.find({ _id: { $in: ids } })) {
        existing.set(row._id, row);
      }
      const ops: MigrationOp[] = batch.map((r) => {
        const id = prefix + r._id;
        const before = existing.get(id);
        return {
          collection: "paths",
          _id: id,
          before: before ? pathDocOf(before) : null,
          after: { ...pathDocOf(r), _id: id },
        };
      });
      result.prefixed += ops.length;
      if (!dryRun && runId !== null) {
        await applyBatch(paths, journal, runId, ops);
      }
    }
  } catch (err) {
    if (runId !== null) await journal.finish(runId, "failed");
    throw err;
  }
  if (runId !== null) {
    await journal.finish(runId, "completed", { prefixed: result.prefixed });
  }
  return result;
}

/** The subset of ControlPlaneStore the import needs (plus raw ids). */
export interface ControlPort {
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  rawKey?(key: string): string;
}

export interface ImportResult {
  dryRun: boolean;
  runId: string | null;
  inserted: number;
  skipped: number;
  rejected: string[];
}

const DEFAULT_IMPORT_MAX_BYTES = 1024 * 1024;

/**
 * Copies serve's filesystem control-plane tree (`<repo>/.swamp/datastore/_control`)
 * into the `_control` collection with put-if-absent semantics. Copies, never
 * moves: downgrading the extension makes serve read the files again. The
 * journal records key + sha256 only, so token secrets are never duplicated
 * into `_migration_ops`.
 */
export async function importControlRecords(
  control: ControlPort,
  journal: Journal,
  opts: { controlDir: string; dryRun?: boolean; maxBytes?: number },
): Promise<ImportResult> {
  const dryRun = opts.dryRun !== false;
  const maxBytes = opts.maxBytes ?? DEFAULT_IMPORT_MAX_BYTES;
  const given = opts.controlDir.replace(/\/+$/, "");
  if (given.split("/").includes("..")) {
    throw new Error(`controlDir must not contain '..': ${opts.controlDir}`);
  }
  // Resolve symlinks first: the basename check must apply to the directory
  // that will actually be read, not to a link named `_control`.
  const dir = await Deno.realPath(given);
  if (dir.split("/").pop() !== "_control") {
    throw new Error(
      `controlDir must resolve to a _control directory, got ${opts.controlDir} (${dir})`,
    );
  }
  const rootInfo = await Deno.lstat(dir);
  if (!rootInfo.isDirectory) {
    throw new Error(`controlDir is not a directory: ${opts.controlDir}`);
  }

  const result: ImportResult = {
    dryRun,
    runId: null,
    inserted: 0,
    skipped: 0,
    rejected: [],
  };
  const files: Array<{ key: string; abs: string }> = [];
  await walkControl(dir, "", files, result.rejected, maxBytes);

  const runId = dryRun ? null : await journal.start({
    kind: "import-control",
    dryRun,
    meta: { controlDir: dir },
  });
  result.runId = runId;
  try {
    for (const { key, abs } of files) {
      if (dryRun) {
        if ((await control.get(key)) === null) result.inserted++;
        else result.skipped++;
        continue;
      }
      // Existing records are skipped without a journal entry, so a re-run
      // (or a no-op import) never blocks the revert of an earlier run.
      if ((await control.get(key)) !== null) {
        result.skipped++;
        continue;
      }
      const bytes = await Deno.readFile(abs);
      const rawId = control.rawKey ? control.rawKey(key) : key;
      const digest = await journalSha256(bytes);
      // Journal before the write; the after-image is the hash only.
      await journal.record(runId!, [{
        collection: "control",
        _id: rawId,
        before: null,
        after: { _id: rawId, sha256: digest },
      }]);
      // A concurrent writer can still win the insert; the op then stays
      // journaled with before=null and revert skips it as a conflict because
      // the stored bytes hash differently.
      if (await control.putIfAbsent(key, bytes)) result.inserted++;
      else result.skipped++;
    }
  } catch (err) {
    if (runId !== null) await journal.finish(runId, "failed");
    throw err;
  }
  if (runId !== null) {
    await journal.finish(runId, "completed", {
      inserted: result.inserted,
      skipped: result.skipped,
      rejected: result.rejected.length,
    });
  }
  return result;
}

async function walkControl(
  root: string,
  rel: string,
  out: Array<{ key: string; abs: string }>,
  rejected: string[],
  maxBytes: number,
): Promise<void> {
  const abs = rel ? `${root}/${rel}` : root;
  for await (const entry of Deno.readDir(abs)) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = `${root}/${childRel}`;
    const info = await Deno.lstat(childAbs);
    if (info.isSymlink) {
      rejected.push(childRel);
      continue;
    }
    if (info.isDirectory) {
      await walkControl(root, childRel, out, rejected, maxBytes);
      continue;
    }
    if (!info.isFile) continue;
    if (info.size > maxBytes) {
      rejected.push(childRel);
      continue;
    }
    out.push({ key: childRel, abs: childAbs });
  }
}
