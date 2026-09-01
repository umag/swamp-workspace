# @magistr/vecs

The **V.E.C.S.** competency framework as queryable swamp data, with 0–5
self-assessment and gap analysis on top.

V.E.C.S. is the Method school's model
([school.mishkatz.com](https://school.mishkatz.com)) of what makes a creative
specialist strong, in four dimensions:

| Letter | Dimension     | What it covers                                        |
| ------ | ------------- | ----------------------------------------------------- |
| **V**  | Vision        | Насмотренность, вкус, замысел — what you can conceive |
| **E**  | Execution     | Ремесло, инструменты, доведение — what you can build  |
| **C**  | Communication | Вербализация, презентация, критика — what you convey  |
| **S**  | Strategy      | Траектория, решения, видимость — where you take it    |

Those four dimensions hold **19 skills**, and each skill is published with its
own explicit _Знания_ (knowledge) and _Умения_ (abilities) lists. That structure
is what makes the framework scoreable, which is what this model is for: rate
yourself against it, and turn the low scores back into a reading list.

The framework ships **bundled** with the extension, so the model needs no
credentials, no configuration and **no network access**. It works offline and
under `swamp serve`.

## Install

```bash
swamp extension pull @magistr/vecs
swamp model create @magistr/vecs/school vecs
```

## Quick start

```bash
# Look at the framework.
swamp model method run vecs framework
swamp model method run vecs framework --input dimension=execution

# Read one skill in full.
swamp model method run vecs skill --input skill=motion
swamp model method run vecs skill --input skill=Доведение
swamp model method run vecs skill --input skill=vision:2

# Score yourself 0–5 and get a study plan.
swamp model method run vecs assess --input scores="motion=2,finishing=3,visual-literacy=4"
swamp model method run vecs gaps
```

## Methods

### `framework`

Returns the dimensions and their skills with knowledge/ability lists. The
optional `dimension` filter accepts `vision` / `execution` / `communication` /
`strategy` or the single letters `V` / `E` / `C` / `S`.

### `skill`

Returns one skill's full knowledge and ability lists. The `skill` argument
accepts three forms:

- the ASCII slug — `motion`, `visual-literacy`, `generative-code-ai`
- the Russian title — `Доведение`, `Критика и обратная связь`
- a `dimension:position` coordinate — `execution:4`, `vision:2`, `e:6`

An unambiguous substring also resolves; an ambiguous one errors with the list of
valid slugs.

### `courses`

The school's course list with prices, strikethrough state, and each course's own
summary.

### `assess`

Records a self-assessment. Scores are **0–5 per skill**:

| Score | Meaning                                             |
| ----- | --------------------------------------------------- |
| 0     | не касался — нет ни знаний, ни практики             |
| 1     | знаю, что это существует; терминология узнаётся     |
| 2     | делал под руководством / по туториалу               |
| 3     | делаю самостоятельно на рабочих задачах, с усилием  |
| 4     | делаю уверенно и предсказуемо, могу объяснить выбор |
| 5     | могу учить других и развивать практику дальше       |

`scores` takes either an object or the compact CLI string form:

```bash
# Compact form — easiest from the shell.
swamp model method run vecs assess --input scores="motion=2,finishing=3"

# Object form — via stdin, for workflows.
echo '{"scores":{"motion":2,"finishing":3},"label":"2026-Q3"}' \
  | swamp model method run vecs assess --stdin
```

You do not have to score every skill. Anything you leave out comes back in
`unscored`; anything that doesn't match a framework skill comes back in
`unknownKeys` rather than being silently dropped. Scores outside 0–5 are
clamped.

Assessments accumulate as **versions** of one `assessment-current` resource, so
`swamp data list vecs` gives you the time series. Re-running with identical
scores and label is a no-op unless you pass `force=true`.

| Argument | Default      | Description                            |
| -------- | ------------ | -------------------------------------- |
| `scores` | _(required)_ | Per-skill ratings 0–5                  |
| `label`  | today's date | Label for this assessment              |
| `note`   | —            | Free-text context                      |
| `force`  | `false`      | Write even if the scores are unchanged |

### `gaps`

Turns the latest assessment into a study plan: per-dimension balance, the
weakest dimension, and the `topN` lowest-scoring skills expanded with their own
knowledge and ability bullets as the syllabus. Also reports `delta` against the
previous stored assessment — `improved`, `regressed`, and `overallMeanChange`.

| Argument | Default | Description                              |
| -------- | ------- | ---------------------------------------- |
| `topN`   | `5`     | How many weakest skills to expand        |
| `target` | `4`     | Target score the gap is measured against |

## Resources

| Spec         | Instance(s)                          | Contents                              |
| ------------ | ------------------------------------ | ------------------------------------- |
| `framework`  | `framework`, `framework-<dimension>` | Dimensions and their skills           |
| `skill`      | `skill-<slug>`                       | One skill's knowledge/ability lists   |
| `courses`    | `courses`                            | Course list with prices and summaries |
| `assessment` | `assessment-current`                 | Self-assessment, versioned over time  |
| `gapPlan`    | `gap-plan`                           | Study plan from the weakest skills    |

## Querying

Everything the methods write is ordinary swamp data:

```bash
# The stored framework.
swamp data query 'modelName == "vecs" && name == "framework"' \
  --select 'attributes.skills.map(s, s.slug)'

# Where you're weakest right now.
swamp data query 'modelName == "vecs" && name == "assessment-current"' \
  --select '{"mean": attributes.overallMean, "weakest": attributes.weakestDimension}'
```

Reference it from other models with CEL:

```
data.latest("vecs", "framework").attributes.skillCount
data.latest("vecs", "assessment-current").attributes.weakestDimension
```

## Skill slugs

The school's skill titles are Cyrillic, so each carries a stable ASCII slug.

| Dimension     | Slugs                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Vision        | `visual-literacy`, `conceptual-thinking`, `authorial-vision`                                                     |
| Execution     | `form-making`, `procedural-workflow`, `light-materials-render`, `motion`, `generative-code-ai`, `finishing`      |
| Communication | `idea-verbalization`, `presentation-packaging`, `publicity-content`, `critique-feedback`, `team-collaboration`   |
| Strategy      | `project-thinking`, `practice-development`, `profession-navigation`, `attention-resource`, `visibility-strategy` |

## Updating the bundled framework

The school publishes its curriculum as static HTML. `references/vecs.json` is
generated from it by a development-time script that is **not** part of the
published extension — the model itself never fetches anything.

```bash
deno task build-reference   # refetch and rewrite references/vecs.json
deno task test              # the suite asserts the regenerated bundle is intact
```

The generator parses the four **dimension** pages rather than the 19 per-skill
pages: the dimension pages carry the canonical numbered skill order and their
bullets are not hard-wrapped, whereas the skill pages wrap at ~46 characters and
split every bullet across lines. It throws rather than writing a partial bundle
if a dimension yields zero skills or two skills collide on a slug.

The test suite validates the bundle itself — all 19 skills present with
non-empty knowledge and ability lists, unique ASCII slugs, each dimension's
`skillSlugs` consistent with the skills that reference it, and every skill
resolvable by slug, title and coordinate.

## Notes

The framework text is the school's own content and remains theirs; this
extension bundles it so you can score yourself against it locally.

## Licence

MIT — see [LICENSE.md](LICENSE.md).
