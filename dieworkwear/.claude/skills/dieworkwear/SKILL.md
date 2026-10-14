---
name: dieworkwear
description: Menswear fit advice for a specific body grounded in Derek Guy's (@dieworkwear) threads via the @magistr/dieworkwear swamp model — classify a figure from measurements (stocky "кабанчик", big-tall, athletic, slim, average), produce a tweet-cited fit checklist, synthesize advice over the fetched thread corpus, critique an outfit photo, and grow the rule base from new threads. Triggers on "dieworkwear", "derek guy", "кабанчик", "what should I wear for my body", "dress for my figure", "stocky build clothes", "larger guy style", "fit advice", "critique my outfit", "how should trousers fit". Do NOT use for shopping/price lookups.
---

# dieworkwear

Instance: `style` (type `@magistr/dieworkwear`). Run through a workflow when
repeating; read results with `swamp data query`.

## Flow

1. **Corpus present?**
   `swamp data query 'model("style") && name == "corpus"' --select content`. If
   missing → `fetch` with `{"ids":["1615828613731078146"]}`.
2. **Figure.** Ask for height, weight, chest, waist, hips, inseam (cm/kg) if not
   known → `figure`. Report `figure`, `metrics`, `signals`.
3. **Advice.** `advise` with `occasion` (work|formal|casual|any), optional
   `garment` (jacket|trousers|casual), `synthesize: true` + `question` for a
   narrative. Present high-severity rules first, each with its `check` and
   `sourceUrl`.
4. **Photo.** `critique` with an absolute `imagePath`; report `fail` verdicts
   first, `unclear` as "needs a side/back photo".
5. **Grow.** `discover` → `fetch {"match": "<regex>"}` → `extract`. Extracted
   rules merge into `advise` automatically.

## Rules

- Cite tweets via `sourceUrl`; never invent a Derek Guy quote.
- Measurements are personal: never put them in commits, issues or published
  files.
- `extract`/`synthesize`/`critique` need the local `claude` CLI logged in.
