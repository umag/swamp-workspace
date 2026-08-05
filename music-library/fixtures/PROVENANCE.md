# Fixture provenance

Every file in this directory is **pure hand-authored synthetic data** — never
captured from a live `gonic.db`, a real SSH session, or a real `ffprobe`/
`ffmpeg`/`essentia` invocation against any host in this homelab. This mirrors
the `observability-agent`/`skype`/`talos-node` backfill precedents (synthetic
fixtures, no live capture) and is a deliberate security decision, not an
oversight.

## What was NOT done (standing prohibition)

A real `@magistr/music-library` instance exists in this homelab (see
`reference_music_library_extension.md`), targeting a real gonic index over a
real unraid host. **Live capture from any real target host, over any real SSH
connection, is FORBIDDEN** for this fixture corpus — not "not done this time",
but a standing rule for anyone regenerating these fixtures later:

- No `swamp model method run <instance> <scan|dupes|verify|bpm|probe>` call was
  made against any real `@magistr/music-library` instance while authoring these
  fixtures.
- No real artist, album, or track name from any managed library appears anywhere
  in this corpus or in the test suites that consume it — every
  artist/album/track name below is an invented placeholder.
- No real SSH key, host key, or `known_hosts` entry was read, exported, or
  otherwise touched.
- No real listening history, personal music collection inventory, or filesystem
  layout is reflected here.

## Shapes

Each file pins the exact wire shape `music_library.ts` parses at its SSH/
subprocess boundary:

| File                | Shape                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `tracks.json`       | `sqlite3 -json` row array for `TRACKS_SQL` — the `GonicRow` shape (`id`, `filename`, `tag_title`, …) |
| `genres.json`       | `sqlite3 -json` row array for `GENRES_SQL` (`track_id`, `name`)                                      |
| `verify_files.json` | `sqlite3 -json` row array for `VERIFY_SQL` (`filename`, `length`, `left_path`, `right_path`)         |
| `probe.json`        | `ffprobe -print_format json -show_format -show_streams` output for one file                          |

`tracks.json`'s 8 rows exercise, on purpose: a fully-tagged two-track album
(`Echo Fields - Aurora Drift`), a dirname-fallback album with no tags at all
(`1998. Salt Wire - Night Drift`), a cp1251-mojibake artist tag
(`Êëàóäèî
Ìîíòåâåðäè` — the SAME invented Monteverdi phrase already used in
`music_library_test.ts`'s own `fixEncoding` unit tests, not new sensitive data),
a two-disc box set collapsed via `CD1`/`CD2` subdirs (`Nebula Ridge - Box`), and
a various-artists compilation (`VA - Night Radio`, `compilation: 1`).

`verify_files.json`'s 4 rows back the `verify`/`bpm` methods' happy-path and
failure-path tests; the test suites assign each file's decode OUTCOME (ok /
failed / errors / truncated) via the stubbed remote script, not via anything
encoded in this fixture itself — the fixture only supplies the worklist (path +
expected duration), exactly like the real `VERIFY_SQL` result would.

## Every value is synthetic

- SSH target hostname: `music.example` — an IANA-reserved
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) example domain, never a
  real host in this homelab.
- Artist/album/track names (`Echo Fields`, `Aurora Drift`, `Salt Wire`,
  `Night Drift`, `Nebula Ridge`, `Night Fox`, `Salt Lamp`, `Night Radio`,
  `Early Music Ensemble`) are invented placeholders with no relationship to any
  real recording artist or release.
- File sizes, bitrates, and durations are round, realistic-looking numbers, not
  observed values.

## Fixtures-secret-scan

The adversarial suite's fixtures-secret-scan (mirroring the
`observability-agent` precedent) walks the already-imported `fixtures/*.json`
objects for RFC1918/real-host/PEM/high-entropy shapes as a mechanical backstop —
not the primary control. The primary control is this prohibition plus never
running a live call in the first place.

## headphones + musicbrainz fixtures (`headphones_artists.json`, `mb_release_groups.json`)

These two files pin the wanted-list feature's two new external wire shapes,
alongside the same standing prohibition as everything above: **no live capture
was performed against any real `headphones` or `musicbrainz` instance or API in
this homelab**, and none is permitted for anyone regenerating this corpus later.
No `swamp model method run` call was made against a real headphones or
musicbrainz instance while authoring these fixtures; every artist name,
release-group title, and identifier below is invented.

