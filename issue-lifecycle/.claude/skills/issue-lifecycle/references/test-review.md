# Phase 4a: TDD test review

## Prerequisites

- State: `writing_tests` (the human approved the plan and `implement` was
  called) or `reviewing_tests` (a test-review round is in flight)
- A git branch is recorded in `state.branch`

Phase 4a authors the failing TDD test suite and drives it through review
**before any implementation code is written**. The plan's `testStrategy` field
says what to test; this phase turns it into reviewed, approved RED tests. Code
is written only in Phase 4b ([implementation.md](implementation.md)), after
`tests_approved`.

The autonomous iteration loop is the same one used by Phases 3 and 5 — read
[autonomous-loop.md](autonomous-loop.md) alongside this file. The Phase 4a
column of its mapping table applies.

## Step 1: Author ALL failing tests

Write the complete failing test suite for the approved plan in one pass — every
behavior the plan's `testStrategy` names. This is the RED phase of
red-green-refactor, done **en masse**: all tests first, reviewed together, then
all code (see the lifecycle section at the end of the bundled `tdd` skill).

Run the suite and confirm every new test **fails for the right reason** — the
behavior is genuinely missing, not a typo, import error, or permission problem.

**Tests-only diff discipline.** Before submitting for review, check:

```bash
git diff --name-only
git status --short
```

The diff may contain only test files (plus test-harness config named in the
approved plan, e.g. a test task in `deno.json`). **Implementation code in the
Phase 4a diff is an automatic CRITICAL finding** — reviewers are instructed to
flag it and the round cannot pass until it is removed. The gate exists so the
tests shape the code, not the other way around.

## Step 2: Enter the review round

```bash
swamp model method run <issue-name> review_tests
```

State transitions from `writing_tests` → `reviewing_tests`, the round's
`reviews` reset, and `reviewRoundStartedAt` is stamped.

## Step 3: Fan out reviewers

Same matrix as every other review phase: for each `reviewMatrix` entry that is
`true`, invoke the matching `tessl__review-*` skill in parallel. Give each
reviewer:

- The test diff (`git diff` + new files)
- The plan's `testStrategy` (what the tests are supposed to cover)
- The instruction that the docs/code under test are intentionally unimplemented
  — failing tests are the expected state, **not** a finding

What reviewers check here:

| Reviewer             | Test-review target                                                     |
| -------------------- | ---------------------------------------------------------------------- |
| `review-code`        | Test correctness, conventions, assertion quality, harness config       |
| `review-adversarial` | Coverage gaps, false-pass/false-fail modes in GREEN, gameability       |
| `review-security`    | Tests for the security-sensitive paths the plan named                  |
| `review-ux`          | Tests covering CLI output / error-message contracts                    |
| `review-skill`       | Contract effects on future skill authoring (for skill-touching issues) |

Plus the mandatory check for **implementation code in the diff** — any non-test,
non-harness file is CRITICAL, regardless of reviewer.

Record each result with `record_review` (valid in `reviewing_tests`):

```bash
swamp model method run <issue-name> record_review \
  --input reviewer=review-<name> \
  --input verdict=<PASS|FAIL|SUGGEST_CHANGES> \
  --input-file /tmp/test-findings-issue-<issue-name>.yaml
```

## Step 4: Drive the loop

Read [autonomous-loop.md](autonomous-loop.md) and run its control flow with the
Phase 4a mapping: `hydrate` after every full fan-out, exit clean on
`blocking.total == 0 AND coverage.complete`, safeguards (`MAX_TEST_ITERATIONS` =
5, loop detection, pivot-required) as documented there.

**Re-entry (named step — do not skip):** after every

```bash
swamp model method run <issue-name> iterate_tests \
  --input reason="..." --input source=auto
```

you are back in `writing_tests`. Revise the tests to address the findings,
re-run them (still RED, right reasons), then **call `review_tests` again** and
re-fan-out. Leaving the model in `writing_tests` after revising is an unfinished
round.

## Step 5: Clean exit — the autonomous gate

When the round is clean (full matrix coverage, zero open CRITICAL, zero open
HIGH):

```bash
swamp model method run <issue-name> tests_approved
```

**This call is autonomous — do not wait for a human trigger phrase.**
`tests_approved` is the single exception to the never-auto-approve principle:
the model itself enforces the gate (coverage + zero blocking) and the human
gates remain at `approve_plan` (Phase 3) and `resolve_findings` (Phase 5).
Stalling here waiting for approval is a process bug; so is generalizing this
autonomy to any other acceptance method.

State transitions `reviewing_tests` → `implementing`. Open MEDIUM/LOW findings
are carried in the round snapshot and get re-checked at Phase 5 code review.

## Override (cap reached only)

If the loop hits `MAX_TEST_ITERATIONS` without converging, hand over to the
human per autonomous-loop.md's safeguard-exit format. Only after explicit human
direction may you force the gate:

```bash
swamp model method run <issue-name> tests_approved \
  --input override_reason="<human's reason — recorded for audit>"
```

Override still requires full matrix coverage; it bypasses only the
blocking-findings check, and the round is snapshotted as `human_override`.

## Next phase

State is `implementing` → read [implementation.md](implementation.md) (Phase 4b)
to write the code that makes the approved tests pass.
