# Changelog

## 2026.08.04.1

Ports three additions (musicbrainz-discography-sync) from an older, untested
local copy of this model onto this package's Grade-A-hardened lineage — a real
merge against this file's own `mbFetch`/schema/method conventions, not a paste.
`model.version` and `manifest.yaml` move `2026.08.02.1` -> `2026.08.04.1`.

### Five new exported pure helpers

`classifyDiscographyCache(entry)` classifies a cached `browse` entry as
`"never-fetched"` (no entry written yet), `"empty"` (fetched, legitimately
`count: 0`), or `"populated"` — conflating empty with never-fetched would cause
infinite re-fetch of artists with no release groups.
`isCacheStale
(timestamp, now, ttlMs)`, `advanceSyncCursor(cursor, outcome)`,
`rateLimitDelayMs
(lastRequestAt, now, minIntervalMs)`, and
`retryAfterBackoffMs(retryAfterHeader,
minIntervalMs)` are all pure — no
internal clock read, `now`/`ttlMs`/etc. are always parameters — and back the two
behaviors below plus the new method.

### `mbFetch`'s rate limiter is now concurrency-safe, and retries a `503` once

Previously `mbFetch` computed its wait with a plain read-then-write of a
module-level timestamp (`wait = 1100 - (now - lastRequest)`); two concurrent
`await mbFetch(...)` calls could both read the same stale timestamp and fire
together. It now reserves its slot through a module-level promise chain
(`reserveRateLimitSlot`) that reassigns the chain's tail _synchronously_, before
any `await` — so two concurrent callers can never race on read-then-write of the
tail pointer, and always run their reservations strictly one after another.
Sequential-call spacing (the default ~1100ms) and the observable throw-on-non-ok
behavior are unchanged; every existing method's default-3-arg
`mbFetch(userAgent, path, params)` call keeps the same ~1100ms floor. `mbFetch`
also now retries a `503` exactly once: it reads `Retry-After` (via
`retryAfterBackoffMs`, honoring the header in seconds when present, else falling
back to one more spacing interval), waits out the backoff, reserves a fresh
slot, and retries; a non-ok response after the retry still throws, with
`Retry-After` still surfaced in the message when present. `mbFetch` is now
exported (previously module-private) so the test suite can exercise the real
spacing/concurrency/retry behavior directly instead of mirroring it.

### New method: `sync-artist-discographies`

A cursored, resumable, rate-limited fan-out over a list of artist MBIDs that
caches each one's full release-group discography, routed through the existing
`mbFetch` + `browse`/`rg-by-artist-<mbid>` write path (the same one
`browse-release-groups` uses) — no second fetch or write path. Defaults to the
artists cached by the instance's most recent `search-artist` run when
`artistMbids` is omitted, falling back to an actionable error (naming the full
`swamp model method run <instance> search-artist ...` command via
`context.definition.name`) when neither is available. Each run processes one
batch (`batchSize`, default 10) starting at a persisted cursor
(`discographySyncState`, a new resource) so an interrupted sync resumes rather
than restarting, and repeated batches cover the artist list exactly once — no
gap, no overlap. A cached entry is skipped when fresh (`ttlMs`, default 7 days)
and re-fetched when stale; a cached `count: 0` is treated as a legitimate empty
discography, never re-fetched merely for being empty. Per-artist pagination
stops at `maxPages` (default 20 — 2,000 release groups) and marks the cached
entry `truncated: true` rather than silently caching a partial discography as
complete — `truncated` is a new optional, defaulted field on the existing
`browse` resource schema, unset by the single-page `browse-*` methods.

### Tests

Integrated into the five existing role-assigned suites, not bolted on as a sixth
file. `musicbrainz_property_test.ts`: the five pure-helper invariants above (21
tests, no stubbed fetch or FakeTime needed — they're pure).
`musicbrainz_adversarial_test.ts`: mbFetch's concurrency-safe spacing (three
concurrent calls via `Promise.all`, asserting every consecutive pair of recorded
timestamps is spaced ≥ the interval apart), the 503-retry-succeeds and
503-persists-past-retry paths (with and without `Retry-After`), and
sync-artist-discographies' stale-cache-triggers-refetch /
fresh-count:0-is-skipped failure modes (6 tests); the pre-existing "still no
retry" 503 pin was updated in place to assert the new retry-once behavior
instead (calls.length flips `1` -> `2`). `musicbrainz_coverage_test.ts`:
new-method/resource-surface enumeration plus the maxPages/truncated pagination
guard, both the ceiling-hit and natural-end cases (3 tests).
`musicbrainz_methods_test.ts`: general execute() paths — explicit artistMbids,
the search-artist fallback, cursor resume across two sequential runs, and the
no-artist-list error (4 tests). 128 tests before this change, 161 after; all
green, no regressions. `quality.yaml`'s five suites and 100% Grade-A ratchet are
unaffected (all additions land inside the existing five files).

