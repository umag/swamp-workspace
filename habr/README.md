# @magistr/habr

Read a [Habr](https://habr.com) user's publications and full article bodies from
Habr's public JSON API (`habr.com/kek/v2`) — no credentials required.

Habr's web pages are React-rendered, but the same data that hydrates them is
served as clean JSON by the `/kek/v2` API, so this model calls the API directly
rather than scraping markup.

## Model: `@magistr/habr`

### `list-articles`

Fan-out read: loops **every page** of a user's feed internally (one method run)
and writes one `articles` resource with the parsed summaries, newest first.

| Argument   | Type   | Notes                                                        |
| ---------- | ------ | ------------------------------------------------------------ |
| `user`     | string | Habr user alias, e.g. `Milfgard` (the alias, not full name). |
| `maxPages` | number | Optional cap on feed pages to fetch (default: all).          |

Each article summary carries: `id`, `title`, `url`, `lang`, `timePublished`,
`readingTime`, `complexity`, `postType`, `tags[]`, `hubs[]`, `author`, and
`statistics` (`reads`, `comments`, `score`, `votesPlus`, `votesMinus`,
`bookmarks`).

### `get-article`

Fetch a single article by its numeric publication `id`, including the full HTML
body (`textHtml`) plus the same summary fields.

| Argument | Type   | Notes                                       |
| -------- | ------ | ------------------------------------------- |
| `id`     | string | Numeric Habr publication id, e.g. `845266`. |

### `get-articles`

Fan-out version of `get-article`: fetches several ids in one run and writes one
`article` resource per id. Every id is validated before the first request, so
one bad id rejects the whole batch.

| Argument | Type     | Notes                                            |
| -------- | -------- | ------------------------------------------------ |
| `ids`    | string[] | Numeric Habr publication ids, e.g. `["845266"]`. |

## Global arguments

| Argument    | Default            | Notes                                                                       |
| ----------- | ------------------ | --------------------------------------------------------------------------- |
| `baseUrl`   | `https://habr.com` | Override for a mirror.                                                      |
| `userAgent` | Chrome desktop UA  | Override the request User-Agent.                                            |
| `timeoutMs` | `15000`            | Per-request timeout (spans redirect hops).                                  |
| `lang`      | `ru`               | Feed language, sent as the `fl`/`hl` params. Use `en` for the English feed. |

## Example

```bash
swamp model create @magistr/habr habr
swamp model @magistr/habr method run list-articles habr --input '{"user":"Milfgard"}'
swamp data get habr
```

Workflow step that pulls several article bodies in one run:

```yaml
- name: fetch-bodies
  task:
    type: model_method
    modelIdOrName: habr
    methodName: get-articles
    inputs:
      ids: ["845266", "828834"]
  dependsOn: []
  weight: 0
```

## Safety

- Every fetched URL is built internally from the configured base host plus a
  fixed API path; the caller-supplied `user`/`id` are shape-validated (alias:
  `[A-Za-z0-9_-]+`, id: digits) before use.
- A host allowlist (configured base host, or `habr.com` / `*.habr.com`) is
  re-checked on the initial request and on every redirect hop.
- `lang` must be 2–8 letters; a server-supplied `lang` that fails the same check
  is ignored. `pagesCount` is clamped to 1–500 pages per run.

## Tests

```bash
deno task test                 # all five suites, FC_NUM_RUNS=100
FC_NUM_RUNS=10000 deno task test:soak
```
