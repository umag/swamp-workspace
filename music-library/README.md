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
# 1. artist name -> MusicBrainz ID map (this model), seeded from a
# headphones instance (default "headphones") and falling back to a
# musicbrainz instance (default "musicbrainz") for whatever the seed does
# not cover
swamp model method run <instance> resolve-artists \
  --input headphonesInstance=<headphones-instance> \
  --input musicbrainzInstance=<musicbrainz-instance>

# 2. get the artist list, then cache each artist's discography (the
# musicbrainz model, NOT this one)
swamp data query 'modelName == "<instance>" && name == "artist-map" && isLatest' \
  --select 'attributes.entries.filter(e, e.status == "resolved").map(e, e.mbid)' --json
# That prints a query envelope, {"results": [[...the MBIDs...]], "total": 1};
# pass the single element of "results" as the artistMbids array below, not
# the whole document.
swamp model method run <musicbrainz-instance> sync-artist-discographies \
  --input 'artistMbids:json=["<mbid>","<mbid>"]'

# 3. derive the gap (this model, pure — no network)
swamp model method run <instance> wanted \
  --input musicbrainzInstance=<musicbrainz-instance>
```

Step 2 is the expensive one: at MusicBrainz's public 1 req/sec a cold pass over
~775 artists is ~775 requests and takes ~35 minutes, and it prints nothing until
it finishes. It holds the `musicbrainz` model lock for that whole time, and
`swamp model method run` only waits up to 60 seconds (`DEFAULT_LOCK_TIMEOUT_MS`,
see below) for a contended lock before timing out — avoid starting it while
anything else needs that instance's lock. An interrupted pass persists its
cursor and counts, so a re-run continues rather than repeating.

Step 2 throws when given no artist list and step 3 throws when the discography
cache is missing, both naming a runnable command.

The whole sequence is also wired as one gated workflow, shipped in this package
as `extensions/workflows/music-wanted.yaml` (`@magistr/music-wanted-sequence`) —
it carries the artist list between the two instances for you, gates each
hand-off with an assert, and refuses to derive a want set from an incomplete
catalog. **Installing this extension does NOT make it runnable**:
`swamp extension pull` / `extension source add` do not register a workflow file,
so nothing under that name exists until you create it yourself. Create it with
`swamp workflow create`, paste the file's body in, and invoke it under whatever
name you gave it. The three commands above remain the portable form and need no
workflow at all.

Run it without `--fail-on`. The default fails the run on ANY assert, including
the medium-severity want-total sanity band and the medium-severity artist-map
floor. `--fail-on high` downgrades both to warnings — use it only in CI, and
read the assert results rather than the exit code.

**Retargeting instance names.** The workflow body hardcodes three literal swamp
model instance names — `music` (this model, matching the `Setup` section below),
`musicbrainz`, and `headphones` (the seed instance `resolve-artists` reads by
default) — repeated across several token classes, not confined to one line. The
three step `modelIdOrName` targets (`music`, `musicbrainz`, `music`) are NOT
workflow inputs: a dynamic step target does not remove swamp's step-input
validation, it keeps the check and makes it report `passed: true` while
verifying nothing, so parameterising them would have silently turned three of
the workflow's 22 `swamp workflow validate` checks into checks that always pass.
`headphonesInstance` and `musicbrainzInstance`, by contrast, ARE plain method
arguments, already explicit literals on the resolve and wanted steps —
retargeting those two is just editing their values, with no step-target risk.

If your own instances are named `music`, `musicbrainz`, and `headphones` — the
names this README's own examples use — the file runs as pasted, with no edits.
If any are named differently, retarget the affected one(s) with a WHOLE-WORD
(`\b`-bounded) find/replace, in this order:

1. Replace every whole-word `musicbrainz` with your instance name FIRST —
   `musicbrainz` contains `music` as a substring, so replacing `music` first
   would corrupt `musicbrainz` into `<newname>brainz`.
2. Then replace every remaining whole-word `music` with your instance name.
3. Replace every whole-word `headphones` with your instance name — this one does
   not overlap the other two, so its position in the order does not matter.

Each replacement must move together across every token class it appears in, or a
gate queries an instance the step never wrote to and fails by indexing `[0]` on
an empty result:

- the three step `modelIdOrName:` values;
- the `headphonesInstance` / `musicbrainzInstance` step-input literal values on
  the resolve and wanted steps;
- every gate's `data.query('modelName == "<name>" && ...')` CEL predicate, in
  both `expr` and `message`;
- the two `data.latest("<name>", ...)` calls in `read-discography-sync-cursor`'s
  `expr` and `message` — miss these and a rename makes
  `data.latest(...) == null` true against a model that no longer exists, so the
  step PASSES and renders "No prior state — this will be a cold pass from offset
  0." even though the true cause is a stale instance name, not an empty cache;
- bare prose `instance "<name>"` occurrences in preflight and gate messages;
- the `swamp model method run` / `swamp data get` / `swamp data query` commands
  inside gate messages that name an instance;
- the top-level `description:` narrative (`music/resolve-artists`,
  `musicbrainz/sync-artist-discographies`, `music/wanted`, and the `musicbrainz`
  model-lock sentence).

Do NOT touch, even though a careless replace might match nearby text:
`@magistr/music-wanted-sequence` (the workflow's own name),
`@magistr/musicbrainz-discography-sync` (a report name), the literal
`music-wanted` inside recovery commands, `music-library` (this package's own
name, named in the preflight-seed gate's recovery message), and the method names
`resolve-artists` / `sync-artist-discographies` / `wanted`.

It enforces nine gates, every one `allowFailure: false`. Gate numbers are stable
labels, not execution positions: (1) preflight-dimensions — the artist and album
dimensions are populated before anything runs; (9) preflight-seed — the
headphones seed resolve-artists reads from (its headphonesInstance argument) is
present and carries a non-empty artists list, catching a missing, wrong-named or
empty seed before the ~35-minute sync is committed to; (2)
resolve-produced-something — resolve-artists resolved at least one artist this
run; (3) artist-map-floor — resolved artists are at least 20% of the library's
artist dimension; (4) sync-coverage — the sync made one complete pass
(`startOffset` 0, `remaining` 0); (5) sync-handoff — the sync was handed THIS
run's full resolved list, not a stale or empty one; (6) catalog-completeness —
every requested artist now has a cached discography; (7) derive-existence — the
`wanted` step actually wrote a resource this run; (8) want-total-band — the
derived want total is not implausibly large against the owned album count. Full
detail, including recovery guidance per gate, is in the file's own
`description:` block and each assert step's `message`.

REQUIRED after any edit to the workflow: run it with `--input dryRun=true`
before trusting the edit. This forces the sync step's `batchSize` to 0 (no new
MusicBrainz requests) while still exercising every gate and the CEL hand-off.
The expected shape is an INVARIANT, not a fixed pass/fail tally — the tally
depends on how warm the catalog already is when you run it: gate 4
(sync-coverage) ALWAYS fails on a dry run, because `batchSize 0` covers nothing
and so can never vouch for coverage, regardless of catalog state; `derive` is
therefore ALWAYS SKIPPED and nothing is written. Gate 6 (catalog-completeness)
is NOT pinned to the same outcome: because the resolve job has no `dryRun`
guard, it resolves artists for real, and gate 6 passes or fails according to
whether the catalog already holds a cached discography for every artist resolved
this run — it PASSES against an already-warm catalog and FAILS alongside gate 4
only when this run resolved an artist the catalog does not yet cover.
`swamp workflow validate` checks schema and DAG shape only, never CEL semantics,
so this dry run is the only control over the gate chain.

Two copies of this workflow exist: the shipped one described here, and (in the
author's own homelab, not part of this package) a live copy registered under the
bare name `music-wanted` and invoked as `swamp workflow run music-wanted`.
Everything from the `tags:` line to EOF is byte-identical between the two by
construction, so diffing both files from that line onward is the mechanical
drift check; the only differences above it are the `id:`/`name:` header lines
and one appended homelab-only operating paragraph in the live copy's
description.

**`resolve-artists`** seeds the map for free from a headphones instance (the
`headphonesInstance` argument, default `"headphones"`), whose artists are
already MusicBrainz-keyed, then falls back to token-set MusicBrainz search — via
the `musicbrainzInstance` argument, default `"musicbrainz"` — for whatever the
seed does not cover. Artists it cannot resolve confidently are **parked, never
guessed** — exact-string matching against MusicBrainz fails in both directions
(`Miles Davis` is rejected against the sort form `Davis, Miles`, while
`Bill Brown` matches `James Brown` at score 100), so a name matching two
distinct MBIDs is reported as ambiguous with its competing candidates rather
than resolved to whichever came first. The `resolved`/`ambiguous`/`unresolved`
counts are top-level fields, so a run that parked 300 artists looks different at
the CLI from one that resolved them.

The MusicBrainz fallback is a SINGLE batched call per run
(`@magistr/musicbrainz`'s `search-artists-batch`), never one call per artist —
the fix for a measured live bug where the old per-artist fan-out sent traffic at
~2.5 req/sec against MusicBrainz's documented 1 req/sec limit. A prior run's map
is reused as a 30-day cache: a seed-unresolved artist whose last search verdict
(`checkedAt`) is younger than `ttlMs` (default 30 days) is not re-searched.
`--input
refresh=true` ignores the cache and re-searches everything;
`--input
refreshKeys='["<artistKey>", ...]'` forces specific artists to be
re-checked regardless of freshness, and those are placed first in the batch so
they can never be crowded out by the query ceiling. The written map reports
`pendingSearch` (how many artists still need a verdict), `truncated`, and
`stopReason` (`complete` / `max-queries` / `max-duration` / `aborted` /
`backoff`) — **re-run `resolve-artists` until `pendingSearch` is 0** to confirm
convergence, rather than counting requests by hand; a cold library of ~1459-1483
seed-unresolved artists takes about 4 runs at the default `maxQueries` of 400.
`maxQueries` is the designed ceiling for one run; `maxDurationMs` is a derived
slow-upstream backstop (roughly 1.5x the nominal wall-clock time) that scales
automatically when `maxQueries` is raised, unless given explicitly. At the
defaults, one run holds the `musicbrainz` model lock continuously for roughly
7.3 minutes at nominal speed, up to roughly 11.5 minutes worst case — and
`swamp model method run` only WAITS up to 60 seconds for a contended model lock
(`DEFAULT_LOCK_TIMEOUT_MS`) before timing out, so avoid starting a
`resolve-artists` batch while anything else needs the `musicbrainz` instance's
lock. `SWAMP_LOCK_TIMEOUT_MS` is a lever on the WAITER — the process trying to
ACQUIRE the lock, e.g. another scheduled workflow's own environment when it runs
against this instance — not on the operator's shell running `resolve-artists`,
which HOLDS the lock and never waits for it; setting it there changes nothing.

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

Four things are now called some form of "wanted", and they do not collide at the
CLI but are easy to conflate:

- `@magistr/music-wanted-sequence` — the packaged workflow FILE, shipped in this
  package at `extensions/workflows/music-wanted.yaml`. Not runnable until
  created with `swamp workflow create` (see above).
- `swamp workflow run <the name you created it under>` — RUNS that workflow and
  PRODUCES the want set (the author's own homelab copy is literally named
  `music-wanted`, so for them this is `swamp workflow run
  music-wanted`).
- `swamp report get @magistr/music-wanted --model <instance>` — RENDERS the most
  recently produced want set.
- `wanted` — the model METHOD the workflow's `derive` job calls, and which step
  3 of the portable three-command form above runs directly.

An operator who runs the report against stale data gets a report that renders
happily and looks like success.

The report renders totals, missing grouped by artist (biggest gaps first),
upgrade candidates grouped by current quality (worst first), and the artists
needing human review. That last section is the point of parking rather than
guessing, so it is first-class output.

### Why not a self-hosted MusicBrainz mirror?

The discography sync is rate-limited to MusicBrainz's public 1 req/sec, making a
full pass a batched, resumable ~35-minute operation. A local mirror would remove
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
  --global-arg host=gonic.example.internal
# optional overrides: sshUser, dbPath, container, containerMusicRoot, hostMusicRoot

swamp model @magistr/music-library method run scan music
swamp model @magistr/music-library method run probe music \
  --input "path=Artist/Album/01 - Track.mp3"
```

`scan` arguments: `pathPrefix` (limit to a subtree), `maxAlbums` (cap for test
runs), `dryRun` (compute + write only the summary).
