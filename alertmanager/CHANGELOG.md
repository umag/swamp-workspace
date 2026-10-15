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

## 2026.10.14.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.13.1

First release.

- `alerts`, `groups`, `silences`, `status` read the Alertmanager v2 API.
- `create-silence` reuses or extends a matching silence instead of creating a
  duplicate. `expire-silence` reads the silence before it deletes it.
- `status` stores a SHA-256 of the running config, never the config text.
- Matcher parsing accepts `=`, `!=`, `=~`, `!~`, quoted values containing
  commas, and amtool-style `{...}` braces. It rejects invalid label names and
  invalid regexes before any request is sent.
- Silence ids are validated before they are used in a URL path, including ids
  returned by the server.
