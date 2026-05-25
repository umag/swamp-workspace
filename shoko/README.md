# @magistr/shoko

Swamp model for the [Shoko Server](https://docs.shokoanime.com/) anime metadata
and library manager. It wraps the Shoko REST v3 API so you can authenticate,
read library state (series, episodes, files, import folders, queue), inspect
dashboard statistics, and trigger maintenance actions from swamp workflows and
the CLI.

Shoko uses a Shoko-specific `apikey` header rather than a standard `Bearer`
token. Authenticate once to mint a long-lived API key, stash it in your vault,
and reference it from the model's `globalArguments.apiKey`.

## Global arguments

| Argument    | Required | Description                                                                 |
| ----------- | -------- | --------------------------------------------------------------------------- |
| `host`      | yes      | Shoko base URL, e.g. `http://shoko.example.com:8111`                        |
| `apiKey`    | yes      | Long-lived API key (sensitive — store in a vault). Mint via `authenticate`. |
| `userAgent` | no       | `User-Agent` string sent with each request (default `swamp-shoko/1.0`).     |

## Methods

| Method                    | Auth | Description                                                 |
| ------------------------- | ---- | ----------------------------------------------------------- |
| `authenticate`            | no   | Exchange `user`/`pass` for a long-lived `apikey`.           |
| `status`                  | no   | Server init status.                                         |
| `dashboard`               | yes  | Dashboard stats (series count, disk usage, queue health).   |
| `list-series`             | yes  | List series, paginated (`page`, `pageSize`, `startsWith`).  |
| `search-series`           | yes  | Fuzzy server-side series search by name.                    |
| `find-unrecognized-files` | yes  | Files Shoko could not match to AniDB (manual link queue).   |
| `find-missing-episodes`   | yes  | Series/episodes with missing (not-yet-downloaded) episodes. |
| `find-duplicate-files`    | yes  | Episodes/series with multiple physical files.               |
| `list-import-folders`     | yes  | Configured import folders.                                  |
| `queue-status`            | yes  | Depth and state of the general, hasher, and image queues.   |
| `list-actions`            | no   | Discover `Action/*` endpoints from the live OpenAPI spec.   |
| `run-action`              | yes  | Trigger an action by name (e.g. `RunImport`, `SyncMyList`). |
| `remove-missing-files`    | yes  | Purge DB entries for files no longer on disk.               |
| `rescan-folder`           | yes  | Rescan a single import folder by ID.                        |

## Usage

Create a model instance pointing at your Shoko Server. The base URL below is a
placeholder — substitute your own host and port (Shoko defaults to `:8111`):

```yaml
type: "@magistr/shoko"
typeVersion: "2026.05.25.1"
name: shoko
globalArguments:
  host: "http://shoko.example.com:8111"
  apiKey: "${{ vault.get(shoko-secrets, API_KEY) }}"
methods: {}
```

Mint an API key once (no auth needed for `authenticate`), store it in the vault,
then run authenticated methods:

```bash
# 1. Authenticate to obtain a long-lived apikey, then store it in a vault.
swamp model method run shoko authenticate \
  --input user=admin --input pass=secret --input device=swamp

# 2. Read library + server state.
swamp model method run shoko status
swamp model method run shoko dashboard
swamp model method run shoko list-series --input pageSize=100

# 3. Trigger maintenance actions.
swamp model method run shoko list-actions
swamp model method run shoko run-action --input action=RunImport
swamp model method run shoko rescan-folder --input importFolderId=1
```

See the [Shoko API documentation](https://docs.shokoanime.com/) for endpoint
details and the full list of available `Action/*` names.

## License

MIT — see [LICENSE.md](LICENSE.md).
