// Sync-state sidecar for the per-path dirty tracking design (swamp-club#232).
//
// Two files under <cachePath>:
//   - .datastore-sync-state.json — scalar state only (a few hundred bytes).
//   - .datastore-dirty.log       — append-only journal of dirty relPaths.
//
// Why the split (schema v2): v1 kept `dirtyPaths` inside the JSON, so every
// `markDirty` was a read-modify-write of the whole document plus a linear
// `Array.includes` scan. On a repo with ~86k accumulated dirty paths that is a
// 6.8 MB read + parse + serialize + 6.8 MB write and ~86k string compares —
// per dirtied file, all of it under swamp's global lock. Appending one line to
// a journal is O(1) in both I/O and CPU, and the scalar document is only
// rewritten when a scalar actually changes.
//
// Scalar state:
//   - bulkInvalidated — flipped when markDirty fires without a relPath, when
//                    we observe a corrupt/missing sidecar, or when the dirty
//                    set grows past MAX_DIRTY_PATHS. Forces the next
//                    pushChanged to take the full-walk path.
//   - lastPulledAt — high-water-mark over _fs_meta.updatedAt. Anything in
//                    Mongo with updatedAt > lastPulledAt is potentially new
//                    work from another host. Read by pullChanged on entry.
//   - lazyPullActive / pushBootstrapped — see field docs below.
//
// Atomicity: scalar mutations are read-modify-write under a process-local
// Promise chain (they serialize within a single process) plus tmp-file +
// rename for crash safety. Journal appends are O_APPEND writes, which the
// kernel serializes; concurrent writers interleave whole lines safely.
// Cross-process races on the scalars are handled by swamp-core's global lock.

const SIDECAR_FILENAME = ".datastore-sync-state.json";
const JOURNAL_FILENAME = ".datastore-dirty.log";
const CURRENT_SCHEMA_VERSION = 2;

// Past this many distinct dirty paths, a single streaming full walk beats
// per-root reconciliation: the walk is one pass over the cache with batched
// bulkWrites, while per-root work costs at least one manifest query each.
// Hitting the cap degrades to bulkInvalidated rather than growing unbounded.
export const MAX_DIRTY_PATHS = 10_000;

