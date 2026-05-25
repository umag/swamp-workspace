# @magistr/obsidian-yt-archiver

A swamp model that scans an [Obsidian](https://obsidian.md) vault for YouTube
links, queues them for download in a self-hosted
[TubeArchivist](https://www.tubearchivist.com/) instance, and resolves the
archived video metadata so you can keep durable, offline copies of every video
you reference in your notes. It walks every `.md` file under the vault (or a
chosen subfolder), extracts unique video IDs from `watch`, `youtu.be`, `embed`,
and `shorts` URLs, checks each ID against TubeArchivist, queues anything
missing, and triggers the pending-download task — all idempotently, so
re-running only queues what is not yet archived.

## Model configuration

The model declares three `globalArguments`: `vaultPath` (the absolute path to
your Obsidian vault), `tubearchivistUrl` (the TubeArchivist base URL), and
`tubearchivistToken` (your TubeArchivist API token). Store the token in a vault
rather than inline.

```yaml
type: "@magistr/obsidian-yt-archiver"
typeVersion: "2026.03.28.1"
id: <uuid>
name: yt-archiver
version: 1
tags: {}
globalArguments:
  vaultPath: "/path/to/vault"
  tubearchivistUrl: "https://tubearchivist.example.com"
  tubearchivistToken: "${{ vault.get(tubearchivist, API_TOKEN) }}"
methods: {}
```

## Usage

The model exposes four methods. `scan` finds links and writes a `scan` resource
without touching TubeArchivist. `archive` queues missing videos for download.
`resolve` fetches metadata for already-archived videos. `sync` does all three in
a single pass. The optional `folder` argument restricts the walk to a subfolder
of the vault; `videoIds` lets you target specific IDs instead of the scan
results.

```bash
# Scan only the Clippings subfolder for YouTube links
swamp model method run yt-archiver scan --input folder=Clippings

# Queue every linked video that is not yet archived
swamp model method run yt-archiver archive

# Resolve metadata for archived videos
swamp model method run yt-archiver resolve

# One-pass scan + archive + resolve over the whole vault
swamp model method run yt-archiver sync

# Inspect the results written to model data
swamp data latest yt-archiver scan --json
```

## Resources

| Resource   | Contents                                              |
| ---------- | ----------------------------------------------------- |
| `scan`     | Every YouTube link found, with file, line, and counts |
| `archive`  | Queued IDs plus already-archived video metadata       |
| `resolved` | Resolved video metadata from TubeArchivist            |

## License

MIT — see [LICENSE.md](LICENSE.md).
