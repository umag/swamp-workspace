# Changelog

## 2026.07.31.1

Everything below was accumulated as `Unreleased` until now. This release bundles
two pieces of work: the wave-2b test backfill to the STANDARD.md five-suite
quality bar (`ext-quality-test-backfill`), and the
`musicbrainz-ssrf-and-latent-bugs` security fix for the SSRF in the Bandcamp
scraper's `fetchPage()`. `model.version` and `manifest.yaml` move `2026.07.16.2`
-> `2026.07.31.1` to reflect the actual source change (the test backfill alone
was behavior-preserving and had not needed a bump).

### Security fix: SSRF via `bandcampUrl` (HIGH)

Closes the HIGH-severity SSRF in `fetchPage()`, which previously fetched any
caller-supplied or scraped URL with no scheme or host allowlist, allowing an
internal/loopback/metadata-service target passed as `bandcampUrl` (or a
second-order `albumUrl` scraped from a discography page) to be fetched verbatim
and its parsed content returned to the caller.

- Added a module-private `assertBandcampUrl(raw)` guard: requires
  `protocol === "https:"` and `hostname === "bandcamp.com"` or
  `hostname.endsWith(".bandcamp.com")` (dot-anchored, so
  `evil.bandcamp.com.attacker.com` and `notbandcamp.com` are both rejected);
  throws a clear `Invalid Bandcamp URL` /
  `Refusing to fetch non-Bandcamp
  host` error otherwise, never a raw parser
  exception.
- `fetchPage()` now calls the guard before the initial request AND fetches with
  `redirect: "manual"`, re-validating every `Location` header against the same
  guard before following it (bounded to 5 hops) — this closes the redirect-based
  bypass where a legitimate `*.bandcamp.com` URL 302s to an internal address,
  which a default auto-following `fetch()` would otherwise chase transparently.
- The guard is centralized in `fetchPage`, so all five existing call sites
  (`seed-from-bandcamp`'s `bandcampUrl`; `find-missing` and `seed-all-missing`'s
  `bcUrl` and second-order `albumUrl`) inherit the fix with no call-site
  changes. A second-order `albumUrl` that fails the guard still falls into the
  existing `catch` and gets embedded as an inert seed-URL string parameter — no
  fetch occurs there, so it is not an SSRF vector.
- **Behavior tradeoff**: custom-domain (CNAME-to-Bandcamp) sites are now
  rejected by the host allowlist, since only `bandcamp.com` and `*.bandcamp.com`
  are recognized. Accepted given the security priority and the overwhelmingly
  common `*.bandcamp.com` case.
- No `AbortSignal` timeout was added (tracked separately as a deferred MED under
  `musicbrainz-ssrf-and-latent-bugs`, along with the other latent bugs noted
  below) — this change is scoped to the SSRF fix only.
- `musicbrainz_adversarial_test.ts`: flipped the two SSRF characterization pins
  from asserting the vulnerable behavior to asserting the fix (`assertRejects` +
  zero fetch calls), and added positive coverage: a legit `*.bandcamp.com` fetch
  is unaffected; a bandcamp-to-bandcamp redirect is followed; a
  bandcamp-to-internal-address redirect is rejected on the redirect hop;
  `file://` and `http://` (non-https) inputs are rejected on scheme; and the
  dot-anchored hostname allowlist rejects spoofed hosts while still allowing
  bare `bandcamp.com`. All other tests are unchanged — 119 tests total, all
  green.

### Test backfill (wave-2b, `ext-quality-test-backfill`)

- Added `extensions/models/musicbrainz_test.ts` (contract-fixture),
  `musicbrainz_methods_test.ts` (methods), `musicbrainz_adversarial_test.ts`
  (adversarial), `musicbrainz_coverage_test.ts` (coverage),
  `musicbrainz_property_test.ts` (property-invariant-flow) — 0 tests before this
  backfill, 114 after (119 after the SSRF fix above).
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
- Several already-shipped gaps were PINNED by the backfill (characterized as
  current behavior, not fixed) and tracked separately for follow-up under
  `musicbrainz-ssrf-and-latent-bugs`: raw MBID path interpolation (path
  traversal / query injection via unencoded `../`, `/`, `?`, `#` in lookup ids),
  the `TralbumData` `//`-comment-strip corrupting an embedded `https://` URL,
  unbounded `while (true)` release-group pagination in
  `find-missing`/`seed-all-missing`, `normalizeTitle`'s ASCII-only stripping
  (over-collapse on punctuation AND non-ASCII/unicode titles), an ISO-8601
  track-duration display string that silently drops the hours component (the
  underlying `durationMs` value is unaffected), and the absence of `AbortSignal`
  timeouts, `Retry-After` handling, or response schema validation on either
  fetch site. `fetchPage`'s SSRF-shaped lack of any host allowlist — also pinned
  by this same backfill — is the one gap this release actually fixes; see the
  security fix above. The rest remain open, tracked pins.
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
- `model.version` (`musicbrainz.ts`) and `manifest.yaml` bumped in sync,
  `2026.07.16.2` -> `2026.07.31.1`.

## 2026.07.16.2

Initial release: search/lookup/browse over artists, release groups, releases,
recordings, and labels via the MusicBrainz Web Service v2 (JSON), with a
built-in 1 request/second rate limiter, plus Bandcamp-to-MusicBrainz helpers
that scrape a Bandcamp discography and generate release-editor seed URLs for
releases missing from MusicBrainz.
