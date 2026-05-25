# @magistr/seanime

A swamp model that wraps the [Seanime](https://seanime.rahim.app/) self-hosted
anime server's `/api/v1` REST surface. It reads library and AniList state,
triggers scans and downloads, lists active torrents, and bulk-manages your
AniList PLANNING list.

## Global arguments

| Argument  | Required | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| `baseUrl` | yes      | Seanime base URL, e.g. `http://seanime.example.com:3211`          |
| `token`   | no       | Server password hash sent as the `X-Seanime-Token` request header |

The model targets `${baseUrl}/api/v1/*`. When `token` is set it is added to
every request as the `X-Seanime-Token` header (Seanime's server-password auth).

## Configuration

```yaml
type: "@magistr/seanime"
typeVersion: 2026.05.25.1
name: my-seanime
globalArguments:
  baseUrl: "http://seanime.example.com:3211"
  token: "${{ vault.get(seanime, TOKEN) }}"
methods: {}
```

## Methods

| Method                  | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `status`                | Get server status, version, and user info.                                |
| `library-collection`    | Get the anime library collection with watch status.                       |
| `missing-episodes`      | Get missing episodes across the library.                                  |
| `library-scan`          | Trigger a library scan (`enhanced` flag for an enhanced scan).            |
| `torrent-list`          | List active torrents from the configured torrent client.                  |
| `auto-download`         | Run the auto-downloader to fetch new episodes.                            |
| `sync-planning-rules`   | Create auto-downloader rules for PLANNING anime that are airing/upcoming. |
| `set-planning-watching` | Move eligible PLANNING anime to CURRENT (watching) on AniList.            |

## Usage

```sh
# Read server status
swamp model method run my-seanime status

# Trigger an enhanced library scan
swamp model method run my-seanime library-scan --input enhanced=true

# Create auto-downloader rules for everything releasing in your PLANNING list
swamp model method run my-seanime sync-planning-rules \
  --input libraryPath=/anime/tv \
  --input includeFinished=false
```

`sync-planning-rules` and `set-planning-watching` are idempotent: entries that
already have a rule (or that are not in a `RELEASING` / `NOT_YET_RELEASED`
state, unless `includeFinished` is set) are reported under `skipped` rather than
re-applied. Each method writes a result resource you can inspect with
`swamp data` afterwards.

## License

MIT — see [LICENSE.md](LICENSE.md).
