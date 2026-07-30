# Fixture provenance

Every JSON file in this directory is **pure doc-derived**, hand-authored from
the published [Subsonic REST API](http://www.subsonic.org/pages/api.jsp)
envelope shape (the `subsonic-response` wrapper `gonic.ts`'s `gonicApi()`
unwraps), never captured from a live call. This mirrors the `porkbun` /
`tubearchivist` precedent (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition)

A live `my-gonic` (`@magistr/gonic`) model instance and a `gonic` vault **do
exist** in this homelab. **Live capture from that instance is FORBIDDEN** for
this fixture corpus — not "not done this time", but a standing rule for anyone
regenerating these fixtures later:

- No `swamp model method run my-gonic <method>` call was made while authoring
  these fixtures.
- No vault credential (`gonic` vault: `PASSWORD`) was read, exported, or
  otherwise touched.
- No SSH connection to the real gonic host was opened, and no real `gonic.db`
  row, podcast feed, playlist, or filesystem path from any real library appears
  anywhere below.
- The admin-only endpoints (`refreshPodcasts`, `deletePodcastChannel`,
  `deletePodcastEpisode`, `downloadPodcastEpisode`) were never invoked against
  the live API — the methods suite exercises them purely against the stubbed
  fetch.

The fixtures-secret-scan test in
`../extensions/models/gonic_adversarial_test.ts` is a **mechanical backstop**,
not the primary control — the primary control is this prohibition plus never
running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero.

## Every value is synthetic

- Podcast/episode/playlist ids: `pd-1`/`pd-2`, `pe-1`/`pe-2`, `pl-1`/`pl-2` —
  synthetic sequential placeholders in gonic's real `pd-<n>`/`pe-<n>` id shape,
  never real gonic-database ids.
- Feed URLs: `feeds.example.com` — IANA's reserved example domain
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never a real feed.
- Podcast/playlist titles, descriptions, and file paths: generic placeholder
  strings ("Example Podcast One", "Episode One: Getting Started", `podcasts/
  Example Podcast One/Episode One.mp3"), not any real library's content.
- `serverVersion` in `ping.json`: a placeholder string
  (`v0.16.2 (synthetic-fixture)`), not the real deployed gonic build.
- Error code `40` / message in `error.json`: the Subsonic-documented "Wrong
  username or password" error code, with a message suffixed
  `(synthetic fixture)` so it can never be mistaken for a real credential
  failure log line.

## Per-file mapping to the documented endpoint

| File                 | Documented endpoint (Subsonic REST API)         | Unwrap path pinned                                    |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `ping.json`          | `GET /rest/ping`                                | `sr.status/version/type/serverVersion/openSubsonic`   |
| `get-podcasts.json`  | `GET /rest/getPodcasts`                         | `sr.podcasts.channel[].episode[]`                     |
| `scan-status.json`   | `GET /rest/getScanStatus`                       | `sr.scanStatus` (idle: `scanning:false`)              |
| `start-scan.json`    | `GET /rest/startScan`                           | `sr.scanStatus` (active: `scanning:true`)             |
| `get-playlists.json` | `GET /rest/getPlaylists`                        | `sr.playlists.playlist[]`                             |
| `error.json`         | Generic Subsonic failed envelope (any endpoint) | `sr.status === "failed"` -> `sr.error.{code,message}` |

## A documented shape this corpus deliberately preserves

`get-podcasts.json`'s second channel (`pd-2`) omits the `episode` key entirely
(a channel with a feed error has no episodes yet), and its second episode
(`pe-2`) omits `description`/`publishDate`/`size`/`duration`/`path` (a
still-downloading episode has no size/duration yet). `get-playlists.json`'s
second playlist (`pl-2`) omits `owner`/`created`/`changed`. These asymmetries
are real Subsonic-server behavior (optional fields are omitted, not sent as
`null`), and the contract-fixture suite pins that `gonic.ts`'s `|| []` /
`|| default` guards handle the omission rather than assuming every optional
field is always present.

## Not committed: the local sqlite3/SSH contract

`db-query`, `db-exec`, and `ensure-podcast-dirs` do not go through the Subsonic
HTTP contract at all — they shell out over SSH to `sqlite3 -json` and
`docker inspect`/`mkdir` on the gonic host. That is a **local-tool contract**,
not an external wire format, so its canned stdout is authored **inline** in
`gonic_methods_test.ts` / `gonic_adversarial_test.ts` / `gonic_coverage_test.ts`
rather than committed here as a fixture file (per STANDARD.md's fixture
convention: `<extension>/fixtures/` is for the external API contract).
