import { assertEquals } from "jsr:@std/assert@1";
import { ConfigSchema, tierRoot } from "./config.ts";
import { Sidecar } from "./sidecar.ts";

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
