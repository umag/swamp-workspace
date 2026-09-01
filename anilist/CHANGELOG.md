# Changelog

## 2026.09.01.1

### Added

- `update-progress` gained an optional `customLists` argument, and `userlist`
  now selects `customLists` so the current membership can be read first.

AniList treats `customLists` as an **absolute set** on write: it replaces the
entry's entire custom-list membership with whatever is passed. Sending an
omitted or partial list therefore silently drops the entry from every other
custom list.

Two consequences are baked into the implementation rather than left to the
caller to remember:

- the argument is forwarded **only** when the caller explicitly supplies one, so
  an ordinary progress update cannot wipe membership as a side effect;
- `[]` is the documented way to remove an entry from all custom lists.

`model.version`/`manifest.yaml` move `2026.08.30.1` -> `2026.09.01.1`. Purely
additive — no stored resource is reshaped.

## 2026.08.30.1

### Added

- **`repeat` on `update-progress`** — AniList's rewatch counter. This is how a
  FINISHED rewatch is actually recorded: the entry stays `COMPLETED` and the
  counter goes up. Setting `status: REPEATING` instead means "currently
  rewatching" and leaves `repeat` at 0, so it was not a substitute. The argument
  is ABSOLUTE, not an increment — read the current value and pass `value + 1`.

  The mutation now declares `$repeat: Int`, forwards it to `SaveMediaListEntry`,
  and reads it back in the selection set; a declared-but-unforwarded variable is
  silently ignored by AniList, so `UPDATE_PROGRESS_MUTATION` is exported and
  pinned by a test. `watchProgress` gained a `repeat` field.

  Omitting `repeat` omits it from the variables entirely rather than sending
  `null`, which would CLEAR an existing count; `repeat: 0` is still sent, since
  0 is the meaningful "reset my rewatches" value and a truthiness check would
  swallow it. Both are pinned by tests.

- **`repeat` is now SELECTED by `USERLIST_QUERY`** and carried on the userlist
  entry schema. Without it the field read back as absent whether or not the
  write landed — a write you cannot read back is indistinguishable from one that
  failed, which is exactly how this was caught in use. A test pins the
  selection. 167 tests pass.

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.17.1

Reconciles this package with the main-repo copy that had forked away from it,
and adds completed/dropped verdict detection to the activity notifier.

**The fork.** `~/dev_tmp/swamp/extensions/models/anilist.ts` — not a
`swamp extension source` of this package, just a parallel copy — is what
actually runs and what is deployed to `swamp serve`. The two diverged from a
common ancestor at `2026.07.27.1`: this package gained the AL1-AL4 hardening,
JSDoc and the `upgrades` chain, while the main repo independently gained the
`#AniList` heading hashtag (`2026.07.30.2`) and the ClickHouse `lookup` method
(`2026.08.16.1`). Neither side ever had the other's work. Resolved as a real
three-way merge against the `2026.07.27.1` ancestor; the four conflicts were all
"both sides added code next to the same comment". **Consequence worth stating
plainly: production had been running without the AL1-AL4 hostile-response guards
this package shipped on 2026-08-02.** This release is the first time they reach
the deployed notifier.

### Added

- **Completed/dropped verdict detection** on `recent-activity`. `dropped`
  activity was filtered out entirely by `isConsumptionActivity` (commented as
  "list housekeeping … noise") and `completed` was folded into a watch range by
  `mergeActivities`, so neither was ever a visible event — a 7-day sample over
  the live tracked users surfaced three real drops that had been silently
  discarded. New `isStatusChangeActivity` / `isReportableActivity` (which widens
  the consumption set by exactly one status), `partitionActivities` (splits
  verdicts out of the progress rows) and `mergeStatusChanges` (dedupes per
  `(user, mediaId, status)`; best known score wins, since score enrichment is
  best-effort and a duplicate may carry `null`).
- Both renderers grew an optional trailing status-changes section:
  `buildRichMessage` adds a `Status changes` paragraph (bold profile-linked
  user, verb, linked title, score) and `formatActivityMessages` the HTML
  equivalent. The footer became `N users · M titles · K status changes`, with
  users counted across BOTH sections so a drop from someone with no progress
  rows is not uncounted, and the titles clause dropped when only verdicts
  landed.
- `statusChanges` + `statusChangeCount` on the `activityFeed` resource — added
  to the resource SCHEMA as well as the write, since the schema strips unknown
  keys and would otherwise have made the verdicts unqueryable while the digest
  still displayed them.
