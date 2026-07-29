# Fixture provenance

Every fixture in this directory is **pure doc/source-derived synthetic data** —
hand-authored from the published
[Headphones API documentation](https://github.com/rembo10/headphones/blob/master/API.md)
and, where the docs were silent or ambiguous, the actual
[rembo10/headphones](https://github.com/rembo10/headphones) Python source
(`headphones/api.py`, `headphones/importer.py`, `headphones/logger.py`) read via
public GitHub — never captured from a live call. This mirrors the `porkbun` and
`telegram-send` precedents (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition)

A live `headphones` (`@magistr/headphones`) model instance exists in this
homelab (the canary seed referenced by the issue), and a `HEADPHONES_API_KEY`
vault entry exists. **Live capture from that instance is FORBIDDEN** for this
fixture corpus — not "not done this time", but a standing rule for anyone
regenerating these fixtures later:

- No `swamp model method run <headphones-instance> <method>` call was made while
  authoring these fixtures.
- No vault credential (`HEADPHONES_API_KEY`) was read, exported, or otherwise
  touched.
- No real host, library path, or music-collection content from any real
  Headphones deployment appears anywhere below.
- The `apikey` query-string parameter is **never** present in any fixture body
  below — Headphones carries it only in the outbound request URL (see
  `headphones_adversarial_test.ts`'s credential honest-gap pins), never in a
  response body, so there is nothing to redact here; the prohibition is listed
  for completeness.

The fixtures-secret-scan test in
`../extensions/models/headphones_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

## Every value is synthetic

- Hosts/domains: `coverartarchive.example`, `musicbrainz.example`,
  `example-indexer.test` — the `.example`/`.test` TLDs are IANA-reserved
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never resolvable, never
  a real service.
- Artist/album/release MusicBrainz-shaped IDs (e.g.
  `f59c5520-5f92-4d33-b271-c0b45741e0aa`) are synthetic UUIDv4-shaped strings,
  not real MusicBrainz identifiers copied from any lookup. "Boards of Canada" /
  "Autechre" / "Actress" are real, independently-famous band names used only as
  recognizable placeholder labels (the same class of substitution
  `lastfm`/`music-library` fixtures already use in this repo) — no real
  release/track data, artwork URL, or file path was captured from any actual
  library.
- File paths (e.g. `/music/Boards of Canada/Tomorrow's Harvest/01 Gemini.flac`)
  are synthetic, matching the `musicDir` default documented in `README.md`, not
  a real filesystem listing from any host.

## Per-file mapping to the documented/source-derived endpoint

| File                     | Documented/source endpoint                                        | Shape resolved from                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getVersion.json`        | `getVersion`                                                      | `headphones/api.py` `_getVersion` (object: git_path, install_type, current_version, latest_version, commits_behind)                                                                                                                                                                                                                                                                                                                                                                        |
| `getIndex.json`          | `getIndex`                                                        | API.md (bare array; ArtistName, ArtistSortName, ArtistID, Status, DateAdded, LatestAlbum, ReleaseDate, AlbumID, HaveTracks, TotalTracks, IncludeExtras, LastUpdated, ArtworkURL, ThumbURL)                                                                                                                                                                                                                                                                                                 |
| `getArtist.json`         | `getArtist` (id=$artistid)                                        | `headphones/api.py` `_getArtist` — see "The getArtist/getAlbum wire-shape finding" below                                                                                                                                                                                                                                                                                                                                                                                                   |
| `getArtist.loading.json` | `getArtist`, mid-import                                           | `headphones/importer.py` `addArtisttoDB()` sets `Status: "Loading"` until `finalize_update()` completes                                                                                                                                                                                                                                                                                                                                                                                    |
| `findArtist.json`        | `findArtist` (MusicBrainz search)                                 | API.md (bare array: url, score, name, uniquename, id)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `getAlbum.json`          | `getAlbum` (id=$albumid)                                          | `headphones/api.py` `_getAlbum` — see "The getArtist/getAlbum wire-shape finding" below                                                                                                                                                                                                                                                                                                                                                                                                    |
| `getWanted.json`         | `getWanted`                                                       | API.md (bare array: Status, AlbumASIN, DateAdded, AlbumTitle, ArtistName, ReleaseDate, AlbumID, ArtistID, Type) — the identical shape backs `get-snatched`/`get-upcoming` in the methods suite (same underlying `albums` table, filtered by `Status` server-side)                                                                                                                                                                                                                          |
| `getHistory.json`        | `getHistory`                                                      | API.md (bare array: Status, DateAdded, Title, URL, FolderName, AlbumID, Size)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `getLogs.json`           | `getLogs`                                                         | API.md marks this endpoint "Not working yet"; `headphones/logger.py` shows `LOG_LIST` actually holds 4-tuples `(time, message, level, threadName)`, not strings. Given the endpoint's own docs disclaim reliability, this fixture follows `headphones.ts`'s own declared `LogsSchema` (`z.array(z.string())`) rather than the tuple shape — the tuple-vs-string divergence is noted here, not asserted as a pinned test, to avoid over-fitting an admittedly-unreliable upstream endpoint. |
| `error.html`             | any endpoint, hostile/misconfigured server (HTTP 200 + HTML body) | Not a Headphones response — models a reverse-proxy/auth-wall page a real deployment could return with `Content-Type: text/html` and status 200, exercising `api()`'s `JSON.parse` → `{raw}` fallback                                                                                                                                                                                                                                                                                       |
| `audit.rows.json`        | `sqlite3 -json <dbPath>` subprocess stdout (not the HTTP API)     | `audit-library`'s SQL: `SELECT AlbumID, ArtistName, AlbumTitle, ReleaseDate FROM albums WHERE Status='Downloaded' ...`                                                                                                                                                                                                                                                                                                                                                                     |

## The getArtist/getAlbum wire-shape finding (round-1 adversarial HIGH + its natural extension)

Plan v2 resolved a round-1 adversarial HIGH by requiring the REAL `getArtist`
wire shape be confirmed before fixturing, rather than pinning a convenient
object shape that hides a latent bug. Reading `headphones/api.py`'s `_getArtist`
directly confirms:

```python
artist = self._dic_from_query(
    'SELECT * from artists WHERE ArtistID="' + self.id + '"')
...
self.data = {'artist': artist, 'albums': albums, 'description': description}
```

`_dic_from_query` always returns a **list** (`rows_as_dic.append(row_as_dic)`
per row) — there is no `[0]` indexing anywhere in `_getArtist`. So `artist` in
the wire response is a **single-element array**, exactly as `onboard-artists`'
`Array.isArray(data.artist) ? data.artist[0] : data.artist` guard implies the
author already suspected. `getArtist.json`/`getArtist.loading.json` fixture this
REAL shape (`"artist": [ {...} ]`), and `headphones_test.ts` pins `get-artist`'s
**non-unwrapping** `artist: data.artist || data` as a documented latent bug:
with a real response, `data.artist` is a truthy array, so the `artist` resource
field ends up holding a one-element ARRAY, violating `ArtistSchema`'s implicit
single-object expectation. Tracked by the filed hardening issue
**`headphones-apikey-hardening`** (see `../CHANGELOG.md`).

The identical mechanism applies to `_getAlbum`:

```python
album = self._dic_from_query(
    'SELECT * from albums WHERE AlbumID="' + self.id + '"')
...
self.data = {'album': album, 'tracks': tracks, 'description': description}
```

Same `_dic_from_query` helper, same absence of `[0]` indexing — `album` is also
a single-element array on the wire. `getAlbum.json` fixtures this faithfully,
and `headphones_test.ts` pins `get-album`'s identical
`album: data.album || data` non-unwrap as the same class of latent bug,
discovered as a direct, same-evidence-quality extension of the plan's Step 2
diligence (not a new, separately-scoped investigation). Also tracked by
`headphones-apikey-hardening`.

## A note on `description`

Both `getArtist` and `getAlbum` also return a `description` array
(`SELECT * from descriptions WHERE ...`) that `headphones.ts` reads nowhere —
neither `get-artist` nor `get-album` writes it to any resource field. The
fixtures include an (empty) `description: []` for wire fidelity; no test asserts
on it, since the frozen source never touches it.
