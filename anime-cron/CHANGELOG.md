# Changelog

## 2026.09.01.1

- **`parseEpisode` now reads the `SxxExx` form.** The bare E-prefix pattern
  documented itself as covering "S01E05", but `\b` before the `E` never fires
  when a digit precedes it, so every `S01E09`-style release parsed as `null` and
  `pickBest` had nothing to rank. Seen live on 2026-09-01: Koukaku Kidoutai
  (2026) ep 9 — Erai-raws (the group behind eps 1–8, dash form) never posted,
  and all nine other 1080p releases (VARYG, Judas, DKB, ToonsHub, Ironclad,
  Cattleya) used `S01E09`, so the show sat in `not-found` for five hourly runs.
  A dedicated `\bS\d{1,2}E(\d{1,3})\b` check now runs right after the `- NN`
  fansub convention.

## 2026.08.22.2

- **An inferred airing time no longer drives an alert.** The not-found branch
  derives `airedAtSec` from `nextAiringAt`, but on a cache-backed run that
  timestamp is projected — and on a SEEDED list it is simply the capture
  instant. With `epsBehind = 0` it therefore measured the age of the cache
  rather than of the episode, so past the 30-minute grace every show read as
  overdue on every run: 13 shows produced an identical "Aired 298min ago — not
  yet on Nyaa" every hour.

  The overdue Telegram alert is now gated on `listSource === "anilist"`. The
  not-found outcome is still recorded, so the run report shows exactly what was
  missing; only the page is withheld until AniList answers and the times are
  real again. The "queued" alert is deliberately NOT gated — a started download
  is a fact regardless of where the list came from.
- **New `alertsSuppressed` count on `fetchResult`**, so a withheld page is
  visible rather than silent. It is incremented independently of whether
  `telegramModel` is configured, which is also what makes the behaviour
  testable: `sendTg` spawns `swamp` via `Deno.Command`, so a fake
  `context.runModel` observes nothing and such a test passes vacuously. The new
  test pairs the cache case with an AniList-path positive control.
- **`listSource` and `listAgeSeconds` are now declared in `FetchResultSchema`.**
  They shipped in 2026.08.22.1 and worked — undeclared keys pass through — but
  carried no schema or description.

## 2026.08.22.1

- **Merged the two divergent copies of this model into one.** The main repo's
  `extensions/models/anime_cron.ts` was the LIVE file and this package was
  inert; each had work the other lacked. Reconciled with the repo behaviour kept
  where they conflicted: `pickBest` restores the HARD resolution floor
  (`h.resolution >= targetRes`) rather than the soft ranking tried here, and the
  `"varyg": 7` preferred-group score is back. The property test's oracle now
  applies the same floor — mirroring only the scoring made it nominate winners
  pickBest had already discarded.
- **New `seed-watchlist` method.** Rebuilds the watch-list cache from the most
  recent `fetchResult` for the case the cache cannot cover: AniList went down
  BEFORE any run had cached the real list. Progress per show comes from the
  strongest signal available (`duplicate` means that episode is already in
  Transmission, anything else means it is still owed), taking the highest across
  outcomes. Airing times are INFERRED from the capture, so the payload is
  flagged `seeded: true` and the next successful AniList read replaces it.
  Refuses to overwrite an existing cache without `force`.
- **Resource instances renamed to `watchlist-current`.** `writeResource` takes
  (spec, INSTANCE) but `readResource` takes the INSTANCE — so the cache both
  read the wrong key and collided with `fetchResult`, which already owns the
  instance name `current`.

- **`fetch-airing` keeps working while AniList is down.** Every successful run
  now caches the CURRENT list to a `watchlist` resource, and a failed AniList
  read falls back to it instead of aborting the run. On 2026-08-22 three
  consecutive hourly runs failed on `AniList 403` and nothing downloaded for
  three hours; nothing about downloading needs AniList reachable, only knowing
  what is being watched.
- **The cached list is projected forward, not replayed.** `lastAiredEp` is
  derived as `nextAiringEp - 1`, so a raw snapshot would conclude nothing new
  had aired and download nothing — the very failure it exists to fix. TV anime
  airs weekly, so episodes aired since the capture are the whole weeks elapsed
  since `nextAiringAt`, plus the one airing at that instant. Capped at the
  season total so a finished show is never projected past its last episode.
- **New `maxCacheAgeDays` global argument (default 14).** Past that the run
  fails as before: shows end and new ones start, so downloading against a
  month-old list is worse than failing loudly. A cache with an unparseable
  timestamp counts as infinitely old.
- **`fetchResult` gains `listSource` and `listAgeSeconds`**, so a run served
  from a stale list is visible rather than looking identical to a healthy one.
- No behaviour change when AniList is reachable, and AniList-down with no cache
  still rejects exactly as before.

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.08.1

Added `fetch-archive`: a preservation-archive sweep that pulls every Nyaa
release credited to a set of release groups and pins it to seed forever.

Motivation: groups like Kineko Video and LonelyChaser publish fresh 16mm/35mm
film scans, LaserDisc Domesday captures and VHS restorations of material that
never got a digital release. Keeping a complete, permanently-seeding copy is the
point — but the existing `fetch-airing`/`upgrade-bd` methods are both driven off
an AniList list, and none of this catalogue is on one.

