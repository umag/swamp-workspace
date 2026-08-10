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
typeVersion: "2026.08.07.2"
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

| Method                      | Purpose                                                                                                                       | Writes instance                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-artist`             | Search artists by name or Lucene query                                                                                        | `search-artist` (plus `search`, deprecated — see below)                                                                                                                |
| `search-artists-batch`      | Search MANY artist queries in ONE invocation — the fan-out-safe alternative to calling `search-artist` once per artist        | `artist-search-batch`                                                                                                                                                  |
| `search-release-group`      | Search release groups (albums/EPs/singles)                                                                                    | `search-release-group`                                                                                                                                                 |
| `search-release`            | Search releases                                                                                                               | `search-release`                                                                                                                                                       |
| `search-recording`          | Search recordings (tracks)                                                                                                    | `search-recording`                                                                                                                                                     |
| `search-label`              | Search record labels                                                                                                          | `search-label`                                                                                                                                                         |
| `search`                    | Generic search over any entity type                                                                                           | `<entity>-search`                                                                                                                                                      |
| `lookup-artist`             | Look up an artist by MBID (with optional `inc` includes)                                                                      | `artist-<id>`                                                                                                                                                          |
| `lookup-release-group`      | Look up a release group by MBID                                                                                               | `rg-<id>`                                                                                                                                                              |
| `lookup-release`            | Look up a release by MBID                                                                                                     | `release-<id>`                                                                                                                                                         |
| `lookup-recording`          | Look up a recording by MBID                                                                                                   | `recording-<id>`                                                                                                                                                       |
| `lookup-label`              | Look up a label by MBID                                                                                                       | `label-<id>`                                                                                                                                                           |
| `browse-release-groups`     | Browse release groups by artist MBID                                                                                          | `rg-by-artist-<mbid>`                                                                                                                                                  |
| `browse-releases`           | Browse releases by artist, label, or release-group MBID                                                                       | `releases-by-<entity>-<id>`                                                                                                                                            |
| `browse-recordings`         | Browse recordings by artist or release MBID                                                                                   | `recordings-by-<entity>-<id>`                                                                                                                                          |
| `seed-from-bandcamp`        | Generate a MusicBrainz seed URL from one Bandcamp album                                                                       | `seed-single`                                                                                                                                                          |
| `find-missing`              | Compare a Bandcamp discography to MusicBrainz, list missing                                                                   | `find-missing-<artistMbid>` (unresolved MBID: falls back to a `bc-`-namespaced Bandcamp-URL-derived instance, e.g. `find-missing-bc-obscurealpha` — see below)         |
| `seed-all-missing`          | Generate seed URLs for all missing releases of an artist                                                                      | `seed-all-missing-<artistMbid>` (unresolved MBID: falls back to a `bc-`-namespaced Bandcamp-URL-derived instance, e.g. `seed-all-missing-bc-obscurealpha` — see below) |
| `sync-artist-discographies` | Cursored, resumable fan-out that caches each artist's full release-group discography — `artistMbids` is REQUIRED, no fallback | `rg-by-artist-<mbid>` (per artist) + `discography-sync-cursor`                                                                                                         |

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

The three-command sequence above is the portable form this package ships. In the
homelab repo the whole artist-map -> sync -> want-derivation sequence is wired
as one workflow — `swamp workflow run music-wanted` — which carries the artist
list between model instances for you and gates each hand-off with an assert.
That workflow lives in the private homelab repo, not in this package.

### Breaking: `find-missing` / `seed-all-missing` instance names changed

`find-missing` (spec `missingReleases`) and `seed-all-missing` (spec `seedUrls`)
used to both write the BARE `artistMbid` as their instance name — `<artistMbid>`
(falling back to `unknown` / `all-missing`) — so one artist run through both
methods silently destroyed whichever wrote second: `readResource(name)` resolves
on the instance name alone. Each method now writes its own namespaced instance,
extending the same rule the `search` family uses above:

```
# before
data.latest("musicbrainz", "<artistMbid>").attributes.missing        # find-missing
data.latest("musicbrainz", "<artistMbid>").attributes.releases       # seed-all-missing

