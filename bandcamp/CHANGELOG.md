# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-3 scraper child of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change -- `bandcamp.ts` is byte-frozen and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/bandcamp_test.ts` (contract-fixture),
  `bandcamp_methods_test.ts` (methods), `bandcamp_adversarial_test.ts`
  (adversarial), `bandcamp_coverage_test.ts` (coverage),
  `bandcamp_property_test.ts` (property-invariant-flow) -- 0 tests before this
  change, 84 after.
- Added `fixtures/` -- 10 synthetic HTML pages (`search_artists`,
  `search_albums`, `search_tracks`, `search_fallback`, `search_empty`, `album`,
  `album_tralbum_fallback`, `album_tralbum_dirty`, `artist_grid`,
  `artist_ld_discography`) and 7 synthetic JSON API responses (`oauth_token`,
  `my_bands`, `sales_report`, `merch_details`, `orders`, `update_shipped`,
  `api_error`) plus `PROVENANCE.md`. No live call was made against bandcamp.com
  or the Bandcamp OAuth/sales API while authoring these fixtures; every value is
  synthetic (RFC 2606 `.example.com` hosts, RFC 5737 addresses for the SSRF pin
  target's contrast case, "Fixture"-prefixed names, invented catalog data).
- Every test in every suite drives `model.methods.<m>.execute()` against a
  stubbed `globalThis.fetch` and a fake context (no CommandRunner seam exists
  for this scraper) -- the same technique the `porkbun` precedent uses. HTML
  fixtures are parsed with the REAL `linkedom@0.16.11` the model itself uses,
  never a stubbed DOM.
- The module-global OAuth token cache (`cachedToken`, keyed only on time) is
  tamed with `@std/testing` FakeTime throughout: every suite file starts with
  `cachedToken === null` (Deno isolates module state per TEST FILE, not per
  `Deno.test` -- verified empirically before writing these suites), and
  cache-sensitive tests use monotonically-advancing fake clocks to stay
  deterministic regardless of within-file test order.
- 7 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed -- `bandcamp.ts` is byte-frozen by this change) and tracked in the
  LOCAL `bandcamp-latent-bugs` issue-lifecycle model (NEVER filed to the
  swamp.club Lab):
  1. **SSRF via `url` arg (CRITICAL)** -- `get-artist`/`get-album`/ `get-track`
     pass the caller-supplied URL straight to `fetch` with no host allowlist; a
     link-local or loopback target (`169.254.169.254`, `127.0.0.1`) is reached
     exactly like a real Bandcamp URL.
  2. **Cross-instance token-cache bleed (HIGH)** -- `cachedToken` is a bare
     module-level `let`, checked only against `Date.now()`; two swamp instances
     of `@magistr/bandcamp` configured with DIFFERENT OAuth credentials but
     sharing one running swamp process silently reuse each other's bearer token
     for up to an hour, with zero identity check.
  3. **`TralbumData` `//`-strip corruption (MEDIUM)** -- the cleanup regex
     `.replace(/\/\/.*/g, "")`, intended to strip `//`-style JS comments, also
     nukes the `//` inside any `https://` value the single-line TralbumData blob
     contains, truncating the JSON past repair; the parse failure is silently
     swallowed and every track is lost.
  4. **Silent all-clear on parse failure (MEDIUM)** -- both the JSON-LD and
     TralbumData `JSON.parse` calls are wrapped in an empty `catch`; a malformed
     or control-byte-corrupted blob resolves as an ordinary "successful"
     resource with the affected fields silently empty, with no signal anywhere
     that parsing actually failed.
  5. **No fetch timeout/backoff (MEDIUM)** -- none of `fetchPage`, `bcPost`, or
     `getToken` pass an `AbortSignal` or any timeout to `fetch`; a slow or hung
     upstream blocks the call (and the model's lock) indefinitely.
  6. **`instanceName` 60-char truncation collision (LOW)** -- the
     `writeResource` name for `get-album`/`get-track`/`get-artist` is the
     sanitized URL sliced to 60 characters; two distinct URLs sharing that
     prefix collide on the identical resource name, and the second call silently
     clobbers the first in a real swamp instance.
  7. **`slice()` surrogate split (LOW)** -- `about`/`bio` truncate at
     `slice(0, 500)`, a UTF-16 code-unit cut that can split a surrogate pair
     straddling the boundary, emitting a lone unpaired high surrogate.
- `deno.json`: default `test` task scoped to
  `--allow-read --allow-env=FC_NUM_RUNS` (read for the HTML fixture files, no
  `--allow-net` -- the fetch boundary is always stubbed); added `test:soak` for
  the high-count nightly property soak. `fmt.exclude` lists the two
  `album_tralbum_*.html` fixtures -- both carry a deliberately single-line
  `TralbumData` blob (matching real Bandcamp output) that `deno fmt`'s HTML
  formatter would otherwise pretty-print across multiple lines, which would
  silently defeat the `//`-strip corruption bug fixture #3 exists to pin.
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependencies
  (`jsr:@std/assert@1`, `jsr:@std/testing@1`, `npm:fast-check@4.8.0`). Source
  dependencies (`npm:zod@4`, `npm:linkedom@0.16.11`) are unchanged -- the lock
  delta carries no runtime/behavior implication whatsoever.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (bandcamp bundles
  no Claude skill -- a scraper model, nothing to document as a skill).
  `watch`/`canary` stay `backlog` (seeded offender at CI-gate rollout, tracked
  in `ext-quality-test-backfill`). `ratchet` set from the measured
  `swamp extension quality manifest.yaml --json` score. Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: search artists, albums, and tracks on the public Bandcamp
catalog; fetch full artist/album/track metadata (discography, track listings,
tags, cover art, bio) by URL via JSON-LD and embedded `TralbumData`. Optional
OAuth (`clientId`/`clientSecret`) unlocks account methods: `my-bands`,
`sales-report`, `get-merch-details`, `get-orders`, and `update-shipped` against
the Bandcamp sales/merch API.