## 2026.08.02.1

Real-fixes LB2-LB7, the six latent bugs pinned (not fixed) by the 2026.07.31.1
test backfill and tracked under `musicbrainz-ssrf-and-latent-bugs`. LB1 (the
bandcampUrl SSRF) was already fixed in 2026.07.31.1 and is untouched here — its
pins stay green. `model.version` and `manifest.yaml` move `2026.07.31.1` ->
`2026.08.02.1`.

### LB2 (MED): raw MBID interpolated unencoded into the request path

All five lookup methods (`lookup-artist`, `lookup-release-group`,
`lookup-release`, `lookup-recording`, `lookup-label`) now wrap `args.id` in
`encodeURIComponent()` before interpolating it into the request path. A `../`
can no longer collapse the path out of `/ws/2/<entity>/`, a `/` can no longer
add an extra path segment, and a `?`/`#` can no longer inject a query parameter
or fragment via the id — every special character is percent-encoded into a
single, harmless path segment. `encodeURIComponent` is the identity transform
for canonical hyphenated-hex MBIDs, so every existing happy-path request-URL
assertion across the suite stays byte-identical; only the four injection pins in
`musicbrainz_adversarial_test.ts` flip from documenting the vulnerable behavior
to asserting the fix, plus two new tests (identity on a real MBID; full encoding
of an id combining every special character at once). The generic `search` method
(its entity comes from a `z.enum`, never user-supplied) and the browse methods
(MBIDs go through `URLSearchParams.set`, already safe) needed no change.

### LB3 (MED): TralbumData `//`-comment-strip corrupts an embedded `https://` URL

`parseBandcampAlbumPage`'s TralbumData fallback now tries `JSON.parse` on the
raw matched blob FIRST — real TralbumData is valid JSON as-is, embedded
`https://` URLs included, so this succeeds without ever touching the
comment-strip. Only on a parse failure does it fall back to a cleanup pass, and
that cleanup itself is `://`-protected (`(?<!:)\/\/.*` — a negative lookbehind
that never strips through the `//` inside `http(s)://`) plus the original
trailing-comma cleanup, preserving the strip's original intent for a genuine
trailing `// comment` without corrupting a URL. The `hostile.ts`-driven pin in
`musicbrainz_adversarial_test.ts` flips from "tracks end up EMPTY" to asserting
`trackCount === 1` and the real track title survives; the `album_tralbum.ts`
contract fixture (valid JSON, no `//` at all) stays green either way, since
MusicBrainz JSON responses go through `response.json()` and were never affected
by this parser at all.

### LB4 (MED): unbounded `while (true)` release-group pagination

