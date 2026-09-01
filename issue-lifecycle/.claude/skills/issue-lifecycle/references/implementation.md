# Phase 4b: Implementation

## Prerequisites

- State: `implementing`, reached via `tests_approved` — the TDD test suite was
  authored and passed review in Phase 4a ([test-review.md](test-review.md))
- The branch in `state.branch` carries the approved failing tests

Phase 4b writes the code that makes the approved tests pass, then hands off to
Phase 4c (verification), which is the only route onward to code review.

## Step 1: Confirm where you are

`implement` was called at the start of Phase 4a — it records the branch and
transitions the model from `approved` into the test-writing sub-phase (state
`writing_tests`):

```bash
swamp model method run <issue-name> implement \
  --input branch="feat/<issue-name>" \
  --input description="..."
```

Code is written only after the test-review loop exits clean and `tests_approved`
lands you in `implementing`. If the model is still in `writing_tests` or
`reviewing_tests`, you are in Phase 4a — go to [test-review.md](test-review.md);
do not write implementation code yet.

**Worktree resume rule.** If a session is resumed mid-implementation, run
`git checkout $(...state.branch)` before reading or writing code. Don't assume
you're on the right branch.

## Step 2: Execute the plan step by step

**Anchor every change in the existing codebase — do not bolt on parallel code.**
Studying how the surrounding code already works and wiring into it is a
**default expectation, not something the human should have to ask for.**

**Match backward-compatibility effort to release maturity.** If the code is
unreleased, in active development, or has no external consumers, **change it
directly** — no compat shims, deprecation paths, dual code paths, version flags,
or migration scaffolding. Add a compatibility layer only when a real released
consumer or published contract depends on the old behavior. When unsure, check
release status / consumers (or ask) before preserving anything —
`agent-constraints/implementation-conventions.md` may state the project's
maturity. Needless backward compat is scope creep; prefer just changing the
code.

Work through `state.plan.steps` in order. For each step:

1. Read every file in `step.files` to confirm the current contents.
2. **Map the integration points first.** Grep for the functions, types, events,
   and callers of the capability you're touching. Find the existing entry
   points, helpers, and abstractions, and **reuse or extend them** — route the
   new behavior through the existing shared code path, and match the file's
   established patterns, naming, and conventions.
3. Apply the step's description, wiring the change _into_ those integration
   points rather than alongside them.
4. Note any risks in `step.risks` and address them inline.

A new entry point that reimplements or sits parallel to existing logic is the
exact defect the plan reviewer flags as **HIGH** (see
[adversarial-review.md](adversarial-review.md), "Trace existing execution
paths"). Catch it here at implementation time — don't wait for review.

**Tests are already approved — do not write failing tests here.** That was Phase
4a. This phase is **GREEN** and **REFACTOR** against the approved suite:

1. **GREEN** — write the **minimum** code to make the next approved test pass —
   not the full implementation, just enough to go green.
2. **GREEN** — run the suite and confirm the test **passes** (and nothing else
   broke).
3. **REFACTOR** — always tidy up **now, while the tests are green** (improve
   naming, remove duplication, extract helpers). Do it in this same step — do
   **not** defer it to a follow-up issue, a TODO, or "later"; refactoring once
   the change is fresh is the cheapest it will ever be. State this step even
   when little is needed; "no refactor required" is a valid outcome, but say so.

If a step exposes a genuine gap in the approved test suite (a behavior the plan
requires but no test covers), that is a return to Phase 4a: write the failing
test, run `review_tests`, and drive the loop again — do not silently grow the
suite alongside the code.

Read `agent-constraints/implementation-conventions.md` at the repo root for
repo-specific build commands, binary paths, test commands, and conventions. If
it doesn't exist, fall back to `CLAUDE.md`.

## Step 3: Use moldable-dev during implementation

Inspect runtime state to verify behavior — not just tests. `tessl__moldable-dev`
can build micro-inspectors to:

- Query live model / resource state after each step
- Check audit logs for side-effects
- Compare before/after snapshots

This catches behavior gaps that unit tests miss.

## Step 4: Verify the fix against the reproduction

**Bugs and regressions only — skip for features, improvements, refactors,
security work.**

If Phase 1 triage created a bug reproduction
(`state.triageDetail.reproduced.status
== "reproduced"`), re-run the exact
reproduction steps from `state.triageDetail.reproduced.notes` against the branch
build. Record the outcome:

- **Pass**: "Verified: reproduction scenario now passes". Proceed to Phase 5.
- **Fail**: "Verification failed: <what still breaks>". Do NOT proceed — the
  plan didn't actually fix the problem. Go back to the plan phase
  (`reject_plan --input source=human` and re-plan) or to implementation (fix the
  gap).

If the triage said `could-not-reproduce`, you can't verify here — note that
explicitly and proceed with extra caution.

## Step 5: Do NOT open a PR yet

The PR comes after verification and attestation, not here. Opening it now means
CI discovers failures the verification loop was about to catch — the exact round
trip Phase 4c exists to eliminate.

The PR URL has a first-class home: the `prUrl` argument on `attest`
([attestation.md](attestation.md)). The old convention of appending a `## PR`
section to the plan summary is obsolete; do not use it.

## Step 6: Hand off to verification

Once implementation is complete — state is `implementing` (reached via
`tests_approved` or an `iterate` from code review), all plan steps are executed,
the approved test suite passes, and the reproduction (if any) verifies the fix —
run the repository's mechanical controls:

```bash
swamp model method run <issue-name> verify --input '{"controls": [...], "repoDir": "<abs path>", "runner": "local"}'
```

State transitions from `implementing` → `verifying`. Read
[verification.md](verification.md) for the control declarations, the outcome
statuses, and the loop.

**`review_code` cannot be called from `implementing`.** It is guarded on
`verifying`. If you find yourself reaching for it here, you are skipping the
controls.

## Next phase

Read [verification.md](verification.md). Code review
([code-review.md](code-review.md)) follows it, using the same autonomous loop
pattern as Phases 3 and 4a but applied to the code rather than the plan or the
tests.
