# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.14.1

Ports three verified upstream arc-kit defects in the EU Cloud Sovereignty
Framework v1.2.1 implementation into this fork, found against the Commission's
own
[Implementation guidance](https://commission.europa.eu/document/download/2ad80a48-166f-4c77-a513-80c53ca2a128_en)
PDF and
[Annex Sovereignty assessment calculator](https://commission.europa.eu/document/download/3acb8fe8-8a4a-4339-ae74-f56138d913d1_en)
XLSX, plus one related backward-compatible widening. TDD RED round: the weight
fix's test asserted all eight weights individually against unmodified source
first, capturing SOV-1/SOV-5/SOV-7 failing by name before any production code
changed — a sum-only assertion would have missed all three, since both the wrong
and the right weight sets sum to 100.

- **`SOV_WEIGHTS` had three wrong values.** SOV-1 was 15 (should be 20), SOV-5
  was 20 (should be 10), SOV-7 was 10 (should be 15) — ground truth is guidance
  p.7 / calculator cells D4/D45/D76/D102/D133/D169/D195/D231. The wrong set
  summed to 100 too, which is exactly why it survived review.
  **Previously-written `sovereigntyAssessment` records were scored against the
  wrong weights and are NOT recomputed** by this upgrade — that resource is
  `lifetime: "infinite"`, so such records persist; re-run `euSovereigntyScore`
  for any assessment that still matters.
- **`SEAL_LABELS.SEAL3.en` was wrong.** Corrected `"Digital resilience"` →
  `"Technological sovereignty"` (guidance p.2-3, p.10). **`SEAL_LABELS.SEAL3.nl`
  is UNCHANGED** — `"Digitale veerkracht"` is a verified, deliberate divergence
  from the Commission's English name, quoted verbatim from the NDS
  Cloudprogramma notitie "Verkenning Overheidsbrede Soevereine Clouddiensten"
  (11 juni 2026), Tabel 1 p.8 — not a bug, and not something a future pass
  should "fix" to match the English.
- **No overall SEAL was computed**, even though it is the framework's actual
  rejection gate (guidance p.9: "The overall SEAL level is the lowest SEAL level
  achieved in any of the objectives" — calculator cell F2:
  `="SEAL-"&MIN(H5:H251)`). `computeSovereigntyScore` now returns `overallSeal`
  (a MINIMUM across all eight objectives, never an average or a mode;
  `undefined` — never fabricated as SEAL0 — when any objective has no recorded
  SEAL) and `overallSealGovernedBy` (every objective id tied at that minimum).
  `SovereigntyAssessmentSchema` gains both fields.
- **`maxScore` had no default and no documented ceiling.** Added an exported
  `SOV_MAX_SCORES` constant with the calculator's actual per-objective maxima
  (`SOV-1 1000.03 · SOV-2 1002 · SOV-3 1000 · SOV-4 1002 · SOV-5 1001
  · SOV-6 1000 · SOV-7 1001 · SOV-8 1000`
  — a nominal 1000 is design intent, not arithmetic; the workbook rounds each
  criterion's answer value to 2dp). `objectives[].maxScore` is now OPTIONAL:
  when omitted, the accept/reject GUARD widens to the objective's actual
  `SOV_MAX_SCORES[id]` ceiling (a flat-1000 clamp would have falsely rejected a
  legitimate maximal SOV-2 response of 1002), while the contribution DIVISOR
  stays the calculator's flat nominal 1000 — the same formula the calculator
  itself uses for every objective regardless of that objective's true ceiling.
  Consequence, kept faithful rather than hidden: a maximal response across all
  eight objectives (every objective at its `SOV_MAX_SCORES` ceiling, `maxScore`
  omitted throughout) scores **100.0756%, not 100%**. An explicit
  caller-supplied `maxScore` is honoured exactly as before for both roles — the
  new defaulting only applies when it is omitted.

`manifest.yaml` and `model.version` bumped in lockstep with a fifth identity
`upgrades[]` entry — additive/corrective resource-shape changes only, no data
transformation. New suite file `arckit_workspace_csf_test.ts` (26 tests) plus
corrections to three stale assertions in `arckit_workspace_nl_test.ts` that
hard-coded the old wrong weights (a local `SOV_WEIGHTS` duplicate, one
sanity-test title, one hard-coded `15` in the fractional-contribution test).
Suite is now 274, all green; `deno lint`/`deno fmt --check` clean.

## 2026.08.07.1

Release of the NL sovereign-cloud overlay, with two defects closed that the
pre-publish adversarial review found in `2026.08.06.1`. **`2026.08.06.1` was
never published** — the registry moves `2026.08.02.1` → `2026.08.07.1` directly.
See the `2026.08.06.1` section below for the overlay itself.

- **`computeSovereigntyScore`'s fail-closed guard was one-sided.** It rejected a
  missing objective but silently accepted a **duplicate** id — a repeated
  `SOV-1` changed the computed score from 50 to 57.5, the later entry winning
  via the `new Map(...)` construction — and silently ignored an **unrecognized**
  id. The objective set is now validated closed and exact (SOV-1..SOV-8, each
  exactly once) before scoring, naming the offending id.
- **`MigrationSchema.ladder` was required with no default**, so a
  `classificationMigration` record written before the field existed failed to
  parse. That resource is `lifetime: "infinite"`, so such records persist and
  can be restored from the datastore. It now defaults to `"uae"` — the only
  ladder that ever existed — matching the `.default([])` precedent set for
  `skipped`/`unmappedFiles`. `MigrationSchema` is exported so a test pins it.

Both passed a fully green 244-test suite: the tests only exercised the
missing-objective direction and never parsed a legacy record. Suite is now 248.
`quality.yaml` gains its entry and lists `arckit_workspace_nl_test.ts` under the
`coverage` role.

## 2026.08.06.1

Never published — superseded by `2026.08.07.1`, which contains this plus the two
fixes above.

NL sovereign-cloud jurisdiction overlay. Adds an `nl-gov` governance profile,
six new NL/EU artifact types with bundled templates, a generalized
classification-ladder registry (`migrateClassification` gains a `ladder`
argument), and two new computable model methods grounding sovereign-cloud
governance in current Dutch/EU law and policy. Tracked on the LOCAL
`arckit-nl-sovereign-cloud` issue-lifecycle model.

- **`nl-gov` profile.** `PROFILE_EXTRAS` gains a fifth profile alongside
  `standard | uk-gov | mod | ai`: risk gate `+ nl-tbb`; design gate
  `+ nl-cloud`; assurance gate `+ nl-bio`, `+ nl-exit`, `+ eu-sovereignty`
  (three separate mandatory groups, order-insensitive). `nl-dtia` is
  deliberately **not** gate-required anywhere — it is a mandatory input for
  other artifacts (produced on demand per Rijksbreed cloudbeleid 2026 §3.1 when
  a third-country transfer without an adequacy decision is in scope), never
  itself required by a phase.
- **Six new NL/EU doc codes, templates and dependency edges**, wired into
  `DOC_CODES` / `COMMAND_TO_CODE` / `TEMPLATE_MAP` / `MANDATORY_DEPS`:

  | Command          | Doc code | Template file                           | Gating phase (nl-gov) | Mandatory inputs         |
  | ---------------- | -------- | --------------------------------------- | --------------------- | ------------------------ |
  | `nl-tbb`         | NLTBB    | `nl-tbb-classification-template.md`     | risk                  | stakeholders             |
  | `nl-cloud`       | NLCLD    | `nl-cloud-assessment-template.md`       | design                | requirements, nl-tbb     |
  | `eu-sovereignty` | EUSOV    | `eu-sovereignty-assessment-template.md` | assurance             | requirements             |
  | `nl-bio`         | NLBIO    | `nl-bio-conformance-template.md`        | assurance             | requirements, principles |
  | `nl-exit`        | NLEXIT   | `nl-exit-plan-template.md`              | assurance             | nl-cloud                 |
  | `nl-dtia`        | NLDTIA   | `nl-dtia-template.md`                   | **not gated**         | data-model, requirements |

  Every dependency's gating phase precedes or equals its dependent's
  (`stakeholders`→context precedes `nl-tbb`→risk precedes `nl-cloud`→design
  precedes `nl-exit`→assurance), verified by the existing table-driven
  phase-ordering property test swept across all profiles including `nl-gov`.
  None of the six new codes collide with the existing 62-entry `DOC_CODES` table
  and none contains a hyphen, so `CODES_BY_LENGTH` longest-first resolution is
  unaffected.
- **`migrateClassification` gains a `ladder` argument** (`z.enum` of registered
  ladder names, default `"uae"` — existing callers unaffected).
  `CLASSIFICATION_MAPPING` (UK → UAE Smart Data) generalizes into
  `CLASSIFICATION_LADDERS`, a registry keyed by ladder name; the shared
  `CLASSIFICATION_LINE` regex (bound to the fixed UK source vocabulary) is
  unchanged byte-for-byte, so only the per-ladder TARGET table varies — this
  keeps the existing UAE contract and its idempotence property test valid
  unmodified, and makes cross-ladder idempotence structural (NL targets are not
  UK tokens, so a second pass under either ladder matches nothing).
  `MigrationSchema` now records which `ladder` ran. New `ladder: "nl"` maps the
  UK ladder to VIRBI 2025 rubricering, and **maps only what a published source
  supports**:
  - `SECRET` → `Stg. GEHEIM` and `TOP SECRET` → `Stg. ZEER GEHEIM` are
    **sourced**, via the German BMI cross-national equivalence table
    (`BMI-IS-20060329-KF01-A004.1`), which aligns NATO markings with both the NL
    and UK national ladders: `SECRET ≡ NATO SECRET ≡ GEHEIM STG` and
    `TOP SECRET ≡ COSMIC TOP SECRET ≡ ZEER GEHEIM STG`.
  - `PUBLIC` → `Ongerubriceerd` is **reasoned, not cited** — both denote the
    absence of a classification and `Ongerubriceerd` is the lowest NL level, so
    it cannot under-protect.
  - `OFFICIAL` and `OFFICIAL-SENSITIVE` are **refused, not guessed**. The BMI
    table's UK row predates the April 2014 UK reform that replaced the lower
    tiers with `OFFICIAL` plus the `-SENSITIVE` caveat, and no published UK → NL
    equivalence covers them. Such lines are left byte-unchanged and reported in
    the run's `skipped` list for an explicit human decision; one undecidable
    document never aborts a whole-workspace migration.
  - `Stg. CONFIDENTIEEL` is **unreachable by migration** — by the same table it
    corresponds to UK `CONFIDENTIAL`, abolished in April 2014.

  ⚠️ This ladder rewrites **governance-document markings only**. UK Cabinet
  Office guidance (_International Classified Exchanges_ v1.5, Annex B) is that
  international classified information is not re-marked with another nation's
  classification — the norm is to protect it at the equivalent level. Do not
  point this migration at genuine foreign classified material.
- **`euSovereigntyScore` method** — new resource `sovereigntyAssessment`
  (`sovereignty-${slugify(subject)}`, optionally `${project}-`-prefixed).
  Implements `computeSovereigntyScore`: scores the EU Cloud Sovereignty
  Framework v1.2.1's eight weighted Sovereignty Objectives (SOV-1..SOV-8,
  weights 15/10/10/15/20/15/10/5, summing to exactly 100), fail-closed (rejects
  a missing objective, a negative score, a score exceeding its `maxScore`, or
  `maxScore <= 0`). Per-objective SEAL floors are **caller-supplied, never
  hardcoded** — the framework states the tender specification sets the minimum
  SEAL per objective, and the Dutch Verkenning notitie (NDS Cloudprogramma, 11
  juni 2026) independently confirms floors are demand-side. `SEAL_LABELS`
  carries both the English and official Dutch rendering for SEAL0–SEAL4 (Geen
  soevereiniteit .. Volledige digitale soevereiniteit). The method computes and
  reports; it does not certify — the written payload carries no
  attestation/certified field, and carries a per-objective `evidence` field
  through from the arguments.
- **`nlCloudEligibility` method** — new resource `cloudEligibility`
  (`cloud-eligibility-${slugify(subject)}`, optionally `${project}-` -prefixed).
  Implements `evaluateCloudEligibility`, encoding the Herziening rijksbreed
  cloudbeleid 2026 (EZK, 3 juli 2026, definitief) eligibility rules as a
  **four-value verdict** — `allowed | conditional | discouraged |
  prohibited`
  — resolved as a strict total order
  (`prohibited > conditional > discouraged > allowed`) over **every** fired
  rule, never first-match, with every fired clause returned alongside a
  human-readable `reason`. Fail-closed: every governance input
  (`processingRegion`, `supplierJurisdiction`, `isPrimaryProcess`,
  `isBasisregistratie`, `isEmailOrWorkplace`, the three separate clause-4.5
  condition booleans, and the three entity-type flags) is a required argument
  with no permissive default; `rubricering`/`tbbCategory` (at least one
  required) are validated as zod enums at the argument boundary.
  `supplierJurisdiction` is independent of `processingRegion` — an EEA
  processing region does not suppress the §4.3 discouraged rule when the
  supplier jurisdiction is non-EU/EEA. The one-way TBB↔rubricering inference
  (Stg. GEHEIM implies TBB 2, not the reverse) is honoured in that direction
  only when both are supplied and disagree.
- **Terminology rule**: field/argument names and `.describe()` text stay in
  English; enum values preserve the official Dutch/EU legal term verbatim
  (translating a classification level risks misstating the law), and every
  `.describe()` glosses the term in English on first use.
- **Templates** (`templates/`): the six new templates above plus
  `templates/_partials/document-control-nl.md` (an NL rubricering Document
  Control block, alongside the existing `document-control-uk.md` /
  `document-control-uae.md`). Every template carries a community-overlay banner
  (not officially validated — verify citations before reliance) and cites its
  grounding instrument + date directly, including the VIRBI 2013→VIRBI 2025
  repeal/replacement (9 September 2025), the TBB systematiek (Gereedschap v1.0,
  2026-06-06), BIO2 (vastgesteld OBDO 23 September 2025, v1.3 2026-01-09), and
  the Cyberbeveiligingswet/Wwke (in force 15 August 2026).
  `eu-sovereignty-assessment-template.md` carries a per-objective **evidence
  column** derived from the EU CSF's own observable contributing factors
  (decisive authority, governing legal system, cryptographic key holder,
  support-staff jurisdiction, hardware/firmware/software provenance, API/licence
  exit rights) and states plainly that vendor-analyst market reports are not
  acceptable evidence and that a self-declared SEAL is an unverified claim until
  the assessor records evidence per objective.
- `manifest.yaml` / `model.version`: bumped `2026.08.02.1` → `2026.08.06.1` in
  lockstep, with a new `upgrades[]` entry (`upgradeAttributes: identity` — the
  `PROFILES` widening is backward-compatible for reads and the two new resource
  schemas are additive, so no stored data needs transformation).
  `additionalFiles` gains the six new templates plus the new partial.
- `.claude/skills/arckit/SKILL.md`: `nl-gov` added to the `profile` enum in the
  `startProject` example; frontmatter `description` gains NL/EU trigger phrases
  ("rijksbreed cloudbeleid", "rubricering", "TBB", "sovereign cloud assessment",
  "nl-gov", "BIO2", "EU Cloud Sovereignty Framework"). No legal exposition added
  to SKILL.md's body — that stays in the templates.
- `.claude/skills/arckit/references/state-machine.md`: `nl-gov` row added to the
  Profile-extras table; two new Method-reference rows for `euSovereigntyScore`
  and `nlCloudEligibility`; `migrateClassification`'s row updated for its new
  `ladder` argument.
- `.claude/skills/arckit/references/phases.md` and `README.md`: terse nl-gov
  notes added to the risk/design/assurance sections and the model-methods list
  respectively.
- The installed skill copy at `swamp/.claude/skills/arckit/` was resynced from
  this workspace source and diff-verified identical, avoiding the known
  workspace-vs-installed drift failure mode documented in project memory.
- `extensions/models/arckit_workspace_nl_test.ts` (new, 135 tests) covers the
  ladder registry, cross-ladder idempotence, table wiring (doc codes, template
  map, profile extras, mandatory deps, phase-ordering), the two pure functions'
  fail-closed boundaries (every required argument asserted individually rejected
  when omitted, not silently defaulted), the verdict total order across every
  co-firing pair, and the two new methods' resource
  naming/logging/argument-schema behavior. All 248 tests
  (`deno test
  --allow-read --allow-write --allow-env=FC_NUM_RUNS extensions/models/`)
  pass, including the pre-existing 5 suites unmodified.
- **Two defects found by the pre-publish adversarial review were fixed before
  publishing**, rather than recorded and shipped:
  - `computeSovereigntyScore`'s fail-closed guard was **one-sided**. It rejected
    a missing objective but silently accepted a DUPLICATE id — a repeated
    `SOV-1` changed the computed score from 50 to 57.5 with no error, the later
    entry winning via the `new Map(...)` construction — and silently ignored an
    UNRECOGNIZED id. The objective set is now validated as closed and exact
    (each of SOV-1..SOV-8 exactly once) before scoring, with the offending id
    named in the error.
  - `MigrationSchema.ladder` was a **required** `z.enum` with no default, so any
    `classificationMigration` record written before this version — that resource
    is `lifetime: "infinite"`, so such records persist and can be restored from
    the datastore — would fail to parse. It now defaults to `"uae"`, which is
    correct because that was the only ladder that ever existed, and consistent
    with `skipped`/`unmappedFiles`, defaulted one version earlier for exactly
    this reason. `MigrationSchema` is now exported so the guarantee is pinned by
    a test that parses an old-shaped record with no `ladder` key.

## 2026.08.02.1

Real-fix pass closing all six remaining latent bugs tracked on the LOCAL
`arckit-latent-bugs` issue-lifecycle model (NEVER filed to the swamp.club Lab) —
LB2 (MEDIUM) and LB3..LB7 (LOW). `arckit_workspace.ts` was no longer byte-frozen
after the LB1 fix in `2026.08.01.1`; this is the second production change.

- **LB2 (MEDIUM) — `migrateClassification apply=true` non-atomic overwrite, no
  backup.** The apply branch now copies the pre-migration content to a
  `<artifact>.bak` recovery sibling, writes the proposed text to a sibling temp
  file, then `Deno.rename`s it over the artifact — an atomic replace on the same
  filesystem, so a reader always sees the whole old or whole new file, never a
  truncated partial, and a crash mid-write leaves the artifact intact plus a
  recoverable `.tmp` orphan.
- **LB3 (LOW) — unbounded `readTextFile` in `template` /
  `migrateClassification`.** Added a defaulted global arg `maxFileBytes`
  (default 10 MiB) to `GlobalArgsSchema`. `migrateClassification` cap-checks via
  the scan snapshot's `sizeBytes` WITHOUT reading, recording an oversize
  artifact in the new `skipped[]` field (`reason: "oversize"`) in both report
  and apply modes; `template` `Deno.stat`s the bundled file and rejects before
  reading if it exceeds the cap.
- **LB4 (LOW) — non-enum `projectState.state` vacuously satisfies the gate.**
  `ProjectStateSchema.state` is now `z.enum(PROJECT_STATES)` (`PHASES` plus
  `complete`/`abandoned`) instead of `z.string()` — a schema seam change only.
  `readProjectState` (the sole reader for
  `status`/`advance`/`skipPhase`/`abandon`) now rethrows a friendly
  `Corrupted project state for <dir>: ...` error instead of a raw ZodError when
  a hand-edited/datastore-restored state falls outside the enum, so `advance`
  can no longer auto-complete a bogus phase. `nextPhase` and
  `gateFor`/`evaluateGate` are UNCHANGED pure functions — the frozen
  contract-fixture (`nextPhase("bogus") === "complete"`) and
  `coverage_test.ts`'s `gateFor`/`evaluateGate` bogus-phase assertions stay
  byte-behaviorally identical; the schema simply makes them unreachable from the
  public API. Trade-off: `abandon` on a corrupted record now also rejects
  (fail-closed, cannot rescue a corrupted record via abandon) — accepted for a
  LOW corruption-recovery path.
- **LB5 (LOW) — project-id allocation breaks past 999.** `parseProjectDir`'s
  regex and the `startProject` allowlist guard both widen `\d{3}` to `\d{3,}`
  (3-OR-MORE digits); `nextProjectDir`'s `padStart(3, "0")` is unchanged, so ids
  `<=999` keep their existing 3-digit zero-padding and ids `>=1000` widen
  naturally. The guard's character class still forbids `/`, `\`, `.`, so every
  LB1 traversal payload stays rejected; `ARTIFACT_RE` (artifact filename ids) is
  untouched and stays 3-digit.
- **LB6 (LOW/info) — `templates` vs `provisionTemplates` inventory divergence.**
  `templates` now additionally walks the bundled `templates/` directory (the
  same source `provisionTemplates` copies) and surfaces any file with no
  `TEMPLATE_MAP` command in a new defaulted `unmappedFiles: string[]` field on
  `TemplateCatalogSchema`, reconciling the two methods' inventories.
  `templateCount` and the `sizeBytes:0` missing-file behavior are unchanged.
- **LB7 (LOW/info) — symlinked artifacts silently skipped.**
  `listFilesRecursive` and `scanWorkspace` now resolve a symlink entry's target
  kind via `Deno.stat` — a symlinked artifact or project directory is
  inventoried like a real one (bounded by the existing depth cap). Write-safety
  cross-cut with LB1/LB2: `migrateClassification`'s apply branch `Deno.lstat`s
  before writing and skips (reason `"symlink"`, reusing the LB3 `skipped[]`
  field) rather than writing through a symlink to a target outside the
  workspace; report-only mode still reads through the symlink and proposes.

`extensions/models/arckit_workspace.ts`: all six fixes land in a single
consolidated ordered block inside `migrateClassification`'s per-file apply loop
(LB3 cap-check → read+propose → LB7 symlink skip / LB2 backup+atomic write),
plus the schema/regex/directory-walk changes above.
`manifest.yaml`/`model.version` bumped `2026.08.01.1` → `2026.08.02.1` in
lockstep. Added `upgrades[]` (previously absent on this model) with identity
`upgradeAttributes: (old) => old` entries — `maxFileBytes` is a defaulted global
arg and `skipped`/`unmappedFiles` are defaulted resource-schema arrays, so no
stored data needs transformation.

- `extensions/models/arckit_workspace_adversarial_test.ts`: flipped LB2
  (`:121`), LB4 (`:197`, `:221`), LB5 (`:251`), LB6 (`:270`), and LB7 (`:306`)
  from `pin (arckit-latent-bugs LBN, SEVERITY):`-titled current-behavior pins to
  `fix regression (arckit-latent-bugs LBN,
  SEVERITY):`-titled POST-fix
  assertions; relabeled the two LB3 500 KB pins from "no size cap" to "under the
  default 10 MiB cap, round-trips whole". Added: LB2 crash-safety (`.bak` + no
  `.tmp` orphan) and idempotent-second-run cases; LB3 oversize-skip cases for
  both `migrateClassification` and `template` (via a small overridden
  `maxFileBytes`); LB7 symlinked-directory and symlinked-artifact-write-skip
  cases.
- `extensions/models/arckit_workspace_coverage_test.ts`: flipped the LB5
  boundary pin (`:416`) to assert `parseProjectDir("1000-new")` now parses;
  relabeled the LB4 `gateFor`/`evaluateGate` reinforcement (`:406`, unchanged
  pure-function behavior) and the LB6 `templateCount` reinforcement (`:432`,
  extended with an `unmappedFiles` assertion for the three seeded orphans).
- `extensions/models/arckit_workspace_property_test.ts`: broadened property
  (c)'s `nextProjectDir`/`parseProjectDir` arbitrary from `<=998` to `<=9998`,
  verifying the monotonic + round-trip invariant ACROSS the former 999 boundary
  instead of excluding it; property (g) re-verified to still reach `complete`
  for every profile.
- `extensions/models/fixtures/workspace.ts`: widened `FakeContext.globalArgs` to
  `{ path: string; maxFileBytes?: number }` (additive/optional — every existing
  call site stays valid).
- Full `deno task check` / `test` / `fmt:check` / `lint` all green; property
  suite re-verified at `FC_NUM_RUNS=10000`. The four LB1 fix-regression pins and
  the frozen contract-fixture (`arckit_workspace_test.ts`) are unchanged and
  stay green.

## 2026.08.01.1

Security fix: `startProject`'s `dir` argument is no longer trusted verbatim.
Fixes **arckit-latent-bugs LB1 (HIGH)** — path traversal / arbitrary directory
creation — tracked in the LOCAL `arckit-latent-bugs` issue-lifecycle model
(NEVER filed to the swamp.club Lab). `parseProjectDir`'s regex `^(\d{3})-(.+)$`
lets the `(.+)` tail carry `/` and `..`, and the accepted `dir` used to flow
verbatim into `Deno.mkdir` under `projects/` and into `writeResource`'s instance
name, with zero sanitization — a dir like `001-a/../../../../<abs>/pwn` could
create a directory OUTSIDE the configured workspace root.

- `extensions/models/arckit_workspace.ts`: `startProject.execute` now rejects
  any `dir` not matching `/^\d{3}-[a-z0-9-]+$/` with a clear error, placed
  immediately after the existing `000`-reserved check and BEFORE
  `readProjectState`, `Deno.mkdir`, and `writeResource` — the guard precedes all
  three write-side sinks. `parseProjectDir` itself is UNCHANGED and stays
  permissive: it is the shared read-model parser used by `scanWorkspace` to
  inventory pre-existing on-disk directories, and tightening it there would
  regress that inventory and the LB5 (`>999`) boundary pin. The allowlist guard
  lives only in `startProject`, the sole write-side factory that turns caller
  input into a filesystem path plus a resource key.
- `extensions/models/arckit_workspace_adversarial_test.ts`: the two LB1
  acceptance pins (`dir: "001-a/../b"`, `dir: "002-nested/deep"`) are flipped
  from characterizing acceptance to fix-regression tests asserting rejection,
  nothing created on disk, and no `projectState` resource written. Added
  regression coverage: legit single-segment dirs (`001-payment-gateway`,
  `002-nested`) still succeed and create exactly `projects/<dir>`; synthetic
  traversal payloads (`001-a/../b`, `002-nested/deep`, `001-../../etc`,
  `001-x/../../../tmp/pwn`) are each rejected with nothing created and no
  resource written. All payloads are synthetic strings used only as REJECTED
  inputs, never written to disk, and every case runs inside its own
  `Deno.makeTempDir()`. LB2..LB7 pins in the same file are untouched.
- `manifest.yaml` / `model.version`: bumped `2026.07.16.2` → `2026.08.01.1` in
  lockstep — this is the first production change to `arckit_workspace.ts` since
  the `ext-quality-bf-arckit` backfill; it is no longer byte-frozen.
- `quality.yaml`: header comment updated to record this fix and drop the
  byte-frozen / no-bump language as it pertains to LB1.
- Full `deno task check` / `test` / `fmt:check` / `lint` all green; property
  suite re-verified at `FC_NUM_RUNS=5000`. LB2 (MEDIUM) and LB3..LB7 (LOW)
  remain deferred on the `arckit-latent-bugs` model — none share LB1's fix path.

Also folded into this release (previously recorded here as `Unreleased`, with no
version bump, since it was itself a byte-frozen characterization pass) -- the
test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4d, FINAL
batch of the extension-quality backfill program, `ext-quality-test-backfill`).
At authorship time it was NO behavior change -- `arckit_workspace.ts` (1487 LOC)
was byte-frozen and the model `version` stayed `2026.07.16.2` (`manifest.yaml`
also unchanged); the LB1 fix above is the change that finally moved the version,
so both land together in `2026.08.01.1`.

