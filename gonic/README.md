# @magistr/gonic

A swamp model for [Gonic](https://github.com/sentriz/gonic), a self-hosted
Subsonic-compatible music server. It wraps the Subsonic REST API to ping the
server, manage podcasts, drive library scans, and list playlists, and adds a set
of SSH-backed SQLite maintenance helpers for the underlying `gonic.db`.

## Global arguments

| Argument   | Type   | Default          | Description                         |
| ---------- | ------ | ---------------- | ----------------------------------- |
| `host`     | string | (required)       | Gonic host (IP or hostname)         |
| `port`     | number | `4747`           | Gonic HTTP port                     |
| `username` | string | (required)       | Subsonic API username               |
| `password` | string | (required)       | Subsonic API password (sensitive)   |
| `sshUser`  | string | `root`           | SSH user for direct database access |
| `dbPath`   | string | `/data/gonic.db` | Path to `gonic.db` on the host      |

The `password` field is marked sensitive and is never persisted in cleartext.
The SSH-backed methods (`db-query`, `db-exec`, `ensure-podcast-dirs`) require
key-based SSH access to `host` as `sshUser`; they run non-interactively, so no
password prompt is involved.

## Instance configuration

```yaml
type: "@magistr/gonic"
typeVersion: 2026.05.25.1
name: my-gonic
version: 1
globalArguments:
  host: gonic.example.com
  port: 4747
  username: listener
  password: ${{ vault.get("gonic", "PASSWORD") }}
  sshUser: root
  dbPath: /data/gonic.db
methods: {}
```

## Methods

| Method                     | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `ping`                     | Test connectivity to the Gonic server                |
| `get-podcasts`             | List all podcast channels (with episodes by default) |
| `refresh-podcasts`         | Refresh all podcast feeds (admin only)               |
| `delete-podcast-channel`   | Delete a podcast channel by ID (admin only)          |
| `delete-podcast-episode`   | Delete a podcast episode by ID (admin only)          |
| `download-podcast-episode` | Trigger download of a podcast episode (admin only)   |
| `scan-status`              | Get current library scan status                      |
| `start-scan`               | Trigger a library rescan                             |
| `get-playlists`            | List all playlists                                   |
| `ensure-podcast-dirs`      | Create missing podcast directories on the host       |
| `db-query`                 | Run a read-only SQL query on `gonic.db` over SSH     |
| `db-exec`                  | Run a write SQL statement on `gonic.db` over SSH     |

## Usage

```bash
# Verify connectivity and capture server status
swamp model method run my-gonic ping

# List podcasts and inspect the captured data
swamp model method run my-gonic get-podcasts --input includeEpisodes=true
swamp data latest my-gonic podcasts --json

# Trigger a rescan and poll the scan status
swamp model method run my-gonic start-scan
swamp model method run my-gonic scan-status

# Read-only maintenance query against the underlying SQLite database
swamp model method run my-gonic db-query --input sql="SELECT id, title FROM podcasts"
```
