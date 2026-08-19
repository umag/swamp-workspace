import { assertEquals } from "jsr:@std/assert@1";
import { Sidecar } from "./sidecar.ts";
import { isRawContentPath, isSecretsPath, modelPrefixes } from "./sync.ts";

Deno.test("modelPrefixes maps models to data/<type>/<id>/ prefixes", () => {
  assertEquals(
    modelPrefixes([{ modelType: "host", modelId: "vm-1" }]),
    ["data/host/vm-1/"],
  );
  assertEquals(
    modelPrefixes([
      { modelType: "host", modelId: "vm-1" },
      { modelType: "net", modelId: "br0" },
    ]),
    ["data/host/vm-1/", "data/net/br0/"],
  );
});

Deno.test("modelPrefixes returns [] for empty/undefined (falls back to full pull)", () => {
  assertEquals(modelPrefixes(undefined), []);
  assertEquals(modelPrefixes([]), []);
});

Deno.test("isRawContentPath matches data/.../raw content, spares catalog files", () => {
  // Skipped by a metadataOnly pull (content bytes).
  assertEquals(isRawContentPath("data/host/vm-1/versions/abc/raw"), true);
  assertEquals(isRawContentPath("data/host/vm-1/raw"), true);
  // Kept by a metadataOnly pull (catalog: list/query/CEL work without bytes).
  assertEquals(
    isRawContentPath("data/host/vm-1/versions/abc/metadata.yaml"),
    false,
  );
  assertEquals(isRawContentPath("data/host/vm-1/latest"), false);
  // `raw` only counts under data/, and only as the trailing segment.
  assertEquals(isRawContentPath("outputs/host/vm-1/raw"), false);
  assertEquals(isRawContentPath("data/host/raw/metadata.yaml"), false);
});

Deno.test("isSecretsPath matches the vault tier only", () => {
  // Excluded from sync (vault keys + ciphertext must not reach MongoDB).
  assertEquals(isSecretsPath("secrets"), true);
  assertEquals(isSecretsPath("secrets/local_encryption/v/.key"), true);
  assertEquals(isSecretsPath("secrets/local_encryption/v/KEY.enc"), true);
  // Unrelated paths sync normally.
  assertEquals(isSecretsPath("data/host/vm-1/raw"), false);
  assertEquals(isSecretsPath("secretsanta/foo"), false);
  assertEquals(isSecretsPath("outputs/secrets/foo"), false);
});

async function withTempCache(
  fn: (cachePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mongodb-swamp-sidecar-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("read on missing sidecar returns bulkInvalidated=true (cold start)", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    const state = await sc.read();
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, []);
    assertEquals(state.lastPulledAt, null);
  });
});

Deno.test("read on corrupt sidecar JSON returns bulkInvalidated=true", async () => {
  await withTempCache(async (cache) => {
    await Deno.writeTextFile(
      `${cache}/.datastore-sync-state.json`,
      "{not json",
    );
    const sc = new Sidecar(cache);
    const state = await sc.read();
    assertEquals(state.bulkInvalidated, true);
  });
});

Deno.test("read on unknown schema version returns bulkInvalidated=true", async () => {
  await withTempCache(async (cache) => {
    await Deno.writeTextFile(
      `${cache}/.datastore-sync-state.json`,
      JSON.stringify({ version: 999, dirtyPaths: ["a"] }),
    );
    const sc = new Sidecar(cache);
    const state = await sc.read();
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, []);
  });
});

Deno.test("recordDirty(undefined) flips bulkInvalidated, leaves dirtyPaths alone", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.recordDirty("data/foo");
    const state = await sc.recordDirty(undefined);
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, ["data/foo"]);
  });
});

Deno.test("recordDirty(path) adds path; dedupes on repeat", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.recordDirty("data/foo");
    await sc.recordDirty("data/foo");
    await sc.recordDirty("data/bar");
    const state = await sc.read();
    assertEquals(state.dirtyPaths.sort(), ["data/bar", "data/foo"]);
  });
});