- Added `extensions/models/arckit_workspace_methods_test.ts` (methods),
  `arckit_workspace_adversarial_test.ts` (adversarial),
  `arckit_workspace_coverage_test.ts` (coverage), and
  `arckit_workspace_property_test.ts` (property-invariant-flow).
  `arckit_workspace_test.ts` (the pre-existing contract-fixture -- pure logic
  plus real-bundled-template presence) is UNCHANGED and keeps its role.
- Added `extensions/models/fixtures/workspace.ts` -- a shared, synthetic fixture
  builder used by the methods/adversarial/coverage/property suites:
  `withTempWorkspace()` creates TWO separate `Deno.makeTempDir()` roots per test
  (the governance workspace `root`, and a `templatesDir` standing in for the
  bundled `templates/` directory via a fake `context.extensionFile`),
  `makeCtx()` builds a fake runtime context (globalArgs + logger +
  writeResource + readResource + extensionFile), and small helpers
  (`writeArtifact`, `writeTemplateFile`, `docControlContent`, `arcFilename`)
  populate them. Real `Deno.mkdir`/`writeTextFile`/`readDir`/`symlink`
  throughout -- no FS stubbing. `templatesDir` is always separate from the real
  bundled `arckit/templates/` that `arckit_workspace_test.ts` (the
  contract-fixture) reads -- none of the four new suites ever touches the real
  bundled directory.
