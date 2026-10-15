# Changelog

## 2026.10.15.8

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

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

## 2026.10.09.1

- Initial release: `search` (saved searches, new-item flags) and `item`
  (details + multilingual measurement parsing).

## 2026.10.09.2

- `item`: back off on HTTP 429 (Retry-After / exponential), keep going on
  per-item failures (recorded in `item-run`), skip already-fetched items unless
  `refresh`, accept up to 200 refs.
- `search`: `colorIds` filter.

## 2026.10.09.3

- Measurement parser: " - " clauses, number-first ("63cm de large"), flat widths
  doubled for waist/hips, "hauteur du col" as length.
- RSC placeholder strings ("$f7") fall back to ld+json.
- `item`: stops after 3 consecutive 403s (`notAttempted`).
- New `reparse` method: re-derive measurements offline from stored items.

## 2026.10.09.4

- Optional `userAgent` and `cookieFile` global arguments: reuse a browser's
  Cloudflare clearance (`cf_clearance`) when the site challenges the IP.
- Cloudflare challenges (403 + `cf-mitigated`) raise an actionable error.
