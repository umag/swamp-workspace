# Changelog

## 2026.08.31.1

### Fixed

- **Sync tier is now rooted at the namespaced cache path.** Swamp core hands
  `createSyncService` the bare cache path (the repoId-keyed default, since
  `resolveCachePath` returns `undefined` as it does for every remote datastore)
  but reads and writes the tier through
  `DefaultDatastorePathResolver.datastorePath()`, which prepends the namespace as
  the outermost segment — `{cache}/{namespace}/data/...`. The sync service walked
  and wrote the bare path, so every `sync --pull` built a second, invisible copy
  of the whole tier at the cache root. Artifacts stayed queryable through the
  catalog while `swamp data get` reported "Data not found"; `sync --push` then
  refused with "un-migrated data found at root level", and
  `datastore namespace migrate` cannot recover once both layouts exist.

  Same defect fixed in `@swamp/s3-datastore` for swamp-club#1458 and #1554. S3
  was less exposed because its remote keys embed the namespace, so the segment
  round-trips; this extension partitions by collection prefix
  (`t_<tenant>_r_<ns>_*`) with tier-relative `_id`s, so nothing reintroduced it.

  `tierRoot()` scopes the **local** side only — remote `_id`s stay tier-relative,
  so existing MongoDB collections need no migration. The sidecar moves alongside
  the tier it describes; a cold-start sidecar has `lastPulledAt: null`, which
  already suppresses the reconciliation tombstone pass in `fullWalkPush`, so the
  first push after upgrading uploads without deleting. An empty namespace returns
  the bare cache path, byte-identical to a non-namespaced repo.

  Upgrading does **not** repair a cache that is already split. Merge the root
  tier into `{cache}/{namespace}/` (`rsync -a --ignore-existing`, version
  directories are immutable so a merge is safe), remove the root tier
  directories, then push.

- **`deno task test` now grants the permissions its own suite needs.** The task
  was bare `deno test`, so all 17 sidecar tests failed with
  `NotCapable: Requires write access to <TMP>` — the suite could never pass in
  CI. Now runs with `--allow-read --allow-write --allow-env`.

### Added

- `config_test.ts` covering `tierRoot`: namespaced paths, solo mode (empty
  namespace), whitespace-only namespace, trailing-slash normalisation,
  composition with a tier-relative path, and that the namespace used for
  collection prefixing is never mutated.
- `quality.yaml`, and this changelog.

## 2026.08.19.1

Initial `@magistr` release — fork of `@keeb/mongodb-datastore` rebranded to the
`@magistr` collective, with the upstream connection-pool bounds
(`maxPoolSize` / `maxIdleTimeMS` / `serverSelectionTimeoutMS`) and graceful
shutdown merged in.
