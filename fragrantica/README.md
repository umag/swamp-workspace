# @magistr/fragrantica

Fragrantica integration for [swamp](https://github.com/systeminit/swamp). Search
perfumes, list them by designer/house or by note, fetch full perfume details
(brand, gender, year, rating, perfumers, main accords with strength %, and the
top/middle/base notes pyramid), and read the **"People who like this also
like"** similar-perfumes list — all from the public Fragrantica pages, no
credentials.

## Why `search` uses a web search engine

Fragrantica's own on-site search box is served behind a Cloudflare Turnstile
challenge and a referer-locked Algolia key, so it cannot be queried from a plain
HTTP client. The `search` method therefore resolves a free-text query to
Fragrantica perfume URLs through DuckDuckGo's HTML endpoint, then every other
method reads the perfume / designer / note pages directly. Occasional
rate-limiting from the search engine is the only tradeoff; the perfume, similar,
and listing data is always read live from Fragrantica.

## Install

```bash
swamp extension pull @magistr/fragrantica
```

## Instance configuration

`globalArguments` are optional — the model needs no credentials.

```yaml
type: "@magistr/fragrantica"
typeVersion: 2026.07.15.1
name: fragrantica
globalArguments:
# Optional overrides
# baseUrl: "https://www.fragrantica.com"
# userAgent: "Mozilla/5.0 ..."
methods: {}
```

## Methods

- `search` — search perfumes by name/brand. Args: `query`, optional `limit`.
  Returns perfume references (`name`, `brand`, `url`, `id`, `thumbnail`).
- `get-perfume` — full perfume details by URL. Args: `url`. Returns brand,
  gender, year, `ratingValue`/`ratingCount`, `perfumers`, `accords`
  (`{name, strength}`), `notes` (`top`/`middle`/`base`/`general`), and
  `similar`.
- `similar` — just the "also like" similar perfumes for a perfume. Args: `url`.
- `list-by-designer` — all perfumes by a house. Args: `designer` (slug like
  `Yves-Saint-Laurent`, a `/designers/…` URL, or a plain house name).
- `list-by-note` — perfumes featuring a note. Args: `note` (slug like
  `Vetiver-4`, a `/notes/…` URL, or a plain note name).
- `find-by-notes` — perfumes sharing several notes at once, by intersecting
  their note pages (fan-out: one call fetches every note page). Args: `notes`
  (array of slugs/URLs/names), optional `mode` (`all` = intersection, default;
  `any` = union ranked by matches), optional `limit`. Note pages list the
  most-popular perfumes per note, so very obscure matches can fall outside.

## Usage

```bash
# Search by name/brand
swamp model method run fragrantica search --input query="Creed Aventus"

# Full details (accords, notes pyramid, rating, perfumers, similar)
swamp model method run fragrantica get-perfume \
  --input url=https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html

# Just the similar perfumes
swamp model method run fragrantica similar \
  --input url=/perfume/Dior/Sauvage-31861.html

# List a house / a note
swamp model method run fragrantica list-by-designer --input designer=Dior
swamp model method run fragrantica list-by-note --input note=Vetiver-4

# Hunt a note combination (perfumes with BOTH licorice and oud)
swamp model method run fragrantica find-by-notes \
  --input 'notes:json=["Black Licorice","Agarwood Oud"]' --input mode=all

# Inspect what was written to model data
swamp data list --json
```

## Notes on responsible use

Requests use a normal browser User-Agent and are made on demand (one page per
call), not as a bulk crawl. Fragrantica's `robots.txt` blocks AI-labelled
crawlers and its `/ajax` and `/search?…` endpoints; this model touches only the
public `/perfume/`, `/designers/`, and `/notes/` pages, which are not
disallowed. Keep usage low-volume and cache results (resources default to an
infinite lifetime with GC) rather than re-fetching.

## License

MIT — see [LICENSE.md](LICENSE.md).
