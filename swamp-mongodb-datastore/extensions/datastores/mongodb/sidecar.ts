// Sync-state sidecar for the per-path dirty tracking design (swamp-club#232).
//
// Lives at <cachePath>/.datastore-sync-state.json.
//
// Three pieces of state:
//   - dirtyPaths   — set of cache-relative paths that swamp-core has signalled
//                    via markDirty(relPath). Consumed by pushChanged.
//   - bulkInvalidated — flipped when markDirty fires without a relPath, or
//                    when we observe a corrupt/missing sidecar. Forces the
//                    next pushChanged to take the full-walk path.
//   - lastPulledAt — high-water-mark over _fs_meta.updatedAt. Anything in
//                    Mongo with updatedAt > lastPulledAt is potentially new
//                    work from another host. Read by pullChanged on entry.
//
// Atomicity: every mutation is read-modify-write under a process-local
// Promise chain (sidecar updates serialize within a single process) plus
// tmp-file + rename for crash safety. Cross-process races are handled by
// swamp-core's global lock around mutations.

const SIDECAR_FILENAME = ".datastore-sync-state.json";
const CURRENT_SCHEMA_VERSION = 1;

export interface SidecarState {
  version: number;
  dirtyPaths: string[];
  bulkInvalidated: boolean;
  lastPulledAt: string | null;
  // True while this cache holds an un-hydrated tree: set by a metadataOnly
  // (lazy) pull, cleared by a full (non-metadataOnly, unscoped) pull that
  // brings the cache fully in sync. While true, the local cache is NOT a
  // complete mirror of the remote, so the push reconciliation pass must not
  // read an absent path as a deletion. Survives clearDirty (a push doesn't
  // hydrate anything). Mirrors the S3/GCS reference's lazyPullActive.
  lazyPullActive: boolean;
  // True once a push has run against this cache. Until then the per-path
  // dirty tracker can't be trusted (it only knows writes since it started),
  // so the next push must do a full walk to bootstrap the remote from
  // whatever's already on disk. Unlike bulkInvalidated, this survives a
  // pullChanged: a clean sidecar written by hydration must not erase the
  // obligation to push pre-existing cache content (issue #4). A sidecar that
  // predates this field reads false, so an already-migrated-but-unpushed
  // cache self-heals on its next push.
  pushBootstrapped: boolean;
}

function emptyState(): SidecarState {
  return {
    version: CURRENT_SCHEMA_VERSION,
    dirtyPaths: [],
    bulkInvalidated: false,
    lastPulledAt: null,
    lazyPullActive: false,
    pushBootstrapped: false,
  };
}

function sidecarPath(cachePath: string): string {
  return `${cachePath}/${SIDECAR_FILENAME}`;
}

async function readState(cachePath: string): Promise<SidecarState> {
  const path = sidecarPath(cachePath);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Cold start — no sidecar history. Force a full walk on the first
      // pushChanged so we bootstrap from whatever's already on disk
      // before trusting the per-path tracker.
      return { ...emptyState(), bulkInvalidated: true };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt sidecar — bulk-invalidate to force a safe full walk.
    return { ...emptyState(), bulkInvalidated: true };
  }
  return normalize(parsed);
}

function normalize(parsed: unknown): SidecarState {
  if (typeof parsed !== "object" || parsed === null) {
    return { ...emptyState(), bulkInvalidated: true };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CURRENT_SCHEMA_VERSION) {
    // Unknown version — be safe and force a full walk.
    return { ...emptyState(), bulkInvalidated: true };
  }
  const dirtyPaths = Array.isArray(obj.dirtyPaths)
    ? obj.dirtyPaths.filter((x): x is string => typeof x === "string")
    : [];
  const bulkInvalidated = obj.bulkInvalidated === true;
  const lastPulledAt = typeof obj.lastPulledAt === "string"
    ? obj.lastPulledAt
    : null;
  const lazyPullActive = obj.lazyPullActive === true;
  const pushBootstrapped = obj.pushBootstrapped === true;
  return {
    version: CURRENT_SCHEMA_VERSION,
    dirtyPaths,
    bulkInvalidated,
    lastPulledAt,
    lazyPullActive,
    pushBootstrapped,
  };
}

async function writeState(
  cachePath: string,
  state: SidecarState,
): Promise<void> {
  await Deno.mkdir(cachePath, { recursive: true });
  const path = sidecarPath(cachePath);
  const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  const body = JSON.stringify(state);
  await Deno.writeTextFile(tmp, body);
  await Deno.rename(tmp, path);
}

// In-process serializer for sidecar mutations. Read-modify-write under a
// Promise chain — concurrent calls from one process land in order. Cross-
// process serialization is the global lock's job.
export class Sidecar {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cachePath: string) {}

  read(): Promise<SidecarState> {
    return readState(this.cachePath);
  }

  // Atomically apply a mutator. The mutator MAY mutate the passed state
  // in place, OR return a new state object. Returns the post-mutation
  // state for callers that need to inspect it.
  update(
    mutator: (state: SidecarState) => SidecarState | void,
  ): Promise<SidecarState> {
    const next = this.chain.then(async () => {
      const current = await readState(this.cachePath);
      const result = mutator(current) ?? current;
      await writeState(this.cachePath, result);
      return result;
    });
    // Keep the chain alive even if a mutator throws — subsequent updates
    // should still serialize behind the in-flight one's completion.
    this.chain = next.catch(() => undefined);
    return next;
  }

  recordDirty(relPath: string | undefined): Promise<SidecarState> {
    return this.update((state) => {
      if (relPath === undefined) {
        state.bulkInvalidated = true;
      } else if (!state.dirtyPaths.includes(relPath)) {
        state.dirtyPaths.push(relPath);
      }
    });
  }

  clearDirty(): Promise<SidecarState> {
    return this.update((state) => {
      state.dirtyPaths = [];
      state.bulkInvalidated = false;
      // A push just completed, so the cache is bootstrapped to the remote;
      // future pushes can trust the per-path dirty tracker.
      state.pushBootstrapped = true;
    });
  }

  setLastPulledAt(iso: string): Promise<SidecarState> {
    return this.update((state) => {
      state.lastPulledAt = iso;
    });
  }

  setLazyPullActive(active: boolean): Promise<SidecarState> {
    return this.update((state) => {
      state.lazyPullActive = active;
    });
  }
}