`find-missing` and `seed-all-missing`'s release-group walk is now bounded by a
new optional, defaulted global argument, `maxPages` (default 50 — 5,000 release
groups, far past any real artist's discography). The `while (true)` loops became
`for (let page = 0; page < maxPages; page++)`, still breaking early on the first
short (`<100`) page exactly as before. The existing FLOW pin in
`musicbrainz_property_test.ts` (offset 0->100->200, terminating naturally on a
short page well under the default cap) stays green unmodified; a new FLOW test
proves the cap itself works by feeding an ALWAYS-full-page stub with
`globalArgs.maxPages: 2` and asserting the walk stops after exactly offsets
`["0", "100"]` — the scenario that would have hung the old unbounded loop
forever.

### LB5 (LOW): `normalizeTitle` ASCII-only over-collapse

`normalizeTitle` now runs `s.normalize("NFKD")`, strips the resulting combining
diacritical marks (U+0300-U+036F), lowercases, collapses any run of
non-`\p{L}`/`\p{N}` Unicode codepoints to a single space, and trims — instead of
deleting every non-ASCII character outright. This FIXES the two over-collapse
false-positive matches pinned in `musicbrainz_coverage_test.ts` ("Café
Nuit"/"Caf Nuit" and a CJK title vs. a punctuation-only title no longer collide
— `matched.length` flips `1`->`0`, `missing.length` flips `0`->`1` in both),
while the ASCII hyphen-vs-space collision test intentionally STAYS matched (both
still normalize to the same string). A new test covers the opposite direction
the fix is FOR: "Motörhead" now correctly matches "Motorhead" (NFKD folds `ö` to
`o` instead of deleting it). The property mirror (`predictNormalize` in
`musicbrainz_property_test.ts`) was updated in lockstep and re-validated at
`FC_NUM_RUNS=10000`; every existing test/artist name in the suite is plain
ASCII, so no other assertion changes.

### LB6 (LOW): ISO-8601 track-duration display drops the hours component

Both duration-string formatters (the Bandcamp JSON-LD ISO-8601 parser and the
TralbumData fallback) now share a new exported `formatDuration(totalSeconds)`
helper, producing `H:MM:SS` once a track runs an hour or longer and `M:SS`
otherwise. The underlying `durationMs` value (used for the seed URL's `length`
param) was already correct and is untouched — this display string is never
written to any resource, so no existing pin flips; the `album_jsonld` contract's
`length: "3750000"` assertion stays byte-identical. Four new direct unit tests
exercise the helper: `65 -> "1:05"`, `3750 -> "1:02:30"`, `3600 -> "1:00:00"`,
`0 -> "0:00"`.

### LB7 (MED): no timeout, no Retry-After, no response-shape validation

- **Timeout**: both `mbFetch` and `fetchPage` now build a per-call
  `AbortController`, pass its `signal` to `fetch()`, and
  `setTimeout(() =>
  controller.abort(), 30000)` with `clearTimeout` in a
  `finally` — per-hop inside `fetchPage`'s redirect loop, so a stuck hop can't
  hang the whole chain. A hung endpoint now aborts after 30s instead of hanging
  forever.
- **Retry-After**: a non-ok `mbFetch` response now reads `Retry-After` and
  appends it to the thrown error message when present — surfaced, not acted on;
  there is still no client-side retry.
- **Response validation**: every `data.<key> || []` array-extraction site (5
  search methods, 3 browse methods, both pagination loops) is now
  `Array.isArray(data.<key>) ? data.<key> : []` — a lightweight shape guard, not
  zod `safeParse` (the resource schemas stay `.passthrough()`). A truthy
  non-array response field (e.g. a malformed string) now normalizes to `[]`
  instead of silently sailing through and type-confusing the derived count via
  `.length`. The raw-entity `data` passthrough in the five `lookup-*` methods is
  deliberately left alone — that pin stays, by design, since those methods
  intentionally return the MusicBrainz entity unvalidated.
- Four adversarial pins flip to assert the fixes (AbortSignal now present on
  both fetch sites; Retry-After now surfaced; the two non-array `artists` tests
  now assert `[]` and a corrected `count`), and a new test drives a
  never-resolving stubbed fetch under `FakeTime`, advances past the 30s timeout,
  and asserts the abort fires.

### Versioning / quality

- `musicbrainz.ts`: `version` `2026.07.31.1` -> `2026.08.02.1`; added an
  `upgrades` entry (`fromVersion: "2026.07.16.2"`,
  `toVersion:
  "2026.08.02.1"`, identity `upgradeAttributes`) — a no-op
  migration since `globalArguments` only gained an optional, defaulted
  `maxPages` field. A single entry covers instances still parked at either
  `2026.07.16.2` or `2026.07.31.1`, since the upgrade filter is
  `toVersion > typeVersion`.
- `manifest.yaml`: `version` bumped in sync.
- `README.md`: documented the new optional `maxPages` global argument.
- `quality.yaml`: re-stamped from a real `swamp extension quality` run; five
  suites still present, ratchet re-measured.
- All five suites green (`deno task test`), plus `deno task test:soak`
  (`FC_NUM_RUNS=10000`) re-validating the normalizeTitle collision property and
  the pagination-flow tests at scale.

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
- No `AbortSignal` timeout was added here — this change was scoped to the SSRF
  fix only (fixed, along with the other latent bugs noted below, in
  2026.08.02.1).
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
  current behavior, not fixed, at the time): raw MBID path interpolation (path
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
  security fix above. Every other gap in this list (LB2-LB7) was real-fixed in
  2026.08.02.1, above.
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
