# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2b full-build
child of the extension-quality backfill program, `ext-quality-test-backfill`).
No behavior change — `musicbrainz.ts` is unmodified and the model `version`
stays `2026.07.16.2`.

- Added `extensions/models/musicbrainz_test.ts` (contract-fixture),
  `musicbrainz_methods_test.ts` (methods), `musicbrainz_adversarial_test.ts`
  (adversarial), `musicbrainz_coverage_test.ts` (coverage),
  `musicbrainz_property_test.ts` (property-invariant-flow) — 0 tests before this
  change, 114 after.
- Added `fixtures/` — pure doc-derived, synthetic MusicBrainz WS v2 JSON wire
  fixtures (artist/release-group/release/recording/label search, artist and
  release-group lookup, browse-release-groups, browse-releases, generic search,
  a 404 and a 503 error body) plus five synthetic Bandcamp HTML fixtures under
  `fixtures/bandcamp/` (`.ts` string-export modules, not `.html`, to keep the
  default test task free of `--allow-read`), plus `PROVENANCE.md`. No live call
  was made against any MusicBrainz instance or real Bandcamp page while
  authoring these fixtures; every value is synthetic (fake MBIDs
  `00000000-...-00000000000N`, invented "Fixture"-prefixed names, synthetic
  Bandcamp subdomains).
- The extension's built-in 1 req/sec MusicBrainz rate limiter is both
  neutralized AND explicitly characterized under `@std/testing` FakeTime (first
  call incurs no wait; a second call soon after schedules a wait of at least
  1100ms; spacing collapses toward zero as elapsed time grows) — see the three
  dedicated `RATE LIMITER:` tests in `musicbrainz_methods_test.ts`.
- Several already-shipped gaps are PINNED (characterized as current behavior,
  not fixed — `musicbrainz.ts` is byte-frozen by this change) and tracked
  separately for follow-up under `musicbrainz-ssrf-and-latent-bugs`: raw MBID
  path interpolation (path traversal / query injection via unencoded `../`, `/`,
  `?`, `#` in lookup ids), `fetchPage`'s SSRF-shaped lack of any host allowlist
  on the Bandcamp scraper, the `TralbumData` `//`-comment-strip corrupting an
  embedded `https://` URL, unbounded `while (true)` release-group pagination in
  `find-missing`/ `seed-all-missing`, `normalizeTitle`'s ASCII-only stripping
  (over-collapse on punctuation AND non-ASCII/unicode titles), an ISO-8601
  track-duration display string that silently drops the hours component (the
  underlying `durationMs` value is unaffected), and the absence of `AbortSignal`
  timeouts, `Retry-After` handling, or response schema validation on either
  fetch site.
- Accepted residual: array-wrapped JSON-LD (`[{...}]`) is pinned for both the
  Bandcamp album and artist-page parsers, but the `@graph`-wrapped variant
  (`{"@graph":[{...}]}` — another valid schema.org form) is NOT pinned in this
  change. Noted here rather than silently dropped; a future backfill round can
  add it without any source change (still byte-frozen, still a pin).
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak (`FC_NUM_RUNS=10000`, scoped to `musicbrainz_property_test.ts`).
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependencies
  (`jsr:@std/assert@1`, `jsr:@std/testing@1` and its `jsr:@std/async`/
  `jsr:@std/data-structures` transitive deps, `npm:fast-check@4.8.0`). Source
  dependencies (`npm:zod@4`, `npm:linkedom@0.16.11`) are unchanged — the lock
  delta carries no runtime/behavior implication whatsoever, only new test-time
  resolution entries.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (musicbrainz
  bundles no Claude skill). `ratchet` set from the measured
  `swamp extension quality manifest.yaml --json` score (100%, rubricVersion 3,
  "Grade A"). Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: search/lookup/browse over artists, release groups, releases,
recordings, and labels via the MusicBrainz Web Service v2 (JSON), with a
built-in 1 request/second rate limiter, plus Bandcamp-to-MusicBrainz helpers
that scrape a Bandcamp discography and generate release-editor seed URLs for
releases missing from MusicBrainz.
