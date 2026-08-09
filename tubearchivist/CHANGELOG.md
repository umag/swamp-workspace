# Changelog

## 2026.08.08.1

Two bug fixes, both found by using the model against a live TubeArchivist
instance rather than by reading it.

- **`search` was broken for every query.** It built `?q=<query>`, but
  TubeArchivist's `/api/search/` reads `query`. Every call came back
  `400 {"message":"no search query specified"}` — the method has never worked.
  Now sends `?query=`.
- **The `token` global argument was not declared sensitive.** swamp reads the
  `sensitive` marker off the schema to decide what to mask, so an unmarked
  credential is written verbatim into `@swamp/method-summary` report data — both
  the rendered markdown and the JSON payload — on every method run, including
  failures, and that data is persisted. This was a known gap: the wave-2a
  security review found it and pinned it in `tubearchivist_coverage_test.ts` as
  a documented HIGH finding to be fixed in follow-up, because `tubearchivist.ts`
  was byte-frozen at the time. It was not theoretical — a real API token was
  later found in cleartext in a stored failure report. Now carries
  `.meta({ sensitive: true })` and redacts to `***`.

Both fixes were driven test-first; all three new assertions failed against the
unfixed model before the change.

Note for anyone who ran this model before upgrading: the sensitivity fix only
stops _future_ leaks. Tokens already written into stored report data are still
there in cleartext — rotate the token.

Tests: 126 → 128 pass.

- `tubearchivist_methods_test.ts` — the happy-path search test asserted
  `searchParams.get("q")`, i.e. it had characterized the bug as correct
  behavior. Retargeted to `query`, plus a new regression test that also asserts
  `q` is _absent_, so a future "send both to be safe" edit is caught.
- `tubearchivist_coverage_test.ts` — the `token is NOT marked sensitive` pin is
  flipped to assert the annotation is present, exactly as that pin's own failure
  message instructed. Also pins the negative (`host` stays unredacted) so a
  blanket "mark everything sensitive" change doesn't pass.
- `tubearchivist_adversarial_test.ts` — the unicode round-trip test also read
  `q`; retargeted to `query`. Percent-encoding assertion unchanged.

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
