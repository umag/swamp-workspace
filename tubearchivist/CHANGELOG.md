# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2a of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `tubearchivist.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/tubearchivist_methods_test.ts` (methods),
  `tubearchivist_test.ts` (contract-fixture),
  `tubearchivist_adversarial_test.ts` (adversarial),
  `tubearchivist_coverage_test.ts` (coverage), `tubearchivist_property_test.ts`
  (property-invariant-flow) — 0 tests before this change, 127 tests after.
- Added `fixtures/` — pure doc-derived, synthetic TubeArchivist API wire-shape
  fixtures (`video-list`, `video-detail`, `channel-list`, `queue-list`,
  `search`, `stats`, `backup-list`, `snapshot-list`, `ping`, `task`) plus
  `PROVENANCE.md`. No live call was made against any TubeArchivist instance;
  every value is synthetic (`tubearchivist.example.com`, synthetic 11-char
  youtube_ids, `UC`-prefixed synthetic channel ids).
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (tubearchivist
  bundles no Claude skill); `ratchet` measured and recorded. Removed from
  `quality-allowlist.txt` in the same change.
- Two byte-frozen residual gaps were surfaced by the security/adversarial review
  and are deliberately NOT fixed here (source is byte-frozen for this test-only
  backfill) — tracked as a follow-up hardening issue
  (`tubearchivist-hardening`):
  1. The `token` global argument is not marked `.meta({ sensitive: true })`, so
     swamp CLI/log surfaces could render it in cleartext. The coverage suite
     pins the current unmarked state so the future fix flips the assertion red
     -> green.
  2. The shared `api()` fetch helper has no `AbortSignal.timeout` and no
     `Retry-After`/429 backoff. Not offline-testable, so it is documented here
     rather than pinned as a test.

## 2026.07.16.2

Initial release: list/get/delete videos, list channels and subscribe, manage the
download queue (add/list/start), rescan/refresh/update-subscribed maintenance
tasks, search across all indexes, mark videos watched/unwatched, read library
statistics, and backup/snapshot management (create + list) for a self-hosted
TubeArchivist instance.
