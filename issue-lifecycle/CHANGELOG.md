# Changelog

## 2026.08.19.1

- Version bump and smoke test

All notable changes to `@magistr/issue-lifecycle`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.08.02.1 — latent-bug fixes (IL-1/2/4/7) + five-suite quality

**Model behavior change — model type version bumped to `2026.08.02.1`** (first
release since the `2026.07.16.2` five-suite quality backfill). Real fixes for
four of the seven latent bugs triaged in the LOCAL issue-lifecycle model
`issue-lifecycle-latent-bugs`; three are explicitly re-affirmed as intentional
behavior, not fixed. No `globalArguments` or resource-schema change — the
version bump ships as an identity `upgrades[]` migration.

### Fixed

- **IL-1** — `start` used to overwrite whatever `current` held with no
  read-before-write — approved plans, review history, everything — with no guard
  or confirmation. It now reads existing state first: a fresh instance (no
  `current` yet) or one already in a terminal state (`complete`/`closed`)
  proceeds as before; anything else throws unless the new `force: boolean`
  argument (default `false`) is passed.
- **IL-2** — `approve_plan`/`tests_approved` gated only on `hasBlockingFindings`
  (open CRITICAL/HIGH count), so a reviewer could post `verdict: "FAIL"` with
  zero findings (or all findings resolved/non-blocking) and approval would still
  succeed. Both methods now also call the new `failingReviewers()` helper and
  block if any reviewer's verdict is FAIL, **after** the existing
  blocking-findings check (gate order preserved so "N CRITICAL and M HIGH" fires
  first when both conditions hold). `tests_approved`'s `override_reason` now
  bypasses both gates together, as before. `SUGGEST_CHANGES` remains
  non-blocking by design — only `FAIL` hard blocks, so the autonomous
  zero-CRITICAL/zero-HIGH loop can still converge without a human override.
- **IL-4** — `resolutions` is a flat `Record<string, string>` keyed by finding
  description text; two different reviewers whose findings happened to share
  description text collapsed into one entry. `resolve_findings` now expands each
  supplied key against the current round's findings: every reviewer whose
  finding matches that description gets its own
  `` `${reviewer} :: ${description}` `` composite key. A key matching no finding
  is stored verbatim (legacy-safe; unaffected: empty-map callers).
- **IL-7** — `record_review` appended every submission unconditionally, so
  recording the same reviewer twice in one round double-counted their open
  findings in the blocking gate. It now replaces (last-write-wins) the
  reviewer's earlier entry in place instead of appending a duplicate.

### Kept as designed (re-affirmed, not fixed)

- **IL-3** — no model-enforced iteration cap on `iterate`/`iterate_tests`.
  `MAX_CODE_ITERATIONS`/`MAX_TEST_ITERATIONS` stay skill-layer policy; enforcing
  a cap in the pure model would couple it to skill policy and could break the
  human `override_reason` escape hatch.
- **IL-5** — `close` has no `guardState` call and works from any state,
  including terminal ones. This is intentional: `close` is the abandon/escape
  hatch (manifest.yaml has always documented "works from any state") and an
  escape hatch must never itself be blockable.
- **IL-6** — `hydrate`'s `summary.snapshotAt` is stamped fresh via `now()` on
  every call, so two calls produce two different values even though `current` is
  never mutated. `snapshotAt` is a wall-clock capture stamp — it should differ
  per call; the property suite already proves non-mutation of `current` by
  freezing the clock (`@std/testing` `FakeTime`), which is the invariant that
  actually matters here.

### Five-suite quality (carried from the `2026.07.16.2` backfill, updated)

- `extensions/models/issue_lifecycle_methods_test.ts` — success + exact
  guardState-throw-message regression for each of the 20 model methods, a sweep
  pinning "No issue state found — run 'start' first" on every method but
  `start`, and a sweep pinning the REAL (not assumed) unknown-key behavior of
  every method's zod arguments schema: `swamp model type describe --json`
  renders `additionalProperties: false` (its own JSON-Schema view), but none of
  the 20 methods call `.strict()`, so a bare `.parse()` silently strips an
  unrecognized key rather than throwing.
- `extensions/models/issue_lifecycle_adversarial_test.ts` — illegal out-of-order
  transitions from varied source states, malformed reviewer input (bad
  severity/verdict enums rejected by zod), hostile approve_plan gate
  combinations (missing-matrix-reviewer, combined CRITICAL+HIGH counts),
  corrupted-stored-state pins for the "no plan found" branches in
  `approve_plan`/`tests_approved`, whitespace `override_reason` still gated, and
  pins asserting the FIXED IL-1/IL-2/IL-4/IL-7 behavior above plus the
  re-affirmed IL-3/IL-5 by-design behavior.
