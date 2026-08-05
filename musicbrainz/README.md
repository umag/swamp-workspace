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
typeVersion: "2026.05.25.1"
name: musicbrainz
globalArguments:
  userAgent: "MyApp/1.0.0 (contact@example.com)"
  # maxPages: 50 # optional, defaults to 50
methods: {}
```

## Methods

| Method                      | Purpose                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `search-artist`             | Search artists by name or Lucene query                                                                                 |
| `search-artists-batch`      | Search MANY artist queries in ONE invocation — the fan-out-safe alternative to calling `search-artist` once per artist |
| `search-release-group`      | Search release groups (albums/EPs/singles)                                                                             |
| `search-release`            | Search releases                                                                                                        |
| `search-recording`          | Search recordings (tracks)                                                                                             |
| `search-label`              | Search record labels                                                                                                   |
| `search`                    | Generic search over any entity type                                                                                    |
| `lookup-artist`             | Look up an artist by MBID (with optional `inc` includes)                                                               |
| `lookup-release-group`      | Look up a release group by MBID                                                                                        |
| `lookup-release`            | Look up a release by MBID                                                                                              |
| `lookup-recording`          | Look up a recording by MBID                                                                                            |
| `lookup-label`              | Look up a label by MBID                                                                                                |
| `browse-release-groups`     | Browse release groups by artist MBID                                                                                   |
| `browse-releases`           | Browse releases by artist, label, or release-group MBID                                                                |
| `browse-recordings`         | Browse recordings by artist or release MBID                                                                            |
| `seed-from-bandcamp`        | Generate a MusicBrainz seed URL from one Bandcamp album                                                                |
| `find-missing`              | Compare a Bandcamp discography to MusicBrainz, list missing                                                            |
| `seed-all-missing`          | Generate seed URLs for all missing releases of an artist                                                               |
| `sync-artist-discographies` | Cursored, resumable fan-out that caches each artist's full release-group discography                                   |

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

# Cache the full discography for every artist found by a prior search-artist
# run, 10 at a time. Re-run the same command to process the next batch — it
# resumes from a persisted cursor rather than restarting.
swamp model method run musicbrainz sync-artist-discographies

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

`sync-artist-discographies` defaults to the artists cached by this instance's
most recent `search-artist` run, or accepts an explicit `artistMbids` array.
Each artist's discography is paginated up to `maxPages` (default 20 — 2,000
release groups); an artist whose catalogue exceeds that ceiling is cached with
`truncated: true` rather than silently treated as complete. A cached discography
is only re-fetched once it goes stale (`ttlMs`, default 7 days) — a legitimately
empty discography (`count: 0`) is never mistaken for "not yet fetched" and
re-queried on every run.

Results are written to swamp data and can be queried with CEL, e.g.
`data.latest("musicbrainz", "artists").attributes.artists`.

## License

MIT — see [LICENSE.md](LICENSE.md).
