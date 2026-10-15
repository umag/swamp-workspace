# Changelog

## 2026.10.15.4

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.3

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.10.1

First release.

- `import_films` builds one Ryot generic-JSON `CompleteExport` from a
  `@jamesakeech/letterboxd` export snapshot plus owned films, uploads it to
  `/backend/upload` and starts `deployImportJob(source: GENERIC_JSON)`. Watched
  and rated films get one undated seen entry, ratings become 0–100 (stars × 20),
  watchlist films go to the Watchlist collection and owned films to Owned. A
  completed non-dry run blocks later runs unless `force` is set, because Ryot
  does not dedupe seen entries.
- TMDB ids for Letterboxd films are read from each film page with the host
  `curl` and cached in `letterboxd-tmdb-map`.
- `import_reports` stores Ryot's import job reports.

### Fixed before release

- Snapshot URIs are checked before they reach `curl`: only `https` URLs on
  `letterboxd.com` / `boxd.it` are fetched, and `curl` runs with
  `--proto =https`. A URI such as `-o /path` or `--config=...` was passed to
  `curl` as an option.
- An upload response that is not a JSON array of strings is rejected. A bare
  string response was indexed to its first character and used as the path.
- Non-JSON 200 responses from the upload and GraphQL endpoints fail with a clear
  message instead of a raw `SyntaxError`.
- The Letterboxd retry loop no longer sleeps after the final attempt.
