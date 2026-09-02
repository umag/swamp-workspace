// RED tests for ./journal.ts — the migration journal (before-images written
// before the mutation, generic revert with conflict detection).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeCollection } from "../datastores/mongodb/test_fakes.ts";

type Doc = Record<string, unknown> & { _id: string };
interface MigrationOp {
  collection: string;
  _id: string;
  before: Doc | null;
  after: Doc | null;
}
interface RevertResult {
  runId: string;
  revertRunId: string | null;
  dryRun: boolean;
  opsTotal: number;
  restored: number;
  deleted: number;
  skippedConflicts: string[];
  refused: string | null;
}
interface Journal {
  start(
    run: { kind: string; dryRun: boolean; meta?: Record<string, unknown> },
  ): Promise<string>;
  record(runId: string, ops: MigrationOp[]): Promise<void>;
  finish(
    runId: string,
    status: "completed" | "failed",
    counts?: Record<string, number>,
  ): Promise<void>;
  get(runId: string): Promise<Doc | null>;
  revert(
    runId: string,
    opts?: { dryRun?: boolean; force?: boolean },
  ): Promise<RevertResult>;
}
interface JournalModule {
  createJournal(deps: {
    runs: unknown;
    ops: unknown;
    target: (collection: string) => unknown;
    now?: () => Date;
  }): Journal;
}

import * as journalModule from "./journal.ts";
function mod(): Promise<JournalModule> {
  return Promise.resolve(journalModule as unknown as JournalModule);
}

function harness() {
  const runs = new FakeCollection("runs");
  const ops = new FakeCollection("ops");
  const paths = new FakeCollection("paths");
  const control = new FakeCollection("control");
  const targets: Record<string, FakeCollection> = { paths, control };
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 2, 12, 0, tick++));
  const journal = mod().then((m) =>
    m.createJournal({ runs, ops, target: (c) => targets[c], now })
  );
  return { runs, ops, paths, control, journal };
}

const T = (s: string) => new Date(s);
const pathDoc = (
  id: string,
  hash: string,
  at = "2026-08-01T00:00:00Z",
): Doc => ({ _id: id, hash, size: 1, updatedAt: T(at), deletedAt: null });

Deno.test("journal: start/record/finish persist a run header and one op per touched record", async () => {
  const h = harness();
  const j = await h.journal;
  const runId = await j.start({
    kind: "fold",
    dryRun: false,
    meta: { namespace: "ns" },
  });
  await j.record(runId, [
    {
      collection: "paths",
      _id: "data/x",
      before: pathDoc("data/x", "h1"),
      after: pathDoc("data/x", "h2"),
    },
    {
      collection: "paths",
      _id: "ns/data/x",
      before: pathDoc("ns/data/x", "h2"),
      after: null,
    },
  ]);
  await j.finish(runId, "completed", { scanned: 2 });
  const run = await j.get(runId);
  assert(run !== null);
  assertEquals(run.kind, "fold");
  assertEquals(run.status, "completed");
  assertEquals(run.dryRun, false);
  const recorded = h.ops.docs().filter((o) => o.runId === runId);
  assertEquals(recorded.length, 2);
  assertEquals(recorded.map((o) => o.seq), [0, 1]);
  assertEquals(recorded[1].after, null);
});

Deno.test("journal: a failed migration leaves its before-images in place and the run marked failed", async () => {
  const h = harness();
  const j = await h.journal;
  h.paths.seed([pathDoc("data/x", "h1")]);
  const runId = await j.start({ kind: "fold", dryRun: false });
  await j.record(runId, [{
    collection: "paths",
    _id: "data/x",
    before: pathDoc("data/x", "h1"),
    after: pathDoc("data/x", "h2"),
  }]);
  // The mutation crashes after the journal write.
  await j.finish(runId, "failed");
  assertEquals((await j.get(runId))!.status, "failed");
  assertEquals(h.ops.docs().length, 1);
  assertEquals(h.paths.docs()[0].hash, "h1");
});

