import { type AnyBulkWriteOperation, Binary } from "npm:mongodb@6.17.0";
import type { ClientHandle } from "./client.ts";
import {
  blobsCollectionName,
  controlCollectionName,
  EXTENSION_VERSION,
  type MongoDatastoreConfig,
  pathsCollectionName,
} from "./config.ts";
import {
  getSidecar,
  reconcileWatermark,
  type SidecarState,
} from "./sidecar.ts";
import {
  hasLegacyPrefix,
  remoteRel,
  stripLegacyPrefix,
} from "./path_mapping.ts";
import {
  type ControlPlaneStore,
  createControlPlaneStore,
} from "./control_plane.ts";
import type {
  BlobDoc,
  BlobsStore,
  ControlStore,
  PathDoc,
  PathsStore,
} from "./stores.ts";

// Mirrors @systeminit/swamp's domain/datastore/datastore_sync_service.ts.
export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  namespacedSync?: boolean;
  twoPhaseSync?: boolean;
  controlPlane?: boolean;
  configRefresh?: boolean;
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
  // swamp core's datastore.namespace. Drives the local layout
  // (`<cache>/<namespace>/...`) — see path_mapping.ts. Never the same thing
  // as config.namespace.
  namespace?: string;
  // Restricts a pull to these datastore subdirectories (configRefresh).
  subdirs?: readonly string[];
}

/** Opaque to core; produced by preparePush, consumed by commitPush. */
export type PushManifest = { readonly __brand: unique symbol };

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
  preparePush?(options?: DatastoreSyncOptions): Promise<PushManifest>;
  commitPush?(
    manifest: PushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
  controlPlaneStore?(): ControlPlaneStore;
}

