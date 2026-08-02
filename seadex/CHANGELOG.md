# Changelog

## 2026.08.02.2

Relocates the `@magistr/seadex-upgrades` report from the main `swamp` repo into
this extension so the workspace becomes its single source of truth.
`model.version` / `manifest.yaml` bump `2026.08.02.1` → `2026.08.02.2`, with an
identity `upgrades[]` entry (`upgradeAttributes: (old) => old` — no resource
schema change).

- Added `extensions/reports/seadex_upgrades.ts` — copied verbatim from the
  already-fixed main-repo version. Renders anime with available SeaDex best
  releases, scored/sorted by user metadata (`userScore`/`userStatus`/
  `userSeason`/`userYear`) passed in via `lookup-many`. Reads the durable
  `upgradeFilter` marker resource (written by `render-upgrades`) as the
  authoritative filter source when present — it persists the last-requested
  filter across report runs regardless of which method triggered the report —
  falling back to `methodArgs` only when no marker resource exists (e.g. an
  older seadex model that predates the marker).
- `manifest.yaml` gains a `reports:` section listing
  `extensions/reports/seadex_upgrades.ts` (the bundling list); `model.reports`
  in `extensions/models/seadex.ts` already declared
  `["@magistr/seadex-upgrades"]` (the model's require list) — both are kept in
  sync.
- Added `extensions/reports/seadex_upgrades_test.ts` — stubs `dataRepository` to
  pin the marker-present-overrides-methodArgs precedence and the
  no-marker-falls-back-to-methodArgs behavior described above.

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

## Follow-up issues from the test backfill — ALL FIXED in 2026.08.02.1 below

Tracked in the local `seadex-latent-bugs` issue-lifecycle model (these are
latent bugs in our own extension, not swamp-product issues, so they were NOT
filed to the swamp.club Lab). At the time this section was originally written,
these 8 issues were pinned-but-not-fixed (seadex.ts was byte-frozen); every one
of them is now REAL-FIXED in `2026.08.02.1` (see that section for the per-bug
detail): render-upgrades being a permanent no-op (LB1, HIGH); AniList
GraphQL-level errors (`{errors,data:null}` at HTTP 200) being silently swallowed
as an ordinary no-match (LB2, HIGH); `lookup-many`'s per-item try/catch not
covering the entry-writeResource loop, so one bad write discarded the whole
batch (LB3, HIGH); errored fan-out items being undercounted (lumped into
`notInSeadex` with no separate error tally) (LB4, MED); duplicate input
`anilistId`s clobbering the same `al-<id>` resource key (LB5, MED); neither
upstream response being runtime-validated, so a type-confused Pocketbase
`file.length` (string), an entirely-missing `items`/`title` key, a malformed
`expand.trs` array element, or a non-JSON 200-OK body crashed instead of
degrading (LB6, MED); a server-returned `alID` diverging from the resource key
derived from the request (LB7, LOW); and `infoHash` never being normalized
(case/whitespace) (LB8, LOW). A hostile non-array `tags` value passing through
verbatim, and hostile `notes`/error-body text being stored/thrown verbatim with
no redaction, remain OUT OF SCOPE (not tracked latent bugs — seadex is
credential-less, so the latter is a trust-boundary observation, not a credential
leak) and stay byte-frozen.

## 2026.08.02.1

Real-fix (not byte-frozen) for all 8 latent bugs tracked in the LOCAL
`seadex-latent-bugs` issue-lifecycle model (3 HIGH). `model.version` /
`manifest.yaml` bump `2026.07.16.2` → `2026.08.02.1`, with a single `upgrades[]`
entry (`upgradeAttributes: (old) => old` — neither resource addition touches
`globalArguments`).

- **LB1 (HIGH)** `render-upgrades` was a permanent no-op that wrote an all-zero
  `summary` marker regardless of its filter arguments. It now writes a new
  `upgradeFilter` resource (`{year, status, minScore, title, timestamp}`) whose
  fields ECHO the caller's year/status/minScore/title arguments (`null` when
  omitted) — a real, observable effect.
