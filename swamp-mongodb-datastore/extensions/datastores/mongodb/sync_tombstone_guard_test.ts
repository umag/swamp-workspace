// Push reconcile-tombstone guards (2026-11-24 incident): one push from a
// non-lazy cache tombstoned ~35k remote paths in a live namespace, including
// the enrollment-token auto-definition every worker enrolls with. Three
// guards, one test group each:
//   1. a full walk only tombstones inside the subdirs it walked — anything
//      outside (auto-definitions/, config/) was never compared, so absent
//      locally means "not walked", not "deleted";
//   2. swamp control-plane records (tokens, grants, workers, ...) are never
//      tombstoned by a push, matching core's retention exemption;
//   3. a push whose tombstone pass would exceed `maxPushTombstones` skips the
//      whole pass rather than mass-deleting the namespace.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Binary } from "npm:mongodb@6.17.0";
import { ConfigSchema } from "./config.ts";
import { getSidecar } from "./sidecar.ts";
import {
  createSyncService as createSyncServiceTyped,
  isTombstoneProtected,
} from "./sync.ts";
import {
  enc,
  FakeClient,
  fakeClientFactory,
  type FakeCollection,
  sha256Hex,
} from "./test_fakes.ts";

const NS = "dev-tmp-swamp";
const PREFIX = `t_default_r_${NS}`;
const OLD = new Date("2026-01-01T00:00:00Z");

interface SyncOptions {
  namespace?: string;
  relPath?: string;
}
interface SyncService {
  pullChanged(o?: SyncOptions): Promise<number>;
  pushChanged(o?: SyncOptions): Promise<number>;
  markDirty(o?: SyncOptions): Promise<void>;
}
type Factory = (
  cfg: unknown,
  getClient: unknown,
  repoDir: string,
  cachePath: string,
) => SyncService;
const createSyncService = createSyncServiceTyped as unknown as Factory;

async function setup(extra: Record<string, unknown> = {}) {
  const cacheDir = await Deno.makeTempDir({ prefix: "mongo-tomb-guard-" });
  const client = new FakeClient();
  const { getClient } = fakeClientFactory(client);
  const cfg = ConfigSchema.parse({
    uri: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
    username: "u",
    namespace: NS,
    ...extra,
  });
  const db = client.db("swamp");
  const paths = db.collection(`${PREFIX}_paths`);
  const blobs = db.collection(`${PREFIX}_blobs`);
  const svc = createSyncService(cfg, getClient, "/repo", cacheDir);
  const sidecar = getSidecar(`${cacheDir}/${NS}`);
  const cleanup = async () => {
    await sidecar.close();
    await Deno.remove(cacheDir, { recursive: true });
  };
  return { cacheDir, paths, blobs, svc, cleanup };
}

async function remoteFile(
  paths: FakeCollection,
  blobs: FakeCollection,
  id: string,
  content: string,
): Promise<void> {
  const bytes = enc(content);
  const hash = await sha256Hex(bytes);
  blobs.store.set(hash, {
    _id: hash,
    size: bytes.byteLength,
    createdAt: OLD,
    data: new Binary(bytes),
  });
  paths.store.set(id, {
    _id: id,
    hash,
    size: bytes.byteLength,
    updatedAt: OLD,
    deletedAt: null,
  });
}

function deletedAt(paths: FakeCollection, id: string): unknown {
  return paths.store.get(id)?.deletedAt ?? null;
}

Deno.test("guard: a full-walk push never tombstones remote paths outside the walked subdirs", async () => {
  const s = await setup();
  try {
    const autoDef = "auto-definitions/swamp/enrollment-token/w.yaml";
    const userAutoDef = "auto-definitions/@adam/cfgmgmt/homebrew/x.yaml";
    const config = "config/access.yaml";
    await remoteFile(s.paths, s.blobs, autoDef, "token def");
    await remoteFile(s.paths, s.blobs, userAutoDef, "user def");
    await remoteFile(s.paths, s.blobs, config, "cfg");
    await remoteFile(s.paths, s.blobs, "data/m/i/n/1/raw", "v1");
    // Full unscoped pull: reconcile watermark set, lazy mode off — the state
    // serve's cache is in.
    await s.svc.pullChanged({ namespace: NS });
    // Bulk invalidation forces the next push to be a full walk.
    await s.svc.markDirty({ namespace: NS });
    await s.svc.pushChanged({ namespace: NS });
    assertEquals(deletedAt(s.paths, autoDef), null);
    assertEquals(deletedAt(s.paths, userAutoDef), null);
    assertEquals(deletedAt(s.paths, config), null);
    assertEquals(deletedAt(s.paths, "data/m/i/n/1/raw"), null);
  } finally {
    await s.cleanup();
  }
});

