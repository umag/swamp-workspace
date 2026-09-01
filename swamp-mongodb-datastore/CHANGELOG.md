# Changelog

## 2026.09.01.2

Merges upstream `keeb/swamp-mongodb-datastore` 2026.08.19.2 into the `@magistr`
fork, bringing journal-based dirty tracking and a maintenance model/workflow —
while **keeping both fork-only guards the upstream tree does not carry**.

### Journal-based dirty tracking (from upstream)

Dirty tracking now rides an append-only journal with ancestor coalescing, so
`markDirty` is O(1) rather than a read-modify-write of the whole sidecar. Push
reconciles dirty roots in batches (`ROOT_QUERY_BATCH` = 100 roots per manifest
query, `PUSH_ROOT_SLICE` = 500 reconciled before a journal slice retires)
instead of one round-trip each. `Sidecar` as a class is replaced by an interned
`getSidecar(cachePath)` plus `reconcileWatermark`, so two sync services over one
cache serialize with each other.

Blob docs gain `createdAt`, used solely for the orphan sweep's grace window: a
blob is written before the path doc that references it, so a sweep must not
judge a freshly-inserted blob unreachable. Docs written before 2026.08.19.1 lack
the field and are treated as old.

### Maintenance model and workflow (from upstream)

Adds `@magistr/mongodb-datastore-maintenance`
(`extensions/models/maintenance.ts` plus `sweeps.ts`) and the
`datastore-maintenance` workflow: inventory, sweep orphaned blobs and aged
tombstones, and compact reclaimed space — fanning out over every namespace in
one execution rather than one run per namespace.

The manifest gains `models:` and `workflows:` keys accordingly, and
`quality.yaml`'s `methods` suite moves from `na` to `present`: the package now
genuinely ships a model, so the justification that it declares none no longer
holds.

### Two fork-only guards kept, NOT inherited from upstream

The upstream merge dropped both. Taking it verbatim would have been a silent
regression in each, so both were re-applied on top of the merged code:

- **Path-traversal confinement.** Upstream composes local targets as
  `` `${cachePath}/${relPath}` `` by raw concatenation. One MongoDB database is
  shared by every repo and tenant — isolation is only a collection prefix — so a
  remote `_id` is untrusted input, and a doc named
  `../../../../.ssh/authorized_keys` would be written through, or unlinked when
  carrying `deletedAt`, anywhere the process can reach. `resolveWithinCache` /
  `isSafeRelPath` are restored and re-applied to all five merged write sites
  (delete, read-back, write, and both `absPath` joins).
- **Namespace tier-root scoping.** Upstream roots every read and write at the
  bare cache path. Core hands `createSyncService` the bare, un-namespaced path
  but reads and writes the tier one segment deeper, so rooting at the bare path
  builds a second, invisible copy of the tier at the cache root that the reader
  never sees — `sync --push` then refuses with "un-migrated data found at root
  level" and `datastore namespace migrate` cannot recover once both layouts
  exist (swamp-club#1458 and #1554 are the same defect in
  `@swamp/s3-datastore`). `tierRoot()` is restored in `config.ts` and applied in
  `createSyncService`; the sidecar and journal are interned on the tier root,
  not the bare path, so they sit beside the tier they describe.

Both restorations carry a comment naming them as fork guards, so a future
upstream merge does not quietly drop them again.

### Namespace normalization on core's per-file hooks — the incremental push had been inert

Live testing on an isolated namespace turned up a defect present in BOTH this
merge and the pre-merge fork: after bootstrap, ordinary writes never reached the
remote. A namespaced repo sat with 37 local files and 0 remote paths, and
`sync --push` reported `Pushed 0 files`; only a forced full walk persisted
anything.

The cause, measured directly: core calls `markDirty` (and `hydrateFile`) with a
path that ALREADY carries the namespace —
`dsmerge-probe/definitions-evaluated/
command/shell/probe2.yaml` — while
`tierRoot` scopes only the LOCAL side, so remote `_id`s, the local walk and
`isSecretsPath` all speak tier-relative paths. swamp-club#1554 records the same
asymmetry for `@swamp/s3-datastore`'s lazy-hydration hook, which is why that one
"lands correctly via the bare fallback" while the bulk path does not.

Unnormalized, one prefix broke three things:

- the dirty journal recorded paths no local walk could match, so the incremental
  push found nothing and only a full walk ever persisted;
- `isSecretsPath` / `isExcludedPath` stopped matching, so the vault tier and
  host-local files were no longer filtered out of the journal;
- `hydrateFile` looked up an `_id` no remote doc carries, and would have written
  to `<tier>/<namespace>/...` had one matched.

`toTierRelative()` now normalizes at both hooks, before the secrets check rather
than after it. It strips only when the remainder begins with a real tier
directory, so a genuinely tier-relative path is never mangled.

Verified live: with the fix, ordinary method runs push incrementally again —
live paths 70 -> 100 -> 144 across two runs, where before they stayed at 0.

### Tests

84 passing across seven suites. The four suites master added after this merge
branch was cut — `config_test.ts`, `sync_adversarial_test.ts`,
`sync_coverage_test.ts`, `sync_property_test.ts` — are **kept**, not replaced by
the upstream tree's: the branch predates them and would have deleted them. They
are what proves the two restored guards still hold against the merged code.

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
