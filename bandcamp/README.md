# @magistr/bandcamp

Bandcamp integration for [swamp](https://github.com/systeminit/swamp). Search
the public Bandcamp catalog for artists, albums, and tracks, and fetch full
metadata (discography, track listings, tags, cover art, bio) by URL. The catalog
search and detail methods need no credentials — they read public pages and parse
the embedded JSON-LD and `TralbumData`.

Optional OAuth credentials (`clientId` / `clientSecret`) additionally unlock the
Bandcamp sales and merch API for account owners: list bands, pull sales reports,
read merch details and orders, and mark orders as shipped.

## Install

```bash
swamp extension pull @magistr/bandcamp
```

## Instance configuration

`globalArguments` are all optional. Leave them unset for catalog search and
detail lookups; set them only if you need the OAuth-gated account methods.

```yaml
type: "@magistr/bandcamp"
typeVersion: 2026.05.25.1
name: bandcamp
globalArguments:
  # Optional — only required for sales/merch/account methods
  clientId: "${{ vault.get(bandcamp, CLIENT_ID) }}"
  clientSecret: "${{ vault.get(bandcamp, CLIENT_SECRET) }}"
methods: {}
```

## Methods

Public (no auth):

- `search-artist` — search for artists/bands. Args: `query`, optional `page`.
- `search-album` — search for albums/releases. Args: `query`, optional `page`.
- `search-track` — search for tracks. Args: `query`, optional `page`.
- `get-artist` — artist page details and discography by URL. Args: `url`.
- `get-album` — album details and track listing by URL. Args: `url`.
- `get-track` — track details by URL. Args: `url`.

OAuth-gated (requires `clientId` + `clientSecret`):

- `my-bands` — list bands/labels on the account.
- `sales-report` — sales report for a band. Args: `bandId`, `startTime`, ...
- `get-merch-details` — merch items for a band.
- `get-orders` — merch orders for a band.
- `update-shipped` — mark orders as shipped.

## Usage

```bash
# Search the public catalog (no credentials needed)
swamp model method run bandcamp search-artist --input query="Boards of Canada"
swamp model method run bandcamp search-album --input query="Music Has the Right"

# Fetch full metadata by URL
swamp model method run bandcamp get-artist \
  --input url=https://example-artist.bandcamp.com
swamp model method run bandcamp get-album \
  --input url=https://example-artist.bandcamp.com/album/example-album

# Inspect the results that were written to model data
swamp data list --json
```

## License

MIT — see [LICENSE.md](LICENSE.md).
