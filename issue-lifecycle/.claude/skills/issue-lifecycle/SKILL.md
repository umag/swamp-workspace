---
name: issue-lifecycle
description: >
  Drive an issue from triage through completion using the
  @magistr/issue-lifecycle model. Fans out review skills in parallel, iterates
  autonomously until zero CRITICAL and zero HIGH findings remain, then waits
  for explicit human approval. Post-implementation harvests new UAT scenarios
  and knowledge base entries. Do NOT use for filing GitHub bugs/features (use
  `swamp-issue`) or ad-hoc review of code outside a lifecycle (use
  `tessl__review-*` directly). Triggers on "triage issue", "new issue",
  "issue plan", "lifecycle status", "resume issue", "approve plan",
  "review plan", "iterate plan", "issue lifecycle", "start issue",
  "harvest issue", "knowledge harvest", "tests approved",
  "test review loop".
---

# Issue Lifecycle

Orchestrate issues from filing to completion using the
`@magistr/issue-lifecycle` model. State persists across sessions — check it
anytime with `swamp model method run <name> hydrate` for a compact summary or
`swamp data get <name> current --json` for the full state.

## Core Principles (sacred — never violate)

1. **Never auto-approve.** `approve_plan` is **only** called after the human
   explicitly says one of: `approve`, `approved`, `looks good`, `ship it`, `go`,
   `LGTM`. Review-finding resolution is autonomous; **approval is not**. **The
   one sanctioned exception is `tests_approved`** (Phase 4a): the skill calls it
   autonomously when the test-review loop exits clean (full matrix coverage AND
   zero open CRITICAL AND zero open HIGH) — the model enforces that gate itself.
   `approve_plan` and `resolve_findings` remain human-gated. Do not generalize
   this exception to any other acceptance method, and do not stall at the test
   gate waiting for a human.
2. **Never skip the approval gate.** Even when the autonomous loop exits with
   zero blocking findings, you still present to the human and wait. The autonomy
   is on finding resolution, not on approval.
3. **Persist everything through the model.** Every decision goes through a model
   method so state survives context compression and session resumption. Never
   keep lifecycle state only in the conversation.
4. **File unrelated issues immediately.** If you discover a bug, code smell, or
   problem during investigation that is NOT related to the current issue, file
   it as a new issue. Do not try to fix it in the current work span. Scope creep
   is the single fastest way to derail a lifecycle.

## Repository configuration (agent-constraints/)

This skill reads repo-specific conventions from an `agent-constraints/`
directory at the repository root. If these files exist they customize the
corresponding phase; if not, documented defaults in each reference file apply.

- `agent-constraints/triage-conventions.md` — codebase exploration, bug repro
- `agent-constraints/planning-conventions.md` — analysis + docs requirements
- `agent-constraints/adversarial-dimensions.md` — review criteria overrides
- `agent-constraints/implementation-conventions.md` — build, verify, PR
- `agent-constraints/code-review-conventions.md` — post-impl matrix fan-out
- `agent-constraints/uat-conventions.md` — UAT test base location + format
- `agent-constraints/knowledge-base.md` — KB location + format
- `agent-constraints/iteration-limits.md` — autonomous loop caps

## Phase dispatch (read ONE file per phase)

| Phase                           | Model states                                                | Reference file                                                       |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| 1. Triage                       | `filed → triaged`                                           | [references/triage.md](references/triage.md)                         |
| 2. Planning                     | `triaged → planned`                                         | [references/planning.md](references/planning.md)                     |
| 3. Adversarial review           | `planned ↔ reviewing → approved`                            | [references/adversarial-review.md](references/adversarial-review.md) |
| 4a. TDD test review             | `approved → writing_tests ↔ reviewing_tests → implementing` | [references/test-review.md](references/test-review.md)               |
| 4b. Implementation              | `implementing`                                              | [references/implementation.md](references/implementation.md)         |
| 5. Code review                  | `implementing ↔ code_reviewing → resolved`                  | [references/code-review.md](references/code-review.md)               |
| 6. Knowledge harvest (optional) | `resolved → harvested → complete`                           | [references/knowledge-harvest.md](references/knowledge-harvest.md)   |

Phases 3, 4a, and 5 all drive a generic **autonomous iteration loop** (reject →
revise → re-review until zero CRITICAL and zero HIGH, with safeguards). The loop
logic lives in [references/autonomous-loop.md](references/autonomous-loop.md) —
read it alongside whichever review phase is active. (The reference-file count
deliberately exceeds the usual 2–7 guideline: each lifecycle phase dispatches to
exactly one file, and that discipline takes precedence.)

State machine diagram + transition guards + method reference live in
[references/state-machine.md](references/state-machine.md). Review matrix
activation rules (which of the 5 reviewers to run when) live in
[references/review-matrix.md](references/review-matrix.md).

## Plan output format (always)

Whenever you **write or present an implementation plan** — at planning Step 9,
at the approval gate, or any time you are asked to produce a plan for an issue —
render it in the skimmable BLUF format defined in
[references/plan-presentation.md](references/plan-presentation.md). Read that
file before emitting the plan. Non-negotiable highlights: Goal / Approach /
Domain impact (exactly 4 lines) / Scope table with a `DDD role` column /
conditional Risks / numbered one-line Steps; 40–80 lines; no code blocks; no
marketing words; diagrams off by default. This applies even outside the full
lifecycle flow.

## Worktree note

If you are in a Claude Code worktree (`.claude/worktrees/`), the worktree is not
an initialized swamp repository. Add `--repo-dir <path-to-main-repo>` to all
`swamp` commands, where the main repo is the parent of the `.claude/worktrees/`
directory. Every example in the reference files assumes you run from the main
repo; adapt as needed.

## Resuming a session

If the human returns to an in-progress issue, get a compact summary first:

```bash
swamp model method run <issue-name> hydrate
swamp data get <issue-name> hydrate --json
```

The hydrate output reports current state, planVersion, blocking finding counts,
matrix coverage, iteration cursors, and review history length. Use it to
dispatch to the right phase reference without reading the full state blob:

| Hydrate `state`                    | Read                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `filed`                            | [references/triage.md](references/triage.md)                         |
| `triaged`, `planned`               | [references/planning.md](references/planning.md)                     |
| `reviewing`                        | [references/adversarial-review.md](references/adversarial-review.md) |
| `writing_tests`, `reviewing_tests` | [references/test-review.md](references/test-review.md)               |
| `implementing`                     | [references/implementation.md](references/implementation.md)         |
| `code_reviewing`                   | [references/code-review.md](references/code-review.md)               |
| `resolved`, `harvested`            | [references/knowledge-harvest.md](references/knowledge-harvest.md)   |

For the full state:

```bash
swamp data get <issue-name> current --json
```

## Related skills

| Need                                            | Use skill                   |
| ----------------------------------------------- | --------------------------- |
| Pre-triage investigation                        | `tessl__moldable-dev`       |
| DDD analysis in planning                        | `tessl__ddd`                |
| TDD test strategy in planning                   | `tessl__tdd`                |
| Code review (matrix entry `code`)               | `tessl__review-code`        |
| Adversarial review (matrix entry `adversarial`) | `tessl__review-adversarial` |
| Security review (matrix entry `security`)       | `tessl__review-security`    |
| UX review (matrix entry `ux`)                   | `tessl__review-ux`          |
| Skill review (matrix entry `skill`)             | `tessl__review-skill`       |
| File a GitHub bug/feature (unrelated)           | `swamp-issue`               |
| Debug swamp itself                              | `swamp-troubleshooting`     |