- **`includeStatusChanges`** method argument (default `true`) — set it `false`
  to restore the previous progress-only digest with no redeploy, since it is a
  workflow step input rather than anything baked into the extension.

### Changed

- Both renderers take the status list as an OPTIONAL second parameter, so every
  pre-existing call site and assertion is untouched.
- `buildRichMessage opens with a '#AniList activity' header` and
  `sanity: model exposes exactly the N documented methods` updated — they had
  been asserting pre-fork behavior (no hashtag, 11 methods) that the main repo
  superseded long ago.

## 2026.08.02.1

Real fixes for the four latent bugs (AL1-AL4) filed against `gql()`'s
request/retry path in the local `anilist-latent-bugs` issue-lifecycle model,
plus the test-backfill work that originally characterized them (both land in
this one release). `anilist.ts` is modified — the four fixes are localized to
`gql()`, its rate-limit state, and the call sites that thread the new
per-invocation client through; the pure-helper surface and every GraphQL
query/mutation const are untouched.

### Fixed

- **AL1** — a 200 response with `{data:null}` and no `errors[]` no longer
  null-derefs downstream with an uncaught `TypeError`: `gql()` now throws a
  typed `Error` ("200 response with null data and no errors") when both are
  absent. `recent-activity`'s per-user activities fetch is now wrapped in a
  try/catch (mirroring the existing user-id-resolution step), so one user's
  hostile/malformed page is recorded in `usersFailed` and the fan-out continues
  for every other tracked user instead of aborting the whole run.
- **AL2** — a non-JSON 200 response body (e.g. a WAF/CDN error page) no longer
  crashes `gql()` with an uncaught `SyntaxError`: the body is now read once via
  `response.text()` and the `JSON.parse` is guarded, producing the same handled
  `AniList API error: non-JSON 200 response body: <body>` shape the non-ok path
  already used.
- **AL3** — 429-in-body detection no longer relies on an exact
  `e.status === 429` numeric equality: a numeric-string status (`"429"`), or a
  missing `status` field paired with a rate-limit-shaped `message` ("rate limit"
  / "too many request"), are now both recognized and retried (sleep 60s) instead
  of falling through to the generic `AniList GraphQL errors:` throw.
- **AL4** — the module-level `rateLimit` object (shared by every request in the
  process) is gone. `gql()` is now built per-invocation via
  `makeGql(authToken?)`, which closes over its own `{remaining, resetAt}` state;
  `fetchAllPages`/`refreshMetadata` take the caller's `gql` client as a
  parameter instead of reaching for a module-level one, and every method's
  `execute()` creates exactly one client for its own invocation. A
  low-remaining/future-reset response from one method call can no longer force
  an unrelated later call to pre-flight-sleep. Deleting the global means any
  un-migrated call site fails `deno task check` rather than silently reverting
  to shared state.

Adversarial suite: six pins flipped from characterizing the bug to asserting the
fix (`anilist_adversarial_test.ts`) — the two `data:null` pins (`search` and
`recent-activity`), the non-JSON-body pin, the two 429-in-body-shape pins (now
FakeTime retry-success assertions matching the numeric-status sibling), and the
module-`rateLimit`-coupling pin (now asserts independent per-invocation state,
`waited === 0`). The contract-fixture, methods, coverage, and
property-invariant-flow suites are unaffected by the fix (they exercise
well-formed fixtures) — 144 tests before and after, same count, six assertions
changed shape. Suite header comments across all five test files reworded: the
four suites above still characterize unchanged behavior, and the adversarial
suite now documents AL1-AL4 as fixed rather than pinned bugs.

`manifest.yaml`/`anilist.ts` version bumped to `2026.08.02.1`; added an identity
`upgrades[]` entry (`toVersion: "2026.08.02.1"`,
`upgradeAttributes: (old) => old`) since `globalArguments` is unchanged. JSDoc
added to the ~23 exported symbols in `anilist.ts` (converted from `//` block
comments), earning the `symbols-docs` quality factor now that `anilist.ts` is an
active fix target rather than a frozen characterization surface —
`quality.yaml`'s ratchet moves from a measured 92% to a measured 100% (14/14,
`allPassed`).

Out of scope: `update-progress`/`set-score`'s mutation paths use raw
`fetch`+`resp.json()` (not `gql()`), share AL2's non-JSON-body shape, but are
not in the filed catalogue and are already null-safe via optional chaining —
left unchanged.

### Test backfill (wave-2c, `ext-quality-bf-anilist`, child of `ext-quality-test-backfill`)

