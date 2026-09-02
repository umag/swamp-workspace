// RED tests for the journaled migrations in sweeps.ts: fold_namespace_prefix,
// prefix_namespace, import_control_records, plus the collection-name parity
// between models/ and datastores/ (which never import each other).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  dec,
  enc,
  FakeCollection,
  sha256Hex,
} from "../datastores/mongodb/test_fakes.ts";

type Doc = Record<string, unknown> & { _id: string };
interface Journal {
  get(runId: string): Promise<Doc | null>;
  revert(
    runId: string,
    opts?: { dryRun?: boolean; force?: boolean },
  ): Promise<{ deleted: number; restored: number; refused: string | null }>;
}
interface FoldResult {
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
interface PrefixResult {
  dryRun: boolean;
  runId: string | null;
  prefixed: number;
}
interface ImportResult {
  dryRun: boolean;
  runId: string | null;
  inserted: number;
  skipped: number;
  rejected: string[];
}
interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
interface SweepsModule {
  controlCollectionNameFor(tenantId: string, namespace: string): string;
  journalCollectionNamesFor(
    tenantId: string,
    namespace: string,
  ): { runs: string; ops: string };
  foldNamespacePrefix(paths: unknown, journal: Journal, opts: {
    namespace: string;
    dryRun?: boolean;
    recentWriterMinutes?: number;
    force?: boolean;
    now?: Date;
    clientStamps?: Array<{ holder: string; version: string; at: Date }>;
    requiredVersion?: string;
  }): Promise<FoldResult>;
  prefixNamespace(
    paths: unknown,
    journal: Journal,
    opts: { namespace: string; since: Date; dryRun?: boolean; now?: Date },
  ): Promise<PrefixResult>;
  importControlRecords(
    control: ControlPlaneStore,
    journal: Journal,
    opts: { controlDir: string; dryRun?: boolean; maxBytes?: number },
  ): Promise<ImportResult>;
}
interface JournalModule {
  createJournal(
    deps: {
      runs: unknown;
      ops: unknown;
      target: (c: string) => unknown;
      now?: () => Date;
    },
  ): Journal;
}
interface ControlPlaneModule {
  createControlPlaneStore(
    store: unknown,
    namespace?: string,
  ): ControlPlaneStore;
}
interface ConfigModule {
  ConfigSchema: { parse(v: unknown): unknown };
  controlCollectionName(cfg: unknown): string;
  migrationsCollectionName(cfg: unknown): string;
  migrationOpsCollectionName(cfg: unknown): string;
}

import * as sweepsModule from "./sweeps.ts";
import * as journalModule from "./journal.ts";
import * as controlPlaneModule from "../datastores/mongodb/control_plane.ts";
import * as configModule from "../datastores/mongodb/config.ts";
function sweeps(): Promise<SweepsModule> {
  return Promise.resolve(sweepsModule as unknown as SweepsModule);
}
function journalMod(): Promise<JournalModule> {
  return Promise.resolve(journalModule as unknown as JournalModule);
}

const NS = "dev-tmp-swamp";
const T = (s: string) => new Date(s);
const NOW = T("2026-09-02T12:00:00Z");
const live = (id: string, hash: string, at: string): Doc => ({
  _id: id,
  hash,
  size: 1,
  updatedAt: T(at),
  deletedAt: null,
});
const dead = (id: string, hash: string, at: string): Doc => ({
  _id: id,
  hash,
  size: 1,
  updatedAt: T(at),
  deletedAt: T(at),
});

async function harness(docs: Doc[]) {
  const paths = new FakeCollection("paths").seed(docs);
  const control = new FakeCollection("control");
  const runs = new FakeCollection("runs");
  const ops = new FakeCollection("ops");
  const jm = await journalMod();
  let tick = 0;
  const journal = jm.createJournal({
    runs,
    ops,
    target: (c) => ({ paths, control })[c],
    now: () => new Date(NOW.getTime() + tick++),
  });
  return { paths, control, runs, ops, journal };
}

const byId = (c: FakeCollection) =>
  Object.fromEntries(c.docs().map((d) => [d._id, d]));

Deno.test("fold: equal hash drops the prefixed doc; newer bare wins; newer prefixed wins; prefixed-only is created", async () => {
  const s = await sweeps();
  const h = await harness([
    live("data/equal", "h", "2026-08-01T00:00:00Z"),
    live(`${NS}/data/equal`, "h", "2026-08-05T00:00:00Z"),
    live("data/bare-newer", "b", "2026-08-10T00:00:00Z"),
    live(`${NS}/data/bare-newer`, "p", "2026-08-01T00:00:00Z"),
    live("data/prefixed-newer", "b", "2026-08-01T00:00:00Z"),
    live(`${NS}/data/prefixed-newer`, "p", "2026-08-10T00:00:00Z"),
    live(`${NS}/data/only`, "o", "2026-08-01T00:00:00Z"),
    live("data/untouched", "u", "2026-08-01T00:00:00Z"),
  ]);
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  assertEquals(r.refused, null);
  assertEquals([
    r.droppedEqual,
    r.bareWon,
    r.prefixedWon,
    r.created,
    r.tombstonesFolded,
  ], [1, 1, 1, 1, 0]);
  const d = byId(h.paths);
  assertEquals(d["data/equal"].hash, "h");
  assert(
    d[`${NS}/data/equal`].deletedAt !== null,
    "prefixed twin tombstoned, never removed",
  );
  assertEquals(d["data/bare-newer"].hash, "b");
  assert(d[`${NS}/data/bare-newer`].deletedAt !== null);
  assertEquals(d["data/prefixed-newer"].hash, "p");
  // Folded writes are stamped `now` so peers past the old timestamp still
  // pull them; the content (hash) comes from the winner.
  assertEquals(
    (d["data/prefixed-newer"].updatedAt as Date).toISOString(),
    NOW.toISOString(),
  );
  assert(d[`${NS}/data/prefixed-newer`].deletedAt !== null);
  assertEquals(d["data/only"].hash, "o");
  assertEquals(d["data/only"].deletedAt, null);
  assert(d[`${NS}/data/only`].deletedAt !== null);
  assertEquals(d["data/untouched"].hash, "u");
  assert(r.runId !== null);
  assertEquals((await h.journal.get(r.runId!))!.status, "completed");
});

Deno.test("fold: a prefixed tombstone folds onto an older live bare doc, never onto a newer one", async () => {
  const s = await sweeps();
  const h = await harness([
    live("data/deleted-on-mac", "h", "2026-08-01T00:00:00Z"),
    dead(`${NS}/data/deleted-on-mac`, "h", "2026-08-15T00:00:00Z"),
    live("data/rewritten-on-serve", "h2", "2026-08-20T00:00:00Z"),
    dead(`${NS}/data/rewritten-on-serve`, "h", "2026-08-15T00:00:00Z"),
  ]);
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  assertEquals(r.tombstonesFolded, 1);
  const d = byId(h.paths);
  assert(d["data/deleted-on-mac"].deletedAt !== null);
  assertEquals(d["data/rewritten-on-serve"].deletedAt, null);
});

Deno.test("fold: dry-run reports the same counts and performs zero writes", async () => {
  const s = await sweeps();
  const docs = [
    live("data/a", "h", "2026-08-01T00:00:00Z"),
    live(`${NS}/data/a`, "h", "2026-08-05T00:00:00Z"),
    live(`${NS}/data/b`, "x", "2026-08-05T00:00:00Z"),
  ];
  const dry = await harness(docs);
  const wet = await harness(docs);
  const rd = await s.foldNamespacePrefix(dry.paths, dry.journal, {
    namespace: NS,
    now: NOW,
  });
  const rw = await s.foldNamespacePrefix(wet.paths, wet.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  assertEquals(rd.dryRun, true);
  assertEquals([rd.scanned, rd.droppedEqual, rd.created], [
    rw.scanned,
    rw.droppedEqual,
    rw.created,
  ]);
  assertEquals(dry.paths.writes.length, 0);
  assertEquals(dry.ops.docs().length, 0);
  assert(wet.paths.writes.length > 0);
});

Deno.test("fold: journals a before-image for every touched doc before writing, and revert restores the collection", async () => {
  const s = await sweeps();
  const docs = [
    live("data/equal", "h", "2026-08-01T00:00:00Z"),
    live(`${NS}/data/equal`, "h", "2026-08-05T00:00:00Z"),
    live("data/pw", "b", "2026-08-01T00:00:00Z"),
    live(`${NS}/data/pw`, "p", "2026-08-10T00:00:00Z"),
    live(`${NS}/data/only`, "o", "2026-08-01T00:00:00Z"),
  ];
  const h = await harness(docs);
  const snapshot = h.paths.docs();
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  const touched = new Set(h.ops.docs().map((o) => o.targetId as string));
  assertEquals(
    [...touched].sort(),
    [
      `${NS}/data/equal`,
      `${NS}/data/only`,
      `${NS}/data/pw`,
      "data/only",
      "data/pw",
    ].sort(),
  );
  const firstOpWrite = h.ops.writes.length > 0;
  assert(firstOpWrite);
  const rv = await h.journal.revert(r.runId!, { dryRun: false });
  assertEquals(rv.refused, null);
  assertEquals(h.paths.docs(), snapshot);
});

Deno.test("fold: refuses while a prefixed doc was written within recentWriterMinutes, unless forced", async () => {
  const s = await sweeps();
  const docs = [live(`${NS}/data/fresh`, "h", "2026-09-02T11:50:00Z")];
  const h = await harness(docs);
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
    recentWriterMinutes: 30,
  });
  assert(r.refused !== null && r.refused.includes("fresh"));
  assertEquals(h.paths.writes.length, 0);
  assertEquals(r.runId, null);
  const forced = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
    recentWriterMinutes: 30,
    force: true,
  });
  assertEquals(forced.refused, null);
  assertEquals(forced.created, 1);
});

