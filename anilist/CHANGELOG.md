# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2c, full build,
`ext-quality-bf-anilist`, child of `ext-quality-test-backfill`). No behavior
change — `anilist.ts` and `manifest.yaml` are byte-for-byte unchanged and the
model `version` stays `2026.07.27.1`.

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
  the two BUG-class hostile-200 pins (`data:null`-no-errors uncaught TypeError;
  non-JSON-200-body uncaught SyntaxError), 429/5xx retry-with-backoff under
  FakeTime, two BUG pins on the fragile 429-in-body `e.status===429`
  exact-equality check, a BUG pin on the module-level shared `rateLimit`
  coupling unrelated calls, a hostile-activity-payload guard pin, argv-injection
  guards (`isValidModelName`, `telegramChatId`), credential non-leak across
  every response-body-echoing throw site
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
  surface, correct type/version (`@magistr/anilist`@`2026.07.27.1`), and the
  `accessToken`/`clickhouse*` globalArguments the mutation and charting methods
  require.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (anilist bundles
  no Claude skill — a bare GraphQL wrapper model, nothing to document as a
  skill); `watch`/`canary` stay `backlog` (exempt from the allowlist gate per
  STANDARD.md). `ratchet` is a MEASURED score
  (`swamp extension quality manifest.yaml --json`), not assumed/copied from a
  sibling.
- Removed from `quality-allowlist.txt` in the same change (shrink-only guard —
  `quality-offenders.baseline.txt` is untouched, write-once, anilist stays
  listed there forever as the immutable seed record).

## Follow-up issues (pinned here, not fixed — anilist.ts is byte-frozen)

Tracked in the local `anilist-latent-bugs` issue-lifecycle model (these are
latent bugs in our own extension, not swamp-product issues, so they are NOT
filed to the swamp.club Lab): a 200 response with `{data:null}` and no
`errors[]` present is not special-cased by `gql()`, so downstream call sites
(`search`, `fetchAllPages`, `userlist`, `recent-activity`'s activities loop)
null-deref it with an uncaught `TypeError` — the `recent-activity` case is
especially sharp since that loop is NOT wrapped in a try/catch (unlike the
user-id resolution step), so it crashes the entire fan-out for every tracked
user; a non-JSON 200 response body crashes `gql()` with an uncaught
`SyntaxError` instead of a handled AniList-specific error, since `resp.ok` is
checked before `.json()` is ever called; the 429-in-body detection keys on an
exact `e.status === 429` numeric equality, so a same-meaning error shaped even
slightly differently (status as a string, or the field renamed/absent) silently
bypasses the dedicated retry path and falls through to the generic errors-throw;
and the module-level mutable `rateLimit` object is shared across every request
in the process (not scoped per-call), so a low-remaining/future-reset response
from one method call forces a completely unrelated later call to
pre-flight-sleep. NOTE: unlike the seadex/seanime swallow-bug class, anilist
DOES correctly check `json.errors` and throws on a legitimate
200-with-`errors[]` response — the above is the milder residual class.

## 2026.07.27.1

Prior release: `search`, `get`, `userlist`, `trending`, `watching`, `seasonal`,
`update-progress`, `set-score`, `recent-activity` (Telegram notifier fan-out),
`ingest-scores` and `refresh-metadata` (ClickHouse charting pipeline).
