# @magistr/dawarich

A swamp model that wraps the [Dawarich](https://dawarich.app) self-hosted
location-tracking HTTP API (`/api/v1/*`). Read your location points, visits,
tracks, statistics, digests, geotagged photos, and service health, and update
user settings — each call persists its result as a swamp data resource so you
can query it later with CEL.

## Global arguments

| Argument  | Required | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| `baseUrl` | yes      | Dawarich instance URL, e.g. `https://dawarich.example.com`.       |
| `apiKey`  | yes      | API key from the Dawarich Account settings page. Use a vault ref. |

The API key is appended to each request as the `api_key` query parameter. Always
supply it through a vault expression so it is never stored in cleartext.

## Instance configuration

```yaml
type: "@magistr/dawarich"
typeVersion: 2026.05.25.1
name: my-dawarich
globalArguments:
  baseUrl: "https://dawarich.example.com"
  apiKey: ${{ vault.get(dawarich-secrets, API_KEY) }}
methods: {}
```

## Methods

| Method            | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `health`          | Check Dawarich service health.                               |
| `stats`           | Get monthly or yearly statistics (`year`, optional `month`). |
| `points`          | Get location points (date range, pagination, sort order).    |
| `tracked-months`  | List months that contain tracking data.                      |
| `visits`          | Get visit records (date range, pagination).                  |
| `tracks`          | Get track data (date range, pagination).                     |
| `settings`        | Read user settings.                                          |
| `update-settings` | Patch user settings (`timezone`, `liveMapEnabled`).          |
| `digests`         | Get yearly or monthly digests (`year`, `periodType`).        |
| `photos`          | Get geotagged photos (date range, pagination).               |

## Usage

```bash
# Store the API key in a vault
swamp vault create local_encryption dawarich-secrets --json
swamp vault put dawarich-secrets API_KEY=your-api-key -f --json

# Create and configure the model instance
swamp model create @magistr/dawarich my-dawarich --json

# Check service health
swamp model method run my-dawarich health --json

# Get this year's statistics
swamp model method run my-dawarich stats --input year=2026 --json

# Fetch a date-bounded page of points
swamp model method run my-dawarich points \
  --input startAt=2026-01-01T00:00:00Z \
  --input endAt=2026-02-01T00:00:00Z \
  --input perPage=100 --json
```

## License

MIT — see [LICENSE.md](LICENSE.md).
