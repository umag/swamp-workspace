# Fixture provenance

Every JSON file in this directory is **pure doc-derived / schema-derived**
synthetic data, hand-authored from the field names and types documented in
[developers.kaiten.ru](https://developers.kaiten.ru) and already encoded in
`kaiten.ts`'s own `z.object({...}).passthrough()` resource schemas (`Space`,
`Board`, `Column`, `Card`). **Nothing here was captured from a live call.**

## What was NOT done (standing prohibition, not "not done this time")

A live model instance named `kaiten` (`@magistr/kaiten`) and a vault also named
`kaiten` **exist in this homelab** and hold real, personal Kaiten board data.
This is a standing rule for anyone regenerating or extending this fixture corpus
later, not a one-time note:

- No `swamp model method run kaiten <method>` call (`listSpaces`, `getSpace`,
  `listBoards`, `getBoard`, `listColumns`, `listCards`, `getCard`) was made
  while authoring these fixtures.
- No vault credential was read, exported, or otherwise touched — specifically
  the `kaiten` vault's `API_TOKEN` key, which holds the real personal Bearer
  token. It never appears anywhere below, in any form (see the
  fixtures-secret-scan test in `../extensions/models/kaiten_adversarial_test.ts`
  for the mechanical backstop, which is _not_ the primary control — the primary
  control is this prohibition plus never running a live call in the first
  place).
- No real space, board, column, or card title/description/id from any workspace
  this account can see appears anywhere below.

## Every value is synthetic

- Space/board/column/card **ids**: small sequential integers (`42`, `43`, `128`,
  `512`, `513`, `99001`, `99002`) chosen to be obviously placeholder, not real
  Kaiten entity ids.
- **Titles**: generic, genre-appropriate placeholders ("Product Space", "Sprint
  Board", "Fix login bug") — no real project, product, or person name.
- **Timestamps**: synthetic ISO-8601 values in January 2026, sequential and
  internally consistent, not derived from any real activity.
- **uid**: a synthetic `SPACE-UID-00NN` placeholder, not a real Kaiten UUID.
- No token, session id, email address, or any other credential-shaped value
  appears in any fixture (enforced by the fixtures-secret-scan test).

## Per-file mapping to the documented endpoint

| File           | Documented endpoint                                                                                                                                                                           | Wire shape                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `spaces.json`  | `GET /spaces`                                                                                                                                                                                 | bare JSON array of Space                       |
| `boards.json`  | `GET /boards/{id}` — a single Board object, wrapped in a 1-element array here as an authoring convenience; the same object shape is also each item of the `GET /spaces/{spaceId}/boards` list | single Board JSON object, embeds columns/lanes |
| `columns.json` | `GET /boards/{boardId}/columns`                                                                                                                                                               | bare JSON array of Column                      |
| `cards.json`   | `GET /cards` (paginated)                                                                                                                                                                      | bare JSON array of Card                        |
| `card.json`    | `GET /cards/{id}`                                                                                                                                                                             | single Card JSON object                        |
| `error.json`   | any non-2xx response body                                                                                                                                                                     | generic `{message}` error envelope             |

## A documented API shape this corpus deliberately pins

Kaiten's list endpoints (`/spaces`, `/spaces/{id}/boards`,
`/boards/{id}/columns`, `/cards`) return a **bare JSON array**, not a
`{data:[...]}`/`{items:[...]}`/`{results:[...]}` envelope. `kaiten.ts`'s
`asArray()` helper tolerates all three wrapped shapes defensively ("some Kaiten
endpoints wrap lists" — see the comment above `asArray` in `kaiten.ts`), but the
_documented, actually-observed_ shape is the plain array pinned here. The
wrapped-envelope tolerance branches, the `[]` fallback for a
non-array/non-object body, and the numeric `condition` mapping are exercised in
`kaiten_coverage_test.ts` and `kaiten_adversarial_test.ts` instead of being
duplicated here — this corpus stays to _one shape per endpoint_ per the plan's
minimal-corpus decision.

`card.json`'s `condition` field is `1` (Kaiten's wire-level numeric "live"
value) — the `listCards` `condition` argument (`"live"`/`"done"`) is a
convenience mapping onto this numeric field (`live` → `1`, `done` → `2`); the
wire format itself only ever sends the number.
