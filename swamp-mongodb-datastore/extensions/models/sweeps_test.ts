import { assertEquals } from "jsr:@std/assert@1";
import type { Collection } from "npm:mongodb@6.17.0";
import {
  type BlobDocLike,
  chunkParentHash,
  type PathDocLike,
  sweepOrphanBlobs,
  sweepTombstones,
} from "./sweeps.ts";

// Minimal stand-ins for the two driver methods sweepOrphanBlobs uses.
function fakePaths(docs: PathDocLike[]): Collection<PathDocLike> {
  return {
    find(filter: { deletedAt: null }) {
      const matched = docs.filter((d) =>
        filter.deletedAt === null ? d.deletedAt === null : true
      );
      return {
        async *[Symbol.asyncIterator]() {
          for (const d of matched) yield d;
        },
      };
    },
  } as unknown as Collection<PathDocLike>;
}

function fakeBlobs(docs: BlobDocLike[]): {
  coll: Collection<BlobDocLike>;
  remaining: () => string[];
} {
  let store = [...docs];
  const coll = {
    find() {
      const snapshot = [...store];
      return {
        async *[Symbol.asyncIterator]() {
          for (const d of snapshot) yield d;
        },
      };
    },
    deleteMany(filter: { _id: { $in: string[] } }) {
      const doomed = new Set(filter._id.$in);
      store = store.filter((d) => !doomed.has(d._id));
      return Promise.resolve({ deletedCount: doomed.size });
    },
  } as unknown as Collection<BlobDocLike>;
  return { coll, remaining: () => store.map((d) => d._id) };
}

// Stand-in supporting the count/delete calls sweepTombstones uses.
function fakeTombstonePaths(docs: PathDocLike[]): {
  coll: Collection<PathDocLike>;
  remaining: () => string[];
} {
  let store = [...docs];
  const matches = (d: PathDocLike, f: Record<string, unknown>): boolean => {
    const spec = f.deletedAt as Record<string, unknown> | null | undefined;
    if (spec === undefined || spec === null) return true;
    if (d.deletedAt === null) return false;
    if ("$lt" in spec && !(d.deletedAt < (spec.$lt as Date))) return false;
    return true;
  };
  const coll = {
    countDocuments(filter: Record<string, unknown>) {
      return Promise.resolve(store.filter((d) => matches(d, filter)).length);
    },
    deleteMany(filter: Record<string, unknown>) {
      const before = store.length;
      store = store.filter((d) => !matches(d, filter));
      return Promise.resolve({ deletedCount: before - store.length });
    },
  } as unknown as Collection<PathDocLike>;
  return { coll, remaining: () => store.map((d) => d._id).sort() };
}

Deno.test("sweepTombstones deletes only tombstones past the grace window", async () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  const day = 86_400_000;
  const { coll, remaining } = fakeTombstonePaths([
    { _id: "live", hash: "h1", deletedAt: null },
    // 60 days dead — every peer syncing monthly has applied this.
    { _id: "old", hash: "h2", deletedAt: new Date(now.getTime() - 60 * day) },
    // 5 days dead — a peer that last synced a week ago still needs to see it.
    { _id: "recent", hash: "h3", deletedAt: new Date(now.getTime() - 5 * day) },
  ]);

  const res = await sweepTombstones(coll, { now });
  assertEquals(res.tombstonesTotal, 2);
  assertEquals(res.tombstonesDeleted, 1);
  assertEquals(res.tombstonesKept, 1);
  // The live doc is untouched, and the recent tombstone still propagates.
  assertEquals(remaining(), ["live", "recent"]);
});

Deno.test("sweepTombstones dry run counts without deleting", async () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  const { coll, remaining } = fakeTombstonePaths([
    {
      _id: "old",
      hash: "h",
      deletedAt: new Date(now.getTime() - 90 * 86_400_000),
    },
  ]);
  const res = await sweepTombstones(coll, { now, dryRun: true });
  assertEquals(res.tombstonesDeleted, 0);
  assertEquals(res.deleted, false);
  assertEquals(remaining(), ["old"]);
});

Deno.test("sweepTombstones never touches live docs even at graceMs 0", async () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  const { coll, remaining } = fakeTombstonePaths([
    { _id: "live1", hash: "a", deletedAt: null },
    { _id: "live2", hash: "b", deletedAt: null },
    { _id: "dead", hash: "c", deletedAt: new Date(now.getTime() - 1) },
  ]);
  const res = await sweepTombstones(coll, { now, graceMs: 0 });
  assertEquals(res.tombstonesDeleted, 1);
  assertEquals(remaining(), ["live1", "live2"]);
});

Deno.test("chunkParentHash splits chunk ids, leaves bare hashes alone", () => {
  assertEquals(chunkParentHash("abc123"), null);
  assertEquals(chunkParentHash("abc123:0"), "abc123");
  assertEquals(chunkParentHash("abc123:17"), "abc123");
});