/** Shared with the provider so the verifier can report the core namespace. */
export interface NamespaceHolder {
  current: string | undefined;
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

// Deliberately carries no `bytes`: both push paths walk for metadata first
// and re-read only the files whose hashes the remote turns out to lack, so a
// 100k-file tree never has all of its contents in RAM at once.
interface LocalMeta {
  // Tier-relative remote id.
  relPath: string;
  hash: string;
  size: number;
}

interface RemotePathSlim {
  hash: string;
  deletedAt: Date | null;
  updatedAt: Date;
}

// What preparePush hands to commitPush. `dirtyRoots` is the slice of the
// journal this manifest consumed, so commit releases exactly that (never the
// whole journal — a markDirty that lands between the phases must survive).
interface InternalPushManifest {
  mode: "full" | "roots";
  namespace: string | undefined;
  localMetas: LocalMeta[];
  dirtyRoots: string[];
  bulkSeq: number;
  watermark: string | null;
  lazy: boolean;
  reconciledAt: string;
  blobsPushed: number;
}

const PUSH_BULK = 500;
const BLOB_QUERY_BATCH = 5000;
// Dirty roots folded into a single manifest query. Each root contributes two
// `$or` clauses (exact id + prefix regex), so this keeps the query under a
// few hundred clauses while cutting round-trips by the same factor.
const ROOT_QUERY_BATCH = 100;
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
// tier (it's out of DATASTORE_SUBDIRS) and is guarded in markDirty/pushRoots;
// pull skips these docs so a deployment that synced secrets under an older
// version cannot re-hydrate them into a cache.
export function isSecretsPath(relPath: string): boolean {
  return relPath === "secrets" || relPath.startsWith("secrets/");
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
 * and `@` (`data//...`) — only a segment that IS `.` or `..` is unsafe.
 *
 * This is a  fork guard: the upstream keeb tree composes these paths by
 * raw concatenation. Every merge since 2026.09.01.2 keeps the guard on every
 * local write site.
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
  holder: NamespaceHolder = { current: undefined },
): DatastoreSyncService {
  let updatedAtIndexEnsured = false;
  // Option 4: debounce — collapse per-step pulls into one per-run by skipping
  // pulls within a short window of the last successful pull. A workflow run's
  // steps fire sequentially, so a 30s debounce effectively means "once per run."
  const PULL_DEBOUNCE_MS = 30_000;
  let lastPullCompletedAt = 0;

  // Option 3: sole-writer fast path — skip the pull entirely when no other
  // client has pushed since our last pull. Checked via the control collection's
  // client stamps (written by stampClient after each push).
  const thisClient = clientHolder();

  // The extension's own namespace, used when a call carries no core namespace
  // — the behaviour 2026.09.01.2 shipped (tierRoot in config.ts). In every
  // real deployment the two are equal; when core passes one, it wins.
  const configNamespace = cfg.namespace.trim() || undefined;

  // The core namespace last seen on any sync call. Core passes it on every
  // pull/push/markDirty; controlPlaneStore() has no options parameter, so it
  // binds to whatever the last call established (same as the S3 reference's
  // bindNamespace).
  function bind(options?: DatastoreSyncOptions): string | undefined {
    if (options && "namespace" in options && options.namespace) {
      holder.current = options.namespace;
    } else if (holder.current === undefined) {
      holder.current = configNamespace;
    }
    return holder.current;
  }

  // `<cache>` or `<cache>/<namespace>` — where the tier-relative tree lives.
  // A  fork guard (swamp-club#1458/#1554): the upstream keeb tree roots
  // everything at the bare cache path, which builds a second, invisible tier
  // the reader never sees.
  function localRoot(ns: string | undefined): string {
    return ns ? `${bareCachePath}/${ns}` : bareCachePath;
  }

  // Interned per TIER root: core builds a fresh sync service per invocation,
  // and two Sidecars over one cache would not serialize with each other. The
  // sidecar and journal sit beside the tier they describe.
  function sidecarFor(ns: string | undefined) {
    return getSidecar(localRoot(ns));
  }

  async function resources(): Promise<{
    paths: PathsStore;
    blobs: BlobsStore;
    control: ControlStore;
  }> {
    const { client } = await getClient(repoDir);
    const db = client.db(cfg.database);
    const paths = db.collection(
      pathsCollectionName(cfg),
    ) as unknown as PathsStore;
    const blobs = db.collection(
      blobsCollectionName(cfg),
    ) as unknown as BlobsStore;
    const control = db.collection(
      controlCollectionName(cfg),
    ) as unknown as ControlStore;
    if (!updatedAtIndexEnsured) {
      await paths.createIndex({ updatedAt: 1 }).catch(() => undefined);
      updatedAtIndexEnsured = true;
    }
    return { paths, blobs, control };
  }

  function poolConcurrency(): number {
    return parseInt(
      Deno.env.get("MONGO_DATASTORE_PULL_CONCURRENCY") ?? "32",
      10,
    );
  }

  // `prefixes`, when present, scopes the pull to `_paths` docs whose `_id`
  // begins with one of the given tier-relative prefixes (e.g.
  // `data/<modelType>/<modelId>/` or `config/`). A scoped pull does NOT
  // advance the `lastPulledAt` watermark — the global watermark stays owned
  // exclusively by the full, unscoped pull; bumping it here would make a
  // later full pull skip every out-of-scope change in this window.
  //
  // Both model-scoped and subdir-scoped pulls use the watermark as a LOWER
  // BOUND: data in-scope is fully hydrated by the last full pull (and
  // content files missing from lazy hydration are served on demand by
  // hydrateFile — swamp-club#1984), so only docs newer than `lastPulledAt`
  // can be missing. A quiet model costs one findOne probe instead of a
  // hash-compare of every file in the prefix.
  async function pull(opts: {
    ns: string | undefined;
    prefixes?: string[];
    subdirs?: string[];
    metadataOnly?: boolean;
  }): Promise<number> {
    const { ns } = opts;
    const metadataOnly = opts.metadataOnly === true;
    const modelScoped = opts.prefixes !== undefined && opts.prefixes.length > 0;
    const subdirScoped = opts.subdirs !== undefined && opts.subdirs.length > 0;
    const scoped = modelScoped || subdirScoped;
    const prefixList = [...(opts.prefixes ?? []), ...(opts.subdirs ?? [])];

    // Fast path: debounce consecutive pulls within a short window (option 4).
    // A workflow run's steps fire sequentially, so this collapses per-step
    // pulls into one per-run. Full (unscoped) pulls and metadataOnly pulls
    // always run — they are boot/setup operations.
    if (scoped && Date.now() - lastPullCompletedAt < PULL_DEBOUNCE_MS) {
      return 0;
    }

    const { paths, blobs, control } = await resources();

    // Fast path: sole-writer check (option 3). If the only client that
    // pushed since our last pull is THIS process, nothing can have changed
    // remotely. Read the control collection's client stamps and compare.
    // Only applies when we have a prior pull (watermark is set) and are not
    // doing a full/metadata pull.
    if (scoped) {
      const sidecar = sidecarFor(ns);
      const state = await sidecar.read();
      if (state.lastPulledAt !== null) {
        try {
          const store = createControlPlaneStore(control, ns);
          const keys = await store.list("clients/");
          const lastPulledMs = new Date(state.lastPulledAt).getTime();
          const recentPushers = new Set<string>();
          for (const key of keys) {
            const raw = await store.get(key);
            if (!raw) continue;
            try {
              const doc = JSON.parse(
                new TextDecoder().decode(raw),
              ) as { holder?: string; at?: string };
              if (
                doc.at && doc.holder &&
                new Date(doc.at).getTime() > lastPulledMs
              ) {
                recentPushers.add(doc.holder);
              }
            } catch { /* malformed stamp */ }
          }
          if (
            recentPushers.size === 0 ||
            (recentPushers.size === 1 && recentPushers.has(thisClient))
          ) {
            lastPullCompletedAt = Date.now();
            return 0;
          }
        } catch { /* control read failed, fall through to normal pull */ }
      }
    }

    const cachePath = localRoot(ns);
    const sidecar = sidecarFor(ns);
    // A metadataOnly pull leaves data/.../raw un-hydrated. Mark the cache so
    // a later pushChanged won't read those absent raw files as deletions and
    // tombstone the whole corpus. Set before the no-op early return so even a
    // metadataOnly pull that finds nothing new still records lazy mode.
    if (metadataOnly) await sidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    const prefixFilter: Record<string, unknown> | null = scoped
      ? {
        $or: prefixList.map((p) => ({
          _id: { $regex: `^${escapeRegex(p)}` },
        })),
      }
      : null;
    const useWatermark = state.lastPulledAt !== null;
    const watermarkFilter: Record<string, unknown> | null = useWatermark
      ? { updatedAt: { $gt: new Date(state.lastPulledAt!) } }
      : null;

    if (useWatermark) {
      const probe = await paths.findOne(
        prefixFilter
          ? { $and: [watermarkFilter!, prefixFilter] }
          : watermarkFilter!,
        { projection: { _id: 1 } },
      );
      if (probe === null) {
        lastPullCompletedAt = Date.now();
        return 0;
      }
    }

    const parts = [watermarkFilter, prefixFilter].filter(
      (f): f is Record<string, unknown> => f !== null,
    );
    const baseFilter = parts.length === 0
      ? {}
      : parts.length === 1
      ? parts[0]
      : { $and: parts };
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

    // Legacy `<ns>/x` docs and tier-relative `x` docs describe the same local
    // file. Keep one per local path: newer updatedAt wins, ties go to the
    // bare id (the layout every upgraded client writes).
    const winners = new Map<string, PathDoc>();
    let legacySeen = false;
    let maxUpdatedAtMs = state.lastPulledAt !== null
      ? new Date(state.lastPulledAt).getTime()
      : 0;
    for await (const doc of paths.find(filter)) {
      const ms = doc.updatedAt.getTime();
      if (ms > maxUpdatedAtMs) maxUpdatedAtMs = ms;
      const rel = stripLegacyPrefix(doc._id, ns);
      // Never hydrate vault secrets or host-local files, even if an older
      // version synced them. Advance the watermark past the doc (above) so it
      // isn't re-scanned, but don't write or delete it locally — a stale
      // `-wal`/`-shm` landing next to a live SQLite catalog is worse than
      // having no copy at all.
      if (isUnsyncable(rel)) continue;
      if (hasLegacyPrefix(doc._id, ns)) legacySeen = true;
      const prev = winners.get(rel);
      if (prev === undefined || newerWins(doc, prev, ns)) {
        winners.set(rel, doc);
      }
    }
    // A watermark or scoped pull sees only part of a legacy/bare pair — e.g.
    // after a fold the legacy tombstone is newer than the bare doc, so only
    // the tombstone is in the window. Decide precedence against the twin
    // that is NOT in the window, or a tombstone would delete a live file.
    if (ns && (legacySeen || state.legacyIdsPossible)) {
      await resolveTwins(paths, winners, ns);
    }
    // A cold pull enumerated every remote id: if none carried the legacy
    // prefix, later pulls can skip the twin lookup until one shows up.
    if (ns && coldStart && !metadataOnly && !legacySeen) {
      await sidecar.setLegacyIdsPossible(false);
    } else if (ns && legacySeen && !state.legacyIdsPossible) {
      await sidecar.setLegacyIdsPossible(true);
    }
    const pathDocs = [...winners.entries()].map(([rel, doc]) => ({
      rel,
      doc,
    }));

    const concurrency = poolConcurrency();
    let changes = 0;

    const deletes = pathDocs.filter((d) => d.doc.deletedAt !== null);
    await runPool(deletes, concurrency, async ({ rel }) => {
      if (await removeSilentlyExisting(resolveWithinCache(cachePath, rel))) {
        changes++;
      }
    });

    const needs = pathDocs.filter((d) => d.doc.deletedAt === null);
    const pathsByHash = new Map<string, string[]>();
    if (coldStart) {
      for (const { rel, doc } of needs) addToBucket(pathsByHash, doc.hash, rel);
    } else {
      await runPool(needs, concurrency, async ({ rel, doc }) => {
        const local = await readFileOrNull(resolveWithinCache(cachePath, rel));
        if (local !== null && (await sha256Hex(local)) === doc.hash) return;
        addToBucket(pathsByHash, doc.hash, rel);
      });
    }

    const hashesNeeded = [...pathsByHash.keys()];
    for (let i = 0; i < hashesNeeded.length; i += BLOB_QUERY_BATCH) {
      const hashBatch = hashesNeeded.slice(i, i + BLOB_QUERY_BATCH);
      const writeJobs: Array<{ rel: string; bytes: Uint8Array }> = [];
      const chunkedHeaders: BlobDoc[] = [];
      for await (const blob of blobs.find({ _id: { $in: hashBatch } })) {
        if (blob.data) {
          const bytes = blob.data.buffer;
          for (const rel of pathsByHash.get(blob._id) ?? []) {
            writeJobs.push({ rel, bytes });
          }
        } else {
          chunkedHeaders.push(blob);
        }
      }
      for (const header of chunkedHeaders) {
        const bytes = await assembleChunkedBlob(blobs, header);
        for (const rel of pathsByHash.get(header._id) ?? []) {
          writeJobs.push({ rel, bytes });
        }
      }
      await runPool(writeJobs, concurrency, async ({ rel, bytes }) => {
        await writeFileAtomic(resolveWithinCache(cachePath, rel), bytes);
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
    lastPullCompletedAt = Date.now();
    return changes;
  }

  // ---- push, phase 1: walk + blob upload (no lock needed) -----------------

  async function prepareFull(
    blobs: BlobsStore,
    ns: string | undefined,
    state: SidecarState,
  ): Promise<InternalPushManifest> {
    // Stamped before the manifest read, not after: anything a peer writes
    // while we are streaming the cursor must stay newer than this watermark
    // so the *next* reconcile still considers it, rather than being silently
    // treated as already-seen.
    const reconciledAt = new Date().toISOString();
    const cachePath = localRoot(ns);
    const localMetas: LocalMeta[] = [];
    const hashToAbs = new Map<string, string>();
    for (const sub of DATASTORE_SUBDIRS) {
      await walkMetas(`${cachePath}/${sub}`, sub, localMetas, hashToAbs);
    }
    const blobsPushed = await pushMissingBlobs(blobs, hashToAbs);
    return {
      mode: "full",
      namespace: ns,
      localMetas,
      dirtyRoots: state.dirtyPaths,
      bulkSeq: state.bulkSeq,
      watermark: reconcileWatermark(state),
      lazy: state.lazyPullActive,
      reconciledAt,
      blobsPushed,
    };
  }

  async function prepareRoots(
    blobs: BlobsStore,
    ns: string | undefined,
    state: SidecarState,
  ): Promise<InternalPushManifest> {
    const reconciledAt = new Date().toISOString();
    const cachePath = localRoot(ns);
    const localMetas: LocalMeta[] = [];
    const hashToAbs = new Map<string, string>();
    // Dirty roots are journaled tier-relative (markDirty normalizes them), so
    // the file lives at `<tier>/<root>` and the remote id is the root itself.
    // A journal written by an older client may still carry the namespace
    // prefix; remoteRel strips it either way.
    for (const root of state.dirtyPaths) {
      const rel = remoteRel(root, ns);
      if (isUnsyncable(rel)) continue;
      const absPath = resolveWithinCache(cachePath, rel);
      let stat: Deno.FileInfo | null = null;
      try {
        stat = await Deno.stat(absPath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      if (stat?.isFile) {
        if (isExcludedPath(rel)) continue;
        const bytes = await Deno.readFile(absPath);
        const hash = await sha256Hex(bytes);
        localMetas.push({ relPath: rel, hash, size: bytes.byteLength });
        if (!hashToAbs.has(hash)) hashToAbs.set(hash, absPath);
      } else if (stat?.isDirectory) {
        await walkMetas(absPath, rel, localMetas, hashToAbs);
      }
    }
    const blobsPushed = await pushMissingBlobs(blobs, hashToAbs);
    return {
      mode: "roots",
      namespace: ns,
      localMetas,
      dirtyRoots: state.dirtyPaths,
      bulkSeq: state.bulkSeq,
      watermark: reconcileWatermark(state),
      lazy: state.lazyPullActive,
      reconciledAt,
      blobsPushed,
    };
  }

  // Probe blob existence for the distinct local hashes, then re-read and
  // upload only what's missing. Chunk docs carry `:<n>` in their `_id`, so
  // an `$in` over bare hashes only ever matches inline/header docs — exactly
  // the "is this blob present" question. Probing only the hashes we hold is
  // bounded by the working set, not by the size of the blob store.
  async function pushMissingBlobs(
    blobs: BlobsStore,
    hashToAbs: Map<string, string>,
  ): Promise<number> {
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
    return blobsPushed;
  }

  // ---- push, phase 2: index merge (under core's global lock) --------------

  // Re-reads the remote path docs this manifest can touch. Full mode reads
  // the whole manifest; roots mode reads one batched query per
  // ROOT_QUERY_BATCH roots. Always read fresh here, never carried over from
  // prepare — another writer may have committed in between.
  async function readRemote(
    paths: PathsStore,
    m: InternalPushManifest,
  ): Promise<Map<string, RemotePathSlim>> {
    const remote = new Map<string, RemotePathSlim>();
    const absorb = (doc: PathDoc) => {
      remote.set(doc._id, {
        hash: doc.hash,
        deletedAt: doc.deletedAt,
        updatedAt: doc.updatedAt,
      });
    };
    if (m.mode === "full") {
      for await (
        const doc of paths.find(
          {},
          { projection: { hash: 1, deletedAt: 1, updatedAt: 1 } },
        )
      ) absorb(doc);
      return remote;
    }
    const roots = m.dirtyRoots.map((r) => remoteRel(r, m.namespace)).filter(
      (r) => !isUnsyncable(r),
    );
    for (let i = 0; i < roots.length; i += ROOT_QUERY_BATCH) {
      const clauses: Array<Record<string, unknown>> = [];
      for (const root of roots.slice(i, i + ROOT_QUERY_BATCH)) {
        clauses.push({ _id: root });
        clauses.push({ _id: { $regex: `^${escapeRegex(root)}/` } });
      }
      if (clauses.length === 0) continue;
      for await (const doc of paths.find({ $or: clauses })) absorb(doc);
    }
    return remote;
  }

  async function commit(
    paths: PathsStore,
    m: InternalPushManifest,
  ): Promise<number> {
    const remote = await readRemote(paths, m);
    const now = new Date();
    let pathsPushed = 0;
    let pathOps: AnyBulkWriteOperation<PathDoc>[] = [];
    const flushPathOps = async () => {
      if (pathOps.length === 0) return;
      const res = await paths.bulkWrite(pathOps, { ordered: false });
      pathsPushed += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
      pathOps = [];
    };
    for (const f of m.localMetas) {
      const existing = remote.get(f.relPath);
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
    // propagating once a full pull clears lazyPullActive. Legacy-prefixed
    // remote ids are never tombstoned by a push — fold_namespace_prefix owns
    // their retirement.
    if (m.watermark !== null && !m.lazy) {
      const watermark = new Date(m.watermark);
      const localPaths = new Set(m.localMetas.map((f) => f.relPath));
      const tombstoneOps: AnyBulkWriteOperation<PathDoc>[] = [];
      for (const [relPath, doc] of remote) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        if (hasLegacyPrefix(relPath, m.namespace)) continue;
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
    return pathsPushed + m.blobsPushed;
  }

  // Bookkeeping after a successful commit. Releases only what the manifest
  // consumed; a journal entry or bulk signal that arrived between the phases
  // is left for the next push.
  async function settle(m: InternalPushManifest): Promise<void> {
    const sidecar = sidecarFor(m.namespace);
    await sidecar.forgetDirty(m.dirtyRoots);
    if (m.mode === "full") {
      await sidecar.clearBulkInvalidatedIf(m.bulkSeq);
      // A full walk enumerated every remote path doc, so this cache has now
      // genuinely observed the complete remote list — record it so the next
      // push may tombstone paths this host itself wrote earlier. A lazy
      // cache is exempt: it never had the full local side to compare.
      if (!m.lazy) await sidecar.setLastReconciledAt(m.reconciledAt);
    }
    await sidecar.markPushBootstrapped();
  }

  async function stampClient(
    control: ControlStore,
    ns: string | undefined,
  ): Promise<void> {
    try {
      const store = createControlPlaneStore(control, ns);
      const holderName = clientHolder();
      const body = JSON.stringify({
        holder: holderName,
        version: EXTENSION_VERSION,
        at: new Date().toISOString(),
      });
      await store.put(
        `clients/${holderName.replace(/[^A-Za-z0-9._@-]/g, "_")}`,
        new TextEncoder().encode(body),
      );
    } catch {
      // The stamp is advisory (migration guard input); never fail a push on it.
    }
  }

  async function prepare(
    options?: DatastoreSyncOptions,
  ): Promise<InternalPushManifest> {
    const ns = bind(options);
    const { blobs } = await resources();
    const state = await sidecarFor(ns).read();
    // First push from this cache must be a full walk so whatever is already
    // on disk gets bootstrapped to the remote — the per-path dirty tracker
    // only knows about writes since it started. `pushBootstrapped` survives a
    // pull and is only set true by a completed push.
    if (state.bulkInvalidated || !state.pushBootstrapped) {
      return await prepareFull(blobs, ns, state);
    }
    return await prepareRoots(blobs, ns, state);
  }

  async function commitAndSettle(
    m: InternalPushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number> {
    bind(options);
    const { paths, control } = await resources();
    const changes = await commit(paths, m);
    await settle(m);
    await stampClient(control, m.namespace);
    return changes;
  }

  return {
    capabilities(): SyncCapabilities {
      return {
        scopedSync: true,
        lazyHydration: true,
        namespacedSync: true,
        twoPhaseSync: true,
        controlPlane: true,
        configRefresh: true,
      };
    },

    // The dirty sidecar remains the authoritative source of what to push;
    // `context.models` is advisory (matches the s3 reference, whose push
    // stays diff-driven). We don't scope the push by it.
    async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
      const m = await prepare(options);
      if (m.mode === "roots" && m.dirtyRoots.length === 0) return 0;
      return await commitAndSettle(m, options);
    },

    async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
      return await prepare(options) as unknown as PushManifest;
    },

    async commitPush(
      manifest: PushManifest,
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      const m = manifest as unknown as InternalPushManifest;
      if (m.mode === "roots" && m.dirtyRoots.length === 0) return 0;
      return await commitAndSettle(m, options);
    },

    pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      const ns = bind(options);
      const prefixes = modelPrefixes(options?.context?.models);
      const subdirs = subdirPrefixes(options?.subdirs);
      return pull({
        ns,
        prefixes: prefixes.length > 0 ? prefixes : undefined,
        subdirs: subdirs.length > 0 ? subdirs : undefined,
        metadataOnly: options?.metadataOnly,
      });
    },

    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      const ns = bind(options);
      // Normalize BEFORE the unsyncable check: core prefixes the namespace, so
      // an un-normalized `<ns>/secrets/...` would slip past isSecretsPath. The
      // journal holds tier-relative paths, the same vocabulary as remote ids.
      const relPath = options?.relPath === undefined
        ? undefined
        : remoteRel(options.relPath, ns);
      // Drop dirty signals for the vault tier and host-local files — neither
      // ever syncs (see isSecretsPath / isExcludedPath). Filtering here keeps
      // per-command SQLite catalog churn out of the journal entirely. A bulk
      // invalidation (no relPath) still records.
      if (relPath !== undefined && isUnsyncable(relPath)) {
        return Promise.resolve();
      }
      return sidecarFor(ns).recordDirty(relPath).then(() => undefined);
    },

    // Single-file hydration: one manifest lookup by path key, then one blob
    // fetch by content hash (assembling chunks for >15 MB blobs). No
    // watermark or sidecar interaction — this is a pure on-demand read of a
    // file the lazy setup pull deliberately skipped. `relPath` is
    // cache-relative (it may carry the core namespace); the remote id is
    // tier-relative, with a legacy-prefixed fallback.
    async hydrateFile(
      relPath: string,
      options?: DatastoreSyncOptions,
    ): Promise<boolean> {
      const ns = bind(options);
      const rel = remoteRel(relPath, ns);
      if (isSecretsPath(rel)) return false;
      const { paths, blobs } = await resources();
      let doc = await paths.findOne({ _id: rel });
      if ((doc === null || doc.deletedAt !== null) && ns) {
        const legacy = await paths.findOne({ _id: `${ns}/${rel}` });
        if (legacy !== null && legacy.deletedAt === null) doc = legacy;
      }
      if (doc === null || doc.deletedAt !== null) return false;

      const cachePath = localRoot(ns);
      const absPath = resolveWithinCache(cachePath, rel);
      const local = await readFileOrNull(absPath);
      if (local !== null && (await sha256Hex(local)) === doc.hash) return true;

      const bytes = await fetchBlobBytes(blobs, doc.hash);
      if (bytes === null) return false;
      await writeFileAtomic(absPath, bytes);
      return true;
    },

    controlPlaneStore(): ControlPlaneStore {
      return createControlPlaneStore(
        async () => (await resources()).control,
        holder.current,
      );
    },
  };
}

// For every candidate in `winners`, fetch the other form of its id (bare ↔
// legacy) when that form was not part of the window, and re-run precedence.
// One `$in` query per BLOB_QUERY_BATCH candidates; a namespace with no legacy
// docs left pays one query per pull that returns nothing.
async function resolveTwins(
  paths: PathsStore,
  winners: Map<string, PathDoc>,
  ns: string,
): Promise<void> {
  const wanted: string[] = [];
  for (const [rel, doc] of winners) {
    wanted.push(hasLegacyPrefix(doc._id, ns) ? rel : `${ns}/${rel}`);
  }
  for (let i = 0; i < wanted.length; i += BLOB_QUERY_BATCH) {
    const batch = wanted.slice(i, i + BLOB_QUERY_BATCH);
    for await (const twin of paths.find({ _id: { $in: batch } })) {
      const rel = stripLegacyPrefix(twin._id, ns);
      const current = winners.get(rel);
      if (current === undefined || current._id === twin._id) continue;
      if (newerWins(twin, current, ns)) winners.set(rel, twin);
    }
  }
}

// Between a legacy `<ns>/x` doc and a bare `x` doc for the same local file:
// newer updatedAt wins, a tie goes to the bare id.
function newerWins(
  candidate: PathDoc,
  incumbent: PathDoc,
  ns: string | undefined,
): boolean {
  const cLegacy = hasLegacyPrefix(candidate._id, ns);
  const iLegacy = hasLegacyPrefix(incumbent._id, ns);
  if (cLegacy === iLegacy) {
    return candidate.updatedAt.getTime() > incumbent.updatedAt.getTime();
  }
  // Mixed pair. The bare id is the layout every upgraded client writes and
  // the one fold_namespace_prefix converges on, so it wins unless the legacy
  // doc is LIVE and strictly newer (an old client wrote after us). A legacy
  // tombstone never outranks a bare doc: after a fold every legacy doc is a
  // fresh tombstone, and letting it win would delete the folded file.
  const legacy = cLegacy ? candidate : incumbent;
  const bare = cLegacy ? incumbent : candidate;
  const legacyWins = legacy.deletedAt === null &&
    legacy.updatedAt.getTime() > bare.updatedAt.getTime();
  return cLegacy ? legacyWins : !legacyWins;
}

// Maps a scoped-sync model list to the tier-relative path prefixes that hold
// each model's bytes. Mirrors swamp core's per-model lock key root
// (`data/<modelType>/<modelId>/.lock`) and the s3 reference's pull scope.
export function modelPrefixes(
  models: ReadonlyArray<{ modelType: string; modelId: string }> | undefined,
): string[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => `data/${m.modelType}/${m.modelId}/`);
}

// `subdirs` from core's config/access pollers → tier-relative prefixes.
export function subdirPrefixes(
  subdirs: readonly string[] | undefined,
): string[] {
  if (!subdirs || subdirs.length === 0) return [];
  return subdirs.map((s) => `${s.replace(/\/+$/, "")}/`);
}

function clientHolder(): string {
  const user = Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "unknown";
  let host = "unknown";
  try {
    host = Deno.hostname();
  } catch {
    host = Deno.env.get("HOSTNAME") ?? Deno.env.get("HOST") ?? "unknown";
  }
  return `${user}@${host}`;
}

async function pushBlobsByHash(
  blobs: BlobsStore,
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
  blobs: BlobsStore,
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
  blobs: BlobsStore,
  hash: string,
): Promise<Uint8Array | null> {
  const blob = await blobs.findOne({ _id: hash });
  if (blob === null) return null;
  if (blob.data) return blob.data.buffer;
  return await assembleChunkedBlob(blobs, blob);
}

async function assembleChunkedBlob(
  blobs: BlobsStore,
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
  blobs: BlobsStore,
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
// `relRoot` is the tier-relative (remote) prefix for `root`.
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