- **LB2 (HIGH)** `anilistFindIdByTitle` silently swallowed AniList GraphQL-level
  errors (`{errors, data:null}` at HTTP 200) as an ordinary no-match. It now
  inspects the parsed `errors[]` array and rejects with
  `anilist graphql errors: <joined messages>` — distinct from both the
  HTTP-failure `anilist search failed:` prefix and a legitimate no-match (which
  still writes `found:false`). Pocketbase is never called once this rejects.
- **LB3 (HIGH)** `lookup-many`'s entry-writeResource loop (and the summary
  write) ran outside any per-item try/catch, so one write rejecting (e.g. a
  real-runtime schema-validation failure) discarded the whole batch and the
  summary was never written. Both the per-entry writes and the summary write are
  now individually try/catch-isolated: one poisoned write is dropped, but every
  other entry still lands and the summary is always attempted.
- **LB4 (MED)** An errored fan-out item was lumped into `summary.notInSeadex`
  identically to a legitimate not-found result, with no error tally. Per-item
  fetch failures are now tracked in a separate `erroredIds` set; the new
  `summary.errors` field counts them, and they are excluded from `notInSeadex`.
- **LB5 (MED)** Duplicate `anilistId`s in one `lookup-many` call wrote the same
  `al-<id>` resource key twice (a real datastore write would clobber the first)
  and double-counted in the summary. `args.items` is now deduped by `anilistId`
  (first-wins) before fan-out.
- **LB6 (MED)** Neither upstream response was runtime-validated: a type-confused
  Pocketbase `file.length` (string) silently string-concatenated into
  `totalSizeBytes`; an entirely-missing `items`/`title` key, a malformed
  `expand.trs` element, or a non-JSON 200-OK body crashed with an uncaught
  TypeError/SyntaxError. `normaliseTorrent` now coerces file lengths numerically
  (`Number(f.length) || 0`); `fetchSeadex` guards `Array.isArray(data.items)`;
  `anilistFindIdByTitle` defaults an absent `title` object (`m.title ?? {}`);
  non-object `expand.trs` elements are filtered out before normalising; and both
  `fetchJson`/`resp.json()` call sites are wrapped so a non-JSON body degrades
  into a mapped `Error` instead of an uncaught `SyntaxError`. Fixing this
  numeric coercion also removes the old BUG-6→BUG-3 write-rejection linkage
  described in the section above (LB3 is independently fixed regardless).
- **LB7 (LOW)** `buildResult`'s found-branch used the server's own `entry.alID`
  for content, which could diverge from the resource key (derived from the
  REQUESTED id). Content now uses the requested `alID` parameter, aligning
  `al-<id>` key and content on every path.
- **LB8 (LOW)** `infoHash` passed through byte-for-byte verbatim, including
  whitespace padding and mixed case. `normaliseTorrent` now normalizes it via
  `.trim().toLowerCase()` (idempotent on well-formed 40-hex values; length
  validation is still not performed — that remains out of scope).

**Two resource-schema additions** (neither touches `globalArguments`, so the
appended `upgrades[]` entry is an identity `upgradeAttributes`): `summary` gains
`errors: number` (LB4); a new `upgradeFilter` resource (LB1) is added alongside
`entry`/`summary`.

**Byte-stability**: the contract-fixture, methods, coverage, adversarial, and
property suites stay byte-frozen except for the specific tests flipped above to
assert the fixed behavior (non-array-`tags` passthrough, files-absent,
notes/error-body verbatim, the secret-scan, primaryFile/argmax, comparisonUrls,
baseUrl-strip, slug-key construction, and the rest of the property suite are all
unchanged). No `tags` coercion was added — the non-array-`tags` pin stays frozen
by design (out of scope for this fix).

## 2026.07.16.2

Initial release: `lookup-by-anilist-id`, `lookup-by-title` (via the public
AniList GraphQL API), `lookup-many` (fan-out batch lookup), and
`render-upgrades` (filter markers for the companion upgrades report) over the
releases.moe Pocketbase API.