Deno.test("clearDirty empties paths and clears bulk flag", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.recordDirty("data/foo");
    await sc.recordDirty(undefined); // bulkInvalidated = true
    const state = await sc.clearDirty();
    assertEquals(state.dirtyPaths, []);
    assertEquals(state.bulkInvalidated, false);
  });
});

Deno.test("clearDirty preserves lastPulledAt", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLastPulledAt("2026-05-04T12:00:00.000Z");
    await sc.recordDirty("data/foo");
    const state = await sc.clearDirty();
    assertEquals(state.lastPulledAt, "2026-05-04T12:00:00.000Z");
  });
});

Deno.test("setLastPulledAt persists across reads", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLastPulledAt("2026-05-04T12:00:00.000Z");
    const fresh = new Sidecar(cache);
    const state = await fresh.read();
    assertEquals(state.lastPulledAt, "2026-05-04T12:00:00.000Z");
  });
});

Deno.test("concurrent recordDirty calls serialize without losing entries", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    // Cold-start sidecar reads as bulkInvalidated; clear it first so
    // we're testing the serialization, not the cold-start behavior.
    await sc.clearDirty();
    const paths = Array.from({ length: 50 }, (_, i) => `data/file-${i}`);
    await Promise.all(paths.map((p) => sc.recordDirty(p)));
    const state = await sc.read();
    assertEquals(state.dirtyPaths.length, 50);
    assertEquals(new Set(state.dirtyPaths).size, 50);
  });
});

Deno.test("lazyPullActive survives clearDirty (a push doesn't hydrate)", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLazyPullActive(true);
    // A push clears dirty state but must NOT clear the lazy flag, or the
    // next fullWalkPush would tombstone un-hydrated raw content.
    const afterClear = await sc.clearDirty();
    assertEquals(afterClear.lazyPullActive, true);
    const fresh = await new Sidecar(cache).read();
    assertEquals(fresh.lazyPullActive, true);
  });
});

Deno.test("setLazyPullActive(false) clears the flag (full pull resync)", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLazyPullActive(true);
    const state = await sc.setLazyPullActive(false);
    assertEquals(state.lazyPullActive, false);
  });
});

Deno.test("lazyPullActive defaults false on cold start", async () => {
  await withTempCache(async (cache) => {
    const state = await new Sidecar(cache).read();
    assertEquals(state.lazyPullActive, false);
  });
});

Deno.test("pushBootstrapped defaults false on cold start", async () => {
  await withTempCache(async (cache) => {
    const state = await new Sidecar(cache).read();
    assertEquals(state.pushBootstrapped, false);
  });
});

Deno.test("clearDirty marks pushBootstrapped true (a push completed)", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    const state = await sc.clearDirty();
    assertEquals(state.pushBootstrapped, true);
    const fresh = await new Sidecar(cache).read();
    assertEquals(fresh.pushBootstrapped, true);
  });
});

Deno.test("a pull (setLastPulledAt) does NOT bootstrap push (issue #4)", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    // Simulate setup: migrate copies files, then hydration sets a clean
    // watermark — but nothing has been pushed yet. pushBootstrapped must
    // stay false so the next pushChanged still does a full walk.
    await sc.setLastPulledAt("2026-06-13T12:00:00.000Z");
    const state = await new Sidecar(cache).read();
    assertEquals(state.pushBootstrapped, false);
    assertEquals(state.lastPulledAt, "2026-06-13T12:00:00.000Z");
  });
});

Deno.test("pushBootstrapped survives a later pull", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.clearDirty(); // push happened → bootstrapped
    await sc.setLastPulledAt("2026-06-13T12:00:00.000Z"); // later pull
    const state = await new Sidecar(cache).read();
    assertEquals(state.pushBootstrapped, true);
  });
});

Deno.test("recordDirty after clearDirty preserves cleared bulk flag", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.clearDirty();
    const state = await sc.recordDirty("data/foo");
    assertEquals(state.bulkInvalidated, false);
    assertEquals(state.dirtyPaths, ["data/foo"]);
  });
});
