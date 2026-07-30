# Fixture provenance

Every JSON file in this directory is **pure doc-derived synthetic data**,
hand-authored from the GraphQL query shapes `anilist.ts` already declares
(`SEARCH_QUERY`, `DETAILS_QUERY`, `USERLIST_QUERY`, `TRENDING_QUERY`,
`SEASONAL_QUERY`, `WATCHING_QUERY`, `ACTIVITIES_QUERY`, `USER_ID_QUERY`,
`LIST_INGEST_QUERY`, `METADATA_INGEST_QUERY`) plus the public AniList GraphQL
schema documented at https://docs.anilist.co. This mirrors the `porkbun`,
`seadex`, and `seanime` wave-1/2 precedents (synthetic fixtures, no live
capture), following [[lesson_port_verify_against_real_data]] for the _shape_
(field names/nesting match the real schema) while inventing every _value_.

## What was NOT done (explicit dual-upstream prohibition)

anilist is unusual among the wave-2 extensions in having **two** live upstreams
that could leak into a fixture, and both are explicitly banned as sources:

1. **The public AniList GraphQL API** (`https://graphql.anilist.co`). No
   `swamp model method run <anilist-instance> search|get|userlist|trending|
   watching|seasonal|update-progress|set-score|recent-activity|ingest-scores|
   refresh-metadata`
   call was made against the real endpoint while authoring these fixtures. No
   request was sent to `https://graphql.anilist.co` at all during fixture
   authoring.
2. **The live ClickHouse charting instance** backing the `ingest-scores` /
   `refresh-metadata` pipeline. `user_scores` and `anilist_metadata` hold REAL
   AniList usernames and REAL scores collected from the live notifier deployment
   (see `reference_anilist_chart_deployment` /
   `reference_anilist_activity_notifier` in project memory). No
   `swamp model method run` against any ClickHouse-backed model, no direct SQL
   query (`SELECT * FROM user_scores` or similar) against the live ClickHouse
   host, and no read of the anilist-chart dashboard was performed to source any
   value below. Every `list-ingest.json` / `metadata.json` row is invented.
3. **No vault read.** `accessToken` and `clickhousePassword` are both
   `meta({ sensitive: true })` globalArguments backed by real vault secrets in
   this repo's live deployment; no vault was read and no real credential value
   appears anywhere in this directory or the test suites that consume it.
4. **No real AniList username appears anywhere.** The OLD `anilist.test.ts`
   (migrated away by this change) hardcoded four real, live-tracked usernames —
   `Magistr`, `akemiv`, `rn144mg`, `InFar` — taken from the production
   `recent-activity` notifier's tracked-users list. None of those four strings
   appear in this directory or in any of the five new test suites. All usernames
   below (`fixture_watcher`, `synth_traveler`, and inline test-literal names
   such as `MixedCaseUser`) are invented.
5. **No real AniList media id or title was looked up and copied in.** `90001` /
   "Nebula Drifters", `90002` / "Static Bloom", `90003` / "Quiet Horizon" are
   invented placeholders, deliberately using a `9000x` id range that does not
   correspond to any specific real AniList entry checked during authoring.

## Every value is synthetic

- Media ids `90001`–`90003` and titles "Nebula Drifters", "Static Bloom", "Quiet
  Horizon" — invented, in an obviously-fixture `9000x` id band.
- Studio "Fixture Animation Works", staff "Aria Fixture", tags "Space" /
  "Ensemble Cast" / "Mystery" — invented, generic enough to avoid resembling any
  specific real production.
- Usernames `fixture_watcher` / `synth_traveler` (the latter appears only in
  test-literal data, not in any committed fixture) and AniList user id `4001`
  (`user-id.json`, `activities.json`) — invented; the numeric id does not
  correspond to any real AniList account checked during authoring.
