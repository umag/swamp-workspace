# Fixture provenance

Every JSON file in this directory is **pure doc-derived synthetic data**,
hand-authored from the wire shapes `@magistr/anime-cron`'s `anime_cron.ts`
already declares in source — `WATCHING_QUERY`, `COMPLETED_QUERY`,
`UPDATE_PROGRESS_MUTATION`, the inline AniList-search query in `mark-watched`,
the `TxTorrent` interface, and the `SeadexTorrent` interface — plus the
Transmission RPC and SeaDex (`releases.moe`) response shapes described in
`anime-cron/README.md`. Nothing here was captured from a live call. This mirrors
the `porkbun` wave-1 and `seanime`/`victorialogs` wave-2 precedents (synthetic
fixtures, no live capture) and is a deliberate security decision, not an
oversight.

## The Nyaa RSS body is deliberately NOT a committed fixture

Three of the four egress hosts (AniList, Transmission, SeaDex) speak JSON, so
their fixtures are committed here as `.json` files. The fourth, Nyaa
(`https://nyaa.si/?page=rss`), speaks RSS/XML. Rather than commit an XML file
into a fixtures/ directory whose entire point is a JSON corpus, the Nyaa wire
body is built **in-test** via a synthetic `rss(hits[])` helper local to each
test file (mirrors `victorialogs`'s in-test `ndjson()` helper for the same
reason: keep the committed corpus JSON-only, keep the wire-envelope assembly
itself part of the test, not a fixture). See
`../extensions/models/anime_cron_methods_test.ts`'s `rss()` function for the
exact tag shapes it emits (`<item>`, CDATA `<title>`, `<link>`,
`<nyaa:seeders>`, `<nyaa:infoHash>`) — these are transcribed directly from
`parseRSS`'s regexes in `anime_cron.ts`, not observed from a live Nyaa response.

## What was NOT done (explicit prohibition)

A live Transmission RPC endpoint and AniList account exist in this homelab's
anime pipeline (see `anime-cron/README.md`'s setup section — a
`local-encryption` vault holds `ANILIST_TOKEN`/`TX_PASSWORD`). **Live capture
from any real instance is FORBIDDEN** for this fixture corpus — not "not done
this time", but a standing rule for anyone regenerating these fixtures later:

- No `swamp model method run <instance> <method>` call was made against any real
  `@magistr/anime-cron` model instance while authoring these fixtures.
