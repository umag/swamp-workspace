# @magistr/ryot

Import a film history into a self-hosted
[Ryot](https://github.com/IgnisDa/ryot).

```bash
swamp model create @magistr/ryot ryot \
  --global-arg baseUrl=https://ryot.example \
  --global-arg 'authToken=${{ vault.get(<vault>, RYOT_AUTH_TOKEN) }}'
```

The token comes from Ryot → Settings → Integrations → Generate auth token.

| Method           | What it does                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_films`   | `snapshot` = a `@jamesakeech/letterboxd` `exportSnapshot`, `owned` = `[{tmdbId, title}]`. Watched/rated → one undated seen entry; ratings × 20 (Ryot rates 0–100); watchlist → Watchlist collection; owned → Owned collection (seen too with `ownedAsSeen`) |
| `import_reports` | Writes Ryot's import job reports: progress, success, failed items                                                                                                                                                                                           |

`import_films` builds one Ryot `CompleteExport`, uploads it to `/backend/upload`
and runs `deployImportJob(source: GENERIC_JSON)`. Ryot then fetches every movie
from TMDB itself. It needs `MOVIES_AND_SHOWS_TMDB_ACCESS_TOKEN` set on the
server.

Ryot does not dedupe seen entries across imports. After a non-dry run succeeds,
the method refuses to run again unless you pass `force: true`. Use
`dryRun: true` to see the counts and unresolved films first.

```yaml
jobs:
  - name: main
    steps:
      - name: import
        task:
          type: model_method
          modelIdOrName: ryot
          methodName: import_films
          inputs:
            snapshot: ${{ data.latest("letterboxd", "export").attributes }}
            dryRun: true
        dependsOn: []
        weight: 0
    dependsOn: []
    weight: 0
```

Letterboxd exports carry no TMDB ids. They are read from each film page's
`data-tmdb-id`, fetched with the host `curl` (Deno's `fetch` gets Cloudflare
challenges), and cached in `letterboxd-tmdb-map`. TV entries are reported as
unresolved.
