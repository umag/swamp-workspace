# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2b, full build,
`ext-quality-bf-seadex`, child of `ext-quality-test-backfill`). No behavior
change — `seadex.ts` and `manifest.yaml` are byte-for-byte unchanged and the
model `version` stays `2026.07.16.2`.

- Added `extensions/models/seadex_test.ts` (contract-fixture — pins BOTH
  upstream wire envelopes offline: the releases.moe Pocketbase list envelope
  with `expand.trs` isBest-split/totalSizeBytes-summed/primaryFile-argmax/
  comparisonUrls-split, and the public AniList GraphQL `{data:{Media}}` envelope
  including the two-hop POST body), `seadex_methods_test.ts` (methods — all 4
  methods happy + failure paths, including all THREE distinct `lookup-by-title`
  outcomes: AniList-hit+Pocketbase-hit, AniList-hit+Pocketbase-miss (the
  load-bearing middle branch, keyed `al-<id>` not `q-<slug>`), and
  AniList-no-match), `seadex_adversarial_test.ts` (adversarial — AniList
  HTTP-200-with-`errors` swallowed as not-found, the AniList
  title-key-entirely-absent, Pocketbase items-key-entirely-absent, and
  Pocketbase malformed-`expand.trs`-element TypeError crashes, non-JSON-200-body
  SyntaxError crashes on both upstream contracts, the un-isolated `lookup-many`
  write-phase failure (BUG-3, pinned with an explicit poisoned `writeResource`)
  kept separate from the harness-fidelity `totalSizeBytes` string-coercion pin
  (BUG-6), duplicate-id key clobber, server-alID-vs-key divergence, infoHash
  verbatim passthrough, hostile non-array `tags` passthrough, hostile-content
  trust-boundary pins (verbatim `notes`/error-body, no redaction), and a
  fixtures-secret-scan with a `distinctCharCount` entropy escape + per-pattern
  poisoned sanity), `seadex_coverage_test.ts` (coverage — both sides of every
  guard: isBest partition extremes, comparisonUrls split/trim/filter, baseUrl
  trailing-slash stripping, the userMeta present-vs-absent structural difference
  between `lookup-by-anilist-id` and `lookup-many`, `fetchSeadex`'s items[0]
  pick, the concurrency `Math.min` guard, and slug-key construction),
  `seadex_property_test.ts` (property-invariant-flow — fast-check, the
  lookup-many partition/summary invariant stated order-independently over unique
  ids plus a named pin proving completion order diverges from input order,
  totalSizeBytes/fileCount/primaryFile over unique-length file sets, isBest
  partition total+disjoint, normalise determinism/injectivity over a canonical
  infoHash-only-varies subset) — 0 tests before this change, 79 after.
- Added `fixtures/` — pure doc-derived, synthetic wire-shape fixtures for BOTH
  upstreams (`pocketbase-entry`, `pocketbase-empty`, `anilist-media`,
  `anilist-nomatch`, `anilist-graphql-error`) plus `PROVENANCE.md`. No live call
  was made against releases.moe or graphql.anilist.co; every value is synthetic
  (`.example` URLs per RFC 2606, invented AniList id/title, repeated-character
  infoHash placeholders). seadex is credential-less (no vault secret exists), so
  the live-capture ban is framed around the actual hazard — durably binding a
  real infoHash + real anime title (i.e. copyrighted torrent content) into this
  repository's history — not a credential-leak rationale copied from a sibling
  extension.
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak (`FC_NUM_RUNS=10000`). `imports` map is unchanged (`{ zod }`
  only); test deps (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`) are pinned
  direct specifiers in the test files themselves.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (seadex bundles
  no Claude skill — a bare Pocketbase/AniList wrapper model, nothing to document
  as a skill); `watch`/`canary` stay `backlog` (exempt from the allowlist gate
  per STANDARD.md). `ratchet` is a MEASURED Grade-A score
  (`swamp extension quality manifest.yaml --json`), not carried forward from a
  sibling.
- Removed from `quality-allowlist.txt` in the same change (shrink-only guard —
  `quality-offenders.baseline.txt` is untouched, write-once, seadex stays listed
  there forever as the immutable seed record).

## Follow-up issues (pinned here, not fixed — seadex.ts is byte-frozen)

Tracked in the local `seadex-latent-bugs` issue-lifecycle model (these are
latent bugs in our own extension, not swamp-product issues, so they are NOT
filed to the swamp.club Lab): render-upgrades is a permanent no-op (filter args
accepted but ignored); AniList GraphQL-level errors (`{errors,data:null}` at
HTTP 200) are silently swallowed as an ordinary no-match; `lookup-many`'s
per-item try/catch does not cover the entry-writeResource loop, so one bad write
discards the whole batch; errored fan-out items are undercounted (lumped into
`notInSeadex` with no separate error tally); duplicate input `anilistId`s
clobber the same `al-<id>` resource key; neither upstream response is
runtime-validated, so a type-confused Pocketbase `file.length` (string), an
entirely-missing `items`/`title` key, a malformed `expand.trs` array element, or
a non-JSON 200-OK body crashes instead of degrading; a server-returned `alID`
can diverge from the resource key derived from the request; `infoHash` is never
normalized (case/whitespace/length are not validated); a hostile non-array
`tags` value passes through verbatim into stored output; and hostile `notes`
content and Pocketbase error-body text are stored/thrown verbatim with no
redaction (seadex is credential-less, so this is a trust-boundary concern, not a
credential leak).

## 2026.07.16.2

Initial release: `lookup-by-anilist-id`, `lookup-by-title` (via the public
AniList GraphQL API), `lookup-many` (fan-out batch lookup), and
`render-upgrades` (filter markers for the companion upgrades report) over the
releases.moe Pocketbase API.