export interface SidecarState {
  version: number;
  // Materialized, coalesced view of the journal — see materialize(). Never
  // stored in the JSON document.
  dirtyPaths: string[];
  bulkInvalidated: boolean;
  lastPulledAt: string | null;
  // High-water mark over the moments this cache last enumerated the *complete*
  // remote manifest — advanced by a full unscoped pull and by a full-walk
  // push. Distinct from lastPulledAt on purpose:
  //
  //   lastPulledAt     — "content is hydrated up to here"  (drives pull)
  //   lastReconciledAt — "remote path list was seen up to here" (drives the
  //                       push tombstone pass)
  //
  // Conflating them broke deletion propagation. A push stamps updatedAt = now
  // on every path it upserts, so those docs immediately sort newer than
  // lastPulledAt — and the tombstone pass skips anything newer than the
  // watermark, since that is how a *peer's* concurrent writes are protected.
  // The result was that a host could never delete data it had itself pushed:
  // `swamp data gc` pruned 118k versions locally and the remote kept every
  // one. Advancing a separate reconcile watermark after a full walk is sound
  // — at that instant we genuinely did observe the whole remote list — while
  // leaving lastPulledAt alone so a pull still re-fetches content it lacks.
  lastReconciledAt: string | null;
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

// The persisted half — SidecarState minus the journal-derived dirtyPaths.
interface Scalars {
  version: number;
  bulkInvalidated: boolean;
  lastPulledAt: string | null;
  lastReconciledAt: string | null;
  lazyPullActive: boolean;
  pushBootstrapped: boolean;
}

function emptyScalars(): Scalars {
  return {
    version: CURRENT_SCHEMA_VERSION,
    bulkInvalidated: false,
    lastPulledAt: null,
    lastReconciledAt: null,
    lazyPullActive: false,
    pushBootstrapped: false,
  };
}

// The watermark the push tombstone pass compares against. Falls back to
// lastPulledAt for caches written before lastReconciledAt existed, which
// preserves their previous (conservative) behavior until the first full walk
// records a real reconcile point.
export function reconcileWatermark(state: SidecarState): string | null {
  return state.lastReconciledAt ?? state.lastPulledAt;
}

// Collapses a raw dirty set into the minimal set of roots that covers it.
// swamp-core calls markDirty with data-name *directories* as well as the
// version dirs beneath them, and pushRoots walks a dirty directory in full —
// so `data/m/i/name` makes every `data/m/i/name/<n>` beneath it redundant.
// Dropping those descendants is what turns ~86k dirty entries into ~17.
export function coalesce(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort();
  const roots: string[] = [];
  let last: string | null = null;
  for (const p of sorted) {
    // Lexicographic order puts an ancestor immediately before its descendants,
    // and any path between them would itself be a descendant of `last`, so
    // comparing against the most recent retained root is sufficient.
    if (last !== null && p.startsWith(last + "/")) continue;
    roots.push(p);
    last = p;
  }
  return roots;
}

function sidecarPath(cachePath: string): string {
  return `${cachePath}/${SIDECAR_FILENAME}`;
}

function journalPath(cachePath: string): string {
  return `${cachePath}/${JOURNAL_FILENAME}`;
}

function normalizeScalars(parsed: unknown): {
  scalars: Scalars;
  legacyDirty: string[];
} {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      scalars: { ...emptyScalars(), bulkInvalidated: true },
      legacyDirty: [],
    };
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  // v1 carried dirtyPaths inline; adopt them so an upgrade in the middle of a
  // dirty window doesn't silently drop pending work.
  const legacyDirty = version === 1 && Array.isArray(obj.dirtyPaths)
    ? obj.dirtyPaths.filter((x): x is string => typeof x === "string")
    : [];
  if (version !== CURRENT_SCHEMA_VERSION && version !== 1) {
    // Unknown version — be safe and force a full walk.
    return {
      scalars: { ...emptyScalars(), bulkInvalidated: true },
      legacyDirty: [],
    };
  }
  return {
    scalars: {
      version: CURRENT_SCHEMA_VERSION,
      bulkInvalidated: obj.bulkInvalidated === true,
      lastPulledAt: typeof obj.lastPulledAt === "string"
        ? obj.lastPulledAt
        : null,
      lastReconciledAt: typeof obj.lastReconciledAt === "string"
        ? obj.lastReconciledAt
        : null,
      lazyPullActive: obj.lazyPullActive === true,
      pushBootstrapped: obj.pushBootstrapped === true,
    },
    legacyDirty,
  };
}

async function readScalars(
  cachePath: string,
): Promise<{ scalars: Scalars; legacyDirty: string[]; degraded: boolean }> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(sidecarPath(cachePath));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Cold start — no sidecar history. Force a full walk on the first
      // pushChanged so we bootstrap from whatever's already on disk
      // before trusting the per-path tracker.
      return {
        scalars: { ...emptyScalars(), bulkInvalidated: true },
        legacyDirty: [],
        degraded: true,
      };
    }
    throw err;
  }
  try {
    const { scalars, legacyDirty } = normalizeScalars(JSON.parse(raw));
    return { scalars, legacyDirty, degraded: false };
  } catch {
    // Corrupt sidecar — bulk-invalidate to force a safe full walk.
    return {
      scalars: { ...emptyScalars(), bulkInvalidated: true },
      legacyDirty: [],
      degraded: true,
    };
  }
}

// Folds a fresh read over what we already knew.
//
// Every fallback in readScalars returns *blank* scalars alongside
// bulkInvalidated. That is the right answer for `bulkInvalidated` — when in
// doubt, full-walk — but it is actively destructive for the rest: mutators
// re-read before writing, so one transient unreadable/unknown-version read
// would adopt `lastPulledAt: null, pushBootstrapped: false` and then *persist*
// it. Losing the watermark is not a safe default. It disables the push
// tombstone pass (deletions stop propagating) and turns the next pull into a
// cold start that re-hydrates every version the remote still lists — which,
// right after a `swamp data gc`, means resurrecting exactly what was pruned.
//
// So a degraded read only ever contributes bulkInvalidated; the durable
// scalars fall back to the last value this instance saw.
function mergeScalars(
  known: Scalars | null,
  fresh: Scalars,
  degraded: boolean,
): Scalars {
  if (!degraded || known === null) return fresh;
  return { ...known, bulkInvalidated: true };
}

