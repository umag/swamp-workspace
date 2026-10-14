# @magistr/dieworkwear

Menswear fit advice grounded in Derek Guy's (**@dieworkwear**) thread corpus,
read through [Thread Reader App](https://threadreaderapp.com). The focus is the
larger, stocky figure — "кабанчик" — from the thread
[DRESSING FOR LARGER MALE FIGURES](https://threadreaderapp.com/thread/1615828613731078146.html)
(2023-01-18, 19 tweets).

What ships in the package:

- `references/figures.json`: five figures (`kabanchik`, `big-tall`, `athletic`,
  `slim`, `average`) with aliases (`кабанчик`, `stocky`, `husky`, ...).
- `references/rules/kabanchik.json`: 15 paraphrased fit rules. Each rule cites
  the tweet it comes from and has a mirror check.

The thread text is not bundled. `fetch` pulls it, and anything else from the
author's index, into swamp data at runtime.

## Methods

| Method     | What it does                                                                           |
| ---------- | -------------------------------------------------------------------------------------- |
| `discover` | Crawl the author's thread index (newest first, `?ajax=true&before=<epoch>` pagination) |
| `fetch`    | Fetch threads by id, or index previews matching a regex; skips already-fetched threads |
| `figure`   | Classify a body from height/weight/chest/waist/hips/inseam                             |
| `advise`   | Ranked checklist (high → low severity) with tweet links; `synthesize` adds a narrative |
| `extract`  | Mine new tweet-cited rules from fetched threads with `claude -p` (resumable)           |
| `critique` | Check an outfit photo against the figure's rules with `claude -p` vision               |

`extract`, `advise synthesize=true` and `critique` run the local `claude` CLI in
print mode. They need no API key, but must run where `claude` is installed and
logged in. Scraped thread text is wrapped as untrusted data in every prompt.
Extracted rules whose cited tweet is not in the thread are dropped.

## Classification

| Figure      | Rule                                                    |
| ----------- | ------------------------------------------------------- |
| `athletic`  | chest − waist ≥ 15 cm and BMI ≥ 23                      |
| `kabanchik` | BMI ≥ 27, or drop ≤ 6 cm with BMI ≥ 25; height < 185 cm |
| `big-tall`  | as `kabanchik`, height ≥ 185 cm                         |
| `slim`      | BMI < 21                                                |
| `average`   | otherwise                                               |

Extra signals: hips > chest (fuller seat/thigh needed); inseam/height < 0.44
(short leg line, so trouser rise matters more).

## Usage

```bash
swamp extension pull @magistr/dieworkwear
swamp model create @magistr/dieworkwear style
```

```bash
swamp model method run style fetch --input '{"ids":["1615828613731078146"]}'
swamp model method run style figure \
  --input '{"heightCm":172,"weightKg":86,"chestCm":102,"waistCm":98,"hipsCm":106,"inseamCm":70}'
swamp model method run style advise --input '{"occasion":"work","synthesize":true}'
swamp data query 'model("style") && name == "advice"' --select content
```

Grow the corpus:

```bash
swamp model method run style discover --input '{"maxPages":20}'
swamp model method run style fetch --input '{"match":"(larger|big|heav|stocky|short)","limit":20}'
swamp model method run style extract
```

## Data

| Resource   | Instance name | Content                          |
| ---------- | ------------- | -------------------------------- |
| `index`    | `index`       | thread cards from the index      |
| `thread`   | `thread-<id>` | parsed tweets, images, links     |
| `corpus`   | `corpus`      | manifest of fetched threads      |
| `figure`   | `figure`      | classification + metrics         |
| `rules`    | `extracted`   | LLM-extracted, tweet-cited rules |
| `advice`   | `advice`      | ranked checklist + narrative     |
| `critique` | `critique`    | per-rule pass/fail/unclear       |
