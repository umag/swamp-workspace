# Fixture provenance

Every file in this directory (and `malformed/`) is **synthetic / hand-authored**
— written from scratch to exercise `fragrantica.ts`'s documented DOM selectors
and DuckDuckGo-result markup, **never captured from a live `fragrantica.com`
page or a live DuckDuckGo query**. This mirrors the `porkbun`/`comfyui`
precedent (synthetic fixtures, no live capture) and is a deliberate security
decision, not an oversight.

## What was NOT done (explicit prohibition)

A published `@magistr/fragrantica` model exists and can be run against the real
Fragrantica site. **Live capture from fragrantica.com, from any Fragrantica
locale domain, or from a live DuckDuckGo query is FORBIDDEN** for this fixture
corpus — not "not done this time", but a standing rule for anyone regenerating
these fixtures later:

- No `swamp model method run <instance> <method>` call was made against a real
  Fragrantica instance while authoring these fixtures.
- No real perfume, house/designer, note, rating, or review text from
  fragrantica.com appears anywhere below.
- No real DuckDuckGo HTML response was captured; `ddg-results.html` is a
  hand-built mirror of the documented `a.result__a` / `uddg=` redirect-param
  markup, pointed only at `fragrantica.example` targets.
- `fragrantica.ts` itself is **BYTE-FROZEN** by the change that added this
  corpus — these fixtures characterize already-shipped parsing behavior, they do
  not describe new behavior.

The fixtures-secret-scan / host-scan test in
`../extensions/models/fragrantica_contract_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

## Every value is synthetic

- Brand/house: `Testhouse`, `Otherhouse` — invented, not a real perfume house.
- Perfumes: `Fakebloom Nova`, `Nova Extreme`, `Second Bloom` — invented names.
- Notes: `Bergamot`, `Pink Pepper`, `Rose`, `Musk`, `Fakewood` — the first four
  are real note _ingredient_ words (unavoidable — perfumery notes are common
  botanical/aromatic terms) but are attached only to the invented perfumes
  above, never to a real Fragrantica page or id; `Fakewood` is an invented note
  name used for the note-listing fixture specifically so at least one note token
  is obviously fake.
- Perfumer: `Jane Testperfumer` — invented, not a real "nose".
- Hosts: `fragrantica.example` — an
  [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserved example domain,
  used everywhere a fixture needs a base host instead of the model's real
  default (`www.fragrantica.com`). `duckduckgo.com` / `html.duckduckgo.com`
  appear only as the literal redirect-host markup DuckDuckGo's own HTML endpoint
  documents (`//duckduckgo.com/l/?uddg=...`), never dereferenced to a live query
  in a test.
- IP addresses used by the adversarial suite's hostile-host tests (not committed
  as fixture files, but sourced from the same discipline): the
  `TEST-NET-1`/`TEST-NET-2`/`TEST-NET-3` documentation ranges `192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`
  ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)) — never a real or
  cloud-metadata address. Where a test names the real-world SSRF target
  `169.254.169.254` (the cloud metadata service), it appears **only in a code
  comment**, never as a URL a stub actually fetches.
- Perfume/record ids (`101`, `102`, `103`, `201`) and note ids (`75`, `88`, `3`,
  `99`, `42`) — small synthetic sequential placeholders, not real Fragrantica
  ids.
- Ratings (`4.2`, `1,234`) — plausible-shaped but invented numbers.

## Per-file mapping to the documented selector / contract

| File                                  | Exercises                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `perfume.html`                        | og:title/og:description, itemprop brand/name/rating, accord width-bars, `#pyramid` top/middle/base, `/noses/` perfumers, "also like" carousel |
| `designer-listing.html`               | `collectPerfumeRefs` over a designer/house grid: dedup of a repeated href, a non-perfume link skipped                                         |
| `note-listing.html`                   | `collectPerfumeRefs` over a note-listing grid                                                                                                 |
| `ddg-results.html`                    | DuckDuckGo's `a.result__a` / `uddg=` redirect-param markup, plus one entry with no `uddg` param (raw href passthrough)                        |
| `malformed/bad-percent.html`          | A `%zz` malformed percent-escape in a `/perfume/` href — pins the `decodeURIComponent` `URIError` (adversarial suite)                         |
| `malformed/non-html.txt`              | A non-HTML 200 body — pins `fetchPage`'s missing `Content-Type` check / silent-empty parse (adversarial suite)                                |
| `malformed/missing-pyramid.html`      | A structurally-drifted page (no `#pyramid`, no itemprop markup) — pins `parsePerfume`'s no-minimum-field guard (adversarial suite)            |
| `malformed/cloudflare-challenge.html` | Cloudflare/Turnstile interstitial wording — pins `fetchPage`'s challenge-detection message (adversarial suite)                                |
| `malformed/accord-over-100.html`      | A `width:120%` accord bar — pins `parseAccords`'s unclamped strength (adversarial suite)                                                      |

## A documented parsing quirk this corpus deliberately preserves

`designer-listing.html` includes the **same**
`/perfume/Testhouse/Fakebloom-Nova-101.html` href twice (once as the sole link
in its card, once inside a second card with different surrounding text) to pin
`collectPerfumeRefs`'s de-duplication by absolute URL — the second occurrence
must never appear twice in a method's written `results` array.