# after
data.latest("musicbrainz", "find-missing-<artistMbid>").attributes.missing
data.latest("musicbrainz", "seed-all-missing-<artistMbid>").attributes.releases
```

The fallback tokens move too, but are NOT the fixed `unknown` / `all-missing`
constants they used to be. When `artistMbid` cannot be auto-resolved, the
instance name is derived from the (required) `bandcampUrl` argument instead —
`find-missing-bc-obscurealpha` for `https://obscurealpha.bandcamp.com`, not a
value shared by every unresolved artist. The `bc-` marker gives this suffix its
own namespace: a MusicBrainz-issued MBID is a UUID and can never start with
`bc-`, so a Bandcamp subdomain that happens to be spelled like a UUID — or like
the literal string `unknown` — can never collide with that MBID's genuinely
resolved row. That holds for every real MBID; it is NOT enforced by this model
for `artistMbid` itself, which accepts any string — a hand-passed `artistMbid`
that itself starts with `bc-` (e.g. `bc-obscurealpha`) still collides with the
URL-derived fallback for the matching subdomain. This is a known, accepted
residual, not a silent gap: it is pinned by GUARD J4's reverse-direction test in
`musicbrainz_property_test.ts` and reachable only through an operator's own
`artistMbid` argument (MusicBrainz-returned MBIDs are always real UUIDs). This
is itself a fix, not just a rename: a single shared fallback would have
reintroduced this same collision one axis over, since two different artists that
both fail to resolve an MBID are common for a tool whose job is finding artists
MISSING from MusicBrainz — "unresolved" is the modal case, not an edge case. The
derivation prefers the artist's Bandcamp subdomain and, when several artists'
pages share ONE subdomain (a label or compilation account), also folds in the
URL's path — `https://label.bandcamp.com/album/roster-a-lp` becomes
`seed-all-missing-bc-label-album-roster-a-lp`, distinct from `.../roster-b-lp`'s
`seed-all-missing-bc-label-album-roster-b-lp` — stated honestly, two unresolved
artists that share both the subdomain AND the path still collide, since neither
`bandcampUrl` nor `artistMbid` gives the model any further signal to tell them
apart at that point. A slug over 80 characters is truncated to a deterministic
`<71 chars>-<8-hex-char digest>` form (e.g.
`.../the-complete-remastered-recordings-1972-1985-deluxe-vol-live-321-extra`
becomes
`find-missing-bc-somelabel-album-the-complete-remastered-recordings-1972-1985-deluxe-vol-315edcd6`)
instead of silently colliding with another long slug sharing the same visible
prefix, so long label/album URLs still get distinct, stable names — the digest
is collision-resistant against ACCIDENT (~2^-32 per candidate pair), not against
a caller who controls both sides of the comparison. Pass `artistMbid` explicitly
once an artist is added to MusicBrainz to move its rows onto the stable
MBID-keyed instance instead of the URL-keyed one. Both methods also
`console.error` at the resolution boundary (leading with the instance about to
be written) whenever the auto-resolve misses, so an unresolved artist is
diagnosable in the log rather than silently invisible — the log never echoes
`bandcampUrl` verbatim (only its hostname), so any userinfo embedded in a
caller-supplied URL never reaches the log.

Detect a row still sitting at the OLD, pre-upgrade instance name — replace
`<instance>` with this model's actual instance name (NOT the literal string
"musicbrainz" unless that really is what you named it; an empty result here can
mean either "fully migrated" or "wrong instance name", so confirm with
`swamp data query 'modelName == "<instance>" && isLatest' --select 'name'` that
rows exist at all before trusting an empty answer):

```
swamp data query 'modelName == "<instance>" && (specName == "missingReleases" || specName == "seedUrls") && name != "seed-single" && !name.startsWith("find-missing-") && !name.startsWith("seed-all-missing-") && isLatest' --select '{"name": name, "spec": specName, "url": attributes.bandcampUrl}' --json
```

Every row this query returns is a pre-upgrade orphan; empty output means there
are none — the predicate is self-evaluating, no eyeballing required. The `spec`
field tells you which method to re-run and which read to repoint:
`missingReleases` -> re-run `find-missing` (repoint `.missing`), `seedUrls` ->
re-run `seed-all-missing` (repoint `.releases`). Projecting `spec` matters
because a pre-upgrade name is a bare MBID and looks identical for both specs —
in the exact collision this fix closes, the SAME bare MBID can appear twice,
once per spec, and only the `spec` field tells them apart. The projected `url`
is the exact `bandcampUrl` to re-run that method with — it is a REQUIRED field
on both `missingReleases` and `seedUrls`, so it is always present on every
returned row, and without it the query's own remediation advice ("re-run
`find-missing`") is not actually executable from the output: `bandcampUrl` is a
required argument and an MBID alone will not do. This matters even more for a
row already at the NEW naming scheme's fallback instance
(`find-missing-bc-<slug>`), where `name` alone identifies no artist at all
(`{"name": "find-missing-bc-unknown", ...}` names nothing) — `url` is what makes
that row actionable too; see the query below for those. The
`name != "seed-single"` clause is not cosmetic: `seed-from-bandcamp` also writes
spec `seedUrls`, at its own fixed, unrelated, CORRECTLY-named instance
`seed-single` — without the exclusion, an operator who has ever run
`seed-from-bandcamp` would be told that healthy row needs migrating too.

