# Changelog

## 2026.08.02.1

Real-fixes the remaining 5 latent bugs tracked in the local
`bandcamp-latent-bugs` issue-lifecycle model (bugs #3-#7 of the 7 characterized
in the wave-3 test backfill; #1 and #2 already shipped in `2026.07.31.1`; NEVER
filed to the swamp.club Lab -- see CLAUDE.md's anti-bypass rule). After this
release all 7 tracked findings are resolved. No resource-schema or
`globalArguments` change -- model identity is preserved via a no-op `upgrades[]`
entry.

- **TralbumData `//`-strip corruption (MEDIUM, bandcamp-latent-bugs #3)**:
  `parseAlbumPage` now tries a direct `JSON.parse` of the TralbumData blob FIRST
  (real Bandcamp TralbumData is valid JSON). Only on failure does a cleanup
  fallback run, and that fallback now PROTECTS any `scheme://` value
  (`.replace(/(^|[^:])\/\/.*$/gm, "$1")`) instead of unconditionally stripping
  from the first `//` to end-of-line -- the old cleanup truncated the JSON at
  the first embedded `https://` value, silently losing every track. The
  trailing-comma cleanups are unchanged and still run on the fallback path.
- **Silent all-clear on parse failure (MEDIUM, bandcamp-latent-bugs #4)**:
  `parseAlbumPage` and `parseArtistPage` now accept an optional
  `warn?: (msg: string) => void` callback, invoked from each of the three empty
  `catch` blocks (album JSON-LD, album TralbumData, artist JSON-LD) on a GENUINE
  parse failure (script present, parse threw) -- never when the script is simply
  absent. The three `get-*` methods pass `(m) => context.logger?.warning?.(m)`.
  The message is a fixed, generic string naming only the error's `.name` (e.g.
  `SyntaxError`) -- never the raw blob content or any credential.
- **No fetch timeout/backoff (MEDIUM, bandcamp-latent-bugs #5)**: added a
  `timedFetch` helper (`AbortController` + `setTimeout(..., 30_000)`,
  `clearTimeout` in a `finally` so it fires on success, on a thrown error, AND
  on every redirect hop) and routed `fetchPage` (per hop), `getToken`, and
  `bcPost` through it. A hung/slow upstream can no longer block a call -- and
  the model's lock -- indefinitely.
- **`instanceName` 60-char truncation collision (LOW, bandcamp-latent-bugs
  #6)**: `get-artist`/`get-album`/`get-track` now derive the written resource's
  instance name via a new `urlResourceName` helper: a 47-char sanitized slug
  plus a 12-hex-char SHA-256 suffix of the FULL source URL (still <= 60 chars
  total). Two different URLs sharing the same first 47 sanitized characters no
  longer collide on the identical resource name -- each gets its own
  collision-resistant suffix. The same URL always hashes to the same suffix, so
  re-running a `get-*` method against the same URL still idempotently overwrites
  its own prior resource.
- **`slice()` surrogate split (LOW, bandcamp-latent-bugs #7)**: `about` and
  `bio` now truncate by CODE POINT (`Array.from(x).slice(0, 500).join("")`)
  instead of by UTF-16 code unit, so an astral character (e.g. an emoji)
  straddling the boundary is kept or dropped WHOLE, never split into a lone
  unpaired surrogate. Note the invariant changes shape: it is now "<= 500 CODE
  POINTS", not "<= 500 UTF-16 code units" -- for astral input the returned
  string's `.length` (code units) can exceed 500.
- No method contract or wire body changes; no resource-schema or
  `globalArguments` change. Added a no-op `upgrades[]` entry
  (`fromVersion: "2026.07.31.1"`, `toVersion: "2026.08.02.1"`,
  `upgradeAttributes: (old) => old`) documenting the bump.
- Tests: flipped all 5 remaining `bandcamp-latent-bugs` pins across
  `bandcamp_test.ts` (contract-fixture, #3's and #6's concrete VALUE pins) and
  `bandcamp_adversarial_test.ts` (#3 x2, #4 x2, #5 x2, #6, #7 x2) to assert the
  FIXED behavior; `bandcamp_adversarial_test.ts`'s `makeCtx` now captures logger
  calls (mirroring `bandcamp_methods_test.ts`'s pattern). Added: a hung-upstream
  `FakeTime`-driven abort test for #5; a JSON-LD parse-failure leak test and an
  artist-page parse-failure warning test for #4; an astral-heavy property test
  for #7 (additive, existing ASCII-only properties untouched). `quality.yaml`'s
  header comment and this file's/ the adversarial suite's/the methods
  suite's/`fixtures/PROVENANCE.md`'s "byte-frozen"/"unmodified"/"deferred"
  wording is updated to reflect that all 7 bugs are now fixed; fixture FILES
  themselves stay byte-identical.

## 2026.07.31.1

Fixes the CRITICAL SSRF and HIGH cross-instance OAuth token-cache bleed tracked
in the local `bandcamp-latent-bugs` issue-lifecycle model (bugs #1 and #2 of the
7 characterized in the wave-3 test backfill below; NEVER filed to the swamp.club
Lab -- see CLAUDE.md's anti-bypass rule).

- **SSRF (CRITICAL, bandcamp-latent-bugs #1)**: `get-artist`/`get-album`/
  `get-track` used to pass the caller-supplied `url` straight to `fetch()` with
  no host allowlist, so a link-local (`169.254.169.254`) or loopback
  (`127.0.0.1`) target was reached exactly like a real Bandcamp URL. Added
  `assertAllowedHost()`, enforced inside `fetchPage` before every fetch: only
  `bandcamp.com` or a `*.bandcamp.com` subdomain is allowed (case-insensitive,
  one trailing dot stripped, http/https only). `fetchPage` now fetches with
  `redirect: "manual"` and manually follows up to 5 redirect hops, re-validating
  the `Location` host against the same allowlist on every hop, so a 3xx bounce
  to an internal host is rejected exactly like a direct request to it.
  Custom-domain Bandcamp artist pages are no longer fetched -- a deliberate,
  accepted scope narrowing.
- **Cross-instance OAuth token-cache bleed (HIGH, bandcamp-latent-bugs #2)**:
  the module-level `cachedToken` singleton was keyed only on `Date.now()`, never
  on which `clientId`/`clientSecret` produced it, so two swamp instances of
  `@magistr/bandcamp` configured with DIFFERENT OAuth credentials but sharing
  one running swamp process silently reused each other's bearer/refresh token
  for up to an hour. Replaced it with `tokenCache`, a `Map` keyed on credential
  identity (`clientId` + `clientSecret`); a different identity now misses the
  cache and fetches its own token. Behavior for a single credential (the common
  case) is unchanged -- same key, same time-based validity check, same
  `refresh_token` branch, same write-back.
- No method contract, resource schema, or wire body changes. Latent bugs #3-#7
  (TralbumData `//`-strip corruption, silent parse-failure all-clear, no fetch
  timeout/backoff, `instanceName` truncation collision, `slice()` surrogate
  split) remain deferred/accepted and are unaffected by this change; in
  particular no `AbortSignal`/timeout was added anywhere (#5's pins still assert
  `init.signal === undefined`).
- Tests: flipped the three `bandcamp-latent-bugs #1` SSRF pins and the `#2`
  token-bleed pin in `bandcamp_adversarial_test.ts` to assert the FIXED behavior
  (rejection + zero fetches for internal targets; two distinct per-credential
  token fetches); added a redirect-revalidation SSRF test and a positive
  allowlist test (`example.com` rejected, real `*.bandcamp.com` still succeeds).
  Migrated every get-artist/get-album/get-track fetch target from a
  `*.example.com` host to `*.bandcamp.com` across the
  adversarial/contract/methods/coverage/property suites (the allowlist now
  rejects `example.com`); fixture files themselves stay byte-frozen since their
  embedded `example.com` content is parsed data, never a fetch target.

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
