# Changelog

## 2026.10.25.1

### Changed

- README: `swamp vault put` now prompts for secrets (hidden input) instead of
  taking them on the command line, where shell history keeps them.

## 2026.10.24.1

### Added

- `recalculate` method: queues Dawarich's "Recalculate tracks & stats" (tracks,
  stats and digests) via `POST /api/v1/recalculations`, optionally for one
  `year`. The outcome is written to the new `recalculation` resource. A `409`
  (recalculation already queued or running) is recorded as `already_in_progress`
  instead of failing.
