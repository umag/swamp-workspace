# Fixture provenance

Every JSON file in this directory is **pure doc-derived synthetic data**,
hand-authored from the shapes `@magistr/seanime`'s `seanime.ts` already declares
(`GlobalArgsSchema`, `StatusSchema`, `CollectionSchema`, `MissingEpisodeSchema`,
`TorrentSchema`/`TorrentListSchema`, and the AniList `MediaListCollection` shape
the bulk methods read) plus the Seanime `/api/v1` REST surface described in
`seanime/README.md`. Nothing here was captured from a live call. This mirrors
the `porkbun` wave-1 precedent (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight — seanime's credential surface is
meaningfully larger than porkbun's (see "Why live capture is forbidden" below).

## What was NOT done (explicit prohibition)

A live `my-seanime` (`@magistr/seanime`) model instance exists in this homelab,
reachable over the real Seanime `/api/v1` surface, with a `seanime` vault
holding its `TOKEN` (the `X-Seanime-Token` server-password hash). **Live capture
from that instance is FORBIDDEN** for this fixture corpus — not "not done this
time", but a standing rule for anyone regenerating these fixtures later:

- No `swamp model method run my-seanime <method>` call was made while authoring
  these fixtures.
- No vault credential (`seanime` vault: `TOKEN`) was read, exported, or
  otherwise touched.
- No real AniList media id, list entry, torrent, or library path from any
  account/library this instance manages appears anywhere below.
- The mutating endpoints (`/library/scan`, `/auto-downloader/run`,
  `/auto-downloader/rule`, `/anilist/list-entry`) were never invoked against the
  live API — their fixture shapes are transcribed from the model's own
  schemas/README, not observed side effects.

## Why live capture is forbidden (seanime-specific, not a generic disclaimer)

Unlike porkbun's `/ping` (which only ever returns the caller's public IP),
Seanime's real `GET /status` response's `settings` object carries **live
credential material**: the configured torrent client's password (under
`settings.torrent`) and, once a user has linked AniList, the account's OAuth
access token surfaces through the same settings/session state that backs
`GET /anilist/collection`. A fixture corpus built by capturing and "redacting" a
real `/status`/`/anilist/collection` response is exactly the failure mode this
repo's fixture policy exists to prevent — redaction is fallible, and a
doc-derived fixture removes the hazard structurally instead of relying on
catching every redaction miss.

`status.json` in this corpus therefore contains a `settings` object with **no
token or password field of any kind** — not a redacted placeholder, an actual
omission, because the doc/schema shapes seanime.ts declares
(`StatusSchema.settings` is `z.object({}).passthrough()`) never require one to
be present for the contract/methods suites to exercise the `/status` method.
`anilist-collection.json` likewise carries only the
`MediaListCollection.lists[].entries[].media` shape the bulk methods read — no
session/auth block at all.

The fixtures-secret-scan test in
`../extensions/models/seanime_adversarial_test.ts` is a **mechanical backstop**,
not the primary control — the primary control is this prohibition plus never
running a live call in the first place. Its patterns are seanime-specific (the
vault key name `TOKEN`, the `X-Seanime-Token` header-value shape, a generic
high-entropy blob), not porkbun's `pk1_`/`sk1_` prefixes, because those would
never catch a leaked Seanime credential. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data (see the security
review's residual LOW finding on plan v2, which makes the same point about the
porkbun precedent).

## Every value is synthetic

- Base URL: `http://seanime.example.com:3211` — IANA's reserved example domain
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never a real host. The
  internal `qbittorrentHost` in `status.json` reuses the same reserved domain.
- AniList media ids: `100001` (library-collection.json) and `200001`–`200003`
  (anilist-collection.json, auto-downloader-rules.json) — synthetic sequential
  placeholders in a range no real AniList media id occupies today, not real
  AniList ids.
- Titles: `Fixture Chronicles`, `Fixture Wanderers`, `Fixture Horizon`,
  `Fixture Legacy` — invented names, not real anime titles.
- Torrent hash: `aaaa...` (40 lowercase `a`s) — a syntactically valid
  40-character SHA-1-shaped info-hash that is trivially recognizable as a
  placeholder, not a real torrent's hash.
- User id `424242` in `status.json` — a synthetic placeholder.
- `error.json`: a generic Seanime-shaped error body
  (`{"error": "invalid or missing X-Seanime-Token"}`) — descriptive of the
  auth-failure case the model's `!resp.ok` branch maps into a thrown error, not
  a captured server response.

## Per-file mapping to the documented endpoint

| File                         | Documented endpoint / method                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `status.json`                | `GET /status` (method `status`)                                                           |
| `library-collection.json`    | `GET /library/collection` (method `library-collection`)                                   |
| `missing-episodes.json`      | `GET /library/missing-episodes` (method `missing-episodes`)                               |
| `torrent-list.json`          | `GET /torrent-client/list` (method `torrent-list`)                                        |
| `anilist-collection.json`    | `GET /anilist/collection` (read inside `sync-planning-rules` and `set-planning-watching`) |
| `auto-downloader-rules.json` | `GET /auto-downloader/rules` (read inside `sync-planning-rules`)                          |
| `list-entry.json`            | `POST /anilist/list-entry` ack (write inside `set-planning-watching`)                     |
| `error.json`                 | Generic Seanime error body (any endpoint's non-`resp.ok` path)                            |

The `{data: ...}` envelope on every fixture (except `error.json`, which is never
parsed via `resp.json()` — the model's error branch reads `resp.text()` instead)
mirrors `seanimeRequest`'s actual unwrap:
`json.data !== undefined ? json.data : json`. The contract-fixture suite pins
this unwrap directly against these fixtures, independent of the loose
`.passthrough()` resource schemas.

## A documented API asymmetry this corpus deliberately preserves

`torrent-list.json`'s `data` is a bare **array**, matching one of the two shapes
`torrent-list`'s handler normalizes
(`Array.isArray(data) ? data : (data?.torrents ?? [])`). The alternate
`{torrents: [...]}` object shape is exercised inline in the coverage suite
rather than as a second fixture file, since the plan's fixture list is fixed at
8 files/endpoints — both sides of that guard are still covered by tests, just
not both committed as separate JSON corpora.

`anilist-collection.json`'s `PLANNING` list deliberately includes one entry per
relevant airing status (`RELEASING`, `NOT_YET_RELEASED`, `FINISHED`) so the same
fixture drives every branch of both bulk methods' eligibility filter (default
`includeFinished:false` skips the `FINISHED` entry; `includeFinished:true`
includes it) without needing per-branch fixture variants.
`auto-downloader-rules.json` pre-seeds a rule for mediaId `200001` only, so
`sync-planning-rules` exercises both the "rule already exists" skip (`200001`)
and the "status ineligible" skip (`200003` when `includeFinished:false`) from
the same two fixtures.
