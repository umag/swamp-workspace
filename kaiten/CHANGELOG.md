# Changelog

## 2026.08.19.1

- Version bump and smoke test

## Unreleased (test backfill, no version bump)

Quality backfill (`ext-quality-test-backfill`, wave 2a gap-check): brought
`@magistr/kaiten` to full five-suite compliance per `STANDARD.md`, adapted to
its read-only, GET-only, Bearer-token-auth surface. No runtime behavior change —
`kaiten.ts` is byte-frozen and the model `version` stays `2026.06.21.1`. Every
new test is a characterization test pinning already-shipped behavior, driven
through `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
`globalThis.fetch` and a fake `ExecCtx` (the porkbun PR #65 fetch-boundary
harness pattern).

- `kaiten_test.ts` — KEPT byte-unchanged as the pre-existing SDK-surface anchor
  (resolveBase/backoffMs/slug helpers, listCards arg defaults, the read-only
  7-method surface guard).
- Added `extensions/models/kaiten_contract_test.ts` (contract-fixture,
  wire-format half) — pins the documented Space/Board/Column/Card keysets, the
  bare-array list shape, the numeric `condition` field, offset/limit pagination
  params, and the generic error envelope, from a synthetic doc/schema-derived
  fixture corpus.
- Added `extensions/models/kaiten_methods_test.ts` (methods) — all 7 read-only
  methods (listSpaces, getSpace, listBoards, getBoard, listColumns, listCards,
  getCard), happy + failure paths, endpoint/query assertions, resource + summary
  writes, per-method token-non-leak across error/logs/resources with a
  distinctive sentinel, the 429→retry→200 path via `Retry-After: "0"` (no timer
  stubbing), and a trust-boundary pin that a hostile echoing server body
  surfaces the token today (documented, not fixed).
- Added `extensions/models/kaiten_adversarial_test.ts` (adversarial) —
  malformed/non-JSON responses, non-array/non-object data, id-less items,
  hostile `null`/array bodies on the single-fetch get* methods, retry
  exhaustion, pagination dedup/truncation, additionalParams passthrough, unicode
  titles, a request that outlives `timeoutMs` (real AbortController path, no
  timer stub), and a fixtures-secret-scan tuned to Kaiten's actual credential
  shape (`Bearer`, the vault key `API_TOKEN`, and a high-entropy heuristic —
  Kaiten tokens have no fixed prefix, unlike porkbun's `pk1_`/`sk1_`) with its
  own poison self-test.
- Added `extensions/models/kaiten_coverage_test.ts` (coverage) — `asArray`'s
  `data`/`items`/`results`/fallback branches, `itemId`'s null-skip,
  `backoffMs`'s `X-RateLimit-Reset` branch (kaiten_test.ts covers only
  `Retry-After`), `kget`'s empty-value param drop, `listCards`'s
  condition/archived string mapping and summary slug naming, a schema-boundary
  rejection sweep (non-positive ids, an out-of-enum `condition`), and a pin that
  `globalArguments.token` is NOT `.meta({ sensitive })` today (documented
  hardening gap, mirrors the porkbun precedent — not fixed here). Deliberately
  does NOT re-test `resolveBase` (already fully covered by kaiten_test.ts).
- Added `extensions/models/kaiten_property_test.ts` (property-invariant-flow,
  `fast-check@4.8.0` pinned, `FC_NUM_RUNS`-gated) — request-builder injectivity
  modulo documented normalization (a canonical, non-colliding arbitrary; a named
  collapse example for an `additionalParams` key colliding with a named filter),
  response-parser round-trip + dedup, a pagination-count invariant, and `slug`'s
  charset property (holds universally) plus idempotence (holds only modulo the
  48-character truncation edge, with the truncation-trailing-dash collapse
  pinned as a named example).
- Added `fixtures/` — pure doc/schema-derived synthetic Kaiten wire-shape
  fixtures (`spaces`, `boards`, `columns`, `cards`, `card`, `error`) plus
  `PROVENANCE.md`, which explicitly forbids any live capture from the real
  `kaiten` model instance or the real `kaiten` vault (key `API_TOKEN`).
- `deno.json`: default `test` task is now network-less
  (`--allow-env=FC_NUM_RUNS` only, no `--allow-net`/`--allow-read`); added
  `test:soak` for the high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (kaiten bundles
  no Claude skill). Removed from `quality-allowlist.txt` in the same change.

## 2026.06.21.1

Initial release: read-only Kaiten work-management REST API wrapper —
`listSpaces`/`getSpace`, `listBoards`/`getBoard`, `listColumns`,
`listCards`/`getCard`, with Bearer token auth, offset/limit pagination up to
`maxResults`, and transparent 429 retry/back-off honoring `Retry-After` /
`X-RateLimit-Reset`.
