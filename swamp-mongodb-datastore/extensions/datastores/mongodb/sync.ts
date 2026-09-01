import {
  type AnyBulkWriteOperation,
  Binary,
  type Collection,
} from "npm:mongodb@6.17.0";
import type { ClientHandle } from "./client.ts";
import {
  blobsCollectionName,
  type MongoDatastoreConfig,
  pathsCollectionName,
  tierRoot,
} from "./config.ts";
import {
  getSidecar,
  reconcileWatermark,
  type SidecarState,
} from "./sidecar.ts";

// Mirrors @systeminit/swamp's domain/datastore/datastore_sync_service.ts.
export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
}

export interface DatastoreSyncOptions {
  signal?: AbortSignal;
  relPath?: string;
  // Domain-level sync context, passed by core only when capabilities()
  // advertises scopedSync. Meaningful on pull/push; ignored on markDirty.
  context?: SyncContext;
  // When true (set by core on a `--hydration-strategy lazy` setup pull),
  // pullChanged downloads catalog metadata only and skips `data/.../raw`
  // content. Honored only when capabilities() advertises lazyHydration.
  metadataOnly?: boolean;
}

export interface DatastoreSyncService {
  pullChanged(options?: DatastoreSyncOptions): Promise<number>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number>;
  capabilities?(): SyncCapabilities;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  // Downloads a single cache-relative file the lazy setup pull skipped.
  // Core calls this transparently when a read-only command needs missing
  // content. Returns true if downloaded (or already present), false if the
  // remote has no live manifest doc for relPath.
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;
}

