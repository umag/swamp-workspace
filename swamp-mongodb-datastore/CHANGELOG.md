# Changelog

## 2026.09.03.1

Feature parity with `@swamp/s3-datastore`: the sync service now advertises
`namespacedSync`, `twoPhaseSync`, `controlPlane` and `configRefresh` on top of
`scopedSync` and `lazyHydration`. On this datastore `swamp serve` reports
deployment mode `durable` instead of `local`: heartbeats, active and pending
runs, cron fire records, reconcile claims and token secrets live in a new
`_control` collection (`putIfAbsent` = `insertOne` + duplicate-key), so runs
survive instance replacement and two instances never fire one schedule twice.

### Added

- **Control plane.** `controlPlaneStore()` over `t_<tenant>_r_<ns>_control`,
  keys stored as `<coreNamespace>/_control/<key>` (or `_control/<key>`).
  Namespace registration (`listNamespaces`, manifest-only `registerNamespace`).
- **Two-phase push.** `preparePush` uploads blobs outside swamp's global lock;
  `commitPush` re-reads the remote, merges path docs, tombstones, and releases
  only the dirty roots it consumed (a `markDirty` between the phases survives;
  `bulkInvalidated` clears only if the sidecar's new `bulkSeq` is unchanged).
- **`subdirs` pulls** for serve's config and access pollers, watermark-bounded
  and never advancing the watermark.
- **Journaled, revertable migrations** on the maintenance model:
  `fold_namespace_prefix` (retire legacy `<ns>/…` ids; guarded against a still-
  writing old client by a recent-writer window and per-client version stamps),
  `prefix_namespace` (its inverse for the post-fold delta),
  `import_control_records` (copy serve's filesystem `_control/` tree,
  hashes-only journal) and `revert_migration` (after-image conflict detection,
  `force` opt-in). `sweep` prunes the journal past the tombstone window.
- Verifier reports config vs core namespace and warns when the control plane
  travels over a plaintext non-loopback URI.

### Changed

- **Path layout.** Remote ids are tier-relative; core's `datastore.namespace`
  (`options.namespace`, with `config.namespace` as the fallback the previous
  release used) shapes only the local cache. Pull tolerates legacy `<ns>/` ids
  until folded: newer `updatedAt` wins, a legacy tombstone never outranks a bare
  doc, and the twin outside a watermark window is fetched before deciding.
  Migration and rollback runbooks are in the README.
- Every push stamps `_control/clients/<user@hostname>` with the extension
  version (the same identity the lock documents carry).

### From upstream keeb 2026.09.02.1

- One `MongoClient` shared per cluster + repo for the life of the process,
  cached at module scope (core builds a fresh provider per operation, so the old
  per-factory cache never hit and every operation opened a new pool);
  connections stamped with `appName` `swamp:<tenantId>/<namespace>#<pid>`; a
  failed connect is not cached. This fork keeps its `maxPoolSize` default of 500
  and its `serverSelectionTimeoutMS` option.

### Kept

The two fork guards from 2026.09.01.2 — `resolveWithinCache` on every
remote-supplied path and the namespaced tier root — are unchanged and still
pinned by their wiring tests.

## 2026.09.01.2

Merges upstream keeb 2026.08.19.2 into the `@magistr` fork, **keeping two fork
guards the upstream tree does not carry** and fixing a third defect found by
live testing.

### Fixed: the incremental push was inert (pre-existing, also on 2026.09.01.1)

Core calls `markDirty` and `hydrateFile` with a path that ALREADY carries the
namespace (`<ns>/data/...`), while `tierRoot` scopes only the LOCAL side — every
remote `_id`, the local walk and `isSecretsPath` speak tier-relative paths.
swamp-club#1554 records the same asymmetry for `@swamp/s3-datastore`'s
lazy-hydration hook.

One prefix broke three things: the dirty journal recorded paths no walk could
match, so ordinary writes NEVER reached the remote and only a full walk
persisted; `isSecretsPath`/`isExcludedPath` stopped matching, so the vault tier
was no longer filtered out of the journal; and `hydrateFile` looked up an `_id`
no remote doc carries.

`toTierRelative()` normalizes at both hooks, before the secrets check. It strips
only when the remainder begins with a real tier directory, so a tier-relative
path is never mangled. Measured live: a namespaced repo held 37 local files and
0 remote paths; after the fix, live paths went 70 -> 100 -> 144 over two runs.

### Two fork guards kept, NOT inherited from upstream

- **Path-traversal confinement.** Upstream composes
  `` `${cachePath}/${relPath}` `` by raw concatenation. One database is shared
  by every repo and tenant (isolation is only a collection prefix), so a remote
  `_id` is untrusted: a doc named `../../../../.ssh/authorized_keys` would be
  written through — or unlinked when carrying `deletedAt`.
  `resolveWithinCache`/`isSafeRelPath` restored and re-applied to all five
  merged write sites.
- **Namespace tier-root scoping.** Upstream roots reads/writes at the bare cache
  path. Core reads the tier one segment deeper, so that builds a second,
  invisible tier the reader never sees; push then refuses with "un-migrated data
  found at root level" and `namespace migrate` cannot recover
  (swamp-club#1458/#1554). Worse, `pushChanged` tombstones every remote path
  absent from its local walk — rooted wrongly, that walk finds nothing and one
  push tombstones the whole namespace. `tierRoot()` restored in `config.ts` and
  applied in `createSyncService`.

Both carry a comment naming them as fork guards so a later merge cannot quietly
drop them again.

### From upstream

Dirty tracking rides an append-only journal with ancestor coalescing (O(1)
`markDirty`); push reconciles dirty roots in batches rather than one round-trip
each. `Sidecar` becomes an interned `getSidecar()` plus `reconcileWatermark`.
Blob docs gain `createdAt` for the orphan sweep's grace window. Adds
`@magistr/mongodb-datastore/maintenance` and the `datastore-maintenance`
workflow — inventory, sweep orphaned blobs and aged tombstones, compact — over
every namespace in one execution. `manifest.yaml` gains `models:`/`workflows:`;
`quality.yaml`'s `methods` suite moves `na` -> `present`.

### Tests

89 across seven suites. Master's four newer suites are KEPT, not replaced by
upstream's — the branch predates them and would have deleted them. New tests pin
the guards' WIRING, not just their helpers: every prior test exercised
`tierRoot()` and `resolveWithinCache()` as functions, which is exactly how the
upstream merge regressed both while all 17 stayed green. Each new test is
mutation-verified.

## 2026.09.01.1

Re-release of 2026.08.31.1, whose publish never reached the registry — the
`extension-publish` job only fires on a version bump, so a version that fails to
publish stays stranded until the next one. Content is unchanged from
2026.08.31.1; its notes are carried forward below so the registry keeps a full
record.

### Fixed

- **Sync tier is now rooted at the namespaced cache path.** Swamp core hands
  `createSyncService` the bare cache path (the repoId-keyed default, since
  `resolveCachePath` returns `undefined` as it does for every remote datastore)
  but reads and writes the tier through
  `DefaultDatastorePathResolver.datastorePath()`, which prepends the namespace
  as the outermost segment — `{cache}/{namespace}/data/...`. The sync service
  walked and wrote the bare path, so every `sync --pull` built a second,
  invisible copy of the whole tier at the cache root. Artifacts stayed queryable
  through the catalog while `swamp data get` reported "Data not found";
  `sync --push` then refused with "un-migrated data found at root level", and
  `datastore namespace migrate` cannot recover once both layouts exist.

  Same defect fixed in `@swamp/s3-datastore` for swamp-club#1458 and #1554. S3
  was less exposed because its remote keys embed the namespace, so the segment
  round-trips; this extension partitions by collection prefix
  (`t_<tenant>_r_<ns>_*`) with tier-relative `_id`s, so nothing reintroduced it.

  `tierRoot()` scopes the **local** side only — remote `_id`s stay
  tier-relative, so existing MongoDB collections need no migration. The sidecar
  moves alongside the tier it describes; a cold-start sidecar has
  `lastPulledAt: null`, which already suppresses the reconciliation tombstone
  pass in `fullWalkPush`, so the first push after upgrading uploads without
  deleting. An empty namespace returns the bare cache path, byte-identical to a
  non-namespaced repo.

  Upgrading does **not** repair a cache that is already split. Merge the root
  tier into `{cache}/{namespace}/` (`rsync -a --ignore-existing`, version
  directories are immutable so a merge is safe), remove the root tier
  directories, then push.

- **Pull no longer writes or deletes outside the cache root.** `pullChanged`
  took its local target straight from a remote path doc's `_id` and interpolated
  it into `${cachePath}/${_id}` for the write, the hash pre-check, and the
  `deletedAt` unlink — with no containment check. One MongoDB database holds
  every repo's tier and isolation is only a collection prefix, so an `_id` is
  untrusted input: a doc named `../../../../.ssh/authorized_keys` was written
  through, and with `deletedAt` set, unlinked, anywhere the process could reach.
  `resolveWithinCache()` now rejects absolute paths, `.`/`..` segments, empty
  segments, backslashes and NUL at every join. Unsafe docs are skipped at
  admission (with a warning) rather than thrown on, so one planted document
  cannot wedge every future pull.

- **`deno task test` now grants the permissions its own suite needs.** The task
  was bare `deno test`, so all 17 sidecar tests failed with
  `NotCapable: Requires write access to <TMP>` — the suite could never pass in
  CI. Now runs with `--allow-read --allow-write --allow-env`.

### Added

- `config_test.ts` covering `tierRoot`: namespaced paths, solo mode (empty
  namespace), whitespace-only namespace, trailing-slash normalisation,
  composition with a tier-relative path, and that the namespace used for
  collection prefixing is never mutated.
- `sync_adversarial_test.ts` — path traversal, absolute paths, backslash/NUL
  injection, secrets-tier boundaries, and regex-state reuse.
- `sync_coverage_test.ts` — regression cover for the load-bearing guards: the
  `lastPulledAt !== null && !lazyPullActive` gate that keeps a cold-start push
  from tombstoning the datastore, and the tier-root/sidecar scoping.
- `sync_property_test.ts` — fast-check properties (gated by `FC_NUM_RUNS`) for
  tier placement and the containment invariant: an accepted path can never
  resolve outside the cache root, for arbitrary remote input.
- `quality.yaml`, and this changelog.

## 2026.08.31.1

### Fixed

- **Sync tier is now rooted at the namespaced cache path.** Swamp core hands
  `createSyncService` the bare cache path (the repoId-keyed default, since
  `resolveCachePath` returns `undefined` as it does for every remote datastore)
  but reads and writes the tier through
  `DefaultDatastorePathResolver.datastorePath()`, which prepends the namespace
  as the outermost segment — `{cache}/{namespace}/data/...`. The sync service
  walked and wrote the bare path, so every `sync --pull` built a second,
  invisible copy of the whole tier at the cache root. Artifacts stayed queryable
  through the catalog while `swamp data get` reported "Data not found";
  `sync --push` then refused with "un-migrated data found at root level", and
  `datastore namespace migrate` cannot recover once both layouts exist.

  Same defect fixed in `@swamp/s3-datastore` for swamp-club#1458 and #1554. S3
  was less exposed because its remote keys embed the namespace, so the segment
  round-trips; this extension partitions by collection prefix
  (`t_<tenant>_r_<ns>_*`) with tier-relative `_id`s, so nothing reintroduced it.

  `tierRoot()` scopes the **local** side only — remote `_id`s stay
  tier-relative, so existing MongoDB collections need no migration. The sidecar
  moves alongside the tier it describes; a cold-start sidecar has
  `lastPulledAt: null`, which already suppresses the reconciliation tombstone
  pass in `fullWalkPush`, so the first push after upgrading uploads without
  deleting. An empty namespace returns the bare cache path, byte-identical to a
  non-namespaced repo.

  Upgrading does **not** repair a cache that is already split. Merge the root
  tier into `{cache}/{namespace}/` (`rsync -a --ignore-existing`, version
  directories are immutable so a merge is safe), remove the root tier
  directories, then push.

- **Pull no longer writes or deletes outside the cache root.** `pullChanged`
  took its local target straight from a remote path doc's `_id` and interpolated
  it into `${cachePath}/${_id}` for the write, the hash pre-check, and the
  `deletedAt` unlink — with no containment check. One MongoDB database holds
  every repo's tier and isolation is only a collection prefix, so an `_id` is
  untrusted input: a doc named `../../../../.ssh/authorized_keys` was written
  through, and with `deletedAt` set, unlinked, anywhere the process could reach.
  `resolveWithinCache()` now rejects absolute paths, `.`/`..` segments, empty
  segments, backslashes and NUL at every join. Unsafe docs are skipped at
  admission (with a warning) rather than thrown on, so one planted document
  cannot wedge every future pull.

- **`deno task test` now grants the permissions its own suite needs.** The task
  was bare `deno test`, so all 17 sidecar tests failed with
  `NotCapable: Requires write access to <TMP>` — the suite could never pass in
  CI. Now runs with `--allow-read --allow-write --allow-env`.

### Added

- `config_test.ts` covering `tierRoot`: namespaced paths, solo mode (empty
  namespace), whitespace-only namespace, trailing-slash normalisation,
  composition with a tier-relative path, and that the namespace used for
  collection prefixing is never mutated.
- `sync_adversarial_test.ts` — path traversal, absolute paths, backslash/NUL
  injection, secrets-tier boundaries, and regex-state reuse.
- `sync_coverage_test.ts` — regression cover for the load-bearing guards: the
  `lastPulledAt !== null && !lazyPullActive` gate that keeps a cold-start push
  from tombstoning the datastore, and the tier-root/sidecar scoping.
- `sync_property_test.ts` — fast-check properties (gated by `FC_NUM_RUNS`) for
  tier placement and the containment invariant: an accepted path can never
  resolve outside the cache root, for arbitrary remote input.
- `quality.yaml`, and this changelog.

## 2026.08.19.1

Initial `@magistr` release — fork of `@keeb/mongodb-datastore` rebranded to the
`@magistr` collective, with the upstream connection-pool bounds (`maxPoolSize` /
`maxIdleTimeMS` / `serverSelectionTimeoutMS`) and graceful shutdown merged in.