- `extensions/models/issue_lifecycle_coverage_test.ts` — branch fill for
  `allMatrixReviewersRecorded` across the security/ux/skill matrix dimensions,
  `hasBlockingFindings`'s full status filter (open / resolved / accepted /
  wontfix), the new `failingReviewers` pure-function coverage, both branches of
  `iterate`'s double-snapshot guard, the zod `source` default (`"human"`) on
  `reject_plan`/`iterate`/`iterate_tests`, `record_reproduction`'s
  create-vs-merge branches, `plan`'s planVersion-bump predicate (keyed on
  `data.plan` presence, not on which of the two guarded states the call came
  from), and `complete`'s silently discarded `summary` argument.
- `extensions/models/issue_lifecycle_property_test.ts` — `npm:fast-check@4.8.0`
  gated by `FC_NUM_RUNS` (`--allow-env=FC_NUM_RUNS`, `test:soak` task at 10000
  runs): P1 no illegal (state, method) pair ever succeeds, P2
  `hasBlockingFindings` totals are monotone non-decreasing under additional
  findings, P3 a randomized-but-legal walk (reject-then-replan /
  iterate_tests-then-retry / iterate-then-retry / harvest-or-skip, each an
  independent branch) always ends in `complete` with matching reviewHistory
  phase counts, P4 `hydrate` never mutates `current` (IL-6's
  `summary.snapshotAt` is excluded from being a flakiness source by freezing
  `now()` with `@std/testing` `FakeTime` for the whole property, not by
  hand-excluding a field), P5 (rewritten for the fixed gate) the `approve_plan`
  gate throws iff `hasBlockingFindings(...).total > 0` **OR** any reviewer's
  verdict is FAIL, and succeeds iff neither holds — verdict is now drawn
  independently of finding severity/status so both gate dimensions are exercised
  in every combination.
- `issue-lifecycle/quality.yaml` — all five suites `present`; `docs.readme`,
  `docs.changelog`, and `docs.skill` (`.claude/skills/issue-lifecycle/SKILL.md`,
  already bundled) `present`; `watch`/`canary` stay `backlog` (justification:
  seeded offender at CI-gate rollout — backfill tracked in
  `ext-quality-test-backfill`); ratchet
  `{rubricVersion: 3, baselinePercentage: 100, label: "Grade A"}`.
- `deno.json` — `test` task gains `--allow-env=FC_NUM_RUNS`; `test:soak` task;
  `check` task globs `extensions/models/*.ts`.

## 2026.06.12.3 — eval scenario-9: resume-dispatch from the TDD sub-cycle

Evals only. **No model schema/method changes — model type version stays
`2026.06.12.2`.**

- New eval scenario-9: a resumed session at `writing_tests` must dispatch via
  SKILL.md's resume table to `references/test-review.md` and drive the Phase 4a
  loop through the autonomous gate. Fixture is mid-loop (one `rejected_auto`
  test round, two named HIGH findings, current round reset); criteria are
  order-anchored and mechanically scorable (orientation comment block, Phase 4a
  verbs proxy, `tests_approved` as the final state-mutating call). Closes the
  eval gap recorded in the `tdd-subcycle-doc-drift` harvest; gate-decision
  behavior remains covered by scenarios 5 and 8.

## 2026.06.12.2 — record_reproduction method

**Model behavior change — model type version bumped to `2026.06.12.2`** (first
model change since `2026.04.30.5`; the intervening releases were skills-only).

- New method `record_reproduction` — record or update the bug-reproduction
  outcome after triage. Optional, for bugs/regressions; guard
  `[triaged, planned]` (mirrors `record_prior_art`); merges into
  `triageDetail.reproduced` without touching classification; state is unchanged;
  a second call overwrites the first (retry-later supported). Fixes the
  documented-but-impossible flow where `triage.md` Step 5 instructed re-calling
  `triage` to record the reproduction — the triage guard (single-shot by design)
  rejects every re-call.
- `references/triage.md`: Step 5 now presents both legal paths (include
  `reproduced:` in the single triage call when already in hand, or
  `record_reproduction` later) with a file-based multiline-notes example; the
  factually wrong "follow-up note" parenthetical is gone; Step 4 gains an
  explicit triage-is-single-shot callout.
- `references/state-machine.md`: guard/method rows for the new method; both
  sibling recorder annotations now read `(optional, stays in
  triaged/planned)`
  matching their actual guards.
- 5 new model tests (merge-preserves-detail, planned parity, filed rejection,
  detail creation, overwrite); the docs drift-guard's dynamic sweep enforced the
  state-machine.md documentation mechanically.

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
