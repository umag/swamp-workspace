# mongodb-swamp-datastore

Custom swamp `DatastoreProvider` backed by MongoDB. Replaces the coarse
per-model file lock of the filesystem/S3 backends with finer-grained,
event-driven coordination. Built for a **mega swamp** — one shared `.swamp` that
many users and agents read/write concurrently.

## MongoDB primitives in use

- Swamp data is already document-shaped (`attributes`, outputs, run history).
- `findAndModify` gives clean optimistic locking per model document — replaces
  the filesystem lock primitive.

## What to read first

1. **The `swamp-extension-datastore` skill** — authoritative guide for this
   project, with references for api / examples / testing / troubleshooting.
2. **The interface we implement:** `src/domain/datastore/datastore_provider.ts`
   in the swamp source tree — `DatastoreProvider` with `createLock` ,
   `createVerifier` , `createSyncService?` , `resolveDatastorePath` ,
   `resolveCachePath?` .
3. **Supporting types:**
   - `src/domain/datastore/distributed_lock.ts` — `DistributedLock` ,
     `LockOptions`
   - `src/domain/datastore/datastore_health.ts` — `DatastoreVerifier`
   - `src/domain/datastore/datastore_sync_service.ts` — `DatastoreSyncService`
   - `src/domain/datastore/datastore_type_registry.ts`
4. **Built-in filesystem datastore** — canonical reference to mirror:
   - Lock: `src/libswamp/datastores/lock.ts`
   - Setup: `src/libswamp/datastores/setup.ts`
   - Status: `src/libswamp/datastores/status.ts`
   - Sync: `src/libswamp/datastores/sync.ts`
   - Verifier: `src/infrastructure/persistence/filesystem_datastore_verifier.ts`
5. **How swamp registers datastore types:**
   `src/domain/datastore/datastore_types.ts` and `datastore_config.ts` — types
   other than `"filesystem"` are user-defined and loaded via
   `user_datastore_loader.ts` .

All paths above are within the swamp source repo ( `github.com/systeminit/swamp`
); read them against the version of swamp whose `DatastoreProvider` interface
you're targeting.

## Project conventions

- **Extension namespace:** `@magistr/mongodb-datastore`. The `type` string in
  the extension export is what consumer `.swamp.yaml` files reference.
- **Extension layout:** `extensions/datastores/mongodb/`
  - `mod.ts` — provider entry point (wires the five interface methods)
  - `client.ts` — `MongoClient` factory, cached per `repoDir`
  - `config.ts` — Zod `ConfigSchema`, collection naming, `.env` loader
  - `lock.ts` — TTL lock with heartbeat + nonce fencing
  - `sync.ts` — manifest + content-addressed blob sync of the datastore tier
  - `sidecar.ts` — scalar sync state + the append-only dirty journal
  - `verifier.ts` — replica-set health check

  `extensions/models/` holds the companion **model** type
  (`@magistr/mongodb-datastore/maintenance`): `sweeps.ts` has the reclamation
  functions, `maintenance.ts` exposes them as `inventory` / `sweep` / `compact`,
  and `workflows/datastore-maintenance/workflow.yaml` chains them. A
  `DatastoreProvider` exposes nothing a workflow can call, so without this,
  maintenance could only ever be a script bolted on beside swamp — which is
  exactly what SWAMP.md rules 9 and 10 say not to do.

  `sweeps.ts` lives under `models/`, not `datastores/mongodb/`, because
  packaging ships only each declared entry point's transitive import graph. The
  datastore entry is `mod.ts`, which never imports the sweeps, so a
  cross-directory import resolved locally and then broke in the tarball — caught
  by `swamp extension quality`, not by `deno check`.

  Root `manifest.yaml` is the publishable package manifest.
- **Secrets:** the mongo password comes from `$MONGO_PASSWORD` (env var name
  overridable via `passwordEnv` in `ConfigSchema`), loaded by `loadDotEnv()`
  from `<repoDir>/.env` at client-factory time.
