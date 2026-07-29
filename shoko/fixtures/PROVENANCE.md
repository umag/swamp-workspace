# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the published [Shoko Server REST v3 documentation](https://docs.shokoanime.com/)
and the shapes `shoko.ts`'s own resource schemas already describe, never
captured from a live call. This mirrors the `porkbun` precedent (synthetic
fixtures, no live capture) and is a deliberate security decision, not an
oversight.

## What was NOT done (explicit prohibition)

A live `my-shoko` (`@magistr/shoko`) model instance and a `shoko-secrets` vault
**do exist** in this homelab. **Live capture from that instance is FORBIDDEN**
for this fixture corpus — not "not done this time", but a standing rule for
anyone regenerating these fixtures later:

- No `swamp model method run my-shoko <method>` call was made while authoring
  these fixtures.
- No vault credential (`shoko-secrets` vault: the Shoko `apikey` / account
  password) was read, exported, or otherwise touched.
- No real series name, episode title, file path, or library layout from any
  Shoko instance this account manages appears anywhere below.
- The maintenance/action endpoints (`run-action`, `remove-missing-files`,
  `rescan-folder`, `authenticate`) were never invoked against the live API —
  their fixture shapes are transcribed from the documentation's example
  responses and the model's own resource schemas, not observed side effects.

The fixtures-secret-scan test in
`../extensions/models/shoko_adversarial_test.ts` is a **mechanical backstop**,
not the primary control — the primary control is this prohibition plus never
running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data (see the security
review's residual LOW finding on plan v1).

## Every value is synthetic

- Host: `http://203.0.113.10:8111` (used in the test harness's `GLOBAL_ARGS`,
  not committed in any fixture file) — from the `TEST-NET-3` documentation range
  ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)), taken directly from
  `shoko.ts`'s own `host` field description.
- `apikey` in `auth.json`: `fixture-shoko-key-0001` — short, hyphenated, and
  well below the 32-character contiguous alphanumeric threshold the
  fixtures-secret-scan's high-entropy pattern looks for. A real Shoko apikey is
  an opaque 40+ character hex/base64-shaped token; this value is deliberately
  shaped to read as an obvious placeholder instead.
- Series/episode/file IDs (`101`, `102`, `501`, `502`, `601`, `9001`–`9003`):
  small synthetic sequential integers, not real Shoko database ids.
- Series names (`Example Series One`, `Example Series Two`) and episode names
  (`Episode 13`, `Episode 25`, `Episode 26`): generic placeholders, no real
  anime titles.
- File paths (`/Anime/Example Series One/Episode 01.mkv`, `/mnt/anime/main`,
  `/mnt/anime/backup`): generic placeholder paths, not real library layout.
- CRC32 values (`1A2B3C4D`, `5E6F7A8B`, `9C8D7E6F`): synthetic hex strings, not
  real file checksums.
- `error.json`: a generic ASP.NET-style `NullReferenceException` envelope — the
  documented shape of a Shoko server error page, not a captured failure.
- `swagger.json`: a hand-authored, deliberately minimal OpenAPI fragment
  covering exactly the four fixture-observable cases the adversarial suite needs
  (see "The list-actions prefix quirk" below) — not a captured copy of Shoko's
  real swagger document.

## Per-file mapping to the documented endpoint

| File                    | Documented endpoint                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `auth.json`             | `POST /api/auth`                                                                              |
| `status.json`           | `GET /api/v3/Init/Status`                                                                     |
| `dashboard.json`        | `GET /api/v3/Dashboard/Stats`                                                                 |
| `series.json`           | `GET /api/v3/Series` (wrapped) and `GET /api/v3/Series/Search/{query}` (its `List` used bare) |
| `files.json`            | `GET /api/v3/File`                                                                            |
| `missing-episodes.json` | `GET /api/v3/ReleaseManagement/MissingEpisodes/{Series\|Episodes}`                            |
| `duplicate-files.json`  | `GET /api/v3/ReleaseManagement/DuplicateFiles/{Series\|Episodes}`                             |
| `import-folders.json`   | `GET /api/v3/ImportFolder`                                                                    |
| `queue.json`            | `GET /api/v3/Queue` (multi-queue array response)                                              |
| `queue-single.json`     | `GET /api/v3/Queue` (single bare-object response variant)                                     |
| `swagger.json`          | `GET /swagger/v3/swagger.json`                                                                |
| `error.json`            | Generic Shoko/ASP.NET error envelope (any endpoint, non-2xx)                                  |

## The list-actions prefix quirk this corpus deliberately preserves

`shoko.ts`'s `list-actions` method filters `spec.paths` entries with
`path.startsWith('/Action/')`. `swagger.json` intentionally carries **both** a
`/api/v3/Action/RunImport` path (which does **not** match that prefix and is
therefore skipped) and a bare `/Action/Foo` path (which **does** match). This
fixture pins the code's prefix-matching rule as **fixture-observable behavior
only** — whether Shoko's real, live OpenAPI document actually lists paths with
or without the `/api/v3` server prefix is unobserved (live capture is forbidden
by this document), so the adversarial suite makes no claim about what a real
Shoko instance's `list-actions` call returns, only about what this code does
given a spec shaped either way. `swagger.json` also carries an `/Action/NoGet`
entry (a `POST`-only action) to pin that entries without a `get` method are
skipped regardless of their path.

## A documented API asymmetry this corpus deliberately preserves

`series.json`'s `List` items and `missing-episodes.json`'s items share the same
nested `IDs`/`Name` passthrough shape, per `shoko.ts`'s loose (`.passthrough()`)
resource schemas — the contract-fixture suite hardcodes the expected
keyset/value-types from the docs rather than leaning on those schemas (which
accept anything), so a real wire-format drift turns a test red instead of
passing silently.