- 7 latent bugs discovered while characterizing are PINNED (characterized as
  CURRENT behavior, not fixed -- `arckit_workspace.ts` is byte-frozen by this
  change) and tracked in the LOCAL `arckit-latent-bugs` issue-lifecycle model
  (NEVER filed to the swamp.club Lab):
  1. **Path traversal / arbitrary directory creation via `startProject`'s `dir`
     (HIGH)** -- `parseProjectDir`'s regex `^(\d{3})-(.+)$` lets the `(.+)`
     group contain `/` and `..`, and the accepted `dir` flows verbatim into
     `Deno.mkdir` under `projects/` and into `writeResource`'s instance name,
     with zero sanitization. Pinned within a temp dir (`dir:
     "001-a/../b"`
     resolves to `projects/b`, never escaping the sandbox).
  2. **Non-atomic in-place overwrite + unbounded read in
     `migrateClassification apply=true` (MEDIUM)** -- each matched artifact is
     read whole via `Deno.readTextFile` (no size cap) then rewritten in place
     via `Deno.writeTextFile`, with no temp-then-rename and no backup.
  3. **Unbounded `readTextFile` in `template` / `migrateClassification` (LOW)**
     -- no size limit anywhere; a 500KB fixture round-trips whole in both
     suites, demonstrating the absence of a cap without a multi-GB file.
  4. **Non-enum `projectState.state` auto-completes an unknown-phase gate
     (LOW)** -- `ProjectStateSchema.state` is `z.string()`, not the `PHASES`
     enum; a corrupted/hand-edited/datastore-restored state value outside
     `PHASES` makes `gateFor` return `[]`, so `evaluateGate` is vacuously
     satisfied and `advance` jumps straight to `"complete"`. Not reachable via
     the public API (`startProject` only ever writes a valid phase); the
     adversarial suite seeds the corrupted state directly to pin it.
  5. **Project-id allocation boundary breaks past 999 (LOW)** --
     `nextProjectDir` returns a 4-digit id once the highest existing id is 999,
     which `parseProjectDir` then rejects, so `startProject` throws and no
     further project can be auto-allocated.
  6. **`templates` vs `provisionTemplates` inventory divergence (LOW/info)** --
     `templates` enumerates only the 61 `TEMPLATE_MAP` commands, while
     `provisionTemplates` copies EVERY bundled file; four real bundled templates
     (`data-source-profile-template.md`, `framework-overview-template.md`,
     `tech-note-template.md`, `vendor-scoring-template.md`) are provisioned but
     never surfaced by `templates`.
  7. **Symlinked artifacts silently skipped (LOW/info)** --
     `listFilesRecursive`/`scanWorkspace` count only entries where `isFile` or
     `isDirectory` is `true`; a symlink (both `false`) is silently ignored, so a
     symlinked `ARC-*` artifact never appears in
     `scan`/`gaps`/`migrateClassification`.

  A security-POSITIVE finding is also pinned: `template`'s `command` argument is
  map-gated (`TEMPLATE_MAP[args.command]`), so a path-traversing or unknown
  command throws `"No template"` before any file read is attempted -- unlike
  `startProject`'s `dir` (LB1), `template` never reaches the filesystem with
  unsanitized caller input.
