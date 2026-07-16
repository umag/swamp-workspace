# @magistr/kaiten

A **read-only** swamp model that wraps the [Kaiten](https://kaiten.ru)
work-management REST API ([developers.kaiten.ru](https://developers.kaiten.ru)).
It lists and fetches **spaces, boards, columns, and cards**, writing each item
into the swamp data model so you can query it later with CEL expressions.

The model never creates, mutates, or deletes anything in Kaiten — every method
is a `GET`. Each `list*` method is a fan-out factory: a single invocation writes
one resource per item plus one `summary`, acquiring the model lock once instead
of looping per item. `listCards` paginates internally (offset/limit) up to
`maxResults`. The shared HTTP helper backs off and retries automatically on HTTP
`429`, honouring the `Retry-After` / `X-RateLimit-Reset` headers (Kaiten allows
50 req/s).

## Methods

| Method        | Kaiten endpoint                 | Writes                        |
| ------------- | ------------------------------- | ----------------------------- |
| `listSpaces`  | `GET /spaces`                   | one `space` each + `summary`  |
| `getSpace`    | `GET /spaces/{id}`              | one `space`                   |
| `listBoards`  | `GET /spaces/{spaceId}/boards`  | one `board` each + `summary`  |
| `getBoard`    | `GET /boards/{id}`              | one `board` (columns + lanes) |
| `listColumns` | `GET /boards/{boardId}/columns` | one `column` each + `summary` |
| `listCards`   | `GET /cards` (paginated)        | one `card` each + `summary`   |
| `getCard`     | `GET /cards/{id}`               | one `card`                    |

## Configuration

The model authenticates with a personal API token. Create one in Kaiten under
your profile's API-key settings, store it in a vault, and reference it from the
model's `globalArguments`.

```bash
# Store the token in a local-encryption vault
swamp vault create local_encryption kaiten
swamp vault put kaiten API_TOKEN=<your-token> -f

# Create the model instance
swamp model @magistr/kaiten create kaiten
```

Then set the global arguments (`swamp model edit kaiten --json`):

```yaml
type: "@magistr/kaiten"
typeVersion: "2026.06.21.1"
id: 00000000-0000-0000-0000-000000000000
name: kaiten
version: 1
tags: {}
globalArguments:
  domain: acme # bare subdomain (acme.kaiten.ru) or a full host
  apiVersion: latest # path segment: "latest" (default) or "v1"
  token: ${{ vault.get(kaiten, API_TOKEN) }}
  timeoutMs: 15000 # optional, per-request timeout
  maxRetries: 5 # optional, retries after a 429
methods: {}
```

| Argument     | Default                           | Description                               |
| ------------ | --------------------------------- | ----------------------------------------- |
| `domain`     | — (required)                      | `acme` → `acme.kaiten.ru`, or a full host |
| `apiVersion` | `latest`                          | API version segment in the base path      |
| `token`      | — (required)                      | Bearer token; use a vault reference       |
| `timeoutMs`  | `15000`                           | Per-request fetch timeout                 |
| `maxRetries` | `5`                               | Retries after an HTTP 429                 |
| `userAgent`  | `swamp-kaiten/1.0 (+swamp-club…)` | `User-Agent` header on all requests       |

## Usage

```bash
# List every space
swamp model method run kaiten listSpaces

# List boards in a space, then its columns
swamp model method run kaiten listBoards --input spaceId=42
swamp model method run kaiten listColumns --input boardId=128

# List cards on a board (paginates automatically, up to maxResults)
swamp model method run kaiten listCards --input boardId=128

# Filter cards: only live (active) cards in a column, free-text search
swamp model method run kaiten listCards \
  --input boardId=128 --input columnId=512 --input condition=live
swamp model method run kaiten listCards --input query="release" --input maxResults=200

# Pass through any raw Kaiten query parameter not exposed as a named filter
swamp model method run kaiten listCards \
  --input boardId=128 --input 'additionalParams={"tag_ids":"3,7"}'

# Fetch a single card / board / space by id
swamp model method run kaiten getCard --input id=99001
swamp model method run kaiten getBoard --input id=128
swamp model method run kaiten getSpace --input id=42
```

## Querying the data

Once a method has run, the results live in the swamp data model:

```bash
# All cards fetched, as a table
swamp data list kaiten

# CEL query: open cards on a specific board (condition 1 = live)
swamp data query kaiten 'data.attributes.board_id == 128 && data.attributes.condition == 1'

# The most recent listing summary (counts + ids + filters used)
swamp data query kaiten 'data.attributes.scope == "cards"'
```

> Card `condition` is Kaiten's numeric field: `1` = live/active, `2` = done. The
> `listCards` `condition` argument (`live` / `done`) maps onto it.

## Notes

- **Read-only by design.** If you need to create or update cards, that is a
  deliberate follow-up — this model intentionally exposes no mutating methods.
- **Endpoint paths** follow Kaiten's `api/<version>` REST surface. Self-hosted
  installations work by passing the full host as `domain`.
- **Rate limits.** Kaiten permits 50 req/s; the model reads `X-RateLimit-*`
  headers and retries on `429`, so large `listCards` runs are safe.

## License

MIT — see [LICENSE.md](LICENSE.md).
