# Fixture provenance

Every file in this directory is **pure doc-derived synthetic data** —
hand-authored from the published
[Last.fm API documentation](https://www.last.fm/api) (the `user.*`, `artist.*`,
`album.*` and `track.*` method pages plus
[the error-code table](https://www.last.fm/api/errorcodes)), never captured from
a live call. This mirrors the `headphones`, `telegram-send`, `porkbun` and
`musicbrainz` precedents (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition)

A live `my-lastfm` (`@magistr/lastfm`) model instance exists in this homelab,
holding a real synced scrobble history, and a `LASTFM_API_KEY` vault entry
exists in the `lastfm` vault. **Live capture from that instance, from the real
Last.fm API, or from any real user profile is FORBIDDEN** for this fixture
corpus — not "not done this time", but a standing rule for anyone regenerating
these fixtures later:

- No `swamp model method run my-lastfm <method>` call was made while authoring
  these fixtures, and no response from a real Last.fm request was saved here.
- No vault credential (`LASTFM_API_KEY`) was read, exported, or otherwise
  touched to produce any file in this directory.
- **No real listening data appears anywhere below.** The real account's history
  is personal data; a fixture corpus is the wrong place for it, and committing
  it would publish one person's 19-year listening record to a public repository.
- No real Last.fm username, artist, album, track, or MusicBrainz MBID appears.
- No `api_key` or `api_sig` value appears in any fixture. The fixtures are
  response bodies only — Last.fm carries the credential in the _request_ query
  string, so a response-body corpus has no credential surface by construction.
  The mechanical secret scan in `../extensions/models/lastfm_test.ts` is a
  **backstop**, not the primary control — the primary control is this
  prohibition plus never making a live call in the first place.

`lastfm.ts` is **BYTE-FROZEN** by the change that added this corpus — every test
here characterizes already-shipped parsing behavior, it does not describe new
behavior.

## Every value is synthetic

- Username: `fixtureuser` — invented; fits the model's documented
  `^[A-Za-z0-9_-]{1,15}$` constraint so the argument boundary is exercised.
- Artists: `Testband`, `Otherband`, `Thirdband` — invented.
- Albums: `First Album`, `Second Album` — invented.
- Tracks: `Opening Track`, `Second Track`, `Third Track` — invented.
- MBIDs: `00000000-0000-4000-8000-00000000000N` — syntactically valid v4-shaped
  UUIDs from an obviously-synthetic all-zero range, never a real MusicBrainz id.
  One fixture deliberately carries `""` (the empty string), because that is how
  the real API reports an absent mbid and `normalizeMbid` exists to absorb it.
- Hosts: `lastfm.example` and `example.com`
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserved domains) wherever
  a fixture needs a URL, never `last.fm` or `ws.audioscrobbler.com`.
- Timestamps: UNIX seconds in 2007–2008 and 2020, chosen to straddle a calendar
  year boundary so the year-partitioning contract is pinned.
- Playcounts and listener counts: small invented numbers.

## Per-file mapping to the documented contract

| File                        | Pins                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `user-getinfo.json`         | `user.getInfo` — stringified counts, the `registered.unixtime` shape, the `image[]` array of `{#text,size}`                                |
| `recent-tracks.json`        | `user.getRecentTracks` — `@attr` pagination, a now-playing entry with **no `date.uts`**, an `""`-mbid, and a year boundary inside one page |
| `recent-tracks-single.json` | The single-element quirk: `track` arrives as a bare **object**, not a one-item array                                                       |
| `recent-tracks-empty.json`  | Empty history — `totalPages: "0"`, empty `track` array                                                                                     |
| `top-artists.json`          | `user.getTopArtists` — `@attr.rank`, stringified playcount                                                                                 |
| `top-albums.json`           | `user.getTopAlbums` — nested `artist.name`                                                                                                 |
| `top-tracks.json`           | `user.getTopTracks` — nested `artist.name`                                                                                                 |
| `loved-tracks.json`         | `user.getLovedTracks` — `@attr.total`, `date.uts`                                                                                          |
| `weekly-chart-list.json`    | `user.getWeeklyChartList` — `from`/`to` range pairs as strings                                                                             |
| `artist-info.json`          | `artist.getInfo` — `stats.{listeners,playcount,userplaycount}`, `tags.tag[]`, `bio.summary`                                                |
| `album-info.json`           | `album.getInfo` — top-level `userplaycount`, `wiki.summary`                                                                                |
| `track-info.json`           | `track.getInfo` — nested `artist.name`, `toptags.tag[]`                                                                                    |
| `error-6.json`              | Permanent: invalid parameters (also what an unknown user returns)                                                                          |
| `error-10.json`             | Permanent: invalid API key                                                                                                                 |
| `error-26.json`             | Permanent: API key suspended                                                                                                               |
| `error-29.json`             | Transient: rate limit exceeded                                                                                                             |

## A documented quirk this corpus deliberately preserves

`recent-tracks.json` contains **four** `track` entries but only **three**
scrobbles: the first carries `@attr.nowplaying: "true"` and no `date.uts`.
Admitting it into the history would give it no position in time, corrupt the
sync cursor, and double-count it once it is really scrobbled — so the contract
test asserts it is surfaced separately and never counted. The remaining three
straddle 2007→2008 so `partitionByYear` is pinned on the same payload.
