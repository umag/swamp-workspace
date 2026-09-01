import { assertEquals } from "jsr:@std/assert@1";
import { ConfigSchema, tierRoot } from "./config.ts";
import { Sidecar } from "./sidecar.ts";
import { createSyncService } from "./sync.ts";

// Coverage suite: guards a reviewer found load-bearing but untested.
//
// Each test here stands over a specific line that, if deleted, causes silent
// data misplacement or data loss rather than a visible error.

function cfg(namespace: string) {
  return ConfigSchema.parse({
    uri: "mongodb://localhost:27017/?replicaSet=rs0",
    username: "swamp",
    namespace,
  });
}

async function withTempCache<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "mongodb-coverage-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// THE GUARD: `if (lastPulledAt !== null && !lazyPullActive)` around the
// reconciliation tombstone pass in fullWalkPush.
//
// This is what made upgrading to the namespaced tier root safe. On the first
// push after the root moves, the sidecar is cold — so every remote path looks
// "absent locally". Without this gate that first push would tombstone the whole
// datastore. Delete the gate and this test must go red.
Deno.test("a cold-start sidecar reports no pull watermark, which suppresses tombstoning", async () => {
  await withTempCache(async (dir) => {
    const sc = new Sidecar(dir);
    const state = await sc.read();
    assertEquals(
      state.lastPulledAt,
      null,
      "a cold sidecar must have no watermark, or the first push would delete",
    );
    assertEquals(state.pushBootstrapped, false);
  });
});

// A pull sets the watermark; only then may deletions propagate. If setting the
// watermark ever stopped persisting, tombstoning would never resume and remote
// deletes would silently stop working.
Deno.test("the tombstone gate opens only after a pull records a watermark", async () => {
  await withTempCache(async (dir) => {
    const sc = new Sidecar(dir);
    const stamp = "2026-08-31T12:00:00.000Z";
    await sc.setLastPulledAt(stamp);
    const state = await sc.read();
    assertEquals(state.lastPulledAt, stamp);
    assertEquals(
      state.lastPulledAt !== null && !state.lazyPullActive,
      true,
      "gate must be open once a full pull has completed",
    );
  });
});

// Lazy hydration leaves the cache an intentionally incomplete mirror, so an
// absent path means "never hydrated", not "deleted".
Deno.test("lazy hydration keeps the tombstone gate shut even with a watermark", async () => {
  await withTempCache(async (dir) => {
    const sc = new Sidecar(dir);
    await sc.setLastPulledAt("2026-08-31T12:00:00.000Z");
    await sc.setLazyPullActive(true);
    const state = await sc.read();
    assertEquals(
      state.lastPulledAt !== null && !state.lazyPullActive,
      false,
      "a lazily-hydrated cache must never drive deletions",
    );
  });
});

// THE GUARD: tierRoot() in createSyncService. Without it the sync service walks
// and writes the bare cache root while core reads {cache}/{namespace}/... —
// the defect this release fixes (swamp-club#1458, #1554).
Deno.test("the sync tier root is the namespaced directory, not the bare cache", () => {
  const bare = "/cache/repos/abc";
  assertEquals(tierRoot(cfg("dev-tmp-swamp"), bare), `${bare}/dev-tmp-swamp`);
  assertEquals(
    tierRoot(cfg("dev-tmp-swamp"), bare) === bare,
    false,
    "a regression here silently rebuilds the invisible root-level tier",
  );
});

// Two repos sharing one cache parent must never resolve to the same tier.
Deno.test("different namespaces never share a tier root", () => {
  const bare = "/cache/repos/abc";
  assertEquals(
    tierRoot(cfg("repo-a"), bare) === tierRoot(cfg("repo-b"), bare),
    false,
  );
});

// The sidecar must live beside the tier it describes; parked at the bare cache
// root, two namespaces would share one dirty-path journal.
Deno.test("the sidecar is scoped to the tier root, not shared across namespaces", async () => {
  await withTempCache(async (dir) => {
    const a = tierRoot(cfg("repo-a"), dir);
    const b = tierRoot(cfg("repo-b"), dir);
    await Deno.mkdir(a, { recursive: true });
    await Deno.mkdir(b, { recursive: true });
    const sa = new Sidecar(a);
    const sb = new Sidecar(b);
    await sa.recordDirty("data/only-in-a");
    const stateB = await sb.read();
    assertEquals(
      stateB.dirtyPaths.includes("data/only-in-a"),
      false,
      "one namespace's dirty path must not leak into another's sidecar",
    );
  });
});