- Added `extensions/models/anilist_test.ts` (contract-fixture — pins the
  concrete AniList GraphQL wire shapes for all 11 methods from
  `fixtures/*.json`, plus the three ingest query-const invariants
  (`LIST_INGEST_QUERY` / `USERLIST_QUERY` / `METADATA_INGEST_QUERY`) migrated
  from the old file), `anilist_methods_test.ts` (methods — every one of the 11
  methods' happy+error paths, args schema-parsed via
  `model.methods.<m>.arguments.parse()` before `execute()`; `update-progress`/
  `set-score` exercised via their own direct-fetch/error path incl. the
  title-resolve sub-query and auth-required guards; `recent-activity`
  constrained to `telegramModel=""`/`dryRun=true` — see the subprocess-boundary
  note below; the ingest-scores end-to-end characterization migrated here),
  `anilist_adversarial_test.ts` (adversarial — the HTTP-200-with-`errors[]` pin
  (anilist correctly THROWS here, unlike the seadex/seanime swallow-bug class),
  the two hostile-200 pins (`data:null`-no-errors, non-JSON-200-body — both
  characterized as bugs when this suite was first added, and FIXED later in this
  same release, see "Fixed" above), 429/5xx retry-with-backoff under FakeTime,
  two pins on the fragile 429-in-body `e.status===429` exact-equality check
  (likewise later fixed), a pin on the module-level shared `rateLimit` coupling
  unrelated calls (likewise later fixed), a hostile-activity-payload guard pin,
  argv-injection guards (`isValidModelName`, `telegramChatId`), credential
  non-leak across every response-body-echoing throw site
  (`gql`/`update-progress`/`set-score`/`clickhouseInsert`/
  `clickhouseDistinctMediaIds`) plus Bearer/`X-ClickHouse-Key` header checks,
  and a fixtures-secret-scan with a per-pattern poisoned-sanity backstop),
  `anilist_coverage_test.ts` (coverage — every pure-helper guard migrated
  verbatim from the old file, plus the compressRanges/mergeActivities/
  buildRichMessage/formatActivityMessages concrete examples), and
  `anilist_property_test.ts` (property-invariant-flow — fast-check invariants
  for `compressRanges` honesty/dedupe, `mergeActivities` group-count,
  `advanceCursor` monotonicity, and `filterNewActivities` cross-checked against
  an independent oracle reimplementation) — 0 tests before this change, 144
  after.
- Added `fixtures/` — 11 doc-derived, synthetic GraphQL wire-shape fixtures
  (`search`, `media-details`, `userlist`, `trending`, `seasonal`, `watching`,
  `activities`, `user-id`, `list-ingest`, `metadata`, `graphql-error`) plus
  `PROVENANCE.md`. No live call was made against the public AniList API, and no
  read of any kind was made against the live ClickHouse charting instance
  backing `user_scores`/`anilist_metadata` (both hold real usernames/scores).
  All usernames/media ids/titles are synthetic; the old file's four real,
  live-tracked usernames (`Magistr`, `akemiv`, `rn144mg`, `InFar`) do not appear
  anywhere in this change.
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak (`FC_NUM_RUNS=10000`). `imports` map is unchanged (`{ zod }`
  only); test deps (`jsr:@std/assert@1`, `jsr:@std/testing@1/time`,
  `npm:fast-check@4.8.0`) are pinned direct specifiers in the test files
  themselves.
- `README.md`: refreshed from the stale 4-method doc (which also showed the
  WRONG instance type `@magistr/api`@`2026.05.25.1`) to the real 11-method
  surface, correct type/version (`@magistr/anilist`@`2026.07.27.1` at the time,
  now `2026.08.02.1`), and the `accessToken`/`clickhouse*` globalArguments the
  mutation and charting methods require.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (anilist bundles
  no Claude skill — a bare GraphQL wrapper model, nothing to document as a
  skill); `watch`/`canary` stay `backlog` (exempt from the allowlist gate per
  STANDARD.md). `ratchet` is a MEASURED score
  (`swamp extension quality manifest.yaml --json`), not assumed/copied from a
  sibling — re-measured again for the `2026.08.02.1` fix (see "Fixed" above).
- Removed from `quality-allowlist.txt` in the same change (shrink-only guard —
  `quality-offenders.baseline.txt` is untouched, write-once, anilist stays
  listed there forever as the immutable seed record).

## 2026.07.27.1

Prior release: `search`, `get`, `userlist`, `trending`, `watching`, `seasonal`,
`update-progress`, `set-score`, `recent-activity` (Telegram notifier fan-out),
`ingest-scores` and `refresh-metadata` (ClickHouse charting pipeline).