- No vault credential (`ANILIST_TOKEN` / `TX_PASSWORD`, however named in the
  operator's own vault) was read, exported, or otherwise touched.
- No real AniList media id, torrent name, download path, or SeaDex release from
  any account/library this pipeline manages appears anywhere below.
- The mutating/lookup endpoints (AniList `SaveMediaListEntry`, Transmission
  `torrent-add`, SeaDex `releases.moe`) were never invoked against a live server
  — their fixture shapes are transcribed from the model's own
  interfaces/queries, not observed side effects.

## Why live capture is forbidden (anime-cron-specific)

The credential surface is `anilistToken` (sent as an AniList
`Authorization:
Bearer` header) and `transmissionPass` (sent as a Transmission
`Authorization:
Basic` header) — **both request-side only**. Neither credential
is ever echoed back into an AniList, Nyaa, Transmission, or SeaDex **response**
body by any of the four hosts' real APIs, so these doc-derived synthetic
fixtures are structurally credential-free by construction, not by redaction. A
fixture corpus built by capturing and "redacting" a real response is exactly the
failure mode this repo's fixture policy exists to prevent — redaction is
fallible, and a doc-derived fixture removes the hazard structurally instead of
relying on catching every redaction miss.

The fixtures-secret-scan test in
`../extensions/models/anime_cron_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data (the same point the
security review made on the porkbun and seanime precedents).

## Every value is synthetic

- AniList media ids: `200101`/`200102` (watching), `200201`/`200202`
  (completed), `200301` (media-search) — synthetic sequential placeholders in a
  range no real AniList media id occupies today.
- Titles: `Fixture Chronicles`, `Fixture Wanderers`, `Fixture Legacy`,
  `Fixture Horizon` — invented names, not real anime titles.
- Torrent hashes: `aaaa...`/`bbbb...`/`cccc...`/`dddd...` (each 40 lowercase
  repeated hex characters) — syntactically valid 40-character SHA-1-shaped
  info-hashes that are trivially recognizable as placeholders, not real
  torrents' hashes.
- Transmission torrent/session ids (`11`, `12`, `13`) and the session-id string
  used by the methods/adversarial suites' 409-handshake stub
  (`fixture-tx-session-id`) — synthetic placeholders, not a real Transmission
  session.
- Timestamps (`1751490000`, `1751500000`, …) — arbitrary fixed epoch seconds in
  2025, not derived from any real download or airing event.

## Per-file mapping to the documented wire shape

| File                            | Source shape / query                                                 | Method(s) that read it                       |
| ------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| `anilist-watching.json`         | `WATCHING_QUERY` → `MediaListCollection` (status: CURRENT)           | `fetch-airing` (`getCurrentList`)            |
| `anilist-completed.json`        | `COMPLETED_QUERY` → `MediaListCollection` (status: COMPLETED)        | `upgrade-bd`                                 |
| `anilist-media-search.json`     | inline `Media(search: $search, type: ANIME)` query in `mark-watched` | `mark-watched`                               |
| `anilist-save-entry.json`       | `UPDATE_PROGRESS_MUTATION` → `SaveMediaListEntry` ack                | `mark-watched`                               |
| `transmission-torrent-get.json` | `TxTorrent[]` via Transmission RPC `torrent-get`                     | `fetch-airing`, `mark-watched`, `disk-stats` |
| `transmission-torrent-add.json` | Transmission RPC `torrent-add` → `torrent-added` ack                 | `fetch-airing`, `upgrade-bd`                 |
| `seadex-entry.json`             | SeaDex `releases.moe` records response → `items[0].expand.trs`       | `upgrade-bd`                                 |
| `error.json`                    | Generic AniList GraphQL `errors[]` envelope (any AniList call)       | any AniList-backed method                    |

The `torrent-duplicate` ack shape (the sibling of
`transmission-torrent-add.json`'s `torrent-added` ack) and the SeaDex
`{items: []}` empty-result shape are exercised **inline** in the
methods/adversarial suites rather than as separate committed fixture files —
small, single-purpose variants of an already-fixtured shape, mirroring
`seanime`'s precedent of exercising a fixture's alternate branch inline instead
of doubling the fixture count for a one-line JSON variation.

## A documented split from the seanime/porkbun precedent (methods suite owns the wire-envelope pins)

In `seanime` and `porkbun`, the contract-fixture suite pins the HTTP
wire-envelope directly (the concrete request/response shapes). Here,
`anime_cron_test.ts` (the pre-existing contract-fixture suite, kept
byte-unchanged as the anchor) only exercises the **pure, exported helper
functions** (`parseEpisode`, `parseResolution`, `groupScore`, `buildMagnet`,
`baseTitle`, `pickBest`, `toFolderName`, `extractShowTitle`) — because
`anime_cron.ts`'s actual wire parsers (`parseRSS`, `gqlRequest`, `txRpc`,
`seadexLookup`) are **module-private** (not exported) and only reachable through
a method's `execute()`. The HTTP wire-envelope pins (RSS → `NyaaHit`, AniList
`MediaListCollection`/`Media`/`SaveMediaListEntry` unwrap, the Transmission 409
session-id handshake, the SeaDex `trs` unwrap) therefore live in
`anime_cron_methods_test.ts` instead, driven through
`model.methods.<m>.execute()` against the fixtures in this directory. This is a
deliberate, forced divergence from the seanime/porkbun suite split, not an
oversight — see the plan's DDD analysis and `CHANGELOG.md` for the same note.