// `secrets` is deliberately absent: the `local_encryption` vault stores each
// vault's symmetric `.key` right next to its `.enc` ciphertext, so syncing the
// tier would land both in the shared MongoDB and let anyone with read access
// decrypt every secret (encryption-at-rest defeated). Secrets stay per-host;
// use a real KMS-backed vault if secrets must travel. See isSecretsPath, which
// also blocks any pre-existing remote `secrets/*` docs from being pulled back
// into a cache. (Repo-root `.swamp/secrets` relocation/deletion during
// `datastore setup` is a swamp-core migration concern, not this extension's.)
const DATASTORE_SUBDIRS = [
  "definitions-evaluated",
  "workflows-evaluated",
  "data",
  "outputs",
  "workflow-runs",
  "bundles",
  "vault-bundles",
  "driver-bundles",
  "report-bundles",
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

interface PathDoc {
  _id: string;
  hash: string;
  size: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

// Blob storage layout:
//   * Inline blob (size <= BLOB_INLINE_MAX):
//       { _id: <sha256>, size, createdAt, data: <Binary> }
//   * Chunked blob (size > BLOB_INLINE_MAX):
//       Header doc:  { _id: <sha256>, size, createdAt, chunkCount }  (no data)
//       Chunk docs:  { _id: "<sha256>:<i>", size, createdAt, data }  (i = 0..N-1)
// `data` and `chunkCount` are mutually exclusive: a doc is either inline,
// header, or chunk. Chunk ids use `:` which is not a sha256 hex character,
// so chunk ids never collide with hash-only ids.
//
// `createdAt` exists solely for the orphan sweep's grace window: a blob is
// written before the path doc that references it, so a sweep must not judge a
// freshly-inserted blob unreachable. See maintenance.ts. Docs written before
// 2026.08.19.1 lack the field and are treated as old.
interface BlobDoc {
  _id: string;
  size: number;
  createdAt?: Date;
  data?: Binary;
  chunkCount?: number;
}

// Deliberately carries no `bytes`: both push paths walk for metadata first
// and re-read only the files whose hashes the remote turns out to lack, so a
// 100k-file tree never has all of its contents in RAM at once.
interface LocalMeta {
  relPath: string;
  hash: string;
  size: number;
}

interface RemotePathSlim {
  hash: string;
  deletedAt: Date | null;
  updatedAt: Date;
}

const PUSH_BULK = 500;
const BLOB_QUERY_BATCH = 5000;
// Dirty roots folded into a single manifest query. Each root contributes two
// `$or` clauses (exact id + prefix regex), so this keeps the query under a
// few hundred clauses while cutting round-trips by the same factor.
const ROOT_QUERY_BATCH = 100;
// Dirty roots reconciled before retiring that slice from the journal. Small
// enough that an interrupted push loses little work, large enough that the
// journal rewrite is amortized.
const PUSH_ROOT_SLICE = 500;
// BSON doc cap is 16 MiB. Reserve ~1 MiB headroom for `_id`, `size`,
// `chunkCount`, field-name overhead, and Binary subtype byte.
const BLOB_INLINE_MAX = 15 * 1024 * 1024;
// Each chunk doc is roughly this size; the last chunk is smaller.
const BLOB_CHUNK_BYTES = 8 * 1024 * 1024;
// Per-bulkWrite payload bound for inline blobs (stays under wire protocol cap).
const BULK_INLINE_BYTES = 14 * 1024 * 1024;
// MongoDB error codes we tolerate per-op without aborting the batch.
const ERR_DUP_KEY = 11000;
const ERR_DOC_TOO_LARGE = 10334;
// Cache-relative paths holding model content bytes: `data/<type>/<id>/.../raw`.
// A metadataOnly pull excludes these and leaves them to lazy hydration.
const RAW_CONTENT_RE = /^data\/.*\/raw$/;

// Fresh regex per call: a `RegExp` carries `lastIndex` state and is reused
// across queries here, so we hand Mongo its own instance each time.
export function rawContentRegex(): RegExp {
  return new RegExp(RAW_CONTENT_RE.source);
}

// True for cache-relative paths a metadataOnly pull skips (model content
// bytes). Catalog files (`metadata.yaml`, `latest`) return false.
export function isRawContentPath(relPath: string): boolean {
  return RAW_CONTENT_RE.test(relPath);
}

// True for the vault `secrets/` tier, which must never be synced to the shared
// MongoDB (see DATASTORE_SUBDIRS). Enforced on both legs: push never walks the
// tier (it's out of DATASTORE_SUBDIRS) and is guarded in markDirty/pushOneRel;
// pull skips these docs so a deployment that synced secrets under an older
// version cannot re-hydrate them into a cache.
export function isSecretsPath(relPath: string): boolean {
  return relPath === "secrets" || relPath.startsWith("secrets/");
}

/**
 * Join a remote-supplied tier-relative path onto the cache root, refusing
 * anything that would land outside it.
 *
 * Pull takes its local target straight from a remote `_id`. One MongoDB
 * database is shared by every repo and tenant (isolation is only a collection
 * prefix), so a `_id` is untrusted input: a doc named
 * `../../../../.ssh/authorized_keys` would otherwise be written through — and,
 * when carrying `deletedAt`, unlinked — anywhere the process can reach.
 *
 * Rejects absolute paths, `.`/`..` segments, empty segments, backslashes (a
 * Windows separator that survives a POSIX `split("/")` untouched), and NUL.
 * Legitimate tier paths keep dots inside a segment (`192.168.88.18`), spaces,
 * and `@` (`data/@magistr/...`) — only a segment that IS `.` or `..` is unsafe.
 *
 * This is a @magistr fork guard: the upstream keeb tree composes these paths by
 * raw concatenation. The 2026.09.01.2 merge kept the guard and re-applied it to
 * the merged write sites rather than inheriting upstream's unguarded ones.
 */
export function resolveWithinCache(cachePath: string, relPath: string): string {
  if (!isSafeRelPath(relPath)) {
    throw new Error(
      `Refusing unsafe datastore path from remote: ${JSON.stringify(relPath)}`,
    );
  }
  return `${cachePath}/${relPath}`;
}

/** Pure predicate behind resolveWithinCache — exported for the guard's tests. */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  if (relPath.startsWith("/")) return false;
  if (relPath.includes("\\")) return false;
  if (relPath.includes("\0")) return false;
  for (const segment of relPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

// Host-local files that must never sync, matched on the basename.
//
//   *.db / *.db-wal / *.db-shm — swamp's SQLite catalogs (`data/_catalog.db`
//     and friends). The `-shm` file is a mmap'd shared-memory region whose
//     contents are meaningless off the machine that created it, and `-wal`
//     only makes sense paired with the exact `.db` that wrote it. They also
//     churn on every single write, so syncing them re-uploads a multi-MB blob
//     per command for data the remote can never correctly consume. The `.db`
//     itself is a rebuildable local index.
//   *.tmp.<pid>.<uuid> — in-flight writeFileAtomic / sidecar staging files.
//     Catching one mid-write pushes a torn blob.
const EXCLUDED_BASENAME_RE =
  /(?:\.db|\.db-wal|\.db-shm)$|\.tmp\.\d+\.[0-9a-f-]+$/;

export function isExcludedPath(relPath: string): boolean {
  const slash = relPath.lastIndexOf("/");
  const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  return EXCLUDED_BASENAME_RE.test(base);
}

// Everything the push side refuses to carry.
function isUnsyncable(relPath: string): boolean {
  return isSecretsPath(relPath) || isExcludedPath(relPath);
}

export function createSyncService(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
  bareCachePath: string,
): DatastoreSyncService {
  // Core passes the bare, un-namespaced cache path; the tier actually lives one
  // segment deeper. Every local read/write below is rooted here so push walks
  // and pull writes land where core's reader looks. See tierRoot() in config.ts.
  //
  // A @magistr fork guard the upstream keeb tree does not carry: upstream roots
  // everything at the bare path, which builds a second, invisible copy of the
  // tier at the cache root that the reader never sees (swamp-club#1458/#1554).
  // The 2026.09.01.2 merge kept the scoping rather than inheriting that.
  const cachePath = tierRoot(cfg, bareCachePath);
  // Interned per cachePath: core builds a fresh sync service per invocation,
  // and two Sidecars over one cache would not serialize with each other. It is
  // interned on the TIER root, not the bare path, so the sidecar and journal
  // sit beside the tier they describe rather than at the shared cache root.
  const sidecar = getSidecar(cachePath);
  let updatedAtIndexEnsured = false;

  /**
   * Strip the namespace core prepends, yielding the tier-relative path every
   * other part of this service speaks.
   *
   * `tierRoot` scopes the LOCAL side only: remote `_id`s stay tier-relative
   * (`data/...`), because this extension partitions by collection prefix, not
   * key prefix. But core's per-file hooks — `markDirty` and `hydrateFile` —
   * hand back a path that ALREADY carries the namespace
   * (`dev-tmp-swamp/data/...`): the same asymmetry swamp-club#1554 records for
   * @swamp/s3-datastore's lazy-hydration hook. Measured directly here — every
   * markDirty call on a namespaced repo arrives prefixed.
   *
   * Unnormalized, that breaks three things:
   *  - the dirty journal records paths no local walk can ever match, so the
   *    incremental push finds nothing and ONLY a full walk ever persists;
   *  - `isSecretsPath`/`isUnsyncable` stop matching, so the vault tier and
   *    host-local files are no longer filtered out of the journal;
   *  - `hydrateFile` looks up an `_id` no remote doc carries, and would write
   *    to `<tier>/<namespace>/...` if one ever did.
   *
   * Strips only when the remainder begins with a real tier directory, so a
   * genuinely tier-relative path is never mangled — including the ambiguous
   * case of a namespace named like a tier directory, where stripping is
   * correct anyway because core is the one that prefixed it.
   */
  function toTierRelative(relPath: string): string {
    const ns = cfg.namespace.trim();
    if (ns.length === 0) return relPath;
    const prefix = `${ns}/`;
    if (!relPath.startsWith(prefix)) return relPath;
    const rest = relPath.slice(prefix.length);
    const head = rest.split("/")[0];
    const known: readonly string[] = DATASTORE_SUBDIRS;
    return known.includes(head) || head === "secrets" ? rest : relPath;
  }

  async function resources(): Promise<{
    paths: Collection<PathDoc>;
    blobs: Collection<BlobDoc>;
  }> {
    const { client } = await getClient(repoDir);
    const db = client.db(cfg.database);
    const paths = db.collection<PathDoc>(pathsCollectionName(cfg));
    const blobs = db.collection<BlobDoc>(blobsCollectionName(cfg));
    if (!updatedAtIndexEnsured) {
      await paths.createIndex({ updatedAt: 1 }).catch(() => undefined);
      updatedAtIndexEnsured = true;
    }
    return { paths, blobs };
  }

  function poolConcurrency(): number {
    return parseInt(
      Deno.env.get("MONGO_DATASTORE_PULL_CONCURRENCY") ?? "32",
      10,
    );
  }

  // `prefixes`, when present, scopes the pull to `_paths` docs whose `_id`
  // begins with one of the given cache-relative prefixes (e.g.
  // `data/<modelType>/<modelId>/`). A scoped pull is a pure read
  // optimization: it ignores the `lastPulledAt` floor (so it can fetch
  // anything in-scope that's missing/stale locally) and — critically — does
  // NOT advance the `lastPulledAt` watermark. The global watermark stays
  // owned exclusively by the full, unscoped pull; bumping it here would make
  // a later full pull skip every out-of-scope change in this window.
  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
  }): Promise<number> {
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const { paths, blobs } = await resources();
    // A metadataOnly pull leaves data/.../raw un-hydrated. Mark the cache so
    // a later pushChanged won't read those absent raw files as deletions and
    // tombstone the whole corpus. Set before the no-op early return so even a
    // metadataOnly pull that finds nothing new still records lazy mode.
    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    if (!scoped && state.lastPulledAt !== null) {
      const since = new Date(state.lastPulledAt);
      const probe = await paths.findOne(
        { updatedAt: { $gt: since } },
        { projection: { _id: 1 } },
      );
      if (probe === null) return 0;
    }

    const baseFilter = scoped
      ? {
        $or: prefixes!.map((p) => ({
          _id: { $regex: `^${escapeRegex(p)}` },
        })),
      }
      : state.lastPulledAt !== null
      ? { updatedAt: { $gt: new Date(state.lastPulledAt) } }
      : {};
    // metadataOnly: keep the catalog (metadata.yaml, latest) but skip the
    // bulky `data/<type>/<id>/.../raw` content so `data list`/`query`/CEL
    // work immediately. The skipped files are fetched on demand by
    // hydrateFile when a read actually needs them.
    const filter = metadataOnly
      ? { $and: [baseFilter, { _id: { $not: rawContentRegex() } }] }
      : baseFilter;
    // A scoped pull always hash-compares against local state (never the
    // cold-start bulk path) — it has no watermark history to lean on.
    const coldStart = !scoped && state.lastPulledAt === null;

    const pathDocs: PathDoc[] = [];
    let maxUpdatedAtMs = state.lastPulledAt !== null
      ? new Date(state.lastPulledAt).getTime()
      : 0;
    for await (const doc of paths.find(filter)) {
      const ms = doc.updatedAt.getTime();
      if (ms > maxUpdatedAtMs) maxUpdatedAtMs = ms;
      // Never hydrate vault secrets or host-local files, even if an older
      // version synced them. Advance the watermark past the doc (above) so it
      // isn't re-scanned, but don't write or delete it locally — a stale
      // `-wal`/`-shm` landing next to a live SQLite catalog is worse than
      // having no copy at all.
      if (isUnsyncable(doc._id)) continue;
      pathDocs.push(doc);
    }

    const concurrency = poolConcurrency();
    let changes = 0;

    const deletes = pathDocs.filter((d) => d.deletedAt !== null);
    await runPool(deletes, concurrency, async (doc) => {
      if (
        await removeSilentlyExisting(resolveWithinCache(cachePath, doc._id))
      ) changes++;
    });

    const needs = pathDocs.filter((d) => d.deletedAt === null);
    const pathsByHash = new Map<string, PathDoc[]>();
    if (coldStart) {
      for (const doc of needs) addToBucket(pathsByHash, doc.hash, doc);
    } else {
      await runPool(needs, concurrency, async (doc) => {
        const local = await readFileOrNull(
          resolveWithinCache(cachePath, doc._id),
        );
        if (local !== null && (await sha256Hex(local)) === doc.hash) return;
        addToBucket(pathsByHash, doc.hash, doc);
      });
    }

    const hashesNeeded = [...pathsByHash.keys()];
    for (let i = 0; i < hashesNeeded.length; i += BLOB_QUERY_BATCH) {
      const hashBatch = hashesNeeded.slice(i, i + BLOB_QUERY_BATCH);
      const writeJobs: Array<{ relPath: string; bytes: Uint8Array }> = [];
      const chunkedHeaders: BlobDoc[] = [];
      for await (const blob of blobs.find({ _id: { $in: hashBatch } })) {
        if (blob.data) {
          const bytes = blob.data.buffer;
          const dependents = pathsByHash.get(blob._id) ?? [];
          for (const doc of dependents) {
            writeJobs.push({ relPath: doc._id, bytes });
          }
        } else {
          chunkedHeaders.push(blob);
        }
      }
      for (const header of chunkedHeaders) {
        const bytes = await assembleChunkedBlob(blobs, header);
        const dependents = pathsByHash.get(header._id) ?? [];
        for (const doc of dependents) {
          writeJobs.push({ relPath: doc._id, bytes });
        }
      }
      await runPool(writeJobs, concurrency, async ({ relPath, bytes }) => {
        await writeFileAtomic(resolveWithinCache(cachePath, relPath), bytes);
        changes++;
      });
    }

    if (!scoped && !metadataOnly) {
      // Full unscoped pull: the cache now mirrors the remote, so advance the
      // watermark and clear lazy mode — the next push may safely tombstone
      // absent paths again.
      const watermark = maxUpdatedAtMs > 0
        ? new Date(maxUpdatedAtMs).toISOString()
        : new Date().toISOString();
      await sidecar.setLastPulledAt(watermark);
      // The cache also mirrors the remote *path list* as of this point — the
      // pull applied every tombstone and hydrated every addition in the
      // window — so it is a reconcile point for the push tombstone pass too.
      await sidecar.setLastReconciledAt(watermark);
      await sidecar.setLazyPullActive(false);
    }
    // A metadataOnly pull deliberately does NOT advance the watermark: doing
    // so would move it past the skipped data/.../raw docs, and a later full
    // pull (filtered by updatedAt > watermark) would then never re-fetch
    // them. Leaving the watermark put keeps those raw docs reachable.
    return changes;
  }

  async function fullWalkPush(
    paths: Collection<PathDoc>,
    blobs: Collection<BlobDoc>,
    watermarkIso: string | null,
    lazyPullActive: boolean,
  ): Promise<{ changes: number; reconciledAt: string }> {
    // Stamped before the manifest read, not after: anything a peer writes
    // while we are streaming the cursor must stay newer than this watermark
    // so the *next* reconcile still considers it, rather than being silently
    // treated as already-seen.
    const reconciledAt = new Date().toISOString();

    // Pull the path manifest with a projection so the in-memory map carries
    // only the fields the diff/tombstone passes use.
    const remotePaths = new Map<string, RemotePathSlim>();
    for await (
      const doc of paths.find(
        {},
        { projection: { hash: 1, deletedAt: 1, updatedAt: 1 } },
      )
    ) {
      remotePaths.set(doc._id, {
        hash: doc.hash,
        deletedAt: doc.deletedAt,
        updatedAt: doc.updatedAt,
      });
    }

    // Pass 1 — walk for metadata only, remembering where each distinct hash
    // can be re-read from.
    //
    // This used to pre-fetch every `_id` in the blobs collection so the walk
    // could decide push-or-skip inline. That cursor scales with the *blob
    // store*, not the repo: proxmox-manager's had grown to 931k docs, so a
    // push of ~21k files began by streaming ~60 MB of hashes and building a
    // 931k-entry Set. Probing only the hashes we actually hold is bounded by
    // the working set instead.
    const localMetas: LocalMeta[] = [];
    const hashToAbs = new Map<string, string>();
    for (const sub of DATASTORE_SUBDIRS) {
      await walkMetas(
        `${cachePath}/${sub}`,
        sub,
        localMetas,
        hashToAbs,
      );
    }

    // Pass 2 — probe blob existence for the distinct local hashes, then
    // re-read and upload only what's missing. Chunk docs carry `:<n>` in
    // their `_id`, so an `$in` over bare hashes only ever matches
    // inline/header docs — exactly the "is this blob present" question.
    let blobsPushed = 0;
    const distinctHashes = [...hashToAbs.keys()];
    const missingHashes: string[] = [];
    for (let i = 0; i < distinctHashes.length; i += BLOB_QUERY_BATCH) {
      const batch = distinctHashes.slice(i, i + BLOB_QUERY_BATCH);
      const present = new Set<string>();
      for await (
        const b of blobs.find(
          { _id: { $in: batch } },
          { projection: { _id: 1 } },
        )
      ) {
        present.add(b._id);
      }
      for (const h of batch) if (!present.has(h)) missingHashes.push(h);
    }
    for (let i = 0; i < missingHashes.length; i += PUSH_BULK) {
      const batch = missingHashes.slice(i, i + PUSH_BULK);
      const byHash = new Map<string, Uint8Array>();
      let batchBytes = 0;
      for (const h of batch) {
        const bytes = await readFileOrNull(hashToAbs.get(h)!);
        if (bytes === null) continue; // vanished mid-walk (autoGc)
        byHash.set(h, bytes);
        batchBytes += bytes.byteLength;
        if (batchBytes >= BULK_INLINE_BYTES) {
          blobsPushed += await pushBlobsByHash(
            blobs,
            [...byHash.keys()],
            byHash,
          );
          byHash.clear();
          batchBytes = 0;
        }
      }
      if (byHash.size > 0) {
        blobsPushed += await pushBlobsByHash(blobs, [...byHash.keys()], byHash);
      }
    }

    // Path upserts — no bytes needed, just the metadata collected above.
    let pathsPushed = 0;
    let pathOps: AnyBulkWriteOperation<PathDoc>[] = [];
    const flushPathOps = async () => {
      if (pathOps.length === 0) return;
      const res = await paths.bulkWrite(pathOps, { ordered: false });
      pathsPushed += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
      pathOps = [];
    };
    const now = new Date();
    for (const f of localMetas) {
      const existing = remotePaths.get(f.relPath);
      if (
        existing &&
        existing.deletedAt === null &&
        existing.hash === f.hash
      ) continue;
      pathOps.push({
        updateOne: {
          filter: { _id: f.relPath },
          update: {
            $set: {
              hash: f.hash,
              size: f.size,
              updatedAt: now,
              deletedAt: null,
            },
          },
          upsert: true,
        },
      });
      if (pathOps.length >= PUSH_BULK) await flushPathOps();
    }
    await flushPathOps();

    // Reconciliation tombstones: skipped entirely while a lazy pull is active.
    // The local cache is then an incomplete mirror (data/.../raw is absent),
    // so an absent path is "never hydrated," not "deleted." Deletions resume
    // propagating once a full pull clears lazyPullActive.
    if (watermarkIso !== null && !lazyPullActive) {
      const watermark = new Date(watermarkIso);
      const localPaths = new Set(localMetas.map((f) => f.relPath));
      const tombstoneOps: AnyBulkWriteOperation<PathDoc>[] = [];
      for (const [relPath, doc] of remotePaths) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        tombstoneOps.push({
          updateOne: {
            filter: { _id: relPath },
            update: { $set: { deletedAt: now, updatedAt: now } },
          },
        });
        pathsPushed++;
      }
      for (let i = 0; i < tombstoneOps.length; i += PUSH_BULK) {
        await paths.bulkWrite(
          tombstoneOps.slice(i, i + PUSH_BULK),
          { ordered: false },
        );
      }
    }
    return { changes: pathsPushed + blobsPushed, reconciledAt };
  }

  // Reconciles a batch of dirty roots in one shot.
  //
  // The previous implementation handled one root per call from a serial loop,
  // costing a `stat` plus a manifest `find` per root. With ~86k dirty entries
  // — 99% of them version directories autoGc had already reaped — that was
  // ~86k sequential round-trips holding the global lock, which is what made
  // pushes time out and, because clearDirty only ran at the very end, left the
  // dirty set to grow into the next run. Batching collapses that to a handful
  // of queries: one manifest fetch per ROOT_QUERY_BATCH roots, one blob
  // existence probe per BLOB_QUERY_BATCH hashes, and bulkWrites throughout.
  async function pushRoots(
    paths: Collection<PathDoc>,
    blobs: Collection<BlobDoc>,
    roots: string[],
    watermarkIso: string | null,
    lazyPullActive: boolean,
  ): Promise<number> {
    // Belt-and-suspenders: markDirty already drops these, so this only fires
    // if a dirty path slipped through from an older sidecar.
    const live = roots.filter((r) => !isUnsyncable(r));
    if (live.length === 0) return 0;

    // Pass 1 — walk every root for metadata only. Bytes are re-read later,
    // and only for the hashes the remote is actually missing, so a dirty
    // directory holding 15k files never lands in RAM all at once.
    const localMetas: LocalMeta[] = [];
    const hashToAbs = new Map<string, string>();
    for (const root of live) {
      const absPath = resolveWithinCache(cachePath, root);
      let stat: Deno.FileInfo | null = null;
      try {
        stat = await Deno.stat(absPath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      if (stat?.isFile) {
        const bytes = await Deno.readFile(absPath);
        const hash = await sha256Hex(bytes);
        localMetas.push({ relPath: root, hash, size: bytes.byteLength });
        if (!hashToAbs.has(hash)) hashToAbs.set(hash, absPath);
      } else if (stat?.isDirectory) {
        await walkMetas(absPath, root, localMetas, hashToAbs);
      }
      // A missing root is a deletion: it contributes no local metas, and the
      // tombstone pass below reconciles whatever the remote still lists.
    }

    // Pass 2 — one manifest query per batch of roots instead of per root.
    const remoteByPath = new Map<string, PathDoc>();
    for (let i = 0; i < live.length; i += ROOT_QUERY_BATCH) {
      const batch = live.slice(i, i + ROOT_QUERY_BATCH);
      const clauses: Array<Record<string, unknown>> = [];
      for (const root of batch) {
        clauses.push({ _id: root });
        clauses.push({ _id: { $regex: `^${escapeRegex(root)}/` } });
      }
      for await (const doc of paths.find({ $or: clauses })) {
        remoteByPath.set(doc._id, doc);
      }
    }

    let changes = 0;

    // Pass 3 — probe blob existence in bulk, then re-read and push only the
    // bytes the remote lacks.
    const distinctHashes = [...hashToAbs.keys()];
    const missingHashes: string[] = [];
    for (let i = 0; i < distinctHashes.length; i += BLOB_QUERY_BATCH) {
      const batch = distinctHashes.slice(i, i + BLOB_QUERY_BATCH);
      const present = new Set<string>();
      for await (
        const b of blobs.find(
          { _id: { $in: batch } },
          { projection: { _id: 1 } },
        )
      ) {
        present.add(b._id);
      }
      for (const h of batch) if (!present.has(h)) missingHashes.push(h);
    }
    for (let i = 0; i < missingHashes.length; i += PUSH_BULK) {
      const batch = missingHashes.slice(i, i + PUSH_BULK);
      const byHash = new Map<string, Uint8Array>();
      let batchBytes = 0;
      for (const h of batch) {
        const bytes = await readFileOrNull(hashToAbs.get(h)!);
        // Vanished between walk and read (autoGc): the path upsert below is
        // skipped for it too, since its meta no longer resolves to bytes.
        if (bytes === null) continue;
        byHash.set(h, bytes);
        batchBytes += bytes.byteLength;
        if (batchBytes >= BULK_INLINE_BYTES) {
          changes += await pushBlobsByHash(blobs, [...byHash.keys()], byHash);
          byHash.clear();
          batchBytes = 0;
        }
      }
      if (byHash.size > 0) {
        changes += await pushBlobsByHash(blobs, [...byHash.keys()], byHash);
      }
    }

    // Pass 4 — path upserts, skipping anything the remote already has at the
    // same hash.
    const now = new Date();
    let pathOps: AnyBulkWriteOperation<PathDoc>[] = [];
    const flushPathOps = async () => {
      if (pathOps.length === 0) return;
      await paths.bulkWrite(pathOps, { ordered: false });
      pathOps = [];
    };
    for (const f of localMetas) {
      const existing = remoteByPath.get(f.relPath);
      if (
        existing &&
        existing.deletedAt === null &&
        existing.hash === f.hash
      ) continue;
      pathOps.push({
        updateOne: {
          filter: { _id: f.relPath },
          update: {
            $set: {
              hash: f.hash,
              size: f.size,
              updatedAt: now,
              deletedAt: null,
            },
          },
          upsert: true,
        },
      });
      changes++;
      if (pathOps.length >= PUSH_BULK) await flushPathOps();
    }
    await flushPathOps();

    // Pass 5 — same lazy guard as fullWalkPush: don't tombstone within these
    // subtrees while the cache is an incomplete (lazy) mirror.
    if (watermarkIso !== null && !lazyPullActive) {
      const watermark = new Date(watermarkIso);
      const localPaths = new Set(localMetas.map((f) => f.relPath));
      let tombstoneOps: AnyBulkWriteOperation<PathDoc>[] = [];
      const flushTombstones = async () => {
        if (tombstoneOps.length === 0) return;
        await paths.bulkWrite(tombstoneOps, { ordered: false });
        tombstoneOps = [];
      };
      for (const [relPath, doc] of remoteByPath) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        tombstoneOps.push({
          updateOne: {
            filter: { _id: relPath },
            update: { $set: { deletedAt: now, updatedAt: now } },
          },
        });
        changes++;
        if (tombstoneOps.length >= PUSH_BULK) await flushTombstones();
      }
      await flushTombstones();
    }

    return changes;
  }

  return {
    capabilities(): SyncCapabilities {
      return { scopedSync: true, lazyHydration: true };
    },

    // The dirty sidecar remains the authoritative source of what to push;
    // `context.models` is advisory (matches the s3 reference, whose push
    // stays diff-driven). We don't scope the push by it.
    async pushChanged(_options?: DatastoreSyncOptions): Promise<number> {
      const { paths, blobs } = await resources();
      const state = await sidecar.read();
      const lazy = state.lazyPullActive;

      // First push from this cache must be a full walk so whatever is already
      // on disk gets bootstrapped to the remote — the per-path dirty tracker
      // only knows about writes since it started. `markDirty` on a missing
      // sidecar sets bulkInvalidated, but a `pullChanged` that runs first
      // (e.g. setup migrates files, then hydrates) writes a *clean* sidecar
      // and erases that signal, so the migrated cache would never be pushed
      // (issue #4). `pushBootstrapped` survives a pull and is only set true
      // by a completed push, so it closes that gap and also re-pushes the
      // content of any deployment that already hit the bug.
      const watermark = reconcileWatermark(state);
      if (state.bulkInvalidated || !state.pushBootstrapped) {
        const { changes, reconciledAt } = await fullWalkPush(
          paths,
          blobs,
          watermark,
          lazy,
        );
        await sidecar.clearDirty();
        // A full walk enumerated every remote path doc, so this cache has now
        // genuinely observed the complete remote list — record it so the next
        // push may tombstone paths this host itself wrote earlier. A lazy
        // cache is exempt: it never had the full local side to compare.
        if (!lazy) await sidecar.setLastReconciledAt(reconciledAt);
        return changes;
      }

      // `dirtyPaths` arrives already coalesced: descendants of a dirty
      // directory are dropped, because pushRoots walks a dirty directory in
      // full. That is what turns the per-version markDirty storm into a
      // handful of roots.
      const roots = state.dirtyPaths;
      if (roots.length === 0) return 0;

      let changes = 0;
      // Retire progress in slices. clearDirty used to run only after every
      // root had been reconciled, so a push that timed out or was killed
      // re-did all of its work next run — and the dirty set kept growing in
      // the meantime. Forgetting each slice as it lands makes an interrupted
      // push resume roughly where it stopped.
      for (let i = 0; i < roots.length; i += PUSH_ROOT_SLICE) {
        const slice = roots.slice(i, i + PUSH_ROOT_SLICE);
        changes += await pushRoots(
          paths,
          blobs,
          slice,
          watermark,
          lazy,
        );
        await sidecar.forgetDirty(slice);
      }
      await sidecar.clearDirty();
      return changes;
    },

    pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      const prefixes = modelPrefixes(options?.context?.models);
      return pull({
        prefixes: prefixes.length > 0 ? prefixes : undefined,
        metadataOnly: options?.metadataOnly,
      });
    },

    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      // Normalize BEFORE the unsyncable check: core prefixes the namespace, so
      // an un-normalized `<ns>/secrets/...` slips past isSecretsPath.
      const relPath = options?.relPath === undefined
        ? undefined
        : toTierRelative(options.relPath);
      // Drop dirty signals for the vault tier and host-local files — neither
      // ever syncs (see isSecretsPath / isExcludedPath). Filtering here keeps
      // per-command SQLite catalog churn out of the journal entirely. A bulk
      // invalidation (no relPath) still records.
      if (relPath !== undefined && isUnsyncable(relPath)) {
        return Promise.resolve();
      }
      return sidecar.recordDirty(relPath).then(() => undefined);
    },

    // Single-file hydration: one manifest lookup by path key, then one blob
    // fetch by content hash (assembling chunks for >15 MB blobs). No
    // watermark or sidecar interaction — this is a pure on-demand read of a
    // file the lazy setup pull deliberately skipped.
    async hydrateFile(rawRelPath: string): Promise<boolean> {
      // Core passes this one namespace-prefixed too (swamp-club#1554 records
      // the same for @swamp/s3-datastore's hook), so normalize before the
      // secrets check, the remote _id lookup, and the local join alike.
      const relPath = toTierRelative(rawRelPath);
      // The vault tier never syncs, so there's nothing to hydrate.
      if (isSecretsPath(relPath)) return false;
      const { paths, blobs } = await resources();
      const doc = await paths.findOne({ _id: relPath });
      if (doc === null || doc.deletedAt !== null) return false;

      const absPath = resolveWithinCache(cachePath, relPath);
      const local = await readFileOrNull(absPath);
      if (local !== null && (await sha256Hex(local)) === doc.hash) return true;

      const bytes = await fetchBlobBytes(blobs, doc.hash);
      if (bytes === null) return false;
      await writeFileAtomic(absPath, bytes);
      return true;
    },
  };
}

