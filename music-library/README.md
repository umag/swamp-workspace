# @magistr/music-library

Multidimensional catalog of a music share — built from an existing
[gonic](https://github.com/sentriz/gonic) scan index instead of a filesystem
traversal, with tag-encoding recovery and directory-naming fallback.

## Why no filesystem traversal?

On unraid, `/mnt/user` is a FUSE aggregation over every array disk; a recursive
scan wakes all of them. gonic already paid that cost during its own scheduled
scans, so this model reads gonic's SQLite index (`gonic.db`) over SSH
(`sqlite3 -json -readonly`) and never lists a directory. The only per-file disk
access is the explicit single-file `probe` method.

## The cube

`scan` writes a star schema into swamp data:

| Resource    | Count        | Content                                           |
| ----------- | ------------ | ------------------------------------------------- |
| `album`     | one per dir  | facts: album → disc → track nesting               |
| `artist`    | one per name | dimension: albums, variants, genres, year span    |
| `dimension` | 4            | rollups: genres, years/decades, formats, quality  |
| `issues`    | 1            | untagged, dirname-only, encoding fixes, 8.3 names |
| `library`   | 1            | summary: totals, source breakdown, cardinalities  |

Query along any axis with CEL, e.g.:

```bash
swamp data query <instance> 'attributes.kind == "album" && attributes.year < 1990'
swamp data get <instance> dim-genres
data.latest("<instance>", "artist-<slug>-<hash>").attributes.albums
```

## Encoding recovery

Legacy single-byte tags (ID3v1, ID3v2.3 with a latin1 encoding byte) written in
cp1251 / koi8-r / cp866 / Shift-JIS / GBK come out of any spec-compliant tagger
as latin1 mojibake ("Êëàóäèî Ìîíòåâåðäè"). The model re-encodes such strings to
their original bytes, walks jschardet's ranked candidates restricted to the
`legacyEncodings` allowlist (global argument, default
`windows-1251, koi8-r, ibm866, shift_jis, gbk`), and re-decodes. Double-encoded
UTF-8 ("BÃ¶ses" → "Böses") is unwrapped first.

Two structural gates prevent false positives on genuine Western accented text:
every word containing a high byte must be ≥85% high-byte letters (legacy
Cyrillic words are all-high-byte, Icelandic "Blóð" is not), and the re-decoded
result must be Cyrillic-dominated for Cyrillic charsets. Every fix is recorded
in `issues.encodingFixes` with before/after and the detected charset.

## Directory-naming fallback

Tracks with missing/placeholder tags ("Unknown Artist", "Track 1") get
artist/album/year/track number parsed from paths:

- `1983. Mike Oldfield - Crises (2013) (Super Deluxe Edition) [24-96]`
- `Carbon Based Lifeforms - ALT-02 (2020)` / `(LFTFLD21) …` catalog prefixes
- `1996 - The Devil's Songs` (artist from the parent directory)
- `2008, [Ice Ages] Buried Silence (CD, Album)` bracketed artists
- `CD1` / `Disc 2` subdirs → disc number, album from the parent
- `01 - Title.mp3`, `Artist - 05 - Title.flac`, `01 House Of Pain`

Per-field provenance is kept (`source: tags|dirname|mixed`, `fallbackFields`,
`fixedFields`) so tag-repair worklists can be derived.

## Playback verification

`verify` decodes files with ffmpeg inside the container and reports unreadable
(`failed`), corrupt (`errors`), and `truncated` files:

- **full** mode decodes every sample and compares the decoded duration with the
  indexed one (catches mid-file corruption and truncation);
- **quick** mode seeks near the end of each file (offset comes from the duration
  already in the gonic index) and decodes only the tail — an order of magnitude
  faster, still catches unreadable files and truncation.

Work is spread over parallel SSH workers, each running a serial remote decode
loop; results land in a `verify` resource per scope with counts and a `problems`
worklist (error excerpts, expected vs decoded duration).

```bash
swamp model @magistr/music-library method run verify <instance> \
  --input "pathPrefix=Some Artist" --input mode=quick
swamp model @magistr/music-library method run verify <instance> \
  --input "path=Artist/Album/01 - Track.mp3"    # single file, full decode
```

## Triage report

`@magistr/music-verify-triage` (a model-type default report) runs after every
method execution and renders the newest `verify` resource into an actionable
worklist: unreadable files (with non-audio-junk suspicion), truncation split by
cause (known-incomplete sources / VBR-suspect big gaps / real losses),
systematically damaged directories (≥8 bad files → re-source the album, with
healthy-duplicate hints from the `dupes` resource), lossless corruption, and an
isolated-glitch count. It never throws — with no verify data it renders a
pointer to run `verify` first.

```bash
swamp report get @magistr/music-verify-triage --model <instance> --markdown
```

## What's missing — the wanted derivation

Answers "what music do I want that I do not have", as a **derived set** rather
than a stored status. The want list is recomputed from scratch on every run, so
it cannot drift out of sync with the library on disk — which is the failure mode
of tools that keep a mutable per-album status column.

Run the three steps **in this order**; they span two model instances:

```bash
# 1. artist name -> MusicBrainz ID map (this model)
swamp model method run <instance> resolve-artists

# 2. cache each artist's discography (the musicbrainz model, NOT this one)
swamp model method run <musicbrainz-instance> sync-artist-discographies

# 3. derive the gap (this model, pure — no network)
swamp model method run <instance> wanted
```

Each step fails with an error naming the command you skipped, so getting the
order wrong is loud rather than silently producing an empty gap report.

**`resolve-artists`** seeds the map for free from a headphones instance, whose
artists are already MusicBrainz-keyed, then falls back to token-set MusicBrainz
search for whatever the seed does not cover. Artists it cannot resolve
confidently are **parked, never guessed** — exact-string matching against
MusicBrainz fails in both directions (`Miles Davis` is rejected against the sort
form `Davis, Miles`, while `Bill Brown` matches `James Brown` at score 100), so
a name matching two distinct MBIDs is reported as ambiguous with its competing
candidates rather than resolved to whichever came first. The
`resolved`/`ambiguous`/`unresolved` counts are top-level fields, so a run that
parked 300 artists looks different at the CLI from one that resolved them.

**`wanted`** is pure — no network at all — and emits two kinds of want:
`missing` (in the discography, absent from disk) and `upgrade` (present but
below a target quality bucket). Where a title match is uncertain it defaults to
treating the album as **present**, because a false want costs a junk download
while a false "have" only costs a missed album; flip it with
`--input uncertainMatchPresent=false`.

Entries are deliberately flat, so the result is queryable directly:

```bash
swamp data query 'modelName == "<instance>" && name == "wanted" && isLatest' \
  --select 'content.wants.filter(w, w.kind == "missing").map(w, w.artist)' --json
```

```bash
swamp report get @magistr/music-wanted --model <instance> --markdown
```

The report renders totals, missing grouped by artist (biggest gaps first),
upgrade candidates grouped by current quality (worst first), and the artists
needing human review. That last section is the point of parking rather than
guessing, so it is first-class output.

### Why not a self-hosted MusicBrainz mirror?

The discography sync is rate-limited to MusicBrainz's public 1 req/sec, making a
full pass a batched, resumable ~38-minute operation. A local mirror would remove
that limit, and was evaluated and rejected: Postgres live-data-feed replication
over the internet, and resuming it cleanly after a restart, costs more to
operate than the sync costs to run. If it is ever revisited, a periodic full
dump reload is the simpler path than incremental replication for read-only
discography data — a full reload is idempotent and restart-safe by construction,
which is precisely what incremental replication is not.

## Setup

```bash
swamp extension source add <path-to>/music-library
swamp model create @magistr/music-library music \
  --global-arg host=192.168.88.242
# optional overrides: sshUser, dbPath, container, containerMusicRoot, hostMusicRoot

swamp model @magistr/music-library method run scan music
swamp model @magistr/music-library method run probe music \
  --input "path=Artist/Album/01 - Track.mp3"
```

`scan` arguments: `pathPrefix` (limit to a subtree), `maxAlbums` (cap for test
runs), `dryRun` (compute + write only the summary).
