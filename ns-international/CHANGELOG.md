# Changelog

## 2026.10.15.7

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.6

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.5

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

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

## 2026.09.19.1

First release.

- `stations` fetches the NS station directory and caches it as `station-index`;
  with `query` it lists matching stations by name or code.
- `plan` resolves `from`/`to` (name, NS code or UIC) and returns ranked journey
  options with per-leg train, operator, crowding, the cheapest fare found and a
  `bookingUrl` (ns.nl for domestic, NS International for cross-border). Planning
  only: NS has no public booking API.
- `disruptions` lists active disruptions and maintenance, with `isActive` and
  `type` filters.

### Fixed before release

- `disruptions` wrote its snapshot under the data name `latest`, which swamp
  reserves; every real run would fail. It now writes `current`.
- A trailing slash on `baseUrl` produced `//v3/trips`; the base is now
  normalised.
- Malformed responses (a JSON `null` body, non-array `trips`/`fares`, `null`
  trips, legs or disruptions) crashed the methods; they are now skipped.
- `plan` rejects a non-ISO-8601 `dateTime` and a `travelClass` other than 1 or 2
  before sending a request, and a blank station name no longer reports a
  misleading "ambiguous" match.
- An empty `apiKey` is rejected before any request is sent.

### Tests

- Hand-authored contract fixtures and the five quality suites (contract,
  methods, adversarial, coverage, property), all with `fetch` stubbed.