Deno.test("fold: refuses when a client stamp newer than 24h carries a version below the required one", async () => {
  const s = await sweeps();
  const h = await harness([live(`${NS}/data/x`, "h", "2026-08-01T00:00:00Z")]);
  const stale = {
    holder: "mac",
    version: "2026.08.27.1",
    at: T("2026-09-02T09:00:00Z"),
  };
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
    clientStamps: [stale],
    requiredVersion: "2026.09.03.1",
  });
  assert(r.refused !== null && r.refused.includes("mac"));
  const old = {
    holder: "mac",
    version: "2026.08.27.1",
    at: T("2026-08-20T09:00:00Z"),
  };
  const upgraded = {
    holder: "serve",
    version: "2026.09.03.1",
    at: T("2026-09-02T11:00:00Z"),
  };
  const ok = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
    clientStamps: [old, upgraded],
    requiredVersion: "2026.09.03.1",
  });
  assertEquals(ok.refused, null);
});

Deno.test("prefix_namespace inverts fold's post-upgrade delta: bare docs newer than `since` gain a prefixed twin", async () => {
  const s = await sweeps();
  const h = await harness([
    live("data/before", "h", "2026-08-01T00:00:00Z"),
    live("data/after", "h2", "2026-09-02T12:30:00Z"),
    dead("data/after-deleted", "h3", "2026-09-02T12:40:00Z"),
  ]);
  const r = await s.prefixNamespace(h.paths, h.journal, {
    namespace: NS,
    since: NOW,
    dryRun: false,
    now: T("2026-09-02T13:00:00Z"),
  });
  assertEquals(r.prefixed, 2);
  const d = byId(h.paths);
  assertEquals(d[`${NS}/data/after`].hash, "h2");
  assert(d[`${NS}/data/after-deleted`].deletedAt !== null);
  assertEquals(d[`${NS}/data/before`], undefined);
  const rv = await h.journal.revert(r.runId!, { dryRun: false });
  assertEquals(rv.deleted, 2);
});