async function writeScalars(
  cachePath: string,
  scalars: Scalars,
): Promise<void> {
  await Deno.mkdir(cachePath, { recursive: true });
  const path = sidecarPath(cachePath);
  const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, JSON.stringify(scalars));
  await Deno.rename(tmp, path);
}

// Reads the journal, tolerating a truncated trailing line (a writer may be
// mid-append) and blank lines.
async function readJournal(cachePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(journalPath(cachePath));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length > 0) out.push(line);
  }
  return out;
}

// One Sidecar per cache path, process-wide.
//
// swamp core calls createSyncService on every invocation, so a plain
// constructor hands out independent instances that share the two files but
// NOT the Promise chain that is supposed to serialize them — each also keeps
// its own O_APPEND handle and its own in-memory dirty set. Interning by
// cachePath restores the invariant the chain assumes: exactly one writer per
// cache within a process.
const instances = new Map<string, Sidecar>();

export function getSidecar(cachePath: string): Sidecar {
  let sc = instances.get(cachePath);
  if (sc === undefined) {
    sc = new Sidecar(cachePath);
    instances.set(cachePath, sc);
  }
  return sc;
}

export class Sidecar {
  private chain: Promise<unknown> = Promise.resolve();
  private scalars: Scalars | null = null;
  private dirty = new Set<string>();
  private handle: Deno.FsFile | null = null;
  private loaded: Promise<void> | null = null;

  constructor(private readonly cachePath: string) {}

  private load(): Promise<void> {
    if (this.loaded !== null) return this.loaded;
    this.loaded = (async () => {
      const { scalars, legacyDirty, degraded } = await readScalars(
        this.cachePath,
      );
      this.scalars = mergeScalars(this.scalars, scalars, degraded);
      for (const p of await readJournal(this.cachePath)) this.dirty.add(p);
      if (legacyDirty.length > 0) {
        // Migrating a v1 sidecar. Beyond the cap the accumulated set is worse
        // than useless — most entries are versions autoGc already reaped — so
        // take the full walk once and start clean.
        if (legacyDirty.length + this.dirty.size > MAX_DIRTY_PATHS) {
          this.scalars.bulkInvalidated = true;
          this.dirty.clear();
        } else {
          for (const p of legacyDirty) this.dirty.add(p);
        }
        await this.persistJournal();
        await writeScalars(this.cachePath, this.scalars);
      }
    })();
    return this.loaded;
  }

