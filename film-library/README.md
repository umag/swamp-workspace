# @magistr/film-library

A multidimensional catalog of the films on a home server, in the spirit of
`@magistr/music-library`: one bounded listing over SSH, a release-name parser,
**Jev** (TypeSafe System One, via `@swamp/typesafe-ai` +
`@webframp/typesafe-batch`) to resolve what each entry is and what it is called,
and TMDB to find and enrich the confirmed films.

## Pipeline

```
scan ─► names ─► Jev: kind + correct title ─► names ─► tmdb.match (confirmed titles)
                                                         │
catalog ◄─ tmdb.enrich ◄─ resolve ◄─ Jev: which candidate ◄─ resolve (ambiguous only)
```

Jev answers typed questions only (yes/no, choice); it cannot write a title. So
the parser proposes readings and Jev picks — before TMDB is called.

The shipped workflow `@magistr/film-library-refresh`
(`extensions/workflows/film-library-refresh.yaml`) wires it end to end.

## Setup

```bash
swamp extension pull @magistr/tmdb @swamp/typesafe-ai @webframp/typesafe-batch
swamp model create @magistr/film-library films --global-arg host=nas.example.lan
swamp model create @magistr/tmdb tmdb \
  --global-arg 'apiToken=${{ vault.get(tmdb, TMDB_API_TOKEN) }}'
swamp model create @swamp/typesafe-ai jev \
  --global-arg 'apiKey=${{ vault.get(typesafe, TYPESAFE_API_KEY) }}'
swamp workflow run films-refresh --input maxJevBatches=40
```

Global arguments: `host`, `sshUser` (root), `roots` (default
`/mnt/user/films/cinema` as `library` and `/mnt/user/downloads/complete` as
`incoming`), `maxDepth` (2), `tmdbInstance` (`tmdb`), `jevInstance` (`jev`),
`setName` (`films` — names the tmdb resources and prefixes Jev batches),
`overrides` (absolute path → TMDB id, for the rare wrong match), `ignore`.

## Methods

### scan

Lists each root to `maxDepth` levels with one `stat` per directory over a single
SSH session (≈6k entries in ~20 s) — never a recursive `find`, and disc
structures (`BDMV`, `VIDEO_TS`) are not descended. Every top-level entry becomes
an item: `film`, `series`, `episode`, `subtitle`, `other` (`software`,
`model3d`, `archive`, `audio`, `book`, `image`), `junk` (nfo, samples) or
`unknown`. A folder of distinct films (`Qatsi_Trilogy`, `Звездные войны`) splits
into collection members; `OLIMPIA1/2` stays one film.

Names are parsed into `title`, `altTitles`, `year`, `resolution`, `source`,
`codec`, `hdr`, `audio`, `edition`, `langTags`, `group`, season/episode:

| Name                                                          | Title                  | Alt                | Year |
| ------------------------------------------------------------- | ---------------------- | ------------------ | ---- |
| `1080p_Forrest_Gump_1994.mkv`                                 | Forrest Gump           |                    | 1994 |
| `12 разгневанных мужчин (1957. 12 Angry Men) BDRip 1080p.mkv` | 12 разгневанных мужчин | 12 Angry Men       | 1957 |
| `Большие спорщики_The Great Debaters [2007.BDRip.720p]`       | Большие спорщики       | The Great Debaters | 2007 |
| `Ame Agaru-(1999)-After The Rain-DIVX`                        | Ame Agaru              | After The Rain     | 1999 |
| `[1995] Hackers [BDRip] [1080p].mkv`                          | Hackers                |                    | 1995 |

### names

Each video entry gets 1–4 readings — the parsed title, alternative titles
(`Большие спорщики` / `The Great Debaters`), the folder vs main-file parse, each
with its year. Jev is asked, in batches of ≤100:

- a `choice` per entry: `feature_film`, `tv_series`, `stage_or_concert`,
  `documentary`, `short_or_clip`, `not_video` — a confident non-film kind (≥
  `kindThreshold`, 0.7) ends the entry before TMDB;
- a `noul` per reading: _is this the actual title (and year) of the film in this
  file?_ Every reading with P ≥ `nameThreshold` (0.6) is confirmed — the most
  likely becomes the title, the others alt titles. If Jev rejects them all, the
  entry is `rejected` and not searched.

Unanswered entries use the parser's reading, so a capped run still progresses.
Output: `names` with `decisions`, `matchQueries`, and the next `kindBatches` /
`nameBatches`.

### resolve

TMDB has searched the confirmed title. A clear hit (string-score `matched`) is
accepted as is. For an ambiguous search — or an unmatched one that still
returned candidates — Jev answers _is candidate X this file's film?_ for the top
3; the top candidate is accepted when P ≥ `threshold` (0.8) and leads the next
by ≥ `margin` (0.2). Output: `resolution` with `decisions`, `enrichIds`, and the
next `pairBatches`.

### catalog

Writes one `film` fact per film (parsed tags + TMDB details + quality rank),
`dimension` rollups (`genres`, `decades`, `countries`, `languages`, `directors`,
`resolutions`, `sources`, `hdr`, `collections`), `issues` worklists, and a
`library` summary:

| Worklist               | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `unmatched`            | films with no accepted TMDB id, with Jev's verdict and candidates  |
| `nonFilmInFilmFolders` | entries Jev is confident are concerts, clips, series or not video  |
| `libraryDupes`         | same film twice in the library, keep-best + reclaimable bytes      |
| `incomingAlreadyOwned` | downloads already in the library (`isUpgrade` when better quality) |
| `incomingToImport`     | downloaded films not yet in the library                            |
| `seriesInLibrary`      | TV series sitting in the film folder                               |
| `nonFilmIncoming`      | software, 3D models, archives… in downloads, with sizes            |

```bash
swamp data query 'modelName == "films" && specName == "library"' --select content
swamp data query 'modelName == "films" && specName == "film" && content.tmdb.directors.exists(d, d == "Akira Kurosawa")'
```