Deno.test("import_control_records: copies serve's filesystem _control tree with putIfAbsent, journals hashes only, and reverts by deleting only what it inserted", async () => {
  const s = await sweeps();
  const cp = controlPlaneModule as unknown as ControlPlaneModule;
  const h = await harness([]);
  const control = cp.createControlPlaneStore(h.control, NS);
  await control.put("heartbeats/existing", enc("pre"));
  const dir = await Deno.makeTempDir({ prefix: "ctl-" });
  const root = `${dir}/_control`;
  await Deno.mkdir(`${root}/token-secrets`, { recursive: true });
  await Deno.mkdir(`${root}/heartbeats`, { recursive: true });
  await Deno.writeTextFile(`${root}/token-secrets/encryption-key`, "hunter2");
  await Deno.writeTextFile(`${root}/heartbeats/existing`, "fs-copy");
  await Deno.writeTextFile(`${root}/heartbeats/i1`, "alive");
  await Deno.writeTextFile(`${dir}/outside`, "x");
  await Deno.symlink(`${dir}/outside`, `${root}/heartbeats/link`);
  await Deno.writeFile(`${root}/heartbeats/big`, new Uint8Array(2048));
  try {
    const r = await s.importControlRecords(control, h.journal, {
      controlDir: root,
      dryRun: false,
      maxBytes: 1024,
    });
    assertEquals(r.inserted, 2);
    assertEquals(r.skipped, 1);
    assertEquals(r.rejected.sort(), ["heartbeats/big", "heartbeats/link"]);
    assertEquals(
      dec((await control.get("token-secrets/encryption-key"))!),
      "hunter2",
    );
    assertEquals(
      dec((await control.get("heartbeats/existing"))!),
      "pre",
      "putIfAbsent never overwrites",
    );
    const opsJson = JSON.stringify(h.ops.docs());
    assert(!opsJson.includes("hunter2"), "journal must not contain the secret");
    assert(opsJson.includes(await sha256Hex(enc("hunter2"))));
    const again = await s.importControlRecords(control, h.journal, {
      controlDir: root,
      dryRun: false,
      maxBytes: 1024,
    });
    assertEquals([again.inserted, again.skipped], [0, 3]);
    const rv = await h.journal.revert(r.runId!, { dryRun: false });
    assertEquals(rv.deleted, 2);
    assertEquals(await control.list(""), ["heartbeats/existing"]);
    assertEquals(
      await Deno.readTextFile(`${root}/token-secrets/encryption-key`),
      "hunter2",
      "import copies, never moves",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("import_control_records: rejects a directory that is not a _control tree", async () => {
  const s = await sweeps();
  const cp = controlPlaneModule as unknown as ControlPlaneModule;
  const h = await harness([]);
  const control = cp.createControlPlaneStore(h.control, NS);
  const dir = await Deno.makeTempDir({ prefix: "ctl-" });
  try {
    await assertRejects(
      () =>
        s.importControlRecords(control, h.journal, {
          controlDir: dir,
          dryRun: false,
        }),
      Error,
      "_control",
    );
    await assertRejects(
      () =>
        s.importControlRecords(control, h.journal, {
          controlDir: `${dir}/../_control`,
          dryRun: false,
        }),
      Error,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collection names derived in models/ equal the ones config.ts derives", async () => {
  const s = await sweeps();
  const cfgMod = configModule as unknown as ConfigModule;
  const cfg = cfgMod.ConfigSchema.parse({
    uri: "mongodb://127.0.0.1",
    username: "u",
    namespace: NS,
    tenantId: "acme",
  });
  assertEquals(
    s.controlCollectionNameFor("acme", NS),
    cfgMod.controlCollectionName(cfg),
  );
  assertEquals(
    s.journalCollectionNamesFor("acme", NS).runs,
    cfgMod.migrationsCollectionName(cfg),
  );
  assertEquals(
    s.journalCollectionNamesFor("acme", NS).ops,
    cfgMod.migrationOpsCollectionName(cfg),
  );
  assertEquals(
    s.controlCollectionNameFor("acme", NS),
    `t_acme_r_${NS}_control`,
  );
});

Deno.test("fold: every before-image is journaled before the first path write of its batch", async () => {
  const s = await sweeps();
  const h = await harness([
    live(`${NS}/data/a`, "h", "2026-08-01T00:00:00Z"),
    live(`${NS}/data/b`, "h", "2026-08-01T00:00:00Z"),
  ]);
  await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  const firstJournalWrite = Math.min(...h.ops.writes.map((w) => w.seq));
  const firstPathWrite = Math.min(...h.paths.writes.map((w) => w.seq));
  assert(
    firstJournalWrite < firstPathWrite,
    `journal seq ${firstJournalWrite} must precede path seq ${firstPathWrite}`,
  );
});

Deno.test("fold: client version stamps compare numerically, not lexically", async () => {
  const s = await sweeps();
  const h = await harness([live(`${NS}/data/x`, "h", "2026-08-01T00:00:00Z")]);
  // Lexically "2026.9.3.1" > "2026.10.1.1"; numerically it is older.
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
    clientStamps: [{
      holder: "mac",
      version: "2026.9.3.1",
      at: T("2026-09-02T11:00:00Z"),
    }],
    requiredVersion: "2026.10.1.1",
  });
  assert(r.refused !== null && r.refused.includes("mac"));
  const ok = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
    clientStamps: [{
      holder: "mac",
      version: "2026.10.1.1",
      at: T("2026-09-02T11:00:00Z"),
    }],
    requiredVersion: "2026.9.3.1",
  });
  assertEquals(ok.refused, null);
});

Deno.test("import_control_records: dry-run reports counts and writes nothing", async () => {
  const s = await sweeps();
  const cp = controlPlaneModule as unknown as ControlPlaneModule;
  const h = await harness([]);
  const control = cp.createControlPlaneStore(h.control, NS);
  const dir = await Deno.makeTempDir({ prefix: "ctl-" });
  const root = `${dir}/_control`;
  await Deno.mkdir(`${root}/heartbeats`, { recursive: true });
  await Deno.writeTextFile(`${root}/heartbeats/i1`, "alive");
  try {
    const r = await s.importControlRecords(control, h.journal, {
      controlDir: root,
    });
    assertEquals(r.dryRun, true);
    assertEquals(r.inserted, 1);
    assertEquals(r.runId, null);
    assertEquals(h.control.writes.length, 0);
    assertEquals(h.ops.docs().length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("import_control_records: a symlink named _control pointing elsewhere is rejected after realpath", async () => {
  const s = await sweeps();
  const cp = controlPlaneModule as unknown as ControlPlaneModule;
  const h = await harness([]);
  const control = cp.createControlPlaneStore(h.control, NS);
  const dir = await Deno.makeTempDir({ prefix: "ctl-" });
  await Deno.mkdir(`${dir}/elsewhere/heartbeats`, { recursive: true });
  await Deno.writeTextFile(`${dir}/elsewhere/heartbeats/i1`, "x");
  await Deno.symlink(`${dir}/elsewhere`, `${dir}/_control`);
  try {
    await assertRejects(
      () =>
        s.importControlRecords(control, h.journal, {
          controlDir: `${dir}/_control`,
          dryRun: false,
        }),
      Error,
      "_control",
    );
    assertEquals(h.control.docs().length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fold: streams the prefixed cursor in batches and starts no run on an empty namespace", async () => {
  const s = await sweeps();
  const empty = await harness([
    live("data/only-bare", "h", "2026-08-01T00:00:00Z"),
  ]);
  const r0 = await s.foldNamespacePrefix(empty.paths, empty.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  assertEquals([r0.scanned, r0.runId], [0, null]);
  assertEquals(empty.runs.docs().length, 0);
  const many = Array.from(
    { length: 1203 },
    (_, i) =>
      live(
        `${NS}/data/f${String(i).padStart(4, "0")}`,
        `h${i}`,
        "2026-08-01T00:00:00Z",
      ),
  );
  const h = await harness(many);
  const r = await s.foldNamespacePrefix(h.paths, h.journal, {
    namespace: NS,
    dryRun: false,
    now: NOW,
  });
  assertEquals([r.scanned, r.created], [1203, 1203]);
  const bulkWrites = h.paths.writes.filter((w) => w.op === "bulkWrite").length;
  assertEquals(bulkWrites, 3, "500 + 500 + 203 → three batches");
  assertEquals(h.ops.docs().length, 1203 * 2);
});
