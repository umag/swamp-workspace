# Changelog

All notable changes to `@magistr/issue-lifecycle`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.05.25.1

- Ships the `2026.05.24.x` skill changes (BLUF plan format + implementation
  discipline) that never reached the registry because CI's deno-check matrix was
  red 2026-05-21…05-25. No model schema/method changes — model type version
  stays `2026.04.30.1`. First release published via the repaired CI publish path
  (real setup-swamp binary download).

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
