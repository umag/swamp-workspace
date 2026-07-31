# Changelog

## 2026.08.01.1

Two changes are bundled into this first version bump since `2026.07.16.2`: the
wave-2c test backfill (previously unreleased, source unmodified) and a hardening
fix for the two HIGH credential-exposure findings that backfill surfaced,
tracked in the local `dawarich-hardening` issue-lifecycle model (never a Lab
issue).

### Hardening fix

- **[HIGH] api_key no longer rides in the request URL query string.**
  `apiRequest()`'s shared builder+fetch site now sends the credential as an
  `Authorization: Bearer <apiKey>` header instead of a `?api_key=...` /
  `&api_key=...` query parameter. The Dawarich `ApiController` accepts either
  transport (`params[:api_key]` OR an `Authorization` header matched by
  `/\ABearer\s+(\S+)\z/i`), so this is a behavior-preserving transport change:
  every one of the 10 methods routes through this single builder, so one edit
  closes the exposure everywhere. The previously dead `sep` local
  (`endpoint.includes("?") ? "&" : "?"`) was removed along with it.
- **[HIGH] `globalArguments.apiKey` is now `.meta({ sensitive: true })`** on
  `GlobalArgsSchema`, so swamp routes it through the vault instead of rendering
  it in cleartext on CLI/log surfaces. Mirrors the `telegram_send.ts` `botToken`
  pattern.
- 8 characterization pins across `dawarich_methods_test.ts`,
  `dawarich_adversarial_test.ts`, and `dawarich_coverage_test.ts` flipped from
  asserting the leaky behavior to asserting the hardened behavior (7 transport
  pins + 1 sensitive-meta pin); behavior-preserving pins (api_key never in a
  written resource, never in a happy-path thrown error) stayed green throughout.
- **Deferred, NOT fixed here** (out of scope for this two-HIGH pass, still
  tracked): the 3 MED / 2 LOW findings from the original bug — the
  `Array.isArray` silent-`[]` coercion (including the CONFIRMED-real `tracks`
  GeoJSON break), non-numeric pagination-header `NaN` coercion, and the missing
  `encodeURIComponent` on interpolated query params. The hostile-server-echo
  residual (a server response can still echo a credential-adjacent value back
  into a thrown error's text) is also unchanged — closing it needs a redacting
  error mapper, tracked as a separate follow-up like headphones/telegram-send.

### Test backfill (wave-2c, previously unreleased)

Test backfill to the STANDARD.md five-suite quality bar (wave-2c of the
extension-quality backfill program, `ext-quality-test-backfill`). This part made
no behavior change on its own — it added tests/fixtures only, with `dawarich.ts`
unmodified at the time — but it was never separately released, so it ships as
part of this same version bump.

- Added `extensions/models/dawarich_test.ts` (contract-fixture),
  `dawarich_methods_test.ts` (methods), `dawarich_adversarial_test.ts`
  (adversarial), `dawarich_coverage_test.ts` (coverage),
  `dawarich_property_test.ts` (property-invariant-flow) — 0 tests before this
  change, 142 tests after.
- Added `fixtures/` — pure doc-derived, synthetic Dawarich API wire-shape
  fixtures (`health`, `stats`, `points`, `tracked-months`, `visits`, `tracks`,
  `settings`, `digests`, `photos`) plus `PROVENANCE.md`. No live call was made
  against any Dawarich instance (including the homelab's own `my-atlas`); every
  coordinate is one of exactly five public, globally documented tourist
  landmarks (Sydney Opera House, Christ the Redeemer, the Mount Everest summit,
  Uluru/Ayers Rock, Ushuaia) — an EXACT-VALUE allowlist, never a region — with a
  coarse country-level Netherlands denylist box as a secondary tripwire only. No
  real point, visit, track, photo, host, or api_key appears anywhere in the
  corpus.
- `deno.json`: default `test` task stays network-less and filesystem-less (no
  `--allow-net`, no `--allow-read`), scoped to `--allow-env=FC_NUM_RUNS`; added
  `test:soak` for the high-count nightly property soak. Both the
  fixtures-secret-scan and the coordinate-allowlist-scan consume
  statically-imported (`with { type: "json" }`) fixture modules — zero runtime
  filesystem access.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (dawarich bundles
  no Claude skill); `ratchet` measured via `swamp extension quality`
  (rubricVersion 3, 100%, Grade A) and recorded. Removed from
  `quality-allowlist.txt` in the same change.
- Several gaps were surfaced by the adversarial/security review at backfill time
  and tracked as a local follow-up hardening bug (`dawarich-hardening`, filed
  via the local `@magistr/issue-lifecycle` model, never the Lab). Items 1 and 2
  below are FIXED in this same version (see "Hardening fix" above); items 3-8
  remain deferred:
  1. **FIXED above.** The `api_key` credential rode in the request URL query
     string (`?api_key=...` / `&api_key=...`), never a header — every
     URL-bearing surface (proxy logs, fetch network errors, swamp CLI traces)
     could expose it. The methods/adversarial suites originally pinned that the
     key WAS present in the captured request URL; they now pin the opposite
     (absent from the query, present as an `Authorization: Bearer` header). The
     network-rejection error-message leak was never offline-testable (the test
     stub replaces `fetch` itself) and remains documented rather than faked into
     a self-fulfilling test.
  2. **FIXED above.** The `apiKey` global argument was not marked
     `.meta({ sensitive: true })`, so swamp CLI/log surfaces could render it in
     cleartext. The coverage suite's pin flipped from asserting the unmarked
     state to asserting `sensitive === true`.
  3. Non-array truthy `data` is silently coerced to `[]` via
     `Array.isArray(data) ? data : []` on points/visits/tracks/photos/
     tracked-months — a hostile or malformed response looks like an
     empty-but-successful result, with no error surfaced. For `tracks`
     specifically this is CONFIRMED, not hypothetical: the real Dawarich
     `GET /api/v1/tracks` endpoint returns a GeoJSON `FeatureCollection` object,
     never a bare array, so `tracks` silently and permanently returns zero
     results against the actual shipped API today.
  4. `parseInt()` on a non-numeric `X-Current-Page`/`X-Total-Pages` header
     silently yields `NaN` rather than throwing or falling back.
  5. Query params (`start_at`/`end_at`/`order`/`page`/`per_page`/`year`/
     `period_type`) are interpolated raw into the query string with no
     `encodeURIComponent` — a value containing `&` injects an extra parameter.
  6. (informational) The real `settings`/`update-settings`/`digests` endpoints
     wrap their payload (`{settings, status}` / `{digests, availableYears}`),
     but the corresponding methods store the whole wrapped envelope verbatim
     rather than unwrapping it — a real, double-nested characterization
     surprise, not a security issue.
  7. (informational) `photos`' `startAt`/`endAt` are optional in the schema even
     though the real documented `GET /api/v1/photos` endpoint requires
     `start_date`/`end_date` — calling `photos()` with no args sends a request
     the live API would likely reject.
  8. (informational) The shared `apiRequest()` fetch helper has no
     `AbortSignal.timeout` and no `Retry-After`/429 backoff (mirrors
     tubearchivist's documented-not-tested gap). Not offline-testable, so it is
     documented here rather than pinned as a test.

## 2026.07.16.2

Initial release: check service health; read monthly/yearly statistics; read
location points, visits, tracks, and geotagged photos with date-range and
pagination filtering; list tracked months; read and update user settings; and
read yearly/monthly digests, for a self-hosted Dawarich instance.
