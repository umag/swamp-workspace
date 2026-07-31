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