  // Rewrites the journal from the in-memory set. Used by migration and by the
  // cap/clear paths — never on the append hot path.
  private async persistJournal(): Promise<void> {
    await Deno.mkdir(this.cachePath, { recursive: true });
    await this.closeHandle();
    const path = journalPath(this.cachePath);
    const body = this.dirty.size === 0 ? "" : [...this.dirty].join("\n") + "\n";
    const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, body);
    await Deno.rename(tmp, path);
  }

  private async closeHandle(): Promise<void> {
    if (this.handle === null) return;
    try {
      this.handle.close();
    } catch {
      // Already closed — nothing to do.
    }
    this.handle = null;
    await Promise.resolve();
  }

  // O_APPEND handle, opened once and reused. The kernel makes each write
  // atomic at the append point, so interleaved writers never split a line.
  private async appendHandle(): Promise<Deno.FsFile> {
    if (this.handle !== null) return this.handle;
    await Deno.mkdir(this.cachePath, { recursive: true });
    this.handle = await Deno.open(journalPath(this.cachePath), {
      append: true,
      create: true,
      write: true,
    });
    return this.handle;
  }

  private async appendLine(relPath: string): Promise<void> {
    const handle = await this.appendHandle();
    const bytes = new TextEncoder().encode(relPath + "\n");
    let off = 0;
    while (off < bytes.length) {
      off += await handle.write(bytes.subarray(off));
    }
  }

  private snapshot(): SidecarState {
    const s = this.scalars ?? emptyScalars();
    return {
      version: CURRENT_SCHEMA_VERSION,
      dirtyPaths: coalesce(this.dirty),
      bulkInvalidated: s.bulkInvalidated,
      lastPulledAt: s.lastPulledAt,
      lastReconciledAt: s.lastReconciledAt,
      lazyPullActive: s.lazyPullActive,
      pushBootstrapped: s.pushBootstrapped,
    };
  }

  // Re-reads both files from disk so a push sees dirty paths appended by other
  // processes. Cheap relative to the push it precedes, and bounded by the cap.
  async read(): Promise<SidecarState> {
    await this.load();
    const { scalars, degraded } = await readScalars(this.cachePath);
    this.scalars = mergeScalars(this.scalars, scalars, degraded);
    this.dirty = new Set(await readJournal(this.cachePath));
    return this.snapshot();
  }

  // Applies a scalar mutation atomically. Journal state is untouched.
  private updateScalars(
    mutator: (s: Scalars) => void,
  ): Promise<SidecarState> {
    const next = this.chain.then(async () => {
      await this.load();
      // Re-read so a concurrent process's scalar write isn't clobbered.
      const { scalars, degraded } = await readScalars(this.cachePath);
      this.scalars = mergeScalars(this.scalars, scalars, degraded);
      mutator(this.scalars);
      await writeScalars(this.cachePath, this.scalars);
      return this.snapshot();
    });
    // Keep the chain alive even if a mutator throws — subsequent updates
    // should still serialize behind the in-flight one's completion.
    this.chain = next.catch(() => undefined);
    return next;
  }

  recordDirty(relPath: string | undefined): Promise<SidecarState> {
    if (relPath === undefined) {
      return this.updateScalars((s) => {
        s.bulkInvalidated = true;
      });
    }
    const next = this.chain.then(async () => {
      await this.load();
      // Already known, or already covered by a dirty ancestor: nothing to
      // journal. This is the branch that absorbs the per-version markDirty
      // storm once the data-name directory itself has been marked.
      if (this.dirty.has(relPath) || this.hasDirtyAncestor(relPath)) {
        return this.snapshot();
      }
      this.dirty.add(relPath);
      if (this.dirty.size > MAX_DIRTY_PATHS) {
        // Degrade to a full walk rather than tracking an unbounded set.
        this.scalars!.bulkInvalidated = true;
        this.dirty.clear();
        await this.persistJournal();
        await writeScalars(this.cachePath, this.scalars!);
        return this.snapshot();
      }
      await this.appendLine(relPath);
      return this.snapshot();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private hasDirtyAncestor(relPath: string): boolean {
    let idx = relPath.lastIndexOf("/");
    while (idx > 0) {
      if (this.dirty.has(relPath.slice(0, idx))) return true;
      idx = relPath.lastIndexOf("/", idx - 1);
    }
    return false;
  }

  clearDirty(): Promise<SidecarState> {
    const next = this.chain.then(async () => {
      await this.load();
      const { scalars, degraded } = await readScalars(this.cachePath);
      this.scalars = mergeScalars(this.scalars, scalars, degraded);
      this.dirty.clear();
      await this.persistJournal();
      this.scalars.bulkInvalidated = false;
      // A push just completed, so the cache is bootstrapped to the remote;
      // future pushes can trust the per-path dirty tracker.
      this.scalars.pushBootstrapped = true;
      await writeScalars(this.cachePath, this.scalars);
      return this.snapshot();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  // Drops a subset of dirty roots — used by pushChanged to retire work
  // incrementally, so an aborted push doesn't lose the progress it made.
  forgetDirty(relPaths: Iterable<string>): Promise<SidecarState> {
    const next = this.chain.then(async () => {
      await this.load();
      let changed = false;
      for (const p of relPaths) {
        if (this.dirty.delete(p)) changed = true;
      }
      if (changed) await this.persistJournal();
      return this.snapshot();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  setLastPulledAt(iso: string): Promise<SidecarState> {
    return this.updateScalars((s) => {
      s.lastPulledAt = iso;
    });
  }

  // Records that the complete remote manifest was observed at `iso`. Only
  // callers that actually enumerated every path doc may call this — a scoped
  // or metadataOnly sync must not, since it saw only a slice.
  setLastReconciledAt(iso: string): Promise<SidecarState> {
    return this.updateScalars((s) => {
      // Monotonic: an older reconcile point never overwrites a newer one.
      if (s.lastReconciledAt === null || s.lastReconciledAt < iso) {
        s.lastReconciledAt = iso;
      }
    });
  }

  setLazyPullActive(active: boolean): Promise<SidecarState> {
    return this.updateScalars((s) => {
      s.lazyPullActive = active;
    });
  }

  // Releases the append handle. Tests and long-lived hosts should call this;
  // process exit closes it implicitly otherwise.
  close(): Promise<void> {
    return this.closeHandle();
  }
}