Deno.test("sweep deletes blobs no live path references", async () => {
  const paths = fakePaths([
    { _id: "data/a", hash: "keep1", deletedAt: null },
    { _id: "data/b", hash: "keep2", deletedAt: null },
    // Tombstoned: its bytes are unreachable, so they are not a reference.
    { _id: "data/c", hash: "drop1", deletedAt: new Date() },
  ]);
  const { coll, remaining } = fakeBlobs([
    { _id: "keep1", size: 10 },
    { _id: "keep2", size: 20 },
    { _id: "drop1", size: 100 },
    { _id: "drop2", size: 300 },
  ]);

  const res = await sweepOrphanBlobs(paths, coll);
  assertEquals(res.liveHashes, 2);
  assertEquals(res.orphanBlobs, 2);
  assertEquals(res.bytesReclaimed, 400);
  assertEquals(remaining().sort(), ["keep1", "keep2"]);
});

Deno.test("sweep drops a chunked blob's chunks along with its header", async () => {
  const paths = fakePaths([
    { _id: "data/big", hash: "live", deletedAt: null },
  ]);
  const { coll, remaining } = fakeBlobs([
    { _id: "live", size: 0 },
    { _id: "live:0", size: 8 },
    { _id: "live:1", size: 8 },
    { _id: "dead", size: 0 },
    { _id: "dead:0", size: 8 },
    { _id: "dead:1", size: 4 },
  ]);

  const res = await sweepOrphanBlobs(paths, coll);
  assertEquals(res.orphanBlobs, 1);
  assertEquals(res.orphanChunks, 2);
  assertEquals(res.bytesReclaimed, 12);
  // A live chunked blob keeps every chunk — dropping one would corrupt it.
  assertEquals(remaining().sort(), ["live", "live:0", "live:1"]);
});

Deno.test("dryRun reports without deleting", async () => {
  const paths = fakePaths([{ _id: "data/a", hash: "keep", deletedAt: null }]);
  const { coll, remaining } = fakeBlobs([
    { _id: "keep", size: 1 },
    { _id: "orphan", size: 99 },
  ]);

  const res = await sweepOrphanBlobs(paths, coll, { dryRun: true });
  assertEquals(res.orphanBlobs, 1);
  assertEquals(res.bytesReclaimed, 99);
  assertEquals(res.deleted, false);
  assertEquals(remaining().sort(), ["keep", "orphan"]);
});

Deno.test("sweep spares unreferenced blobs inside the grace window", async () => {
  // The race this exists for: a push inserts the blob, then upserts the path
  // doc. A sweep landing between the two sees an unreferenced hash. Observed
  // for real against proxmox-manager — the global lock did NOT exclude it.
  const now = new Date("2026-08-19T20:00:00.000Z");
  const paths = fakePaths([{ _id: "data/a", hash: "keep", deletedAt: null }]);
  const { coll, remaining } = fakeBlobs([
    { _id: "keep", size: 1 },
    // Inserted 30s ago by an in-flight push; its path doc is still pending.
    { _id: "inflight", size: 50, createdAt: new Date(now.getTime() - 30_000) },
    // Two hours old and unreferenced — genuinely dead.
    { _id: "stale", size: 70, createdAt: new Date(now.getTime() - 7_200_000) },
    // No createdAt: written before the field existed, so always eligible.
    { _id: "ancient", size: 90 },
  ]);

  const res = await sweepOrphanBlobs(paths, coll, { now });
  assertEquals(res.skippedTooYoung, 1);
  assertEquals(res.orphanBlobs, 2);
  assertEquals(res.bytesReclaimed, 160);
  assertEquals(remaining().sort(), ["inflight", "keep"]);
});

Deno.test("graceMs 0 disables the window (opt-in aggressive sweep)", async () => {
  const now = new Date("2026-08-19T20:00:00.000Z");
  const paths = fakePaths([]);
  const { coll, remaining } = fakeBlobs([
    { _id: "brandnew", size: 5, createdAt: now },
  ]);
  const res = await sweepOrphanBlobs(paths, coll, { now, graceMs: 0 });
  assertEquals(res.skippedTooYoung, 0);
  assertEquals(res.orphanBlobs, 1);
  assertEquals(remaining(), []);
});

Deno.test("sweep is a no-op when every blob is referenced", async () => {
  const paths = fakePaths([
    { _id: "data/a", hash: "h1", deletedAt: null },
    // Two paths sharing one blob — the dedup case the store exists for.
    { _id: "data/b", hash: "h1", deletedAt: null },
  ]);
  const { coll, remaining } = fakeBlobs([{ _id: "h1", size: 5 }]);

  const res = await sweepOrphanBlobs(paths, coll);
  assertEquals(res.liveHashes, 1);
  assertEquals(res.orphanBlobs, 0);
  assertEquals(res.bytesReclaimed, 0);
  assertEquals(remaining(), ["h1"]);
});
