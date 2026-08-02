# Fixture provenance

Every file in this directory is **pure synthetic / hand-authored** — built from
the observable structure of Bandcamp's public search/discography/album pages
(schema.org JSON-LD + the `TralbumData` embed) and the documented shape of the
Bandcamp OAuth token endpoint and sales/merch JSON API, **never captured from a
live call**. This mirrors the `porkbun`/`musicbrainz` precedent (synthetic
fixtures, no live capture) and is a deliberate security decision, not an
oversight.

## What was NOT done (explicit prohibition)

**Live capture from bandcamp.com (or the Bandcamp OAuth/sales/merch API) is
FORBIDDEN** for this fixture corpus — not "not done this time", but a standing
rule for anyone regenerating these fixtures later:

- No `swamp model method run bandcamp <method>` call was ever made against a
  real Bandcamp instance while authoring these fixtures.
- No real Bandcamp page (`fetch`, browser, or otherwise) was ever scraped to
  produce the HTML fixtures — every `<script type="application/ld+json">` block,
  `TralbumData` blob, and DOM element was hand-written from the
  documented/observed shape, not copied from a live page.
- No vault credential (a Bandcamp `clientId`/`clientSecret` pair, or any derived
  bearer/refresh token) was read, exported, or otherwise touched.
- No real artist, band, album, track, or subdomain name appears anywhere below —
  every name is prefixed `Fixture` as a deliberate, greppable marker.
- No real Bandcamp band id, sale, order, or merch record appears anywhere below
  — every id/amount/date is an invented placeholder.

The fixtures-secret-scan tests in
`../extensions/models/bandcamp_adversarial_test.ts` (one for the JSON fixtures,
one for the HTML fixtures) are a **mechanical backstop**, not the primary
control — the primary control is this prohibition plus never running a live call
in the first place.

## Every value is synthetic

- Hosts: every artist/album/track URL uses an `.example.com` subdomain — IANA's
  reserved example domain ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)),
  never a real Bandcamp `*.bandcamp.com` page. This is a deliberate departure
  from real Bandcamp URL shape (which uses `artist.bandcamp.com`), chosen so no
  fixture could ever be mistaken for — or accidentally resolve to — a real
  artist's page.
- The SSRF-pin target addresses used in the adversarial suite
  (`169.254.169.254`, `127.0.0.1`) are well-known documentation/reserved
  examples for cloud-metadata and loopback scenarios (RFC 5737-adjacent
  convention used across this fixture corpus), never a real reachable host this
  repo's author controls.
- Names: `Fixture Aurora Band`, `Fixture Nightfall`, `Fixture Static Dreams`,
  `Fixture Grid Artist`, `Fixture LD Artist`, `Fixture Legacy Artist`, etc. —
  invented artist/album/track names using the word "Fixture" as a marker.
- Band/sale/order/merch ids: `1000001`–`1000003` (bands), `9001` (merch
  package), `500001`/`500002` (payment ids), `si_fixture_001`/`si_fixture_002`
  (sale item ids), `FIX-LP-001` (sku) — synthetic sequential placeholders, never
  real Bandcamp/Stripe-style identifiers.
- OAuth tokens: `fixture-access-token-alpha` / `fixture-refresh-token-alpha`
  (`oauth_token.json`) — obviously-fake, human-readable placeholder strings, not
  a real bearer/refresh token shape (no high-entropy blob anywhere in this
  corpus; the fixtures-secret-scan's own sanity test confirms the scanner would
  catch one if it existed).
- Dates: `2024-03-02`, `2024-01-01`, etc. — arbitrary placeholder dates, never
  tied to a real release or transaction.

## Per-file mapping to the documented endpoint / page shape