// Maps a scoped-sync model list to the cache-relative path prefixes that hold
// each model's bytes. Mirrors swamp core's per-model lock key root
// (`data/<modelType>/<modelId>/.lock`) and the s3 reference's pull scope.
export function modelPrefixes(
  models: ReadonlyArray<{ modelType: string; modelId: string }> | undefined,
): string[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => `data/${m.modelType}/${m.modelId}/`);
}

async function pushBlobsByHash(
  blobs: Collection<BlobDoc>,
  hashes: string[],
  localByHash: Map<string, Uint8Array>,
): Promise<number> {
  if (hashes.length === 0) return 0;
  const inlineHashes: string[] = [];
  const chunkedHashes: string[] = [];
  for (const h of hashes) {
    const bytes = localByHash.get(h);
    if (bytes === undefined) continue;
    if (bytes.byteLength <= BLOB_INLINE_MAX) inlineHashes.push(h);
    else chunkedHashes.push(h);
  }

  let pushed = 0;
  let i = 0;
  while (i < inlineHashes.length) {
    const ops: AnyBulkWriteOperation<BlobDoc>[] = [];
    let batchBytes = 0;
    while (
      i < inlineHashes.length &&
      ops.length < PUSH_BULK &&
      batchBytes < BULK_INLINE_BYTES
    ) {
      const h = inlineHashes[i++];
      const bytes = localByHash.get(h)!;
      batchBytes += bytes.byteLength + 64;
      ops.push({
        insertOne: {
          document: {
            _id: h,
            size: bytes.byteLength,
            createdAt: new Date(),
            data: new Binary(bytes),
          },
        },
      });
    }
    pushed += await safeBulkInsertBlobs(blobs, ops);
  }

  for (const h of chunkedHashes) {
    const bytes = localByHash.get(h)!;
    pushed += await pushChunkedBlob(blobs, h, bytes);
  }
  return pushed;
}