- `deno.json`: `check` task widened from two explicit files to
  `extensions/models/*.ts` (type-checks transitively pull in
  `fixtures/workspace.ts`). `test` task widened to
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (`--allow-write` is
  needed for the temp-dir workspace/templates fixtures the new suites write to;
  no `--allow-net`/`--allow-run` -- `arckit_workspace.ts` has no subprocess or
  network seam). Added `test:soak` for the high-count nightly property soak
  (`FC_NUM_RUNS=10000`).
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependency
  `npm:fast-check@4.8.0` (pinned exact version, per this repo's
  bundler-dependency rule) and its transitive `pure-rand`. Source dependencies
  (`npm:zod@4`) are unchanged.
- `quality.yaml`: all five required suites plus `docs.readme`/
  `docs.changelog`/`docs.skill` flip from `backlog` to `present` (`docs.skill`
  -> `.claude/skills/arckit/SKILL.md`, verified present). `watch`/`canary` stay
  `backlog` (seeded offender at CI-gate rollout, tracked in
  `ext-quality-test-backfill`). `ratchet` set to 100 / "Grade A" --
  `swamp extension quality arckit/manifest.yaml --json` reports
  `percentage: 100`, `status: "passed"` (arckit is SCORABLE; the seanime
  UNSCORABLE path does not apply). Removed `arckit` from `quality-allowlist.txt`
  in the same change (five-suite presence graduates it) -- the FINAL line
  removed from that file by the extension-quality backfill program (45
  extensions graduated).

## 2026.07.16.2

Initial release: a standalone swamp port of ArcKit (the Enterprise Architecture
Governance Harness) as a skill-driven state machine. No ArcKit Claude plugin and
no Python CLI required -- 65 bundled arc-kit templates plus a reimplementation
of the Python CLI's classification-migration behavior. `init` scaffolds a
workspace, `scan` inventories every project's `ARC-*` artifacts, `gaps` checks
the mandatory-dependency matrix, and the
`startProject`/`status`/`advance`/`skipPhase`/`abandon` state machine gates 12
governance phases (foundation through story) against artifacts actually on disk,
with `standard`/`uk-gov`/`mod`/`ai` profiles adding gate groups. Ships the
`arckit` skill for driving document production through the lifecycle.
