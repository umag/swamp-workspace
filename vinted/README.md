# @magistr/vinted

Search [Vinted](https://www.vinted.nl) and read listings from swamp, without an
account or API key. The web app embeds its data in the HTML:

- **Catalog pages** carry search results in the Next.js RSC payload
  (`self.__next_f.push([1,"…"])` → `"items":[…]`).
- **Item pages** carry `"photos":[…]`, a `"plugins":[…]` array (summary,
  attributes, description, seller) and a schema.org `Product` in `ld+json`.

A session cookie from the homepage is the only setup.

## Methods

| Method   | Writes          | What                                                                                       |
| -------- | --------------- | ------------------------------------------------------------------------------------------ |
| `search` | `search-<name>` | Text + price/brand/size/condition/category filters, up to 10 pages; `isNew` vs last run    |
| `item`   | `item-<id>`     | Description, price, size, condition, material, seller, photos, parsed garment measurements |

Measurements come from the seller's free-text description, in French, English,
Dutch, German or Italian: shoulders, chest, length, sleeve, waist, hips, inseam
and rise. A chest under 75 cm, or one labelled pit-to-pit, is treated as a flat
measurement and doubled into `chestCm`. The raw value is kept in `chestFlatCm`.

## Usage

```bash
swamp extension pull @magistr/vinted
swamp model create @magistr/vinted vinted
```

```bash
swamp model method run vinted search \
  --input '{"query":"burberry trench","priceTo":200,"mustMatch":"trench|impers|raincoat","pages":2}'
swamp model method run vinted item \
  --input '{"refs":["https://www.vinted.nl/items/10107271840-impers-burberrys-homme"]}'
swamp data query 'modelName == "vinted" && name == "item-10107271840"' --select content
```

Run the same `search` on a schedule. Rows with `isNew: true` are listings that
appeared since the previous run.

## Global arguments

| Argument         | Default         | Meaning                           |
| ---------------- | --------------- | --------------------------------- |
| `domain`         | `www.vinted.nl` | Country site (`www.vinted.fr`, …) |
| `requestDelayMs` | `1500`          | Delay between page requests       |

Descriptions are seller-written and untrusted; escape them before rendering.
