# @magistr/anime-cron

Anime automation pipeline for swamp: fetch new airing episodes from Nyaa, sync
watch progress back to AniList, and queue Blu-ray upgrades via SeaDex — all
without touching Seanime or any other media server GUI.

## Methods

| Method          | What it does                                         |
| --------------- | ---------------------------------------------------- |
| `fetch-airing`  | AniList CURRENT → Nyaa → Transmission                |
| `mark-watched`  | Transmission completed → AniList progress update     |
| `upgrade-bd`    | AniList COMPLETED → SeaDex → Transmission            |
| `fetch-archive` | Release groups → Nyaa → Transmission, seeded forever |
| `disk-stats`    | Transmission torrent usage by status                 |

## Setup

### 1. Create an AniList personal access token

Go to <https://anilist.co/settings/developer> → create a token. Required for
`mark-watched` and Telegram alerts from `fetch-airing`.

### 2. Add secrets to a vault

```bash
swamp vault create local-encryption anime-secrets
swamp vault set anime-secrets ANILIST_TOKEN   <your-token>
swamp vault set anime-secrets TX_PASSWORD     <transmission-password>
```

### 3. Create the model instance

```bash
swamp model create @magistr/anime-cron anime-cron
```

Edit the generated YAML — example `globalArguments`:

```yaml
globalArguments:
  anilistUser: "yourusername"
  anilistToken: "${{ vault.get(anime-secrets, ANILIST_TOKEN) }}"
  transmissionRpcUrl: "http://192.0.2.1:9091/transmission/rpc"
  transmissionUser: "admin"
  transmissionPass: "${{ vault.get(anime-secrets, TX_PASSWORD) }}"
  animeContainerDir: "/downloads/anime"
  preferredResolution: 1080
  telegramModel: ""
```

Set `telegramModel` to a `@magistr/telegram-send` model instance name to enable
Telegram notifications when episodes are queued or overdue.

## Usage

### Fetch new episodes (run hourly via workflow)

```bash
swamp model method run anime-cron fetch-airing
# dry run first:
swamp model method run anime-cron fetch-airing --input dryRun=true
```

### Sync completed downloads → AniList

```bash
swamp model method run anime-cron mark-watched
```

### Queue BD upgrades for completed shows

```bash
# Pass library scan output to skip shows already on disk:
swamp model method run anime-cron upgrade-bd \
  --input 'libraryEntries=${{ data.latest("anime-library","current").attributes.entries }}'
```

### Archive a preservation group's catalogue

Sweep every Nyaa release credited to a set of groups into `archiveContainerDir`
and pin it to seed forever. Cost the sweep first:

```bash
swamp model method run anime-cron fetch-archive --arg dryRun=true
# → found / queued / queuedGB / catalogGB, nothing touched
swamp model method run anime-cron fetch-archive
```

Defaults to `Kineko Video` + `LonelyChaser`; override for any other group:

```bash
swamp model method run anime-cron fetch-archive \
  --arg 'groups=["Kineko Video"]' --arg category=1_0 --arg minSeeders=2
```

Matching is on the leading `[..]` credit, so `[Kineko Video] …`,
`[LonelyChaser & Kineko Video] …` and the `[LonelyChaser-Raws] …` alias all
match, while `Kineko video presents …` (no credit bracket) does not.

Re-runs are safe: releases already in Transmission come back as duplicates, and
`seedForeverExisting` (default true) re-applies unlimited ratio/idle seeding to
everything already sitting in the archive dir — so a re-run also repairs
torrents added before this method existed.

`category` defaults to `0_0` (all categories) because these groups also post
live-action scans outside the anime categories. Narrow it to `1_0` if you only
want anime.

### Check disk usage

```bash
swamp model method run anime-cron disk-stats
swamp data get anime-cron
```

## Workflow example

Create an hourly workflow to auto-fetch airing episodes:

```yaml
name: anime-fetch-airing
trigger:
  schedule: "0 * * * *"
jobs:
  - name: fetch
    steps:
      - name: fetch-airing
        task:
          type: model_method
          modelIdOrName: anime-cron
          methodName: fetch-airing
          inputs:
            dryRun: false
            skipUnaired: true
```

## How `fetch-airing` picks torrents

1. Queries AniList for your CURRENT list and finds `progress + 1` as the next
   episode.
2. Searches Nyaa by romaji title → English title → synonyms → stripped base
   title (handles sequels like "Show S2" → "Show").
3. Scores results by preferred fansub group (SubsPlease > Erai-Raws > Ember >
   ASW > Judas), seeder count, and resolution match.
4. Deduplicates against existing Transmission torrents by `(show, episode)` key
   to avoid re-queuing.
5. Queues all aired-but-undownloaded episodes in one run (catchup support).

## SeaDex integration

`upgrade-bd` checks <https://releases.moe> for the recommended Blu-ray release
of each completed show on your AniList. It prefers `isBest=true` nyaa entries.
Pass `libraryEntries` from a `@magistr/anime-library` scan to skip shows already
on disk with the correct release group.
