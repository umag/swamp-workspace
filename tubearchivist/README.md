# @magistr/tubearchivist

TubeArchivist API integration for swamp — manage your self-hosted YouTube
archive directly from swamp models. This extension wraps the TubeArchivist REST
API to list and inspect archived videos, manage subscribed channels, drive the
download queue, trigger maintenance tasks (rescan, reindex, backups,
Elasticsearch snapshots), search across all indexes, and read library
statistics. Every method persists its result as a typed swamp resource so the
data can be referenced with CEL expressions downstream.

## Configuration

The model requires two global arguments: the base `host` URL of your
TubeArchivist instance and an API `token`. The token should be supplied via a
vault reference rather than inline cleartext.

```yaml
type: "@magistr/tubearchivist"
typeVersion: "2026.03.28.2"
name: my-archive
globalArguments:
  host: "https://tubearchivist.example.com"
  token: "${{ vault.get(my-vault, TA_TOKEN) }}"
methods: {}
```

Store the API token in a vault first:

```bash
swamp vault create local_encryption my-vault --json
swamp vault put my-vault TA_TOKEN=your-api-token-here -f --json
```

## Usage

Run any method with `swamp model method run <name> <method> --input ...`.

```bash
# Health check the API
swamp model method run my-archive ping

# List videos (optionally filtered by channel / watch status / type)
swamp model method run my-archive list-videos --input page=0

# Add videos or playlists to the download queue, then start downloading
swamp model method run my-archive add-to-queue --input youtube_ids='["dQw4w9WgXcQ"]'
swamp model method run my-archive start-download

# Subscribe to channels and pull new uploads
swamp model method run my-archive subscribe --input channel_ids='["UC_x5XG1OV2P6uZZ5FSM9Ttw"]'
swamp model method run my-archive update-subscribed

# Search, stats, and maintenance
swamp model method run my-archive search --input query="keynote"
swamp model method run my-archive stats
swamp model method run my-archive rescan
swamp model method run my-archive backup
swamp model method run my-archive create-snapshot
```

## Methods

| Method              | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `list-videos`       | List videos with optional `page`, `channel`, `watch`, `type` filters |
| `get-video`         | Get a single video by `youtube_id`                                   |
| `delete-video`      | Delete a video by `youtube_id`                                       |
| `list-channels`     | List channels, filterable by subscription status                     |
| `subscribe`         | Subscribe to one or more YouTube channels                            |
| `add-to-queue`      | Add video or playlist IDs to the download queue                      |
| `list-queue`        | List the current download queue                                      |
| `start-download`    | Trigger downloading of pending queue items                           |
| `rescan`            | Rescan the filesystem for new or removed videos                      |
| `refresh`           | Reindex specified videos, channels, or playlists                     |
| `update-subscribed` | Check subscribed channels for new uploads                            |
| `search`            | Search across all indexes                                            |
| `mark-watched`      | Mark a video watched or unwatched                                    |
| `stats`             | Read video library statistics                                        |
| `backup`            | Trigger a new backup                                                 |
| `list-backups`      | List available backup files                                          |
| `create-snapshot`   | Create an Elasticsearch snapshot                                     |
| `list-snapshots`    | List available Elasticsearch snapshots                               |
| `ping`              | Health check the API                                                 |

## License

MIT — see [LICENSE.md](LICENSE.md).
