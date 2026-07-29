# Fixture provenance

Every JSON file in this directory is **pure doc-derived synthetic data**,
hand-authored from the shapes `@magistr/seadex`'s `seadex.ts` already declares
(`SeadexFile`, `SeadexTorrent`, `SeadexEntry`, `PbList<T>`, the AniList GraphQL
response shape `anilistFindIdByTitle` parses) plus the public API surfaces
described in `seadex/README.md` and https://releases.moe/about/. Nothing here
was captured from a live call to releases.moe or graphql.anilist.co. This
mirrors the `porkbun` wave-1 and `seanime` wave-2a precedents (synthetic
fixtures, no live capture) but the _reason_ live capture is forbidden is
different for seadex — see below.

## What was NOT done (explicit prohibition)

- No `swamp model method run <seadex-instance> lookup-by-anilist-id` (or
  `lookup-by-title` / `lookup-many`) call was made against the real
  `https://releases.moe` Pocketbase API while authoring these fixtures.
- No request was sent to the real `https://graphql.anilist.co` endpoint.
- No real SeaDex `alID`, torrent `infoHash`, release-group/tracker pairing, or
  file name from an actual entry on releases.moe appears anywhere below.
- No real AniList anime id or title was looked up and copied in; `1` / "Fixture
  Voyager" are invented placeholders picked to be obviously synthetic.

## Why live capture is forbidden (seadex-specific, NOT a credential-leak concern)

seadex is **credential-less**: `https://releases.moe` and
`https://graphql.anilist.co` are both public, unauthenticated, read-only APIs.
The model's `globalArguments` are only `baseUrl` and `userAgent` — there is no
vault secret, API key, or session token anywhere in this extension (unlike
porkbun's `pk1_`/`sk1_` API keys or seanime's `X-Seanime-Token` server-password
hash). **If this document simply copied the cousins' "prevents credential
leakage" framing, the reasoning would not apply here** — a future regenerator
reading a copy-pasted rationale could conclude the ban is inapplicable to a
credential-less model and capture live data anyway.

The actual hazard is different: a torrent's `infoHash` is a globally unique,
verifiable identifier for one specific set of copyrighted video files, and
SeaDex's `alID` + `theoreticalBest`/`notes` fields tie that hash to a specific,
real, real-world anime title. A fixture built by capturing a real
`lookup-by-anilist-id` response would durably commit **real infoHash + real
anime title pairs** — i.e., a verifiable pointer to actual (in most cases
copyrighted) torrent content — into this repository's git history, forever,
regardless of whether the response also happened to carry any secret.
Doc-derived synthetic fixtures remove this hazard _structurally_: every `alID`,
title, `infoHash`, and file name below is invented, so there is no real content
for the corpus to bind to. Keep the ban; the reason is "don't durably associate
this repository with specific copyrighted torrent content," not "don't leak a
credential this model doesn't have."

## Every value is synthetic

- AniList media id `1` and title "Fixture Voyager" (`anilist-media.json`,
  `pocketbase-entry.json`) — an invented placeholder id/title pair picked to be
  obviously synthetic (id `1` also happens to be the exact example the model's
  own README's `Usage` section uses for `lookup-by-anilist-id`), not a real
  AniList entry.
- Release groups `SubsPlease` / `Judas` and trackers `Nyaa` / `AnimeBytes` —
  real, publicly-known category names (the same convention `seanime.ts` already
  hardcodes as default release groups), used here only to make the fixture
  legible; no specific real torrent from either tracker is referenced.
- `infoHash`: `aaaa...` and `bbbb...` (40 repeated `a`/`b` characters) — two
  syntactically valid 40-character SHA-1-shaped info-hash placeholders, each
  trivially recognizable as synthetic (1 distinct character), never a real
  torrent's hash. See "Entropy escape" below for why this specific shape matters
  to the adversarial suite's secret-scan.
- URLs use the IANA-reserved `.example` TLD
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) — `nyaa.example`,
  `tracker.example`, `slow.pics.example` — never a resolvable real host.
