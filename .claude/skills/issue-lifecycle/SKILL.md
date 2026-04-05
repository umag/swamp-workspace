---
name: issue-lifecycle
description: >
  Drive issue triage and implementation lifecycle using the
  @magistr/issue-lifecycle extension model. Triage issues with moldable-dev
  investigation, generate plans with DDD analysis and TDD strategy, fan-out
  review skills in parallel, iterate on findings, and track implementation.
  Triggers on "triage issue", "triage #", "new issue", "issue plan", "issue
  status", "approve plan", "review plan", "issue lifecycle", "start issue".
---

# Issue Lifecycle

Orchestrate issues from filing to completion using the `@magistr/issue-lifecycle`
model. State persists across sessions — check it anytime with
`swamp model get <issue> --json`.

## Core Principle

**Never auto-approve.** Always show the plan to the human. Always ask for
feedback. Only call `approve_plan` when the human explicitly says to proceed.

## Quick Reference

| Phase | Action | Command |
|-------|--------|---------|
| File | Create issue | `swamp model create @magistr/issue-lifecycle issue-<N> && swamp model method run issue-<N> start --input title=... --input description=...` |
| Triage | Investigate with moldable-dev, then triage | `swamp model method run issue-<N> triage --input-file triage.yaml` |
| Plan | Create plan with DDD + TDD | `swamp model method run issue-<N> plan --input-file plan.yaml` |
| Review | Start plan review | `swamp model method run issue-<N> review_plan` |
| Record | Record each reviewer's findings | `swamp model method run issue-<N> record_review --input-file review.yaml` |
| Approve | Human approves plan | `swamp model method run issue-<N> approve_plan` |
| Implement | Start coding (TDD) | `swamp model method run issue-<N> implement --input branch=feat/...` |
| Code Review | Fan-out code reviews | `swamp model method run issue-<N> review_code` |
| Resolve | Record finding resolutions | `swamp model method run issue-<N> resolve_findings --input-file resolve.yaml` |
| Complete | Mark done | `swamp model method run issue-<N> complete` |
| Close | Abandon | `swamp model method run issue-<N> close --input reason=...` |

## Phase-by-Phase Instructions

### Phase 1: Triage

**Use moldable-dev.** Before triaging, investigate the problem domain:

1. Query live model/data state to understand context
2. Check audit logs for recent activity
3. Build a micro inspector if needed (CEL query, data pipeline)
4. THEN triage: set priority, category, affected areas

```yaml
# triage.yaml
priority: high          # critical | high | medium | low
category: bug           # bug | feature | improvement | refactor
affectedAreas:
  - extensions/models
  - workflows
```

### Phase 2: Plan

**Use ddd + tdd.** Every plan requires:
- **DDD analysis**: which aggregates, entities, value objects, domain services
- **TDD test strategy**: what tests first, red-green-refactor sequence
- **Review matrix**: which review skills should run

```yaml
# plan.yaml
summary: Fix state transition guard in issue lifecycle model
steps:
  - Add guard validation for duplicate state transitions
  - Write failing test for double-triage scenario
  - Implement guard with descriptive error
  - Add regression test
dddAnalysis: >
  Aggregate: issue-lifecycle model. Entity: issue state resource.
  Value Object: FindingSchema. Guard logic is a Domain Service.
testStrategy: >
  RED: test calling triage() twice throws. GREEN: add guard.
  REFACTOR: extract guard into helper function.
reviewMatrix:
  code: true
  adversarial: true
  security: false
  ux: false
  skill: false
```

### Phase 3: Review — FAN-OUT

After `review_plan`, invoke the relevant review skills **in parallel**:

1. Run `/review-adversarial` against the plan text
2. Run `/review-code` against the plan
3. Capture each skill's structured output
4. Record findings via `record_review` for each

```yaml
# review.yaml (one per reviewer)
reviewer: review-adversarial
verdict: FAIL                    # PASS | FAIL | SUGGEST_CHANGES
findings:
  - reviewer: review-adversarial
    severity: HIGH
    description: Plan doesn't address partial failure in state transition
    fix: Add rollback logic if writeResource fails after guard passes
```

**After ALL reviews recorded**, show aggregated findings to the human.
Human decides: `approve_plan` or `reject_plan`.

### Phase 4: Implement

**Use tdd.** Follow red-green-refactor:
1. Write failing test (RED)
2. Minimum code to pass (GREEN)
3. Refactor while green

**Use moldable-dev.** Inspect runtime state to verify behavior — not just tests.

### Phase 5: Code Review — FAN-OUT (selective)

After `review_code`, the model logs which reviewers are needed based on
`reviewMatrix`. Invoke each in parallel, record findings, then resolve.

See [references/review-matrix.md](references/review-matrix.md) for activation
rules.

### Resuming a Session

```bash
swamp model get issue-<N> --json    # Check current state
swamp data get issue-<N> current --json  # See full state data
```

Read the state field and pick up from the corresponding phase above.

## Key Rules

1. **Never skip the feedback loop.** Always show the plan. Always ask.
2. **Never call approve_plan without explicit human approval.**
3. **Persist everything through the model.** Don't just have a conversation —
   call model methods so state survives context compression.
4. **Use moldable-dev throughout** — triage, plan, implement, review.
5. **DDD analysis is mandatory** in every plan.
6. **TDD test strategy is mandatory** in every plan.

See [references/state-machine.md](references/state-machine.md) for the full
state diagram and transition rules.