Deno.test("journal: revert restores before-images, deletes inserted docs, marks the run reverted and records a revert run", async () => {
  const h = harness();
  const j = await h.journal;
  h.paths.seed([
    pathDoc("data/x", "h2", "2026-08-20T00:00:00Z"),
    pathDoc("data/new", "hn"),
  ]);
  const runId = await j.start({ kind: "fold", dryRun: false });
  await j.record(runId, [
    {
      collection: "paths",
      _id: "data/x",
      before: pathDoc("data/x", "h1"),
      after: pathDoc("data/x", "h2", "2026-08-20T00:00:00Z"),
    },
    {
      collection: "paths",
      _id: "data/new",
      before: null,
      after: pathDoc("data/new", "hn"),
    },
    {
      collection: "paths",
      _id: "data/gone",
      before: pathDoc("data/gone", "hg"),
      after: null,
    },
  ]);
  await j.finish(runId, "completed");
  const r = await j.revert(runId, { dryRun: false });
  assertEquals(r.refused, null);
  assertEquals(r.restored, 2);
  assertEquals(r.deleted, 1);
  assertEquals(r.skippedConflicts, []);
  assertEquals(h.paths.docs().map((d) => [d._id, d.hash]), [
    ["data/gone", "hg"],
    ["data/x", "h1"],
  ]);
  assertEquals((await j.get(runId))!.status, "reverted");
  assert(r.revertRunId !== null);
  const revertRun = await j.get(r.revertRunId!);
  assertEquals(revertRun!.kind, "revert");
  assertEquals((revertRun!.meta as { revertOf: string }).revertOf, runId);
});

Deno.test("journal: dry-run revert reports counts without writing", async () => {
  const h = harness();
  const j = await h.journal;
  h.paths.seed([pathDoc("data/x", "h2")]);
  const runId = await j.start({ kind: "fold", dryRun: false });
  await j.record(runId, [{
    collection: "paths",
    _id: "data/x",
    before: pathDoc("data/x", "h1"),
    after: pathDoc("data/x", "h2"),
  }]);
  await j.finish(runId, "completed");
  const writesBefore = h.paths.writes.length;
  const r = await j.revert(runId);
  assertEquals(r.dryRun, true);
  assertEquals(r.restored, 1);
  assertEquals(r.revertRunId, null);
  assertEquals(h.paths.writes.length, writesBefore);
  assertEquals(h.paths.docs()[0].hash, "h2");
  assertEquals((await j.get(runId))!.status, "completed");
});

Deno.test("journal: revert refuses when a later non-reverted run touched the same ids", async () => {
  const h = harness();
  const j = await h.journal;
  h.paths.seed([pathDoc("data/x", "h3")]);
  const first = await j.start({ kind: "fold", dryRun: false });
  await j.record(first, [{
    collection: "paths",
    _id: "data/x",
    before: pathDoc("data/x", "h1"),
    after: pathDoc("data/x", "h2"),
  }]);
  await j.finish(first, "completed");
  const second = await j.start({ kind: "prefix", dryRun: false });
  await j.record(second, [{
    collection: "paths",
    _id: "data/x",
    before: pathDoc("data/x", "h2"),
    after: pathDoc("data/x", "h3"),
  }]);
  await j.finish(second, "completed");
  const r = await j.revert(first, { dryRun: false });
  assert(r.refused !== null && r.refused.includes(second));
  assertEquals(h.paths.docs()[0].hash, "h3");
  // Reverting the later run first unblocks the earlier one.
  await j.revert(second, { dryRun: false });
  const r2 = await j.revert(first, { dryRun: false });
  assertEquals(r2.refused, null);
  assertEquals(h.paths.docs()[0].hash, "h1");
});

Deno.test("journal: revert skips ids whose current doc differs from the after-image, unless forced", async () => {
  const h = harness();
  const j = await h.journal;
  const runId = await j.start({ kind: "fold", dryRun: false });
  await j.record(runId, [
    {
      collection: "paths",
      _id: "data/x",
      before: pathDoc("data/x", "h1"),
      after: pathDoc("data/x", "h2"),
    },
    {
      collection: "paths",
      _id: "data/y",
      before: pathDoc("data/y", "h1"),
      after: pathDoc("data/y", "h2"),
    },
  ]);
  await j.finish(runId, "completed");
  // A client wrote data/x after the migration.
  h.paths.seed([pathDoc("data/x", "client-wrote"), pathDoc("data/y", "h2")]);
  const r = await j.revert(runId, { dryRun: false });
  assertEquals(r.skippedConflicts, ["paths:data/x"]);
  assertEquals(r.restored, 1);
  assertEquals(h.paths.docs().map((d) => d.hash), ["client-wrote", "h1"]);
  // Forced revert overwrites the conflict and reports it.
  const forced = await j.revert(r.revertRunId!, { dryRun: false });
  assertEquals(forced.refused, null);
  const again = await j.revert(runId, { dryRun: false, force: true });
  assertEquals(again.skippedConflicts, []);
  assertEquals(h.paths.docs().map((d) => d.hash), ["h1", "h1"]);
});

