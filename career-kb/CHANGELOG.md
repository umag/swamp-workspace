# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Real-fixes the six remaining latent bugs (LB2-LB7) characterized by the test
backfill and pinned in `2026.07.16.2`, tracked and resolved via the local
`career-kb-latent-bugs` issue-lifecycle model (NEVER filed to the swamp.club
Lab). LB1 (path traversal, fixed in `2026.08.01.1`) is untouched and both its
pins stay green. All fixes converge on one chokepoint per bug; the
contract-fixture suite (`career_kb_test.ts`) and the methods suite
(`career_kb_methods_test.ts`) are byte-identical to `2026.08.01.1`.

- **LB2 (MEDIUM) all-out-of-range CARINAS -> NaN mean mislabeled "high"**:
  `assess`'s CARINAS branch now guards `vals.length === 0` and reports a
  distinct `{ mean: null, band: "no valid input", interpretation: "..." }` state
  instead of letting `0/0 = NaN` fall through every `<` comparison into the
  STRONGEST band. `AssessmentSchema.carinas.mean` widened to
  `z.number().nullable()` (backward-compatible; existing numeric-mean resources
  stay valid).
- **LB3 (MEDIUM) resource-name slug collision across search/assess/read**: added
  `shortHash()` (FNV-1a-32, base36) and `resourceName()` (a `slugify()` prefix
  plus a `shortHash()` suffix over the full input) next to `slugify`;
  `search`/`read`/`assess` now key their written resource on `resourceName(...)`
  instead of `slugify(...)`, so distinct inputs that `slugify` alone would
  collapse no longer collide, while identical input still yields an identical
  name (idempotent overwrite preserved). Charset stays `[a-z0-9-]`, length stays
  <= 48.
- **LB4 (MEDIUM) one bad/missing source aborts the whole catalog build**:
  `loadSources` now reads each entry inside a `try/catch`; a failure is
  `console.warn`'d and skipped instead of aborting `index()`/`search()`/bare-
  slug `read()` entirely -- the catalog (or search pool) still covers every
  source that DID load.
- **LB5 (LOW) empty `clusters: []` disabled filtering entirely**: `sourceList`
  now branches on `clusters.length` directly (not
  `clusters && clusters.length
  ? filter : index`), so an explicit empty array
  matches zero sources, as its shape implies, instead of falling back to the
  full unfiltered index. The `undefined` branch (returning the full index) is
  defensive only -- the schema default means `clusters` is never actually
  `undefined` at runtime.
- **LB6 (LOW) no size cap on read()/index()**: added a defaulted global arg
  `maxFileBytes` (default 1,000,000, safely above the largest real source ~20
  KB). `readRef` now calls `Deno.stat()` before `Deno.readTextFile()` and throws
  a clear error naming the file and its size when it exceeds the cap.
- **LB7 (LOW/info) verbatim unsanitized content storage -- BY DESIGN**: decided
  lossless-by-design (this model returns source markdown to an agent/LLM
  consumer, not a trusted-HTML renderer -- stripping markup would corrupt
  legitimate research content) and made the contract explicit and testable:
  `DocumentSchema.content` gets a `.describe(...)` naming it
  untrusted-must-sanitize, and `read`'s method description carries the same
  caveat. No change to stored bytes.
- Bumped `manifest.yaml` and `model.version` to CalVer `2026.08.02.1`. Added an
  identity `upgrades[]` entry (`fromVersion: "2026.08.01.1"`) -- the sole new
  global arg (`maxFileBytes`) is defaulted (schema fills it at parse time for
  existing instances) and no new resource-schema field was added (LB2 widens an
  existing field to nullable; LB7 adds field metadata only), so
  `upgradeAttributes: (old) => old` is correct.
