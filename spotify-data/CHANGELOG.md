# Changelog

## 2026.08.02.1

First release of `@magistr/spotify-data` — an offline importer for a Spotify
"Extended streaming history" GDPR export.

### Model

`@magistr/spotify-data` with two methods, both idempotent and neither making a
network call or holding a credential:

- `inspect` — reports record counts, the music/podcast/audiobook split, per-year
  distribution and date range **without** writing a year chunk. Writes one
  `inspection.<label>` resource.
- `import` — writes one `spotify.<year>` resource per calendar year plus an
  `import.<label>` state resource. An optional `year` argument narrows the run
  to a single calendar year.

Chunks are partitioned exactly like `@magistr/lastfm`'s scrobble chunks so the
two sources stay comparable. A year chunk carries no wall-clock field, so
re-importing an unchanged export rewrites identical bytes rather than minting a
new data version every run.

### Privacy boundary

Every export record carries `ip_addr`, and most carry `conn_country`, `platform`
and `incognito_mode` — a location and device trail spanning years. All four are
dropped in `toStream`, the single point every record passes through, and never
reach a resource. `incognito_mode` is dropped rather than stored as `false`, so
a private play and an ordinary one are byte-identical in the stored row.

This is treated as the model's security property rather than a nicety: the
committed fixture carries all four fields on every record so their absence is
observable, and a property test asserts no generated secret value survives
`toStream` under any record shape.

### Fidelity

Podcast episodes and audiobook chapters are excluded, but every music stream is
kept regardless of play time. Last.fm only recorded plays past its ~30s
threshold, so the sub-threshold tail is what this source uniquely adds;
filtering by play time is left to the reports, which report `total` (every
stream) and `listens` (past 30s) as two deliberately non-interchangeable
numbers.

### Deduplication keys on the whole record

Identity is the entire normalized record, not `(ts, artist, track)`. On a real
15,607-record export, 546 groups share that triple: 469 are byte-identical
export artifacts, correct to collapse, but 77 differ in `ms_played` and
sometimes `reason_start`/`reason_end` — plays Spotify emitted as several
segments stamped with one end second. The coarser key would have discarded them
as duplicates and silently lost real playback data. The key's delimiter is NUL,
since a printable separator makes `("a b", "c")` and `("a", "b c")` collide.

### Reports

- `@magistr/spotify-stats` — playcounts, hours, top artists/tracks by both
  playcount and time, skip rate, and year/hour/`reason_end` distributions.
- `@magistr/listening-overlap` — cross-references against a `@magistr/lastfm`
  instance. Matching is one-to-one within a tolerance window (default 600s),
  because Spotify's `ts` is an END timestamp while Last.fm's `date.uts` is a
  START timestamp, and because a naive "any counterpart exists" test
  double-counts repeated plays. Artist ranking folds spelling variants, merging
  the `Za Frûmi` / `Za Frűmi` split that costs that artist half their real
  playcount on Last.fm.

### Tests

All five suites present, 89 tests:

- contract-fixture (11) — the parse boundary against the documented export
  record shape, including the privacy pins and the UTC year boundary
- methods (18) — both methods' success and failure paths against real temp-dir
  exports
- adversarial (14) — hostile export content, the privacy boundary under attack,
  and key/name collision
- coverage (18) — one test per guard, including the empty-`episode_name` case
  that would otherwise classify every music play as a podcast
- property-invariant-flow (11 + 27 report tests) — no-loss, idempotence, order
  independence, key soundness and privacy totality under `fast-check`

Fixtures are hand-authored rather than captured: a real export is one of the
most personal files a person owns, and committing even a redacted slice would
put that trail one `git log` away. See `fixtures/PROVENANCE.md`.