- URLs use the IANA-reserved `.example` TLD
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) for image/streaming hosts
  (`fixtures.example`) — never a resolvable real host. `siteUrl` values use the
  real `anilist.co` path shape (`/anime/<id>`, `/manga/<id>`) since that URL
  shape itself is public and documented, but the ids they point at are the
  invented `9000x` placeholders above, not real entries.
- `graphql-error.json`'s `errors[]` envelope (message text, `status: 500`,
  `locations`) — a synthetic transcription of AniList's publicly documented
  GraphQL error envelope shape (errors alongside `data: null`, returned at HTTP
  200), not a captured response. The adversarial suite additionally constructs
  an inline (not committed) `{errors:[{status:429,...}],data:null}` variant to
  pin the 429-in-body retry path — that inline literal is reviewed manually, per
  the SCOPE NOTE below.
- `list-ingest.json` / `metadata.json` scores and dates are invented, including
  a deliberately malformed `startDate` (`{year:2026,month:13,day:40}` on media
  id 90003) to exercise `formatDate`'s null-on-malformed / year-still-populated
  behavior through the wire shape, not copied from any real ClickHouse row.

## SCOPE NOTE (mirrors seadex/musicbrainz precedent)

The adversarial suite's `fixtures-secret-scan` mechanically scans only the 11
committed fixture JSON files in this directory — it does NOT scan the test
files' own inline hostile-payload string literals (e.g. sentinel credential
values used in the credential-non-leak tests, the inline 429-in-body payload
above). Those are reviewed manually. Prefer adding new hostile wire-shape
corpora to this directory (where the mechanical scan protects them) over inline
literals when a value could plausibly resemble a real secret.

## Per-file mapping to the documented query

| File                 | Query                   | Documented shape                                                                                                                |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `search.json`        | `SEARCH_QUERY`          | `{data:{Page:{pageInfo,media[]}}}` — two media results, one anime, one manga                                                    |
| `media-details.json` | `DETAILS_QUERY`         | `{data:{Media:{...}}}` — single media with studios/staff/relations/recommendations/tags/externalLinks                           |
| `userlist.json`      | `USERLIST_QUERY`        | `{data:{MediaListCollection:{lists[]}}}` — two lists (Completed, Planning)                                                      |
| `trending.json`      | `TRENDING_QUERY`        | `{data:{Page:{pageInfo,media[]}}}` — one trending result                                                                        |
| `seasonal.json`      | `SEASONAL_QUERY`        | `{data:{Page:{pageInfo,media[]}}}` — one seasonal result with `nextAiringEpisode`                                               |
| `watching.json`      | `WATCHING_QUERY`        | `{data:{MediaListCollection:{lists[].entries[]}}}` — CURRENT list, one airing/one finished                                      |
| `activities.json`    | `ACTIVITIES_QUERY`      | `{data:{Page:{pageInfo,activities[]}}}` — 3 activities, one consumption, one non-consumption ("plans to watch"), one completion |
| `user-id.json`       | `USER_ID_QUERY`         | `{data:{User:{id,name}}}`                                                                                                       |
| `list-ingest.json`   | `LIST_INGEST_QUERY`     | `{data:{MediaListCollection:{lists[],hasNextChunk}}}` — score 0 (kept), decimal score (kept), null score (dropped)              |
| `metadata.json`      | `METADATA_INGEST_QUERY` | `{data:{Page:{pageInfo,media[]}}}` — one well-formed entry, one with a malformed `startDate`                                    |
| `graphql-error.json` | any query               | `{errors:[...],data:null}` at HTTP 200 — a GraphQL-level error, not an HTTP error                                               |

`activities.json`'s "plans to watch" item exercises `isConsumptionActivity`
filtering out list-housekeeping noise directly through the wire shape (the same
invariant `anilist_property_test.ts` proves for arbitrary inputs).
`list-ingest.json`'s three entries (score 0 / decimal / null) exercise
`buildScoreRows`'s keep-zero / keep-decimal / drop-null behavior through the
wire shape, matching the migrated end-to-end ingest-scores characterization from
the old `anilist.test.ts`.