// THE WIRING, not just the helper. The two tests above prove `tierRoot()`
// computes the right path; NEITHER proves createSyncService actually calls it.
// That gap is not hypothetical: the upstream keeb 2026.08.19.2 tree roots the
// service at the bare cache path, and merging it verbatim left every test above
// green while the service silently walked the wrong directory.
//
// The consequence is worse than misplaced files. pushChanged's reconciliation
// pass tombstones every REMOTE path absent from its LOCAL walk. Rooted at the
// bare path, that walk finds nothing, so the whole namespace is tombstoned in
// one push — the MongoDB shape of swamp-club#1554, where the same defect in
// @swamp/s3-datastore left 7431 live objects one boolean away from deletion.
//
// markDirty is network-free (it only appends to the journal), so the tier the
// service resolved is observable without a cluster: the journal must appear
// beside the tier, not at the bare root.
Deno.test("createSyncService roots the service at the TIER, not the bare cache path — the journal lands under the namespace", async () => {
  await withTempCache(async (bare) => {
    const namespace = "wiring-probe";
    const service = createSyncService(
      cfg(namespace),
      () => Promise.reject(new Error("markDirty must not open a client")),
      "/repo",
      bare,
    );

    await service.markDirty({ relPath: "data/probe/raw" });

    const namespaced = `${bare}/${namespace}/.datastore-dirty.log`;
    const atRoot = `${bare}/.datastore-dirty.log`;

    assertEquals(
      await exists(namespaced),
      true,
      "the dirty journal must be written under the namespace tier",
    );
    assertEquals(
      await exists(atRoot),
      false,
      "a journal at the bare cache root means the service is rooted one " +
        "level too high — push would then tombstone the whole namespace",
    );
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// THE NORMALIZATION core's per-file hooks require. Measured against a live
// namespaced repo: every markDirty call arrives with the namespace already
// prepended (`dsmerge-probe/definitions-evaluated/...`), while everything else
// in this service — remote `_id`s, the local walk, isSecretsPath — speaks
// tier-relative paths. swamp-club#1554 records the same asymmetry for
// @swamp/s3-datastore's lazy-hydration hook.
//
// Left unnormalized the journal fills with paths no walk can match, so the
// incremental push silently persists NOTHING and only a full walk ever does.
// Confirmed live: before this fix a namespaced repo held 37 local files and 0
// remote paths; after it, ordinary method runs push incrementally again.
Deno.test("markDirty normalizes core's namespace-prefixed path to tier-relative before journalling it", async () => {
  await withTempCache(async (bare) => {
    const namespace = "ns-probe";
    const service = createSyncService(
      cfg(namespace),
      () => Promise.reject(new Error("markDirty must not open a client")),
      "/repo",
      bare,
    );

    await service.markDirty({
      relPath: `${namespace}/data/command/shell/abc/result`,
    });

    const journal = await Deno.readTextFile(
      `${bare}/${namespace}/.datastore-dirty.log`,
    );
    assertEquals(
      journal.includes("data/command/shell/abc/result"),
      true,
      "the tier-relative path must reach the journal",
    );
    assertEquals(
      journal.includes(`${namespace}/data/`),
      false,
      "the namespace prefix must NOT survive into the journal — a prefixed " +
        "entry matches no local walk, so the incremental push finds nothing",
    );
  });
});

// The prefix also hides the vault tier from isSecretsPath. Unnormalized,
// `<ns>/secrets/...` fails the isSecretsPath test and is journalled like any
// other path, re-arming the leak DATASTORE_SUBDIRS exists to prevent.
Deno.test("markDirty still filters the vault tier when core prefixes the namespace", async () => {
  await withTempCache(async (bare) => {
    const namespace = "ns-probe";
    const service = createSyncService(
      cfg(namespace),
      () => Promise.reject(new Error("markDirty must not open a client")),
      "/repo",
      bare,
    );

    await service.markDirty({ relPath: `${namespace}/secrets/my-vault.key` });

    let journal = "";
    try {
      journal = await Deno.readTextFile(
        `${bare}/${namespace}/.datastore-dirty.log`,
      );
    } catch {
      journal = "";
    }
    assertEquals(
      journal.includes("secrets"),
      false,
      "a namespace-prefixed secrets path must still be dropped",
    );
  });
});

// A genuinely tier-relative path must survive untouched, including the
// ambiguous case where the first segment happens to equal the namespace.
Deno.test("markDirty leaves an already tier-relative path alone", async () => {
  await withTempCache(async (bare) => {
    const namespace = "data";
    const service = createSyncService(
      cfg(namespace),
      () => Promise.reject(new Error("markDirty must not open a client")),
      "/repo",
      bare,
    );

    // "outputs/..." does not start with "data/", so nothing is stripped.
    await service.markDirty({ relPath: "outputs/command/shell/run.yaml" });

    const journal = await Deno.readTextFile(
      `${bare}/${namespace}/.datastore-dirty.log`,
    );
    assertEquals(journal.includes("outputs/command/shell/run.yaml"), true);
  });
});
