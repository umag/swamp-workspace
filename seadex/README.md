# @magistr/seadex

A swamp model for [SeaDex](https://releases.moe) — a community-curated index of
the "best" anime releases. SeaDex is backed by a public Pocketbase API at
`https://releases.moe/api/...`; this model fetches an entry for an anime and
normalises it into a clean shape of best + alternative releases (release group,
tracker, infoHash, file list, total on-disk size).

## What it does

Given an AniList anime ID (or a title, which is resolved to an AniList ID via
the public AniList GraphQL API), the model fetches the matching SeaDex entry and
writes a normalised `entry` resource containing:

- `bestReleases` / `alternativeReleases` — each with `releaseGroup`, `tracker`,
  `url`, `infoHash`, `dualAudio`, `tags`, `totalSizeBytes`, `fileCount`, and the
  largest (`primaryFile`).
- `notes`, `theoreticalBest`, `comparisonUrls`, `incomplete` — SeaDex metadata.
- `sourceUrl`, `timestamp`, and optional caller-supplied user metadata
  (`userScore`, `userStatus`, `userSeason`, `userYear`, `currentPath`,
  `currentSizeBytes`, `currentFileCount`) used for upgrade analysis.

## Configuration

The model takes two optional global arguments:

| Argument    | Default                | Description                          |
| ----------- | ---------------------- | ------------------------------------ |
| `baseUrl`   | `https://releases.moe` | SeaDex root URL.                     |
| `userAgent` | `swamp-seadex/1.0`     | `User-Agent` string sent on requests |

Both have sensible defaults, so an instance needs no arguments at all:

```yaml
type: "@magistr/seadex"
typeVersion: 2026.05.25.1
name: seadex
version: 1
tags: {}
globalArguments: {}
methods: {}
```

## Methods

| Method                 | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `lookup-by-anilist-id` | Fetch the SeaDex entry for an anime by its AniList ID.            |
| `lookup-by-title`      | Resolve a title to an AniList ID, then fetch the entry.           |
| `lookup-many`          | Fan-out: look up an array of AniList IDs in one execution.        |
| `render-upgrades`      | Set filter markers (year/status/minScore) for an upgrades report. |

### Usage

```bash
# Look up a single anime by its AniList ID
swamp model method run seadex lookup-by-anilist-id --input anilistId=1

# Look up by title (resolved via AniList GraphQL)
swamp model method run seadex lookup-by-title --input title="Cowboy Bebop"

# Fan-out batch lookup of several IDs in one execution
swamp model method run seadex lookup-many \
  --input 'items=[{"anilistId":1},{"anilistId":5}]' \
  --input concurrency=5

# Inspect the results that were written
swamp data query seadex entry --json
```

## License

MIT — see [LICENSE.md](LICENSE.md).