async function pushChunkedBlob(
  blobs: Collection<BlobDoc>,
  hash: string,
  bytes: Uint8Array,
): Promise<number> {
  const size = bytes.byteLength;
  const chunkCount = Math.ceil(size / BLOB_CHUNK_BYTES);

  // Insert chunks first. Dup-key on any chunk is tolerated so a previously
  // interrupted push can finish without re-uploading completed chunks.
  let chunksWritten = 0;
  for (let i = 0; i < chunkCount; i++) {
    const start = i * BLOB_CHUNK_BYTES;
    const end = Math.min(start + BLOB_CHUNK_BYTES, size);
    const chunkBytes = bytes.subarray(start, end);
    chunksWritten += await safeBulkInsertBlobs(blobs, [{
      insertOne: {
        document: {
          _id: `${hash}:${i}`,
          size: chunkBytes.byteLength,
          createdAt: new Date(),
          data: new Binary(chunkBytes),
        },
      },
    }]);
  }

  // Header written last so readers never see a header pointing at missing
  // chunks. If the header already exists, another writer beat us — treat as
  // success.
  const headerWritten = await safeBulkInsertBlobs(blobs, [{
    insertOne: {
      document: { _id: hash, size, createdAt: new Date(), chunkCount },
    },
  }]);
  return chunksWritten + headerWritten;
}