| File                          | Documented shape / endpoint                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `search_artists.html`         | `GET /search?item_type=b` results page — primary `.searchresult.data-search` markup                                          |
| `search_albums.html`          | `GET /search?item_type=a` results page — full-field item + minimal-field item                                                |
| `search_tracks.html`          | `GET /search?item_type=t` results page — the "by X from Y" subhead quirk                                                     |
| `search_fallback.html`        | Legacy `.result-items li` / `.itemurl a` markup (the OR-fallback selector path)                                              |
| `search_empty.html`           | A zero-result search page, no "of N results" text                                                                            |
| `album.html`                  | An album page with full schema.org `MusicAlbum` JSON-LD (the primary parse path)                                             |
| `album_tralbum_fallback.html` | An album page whose JSON-LD carries no track list — exercises the `TralbumData.trackinfo` fallback                           |
| `album_tralbum_dirty.html`    | An album page with a corrupted, single-line `TralbumData` blob (the `//`-strip pin, bandcamp-latent-bugs #3)                 |
| `artist_grid.html`            | An artist page with no JSON-LD — exercises the DOM `#music-grid` fallback                                                    |
| `artist_ld_discography.html`  | An artist page with JSON-LD `album[]` — exercises the ld-wins-over-DOM-grid path                                             |
| `oauth_token.json`            | `POST /oauth_token` 200 success response                                                                                     |
| `my_bands.json`               | `POST /api/account/1/my_bands` response, including `member_bands` nesting                                                    |
| `sales_report.json`           | `POST /api/sales/4/sales_report` response                                                                                    |
| `merch_details.json`          | `POST /api/merchorders/1/get_merch_details` response                                                                         |
| `orders.json`                 | `POST /api/merchorders/4/get_orders` response                                                                                |
| `update_shipped.json`         | `POST /api/merchorders/2/update_shipped` response (its body is never surfaced by the model — see the contract-fixture suite) |
| `api_error.json`              | The `getToken` failure envelope (`ok: false`, no `access_token`)                                                             |

## Two documented quirks this corpus deliberately preserves

1. **The Bandcamp `TralbumData` single-line convention.** Real Bandcamp pages
   emit `var TralbumData = {...};` as one long minified line, not pretty-printed
   JSON. `album_tralbum_fallback.html` and `album_tralbum_dirty.html` both
   preserve this single-line style deliberately: as of 2026.08.02.1 the source
   tries a direct `JSON.parse` first and only falls back to a scheme-protected
   `//`-strip cleanup on failure, but that fallback's
   `.replace(/(^|[^:])\/\/.*$/gm, "$1")` still only strips text through the END
   OF A LINE, so a pretty-printed (multi-line) fixture would dodge the
   `album_tralbum_dirty.html` scenario entirely (the fallback path pins RECOVERY
   now, not corruption — see CHANGELOG.md's bandcamp-latent-bugs #3 entry). Both
   files stay listed in `deno.json`'s `fmt.exclude` so `deno fmt` never
   reformats them across multiple lines — regenerating either with a JSON
   pretty-printer would silently defeat the pin.
2. **The subhead "by X from Y" ambiguity.** `search_tracks.html`'s subhead ("by
   Fixture Aurora Band from Fixture Static Dreams") is deliberately shaped to
   exercise a genuine parsing quirk (not one of the 7 tracked latent bugs, but
   pinned as a characterization in the contract-fixture suite): the `artist`
   field ends up capturing the ENTIRE "X from Y" tail, not just "X", because the
   `byMatch` regex isn't anchored to stop before "from". `album` is separately
   and correctly extracted as "Y" via its own regex.

## Latent bugs this corpus exists to pin

Seven latent bugs were characterized against this corpus and tracked in the
LOCAL `bandcamp-latent-bugs` issue-lifecycle model (never filed to the
swamp.club Lab): SSRF via the `url` argument, cross-instance OAuth token-cache
bleed, the `TralbumData` `//`-strip corruption (`album_tralbum_dirty.html`,
above), silent all-clear on JSON-LD/TralbumData parse failure, absence of any
fetch timeout/backoff, `instanceName` 60-char truncation collision, and
`slice(0, 500)` surrogate-pair splitting. As of 2026.08.02.1 all seven are FIXED
— see `../CHANGELOG.md` and the adversarial suite's per-test doc comments for
the full characterization of each. Fixture FILES themselves are unchanged: they
still isolate each scenario, but the suites now pin the fixed
(recovered/warned/bounded/collision-free/code-point -safe) behavior instead of
the original bug.