- **New method `fetch-archive`.** Pages Nyaa's RSS (75/page, `maxPages`
  default 10) once per group, keeps only releases whose leading `[..]` credit
  actually names a wanted group, dedups by infoHash across groups, queues the
  rest flat into the archive dir, and issues one batched `torrent-set` with
  `seedRatioMode: 2` + `seedIdleMode: 2` (Transmission's "unlimited", which
  overrides the session defaults per torrent).
  - Group matching splits collabs on `& + , /` and prefix-matches in both
    directions behind a 5-character stem floor, so a wanted `LonelyChaser`
    catches the `LonelyChaser-Raws` alias and a wanted `Kineko Video` catches a
    bare `Kineko`, while a short token cannot wildcard onto every group. A title
    that merely _mentions_ a group without crediting it in the bracket is not
    swept.
  - Idempotent: it reads live Transmission state first and reports already-held
    releases as duplicates. `seedForeverExisting` (default true) re-applies
    unlimited seeding to everything already in the archive dir, so a re-run
    repairs torrents added before this method existed.
  - `category` defaults to `0_0` (all) because these groups also post
    live-action scans outside the anime categories.
  - Reports `queuedGB`/`catalogGB` so a `dryRun` answers "how much disk will
    this cost" before anything is queued.
  - Optional Telegram summary lists what was snatched (capped at 20 titles + an
    overflow count, to stay under Telegram's 4096-char limit).
- **New global argument `archiveContainerDir`** (default `/anime/kineko`) — the
  download dir inside the Transmission container for these rips.
- **`NyaaHit` gains `sizeBytes`**, parsed from `<nyaa:size>` by the new
  `parseNyaaSize` helper (returns 0 for anything unparseable, so a missing size
  can never NaN a running total).
- New exported pure helpers, all unit-tested: `parseNyaaSize`, `decodeEntities`,
  `escapeHtml`, `bracketGroups`, `normGroup`, `creditsGroup`.

Tests: 117 pass. Added `fetch-archive` cases across the contract-fixture (pure
helpers), methods (happy path, idempotent re-run, dryRun-mutates-nothing,
per-group search failure isolation, seeder floor, empty-group rejection) and
adversarial (HTML-injection escaping at the Telegram subprocess boundary, group
impersonation outside the credit bracket, credential-leak sweep) suites. The
`sanity: model exposes exactly the N documented methods` pin moved 4 → 5, and
the two `NyaaHit` literal builders in the existing suites gained `sizeBytes`.

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave 2c, full build,
`ext-quality-bf-anime-cron`, child of `ext-quality-test-backfill`). No behavior
change — `anime_cron.ts` and `manifest.yaml` are byte-for-byte unchanged and the
model `version` stays `2026.07.16.2`.

- Added `extensions/models/anime_cron_methods_test.ts` (methods — all 4 methods
  happy + error path against a stubbed AniList GraphQL / Nyaa RSS / Transmission
  RPC / SeaDex `fetch` and a stubbed `Deno.Command` for the `sendTg` Telegram
  subprocess, plus a credential-leak sweep across written resources, log calls,
  the subprocess argv, and the stdin payload), `anime_cron_adversarial_test.ts`
  (adversarial — hostile/malformed Nyaa RSS and AniList payloads, title
  path-traversal into the download-dir, the Transmission 409-session-id
  handshake tested both ways plus an unbounded-retry-depth pin, SeaDex's two
  distinct "not found" wire shapes, a server-echoed-credential non-redaction pin
  contrasted with Transmission's non-leaking error path, live
  `torrent-duplicate`/`transmission-add-failed` Transmission acks for both
  `fetch-airing` and `upgrade-bd`, `mark-watched`'s `SaveMediaListEntry`
  mutation-failure path, `upgrade-bd`'s uncaught `seadexLookup()` exception
  path, `fetch-airing`'s swallowed pre-load Transmission failure verified
  end-to-end, the `sendTg` fire-and-forget swallow of a throwing subprocess, an
  array-args-only command-injection negative, and a fixtures-secret-scan),
  `anime_cron_coverage_test.ts` (coverage — both sides of every guard:
  skipUnaired, the all-eps-downloaded boundary, existingSet dedup hit/miss,
  mark-watched's no-token-throw vs dryRun-bypass, the sinceHours doneDate window
  boundary, upgrade-bd's on-disk-skip vs different-release-group fallthrough
  plus its case-sensitivity asymmetry, the unknown-Transmission- status
  "status-N" fallback, an empty torrent list, and the 30-minute overdue-alert
  grace boundary), `anime_cron_property_test.ts` (property-invariant-flow —
  fast-check, gated by `FC_NUM_RUNS`: the precise outcome-partition invariant
  for `fetch-airing` — FetchResultSchema has NO error counter, so a naive
  `sum == outcomes.length` is false whenever an error-status outcome exists —
  `pickBest` order-invariance, dedup re-run idempotency, `disk-stats`' exact
  byte-level conservation, and `buildMagnet` injectivity/determinism over the
  canonical hex-hash subset) — 29 tests before this change (contract-fixture
  only), 95 after (66 new).
