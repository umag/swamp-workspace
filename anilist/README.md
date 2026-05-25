# @magistr/anilist

A swamp model that wraps the public [AniList](https://anilist.co) GraphQL API
([`https://graphql.anilist.co`](https://graphql.anilist.co)) to search and fetch
anime and manga. It exposes four methods — `search`, `get`, `userlist`, and
`trending` — each writing structured results into the swamp data model so you
can query them later with CEL expressions. No API key is required; the model
respects AniList's published rate limits (it reads the `X-RateLimit-*` response
headers and backs off automatically on `429`, retrying transparently). Optional
`fetchAll` pagination collects up to five pages (250 results) per call.

## Configuration

The model takes a single global argument, `mediaType`, which sets the default
media type (`ANIME` or `MANGA`) for any method that does not override it.

```yaml
type: "@magistr/api"
typeVersion: "2026.05.25.1"
id: 00000000-0000-0000-0000-000000000000
name: anilist
version: 1
tags: {}
globalArguments:
  mediaType: ANIME
methods: {}
```

## Usage

Search for an anime by title:

```bash
# Search anime (uses the default mediaType from globalArguments)
swamp model method run anilist search --input query="Frieren"

# Override media type and paginate through all results
swamp model method run anilist search \
  --input query="Berserk" --input type=MANGA --input fetchAll=true

# Fetch full details for a specific AniList media ID
swamp model method run anilist get --input id=154587

# Fetch a public user list filtered by status
swamp model method run anilist userlist \
  --input userName=someuser --input status=COMPLETED

# Get the current trending anime
swamp model method run anilist trending --input sort=TRENDING_DESC
```

Results are written as swamp data artifacts (`search`, `media`, `userlist`,
`trending`) with a one-hour lifetime, so subsequent CEL lookups can read them
without re-fetching from the API.
