// RED tests for sync.ts: namespace-aware path layout, legacy-prefix
// tolerance on pull, subdirs pulls, two-phase push, the control-plane store
// bound to the last-seen namespace, the client version stamp, and the
// advertised capabilities.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Binary } from "npm:mongodb@6.17.0";
import { ConfigSchema } from "./config.ts";
import { getSidecar } from "./sidecar.ts";
import { createSyncService as createSyncServiceTyped } from "./sync.ts";
import {
  dec,
  enc,
  FakeClient,
  fakeClientFactory,
  FakeCollection,
  sha256Hex,
} from "./test_fakes.ts";

const NS = "dev-tmp-swamp";
const PREFIX = `t_default_r_${NS}`;

interface SyncOptions {
  namespace?: string;
  subdirs?: readonly string[];
  relPath?: string;
  metadataOnly?: boolean;
  context?: { models?: ReadonlyArray<{ modelType: string; modelId: string }> };
}
interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
interface SyncService {
  capabilities(): Record<string, boolean | undefined>;
  pullChanged(o?: SyncOptions): Promise<number>;
  pushChanged(o?: SyncOptions): Promise<number>;
  markDirty(o?: SyncOptions): Promise<void>;
  preparePush(o?: SyncOptions): Promise<unknown>;
  commitPush(manifest: unknown, o?: SyncOptions): Promise<number>;
  controlPlaneStore(): ControlPlaneStore;
}
type Factory = (
  cfg: unknown,
  getClient: unknown,
  repoDir: string,
  cachePath: string,
) => SyncService;
const createSyncService = createSyncServiceTyped as unknown as Factory;

async function setup() {
  const cacheDir = await Deno.makeTempDir({ prefix: "mongo-sync-test-" });
  const client = new FakeClient();
  const { getClient } = fakeClientFactory(client);
  const cfg = ConfigSchema.parse({
    uri: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
    username: "u",
    namespace: NS,
  });
  const db = client.db("swamp");
  const paths = db.collection(`${PREFIX}_paths`);
  const blobs = db.collection(`${PREFIX}_blobs`);
  const control = db.collection(`${PREFIX}_control`);
  const svc = createSyncService(cfg, getClient, "/repo", cacheDir);
  // The service interns its sidecar at the TIER root (a fork guard from
  // 2026.09.01.2), not the bare cache path.
  const sidecar = getSidecar(`${cacheDir}/${NS}`);
  const cleanup = async () => {
    await sidecar.close();
    await Deno.remove(cacheDir, { recursive: true });
  };
  return { cacheDir, db, paths, blobs, control, svc, sidecar, cleanup };
}

async function remoteFile(
  paths: FakeCollection,
  blobs: FakeCollection,
  id: string,
  content: string,
  updatedAt: Date,
  deletedAt: Date | null = null,
): Promise<string> {
  const bytes = enc(content);
  const hash = await sha256Hex(bytes);
  if (!blobs.store.has(hash)) {
    blobs.store.set(hash, {
      _id: hash,
      size: bytes.byteLength,
      createdAt: updatedAt,
      data: new Binary(bytes),
    });
  }
  paths.store.set(id, {
    _id: id,
    hash,
    size: bytes.byteLength,
    updatedAt,
    deletedAt,
  });
  return hash;
}

async function writeLocal(
  cacheDir: string,
  rel: string,
  content: string,
): Promise<void> {
  const abs = `${cacheDir}/${rel}`;
  await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(abs, content);
}

