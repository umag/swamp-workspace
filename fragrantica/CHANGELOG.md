# Changelog

## 2026.08.02.1

Real-fixes the 9 remaining latent bugs (LB4–LB12) pinned during the wave-3
quality backfill (tracked in the local `fragrantica-latent-bugs`
@magistr/issue-lifecycle model — not filed to the swamp.club Lab, per
CLAUDE.md's Anti-Bypass rule). LB1–LB3 (closed in `2026.07.31.1`) are untouched
and stay green.

Adds three optional, code-defaulted global args — `timeoutMs` (default 15000),
`maxNotes` (default 20), `imageBaseUrl` (default `https://fimgs.net`) — so every
existing caller stays byte-identical unless it opts in to an override. No
resource-schema change.

**MEDIUM:**

- **LB4, redirect-follow bypasses host intent, closed** — `fetchPage`'s
  `fetch()` now passes `redirect: "manual"` and follows redirects itself in a
  loop bounded to 5 hops, re-validating each `Location` target against the host
  allowlist (`assertHostAllowed`) before ever fetching it. An
  opaque/locationless redirect throws instead of being silently followed.
- **LB5, second-order SSRF via DuckDuckGo poisoning, closed** —
  `resolveNoteUrl`'s and `list-by-designer`'s DuckDuckGo-resolved hit is now
  host-allowlisted before use, reusing the same `assertHostAllowed` guard as
  LB1/LB4. The stale "#4/#5 deferred" comments are removed throughout.
- **LB6, unbounded note fan-out, closed** — `find-by-notes` now caps `notes[]`
  at a `maxNotes` global arg (default 20), throwing before any fetch when
  exceeded.
- **LB7, no fetch timeout, closed** — `fetchPage` and `duckDuckGo` now run under
  a shared `withTimeout` helper: one `AbortController` + `setTimeout` per call
  (spanning every redirect hop for `fetchPage`), `clearTimeout` always in
  `finally`. Governed by the new `timeoutMs` global arg (default 15000ms).
- **LB8, duplicate-note double-count, closed** — `find-by-notes` now dedups by
  the RESOLVED note URL (a repeated note is fetched at most once) and computes
  its `mode=all` threshold from the distinct note count, not
  `args.notes.length`.

**LOW:**

- **LB9, instanceSlug resource-name collision, closed** — `instanceSlug` now
  appends a deterministic 8-hex-char FNV-1a hash of the RAW (pre-slugify) input,
  so distinct inputs that used to collapse to the same lossy slug (e.g. `"A/B"`
  vs `"A B"`) get distinct `writeResource` instance names. Injective and
  deterministic, not merely idempotent — the property test was rewritten
  accordingly.
- **LB10, unclamped accord strength, closed (with an accepted residual)** —
  `parseAccords` now clamps strength to `[0, 100]`. The false-positive selector
  match (matching ANY colored `width:` div, not just real accord-bar markup) is
  a SEPARATE, accepted residual — it isn't separable from synthetic markup
  without breaking the byte-frozen `perfume.html` accords contract pin, so it
  stays pinned as a documented, un-fixed risk.
- **LB11, hardcoded fimgs.net thumbnail, closed** — `refFromPerfumeUrl` /
  `collectPerfumeRefs` / `parsePerfume` now thread an optional `imageBase`
  parameter (default `https://fimgs.net`, driven by the new `imageBaseUrl`
  global arg) through to the thumbnail URL. The default stays byte-identical
  everywhere the override isn't set.
- **LB12, unsanitized stored values, accepted by decision (not fixed)** —
  `parsePerfume` still stores parsed text (brand/notes/description) VERBATIM.
  This is now documented as an intentional lossless-storage contract (see
  `parsePerfume`'s doc comment in `fragrantica.ts`): sanitizing at storage time
  would corrupt legitimate brand/note names, and this model never renders its
  stored data — encoding is a render-time responsibility for whichever
  downstream consumer displays it.

Model `version` and `manifest.yaml` bumped `2026.07.31.1` -> `2026.08.02.1` (in
sync), with an `upgrades` entry (`upgradeAttributes: (old) => old` — no
resource-schema change).

Test flips: `fragrantica_adversarial_test.ts` — 9 pins flipped from
pinned-broken to pinned-fixed (LB4/LB5/LB6/LB7/LB8/LB9/LB10/LB11) plus 6 new
tests (2 non-vacuous LB4 redirect tests, 1 symmetric LB5 list-by-designer test,
2 LB6 boundary/override tests, 1 LB11 unchanged-default test); LB10's
false-positive-selector pin and LB12's verbatim-storage pin stay as documented,
un-fixed/accepted residuals (retitled, same assertions).
`fragrantica_contract_test.ts` — the `accord-over-100.html` pin flips 120
-> 100. `fragrantica_coverage_test.ts` — the two `instanceSlug` tests updated
for the new hash-suffixed shape. `fragrantica_methods_test.ts` — the
`expectedSlug` mirror updated to match `instanceSlug`'s new algorithm (the 4
tests that call it need no other changes). `fragrantica_property_test.ts` —
property (a) adds a `<=100` clamp assertion; property (d) rewritten from
"idempotent" to "deterministic + injective". `fragrantica_test.ts` and all
LB1–LB3 pins stay unchanged and green.

`quality.yaml`: re-measured against the real-fix; ratchet stays
`rubricVersion: 3` / `baselinePercentage: 100` / Grade A. The stale
BYTE-FROZEN/no-bump/deferred header comment is rewritten to reflect this
real-fix change.

## 2026.07.31.1

Fixes the three HIGH latent bugs pinned during the wave-3 quality backfill
(tracked in the local `fragrantica-latent-bugs` @magistr/issue-lifecycle model —
not filed to the swamp.club Lab, per CLAUDE.md's Anti-Bypass rule; Lab is
`@swamp/*` product only).

- **SSRF (HIGH), closed** — every caller-supplied URL/path argument across the 5
  URL-taking methods (`get-perfume`, `similar`, `list-by-designer`,
  `list-by-note`, `find-by-notes`) is now checked against a host allowlist (the
  configured `baseUrl` host, or `fragrantica.com`/`*.fragrantica.com`) before it
  is ever fetched — enforced at the caller-input normalizers
  (`normalizePerfumeUrl`, `resolveNoteUrl`'s direct-URL branch,
  `list-by-designer`'s direct-URL branch), throwing before any network call
  (`calls.length === 0`) for a disallowed host. The allowlist check is exact
  -match or dot-suffixed, never a naive substring/`endsWith`, so lookalikes like
  `evilfragrantica.com` or `fragrantica.com.example` are still rejected.
  `fetchPage` also re-validates the post-redirect final URL (`response.url`)
  when the original request was already allowlisted, and now enforces a lenient
  Content-Type check (only rejects when a Content-Type header is present and
  isn't HTML/XHTML). Deliberately deferred and left byte-frozen: the
  DuckDuckGo-resolved branches of `resolveNoteUrl`/`list-by-designer`
  (second-order SSRF, MEDIUM #5) and `redirect: "manual"` (MEDIUM #4) — both
  still tracked, unchanged.
- **URIError DoS (HIGH), closed** — `slugToText`'s `decodeURIComponent` is now
  wrapped in try/catch, falling back to the raw (still percent-encoded) slug
  text instead of throwing an unmapped `URIError`. A single malformed `%`-escape
  no longer aborts an entire `get-perfume` call or an entire
  `collectPerfumeRefs` listing pass — every other link on the page still
  resolves.
- **Silent-empty success (HIGH), closed** — `get-perfume` now requires
  page-derived substance (an `itemprop` brand, or any of accords, notes,
  perfumers, rating, gender, year, description) before writing a `perfume`
  resource. A non-HTML 200 body (e.g. a JSON error page) or a redesigned page
  with none of the expected selectors now throws instead of silently writing an
  empty-ish perfume record and reporting success.
- Model `version` and `manifest.yaml` bumped `2026.07.16.2` -> `2026.07.31.1`
  (in sync).
- Test flips: 6 adversarial pins (`fragrantica_adversarial_test.ts`, including a
  new pin guarding the allowlist's dot-boundary/prefix-trick edge case) + 1
  contract pin (`fragrantica_contract_test.ts`) flipped from pinned-broken to
  pinned-fixed; 3 `normalizePerfumeUrl` coverage-branch fixtures
  (`fragrantica_coverage_test.ts`) adjusted (foreign host -> allowlisted host,
  empty body -> substance-bearing body). All deferred MED/LOW pins, the property
  suite, `fragrantica_test.ts`, and `fragrantica_methods_test.ts` stay green,
  unchanged.

This release also folds in the previously-unreleased wave-3 test backfill
(`ext-quality-test-backfill`), which added the five-suite quality bar ahead of
this fix and first pinned the 12 latent bugs above (3 HIGH now closed, 9
MEDIUM/LOW still deferred and tracked):

- Added `extensions/models/fragrantica_contract_test.ts` (contract-fixture,
  second file alongside the pre-existing `fragrantica_test.ts`, which stays
  UNCHANGED) — fixture-corpus pins of the four exported pures
  (`refFromPerfumeUrl`, `parseAccords`, `parseNotes`, `preferLinkName`) loaded
  from `fixtures/` via `Deno.readTextFile`, plus a mechanical host-allowlist and
  secret-shape scan over the whole fixture corpus (with sanity counter-tests
  proving both scanners actually fire).
- Added `extensions/models/fragrantica_methods_test.ts` (methods) — all 6
  methods (`search`, `get-perfume`, `similar`, `list-by-designer`,
  `list-by-note`, `find-by-notes`) happy-path, driven through
  `model.methods.<m>.arguments.parse()` + `.execute()` against a multi-route
  stubbed `globalThis.fetch` (DuckDuckGo POST vs. Fragrantica page GET, routed
  separately). Asserts fetched URLs, the DuckDuckGo POST body, the default vs.
  overridden User-Agent, written resource envelopes, and — since fragrantica.ts
  takes no credentials at all (`globalArguments` = `baseUrl` + `userAgent` only)
  — that no `Authorization` or `Cookie` header is ever sent.
- Added `extensions/models/fragrantica_adversarial_test.ts` (adversarial, new) —
  pins 12 latent scraper hazards found during characterization (characterized,
  NOT fixed — tracked in the LOCAL `fragrantica-latent-bugs` issue-lifecycle
  model, never filed to the swamp.club Lab):
  1. SSRF via an unvalidated URL/foreign-path argument, reachable through all 5
     URL-taking methods (`get-perfume`, `similar`, `list-by-designer`,
     `list-by-note`, `find-by-notes`) — no base-host allowlist.
  2. `URIError` crash on malformed percent-encoding (`slugToText` /
     `decodeURIComponent`) — a single poisoned `%`-href also denies an entire
     listing page's `collectPerfumeRefs` pass.
  3. Silent-empty SUCCESS on structural drift or a non-HTML 200 body —
     `fetchPage` never checks `Content-Type` and `parsePerfume` asserts no
     minimum field, so a JSON/binary body or a redesigned page "succeeds" with
     an empty-ish perfume instead of throwing.
  4. Redirect-follow bypasses host intent — `fetch()` is never called with
     `redirect: "manual"`.
  5. Second-order SSRF via DuckDuckGo poisoning — a resolved `/notes/` or
     `/designers/` hit is dereferenced on any host, no allowlist.
  6. Unbounded note fan-out in `find-by-notes` — `notes[]` has `.min(1)` but no
     `.max()`.
  7. No fetch timeout/`AbortSignal` on either `fetchPage` or `duckDuckGo`.
  8. Duplicate-note double-count in `find-by-notes` — passing the same note
     twice fetches its page twice and double-increments every match.
  9. `instanceSlug` resource-name collision — distinct inputs (e.g. `"A/B"` vs.
     `"A B"`) collapse to the same slug and clobber each other's written
     resource.
  10. `parseAccords` never clamps strength to 100 and matches any colored
      `width:` bar, not just real accord markup.
  11. The perfume thumbnail is hardcoded to `fimgs.net`, ignoring a configured
      `baseUrl` override.
  12. Parsed values (brand/notes/description) are stored unsanitized — inert
      today since this model never renders them, but a trust-boundary note for
      downstream consumers.
- Added `extensions/models/fragrantica_coverage_test.ts` (coverage, new) —
  sweeps every remaining guard/branch the methods/adversarial suites don't
  already exercise on both sides: `normalizePerfumeUrl`'s 3 branches,
  `resolveNoteUrl`'s 3 branches + its could-not-resolve throw,
  `list-by-designer`'s 3 branches, `parseNotes`'s container/heading
  permutations, `parseAlsoLike`'s heading-present/absent + self-URL filter,
  `collectPerfumeRefs`'s dedup/cap(500)/non-perfume-href skip, `search`'s
  locale-collapse/limit/zero-match, `find-by-notes`'s threshold/sort/limit, and
  `instanceSlug`'s symbol-only fallback + 80-char truncation.
- Added `extensions/models/fragrantica_property_test.ts` (property-invariant
  -flow, new) — `fast-check@4.8.0` properties honoring `FC_NUM_RUNS`, over
  arbitraries RESTRICTED to a safe (non-`%`) charset so the two documented
  totality exceptions (malformed-percent → `URIError`; non-HTML body →
  silent-empty) stay pinned in the adversarial suite instead of causing spurious
  property failures: `parseAccords` strength/dedup/cap invariants,
  `parseNotes`'s always-four-arrays shape, `refFromPerfumeUrl`'s totality over
  safe slugs, `instanceSlug` idempotency, `get-perfume`'s output always matching
  the (re-declared, since `PerfumeDetailSchema` isn't exported) `PerfumeDetail`
  shape, and `collectPerfumeRefs`'s 500-item cap + URL uniqueness.
- Added `fixtures/` — a synthetic, hand-authored HTML corpus (`perfume.html`,
  `designer-listing.html`, `note-listing.html`, `ddg-results.html`, and
  `malformed/` variants for a bad percent-escape, a non-HTML body, a missing
  `#pyramid`, a Cloudflare-challenge body, and an unclamped `width:120%` accord
  bar) plus `PROVENANCE.md`. No live capture from fragrantica.com or a live
  DuckDuckGo query was made; every host is `fragrantica.example` (RFC 2606) or a
  `duckduckgo.com` redirect-param literal, and every brand/perfume name is
  invented (`Testhouse`, `Fakebloom Nova`, ...). Excluded from `deno fmt` (see
  `deno.json`'s `fmt.exclude`) because a literal newline between the also-like
  carousel's brand and name text is semantically significant to the parser under
  test and must not be reformatted away.
- `deno.json`: `test` task adds `--allow-read=fixtures` (scoped to the
  contract-fixture file's `Deno.readTextFile` calls) and
  `--allow-env=FC_NUM_RUNS`; added a `test:soak` task for the high-count nightly
  property soak. Stays network-less (no `--allow-net` — every fetch in every
  suite is stubbed).
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (fragrantica
  bundles no Claude skill); `watch`/`canary` stay `backlog` (no generalized
  release-watch or live-canary workflow yet). Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: perfume search (via a DuckDuckGo HTML resolver, since
Fragrantica's own search is Cloudflare/Algolia-gated), full perfume details
(`get-perfume`), the "People who like this also like" similar list (`similar`),
designer/house and note listings (`list-by-designer`, `list-by-note`), and a
note-combination hunt (`find-by-notes`) — all reading the public Fragrantica
pages, no credentials required.
