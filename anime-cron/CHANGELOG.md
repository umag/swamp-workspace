# Changelog

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