// Fetches a blob's full bytes by content hash, transparently assembling
// chunked blobs. Returns null when no blob doc exists for the hash.
async function fetchBlobBytes(
  blobs: Collection<BlobDoc>,
  hash: string,
): Promise<Uint8Array | null> {
  const blob = await blobs.findOne({ _id: hash });
  if (blob === null) return null;
  if (blob.data) return blob.data.buffer;
  return await assembleChunkedBlob(blobs, blob);
}

async function assembleChunkedBlob(
  blobs: Collection<BlobDoc>,
  header: BlobDoc,
): Promise<Uint8Array> {
  const chunkCount = header.chunkCount;
  if (chunkCount === undefined || chunkCount <= 0) {
    throw new Error(
      `Blob ${header._id} has neither inline data nor a positive chunkCount`,
    );
  }
  const chunkIds = Array.from(
    { length: chunkCount },
    (_, i) => `${header._id}:${i}`,
  );
  const parts = new Map<number, Uint8Array>();
  for await (
    const doc of blobs.find({ _id: { $in: chunkIds } })
  ) {
    if (!doc.data) {
      throw new Error(`Blob chunk ${doc._id} has no data field`);
    }
    const colon = doc._id.lastIndexOf(":");
    const idx = parseInt(doc._id.slice(colon + 1), 10);
    parts.set(idx, doc.data.buffer);
  }
  const out = new Uint8Array(header.size);
  let offset = 0;
  for (let i = 0; i < chunkCount; i++) {
    const part = parts.get(i);
    if (!part) {
      throw new Error(`Missing chunk ${i} for blob ${header._id}`);
    }
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function safeBulkInsertBlobs(
  blobs: Collection<BlobDoc>,
  ops: AnyBulkWriteOperation<BlobDoc>[],
): Promise<number> {
  if (ops.length === 0) return 0;
  try {
    const res = await blobs.bulkWrite(ops, { ordered: false });
    return res.insertedCount ?? 0;
  } catch (err) {
    const wErr = err as {
      writeErrors?: Array<{ code: number; errmsg?: string; index?: number }>;
      insertedCount?: number;
    };
    const writeErrors = wErr.writeErrors ?? [];
    const fatal = writeErrors.find(
      (e) => e.code !== ERR_DUP_KEY && e.code !== ERR_DOC_TOO_LARGE,
    );
    if (fatal) throw err;
    if (writeErrors.length === 0) throw err;
    return wErr.insertedCount ?? 0;
  }
}

function addToBucket<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    }),
  );
}