The old instance does not error and does not go empty on upgrade — it FREEZES.
Nothing in this model warns or throws when `find-missing`/`seed-all-missing`
stop writing the bare `artistMbid`, so
`data.latest("musicbrainz",
"<artistMbid>")` keeps RESOLVING forever, returning
whichever payload it held right before this version — valid-looking, silently
stale data, strictly harder to notice than a `null`. Remediation: the new
instance name holds NOTHING until the method is re-run against that artist, so a
repointed read returns `null` rather than frozen-but-plausible data until then;
the old row is PERMANENT (it cannot be deleted — `swamp data delete` resurrects
rows from the datastore, and `model delete --force` on this model UUID would
also destroy the unrelated `rg-by-artist-*` cache and the discography-sync
cursor), so every reader must be actively repointed rather than left to expire
on its own.

Passing an artist through `find-missing`/`seed-all-missing` a second time, AFTER
it has been added to MusicBrainz, creates a second kind of orphan beyond the
pre-upgrade one described above: the earlier URL-keyed row
(`find-missing-bc-<slug>` / `seed-all-missing-bc-<slug>`) freezes at its last
unresolved payload and is never written again once the auto-resolve starts
succeeding and rows move to the MBID-keyed instance — permanent, for the same
reason the pre-upgrade rows are (`swamp data delete` resurrects rows from the
datastore, Lab #1440). It is NOT flagged by the detection query above: a
`find-missing-bc-<slug>` name starts with `find-missing-`, so the query's own
`!name.startsWith("find-missing-")` predicate classifies it as healthy. This is
the same READ consequence as the pre-upgrade orphan above, not just the storage
growth: any `data.latest("<instance>", "find-missing-bc-<slug>")` (or the
`seed-all-missing-` equivalent) read keeps resolving to that frozen payload
rather than going `null` once the artist's MBID has since resolved, so it goes
silently stale exactly the same way the pre-upgrade row does — repoint the read
to `find-missing-<artistMbid>` / `seed-all-missing-<artistMbid>` once the artist
resolves; the `console.error` above no longer firing for that artist on a later
run is the signal the move has happened. This class is more likely to bite in
practice than the pre-upgrade one, too: it is created by ordinary successful
use, on an ongoing basis, rather than by a one-time upgrade, and this document
actively points operators at URL-keyed instances to read from in the first place
— the "Writes instance" column above and the model's own `console.error` both
name `find-missing-bc-obscurealpha`-shaped instances as the thing being written.
An orphan per resolved artist is strictly better than the pre-fix shared row
that silently destroyed other artists' data, but it is an unbounded, undeletable
growth term worth knowing about. To list rows still at a `bc-`-namespaced
fallback instance — this returns every such row, both ones still genuinely
unresolved and ones already superseded by an MBID-keyed row for the same artist;
a row is superseded if the same `artist` also appears under a
`find-missing-<mbid>` / `seed-all-missing-<mbid>` name, which this companion
query lists for cross-reference:

```
swamp data query 'modelName == "<instance>" && (specName == "missingReleases" || specName == "seedUrls") && (name.startsWith("find-missing-bc-") || name.startsWith("seed-all-missing-bc-")) && isLatest' --select '{"name": name, "artist": attributes.artist, "url": attributes.bandcampUrl}' --json

# companion — the MBID-keyed rows to cross-reference the above against
swamp data query 'modelName == "<instance>" && (specName == "missingReleases" || specName == "seedUrls") && (name.startsWith("find-missing-") || name.startsWith("seed-all-missing-")) && !name.contains("-bc-") && isLatest' --select '{"name": name, "artist": attributes.artist}' --json
```

No alias is shipped for either instance, unlike the `search` migration above —
declined, not impossible: (a) the one live pre-upgrade row (`missingReleases` at
a bare-MBID instance) has no reader anywhere in this package or the homelab
repo's workflows/models, so there is nothing to bridge; (b) an alias would keep
`find-missing` writing an un-namespaced, colliding-by-construction instance name
for the whole deprecation window — the exact property this change exists to
remove.

## License

MIT — see [LICENSE.md](LICENSE.md).
