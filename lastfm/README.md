# @magistr/lastfm

Read a Last.fm user's scrobble history and listening statistics from the
[Last.fm 2.0 web API](https://www.last.fm/api).

Read-only by design. Every method here is an unauthenticated `user.*` /
`artist.*` / `album.*` / `track.*` read, so an API key is the only credential
needed — no OAuth flow, no session key, no MD5 request signing.

## Setup

### 1. Get an API key

Register an API account at <https://www.last.fm/api/account/create>. You need
only the **API key**; the shared secret is for write methods, which this
extension does not use.

### 2. Store it in a vault

```bash
swamp vault create @webframp/hashicorp-vault lastfm \
  --config '{"address":"http://192.168.88.242:8200","mount":"swamp/lastfm","kvVersion":"2"}'
swamp vault put lastfm LASTFM_API_KEY=<your-key> -f
```

### 3. Create the model

```bash
swamp model create @magistr/lastfm my-lastfm
```

Then set the global arguments in `models/@magistr/lastfm/<uuid>.yaml`:

```yaml
globalArguments:
  user: u3BpaT
  apiKey: ${{ vault.get(lastfm, LASTFM_API_KEY) }}
```

## Methods

### Lookups

| Method | Wraps | Notes |
|--------|-------|-------|
| `profile` | `user.getInfo` | Playcount, artist/album/track counts, registration date |
| `loved-tracks` | `user.getLovedTracks` | Paged |
| `artist-info` | `artist.getInfo` | Includes *your* playcount for that artist |
| `album-info` | `album.getInfo` | Includes your playcount |
| `track-info` | `track.getInfo` | Includes your playcount |

### Charts

| Method | Wraps |
|--------|-------|
| `top-artists` / `top-albums` / `top-tracks` | `user.getTop*` |
| `weekly-chart-list` | `user.getWeeklyChartList` |
| `weekly-artist-chart` / `weekly-album-chart` / `weekly-track-chart` | `user.getWeekly*Chart` |

`period` is a closed enum — `overall`, `7day`, `1month`, `3month`, `6month`,
`12month`. Anything else is rejected at the argument boundary rather than
passed through, because the API silently coerces an unrecognised period to
`overall` and returns a plausible wrong answer.

### History

```bash
swamp model method run my-lastfm sync-history
```

Pages `user.getRecentTracks` into one `scrobbles.<year>` resource per calendar
year, plus a `history.<user>` resource holding the sync cursor and per-year
counts.

| Argument | Purpose |
|----------|---------|
| `from` / `to` | Explicit UNIX range; `to` defaults to now and may not be in the future |
| `resyncYear` | Rebuild one year from scratch — the only way to shed scrobbles deleted upstream |
| `limit` | Page size, 1–200 (default 200) |
| `maxPages` | Safety cap for one run; re-run to continue from the cursor |

**It is idempotent.** Re-running adds only what is new: scrobbles are deduped
on `(uts, artist, track)`, and a year chunk's content is a pure function of the
scrobbles it holds, so an unchanged year produces byte-identical data and no
new version.

## Report: `@magistr/lastfm-stats`

A model-scope report that runs after `sync-history` and derives what the API's
six fixed periods cannot express:

- per-year, per-month, per-weekday and per-hour distributions
- unique artist / album / track counts
- days with listening, and the longest consecutive-day streak
- top artists, albums and tracks over the whole history

```bash
swamp report get @magistr/lastfm-stats --model my-lastfm --json
```

Pass a `timezone` (IANA name, e.g. `Europe/Amsterdam`) to bucket hours and
weekdays in local time; scrobble timestamps are UTC and the default is `UTC`.

## Reading the data

Prefer CEL over re-fetching (CLAUDE.md Rule 3–4):

```
data.latest("my-lastfm", "history.u3BpaT").attributes.lastUts
data.latest("my-lastfm", "scrobbles.2026").attributes.count
data.latest("my-lastfm", "profile.u3BpaT").attributes.playcount
```

## Security notes

Last.fm has **no header-auth option** — `api_key` is a query parameter on every
request. Three consequences are enforced in the model:

1. The base URL is pinned to `https://ws.audioscrobbler.com/2.0/`. The
   published docs give an `http://` root, which would put the key in cleartext
   on the wire. A non-`https:` `baseUrl` override is refused at the argument
   boundary rather than requested.
2. `apiKey` is marked sensitive, so swamp never persists it in cleartext.
3. Every URL passes through a redaction helper before it can reach an error
   message, a log line, or a test fixture.

## Error handling

Last.fm reports failures as **HTTP 200 with an `{error, message}` body**, so a
bare `response.ok` check reads them as success. Codes are classified per
<https://www.last.fm/api/errorcodes>:

- **Permanent** — 6 (invalid parameters, which is also what an unknown user
  returns), 10 (invalid API key), 26 (API key suspended). These fail fast.
- **Transient** — 8, 11, 16, 29 (rate limit). These retry with exponential
  backoff.

Unknown codes are treated as permanent: hammering an unrecognised failure is
how a key ends up suspended.

## Dependencies

Pinned exactly, per CLAUDE.md Rule 7 — swamp's bundler inlines npm packages, so
`deno.lock` does not cover them:

- `npm:zod@4.4.3`
- `npm:fast-check@4.8.0` (tests only)

This deviates deliberately from the workspace's usual `npm:zod@4`, which is a
major-version *range*.

## Tests

```bash
deno task test        # network-less; five suites
deno task test:soak   # property suites at 10,000 iterations
deno task test:live   # LIVE_LASTFM=1, needs a real API key
```

The default task grants no `--allow-net`, so a test that reaches the network
fails loudly rather than silently depending on the live API.
