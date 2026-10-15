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

## 2026.10.08.1

### Added

- First release: Taelin's OptChat / UniiChat never-ending chat as a swamp model.
  Append-only chat directory, 512-byte summary tree, push-ordered view batched
  128 KB → 64 KB, compaction view 16-32 KB, ruler + "Too long" retries in the
  same conversation, up to 8 compactions at once from work queues.
- Methods `turn`, `compact`, `append`, `view`, `zoom`, `status`.
- Turns and compactions through `claude -p` stream-json; `zoom` and `date`
  served to the agent by a bundled stdio MCP server.
- Ships the `optchat` skill.