Deno.test("journal: after-images with only a sha256 compare against the current doc's bytes (control records)", async () => {
  const h = harness();
  const j = await h.journal;
  const bytes = new TextEncoder().encode("hunter2");
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
  h.control.seed([{ _id: "_control/token-secrets/key", data: bytes }]);
  const runId = await j.start({ kind: "import-control", dryRun: false });
  await j.record(runId, [{
    collection: "control",
    _id: "_control/token-secrets/key",
    before: null,
    after: { _id: "_control/token-secrets/key", sha256: digest },
  }]);
  await j.finish(runId, "completed");
  assertEquals(
    JSON.stringify(h.ops.docs()[0]).includes("hunter2"),
    false,
    "journal must not hold the secret value",
  );
  const r = await j.revert(runId, { dryRun: false });
  assertEquals(r.deleted, 1);
  assertEquals(h.control.docs().length, 0);
});

// Property: for random collections and random journaled mutations, revert
// restores the collection exactly. The oracle is a deep-equal against a
// snapshot taken before the mutation — independent of the journal's own
// bookkeeping.
Deno.test("journal: revert(mutation) restores the collection exactly for random mutations", async () => {
  let seed = 424242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 40; round++) {
    const h = harness();
    const j = await h.journal;
    const n = 1 + Math.floor(rnd() * 12);
    const initial: Doc[] = Array.from(
      { length: n },
      (_, i) =>
        pathDoc(
          `data/${i}`,
          `h${Math.floor(rnd() * 5)}`,
          `2026-08-${
            String(1 + Math.floor(rnd() * 28)).padStart(2, "0")
          }T00:00:00Z`,
        ),
    );
    h.paths.seed(initial);
    const snapshot = h.paths.docs();
    const ops: MigrationOp[] = [];
    for (const d of h.paths.docs()) {
      const roll = rnd();
      if (roll < 0.4) {
        const after = {
          ...d,
          hash: `m${Math.floor(rnd() * 5)}`,
          updatedAt: T("2026-09-01T00:00:00Z"),
        };
        ops.push({ collection: "paths", _id: d._id, before: d, after });
        await h.paths.replaceOne({ _id: d._id }, after);
      } else if (roll < 0.6) {
        ops.push({ collection: "paths", _id: d._id, before: d, after: null });
        await h.paths.deleteOne({ _id: d._id });
      }
    }
    const extra = Math.floor(rnd() * 3);
    for (let i = 0; i < extra; i++) {
      const doc = pathDoc(`data/new-${round}-${i}`, "hn");
      ops.push({ collection: "paths", _id: doc._id, before: null, after: doc });
      await h.paths.insertOne(doc);
    }
    const runId = await j.start({ kind: "random", dryRun: false });
    await j.record(runId, ops);
    await j.finish(runId, "completed");
    const r = await j.revert(runId, { dryRun: false });
    assertEquals(r.refused, null, `round ${round}`);
    assertEquals(r.skippedConflicts, [], `round ${round}`);
    assertEquals(h.paths.docs(), snapshot, `round ${round}: ${ops.length} ops`);
  }
});

Deno.test("journal: pruneJournal drops finished runs older than the window and keeps running ones", async () => {
  const h = harness();
  const j = await h.journal;
  const m = await mod();
  const old = await j.start({ kind: "fold", dryRun: false });
  await j.record(old, [{
    collection: "paths",
    _id: "data/x",
    before: null,
    after: pathDoc("data/x", "h"),
  }]);
  await j.finish(old, "completed");
  // Backdate the old run's finish time.
  await h.runs.updateOne({ _id: old }, {
    $set: { finishedAt: T("2026-07-01T00:00:00Z") },
  });
  const fresh = await j.start({ kind: "fold", dryRun: false });
  await j.record(fresh, [{
    collection: "paths",
    _id: "data/y",
    before: null,
    after: pathDoc("data/y", "h"),
  }]);
  await j.finish(fresh, "completed");
  const running = await j.start({ kind: "fold", dryRun: false });
  await h.runs.updateOne({ _id: running }, {
    $set: { finishedAt: T("2026-07-01T00:00:00Z") },
  });
  const prune = (m as unknown as {
    pruneJournal: (
      r: unknown,
      o: unknown,
      opts: Record<string, unknown>,
    ) => Promise<{ runsDeleted: number; opsDeleted: number }>;
  }).pruneJournal;
  const dry = await prune(h.runs, h.ops, {
    olderThanMs: 30 * 86_400_000,
    now: T("2026-09-02T00:00:00Z"),
    dryRun: true,
  });
  assertEquals([dry.runsDeleted, dry.opsDeleted], [1, 1]);
  assertEquals(h.runs.docs().length, 3);
  const wet = await prune(h.runs, h.ops, {
    olderThanMs: 30 * 86_400_000,
    now: T("2026-09-02T00:00:00Z"),
  });
  assertEquals([wet.runsDeleted, wet.opsDeleted], [1, 1]);
  assertEquals(h.runs.docs().map((r) => r._id).sort(), [fresh, running].sort());
  assertEquals(h.ops.docs().map((o) => o.runId), [fresh]);
});