- File names (`Fixture Voyager - 01 (1080p) [aaaaaaaa].mkv`, etc.) and file
  sizes (`734003200`, `728400000`, `367000000`) — invented byte counts in a
  plausible 1080p/720p episode range, not sizes of any real file.
- `anilist-graphql-error.json`'s `errors[]` envelope
  (`{"errors":[{"message":"Something went wrong. Please contact support for
  more information.","status":500,...}],"data":null}`)
  — a synthetic transcription of AniList GraphQL's publicly documented error
  envelope shape (errors alongside `data: null`, returned at HTTP 200), not a
  captured response.

## Entropy escape for the low-entropy infoHash placeholder

The adversarial suite's fixtures-secret-scan flags high-entropy,
token/hash-shaped strings as a mechanical backstop against accidentally
committing a real secret or a real-looking hash. A real 40-character SHA-1 info
hash is exactly the kind of value that pattern is built to catch — which would
also flag OUR placeholder if the scan only checked length/character-class.
`distinctCharCount(s)` (count of distinct characters in the string) is the
escape: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` has exactly **1** distinct
character, and `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` also has exactly **1**
— both far below the `>= 10` distinct-character threshold the high-entropy
pattern requires to fire (per the `seanime` wave-2a precedent). A real-looking
40-hex infoHash (e.g. mixed hex digits with `distinctCharCount

> = 10`) is used as that pattern's tailored poison value in the adversarial
> suite's per-pattern sanity test, proving the scan actually distinguishes
> "looks like a real hash" from "obviously a repeated-character placeholder"
> rather than merely tolerating our own fixtures by coincidence.

## Per-file mapping to the documented upstream contract

There are **two distinct upstream wire contracts** pinned here — releases.moe's
Pocketbase list envelope and AniList's public GraphQL envelope — each in both
its success and its "nothing found" / error shape.

| File                         | Upstream                     | Documented shape                                                                                                                                                |
| ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pocketbase-entry.json`      | releases.moe (Pocketbase)    | `GET /api/collections/entries/records?filter=(alID=N)&expand=trs` — one matching entry, `expand.trs` holding 2 torrents (one `isBest:true`, one `isBest:false`) |
| `pocketbase-empty.json`      | releases.moe (Pocketbase)    | Same endpoint, `items: []` — alID not (yet) in SeaDex                                                                                                           |
| `anilist-media.json`         | graphql.anilist.co (AniList) | `{data:{Media:{id,title:{romaji,english}}}}` — a successful title search match                                                                                  |
| `anilist-nomatch.json`       | graphql.anilist.co (AniList) | `{data:{Media:null}}` — a syntactically successful response with no match                                                                                       |
| `anilist-graphql-error.json` | graphql.anilist.co (AniList) | `{errors:[...],data:null}` at HTTP 200 — a GraphQL-level error, not an HTTP error                                                                               |

`anilist-nomatch.json` and `anilist-graphql-error.json` are deliberately paired
in the adversarial suite: `seadex.ts`'s `anilistFindIdByTitle` only ever checks
`data.data?.Media`, so both fixtures make `lookup-by-title` take the _identical_
"no match" code path — the GraphQL error is silently swallowed and
indistinguishable from a legitimate no-match. That equivalence is a pinned
characterization, not something this change fixes (`seadex.ts` is byte-frozen).

`pocketbase-entry.json`'s `alID: 1` intentionally matches `anilist-media.json`'s
`Media.id: 1`, so the two fixtures compose into one full two-hop
`lookup-by-title` happy path (AniList resolves title -> id `1` -> Pocketbase has
an entry for `alID=1`) without needing a third combined fixture file. Pairing
`anilist-media.json` with `pocketbase-empty.json` instead produces the THIRD,
middle `lookup-by-title` outcome: AniList resolves but SeaDex has no entry yet
(`found:false`, `alID` = the resolved AniList id, resource key `al-<id>`, title
= the AniList-resolved title) — distinct from both the full-hit and the
AniList-no-match paths.
