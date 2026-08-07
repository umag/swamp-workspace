# @magistr/musicbrainz

A swamp model for the [MusicBrainz](https://musicbrainz.org) open music
encyclopedia. Search, look up, and browse artists, release groups, releases,
recordings, and labels through the MusicBrainz Web Service v2 (JSON), with a
built-in 1 request/second rate limiter — concurrency-safe WITHIN one method
invocation, so multiple in-flight calls inside that invocation (e.g.
`sync-artist-discographies`' pagination) can never race each other into firing
too close together — that backs off and retries once on a `503` before giving
up, so you stay within the MusicBrainz usage policy. It has no memory across
separate `context.runModel` invocations, so a caller that fans out one search
per item (one `runModel` call per artist, for example) can send real traffic
well past 1 req/sec even though each individual call is internally well-behaved.
Callers that would otherwise fan out across invocations should use
`search-artists-batch` instead, which takes MANY queries and loops internally
through the same rate-limited fetch, so the limiter stays correct for the whole
workload. Also includes Bandcamp-to-MusicBrainz helpers that scrape a Bandcamp
discography and generate release-editor seed URLs for releases that are missing
from MusicBrainz.

## Configuration

The model has one required global argument, `userAgent`. MusicBrainz
**requires** a descriptive, application-identifying User-Agent string that
includes a contact address; requests without one may be blocked.

An optional `maxPages` argument caps how many 100-per-page release-group pages
`find-missing`/`seed-all-missing` will walk before stopping, even if every page
came back full (defaults to 50 — plenty for any real artist discography, and a
hard ceiling against a misbehaving endpoint that never returns a short page).

```yaml
type: "@magistr/musicbrainz"
typeVersion: "2026.08.07.1"
name: musicbrainz
globalArguments:
  userAgent: "MyApp/1.0.0 (contact@example.com)"
  # maxPages: 50 # optional, defaults to 50
methods: {}
```

## Methods

`swamp model type describe @magistr/musicbrainz --json` returns each method's 12
resource SPEC names but no INSTANCE names at all — the "Writes instance" column
below is the only place to learn which instance name a method writes to, which
is what `data.latest("musicbrainz", "<instance>")` needs as its second argument.
A literal cell is the exact, fixed name that method always writes; a
`<placeholder>` cell is a template the method fills in per call (usually from an
MBID argument).

| Method                      | Purpose                                                                                                                       | Writes instance                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `search-artist`             | Search artists by name or Lucene query                                                                                        | `search-artist` (plus `search`, deprecated — see below)        |
| `search-artists-batch`      | Search MANY artist queries in ONE invocation — the fan-out-safe alternative to calling `search-artist` once per artist        | `artist-search-batch`                                          |
| `search-release-group`      | Search release groups (albums/EPs/singles)                                                                                    | `search-release-group`                                         |
| `search-release`            | Search releases                                                                                                               | `search-release`                                               |
| `search-recording`          | Search recordings (tracks)                                                                                                    | `search-recording`                                             |
| `search-label`              | Search record labels                                                                                                          | `search-label`                                                 |
| `search`                    | Generic search over any entity type                                                                                           | `<entity>-search`                                              |
| `lookup-artist`             | Look up an artist by MBID (with optional `inc` includes)                                                                      | `artist-<id>`                                                  |
| `lookup-release-group`      | Look up a release group by MBID                                                                                               | `rg-<id>`                                                      |
| `lookup-release`            | Look up a release by MBID                                                                                                     | `release-<id>`                                                 |
| `lookup-recording`          | Look up a recording by MBID                                                                                                   | `recording-<id>`                                               |
| `lookup-label`              | Look up a label by MBID                                                                                                       | `label-<id>`                                                   |
| `browse-release-groups`     | Browse release groups by artist MBID                                                                                          | `rg-by-artist-<mbid>`                                          |
| `browse-releases`           | Browse releases by artist, label, or release-group MBID                                                                       | `releases-by-<entity>-<id>`                                    |
| `browse-recordings`         | Browse recordings by artist or release MBID                                                                                   | `recordings-by-<entity>-<id>`                                  |
| `seed-from-bandcamp`        | Generate a MusicBrainz seed URL from one Bandcamp album                                                                       | `seed-single`                                                  |
| `find-missing`              | Compare a Bandcamp discography to MusicBrainz, list missing                                                                   | `<artistMbid>` (falls back to `unknown`)                       |
| `seed-all-missing`          | Generate seed URLs for all missing releases of an artist                                                                      | `<artistMbid>` (falls back to `all-missing`)                   |
| `sync-artist-discographies` | Cursored, resumable fan-out that caches each artist's full release-group discography — `artistMbids` is REQUIRED, no fallback | `rg-by-artist-<mbid>` (per artist) + `discography-sync-cursor` |

## Usage

```bash
# Search for an artist by name
swamp model method run musicbrainz search-artist --input query="Boards of Canada"

# Look up a release with its recordings and artist credits
swamp model method run musicbrainz lookup-release \
  --input id=<RELEASE_MBID> --input inc="recordings+artist-credits+labels"

# Browse all release groups for an artist
swamp model method run musicbrainz browse-release-groups --input artist=<ARTIST_MBID>

# Find releases on a Bandcamp page that are missing from MusicBrainz
swamp model method run musicbrainz find-missing \
  --input bandcampUrl="https://artist.bandcamp.com"

# Get the artist list from a @magistr/music-library instance's artist-map:
swamp data query 'modelName == "music" && name == "artist-map" && isLatest' \
  --select 'attributes.entries.filter(e, e.status == "resolved").map(e, e.mbid)' --json
# That prints a query envelope, {"results": [[...the MBIDs...]], "total": 1};
# pass the single element of "results" as the artistMbids array below, not
# the whole document.

# Cache the full discography for an explicit artist MBID list. By default
# one run covers the WHOLE list.
swamp model method run musicbrainz sync-artist-discographies \
  --input 'artistMbids:json=["<mbid>","<mbid>"]'
# By default one run covers the WHOLE list. Re-run with the SAME
# artistMbids list only after a deliberate partial or an interrupted pass —
# the cursor indexes that list and is fingerprinted to it, so passing a
# different list restarts at 0 rather than resuming at a meaningless offset.

# Search MANY artists in ONE invocation instead of one runModel call per
# artist — the fix for fanning out across invocations losing rate-limit
# spacing (see the note at the top of this README).
swamp model method run musicbrainz search-artists-batch \
  --input queries='["artist:\"Boards of Canada\"", "artist:\"Autechre\""]'
```

`search-artists-batch` loops internally over the same rate-limited fetch every
other method uses, so the ~1 req/sec spacing that is already correct within one
invocation stays correct for the whole list of queries. `limit` (default 10)
caps candidates requested per query — `matchArtist`-style disambiguation needs a
candidate SET, not a single top hit — and each hit is written in a REDUCED
`{id, name, sort-name}` shape (never the full MusicBrainz artist document) to
stay well inside the datastore's per-document size limit on a large batch.
`maxQueries` (default 400) is the designed stop for one run; the untried
remainder is written to `deferred` for a future run to pick up, and the batch's
`stopReason` (`complete` / `max-queries` / `max-duration` / `aborted` /
`backoff`) says which ceiling (if any) produced a partial result.
`maxDurationMs` is a slow-upstream backstop DERIVED from `maxQueries` and
`minIntervalMs` (roughly 1.5x the nominal wall-clock time, plus a 30s floor)
unless given explicitly — so raising `maxQueries` also raises the backstop, and
a deliberately tight explicit value is honoured verbatim. At the defaults (400
queries, 1100ms spacing) one run holds this instance's model lock for roughly
7.3 minutes at nominal speed, up to roughly 11.5 minutes worst case. A
`Retry-After` header on a `503` that exceeds 60 seconds now STOPS the whole
batch (`stopReason: "backoff"`, throwing `MusicBrainzBackoffError` on the
single-query methods) instead of sleeping it out — a hostile or misconfigured
multi-hour `Retry-After` can no longer stall an invocation for that long while
holding a model lock; a `Retry-After` within the cap still sleeps and retries
exactly once, as before.

`sync-artist-discographies` requires an explicit `artistMbids` array — it does
NOT fall back to any cached search result. Duplicates are removed before syncing
(`requested` on the written state is the distinct count, `requestedRaw` the raw
length you passed). `batchSize` now defaults to the WHOLE deduped list, so one
run is a single complete pass by default: a cold pass over ~775 artists is ~775
MusicBrainz requests and takes ~35 minutes at 1 req/sec, and it prints nothing
until it finishes. `swamp workflow run` blocks and has no detached mode, so if
you want to see it progressing rather than guessing whether it has hung, run it
with `--log-level debug`. It holds this instance's model lock for that whole
time — do not start a cold pass between 02:30 and 03:15, when the nightly
extension canary may probe this instance. An interrupted pass now persists its
cursor and counts on every path, including a crash, so a re-run continues rather
than repeating; the cursor is fingerprinted to its list, so passing a different
list always restarts at offset 0 instead of resuming at a meaningless position.
Pass a smaller `batchSize` for a deliberate partial — the next run over the SAME
list resumes from where it stopped.

Each artist's discography is paginated up to `maxPages` (default 20 — 2,000
release groups); an artist whose catalogue exceeds that ceiling is cached with
`truncated: true` rather than silently treated as complete. A cached discography
is only re-fetched once it goes stale (`ttlMs`, default 7 days) — a legitimately
empty discography (`count: 0`) is never mistaken for "not yet fetched" and
re-queried on every run.

Check coverage after a run:
`swamp data get musicbrainz discography-sync-cursor
--json` shows the persisted
cursor, `covered`/`remaining` (this run's coverage against its requested list),
and `uncovered`/`uncoveredCount` (which requested MBIDs still have no cached
discography at all) directly. Or render it:
`swamp report get @magistr/musicbrainz-discography-sync --model musicbrainz
--markdown`.

Results are written to swamp data and can be queried with CEL. The second
argument to `data.latest` is the resource's INSTANCE name, not its spec name.
Each typed search method writes its OWN instance (see the "Writes instance"
column above), so read expressions differ per method:

```
data.latest("musicbrainz", "search-artist").attributes.artists
data.latest("musicbrainz", "search-release-group").attributes.releaseGroups
data.latest("musicbrainz", "search-release").attributes.releases
data.latest("musicbrainz", "search-recording").attributes.recordings
data.latest("musicbrainz", "search-label").attributes.labels
```

`swamp data query 'modelName == "musicbrainz" && isLatest' --select 'name'
--json`
lists what is actually stored.

### `search-artist` vs `artist-search` vs `artist-search-batch`

These three names are easy to confuse and pointing a `data.latest` read at the
wrong one returns `null`, not an error:

| Instance              | Written by                          | Spec                | Payload shape                                                                      |
| --------------------- | ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `search-artist`       | `search-artist`                     | `artists`           | `{artists, count, timestamp}`                                                      |
| `artist-search`       | `search` (generic, `entity=artist`) | `search`            | `{query, entity, results, count, offset, timestamp}`                               |
| `artist-search-batch` | `search-artists-batch`              | `artistSearchBatch` | `{batchId, queries, deferred, requested, searched, failed, stopReason, timestamp}` |

### Migrating off the deprecated `search` instance

Before this fix, all five typed search methods wrote the shared instance
`search`, so `search-artist` writing there was the ONLY working read path a
caller could reach. `search-artist` still writes `search` too, as a TIME-BOUNDED
DEPRECATION ALIAS — but `search` is DEPRECATED and removed no earlier than
**2026-09-07** (tracked as `musicbrainz-search-alias-removal`), never "this
version only" (this package shipped five versions in the eight days before this
one — a version count is not a duration here). Migrate any existing read now:

```
# before (deprecated, removed no earlier than 2026-09-07)
data.latest("musicbrainz", "search").attributes.artists

# after
data.latest("musicbrainz", "search-artist").attributes.artists
```

The alias write carries two additive payload keys, present ONLY on the `search`
row and NEVER on `search-artist`'s own canonical row: `deprecated: true` and
`supersededBy: "search-artist"`. The documented `.attributes.artists` path above
never surfaces them — to see them directly:

```
swamp data query 'modelName == "musicbrainz" && name == "search" && isLatest' \
  --select 'attributes' --json
```

Tracked follow-up: a second, unrelated instance collision between `find-missing`
(spec `missingReleases`) and `seed-all-missing` (spec `seedUrls`), both keyed on
`artistMbid`, is OUT OF SCOPE for this fix and tracked separately as
`musicbrainz-missing-seed-instance-collision`.

The three-command sequence above is the portable form this package ships. In the
homelab repo the whole artist-map -> sync -> want-derivation sequence is wired
as one workflow — `swamp workflow run music-wanted` — which carries the artist
list between model instances for you and gates each hand-off with an assert.
That workflow lives in the private homelab repo, not in this package.

## License

MIT — see [LICENSE.md](LICENSE.md).