async function readLocal(
  cacheDir: string,
  rel: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${cacheDir}/${rel}`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

const T = (s: string) => new Date(s);

Deno.test("sync: capabilities advertise all six flags", async () => {
  const { svc, cleanup } = await setup();
  try {
    const caps = svc.capabilities();
    for (
      const k of [
        "scopedSync",
        "lazyHydration",
        "namespacedSync",
        "twoPhaseSync",
        "controlPlane",
        "configRefresh",
      ]
    ) {
      assertEquals(caps[k], true, k);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("sync: pull lands under core's namespace when passed, under config.namespace when a call carries none, never at the bare root", async () => {
  const a = await setup();
  const b = await setup();
  const c = await setup();
  try {
    for (const s of [a, b, c]) {
      await remoteFile(
        s.paths,
        s.blobs,
        "data/host/vm-1/out/1/raw",
        "hello",
        T("2026-09-01T00:00:00Z"),
      );
    }
    // Core passes its namespace (equal to config.namespace in every real
    // deployment).
    await a.svc.pullChanged({ namespace: NS });
    assertEquals(
      await readLocal(a.cacheDir, `${NS}/data/host/vm-1/out/1/raw`),
      "hello",
    );
    assertEquals(await readLocal(a.cacheDir, "data/host/vm-1/out/1/raw"), null);
    // No namespace on the call: the 2026.09.01.2 behaviour — config.namespace
    // roots the tier (tierRoot fork guard), never the bare cache root.
    await b.svc.pullChanged({});
    assertEquals(
      await readLocal(b.cacheDir, `${NS}/data/host/vm-1/out/1/raw`),
      "hello",
    );
    assertEquals(await readLocal(b.cacheDir, "data/host/vm-1/out/1/raw"), null);
    // Core's namespace differs from config.namespace: core's wins, because it
    // is the one DefaultDatastorePathResolver reads under.
    await c.svc.pullChanged({ namespace: "other-core-ns" });
    assertEquals(
      await readLocal(c.cacheDir, "other-core-ns/data/host/vm-1/out/1/raw"),
      "hello",
    );
    assertEquals(
      await readLocal(c.cacheDir, `${NS}/data/host/vm-1/out/1/raw`),
      null,
    );
  } finally {
    await a.cleanup();
    await b.cleanup();
    await c.cleanup();
  }
});

Deno.test("sync: pull strips a legacy <ns>/ remote prefix and the newer twin wins, tie to the bare id", async () => {
  const { svc, paths, blobs, cacheDir, cleanup } = await setup();
  try {
    await remoteFile(
      paths,
      blobs,
      "data/m/i/latest",
      "old",
      T("2026-08-01T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      `${NS}/data/m/i/latest`,
      "new",
      T("2026-08-20T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      "data/m/i/tie",
      "bare",
      T("2026-08-10T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      `${NS}/data/m/i/tie`,
      "prefixed",
      T("2026-08-10T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      `${NS}/data/m/i/only-prefixed`,
      "p",
      T("2026-08-10T00:00:00Z"),
    );
    await svc.pullChanged({ namespace: NS });
    assertEquals(await readLocal(cacheDir, `${NS}/data/m/i/latest`), "new");
    assertEquals(await readLocal(cacheDir, `${NS}/data/m/i/tie`), "bare");
    assertEquals(
      await readLocal(cacheDir, `${NS}/data/m/i/only-prefixed`),
      "p",
    );
    assertEquals(
      await readLocal(cacheDir, `${NS}/${NS}/data/m/i/latest`),
      null,
      "no doubled prefix on disk",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("sync: subdirs pull fetches only the listed prefixes, escapes metacharacters, and leaves the watermark alone", async () => {
  const { svc, paths, blobs, cacheDir, sidecar, cleanup } = await setup();
  try {
    await remoteFile(
      paths,
      blobs,
      "config/pulled-extensions/x.yaml",
      "cfg",
      T("2026-09-01T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      "data/m/i/n/1/raw",
      "content",
      T("2026-09-01T00:00:00Z"),
    );
    await remoteFile(paths, blobs, "a.b/f", "dot", T("2026-09-01T00:00:00Z"));
    await remoteFile(paths, blobs, "aXb/f", "x", T("2026-09-01T00:00:00Z"));
    const n = await svc.pullChanged({
      namespace: NS,
      subdirs: ["config", "a.b"],
    });
    assertEquals(n, 2);
    assertEquals(
      await readLocal(cacheDir, `${NS}/config/pulled-extensions/x.yaml`),
      "cfg",
    );
    assertEquals(await readLocal(cacheDir, `${NS}/a.b/f`), "dot");
    assertEquals(await readLocal(cacheDir, `${NS}/aXb/f`), null);
    assertEquals(await readLocal(cacheDir, `${NS}/data/m/i/n/1/raw`), null);
    assertEquals(
      (await sidecar.read()).lastPulledAt,
      null,
      "a subdirs pull must not advance lastPulledAt",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("sync: scoped pull by model queries tier-relative prefixes and lands files under the namespace", async () => {
  const { svc, paths, blobs, cacheDir, cleanup } = await setup();
  try {
    await remoteFile(
      paths,
      blobs,
      "data/host/vm-1/out/1/raw",
      "vm1",
      T("2026-09-01T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      "data/host/vm-2/out/1/raw",
      "vm2",
      T("2026-09-01T00:00:00Z"),
    );
    await svc.pullChanged({
      namespace: NS,
      context: { models: [{ modelType: "host", modelId: "vm-1" }] },
    });
    assertEquals(
      await readLocal(cacheDir, `${NS}/data/host/vm-1/out/1/raw`),
      "vm1",
    );
    assertEquals(
      await readLocal(cacheDir, `${NS}/data/host/vm-2/out/1/raw`),
      null,
    );
    const scoped = paths.queries.find((q) =>
      JSON.stringify(q).includes("data/host/vm-1/")
    );
    assert(scoped !== undefined, "expected a query scoped to data/host/vm-1/");
    assert(
      !JSON.stringify(scoped).includes(`${NS}/data`),
      "remote prefix must not carry the namespace",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("sync: full-walk push maps <cache>/<ns>/<rel> to tier-relative ids and ignores old root-tier files", async () => {
  const { svc, paths, cacheDir, cleanup } = await setup();
  try {
    await writeLocal(cacheDir, `${NS}/data/host/vm-1/out/1/raw`, "new-layout");
    await writeLocal(cacheDir, "data/host/vm-9/out/1/raw", "old-layout");
    await svc.pushChanged({ namespace: NS });
    const ids = paths.docs().map((d) => d._id);
    assertEquals(ids, ["data/host/vm-1/out/1/raw"]);
  } finally {
    await cleanup();
  }
});

async function bootstrapped() {
  const s = await setup();
  await s.svc.pushChanged({ namespace: NS });
  await writeLocal(s.cacheDir, `${NS}/data/m/i/n/1/raw`, "v1");
  await s.svc.markDirty({ relPath: `${NS}/data/m/i/n/1/raw`, namespace: NS });
  return s;
}

Deno.test("sync: preparePush uploads blobs only and leaves paths and the dirty journal untouched", async () => {
  const s = await bootstrapped();
  try {
    const manifest = await s.svc.preparePush({ namespace: NS });
    assert(manifest !== null && manifest !== undefined);
    const hash = await sha256Hex(enc("v1"));
    assert(s.blobs.store.has(hash), "blob uploaded in prepare");
    assertEquals(s.paths.docs().length, 0, "no path docs before commit");
    assertEquals((await s.sidecar.read()).dirtyPaths, [
      "data/m/i/n/1/raw",
    ]);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: commitPush upserts tier-relative path docs and forgets only the consumed dirty set", async () => {
  const s = await bootstrapped();
  try {
    const manifest = await s.svc.preparePush({ namespace: NS });
    await writeLocal(s.cacheDir, `${NS}/data/m/i/n2/1/raw`, "late");
    await s.svc.markDirty({
      relPath: `${NS}/data/m/i/n2/1/raw`,
      namespace: NS,
    });
    const n = await s.svc.commitPush(manifest, { namespace: NS });
    assert(n > 0);
    const ids = s.paths.docs().map((d) => d._id);
    assertEquals(ids, ["data/m/i/n/1/raw"]);
    assertEquals((await s.sidecar.read()).dirtyPaths, [
      "data/m/i/n2/1/raw",
    ], "dirty path added after prepare survives commit");
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: a bulk invalidation between prepare and commit is not cleared by commit", async () => {
  const s = await bootstrapped();
  try {
    const manifest = await s.svc.preparePush({ namespace: NS });
    await s.svc.markDirty({ namespace: NS });
    await s.svc.commitPush(manifest, { namespace: NS });
    assertEquals((await s.sidecar.read()).bulkInvalidated, true);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: a commit failure leaves the dirty journal intact for retry", async () => {
  const s = await bootstrapped();
  try {
    const manifest = await s.svc.preparePush({ namespace: NS });
    s.paths.failNextBulkWrite = new Error("primary stepped down");
    await assertRejects(
      () => s.svc.commitPush(manifest, { namespace: NS }),
      Error,
      "stepped down",
    );
    assertEquals((await s.sidecar.read()).dirtyPaths, [
      "data/m/i/n/1/raw",
    ]);
    assertEquals(s.paths.docs().length, 0);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: pushChanged produces the same remote state as prepare + commit", async () => {
  const one = await bootstrapped();
  const two = await bootstrapped();
  try {
    await one.svc.pushChanged({ namespace: NS });
    const manifest = await two.svc.preparePush({ namespace: NS });
    await two.svc.commitPush(manifest, { namespace: NS });
    const strip = (c: FakeCollection) =>
      c.docs().map((d) => ({
        _id: d._id,
        hash: d.hash,
        deletedAt: d.deletedAt,
      }));
    assertEquals(strip(two.paths), strip(one.paths));
    assertEquals(
      [...two.blobs.store.keys()].sort(),
      [...one.blobs.store.keys()].sort(),
    );
    assertEquals((await one.sidecar.read()).dirtyPaths, []);
    assertEquals((await two.sidecar.read()).dirtyPaths, []);
  } finally {
    await one.cleanup();
    await two.cleanup();
  }
});

Deno.test("sync: push stamps this client's extension version into the control plane", async () => {
  const s = await bootstrapped();
  try {
    await s.svc.pushChanged({ namespace: NS });
    const stamps = s.control.docs().filter((d) =>
      d._id.includes("_control/clients/")
    );
    assertEquals(stamps.length, 1);
    assert(stamps[0]._id.startsWith(`${NS}/_control/clients/`));
    const body = JSON.parse(dec((stamps[0].data as Binary).buffer)) as {
      version: string;
      at: string;
    };
    assert(typeof body.version === "string" && body.version.length > 0);
    assert(!Number.isNaN(Date.parse(body.at)));
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: controlPlaneStore() binds to the namespace last seen on pull or push", async () => {
  const s = await setup();
  try {
    await s.svc.pullChanged({ namespace: NS });
    const cp = s.svc.controlPlaneStore();
    assertEquals(await cp.putIfAbsent("fire-records/w/1", enc("x")), true);
    assertEquals(await cp.putIfAbsent("fire-records/w/1", enc("y")), false);
    assertEquals(s.control.docs().map((d) => d._id), [
      `${NS}/_control/fire-records/w/1`,
    ]);
    assertEquals(await cp.list("fire-records/"), ["fire-records/w/1"]);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: markDirty for a namespaced relPath is pushed tier-relative by the dirty-root path", async () => {
  const s = await bootstrapped();
  try {
    await s.svc.pushChanged({ namespace: NS });
    assertEquals(s.paths.docs().map((d) => d._id), ["data/m/i/n/1/raw"]);
    assertEquals(s.paths.docs()[0].hash, await sha256Hex(enc("v1")));
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: hydrateFile maps a namespaced cache-relative path to its tier-relative remote id", async () => {
  const s = await setup();
  try {
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/n/1/raw",
      "lazy-bytes",
      T("2026-09-01T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS, metadataOnly: true });
    const svc = s.svc as unknown as {
      hydrateFile(relPath: string): Promise<boolean>;
    };
    assertEquals(await svc.hydrateFile(`${NS}/data/m/i/n/1/raw`), true);
    assertEquals(
      await readLocal(s.cacheDir, `${NS}/data/m/i/n/1/raw`),
      "lazy-bytes",
    );
    assertEquals(await svc.hydrateFile(`${NS}/data/m/i/missing/1/raw`), false);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: a remote tombstone (bare or legacy-prefixed) removes the local file under the namespace", async () => {
  const s = await setup();
  try {
    await writeLocal(s.cacheDir, `${NS}/data/m/i/a/1/raw`, "a");
    await writeLocal(s.cacheDir, `${NS}/data/m/i/b/1/raw`, "b");
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/a/1/raw",
      "a",
      T("2026-09-01T00:00:00Z"),
      T("2026-09-01T00:00:00Z"),
    );
    await remoteFile(
      s.paths,
      s.blobs,
      `${NS}/data/m/i/b/1/raw`,
      "b",
      T("2026-09-01T00:00:00Z"),
      T("2026-09-01T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/a/1/raw`), null);
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/b/1/raw`), null);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: two-phase push tombstones a file deleted locally after commit re-reads the remote", async () => {
  const s = await bootstrapped();
  try {
    await s.svc.pushChanged({ namespace: NS });
    await s.svc.pullChanged({ namespace: NS });
    await Deno.remove(`${s.cacheDir}/${NS}/data/m/i/n/1/raw`);
    await s.svc.markDirty({ relPath: `${NS}/data/m/i/n/1/raw`, namespace: NS });
    const manifest = await s.svc.preparePush({ namespace: NS });
    assertEquals(s.paths.docs()[0].deletedAt, null, "prepare never tombstones");
    await s.svc.commitPush(manifest, { namespace: NS });
    assert(
      s.paths.docs()[0].deletedAt !== null,
      "commit tombstones the absent path",
    );
    assertEquals(s.paths.docs()[0]._id, "data/m/i/n/1/raw");
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: old root-tier files are left on disk untouched by push and pull under a namespace", async () => {
  const s = await setup();
  try {
    await writeLocal(s.cacheDir, "data/host/vm-9/out/1/raw", "old-layout");
    await s.svc.pushChanged({ namespace: NS });
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(
      await readLocal(s.cacheDir, "data/host/vm-9/out/1/raw"),
      "old-layout",
    );
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: a full-walk prepare + commit clears bulkInvalidated when no bulk signal arrived in between", async () => {
  const s = await bootstrapped();
  try {
    await s.svc.markDirty({ namespace: NS });
    assertEquals((await s.sidecar.read()).bulkInvalidated, true);
    const manifest = await s.svc.preparePush({ namespace: NS });
    await s.svc.commitPush(manifest, { namespace: NS });
    assertEquals((await s.sidecar.read()).bulkInvalidated, false);
    assertEquals(s.paths.docs().map((d) => d._id), ["data/m/i/n/1/raw"]);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: a subdirs pull after a full pull uses the watermark — quiet tier costs no file work, new docs still arrive", async () => {
  const s = await setup();
  try {
    await remoteFile(
      s.paths,
      s.blobs,
      "config/a.yaml",
      "a",
      T("2026-09-01T00:00:00Z"),
    );
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/n/1/raw",
      "d",
      T("2026-09-01T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    const watermark = (await s.sidecar.read()).lastPulledAt;
    assert(watermark !== null);
    const queriesBefore = s.paths.queries.length;
    assertEquals(
      await s.svc.pullChanged({ namespace: NS, subdirs: ["config"] }),
      0,
    );
    assertEquals(
      s.paths.queries.length - queriesBefore,
      1,
      "one probe, no scan",
    );
    await remoteFile(
      s.paths,
      s.blobs,
      "config/b.yaml",
      "b",
      T("2026-09-02T00:00:00Z"),
    );
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/n/2/raw",
      "d2",
      T("2026-09-02T00:00:00Z"),
    );
    assertEquals(
      await s.svc.pullChanged({ namespace: NS, subdirs: ["config"] }),
      1,
    );
    assertEquals(await readLocal(s.cacheDir, `${NS}/config/b.yaml`), "b");
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/n/2/raw`), null);
    assertEquals(
      (await s.sidecar.read()).lastPulledAt,
      watermark,
      "subdirs pull never advances the watermark",
    );
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: a legacy tombstone never outranks a bare doc, a live newer legacy doc still does", async () => {
  const { svc, paths, blobs, cacheDir, cleanup } = await setup();
  try {
    // Post-fold shape: bare live (older), legacy tombstoned (newer).
    await remoteFile(
      paths,
      blobs,
      "data/m/i/latest",
      "keep",
      T("2026-08-01T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      `${NS}/data/m/i/latest`,
      "gone",
      T("2026-09-01T00:00:00Z"),
      T("2026-09-01T00:00:00Z"),
    );
    // Old client still writing: legacy live and newer than the bare doc.
    await remoteFile(
      paths,
      blobs,
      "data/m/i/old",
      "bare",
      T("2026-08-01T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      `${NS}/data/m/i/old`,
      "legacy-newer",
      T("2026-08-20T00:00:00Z"),
    );
    // Bare tombstoned after the legacy doc was written: deletion wins.
    await remoteFile(
      paths,
      blobs,
      "data/m/i/deleted",
      "x",
      T("2026-08-20T00:00:00Z"),
      T("2026-08-20T00:00:00Z"),
    );
    await remoteFile(
      paths,
      blobs,
      `${NS}/data/m/i/deleted`,
      "legacy-older",
      T("2026-08-10T00:00:00Z"),
    );
    await svc.pullChanged({ namespace: NS });
    assertEquals(await readLocal(cacheDir, `${NS}/data/m/i/latest`), "keep");
    assertEquals(
      await readLocal(cacheDir, `${NS}/data/m/i/old`),
      "legacy-newer",
    );
    assertEquals(await readLocal(cacheDir, `${NS}/data/m/i/deleted`), null);
  } finally {
    await cleanup();
  }
});

