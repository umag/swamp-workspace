# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change -- `career_kb.ts` is byte-frozen and the model `version` stays
`2026.07.16.2` (`manifest.yaml` is also unchanged).

- Added `extensions/models/career_kb_methods_test.ts` (methods),
  `career_kb_adversarial_test.ts` (adversarial), `career_kb_coverage_test.ts`
  (coverage), and `career_kb_property_test.ts` (property-invariant-flow) -- 26
  tests before this change (all in the pre-existing `career_kb_test.ts`, now
  recharacterized as the contract-fixture role, unchanged), 78 after (26
  contract-fixture + 17 methods + 11 adversarial + 16 coverage + 8 property).
- Added `fixtures/references/` -- a SYNTHETIC, committed corpus (`index.json` +
  4 sample sources across all three clusters: 1 `ama`, 1 `inaction`, 2
  `success-outcomes`) used by the methods, adversarial, coverage, and property
  suites via a fake `context.extensionFile` pointed at this directory (a REAL
  `Deno.readTextFile`, never a builtin stub). Every title, author, finding, and
  quote is invented for this fixture corpus -- none is derived from, or
  resembles, any of the 22 real sources bundled under `references/` (the
  repository author's own career-research reading list, which must never be
  echoed into a test fixture or assertion). Also added
  `fixtures/outside/fixture-escape-target.md` -- a sibling directory holding one
  synthetic file, used ONLY as the LB1 path-traversal escape target -- and
  `fixtures/PROVENANCE.md` documenting the synthetic-only provenance of both.
  `career_kb_test.ts` (the contract-fixture suite) is UNCHANGED and keeps
  pointing at the REAL bundled `references/` corpus, as before.
- `assess` needed no fixtures at all for any of the new suites -- it is pure
  (`situation`/`carinas` in, hardcoded `SIGNALS`/`FAMILY_INFO` constants out, no
  file reads), so its full family coverage (indecision, indecisiveness,
  shock-transition -- the three families `career_kb_test.ts` didn't already
  exercise) and both LB2/LB3 pins run against nothing but the model's own
  exported functions.
- 7 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed -- `career_kb.ts` is byte-frozen by this change) and tracked in the
  LOCAL `career-kb-latent-bugs` issue-lifecycle model (NEVER filed to the
  swamp.club Lab):
  1. **Path traversal via `read`'s `file` argument (HIGH)** -- when `file`
     contains a `/`, it is used verbatim inside the extensionFile call that
     builds the on-disk path; a value with `..` segments escapes the references
     directory into a sibling directory, with no confinement anywhere in the
     read path (contingent on the real `context.extensionFile`'s own
     confinement, which this model never relies on or checks).
  2. **All-out-of-range CARINAS values yield a NaN mean mislabeled "high"
     (MEDIUM)** -- when every value in `carinas` falls outside `[1,5]`, the
     filtered array is empty, so `mean = 0/0 = NaN`; every `<` comparison
     against `NaN` is `false`, so execution falls through to the `else` branch
     and reports band `"high"` -- the STRONGEST possible signal -- for what is
     actually a total absence of valid input.
  3. **Resource-name slug collision (MEDIUM)** -- `search`/`assess`/`read` all
     key their written resource on `slugify(<input>)`, which collapses
     punctuation and truncates at 48 chars; two genuinely distinct inputs (e.g.
     differing only in trailing punctuation) can collapse to the identical
     resource name, so the second call's write silently overwrites the first's
     in a real datastore.
  4. **One bad/missing source aborts the whole catalog build (MEDIUM)** --
     `loadSources` has no per-entry try/catch; a single missing or unreadable
     file listed in `index.json` throws and aborts `index()` (and
     `search()`/bare-slug `read()`) entirely, discarding every already-loaded
     well-formed source with it.
  5. **An empty `clusters: []` global argument disables filtering entirely
     (LOW)** -- `sourceList`'s `clusters && clusters.length ? filter : index`
     treats `[].length` as falsy, so an explicit empty array falls through to
     the FULL unfiltered index instead of matching zero clusters as its shape
     would suggest.
  6. **No size cap on `read`/`index` (LOW)** -- `Deno.readTextFile` loads each
     source's entire content into memory with no size limit; an arbitrarily
     large source is read and returned in full.
  7. **Verbatim unsanitized content storage (LOW/info)** -- `read`'s `content`
     field stores/returns the raw markdown body byte-for-byte, with no escaping
     or stripping; an embedded `<script>` tag or other markup survives untouched
     into the written resource.
- `deno.json`: `test` task widened to
  `--allow-read --allow-write
  --allow-env=FC_NUM_RUNS` (`--allow-write` is
  needed only for the adversarial suite's disposable `Deno.makeTempDir()`
  corpora used by LB4/LB6/LB7; no `--allow-net`/`--allow-run` -- career_kb.ts
  has no subprocess or network seam at all, confirmed by one of the adversarial
  suite's own covered-negative tests). `check` task widened from two explicit
  files to `extensions/models/*.ts` so every new test file is typechecked too.
  Added `test:soak` for the high-count nightly property soak
  (`FC_NUM_RUNS=10000`).
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependency
  `npm:fast-check@4.8.0` (pinned exact version, per this repo's
  bundler-dependency rule) and its transitive `pure-rand`. Source dependencies
  (`npm:zod@4`) are unchanged.
- `quality.yaml`: all five required suites plus `docs.readme`/
  `docs.changelog`/`docs.skill` flip from `backlog` to `present` (`docs.skill`
  -> `.claude/skills/career/SKILL.md`, verified present). `watch`/`canary` stay
  `backlog` (seeded offender at CI-gate rollout, tracked in
  `ext-quality-test-backfill`). `ratchet` set to 100 / "Grade A" --
  `swamp extension quality manifest.yaml --json` reports `percentage: 100`,
  `status: "passed"`. Removed `career-kb` from `quality-allowlist.txt` in the
  same change (five-suite presence graduates it).

## 2026.07.16.2

Initial release: retrieval, routing, and triage over a bundled career-research
knowledge base (22 extractions across the `ama`, `inaction`, and
`success-outcomes` clusters). `index` builds a queryable catalog from
frontmatter; `search` routes a question or keywords to the most relevant
sources; `read` returns a source's frontmatter plus its full body or one named
section; `assess` triages a described situation into its problem family
(inaction / indecision / indecisiveness / success-derailer / shock-transition),
names the validated instrument (CARINAS / SCCI / EPCD), points to sources, and
gives coping guidance. Ships the `career` skill for routing career questions to
grounded sources.
