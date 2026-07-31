# Fixture provenance

Every file under this directory is **pure synthetic / hand-authored** -- built
from the observable structure of the real bundled corpus (YAML frontmatter with
`title`/`cluster`/`doc_type`/`authors`/`year`/`topics`/
`key_constructs`/`summary`, and a standardized `##`-heading section layout),
**never derived from, copied from, or based on any of the 22 real
career-research sources bundled under `../references/`**. This mirrors the
`bandcamp`/`porkbun`/`livejournal-import`/`jabber` precedent (synthetic
fixtures, no live/real-data capture) and is a deliberate privacy decision, not
an oversight -- the real corpus contains the repository author's own
career-research reading list and must never be echoed into a test fixture or a
test assertion.

## What was NOT done (explicit prohibition)

**Deriving fixture content from the real `references/` corpus is FORBIDDEN** for
this fixture corpus -- not "not done this time", but a standing rule for anyone
regenerating these fixtures later:

- No text, title, author, statistic, construct name, or finding from any of the
  22 real sources under `../references/` appears anywhere below.
- No real person's name, employer, job title, visa status, or career event
  appears anywhere below -- every author name is prefixed `Fixture` as a
  deliberate, greppable marker, and every finding/quote is explicitly invented
  for this fixture corpus.
- No real scale/instrument (CARINAS, SCCI, EPCD) item wording is reproduced here
  -- the fictional "Career Stasis Inventory (CSI)" in
  `references/inaction/fixture-inaction-example.md` is entirely invented and
  does not describe any real published instrument.

## Two fixture trees, deliberately separated

- `references/` -- the well-formed corpus (`index.json` + 4 sample sources
  across all three clusters: 1 `ama`, 1 `inaction`, 2 `success-outcomes`) used
  by the methods, adversarial, coverage, and property suites via a fake
  `context.extensionFile` pointed at this directory (a REAL `Deno.readTextFile`,
  never a builtin stub).
- `outside/` -- a SIBLING directory, one file (`fixture-escape-target.md`), that
  exists ONLY to characterize LB1 (path traversal via the `read` method's `file`
  argument -- `context.extensionFile` performs no confinement, so a `file` value
  containing `../` segments escapes `references/` into this directory). Kept in
  its own subtree, never mixed into `references/`, so the traversal pin stays a
  dedicated, isolated case rather than polluting the "well-formed corpus"
  fixtures the other suites depend on.

## Per-file mapping

| File                                                         | Exercises                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `references/ama/fixture-ama-example.md`                      | `ama` cluster, no `Measurement` section -- the general title/topics/constructs search surface                                  |
| `references/inaction/fixture-inaction-example.md`            | `inaction` cluster, HAS a `Measurement` section -- exercises `read`'s section extraction                                       |
| `references/success-outcomes/fixture-success-example-one.md` | `success-outcomes` cluster, `self-doubt`/`perceived fraudulence` key constructs for search scoring/phrase-bonus boundary tests |
| `references/success-outcomes/fixture-success-example-two.md` | `success-outcomes` cluster, second entry -- exercises multi-source cluster counts                                              |
| `outside/fixture-escape-target.md`                           | LB1 path-traversal escape target (never reachable through `references/` alone)                                                 |

## Latent bugs this corpus (plus dynamically-built temp fixtures in the test files) exists to pin

Seven already-shipped latent bugs are characterized against this corpus (and,
for LB4/LB6/LB7, against small temp-directory corpora built inline via
`Deno.makeTempDir`/`Deno.writeTextFile` in
`../extensions/models/career_kb_adversarial_test.ts` -- never committed to disk)
and tracked in the LOCAL `career-kb-latent-bugs` issue-lifecycle model (never
filed to the swamp.club Lab): path traversal via `read`'s `file` argument (LB1,
using `outside/fixture-escape-target.md`), an all-out-of-range CARINAS array
producing a NaN mean mislabeled "high" (LB2, no fixtures -- `assess` is pure), a
resource-name slug collision between two distinct `assess` situations (LB3, no
fixtures), one missing/unreadable source aborting the whole catalog build (LB4,
temp corpus), an empty `clusters: []` global argument disabling filtering
entirely instead of matching zero clusters (LB5, using this committed corpus),
no size cap on `read`/`index` (LB6, temp corpus with a large synthetic file),
and unsanitized verbatim content storage (LB7, temp corpus with an embedded
`<script>` tag). See `../CHANGELOG.md` and the adversarial suite's per-test doc
comments for the full characterization of each.