- Added `fixtures/` — pure doc-derived, synthetic AniList/Transmission/SeaDex
  wire-shape fixtures (`anilist-watching`, `anilist-completed`,
  `anilist-media-search`, `anilist-save-entry`, `transmission-torrent-get`,
  `transmission-torrent-add`, `seadex-entry`, `error`) plus `PROVENANCE.md`. No
  live call was made against any real `@magistr/anime-cron` model instance;
  every media id, torrent hash, and timestamp is synthetic. The Nyaa RSS wire
  body is deliberately NOT committed as a fixture — it is built in-test via a
  synthetic `rss(hits[])` helper (mirrors `victorialogs`'s in-test `ndjson()`
  helper), keeping the committed corpus JSON-only; see `PROVENANCE.md` for the
  full rationale.
- Documented split from the seanime/porkbun precedent: the pre-existing
  contract-fixture suite (`anime_cron_test.ts`, kept byte-unchanged) only pins
  the pure, exported helper functions (`parseEpisode`, `parseResolution`,
  `groupScore`, `buildMagnet`, `baseTitle`, `pickBest`, `toFolderName`,
  `extractShowTitle`) — `anime_cron.ts`'s wire parsers (`parseRSS`,
  `gqlRequest`, `txRpc`, `seadexLookup`) are module-private, so the HTTP
  wire-envelope pins live in the methods suite instead. See
  `fixtures/PROVENANCE.md` for the full explanation.
- Every suite drives `model.methods.<m>.execute()` against a stubbed `fetch`
  (the `(globalThis as any).fetch = stub` no-cast idiom, no
  `as typeof globalThis.fetch` direct cast) and a stubbed `Deno.Command` (for
  `sendTg`), pinning already-shipped behavior — including several characterized
  quirks (tracked in the local `anime-cron-accounting-quirks` issue-lifecycle
  bug model, NOT the Lab, and NOT fixed here since `anime_cron.ts` is
  byte-frozen):
  - `mark-watched`'s `could-not-parse-episode` branch increments NEITHER
    `updated` NOR `failed` — `checked` can exceed `updated + failed`.
  - `FetchResultSchema` has no error counter; error-status outcomes
    (`nyaa-fetch-failed`, `transmission-add-failed`) are counted by none of the
    four returned fields.
  - `downloadDir.startsWith(prefix)` has no path-separator boundary check — a
    sibling directory like `/anime/tv-extra` spuriously matches a configured
    prefix of `/anime/tv`.
  - `disk-stats`' `totalGB`/`downloadedGB`/`remainingGB` are independently
    rounded — `gb(total)` does not generally equal
    `gb(downloaded) + gb(remaining)`; the exact conservation invariant only
    holds at the bytes level.
  - Newly found during this backfill (not in the original bug list, pinned as
    characterization, not filed as new bugs): `upgrade-bd`'s release-group
    comparison lowercases only the SeaDex side, so a library-supplied
    `releaseGroup` in its original mixed case never matches and the show is
    re-queued instead of skipped as on-disk; `upgrade-bd`'s uncaught
    `seadexLookup()` exception aborts the whole run (unlike `fetch-airing`'s
    per-show-isolated Nyaa failure); `txRpc`'s 409 session-id retry has no depth
    cap.
- `deno.json`: `test` task flips to network-less + run-less
  (`--allow-env=FC_NUM_RUNS extensions/models/ --permit-no-files`); `check`
  aligns to source-only (`anime_cron.ts`), relying on the network-less `test`
  task to type-check every `*_test.ts` file; added `test:soak` for the
  high-count nightly property soak. `imports` map is unchanged (`{ zod }` only);
  test deps (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`) are pinned direct
  specifiers in the test files themselves. The pre-existing
  `anime_cron_test.ts`'s remote `https://deno.land/std@0.224.0/assert/mod.ts`
  import (kept byte-unchanged) is already pinned by hash in `deno.lock` and
  resolves offline from the local module cache under the network-less task —
  confirmed by running `deno task test` end-to-end.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (anime-cron
  bundles no Claude skill). `ratchet` stays `baselinePercentage: 0` with an
  honest label — the live registry scorer exits 1 on anime-cron's unearned
  `symbols-docs` factor (50% JSDoc coverage vs the 80% threshold), which
  predates this change and is unfixable here since `anime_cron.ts` is
  byte-frozen; `score_ratchet.ts` reports an unscorable extension as SKIPPED,
  never a CI failure, so this stays green.
- Removed from `quality-allowlist.txt` in the same change (shrink-only guard —
  `quality-offenders.baseline.txt` is untouched, write-once).

## 2026.07.16.2

Initial release: `fetch-airing` (AniList CURRENT list → Nyaa → Transmission,
with multi-episode catchup, name-based dedup, and optional Telegram alerts),
`mark-watched` (completed Transmission torrents → AniList progress sync),
`upgrade-bd` (AniList COMPLETED list → SeaDex → Transmission BD upgrades), and
`disk-stats` (Transmission torrent disk usage by status).