- Flipped the LB2/LB3/LB4/LB5/LB6 pins in `career_kb_adversarial_test.ts` from
  characterizing the bug to asserting the fixed behavior (each renamed with
  `-- FIXED`), re-framed the LB7 pin to assert BOTH lossless preservation AND
  the documented untrusted-content contract (renamed `-- BY DESIGN`), and added
  new both-side/resilience tests: LB2 (all-out-of-range and
  one-in-range-among-out-of-range, in `career_kb_coverage_test.ts`), LB3
  (determinism, distinctness, charset+length of `resourceName`/`shortHash`, in
  `career_kb_coverage_test.ts`), LB4 (`search()` resilience over the same
  one-bad-two-good corpus, in `career_kb_adversarial_test.ts`), LB6 (a positive
  under-cap read, and an `index()` run over one oversized + one small entry that
  synergizes with the LB4 fix, both in `career_kb_adversarial_test.ts`). Updated
  the "refuted: globalArguments carries no secret-shaped field" test to the new
  two-key shape (`["clusters", "maxFileBytes"]`) -- the one intentional
  non-byte-identical change to an otherwise-frozen negative test, driven by the
  legitimate `maxFileBytes` schema extension. Flipped the property suite's (e)
  branch (`career_kb_property_test.ts`) to assert a null mean and a
  `"no valid input"` band on the all-out-of-range side.
- `quality.yaml`: re-stamped from a real
  `swamp extension quality career-kb/manifest.yaml --json` run; header comment
  rewritten to drop the byte-frozen/no-version-bump wording now that
  `career_kb.ts` and `manifest.yaml` are real-fixed. All five suites stay
  `present` and Grade A / 100%.
- `README.md`: documented the new `maxFileBytes` global arg and the `read`
  content untrusted-must-sanitize contract. `.claude/skills/career/SKILL.md`:
  updated the resource-naming description (slug + content hash).

## 2026.08.01.1

Fixes the HIGH latent bug characterized (pinned, not fixed) by the test backfill
below, tracked and resolved via the local `career-kb-latent-bugs`
issue-lifecycle model:

- **Path traversal via `read`'s `file` argument (HIGH)**: when `file` contained
  a `/`, it flowed verbatim through `readRef()` into
  `context.extensionFile(`references/${rel}`)` then `Deno.readTextFile(...)`
  with zero sanitization, so a value with `..` segments (e.g.
  `../outside/some-file.md`) escaped the `references/` directory into a sibling
  directory. Added a pure `assertWithinRefs(rel)` guard (next to `slugify` in
  the Helpers section) that rejects absolute paths (leading `/`), any
  `..`/`.`/empty path segment, and backslashes, and calls it at the single
  `readRef()` chokepoint BEFORE building the on-disk path -- this confines
  `read`, `loadRaw`, `loadSources`, and `sourceList` in one place, independent
  of (and regardless of) any downstream `context.extensionFile` confinement, as
  defense in depth. Legitimate `cluster/file.md` relative reads and the bare
  `index.json` lookup are unaffected.
- Bumped `manifest.yaml` and `model.version` to CalVer `2026.08.01.1`, in sync.
- Flipped the LB1 pin in `career_kb_adversarial_test.ts` from
  success-characterization to `assertRejects` (asserting zero resource writes on
  rejection), and added a second pin for four extra synthetic traversal shapes
  (absolute `/etc/passwd`, nested `../..`, mixed `a/../../b`, `./x`) -- both
  assert the rejection is the guard's own `"Invalid reference path"` message
  specifically (not an incidental filesystem error), verified genuinely RED
  against the unmodified source before the guard was wired in. Added focused
  unit tests for `assertWithinRefs` in `career_kb_test.ts` (accepts
  `inaction/career-inaction.md` and `index.json`; rejects `../x`, `/etc/passwd`,
  `a/../../b`, `./x`, and a backslash variant, naming the offending input in
  each thrown message). The committed
  `fixtures/outside/fixture-escape-target.md` stays as the now-unreachable
  synthetic attack target. LB2-LB7 pins are unchanged -- they remain deferred
  and still characterize current behavior, still tracked by the local
  `career-kb-latent-bugs` issue-lifecycle model (NEVER filed to the swamp.club
  Lab).

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change at the time -- `career_kb.ts` was byte-frozen and the model
`version` stayed `2026.07.16.2` (`manifest.yaml` was also unchanged; later fixed
above in `2026.08.01.1`).

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
