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
import { Sidecar, type SidecarState } from "./sidecar.ts";

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
//       { _id: <sha256>, size, data: <Binary> }
//   * Chunked blob (size > BLOB_INLINE_MAX):
//       Header doc:  { _id: <sha256>, size, chunkCount }            (no data)
//       Chunk docs:  { _id: "<sha256>:<i>", size, data: <Binary> }   (i = 0..N-1)
// `data` and `chunkCount` are mutually exclusive: a doc is either inline,
// header, or chunk. Chunk ids use `:` which is not a sha256 hex character,
// so chunk ids never collide with hash-only ids.
interface BlobDoc {
  _id: string;
  size: number;
  data?: Binary;
  chunkCount?: number;
}

interface LocalFile {
  relPath: string;
  hash: string;
  size: number;
  bytes: Uint8Array;
}

// Same shape as LocalFile minus bytes — used by fullWalkPush so we can walk
// 100k+ files without buffering all of their contents in RAM.
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

export function createSyncService(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
  bareCachePath: string,
): DatastoreSyncService {
  // Core passes the bare, un-namespaced cache path; the tier actually lives one
  // segment deeper. Every local read/write below is rooted here so push walks
  // and pull writes land where core's reader looks. See tierRoot() in config.ts.
  const cachePath = tierRoot(cfg, bareCachePath);
  // The sidecar tracks paths relative to the tier root, so it belongs beside the
  // tier it describes — not at the cache root shared with other namespaces.
  const sidecar = new Sidecar(cachePath);
  let updatedAtIndexEnsured = false;

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
      // Never hydrate vault secrets, even if an older version synced them.
      // Advance the watermark past the doc (above) so it isn't re-scanned,
      // but don't write or delete it locally.
      if (isSecretsPath(doc._id)) continue;
      // A `_id` that escapes the cache root is dropped here rather than thrown
      // on: the database is shared, and letting one malformed or planted doc
      // abort every future pull would turn a rejected write into a sync outage.
      // resolveWithinCache still guards the write sites as defence in depth.
      if (!isSafeRelPath(doc._id)) {
        console.warn(
          `mongodb-datastore: skipping remote path outside the cache root: ${
            JSON.stringify(doc._id)
          }`,
        );
        continue;
      }
      pathDocs.push(doc);
    }

    const concurrency = poolConcurrency();
    let changes = 0;

    const deletes = pathDocs.filter((d) => d.deletedAt !== null);
    await runPool(deletes, concurrency, async (doc) => {
      if (
        await removeSilentlyExisting(resolveWithinCache(cachePath, doc._id))
      ) {
        changes++;
      }
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
    lastPulledAt: string | null,
    lazyPullActive: boolean,
  ): Promise<number> {
    // Pre-fetch the set of blob hashes already in mongo so we can decide
    // push-or-skip per file during the walk without buffering bytes.
    // Filter out chunk docs (their `_id` carries `:<n>`): a hash is only
    // "present" when its header/inline doc exists.
    const remoteBlobHashes = new Set<string>();
    for await (
      const b of blobs.find({}, { projection: { _id: 1 } })
    ) {
      if (!b._id.includes(":")) remoteBlobHashes.add(b._id);
    }

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

    // Streaming push state: one file's bytes are in memory at most.
    const inlineOps: AnyBulkWriteOperation<BlobDoc>[] = [];
    let inlineBytes = 0;
    let blobsPushed = 0;
    const seenHashes = new Set<string>();

    const flushInline = async () => {
      if (inlineOps.length === 0) return;
      blobsPushed += await safeBulkInsertBlobs(blobs, inlineOps);
      inlineOps.length = 0;
      inlineBytes = 0;
    };

    const localMetas: LocalMeta[] = [];
    const onFile = async (relPath: string, bytes: Uint8Array) => {
      const hash = await sha256Hex(bytes);
      localMetas.push({ relPath, hash, size: bytes.byteLength });

      if (remoteBlobHashes.has(hash) || seenHashes.has(hash)) return;
      seenHashes.add(hash);

      if (bytes.byteLength > BLOB_INLINE_MAX) {
        await flushInline();
        blobsPushed += await pushChunkedBlob(blobs, hash, bytes);
        return;
      }
      if (
        inlineOps.length >= PUSH_BULK ||
        inlineBytes + bytes.byteLength + 64 >= BULK_INLINE_BYTES
      ) {
        await flushInline();
      }
      inlineOps.push({
        insertOne: {
          document: {
            _id: hash,
            size: bytes.byteLength,
            data: new Binary(bytes),
          },
        },
      });
      inlineBytes += bytes.byteLength + 64;
    };

    for (const sub of DATASTORE_SUBDIRS) {
      await walkAndStream(`${cachePath}/${sub}`, sub, onFile);
    }
    await flushInline();

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
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
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
    return pathsPushed + blobsPushed;
  }

  async function pushOneRel(
    paths: Collection<PathDoc>,
    blobs: Collection<BlobDoc>,
    relPath: string,
    lastPulledAt: string | null,
    lazyPullActive: boolean,
  ): Promise<number> {
    // Belt-and-suspenders: markDirty already drops secrets, so this only
    // fires if a dirty path slipped through. Never push the vault tier.
    if (isSecretsPath(relPath)) return 0;
    const absPath = resolveWithinCache(cachePath, relPath);
    let stat: Deno.FileInfo | null = null;
    try {
      stat = await Deno.stat(absPath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const local: LocalFile[] = [];
    if (stat?.isFile) {
      const bytes = await Deno.readFile(absPath);
      local.push({
        relPath,
        hash: await sha256Hex(bytes),
        size: bytes.byteLength,
        bytes,
      });
    } else if (stat?.isDirectory) {
      await walkInto(absPath, relPath, local);
    }

    const remoteDocs = await paths.find({
      $or: [
        { _id: relPath },
        { _id: { $regex: `^${escapeRegex(relPath)}/` } },
      ],
    }).toArray();
    const remoteByPath = new Map<string, PathDoc>();
    for (const d of remoteDocs) remoteByPath.set(d._id, d);

    const localByHash = new Map<string, Uint8Array>();
    for (const f of local) {
      if (!localByHash.has(f.hash)) localByHash.set(f.hash, f.bytes);
    }
    let changes = 0;

    const localHashes = [...localByHash.keys()];
    const remoteBlobHashes = new Set<string>();
    if (localHashes.length > 0) {
      for await (
        const b of blobs.find(
          { _id: { $in: localHashes } },
          { projection: { _id: 1 } },
        )
      ) {
        remoteBlobHashes.add(b._id);
      }
    }
    const missing = localHashes.filter((h) => !remoteBlobHashes.has(h));
    changes += await pushBlobsByHash(blobs, missing, localByHash);

    const now = new Date();
    const pathOps: AnyBulkWriteOperation<PathDoc>[] = [];
    for (const f of local) {
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
    }
    for (let i = 0; i < pathOps.length; i += PUSH_BULK) {
      await paths.bulkWrite(
        pathOps.slice(i, i + PUSH_BULK),
        { ordered: false },
      );
    }

    // Same lazy guard as fullWalkPush: don't tombstone within this subtree
    // while the cache is an incomplete (lazy) mirror.
    if (lastPulledAt !== null && !lazyPullActive) {
      const watermark = new Date(lastPulledAt);
      const localPaths = new Set(local.map((f) => f.relPath));
      const tombstoneOps: AnyBulkWriteOperation<PathDoc>[] = [];
      for (const doc of remoteDocs) {
        if (localPaths.has(doc._id) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        tombstoneOps.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { deletedAt: now, updatedAt: now } },
          },
        });
        changes++;
      }
      for (let i = 0; i < tombstoneOps.length; i += PUSH_BULK) {
        await paths.bulkWrite(
          tombstoneOps.slice(i, i + PUSH_BULK),
          { ordered: false },
        );
      }
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
      if (state.bulkInvalidated || !state.pushBootstrapped) {
        const changes = await fullWalkPush(
          paths,
          blobs,
          state.lastPulledAt,
          lazy,
        );
        await sidecar.clearDirty();
        return changes;
      }

      if (state.dirtyPaths.length === 0) return 0;
      let changes = 0;
      for (const relPath of state.dirtyPaths) {
        changes += await pushOneRel(
          paths,
          blobs,
          relPath,
          state.lastPulledAt,
          lazy,
        );
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
      const relPath = options?.relPath;
      // Drop dirty signals for the vault tier — it never syncs (see
      // isSecretsPath). A bulk invalidation (no relPath) still records.
      if (relPath !== undefined && isSecretsPath(relPath)) {
        return Promise.resolve();
      }
      return sidecar.recordDirty(relPath).then(() => undefined);
    },

    // Single-file hydration: one manifest lookup by path key, then one blob
    // fetch by content hash (assembling chunks for >15 MB blobs). No
    // watermark or sidecar interaction — this is a pure on-demand read of a
    // file the lazy setup pull deliberately skipped.
    async hydrateFile(relPath: string): Promise<boolean> {
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
      document: { _id: hash, size, chunkCount },
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

async function walkAndStream(
  root: string,
  relRoot: string,
  onFile: (relPath: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isSymlink) continue;
      const childAbs = `${root}/${entry.name}`;
      const childRel = `${relRoot}/${entry.name}`;
      if (entry.isDirectory) {
        await walkAndStream(childAbs, childRel, onFile);
        continue;
      }
      if (!entry.isFile) continue;
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(childAbs);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue;
        throw err;
      }
      await onFile(childRel, bytes);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

async function walkInto(
  root: string,
  relRoot: string,
  out: LocalFile[],
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isSymlink) continue;
      const childAbs = `${root}/${entry.name}`;
      const childRel = `${relRoot}/${entry.name}`;
      if (entry.isDirectory) {
        await walkInto(childAbs, childRel, out);
        continue;
      }
      if (!entry.isFile) continue;
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(childAbs);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue;
        throw err;
      }
      out.push({
        relPath: childRel,
        hash: await sha256Hex(bytes),
        size: bytes.byteLength,
        bytes,
      });
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
