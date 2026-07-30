# Fixture provenance

Every file in this directory (and `bandcamp/`) is **pure doc-derived synthetic
data** — hand-authored from the published
[MusicBrainz Web Service v2 documentation](https://musicbrainz.org/doc/MusicBrainz_API)
and from the observable structure of Bandcamp's public discography/album pages
(schema.org JSON-LD + the `TralbumData` embed), never captured from a live call.
This mirrors the `porkbun`/`shoko` precedent (synthetic fixtures, no live
capture) and is a deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition — BOTH services)

**Live capture from either MusicBrainz or Bandcamp is FORBIDDEN** for this
fixture corpus — not "not done this time", but a standing rule for anyone
regenerating these fixtures later:

- No `swamp model method run <musicbrainz-instance> <method>` call was ever made
  against the real MusicBrainz Web Service while authoring these fixtures.
- No real Bandcamp page (`fetch`, browser, or otherwise) was ever scraped to
  produce the `fixtures/bandcamp/*.ts` HTML strings — every
  `<script
  type="application/ld+json">` block and `TralbumData` blob was
  hand-written from the documented/observed shape, not copied from a live page.
- No real artist, release, recording, or label name, and no real MusicBrainz
  MBID, appears anywhere below.
- No real Bandcamp subdomain, album, or track appears anywhere below.
- musicbrainz.ts has no credential surface (only a public-facing `userAgent`
  string) — there is no API key to leak — but the contact email embedded in
  every test `userAgent` value is still always `fixture@example.com` (never a
  real address), consistent with the RFC 2606 documentation-domain convention
  used across this fixture corpus.

The fixtures-secret-scan test in
`../extensions/models/musicbrainz_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero.

## Every value is synthetic

- MBIDs: `00000000-0000-0000-0000-00000000000N` (search/lookup results) and a
  handful of small variations on that pattern for browse/pagination fixtures —
  never a real MusicBrainz identifier.
- Names: `Fixture Aurora Static`, `Fixture Marin Holloway`,
  `Fixture Nightfall
  Static`, `Fixture Static Interference EP`, etc. —
  invented artist/release names using the word "Fixture" as a deliberate,
  greppable marker.
- Bandcamp subdomains: `fixtureaurorastatic.bandcamp.com`,
  `fixturemarinholloway.bandcamp.com`, `fixture.bandcamp.com` — synthetic, never
  a real Bandcamp artist page.
- `PROVENANCE.md`'s own `userAgent` / `fixture@example.com` — IANA's reserved
  example domain ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)).
- SSRF-pin target addresses used in the adversarial suite (`169.254.169.254`,
  `internal.corp.local`) are well-known documentation/reserved examples for
  cloud-metadata and internal-DNS scenarios, never a real reachable host this
  repo's author controls.

## Per-file mapping to the documented endpoint / page shape

| File                           | Documented MusicBrainz WS v2 endpoint / Bandcamp page shape                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artist-search.json`           | `GET /ws/2/artist?query=...&fmt=json`                                                                                                                                                           |
| `release-group-search.json`    | `GET /ws/2/release-group?query=...&fmt=json`                                                                                                                                                    |
| `release-search.json`          | `GET /ws/2/release?query=...&fmt=json`                                                                                                                                                          |
| `recording-search.json`        | `GET /ws/2/recording?query=...&fmt=json`                                                                                                                                                        |
| `label-search.json`            | `GET /ws/2/label?query=...&fmt=json`                                                                                                                                                            |
| `artist-lookup.json`           | `GET /ws/2/artist/<mbid>?fmt=json` (raw entity detail)                                                                                                                                          |
| `release-group-lookup.json`    | `GET /ws/2/release-group/<mbid>?fmt=json`                                                                                                                                                       |
| `browse-release-groups.json`   | `GET /ws/2/release-group?artist=<mbid>&fmt=json` (browse form — note the `release-group-count`/`release-group-offset` PREFIXED keys, distinct from search's bare `count`/`offset`)              |
| `browse-releases.json`         | `GET /ws/2/release?label=<mbid>&fmt=json` (browse form)                                                                                                                                         |
| `generic-search.json`          | `GET /ws/2/area?query=...&fmt=json` (the generic `search` method's entity-varying resultsKey heuristic)                                                                                         |
| `error-404.json`               | Generic MusicBrainz error envelope, any endpoint, HTTP 404                                                                                                                                      |
| `error-503.json`               | The documented "requests are being throttled" 503 envelope                                                                                                                                      |
| `bandcamp/album_jsonld.ts`     | A Bandcamp album page, schema.org `MusicAlbum` JSON-LD path (with one ISO-8601 track duration carrying an hours component, to pin the display-drops-hours gap — see the file's own doc comment) |
| `bandcamp/album_tralbum.ts`    | A Bandcamp album page whose JSON-LD has no track list, exercising the `TralbumData` regex-extraction fallback                                                                                   |
| `bandcamp/artist_jsonld.ts`    | A Bandcamp artist/discography page, JSON-LD `album[]` path                                                                                                                                      |
| `bandcamp/artist_musicgrid.ts` | A Bandcamp artist/discography page with NO JSON-LD at all, exercising the `#music-grid` DOM fallback                                                                                            |
| `bandcamp/hostile.ts`          | Malformed JSON-LD + a `TralbumData` blob embedding an `https://` URL, to pin the `//`-comment-strip corruption bug                                                                              |

## Two documented API/scraper quirks this corpus deliberately preserves

1. **Browse vs. search envelope asymmetry.** MusicBrainz's _browse_ endpoints
   (`browse-release-groups.json`, `browse-releases.json`) return entity-PREFIXED
   count/offset keys (`release-group-count`, `release-group-offset`) instead of
   the bare `count`/`offset` that _search_ endpoints use. `musicbrainz.ts`'s
   browse methods read the prefixed keys specifically — this corpus preserves
   that asymmetry rather than "normalizing" it, so a future refactor that
   conflates the two envelope shapes turns a contract-fixture test red.
2. **The Bandcamp `TralbumData` single-line convention.** Real Bandcamp pages
   emit `var TralbumData = {...};` as one long minified line, not pretty-printed
   JSON. `bandcamp/album_tralbum.ts` and `bandcamp/hostile.ts` both preserve
   this single-line style deliberately: the source's `.replace(/\/\/.*/g, "")`
   comment-strip cleanup only strips text through the END OF A LINE, so a
   pretty-printed (multi-line) fixture would dodge the very corruption bug
   `hostile.ts` exists to pin. Regenerating these fixtures with a JSON
   pretty-printer would silently defeat that pin.