| File                           | Shape                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headphones_artists.json`      | headphones artist-index response — `{ artists: [{ ArtistID, ArtistName, Status }], total, timestamp }`                                                                                                                                                                                                                           |
| `mb_release_groups.json`       | MusicBrainz `browse` response for `entity=release-group&artist=<id>` — `{ entity, linkedEntity, linkedId, results[], count, offset, timestamp }`                                                                                                                                                                                 |
| `mb_release_groups_empty.json` | The SAME browse shape for an artist with a legitimately empty discography (`results: []`, `count: 0`) — a separate file so each fixture's top level mirrors the wire response exactly                                                                                                                                            |
| `mb_artist_search_batch.json`  | MusicBrainz `search-artists-batch` response — `{ batchId, queries: [{ query, artists[], count, error? }], deferred[], requested, searched, failed, truncated, stopReason, timestamp }`, the shape template `resolve-artists`' batch-search result mapping (musicbrainz-ratelimit-runmodel-fanout) reads back via `readModelData` |

### All MBIDs/UUIDs in this corpus are invented

Every `ArtistID`, release-group `id`, and `linkedId` value in these two files is
a **hand-invented, syntactically-valid UUID** (correct 8-4-4-4-12 hex form) —
never a real MusicBrainz identifier copied from `musicbrainz.org` or from any
real headphones instance. This matters specifically for this corpus: a real MBID
is a stable, public pointer to one real artist, so pasting one into a fixture —
even attached to an invented display name — would leak a factual claim about the
owner's actual collection ("this real artist is tracked/wanted"). Inventing the
UUID removes that leak entirely. The UUIDs here are built from well-known
hexspeak placeholder words (`deadbeef`, `cafebabe`, `feedface`, `deadc0de`,
`decafbad`, `fa57f00d`, `f01dab1e`, `5ca1ab1e`, `c001d00d`, `da7aba5e`,
`abadcafe`, `8badf00d`, `baadf00d`) so they are visibly synthetic to anyone
reading the fixture, not just statistically unlikely to collide with a real one.
`mb_release_groups.json`'s `linkedId` intentionally reuses
`headphones_artists.json`'s `Velvet Static` `ArtistID` (and
`emptyBrowse.linkedId` reuses the `Halcyon` `ArtistID`) purely for corpus
coherence — one invented artist across both fixtures — not because either ID is
real.

### What each fixture's rows exercise on purpose

`headphones_artists.json`'s 6 entries exercise: a plain single-token name
(`Halcyon`), a multi-token name (`Velvet Static`), a name already in MusicBrainz
`"Last, First"` sort-name form (`Marrow, Iris` — so downstream sort-name
matching logic has a case where display name and sort name coincide), a name
containing a Lucene metacharacter (`Coastline [Dub]`, brackets), a `Paused`
status (`Drift Collective`, the only non-`Active` row), and one more plain
multi-token name (`Nebula Choir`) to round out `total: 6`.

`mb_release_groups.json`'s 7 `results` rows exercise: a plain `Album`
(`Salt Static`), an `EP` (`Night Coil`), a `Single` (`Glass Horizon`), a
`secondary-types: ["Live"]` release (`Salt Static (Live at Harbor Hall)`), a
`secondary-types: ["Compilation"]` release
(`Velvet Static: The Collected
Works`), a release with a FUTURE
`first-release-date` of `2099-06-15` well beyond 2030 (`Static Horizon`, to
exercise date-sanity handling), and a title that differs from a plausible
on-disk directory name only by bracketed noise (`Salt Static (Remastered 2015)`
vs. the plain `Salt Static` row above, to exercise title-normalisation
matching). The nested `emptyBrowse` object is a second, independent browse
response with `results: []` and `count: 0` — a legitimately-empty discography
for a different artist, distinguishing "we asked MusicBrainz and it has nothing"
(cached empty) from "we never asked" (no cache entry at all).

`mb_artist_search_batch.json` is the SHAPE TEMPLATE for `search-artists-batch`'s
happy path and the contract-fixture key-set pin only — it is never the property
test's data source, since the caller generates `batchId` at runtime and
fast-check generates fresh names per run, neither of which a static fixture can
supply (see `runModelHandler` in the methods/adversarial suites). Its 2
`queries` rows exercise a resolved hit (`Fixture Aurora Static`, `sort-name`
present) and a per-query `error` (`Fixture Nightfall`) — distinguishable from a
legitimately empty result, which carries no `error` key at all. `deferred`
carries one query never reached this run (`Fixture Deferred Artist`), with
`truncated: true` and `stopReason: "max-queries"` recording why. `batchId` and
every artist `id` use the same hexspeak-UUID family as the other MusicBrainz
fixtures in this file (`deadbeef`, `cafebabe`, `facefeedface`) — invented, never
a real MusicBrainz identifier.
