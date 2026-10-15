# Changelog

## 2026.10.15.9

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.8

### Fixed

- `parseSummary`, `articles` and `article` no longer crash on a malformed API
  response. `String()` and `Number()` on a JSON object whose `toString` /
  `valueOf` is not callable (e.g. `{"toString": ""}`) threw "Cannot convert
  object to primitive value" and aborted the run. Untrusted scalars now go
  through `str()` / `toNumber()`, which accept only strings and numbers. Found
  by the property suite at nightly-soak scale; both counterexamples are pinned
  as regression tests.

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

## 2026.09.09.2

Initial release of `@magistr/habr`: read a Habr user's publications and full
article bodies from Habr's public `/kek/v2` JSON API, no credentials required.

- `list-articles` fans out over every page of a user's feed in one run and
  writes one `articles` resource, newest first. `maxPages` caps the fan-out.
- `get-article` fetches one publication by numeric id with its HTML body
  (`textHtml`) and a block-aware plain-text rendering (`text`).
- `get-articles` fetches several ids in one run, one `article` resource per id.
- The user alias, article id and language are shape-checked before they are put
  in a URL. Every request and every redirect hop is checked against a host
  allowlist (the configured base host, `habr.com`, `*.habr.com`).

### Fixed (found while writing the test suites)

- `decodeEntities` threw a `RangeError` on a numeric reference above U+10FFFF
  (for example `&#99999999;`), which aborted the whole method run. Such a
  reference is now left as-is.
- The `lang` global argument was put in the query string and the article URL
  path without a check, so a value such as `ru&user=other` could add query
  params. It is now validated (2–8 letters). A server-supplied `lang` that fails
  the same check is replaced by the configured language.
- A non-numeric `pagesCount` produced `NaN`, which the `articles` schema
  rejects. A very large `pagesCount` made the page loop unbounded. The value is
  now coerced to an integer from 1 to 500. A fractional `maxPages` is floored.
- Non-numeric statistics and a `NaN` `readingTime` produced `NaN` fields that
  failed schema validation. They now become `0` and `null`.
- `htmlToText` put a blank line between list items and treated tags such as
  `<link>` as list items. List items are now single-spaced, the end of a list
  ends a paragraph, and only a real `<li>` gets a bullet.
