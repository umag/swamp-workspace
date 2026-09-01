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
