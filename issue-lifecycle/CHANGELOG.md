# Changelog

All notable changes to `@magistr/issue-lifecycle`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.06.12.1 — skills catch up with the TDD test-review sub-cycle

Skills + docs + evals + a drift-guard test only. **No model schema/method
changes** — the model type version stays `2026.04.30.1` (the sub-cycle has been
in the model since 2026.04.30.5; the bundled skills never documented it, so
agents wrote implementation code before the test-review gate and rubber-stamped
`tests_approved` afterwards).

### Drift-guard contract test

- New `extensions/models/issue_lifecycle_docs.test.ts`: per-file token
  assertions bind each skill doc to the model (implementation.md must reference
  `tests_approved` and must not claim the pre-sub-cycle transition; SKILL.md
  must dispatch `writing_tests`/`reviewing_tests`; autonomous-loop.md must map
  the test-review loop; state-machine.md's `record_review` guard row must
  include `reviewing_tests`), plus a completeness sweep that enumerates every
  `StateEnum` value and model method dynamically and requires each as a
  backticked token in state-machine.md.
- `deno.json`: test task is now directory-scoped with `--allow-read=.`; check
  task covers the new test file.

### Skill fixes

- New `references/test-review.md` — Phase 4a: author ALL failing tests
  (tests-only diff discipline; implementation code in the 4a diff is an
  automatic CRITICAL finding), drive the review loop, and call `tests_approved`
  **autonomously** on clean exit.
- `references/implementation.md` rewritten as Phase 4b: `implement` enters
  `writing_tests` (not `implementing`); the inline interleaved
  red-green-refactor block is replaced by GREEN/REFACTOR-only discipline against
  the approved suite.
- `SKILL.md`: phase table splits Phase 4 into 4a/4b; Core Principle 1 gains the
  `tests_approved` carve-out (the one sanctioned autonomous acceptance); resume
  section gains a state→reference-file dispatch table; new triggers "tests
  approved", "test review loop".
- `references/state-machine.md` re-synced to the current model: diagram,
  test-review loop visualization, guards (incl. `record_review` in
  `reviewing_tests`), method rows for `review_tests`/`iterate_tests`/
  `tests_approved`, `testReviewIteration` in state fields and hydrate table,
  hydrate writes the `summary` spec.
- `references/autonomous-loop.md`: Phase 4a column in the mapping table
  (`MAX_TEST_ITERATIONS` = 5), a "Phase 4a clean exit (autonomous)" subsection,
  and the Sacred rule re-scoped to name `approve_plan` and `resolve_findings` as
  the human gates with `tests_approved` the single exception.
- `references/code-review.md` and `references/review-matrix.md`: stale phase
  attributions and the understated acceptance gate corrected (full coverage AND
  zero CRITICAL AND zero HIGH).
- `tdd/SKILL.md`: new "TDD inside the issue lifecycle" section — RED en masse in
  `writing_tests`, GREEN/REFACTOR in `implementing`; interleaved RGR applies
  outside the lifecycle.

### Evals

- New scenario-5 (clean path): autonomous `tests_approved` at the gate.
- New scenario-8 (penalty path): implementation code in the 4a diff must be
  flagged CRITICAL instead of approved.
- scenario-4 task gains a Phase-4b preamble (criteria unchanged); scenario-0
  phase wording aligned to 4a/4b.

## 2026.05.25.3

- Ships the `2026.05.24.x` skill changes (BLUF plan format + implementation
  discipline) that never reached the registry because CI's deno-check matrix was
  red 2026-05-21…05-25. No model schema/method changes — model type version
  stays `2026.04.30.1`. First version actually published through the fully
  repaired CI path (setup-swamp binary + API-key auth.json + `-y`).
  `2026.05.25.1` (inert SWAMP_AUTH_TOKEN) and `2026.05.25.2` (push prompt
  cancelled with no TTY) were tagged but never reached the registry.

## 2026.05.24.2

- Publish release notes / changelog for the 2026.05.24 release (no content
  change from `2026.05.24.1`; the `.1` push omitted `--release-notes`).

## 2026.05.24.1 — plan presentation + implementation discipline

Skill changes (bundled `issue-lifecycle` skill). No model schema/method changes
— model type version stays `2026.04.30.1`.

### Plan presentation

- New skimmable **BLUF plan format**: Goal / Approach / Domain impact (exactly 4
  lines) / Scope table with a `DDD role` column / conditional Risks / numbered
  one-line Steps / Review coverage / Non-goals / Open questions.
- Front-loaded **"Plan output format (always)"** pointer in `SKILL.md` so the
  format applies even when a plan is produced outside the full lifecycle flow.
- Opt-in references for **HTML-artifact escalation**, **Wardley maps**
  (strategic build-vs-buy only), and **DDD diagram conventions**; diagrams off
  by default.
- Planning Step 9 and the autonomous-loop approval gate both render plans in
  this format.

### Implementation discipline (`implementation.md` Step 2)

- **Anchor changes in existing code**: map integration points first (grep
  callers/entry points), reuse or extend, no parallel code paths.
- **Right-size backward compatibility**: no compat shims, migrations, or version
  flags for unreleased / in-development code with no external consumers. New
  `adversarial-review.md` "Right-size backward compatibility" check enforces it
  at plan time.
- Explicit **RED / GREEN / REFACTOR** phases; refactor **in-place, never
  deferred** to a follow-up issue or "later".

### Validation

- Behaviors validated with tessl evals: BLUF plan format scored 100/100;
  integrate-with-existing-code and no-needless-backward-compat guards at 100%.

## 2026.04.30.5

- TDD test sub-loop, human escalation after the 5-iteration cap, explicit
  full-plan display in the plan-review phase, supporting CI fixes.