Deno.test("guard: a full-walk push still tombstones a walked-subdir file deleted locally", async () => {
  const s = await setup();
  try {
    await remoteFile(s.paths, s.blobs, "data/m/i/n/1/raw", "v1");
    await remoteFile(s.paths, s.blobs, "data/m/i/n/2/raw", "v2");
    await s.svc.pullChanged({ namespace: NS });
    await Deno.remove(`${s.cacheDir}/${NS}/data/m/i/n/2/raw`);
    await s.svc.markDirty({ namespace: NS });
    await s.svc.pushChanged({ namespace: NS });
    assertEquals(deletedAt(s.paths, "data/m/i/n/1/raw"), null);
    assert(deletedAt(s.paths, "data/m/i/n/2/raw") !== null);
  } finally {
    await s.cleanup();
  }
});

Deno.test("guard: control-plane records absent locally are never tombstoned by a push", async () => {
  const s = await setup();
  try {
    const token = "data/swamp/enrollment-token/abc/token-main/1/raw";
    const grant = "data/@swamp/grant/def/grant/1/raw";
    const plain = "data/@magistr/x/ghi/result/1/raw";
    for (const id of [token, grant, plain]) {
      await remoteFile(s.paths, s.blobs, id, id);
    }
    await s.svc.pullChanged({ namespace: NS });
    for (const id of [token, grant, plain]) {
      await Deno.remove(`${s.cacheDir}/${NS}/${id}`);
    }
    await s.svc.markDirty({ namespace: NS });
    await s.svc.pushChanged({ namespace: NS });
    assertEquals(deletedAt(s.paths, token), null);
    assertEquals(deletedAt(s.paths, grant), null);
    assert(deletedAt(s.paths, plain) !== null, "ordinary data still deletes");
  } finally {
    await s.cleanup();
  }
});

Deno.test("guard: a push over maxPushTombstones skips the whole tombstone pass", async () => {
  const s = await setup({ maxPushTombstones: 3 });
  try {
    const ids = [1, 2, 3, 4, 5].map((n) => `data/m/i/n/${n}/raw`);
    for (const id of ids) await remoteFile(s.paths, s.blobs, id, id);
    await s.svc.pullChanged({ namespace: NS });
    for (const id of ids) await Deno.remove(`${s.cacheDir}/${NS}/${id}`);
    await s.svc.markDirty({ namespace: NS });
    await s.svc.pushChanged({ namespace: NS });
    for (const id of ids) assertEquals(deletedAt(s.paths, id), null, id);
  } finally {
    await s.cleanup();
  }
});

Deno.test("guard: a push at or under maxPushTombstones tombstones normally; 0 disables the cap", async () => {
  for (const cap of [3, 0]) {
    const s = await setup({ maxPushTombstones: cap });
    try {
      const ids = [1, 2, 3].map((n) => `data/m/i/n/${n}/raw`);
      for (const id of ids) await remoteFile(s.paths, s.blobs, id, id);
      await s.svc.pullChanged({ namespace: NS });
      for (const id of ids) await Deno.remove(`${s.cacheDir}/${NS}/${id}`);
      await s.svc.markDirty({ namespace: NS });
      await s.svc.pushChanged({ namespace: NS });
      for (const id of ids) {
        assert(deletedAt(s.paths, id) !== null, `cap=${cap} ${id}`);
      }
    } finally {
      await s.cleanup();
    }
  }
});

Deno.test("guard: isTombstoneProtected matches every control-plane type in both spellings, nothing else", () => {
  for (
    const t of [
      "enrollment-token",
      "worker",
      "step-lease",
      "pending-dispatch",
      "fleet-probe",
      "server-token",
      "grant",
      "group",
      "integration",
      "delegation",
    ]
  ) {
    for (const tier of ["auto-definitions", "data", "definitions-evaluated"]) {
      assert(isTombstoneProtected(`${tier}/swamp/${t}/x.yaml`), `${tier} ${t}`);
      assert(isTombstoneProtected(`${tier}/@swamp/${t}/x/y`), `${tier} @${t}`);
    }
  }
  for (
    const p of [
      "data/swamp/workflow-run/x",
      "data/@swamp/ssh/x/raw",
      "data/@magistr/grant/x",
      "data/swamp/grantx/x",
      "workflow-runs/swamp/grant/x",
    ]
  ) {
    assertEquals(isTombstoneProtected(p), false, p);
  }
});
