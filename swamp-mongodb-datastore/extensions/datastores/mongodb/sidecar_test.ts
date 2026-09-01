import { assertEquals } from "jsr:@std/assert@1";
import {
  coalesce,
  getSidecar,
  MAX_DIRTY_PATHS,
  reconcileWatermark,
  Sidecar,
} from "./sidecar.ts";
import {
  isExcludedPath,
  isRawContentPath,
  isSecretsPath,
  modelPrefixes,
} from "./sync.ts";

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
    await sc.close();
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
    await sc.close();
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
    await sc.close();
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
    await sc.close();
  });
});

Deno.test("coalesce drops descendants of a dirty ancestor", () => {
  // The shape that made proxmox-manager's sidecar reach 86k entries: the
  // data-name dir plus every version dir beneath it.
  assertEquals(
    coalesce([
      "data/m/i/name",
      "data/m/i/name/1",
      "data/m/i/name/2/raw",
      "data/m/i/other/9",
    ]),
    ["data/m/i/name", "data/m/i/other/9"],
  );
});

Deno.test("coalesce keeps siblings and prefix-lookalikes", () => {
  // `name2` is not under `name` — a naive startsWith without the slash
  // would wrongly swallow it.
  assertEquals(
    coalesce(["data/name", "data/name2", "data/name2/v"]),
    ["data/name", "data/name2"],
  );
  assertEquals(coalesce([]), []);
  assertEquals(coalesce(["a", "a", "a"]), ["a"]);
});

Deno.test("recordDirty absorbs paths under an already-dirty ancestor", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.clearDirty();
    await sc.recordDirty("data/m/i/name");
    for (let v = 0; v < 500; v++) {
      await sc.recordDirty(`data/m/i/name/${v}`);
    }
    const state = await sc.read();
    assertEquals(state.dirtyPaths, ["data/m/i/name"]);
    // The journal must not have grown either — that was the 6.8 MB problem.
    const journal = await Deno.readTextFile(`${cache}/.datastore-dirty.log`);
    assertEquals(journal.trim().split("\n"), ["data/m/i/name"]);
    await sc.close();
  });
});

Deno.test("exceeding MAX_DIRTY_PATHS degrades to bulkInvalidated", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.clearDirty();
    let state = await sc.read();
    for (let i = 0; i <= MAX_DIRTY_PATHS; i++) {
      state = await sc.recordDirty(`data/f${i}`);
      if (state.bulkInvalidated) break;
    }
    assertEquals(state.bulkInvalidated, true);
    // Set is dropped: a full walk supersedes it, and keeping it would just
    // grow unbounded.
    assertEquals(state.dirtyPaths, []);
    await sc.close();
  });
});

Deno.test("v1 sidecar with a small dirtyPaths array migrates its entries", async () => {
  await withTempCache(async (cache) => {
    await Deno.writeTextFile(
      `${cache}/.datastore-sync-state.json`,
      JSON.stringify({
        version: 1,
        dirtyPaths: ["data/a", "data/b"],
        bulkInvalidated: false,
        lastPulledAt: "2026-06-13T12:00:00.000Z",
        lazyPullActive: false,
        pushBootstrapped: true,
      }),
    );
    const state = await new Sidecar(cache).read();
    assertEquals(state.dirtyPaths.sort(), ["data/a", "data/b"]);
    assertEquals(state.bulkInvalidated, false);
    assertEquals(state.lastPulledAt, "2026-06-13T12:00:00.000Z");
    assertEquals(state.pushBootstrapped, true);
  });
});

Deno.test("v1 sidecar with an oversized dirtyPaths array forces a full walk", async () => {
  await withTempCache(async (cache) => {
    // proxmox-manager's real sidecar: ~86k accumulated paths, almost all of
    // them versions autoGc had already reaped. Reconciling them one by one is
    // strictly worse than walking the cache once.
    const dirtyPaths = Array.from(
      { length: MAX_DIRTY_PATHS + 1 },
      (_, i) => `data/m/i/name/${i}`,
    );
    await Deno.writeTextFile(
      `${cache}/.datastore-sync-state.json`,
      JSON.stringify({ version: 1, dirtyPaths, pushBootstrapped: true }),
    );
    const state = await new Sidecar(cache).read();
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, []);
    // Scalars are preserved across the migration.
    assertEquals(state.pushBootstrapped, true);
  });
});

Deno.test("forgetDirty retires a slice, leaving the rest pending", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.clearDirty();
    await sc.recordDirty("data/a");
    await sc.recordDirty("data/b");
    await sc.recordDirty("data/c");
    const state = await sc.forgetDirty(["data/a", "data/b"]);
    assertEquals(state.dirtyPaths, ["data/c"]);
    // Survives a reopen — an interrupted push resumes from here.
    assertEquals((await new Sidecar(cache).read()).dirtyPaths, ["data/c"]);
    await sc.close();
  });
});