Deno.test("sync: a watermark pull that sees only the legacy tombstone still keeps the live bare file", async () => {
  const s = await setup();
  try {
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/latest",
      "keep",
      T("2026-09-01T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/latest`), "keep");
    // A fold tombstones the legacy twin AFTER the watermark; the bare doc is
    // untouched and therefore outside the next pull's window.
    await remoteFile(
      s.paths,
      s.blobs,
      `${NS}/data/m/i/latest`,
      "old",
      T("2026-09-02T00:00:00Z"),
      T("2026-09-02T00:00:00Z"),
    );
    assertEquals(await s.svc.pullChanged({ namespace: NS }), 0);
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/latest`), "keep");
    // The reverse: a bare tombstone in the window must not be outranked by an
    // older live legacy doc outside it.
    await remoteFile(
      s.paths,
      s.blobs,
      `${NS}/data/m/i/gone`,
      "legacy",
      T("2026-08-01T00:00:00Z"),
    );
    await writeLocal(s.cacheDir, `${NS}/data/m/i/gone`, "legacy");
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/gone",
      "x",
      T("2026-09-03T00:00:00Z"),
      T("2026-09-03T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/gone`), null);
  } finally {
    await s.cleanup();
  }
});

Deno.test("sync: the twin lookup is skipped once a cold pull saw no legacy ids, and resumes when one appears", async () => {
  const s = await setup();
  const twinQueries = () =>
    s.paths.queries.filter((q) => JSON.stringify(q).includes('"$in"')).length;
  try {
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/a",
      "a",
      T("2026-09-01T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(
      (await s.sidecar.read() as unknown as { legacyIdsPossible: boolean })
        .legacyIdsPossible,
      false,
    );
    const before = twinQueries();
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/b",
      "b",
      T("2026-09-02T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(
      twinQueries(),
      before,
      "no twin lookup on a namespace with no legacy ids",
    );
    assertEquals(await readLocal(s.cacheDir, `${NS}/data/m/i/b`), "b");
    // An old client writes a legacy id: the flag flips back and precedence applies.
    await remoteFile(
      s.paths,
      s.blobs,
      `${NS}/data/m/i/a`,
      "legacy-newer",
      T("2026-09-03T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assertEquals(
      (await s.sidecar.read() as unknown as { legacyIdsPossible: boolean })
        .legacyIdsPossible,
      true,
    );
    assertEquals(
      await readLocal(s.cacheDir, `${NS}/data/m/i/a`),
      "legacy-newer",
    );
    await remoteFile(
      s.paths,
      s.blobs,
      "data/m/i/c",
      "c",
      T("2026-09-04T00:00:00Z"),
    );
    await s.svc.pullChanged({ namespace: NS });
    assert(twinQueries() > before, "twin lookup resumed");
  } finally {
    await s.cleanup();
  }
});
