# Changelog

## 2026.08.19.1

- Version bump and smoke test

All notable changes to `@magistr/lastfm` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are CalVer (`YYYY.MM.DD.N`), matching the swamp extension registry.

## [Unreleased]

## [2026.07.27.1] — 2026-07-27

Initial release.

### Added

- **Model `@magistr/lastfm`** — read-only client for the Last.fm 2.0 web API.
  Every method is an unauthenticated `user.*` / `artist.*` / `album.*` /
  `track.*` read, so an API key is the only credential required: no OAuth flow,
  no session key, no MD5 request signing.
  - Lookups: `profile`, `loved-tracks`, `artist-info`, `album-info`,
    `track-info` — the three `*-info` methods report the user's own playcount
    alongside global figures.
  - Charts: `top-artists`, `top-albums`, `top-tracks` over the six standard
    periods, plus `weekly-chart-list` and the three weekly range charts.
  - `sync-history` — an idempotent fan-out that pages `user.getRecentTracks`
    into one `scrobbles.<year>` resource per calendar year, plus a
    `history.<user>` resource carrying the sync cursor and per-year counts.
    Supports `from`/`to`, `resyncYear` (the only way to shed scrobbles deleted
    upstream), `limit`, and a `maxPages` safety cap.

- **Report `@magistr/lastfm-stats`** — a model-scope report over the synced
  history, deriving what the API's six fixed periods cannot express: per-year,
  per-month, per-weekday and per-hour distributions, unique artist/album/track
  counts, days with listening, the longest consecutive-day streak, and top lists
  over the whole history. Timezone-aware via an explicit IANA zone, defaulting
  to UTC.

### Security

- The base URL is pinned to `https://ws.audioscrobbler.com/2.0/`, and a
  non-`https:` `baseUrl` override is rejected at the argument boundary rather
  than requested. The published docs give an `http://` API root, and Last.fm
  offers no header-auth alternative — `api_key` travels as a query parameter on
  every request, so plaintext would expose the credential on the wire.
- `apiKey` is marked sensitive, so swamp never persists it in cleartext.
- Every URL passes through a redaction helper before it can reach an error
  message, a log line, or a fixture.

### Notes on correctness

- Last.fm reports failures as **HTTP 200 with an `{error, message}` body**.
  Codes are classified permanent (6, 10, 26 — fail fast) or transient (8, 11,
  16, 29 — retry with exponential backoff). Unknown codes are treated as
  permanent, because repeating an unrecognised failure at speed is how an API
  key ends up suspended.
- `sync-history` pins its `to` bound for the whole walk. `getRecentTracks` pages
  newest-first, so without a fixed upper bound a scrobble arriving mid-walk
  shifts every page boundary and silently drops a track.
- The now-playing entry carries no `date.uts` and is excluded from history; it
  is surfaced separately on the `history` resource. Admitting it would corrupt
  the cursor and double-count the track once it is really scrobbled.
- A walk truncated by `maxPages` **holds** the cursor rather than advancing it.
  Because paging is newest-first, a truncated run leaves a gap at the old end;
  advancing to the newest timestamp would put that gap permanently behind the
  cursor.
- Year chunks carry no wall-clock field, so re-syncing an unchanged year
  produces byte-identical data instead of minting a new version every run.
- Chunks are written **before** the cursor advances, so a crash between the two
  re-fetches a range that dedup absorbs rather than skipping it.

[Unreleased]: https://github.com/umag/swamp-workspace/compare/master...HEAD
[2026.07.27.1]: https://github.com/umag/swamp-workspace/releases/tag/lastfm-2026.07.27.1