- **npm deps are bundled, not lockfile-tracked** (per SWAMP.md rule 7). Pin
  every `npm:` import with an explicit version (e.g. `npm:mongodb@6.17.0` ).

## Architecture decisions

1. **Lock scope.** Global + per-model keys, each keyed on a Mongo doc `_id`.
   `findOneAndUpdate` with `{expiresAt: $lte: now}` gives atomic take-over of
   expired locks. A nonce protects `release` and `forceRelease` from acting on a
   lock that was already reaped.
2. **Sync service.** Swamp core writes a local cache tree under the datastore
   tier. `sync.ts` mirrors that tree to two collections: `_paths` (one manifest
   doc per file: `{_id: relPath, hash, size, updatedAt, deletedAt}`) and
   `_blobs` (content-addressed bytes keyed by sha256). Pulls walk the `_paths`
   cursor since the last watermark and bulk-`$in` over `_blobs` for only the
   hashes the host doesn't already have. The cursor itself is the wire transport
   — no per-file roundtrips.
3. **Actor metadata.** No interface hook for "who." `$USER@$HOSTNAME` (plus pid)
   gets stamped onto every lock doc from the environment.
4. **Bytes vs. metadata split.** Manifest in `_paths`, bytes in `_blobs`, keyed
   by content hash. Identical bytes pushed by N agents collapse to a single blob
   server-side. Blobs ride inline as `Binary` (under MongoDB's 16MB BSON limit).
   No GridFS — the per-file `find`/chunk-read overhead it imposes is what made
   the previous protocol RTT-bound on tiny-file workloads.
5. **Dirty tracking is a journal, not a document.** `markDirty` appends a line
   to `.datastore-dirty.log`; only scalars live in `.datastore-sync-state.json`.
   Keeping `dirtyPaths` inside the JSON made every `markDirty` a
   read-modify-write plus a linear `includes` scan — on a repo that had
   accumulated ~86k dirty paths, 13.6 MB of I/O and ~86k string compares per
   dirtied file, under the global lock. On push the journal is coalesced so a
   dirty directory absorbs everything beneath it, and past `MAX_DIRTY_PATHS` it
   degrades to one full walk.
6. **Two watermarks.** `lastPulledAt` = content hydrated to here (drives pull).
   `lastReconciledAt` = complete remote path list observed to here (drives the
   push tombstone pass). Conflating them means a host can never propagate
   deletion of data it pushed itself, because its own push stamps
   `updatedAt = now`, and the tombstone pass skips anything newer than the
   watermark in order to protect a peer's concurrent writes.
7. **`_blobs` is append-only; reclamation is out of band.** Dedup means a push
   can't tell whether another path still references a hash, so it must never
   delete. The `sweep` method reclaims unreferenced blobs, guarded by a
   `createdAt` grace window — NOT by the global lock, which is only
   defense-in-depth: a real sweep holding it still lost a blob to a concurrent
   push, so swamp core does not funnel every write through it.
8. **Tombstones are load-bearing and must age out, not vanish.** They carry
   deletions to peers, so `_paths` grows without bound (855k tombstones vs 21k
   live on one repo). `sweepTombstones` hard-deletes only those past a long
   grace window (default 30d) — pruning a tombstone a peer hasn't seen makes the
   deletion invisible and lets that peer resurrect the file.
9. **Deleting documents does not free disk.** WiredTiger keeps the space on a
   free list; `compact` (with `force: true` on a primary) is what returns it to
   the filesystem.

## Verification

Run before committing:

1. `deno check` — type check
2. `deno lint`
3. `deno fmt`
4. `deno test` — unit tests
5. Integration: swamp CLI against a real replica-set Mongo and at least one
   consumer repo.

## Do not

- Do not commit connection strings or credentials. Config must come from the
  extension's Zod schema plus a gitignored `.env` — not hardcoded constants, not
  committed `.swamp.yaml` values.
- Do not bypass the `DatastoreProvider` interface with side-channel
  reads/writes. Everything must flow through the provider so swamp core owns the
  lifecycle.

Swamp-specific guidance for this repo (rules, skills, getting started) lives in
[SWAMP.md](SWAMP.md).