Deno.test("dirty journal is picked up by another Sidecar instance", async () => {
  await withTempCache(async (cache) => {
    const a = new Sidecar(cache);
    await a.clearDirty();
    await a.recordDirty("data/from-a");
    // A second process pushing must see what the first marked.
    const b = new Sidecar(cache);
    assertEquals((await b.read()).dirtyPaths, ["data/from-a"]);
    await a.close();
  });
});

Deno.test("a corrupt re-read never erases lastPulledAt/pushBootstrapped", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.clearDirty(); // pushBootstrapped = true
    await sc.setLastPulledAt("2026-07-31T00:51:33.988Z");

    // Something clobbers the file between mutations. The old code adopted the
    // blank fallback and then persisted it, silently dropping the watermark —
    // which disables deletion propagation on push and turns the next pull into
    // a cold start that re-hydrates everything a `data gc` just pruned.
    await Deno.writeTextFile(`${cache}/.datastore-sync-state.json`, "{trunc");

    // read() re-reads from disk, so it is where the damage is observed.
    const state = await sc.read();
    assertEquals(state.lastPulledAt, "2026-07-31T00:51:33.988Z");
    assertEquals(state.pushBootstrapped, true);
    // A degraded read still forces the safe full walk.
    assertEquals(state.bulkInvalidated, true);

    // And the repaired values are what land on disk at the next mutation,
    // rather than the blank fallback overwriting them.
    await sc.setLazyPullActive(false);
    const persisted = JSON.parse(
      await Deno.readTextFile(`${cache}/.datastore-sync-state.json`),
    );
    assertEquals(persisted.lastPulledAt, "2026-07-31T00:51:33.988Z");
    assertEquals(persisted.pushBootstrapped, true);
    await sc.close();
  });
});

Deno.test("reconcileWatermark falls back to lastPulledAt when unreconciled", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLastPulledAt("2026-07-31T00:00:00.000Z");
    const state = await sc.read();
    assertEquals(state.lastReconciledAt, null);
    // Pre-existing caches keep their old, conservative behavior until a full
    // walk records a real reconcile point.
    assertEquals(reconcileWatermark(state), "2026-07-31T00:00:00.000Z");
  });
});

Deno.test("reconcileWatermark prefers lastReconciledAt once set", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLastPulledAt("2026-07-31T00:00:00.000Z");
    await sc.setLastReconciledAt("2026-08-19T12:00:00.000Z");
    const state = await sc.read();
    // This is what lets a host tombstone paths it pushed itself: the push
    // stamped them updatedAt=now, which is newer than lastPulledAt but older
    // than the reconcile point recorded by the walk that observed them.
    assertEquals(reconcileWatermark(state), "2026-08-19T12:00:00.000Z");
    // Pull semantics are untouched.
    assertEquals(state.lastPulledAt, "2026-07-31T00:00:00.000Z");
  });
});

Deno.test("setLastReconciledAt is monotonic", async () => {
  await withTempCache(async (cache) => {
    const sc = new Sidecar(cache);
    await sc.setLastReconciledAt("2026-08-19T12:00:00.000Z");
    // An interleaved older walk finishing late must not rewind the point.
    const state = await sc.setLastReconciledAt("2026-08-01T00:00:00.000Z");
    assertEquals(state.lastReconciledAt, "2026-08-19T12:00:00.000Z");
  });
});

Deno.test("getSidecar interns one instance per cache path", async () => {
  await withTempCache(async (cache) => {
    const a = getSidecar(cache);
    const b = getSidecar(cache);
    // Two instances would each keep their own dirty set and append handle,
    // and would not serialize through a shared Promise chain.
    assertEquals(a === b, true);
    assertEquals(getSidecar(cache + "/other") === a, false);
    await a.close();
  });
});

Deno.test("isExcludedPath drops SQLite catalogs and in-flight temp files", () => {
  // Host-local: churns every command, meaningless on another machine.
  assertEquals(isExcludedPath("data/_catalog.db"), true);
  assertEquals(isExcludedPath("data/_catalog.db-wal"), true);
  assertEquals(isExcludedPath("data/_catalog.db-shm"), true);
  assertEquals(isExcludedPath("_extension_catalog.db-shm"), true);
  // writeFileAtomic / sidecar staging files, mid-write.
  assertEquals(
    isExcludedPath("data/x/raw.tmp.18413.73c37437-19de-406a-b0a0-77570916ebf3"),
    true,
  );
  // Real content is untouched.
  assertEquals(isExcludedPath("data/host/vm-1/raw"), false);
  assertEquals(isExcludedPath("data/host/vm-1/metadata.yaml"), false);
  assertEquals(isExcludedPath("outputs/a/b/c.yaml"), false);
  // `.db` only as a suffix of the basename, not a directory component.
  assertEquals(isExcludedPath("data/my.db/raw"), false);
});
