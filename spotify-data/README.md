# @magistr/spotify-data

Import a Spotify **"Extended streaming history"** GDPR export into swamp — one
`spotify.<year>` resource per calendar year, partitioned exactly like
[`@magistr/lastfm`](../lastfm)'s scrobble chunks so the two sources sit
alongside each other and stay comparable.

This is an **offline importer**. It makes no network call and needs no
credential. It only ever reads the export; the file stays wherever you put it.

## Getting the export

Request it at <https://www.spotify.com/account/privacy/> — choose **"Extended
streaming history"**, not the plain "Account data" package.

The distinction matters and is the single most common way to end up with the
wrong file:

| Package                    | Covers                        | Filenames                        |
| -------------------------- | ----------------------------- | -------------------------------- |
| Extended streaming history | your whole listening lifetime | `Streaming_History_Audio_*.json` |
| Account data               | the last **12 months** only   | different names entirely         |

Spotify emails the extended export as a ZIP, typically within a few days. The
Web API is not a substitute: `recently-played` returns only the last 50 tracks,
so the export is the only source for a lifetime history.

## Setup

```bash
swamp model create @magistr/spotify-data my-spotify \
  --global-args '{"exportPath": "/path/to/my_spotify_data.zip"}'
```

`exportPath` accepts either the `.zip` Spotify emailed you or a directory it was
extracted into. A `.zip` is extracted into a throwaway temp directory that is
removed afterwards; a directory is read in place and never modified.

| Global argument | Default      | Meaning                                                         |
| --------------- | ------------ | --------------------------------------------------------------- |
| `exportPath`    | _(required)_ | The `.zip` or the extracted directory                           |
| `label`         | `spotify`    | Identifies this export, so two accounts can coexist in one repo |

## Methods

### `inspect`

Reports what the export contains — record counts, the music/podcast/audiobook
split, per-year distribution and date range — **without writing any year
chunk**. Run it first to confirm you have the extended export rather than the
one-year package.

```bash
swamp model method run my-spotify inspect
```

Writes one `inspection.<label>` resource.

### `import`

Imports the export into one `spotify.<year>` resource per calendar year, plus an
`import.<label>` state resource.

```bash
swamp model method run my-spotify import
swamp model method run my-spotify import --input '{"year": "2024"}'
```

Idempotent: each year chunk is rewritten **from** the export rather than merged
into a prior chunk, so re-importing an unchanged export produces identical bytes
rather than minting a new data version every run. A year chunk carries no
wall-clock field for exactly this reason.

## Two decisions that shape the whole model

### Privacy: the location trail never reaches a resource

Every record in the export carries `ip_addr`, and most carry `conn_country`,
`platform` and `incognito_mode`. That is a location and device trail spanning
years, not listening data.

All four are dropped at the parse boundary — in `toStream`, the single point
every record must pass through — and never reach a resource. The boundary is
there rather than in a later filter precisely because a later filter can be
forgotten. `incognito_mode` is _dropped_, not stored as `false`: a private play
and an ordinary one produce byte-identical rows, so a resource reader cannot
tell them apart.

The test suites treat this as the model's security property, not a nicety: the
committed fixture carries all four fields on every record so their absence from
a parsed row is observable, and a property test asserts no generated secret
value survives `toStream` under any record shape.

### Fidelity: every play is kept, however brief

Podcast episodes and audiobook chapters are excluded — a different kind of thing
from a music play, and they distort artist and track statistics.

But **every music stream is kept regardless of how briefly it played**. Last.fm
only ever recorded plays past its ~30s scrobble threshold, so the sub-threshold
tail is information a Last.fm history structurally cannot hold — discarding it
at import would throw away the one thing this source adds. Filtering by play
time is a read-time concern, applied by the report.

That is why the stats report shows two totals that are **not** interchangeable:

- `total` — every stream in the export: what actually happened
- `listens` — only those past 30s: the number comparable to a scrobble count

## Deduplication

A real 15,607-record export contains 546 groups of records sharing
`(ts, artist, track)`. 469 of those are byte-identical — genuine export
artifacts, correct to collapse — but **77 differ**, almost always in `ms_played`
and sometimes in `reason_start`/`reason_end`. Spotify evidently emits some plays
as more than one segment stamped with the same end second.

So identity is the **whole normalized record**, not the `(ts, artist, track)`
triple that looks right. Keying on the triple would discard those 77 as
duplicates and silently lose real playback data. This is safe precisely because
`import` rewrites each chunk from the export: dedup is within-export only, so
the same export always yields the same rows.

## Reports

### `@magistr/spotify-stats`

Playcounts, listening hours, top artists and tracks (by both playcount and
time), skip rate, and year/hour/`reason_end` distributions over every imported
chunk.

### `@magistr/listening-overlap`

Cross-references this model's chunks against a `@magistr/lastfm` instance's
scrobbles to show what each source uniquely holds.

Two things make it more than a set intersection:

- **Spotify's `ts` is an END timestamp; Last.fm's `date.uts` is a START
  timestamp.** Any cross-source match must therefore allow at least one track
  length of drift, so matching uses a tolerance window (default 600s) rather
  than timestamp equality.
- **Matching is one-to-one.** A naive "does any counterpart exist" test
  double-counts when a track is played several times in an evening. Candidates
  are consumed as they are used and the nearest unconsumed one wins, so N plays
  match at most N counterparts.

Artist ranking folds spelling variants, so `Za Frûmi` and `Za Frűmi` — which
Last.fm treats as two artists, splitting one artist's real playcount across both
— collapse into a single entry labelled with the commonest spelling.

## Development

```bash
deno task check      # type-check
deno task test       # all five suites
deno task test:soak  # property tests at 10,000 iterations
deno task fmt:check
deno task lint
```

Fixtures are hand-authored, never captured from a real export — see
[`fixtures/PROVENANCE.md`](fixtures/PROVENANCE.md) for the reasoning and the
per-record table of what each one exercises.

## License

MIT — see [LICENSE.md](LICENSE.md).