// Metadata-only walk: hashes each file and drops its bytes immediately,
// recording where to find them again if the remote turns out to need them.
// Both push paths share it — the old walkInto accumulated every file's bytes,
// so one dirty data-name directory holding 15k versions pinned all of them in
// RAM, and the old walkAndStream had to decide push-or-skip inline, which
// forced the whole blob-id prefetch.
async function walkMetas(
  root: string,
  relRoot: string,
  out: LocalMeta[],
  hashToAbs: Map<string, string>,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isSymlink) continue;
      const childAbs = `${root}/${entry.name}`;
      const childRel = `${relRoot}/${entry.name}`;
      if (entry.isDirectory) {
        await walkMetas(childAbs, childRel, out, hashToAbs);
        continue;
      }
      if (!entry.isFile) continue;
      if (isExcludedPath(childRel)) continue;
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(childAbs);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue;
        throw err;
      }
      const hash = await sha256Hex(bytes);
      out.push({ relPath: childRel, hash, size: bytes.byteLength });
      if (!hashToAbs.has(hash)) hashToAbs.set(hash, childAbs);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function removeSilentlyExisting(path: string): Promise<boolean> {
  try {
    await Deno.remove(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeFileAtomic(
  absPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const slash = absPath.lastIndexOf("/");
  const dir = slash > 0 ? absPath.slice(0, slash) : ".";
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, absPath);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { SidecarState };
