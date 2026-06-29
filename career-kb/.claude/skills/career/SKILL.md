---
name: career
description: >
  Answer career-psychology questions and triage career situations against a
  career-research knowledge base (22 extractions across the ama / inaction /
  success-outcomes clusters) via the @magistr/career-kb swamp model (instance
  `career`). Route a question to the right sources, read a source or one section,
  and classify a described situation into its problem family (inaction /
  indecision / indecisiveness / success-derailer / shock-transition) with the
  validated instrument (CARINAS, SCCI, EPCD) and coping guidance. Triggers on
  "career advice", "career change", "should I quit / leave my job", "I'm stuck
  in my career", "I can't decide between", "career indecision", "career
  inaction", "impostor syndrome", "career transition", "career success", "am I
  on the right path", "career coaching", "career-kb". Do NOT use for editing the
  knowledge base files themselves or for non-career life decisions.
---

# Career

A retrieval + triage layer over a career-research knowledge base — 22
career-psychology sources (1 practitioner AMA + 21 academic papers) extracted
into frontmatter + standardized sections. The `@magistr/career-kb` model
(instance **`career`**) indexes, routes, reads, and triages; **you** read the
surfaced markdown and answer grounded in it.

## Core taxonomy — keep these three distinct

The whole KB hinges on a distinction the sources insist on:

- **Indecision** — difficulty making a _specific_ choice right now → SCCI /
  decision theory.
- **Indecisiveness** — a _chronic trait_ of struggling with any decision → EPCD.
- **Inaction** — failing to act _over time_ on a change you already want →
  CARINAS.

Plus two outcome-side families: **success-derailer** (you're moving but it
doesn't feel successful — impostorism, unmet expectations) and
**shock-transition** (an external disruption — layoff, relocation, visa — forces
a rethink).

## Clusters

| Cluster             | Answers                                                     | Files |
| ------------------- | ----------------------------------------------------------- | ----- |
| `inaction/`         | why people don't act (indecision, indecisiveness, inaction) | 9     |
| `success-outcomes/` | what makes a career feel successful & what derails it       | 12    |
| `ama/`              | practitioner-level transition guidance                      | 1     |

## Workflow

**1. Triage a described situation** ("I'm stuck…", "should I…", a paragraph
about their career) — start here, not with search:

```bash
swamp model method run career assess --input situation="<their words>"
# optional CARINAS self-score (8 items, each 1–5, see inaction/career-inaction-scale.md):
swamp model method run career assess --input situation="…" --input 'carinas=[4,5,4,5,4,3,5,4]'
```

`assess` returns `primaryFamily`, per-family `instrument` + `readSources` +
`guidance`, optional CARINAS banding, and coping guidance (the key asymmetry:
**cutting nonproductive coping matters ~2× more than adding productive
coping**).

**2. Find sources for a topical question** ("what predicts subjective success?",
"impostor prevalence"):

```bash
swamp model method run career search --input query="<question or keywords>" --input topK=5
swamp model method run career search --input query="…" --input cluster=success-outcomes   # optional filter
```

Search is a **keyword router over frontmatter** (title/constructs/topics/summary
weighted). It's strong for topical lookups; for filler-heavy natural-language
sentences prefer `assess`.

**3. Read what was surfaced.** The methods point at relative paths like
`inaction/career-inaction.md`. Read them directly with the Read tool, or pull a
single section through the model:

```bash
swamp model method run career read --input file=inaction/career-inaction-scale.md --input section=Measurement
```

**4. Answer grounded in the sources**, citing file + section. Honour the
fidelity rule below.

## Reading a method's output

Each run writes a JSON data artifact (named `main` for the catalog; a slug of
the input for search/assess/read). Fetch the most recent:

```bash
name=$(swamp data list career --json | python3 -c "import sys,json;d=json.load(sys.stdin);items=[i for g in d['groups'] if g['type']=='resource' for i in g['items']];items.sort(key=lambda i:i['createdAt']);print(items[-1]['name'])")
swamp data get career "$name" --json
```

`swamp data get career main --json` is always the latest catalog (all 22 sources
with topics/constructs/sections) — use it to browse or build a routing answer
without a fresh scan.

## Routing map (instrument ← family)

- **inaction** → CARINAS (8 items, 1–5) · `inaction/career-inaction.md`,
  `…-scale.md`
- **indecision** → SCCI (45 items, 14 strategies/3 clusters) ·
  `inaction/career-indecision-strategies.md`
- **indecisiveness** → EPCD (11 categories/3 clusters) ·
  `success-outcomes/career-difficulties.md`
- **success-derailer** → `success-outcomes/subjective-success.md`,
  `impostor-*.md`
- **shock-transition** → `success-outcomes/career-shocks.md`,
  `career-transition-*.md`, `career-adaptability.md`

## Setup (first run / new machine)

The corpus is bundled into the extension — no configuration needed.

```bash
swamp model search career --json      # confirm the `career` instance exists
swamp model method run career index   # (re)build the catalog
# if the instance is missing:
swamp model create @magistr/career-kb career
```

## Guardrails

- **Fidelity.** Extractions are summaries, not the originals. Verify any exact
  statistic, scale item, or model component against the source before citing.
- **Not clinical.** `assess` is keyword triage over research, not a diagnosis or
  a normed psychometric. Frame it as "which literature applies", and point the
  user to self-administer the actual instrument in the cited file.
- Load the `swamp` skill for any model/extension mechanics beyond the commands
  above.
