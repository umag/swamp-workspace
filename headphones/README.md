# @magistr/headphones

A swamp model that automates
[Headphones](https://github.com/rembo10/headphones), the music-download manager.
It wraps the Headphones JSON API to manage artists, albums, and the wanted
queue, and adds an optional SSH-backed library audit that cross-checks the
Headphones database against the music filesystem.

## Model

`@magistr/headphones` — talks to the Headphones HTTP API using your instance URL
and API key. Every method writes its result as a swamp data resource so you can
query it afterwards with CEL expressions.

## Configuration

The model is configured through `globalArguments`:

| Argument   | Required | Default                 | Description                                                |
| ---------- | -------- | ----------------------- | ---------------------------------------------------------- |
| `host`     | yes      | —                       | Headphones URL (e.g. `http://headphones.example.com:8181`) |
| `apiKey`   | yes      | —                       | Headphones API key (store it in a vault, not inline)       |
| `sshHost`  | no       | —                       | SSH host for direct DB/FS access (`audit-library` only)    |
| `sshUser`  | no       | `root`                  | SSH user for the audit                                     |
| `dbPath`   | no       | `/config/headphones.db` | Path to `headphones.db` on the SSH host                    |
| `musicDir` | no       | `/music`                | Music library root on the SSH host                         |

Example instance definition:

```yaml
type: "@magistr/headphones"
typeVersion: "2026.05.25.1"
name: headphones
globalArguments:
  host: "http://headphones.example.com:8181"
  apiKey: ${{ vault.get(my-vault, HEADPHONES_API_KEY) }}
  # Optional — only needed for the audit-library method:
  sshHost: "media.example.com"
  sshUser: "root"
  dbPath: "/config/headphones.db"
  musicDir: "/music"
methods: {}
```

## Methods

Artist methods: `get-index`, `get-artist`, `find-artist`, `add-artist`,
`del-artist`, `pause-artist`, `resume-artist`, `refresh-artist`.

Album methods: `get-album`, `add-album`, `find-album`, `queue-album`,
`unqueue-album`.

List views: `get-wanted`, `get-snatched`, `get-upcoming`, `get-history`.

System: `force-search`, `force-process`, `force-active-artists-update`,
`get-version`, `check-github`, `get-logs`, `clear-logs`, `restart`, `update`.

Library audit: `audit-library` (requires `sshHost`).

## Usage

```bash
# List every artist in the library
swamp model method run headphones get-index

# Search MusicBrainz for an artist, then add the first match by ID
swamp model method run headphones find-artist --input name="Boards of Canada"
swamp model method run headphones add-artist --input id=<musicbrainz-artist-id>

# Mark an album as wanted and kick off a search
swamp model method run headphones queue-album --input id=<release-group-id>
swamp model method run headphones force-search

# Review what is currently wanted
swamp model method run headphones get-wanted

# Audit the library: albums marked Downloaded but missing from disk
swamp model method run headphones audit-library --input requireArtist=true
```

After running a method, inspect its output with `swamp data`:

```bash
swamp data query headphones albums --where 'attributes.category == "wanted"'
```

## License

MIT — see [LICENSE.md](LICENSE.md).
