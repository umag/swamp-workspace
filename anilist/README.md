# @magistr/anilist

A swamp model that wraps the public [AniList](https://anilist.co) GraphQL API
([`https://graphql.anilist.co`](https://graphql.anilist.co)) to search
anime/manga, fetch details and user lists, track trending/seasonal titles,
update your own list via mutations, notify a Telegram chat of tracked users'
recent activity, and feed a ClickHouse-backed charting pipeline. It exposes **11
methods** — `search`, `get`, `userlist`, `trending`, `watching`, `seasonal`,
`update-progress`, `set-score`, `recent-activity`, `ingest-scores`, and
`refresh-metadata` — each writing structured results into the swamp data model
so you can query them later with CEL expressions. The model respects AniList's
published rate limits (it reads the `X-RateLimit-*` response headers and backs
off automatically on `429`, retrying transparently).

## Configuration

```yaml
type: "@magistr/anilist"
typeVersion: "2026.07.27.1"
id: 00000000-0000-0000-0000-000000000000
name: anilist
version: 1
tags: {}
globalArguments:
  mediaType: ANIME
  # accessToken: <AniList personal access token> — required for
  #   update-progress / set-score (and improves recent-activity's read
  #   reliability during AniList's degraded mode). Wire via a vault
  #   reference, not a literal in this file.
  # clickhouseUrl: http://host:8123 — required for ingest-scores /
  #   refresh-metadata.
  # clickhouseDatabase: default
  # clickhouseUser: default
  # clickhousePassword: <ClickHouse HTTP password> — wire via a vault
  #   reference.
methods: {}
```

| Global argument      | Default   | Required for                        | Description                                                                      |
| -------------------- | --------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `mediaType`          | `ANIME`   | all read methods                    | Default media type (`ANIME`/`MANGA`) when a method doesn't override it           |
| `accessToken`        | —         | `update-progress`, `set-score`      | AniList personal access token — get one at https://anilist.co/settings/developer |
| `clickhouseUrl`      | —         | `ingest-scores`, `refresh-metadata` | ClickHouse HTTP base URL (e.g. `http://host:8123`)                               |
| `clickhouseDatabase` | `default` | ingest/refresh                      | Database holding `anilist_metadata` + `user_scores`                              |
| `clickhouseUser`     | `default` | ingest/refresh                      | ClickHouse HTTP user                                                             |
| `clickhousePassword` | —         | ingest/refresh                      | ClickHouse HTTP password                                                         |

## Usage

### Read methods

```bash
# Search anime (uses the default mediaType from globalArguments)
swamp model method run anilist search --input query="Frieren"

# Override media type and paginate through all results (up to 5 pages / 250)
swamp model method run anilist search \
  --input query="Berserk" --input type=MANGA --input fetchAll=true

# Fetch full details for a specific AniList media ID
swamp model method run anilist get --input id=154587

# Fetch a public user list filtered by status
swamp model method run anilist userlist \
  --input userName=someuser --input status=COMPLETED

# Trending / popular anime
swamp model method run anilist trending --input sort=TRENDING_DESC

# CURRENT list enriched with next-airing-episode info
swamp model method run anilist watching --input userName=someuser

# Browse a season (defaults to the current season/year)
swamp model method run anilist seasonal --input season=SUMMER --input seasonYear=2026
```

### Write methods (require `accessToken`)

```bash
# Update episode progress (and optionally status) on your own list
swamp model method run anilist update-progress \
  --input mediaId=154587 --input progress=5

# Set your score — by mediaId, or by title (resolved via a search sub-query)
swamp model method run anilist set-score --input mediaId=154587 --input score=8
swamp model method run anilist set-score --input title="Frieren" --input score=8
```

### recent-activity — notifier fan-out

Fetches new list activity (episodes watched, completions) since the last run for
a set of tracked users, dedupes with a persisted per-user cursor, and optionally
posts a digest to Telegram via a `@magistr/telegram/send` model instance (Bot
API 10.2 Rich Message by default, or legacy HTML). The cursor only advances
after a **confirmed** delivery — a failed send or `dryRun` holds it so the next
run retries (at-least-once).

```bash
swamp model method run anilist recent-activity \
  --input usernamesFile=/path/to/usernames.txt \
  --input telegramModel=tg-bot \
  --input format=rich
```

### Charting pipeline (requires `clickhouseUrl`)

`ingest-scores` is the **only** writer of the `user_scores` and
`anilist_metadata` ClickHouse tables backing the AniList chart dashboard.
`refresh-metadata` is a companion backfill that fetches metadata only for media
ids already present in `user_scores` but missing from `anilist_metadata` — it
never re-hammers the score endpoints.

```bash
swamp model method run anilist ingest-scores \
  --input usernamesFile=/path/to/usernames.txt

swamp model method run anilist refresh-metadata
```

## Resources written

| Resource                         | Written by                     | Lifetime      |
| -------------------------------- | ------------------------------ | ------------- |
| `search`                         | `search`                       | 1h            |
| `media`                          | `get`                          | 1h            |
| `userlist`                       | `userlist`                     | 1h            |
| `trending`                       | `trending`                     | 1h            |
| `watching`                       | `watching`                     | 1h            |
| `seasonal`                       | `seasonal`                     | 6h            |
| `watchProgress`                  | `update-progress`, `set-score` | 1h            |
| `activityFeed`, `activityCursor` | `recent-activity`              | 7d / infinite |
| `userlistScored`, `ingestRun`    | `ingest-scores`                | 30d / 90d     |
| `metadataRefresh`                | `refresh-metadata`             | 90d           |

Results are written as swamp data artifacts with the lifetimes above, so
subsequent CEL lookups can read them without re-fetching from the API.
