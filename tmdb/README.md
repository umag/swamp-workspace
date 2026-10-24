# @magistr/tmdb

Read-only [The Movie Database](https://www.themoviedb.org/) (TMDB v3) access for
swamp: search, details, and two fan-out methods built for whole-library work —
`match` (titles → candidate ids) and `enrich` (ids → normalized details). Both
cache their output and reuse it, so a re-run over an unchanged library makes
zero requests.

## Setup

Get a token at https://www.themoviedb.org/settings/api (either the v4 "API Read
Access Token" or the v3 "API Key" works), store it in a vault, and point the
instance at it:

```bash
swamp vault put tmdb TMDB_API_TOKEN  # prompts for the value (hidden input)
swamp model create @magistr/tmdb tmdb \
  --global-arg 'apiToken=${{ vault.get(tmdb, TMDB_API_TOKEN) }}'
```

Optional global arguments: `language` (default `en-US`), `region` (whose age
certification is extracted, default `NL`), `includeAdult`, `minIntervalMs`
(request spacing, default 100), `timeoutMs`.

## Methods

| Method    | What it does                                                                                                        | Resource                      |
| --------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `search`  | One query (`movie`, `tv` or `multi`), results scored against it                                                     | `search-<type>-<slug>-<hash>` |
| `details` | One movie/show with credits, keywords, external ids, certification                                                  | `title` `<kind>-<id>`         |
| `match`   | Batch: `items: [{key, title, altTitles?, year?, kind?, tmdbId?}]` → top-5 candidates + string-score verdict per key | `match` `<name>`              |
| `enrich`  | Batch: `ids: [{id, kind}]` → normalized details keyed `kind:id`                                                     | `titles` `<name>`             |

```bash
swamp model method run tmdb search --input query="Ame Agaru" --input year=1999
swamp model method run tmdb details --input id=13
```

### match

Each item is searched with every distinct title (`title` + `altTitles`) and the
year; if nothing comes back, the search is repeated without the year. Candidates
are scored as `0.75 × best title similarity + 0.25 × year
agreement` (titles
folded: accents, case, punctuation, leading article, `ё→е`), and the verdict is
`matched` (best ≥ `minScore` and ahead of the next by ≥ 0.05), `ambiguous`,
`unmatched`, `pinned` (the item carried a `tmdbId`) or `error`. The verdict is a
hint — consumers such as `@magistr/film-library` let Jev make the final call
over the candidates.

Idempotency: an entry is reused while its query fingerprint is unchanged and it
is younger than `ttlDays`; `refresh` / `refreshKeys` force re-resolution;
`maxQueries` bounds a run and lists the rest as `pending`. A 401 aborts the run;
other per-item failures become `error` entries.

### enrich

```yaml
- task:
    type: model_method
    modelIdOrName: tmdb
    methodName: enrich
    inputs:
      name: films
      ids: ${{ data.query('modelName == "films" && specName == "resolution"', 'attributes')[0].enrichIds }}
```

Details carry `imdbId`, `wikidataId`, `title`, `originalTitle`,
`originalLanguage`, `year`, `runtime`, `genres`, `countries`, `spokenLanguages`,
`overview`, `tagline`, `voteAverage`, `voteCount`, `certification`, `directors`
(creators for TV), `writers`, top-10 `cast`, `keywords`, `collection`,
`seasons`/`episodes`, `posterUrl`, `backdropUrl`.

## Security

The token is a sensitive global argument and is never written into a resource;
any error text is scrubbed of it and of `api_key=` values. 429 and 5xx responses
are retried up to three times honouring `Retry-After` (capped at 30 s).
