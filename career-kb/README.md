# @magistr/career-kb

A retrieval, routing, and triage layer over a **career-research knowledge base**
— 22 career-psychology extractions (1 practitioner AMA + 21 academic papers:
theory pieces, scale-development studies, systematic reviews, and meta-analyses)
organized into three clusters:

| Cluster             | Answers                                                     | Sources |
| ------------------- | ----------------------------------------------------------- | ------- |
| `inaction/`         | why people don't act — indecision, indecisiveness, inaction | 9       |
| `success-outcomes/` | what makes a career feel successful, and what derails it    | 12      |
| `ama/`              | practitioner-level transition guidance                      | 1       |

Each source is a markdown file with YAML frontmatter (`title`, `topics`,
`key_constructs`, `summary`) and a standardized section layout (`Overview`,
`Key Constructs & Definitions`, `Main Findings & Arguments`,
`Frameworks &
Models`, `Measurement`, `Practical Implications`,
`Notable Quotes`, `Connections`). This model turns that structure into queryable
state: it builds a catalog, routes a question to the right sources, reads a
source or one section, and triages a described situation into its problem family
with the validated instrument for that family.

## Install

```bash
swamp extension pull @magistr/career-kb
```

For local development, add the package as a source instead:

```bash
swamp extension source add /path/to/swamp-workspace/career-kb
```

## Setup

The corpus is bundled into the extension — there is nothing to configure. Create
an instance and go:

```bash
swamp model create @magistr/career-kb career
swamp model method run career index
```

(`clusters` is an optional global arg that restricts `index`/`search` to a
subset of the bundled clusters; it defaults to all three.)

## Methods

### `index`

Scans the configured cluster folders, parses each source's frontmatter, and
writes a `catalog` resource (every source with its cluster, title, topics, key
constructs, summary, and section list). Idempotent — re-run after editing the
KB.

```bash
swamp model method run career index
swamp data get career main --json     # the latest catalog
```

### `search`

Routes a question or keywords to the most relevant sources, ranked. Scoring is a
weighted keyword match over frontmatter (title and key constructs weigh most,
then topics, then summary), with a whole-phrase bonus. Optionally restrict to
one cluster.

```bash
swamp model method run career search --input query="impostor syndrome prevalence" --input topK=5
swamp model method run career search --input query="subjective success" --input cluster=success-outcomes
```

### `read`

Returns one source's frontmatter plus its full body, or just a named section
(case-insensitive, partial match).

```bash
swamp model method run career read --input file=inaction/career-inaction-scale.md --input section=Measurement
```

### `assess`

Triages a free-text situation into one or more problem families and, for each,
names the validated instrument, the sources to read, and concrete guidance. The
families and their instruments:

| Family             | Distinction                                                              | Instrument                                  |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------- |
| `inaction`         | failing to act _over time_ on a change you already want                  | CARINAS (8 items, 1–5)                      |
| `indecision`       | difficulty making a _specific_ choice                                    | SCCI (45 items, 14 strategies / 3 clusters) |
| `indecisiveness`   | a _chronic trait_ of struggling with any decision                        | EPCD (11 categories / 3 clusters)           |
| `success-derailer` | moving, but it doesn't feel successful (impostorism, unmet expectations) | —                                           |
| `shock-transition` | an external disruption forces a rethink                                  | —                                           |

It also returns coping guidance grounded in the SCCI finding that **cutting
nonproductive coping matters ~2× more than adding productive coping**. Pass
self-rated CARINAS items (each 1–5) to get a benchmarked band.

```bash
swamp model method run career assess --input situation="I want to leave but feel paralyzed and keep putting it off"
swamp model method run career assess --input situation="…" --input 'carinas=[4,5,4,5,4,3,5,4]'
```

## Fidelity

The extractions are summaries, not the originals, and `assess` is keyword triage
over the literature — not a clinical diagnosis or a normed psychometric. Verify
any exact statistic, scale item, or model component against the source before
citing, and self-administer the actual instrument from the cited file.

## License

MIT — see [LICENSE.md](LICENSE.md).
