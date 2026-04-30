---
name: issue-lifecycle
description: >
  Drive issue triage and implementation lifecycle using the
  @magistr/issue-lifecycle extension model. Triage issues with moldable-dev
  investigation, record prior art (UAT scenarios, KB entries), generate plans
  with DDD analysis and TDD strategy, fan-out review skills in parallel,
  auto-reject plans that fail review, iterate autonomously on code-review
  findings until zero CRITICAL and zero HIGH remain, wait for explicit human
  approval, harvest UAT and KB improvement proposals, and track the issue
  through to completion.
  Triggers on "triage issue", "triage #", "new issue", "file issue",
  "issue plan", "issue status", "review plan", "approve plan", "reject plan",
  "iterate on findings", "harvest issue", "start issue", "issue lifecycle",
  "record prior art", "hydrate issue".
---

# Issue Lifecycle

Orchestrate issues from filing to completion using the
`@magistr/issue-lifecycle` model. State persists across sessions — check it
anytime with `swamp model get <issue> --json` or, more cheaply, by running
`hydrate` and reading the `summary` resource.

## Core Principle

**Never auto-approve.** Always show the plan to the human. Always ask for
feedback. Only call `approve_plan` when the human explicitly says to proceed.
The `approve_plan` gate is strict — it will refuse to approve until every
reviewer listed in the matrix has been recorded AND every open CRITICAL and HIGH
finding is resolved. Do not attempt to bypass it.

## Quick Reference

| Phase        | Action                                | Command                                                                                                                  |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| File         | Create issue                          | `swamp model create @magistr/issue-lifecycle issue-<N> && swamp model method run issue-<N> start --input-file file.yaml` |
| Triage       | Investigate with moldable-dev, triage | `swamp model method run issue-<N> triage --input-file triage.yaml`                                                       |
| Prior art    | Record existing UAT/KB that applies   | `swamp model method run issue-<N> record_prior_art --input-file prior-art.yaml`                                          |
| Plan         | Create plan with DDD + TDD            | `swamp model method run issue-<N> plan --input-file plan.yaml`                                                           |
| Review       | Start plan review                     | `swamp model method run issue-<N> review_plan`                                                                           |
| Record       | Record each reviewer's findings       | `swamp model method run issue-<N> record_review --input-file review.yaml`                                                |
| Auto-reject  | Auto revise after failed review       | `swamp model method run issue-<N> reject_plan --input reason=... --input source=auto`                                    |
| Approve      | Human approves plan                   | `swamp model method run issue-<N> approve_plan`                                                                          |
| Implement    | Start coding (TDD)                    | `swamp model method run issue-<N> implement --input branch=feat/...`                                                     |
| Code Review  | Fan-out code reviews                  | `swamp model method run issue-<N> review_code`                                                                           |
| Auto iterate | Loop back on CRITICAL/HIGH            | `swamp model method run issue-<N> iterate --input reason=... --input source=auto`                                        |
| Resolve      | Record finding resolutions            | `swamp model method run issue-<N> resolve_findings --input-file resolve.yaml`                                            |
| Harvest      | Record UAT/KB proposals (optional)    | `swamp model method run issue-<N> harvest --input-file harvest.yaml`                                                     |
| Complete     | Mark done                             | `swamp model method run issue-<N> complete`                                                                              |
| Close        | Abandon                               | `swamp model method run issue-<N> close --input reason=...`                                                              |
| Hydrate      | Cheap state check (autonomous loop)   | `swamp model method run issue-<N> hydrate && swamp data get issue-<N> hydrate --json`                                    |

## Phase-by-Phase Instructions

### Phase 1: Triage

**Use moldable-dev.** Before triaging, investigate the problem domain:

1. Query live model/data state to understand context
2. Check audit logs for recent activity
3. Build a micro inspector if needed (CEL query, data pipeline)
4. THEN triage: set priority, category, affected areas, and optionally
   confidence/reasoning/isRegression/clarifyingQuestions/reproduced

```yaml
# triage.yaml
priority: high # critical | high | medium | low
category: bug # bug | feature | improvement | refactor | security
affectedAreas:
  - extensions/issue-lifecycle
# Optional classification detail:
confidence: high # high | medium | low
reasoning: >
  Reproduced in three environments with the same stack trace.
isRegression: true
clarifyingQuestions: []
reproduced:
  status: reproduced # reproduced | could-not-reproduce | not-applicable
  notes: "Failing since v2026.04.05.1"
```

### Phase 2: Prior Art Lookup

**Before planning**, search for existing knowledge that already addresses part
of the problem. This enables the Phase 6 harvest to cleanly diff what you
already knew vs. what's newly learned by the end of the issue.

1. Search the UAT scenarios directory (or wherever test cases live) for any
   scenario that already covers the affected area.
2. Search the KB / decision log / runbooks for any prior pattern, anti-pattern,
   postmortem, or ADR that already touched this problem.
3. Record what you found — even an empty array is a useful record, because it
   documents that you looked.

```yaml
# prior-art.yaml
uatScenarios:
  - path: uat/retry-policy.yaml
    summary: Covers happy-path exponential backoff but not jitter
    reusable: true
kbEntries:
  - path: kb/decisions/2026-02-retry-strategy.md
    summary: Original retry decision — jitter was deferred
```

```bash
swamp model method run issue-<N> record_prior_art --input-file prior-art.yaml
```

### Phase 3: Plan

**Use ddd + tdd.** Every plan requires:

- **DDD analysis**: which aggregates, entities, value objects, domain services
- **TDD test strategy**: what tests first, red-green-refactor sequence
- **Review matrix**: which review skills should run during plan review and code
  review
- **Potential challenges**: candid up-front list of risks / unknowns / tradeoffs

Plan steps accept **either** bare strings (legacy, backward compatible) **or**
rich step objects with `order`, `description`, `files`, and `risks`. Prefer rich
objects when the plan touches more than one file or carries identified risks —
they are far easier to review.

Every call to `plan` bumps `planVersion` (so a plan revision after an
auto-reject is unambiguously a new version) and resets the current `reviews`
array. The prior round is preserved in `reviewHistory`.

```yaml
# plan.yaml — rich step form
summary: Fix retry jitter in @magistr/issue-lifecycle extension
steps:
  - order: 1
    description: Write failing test for jitter absence on first retry
    files:
      - extensions/models/issue_lifecycle.test.ts
    risks: None — pure test addition
  - order: 2
    description: Add jitter helper and apply to retry scheduler
    files:
      - extensions/models/issue_lifecycle.ts
    risks: Must preserve deterministic behaviour under seeded RNG for tests
dddAnalysis: >
  Aggregate: issue-lifecycle state. Value Object: FindingSchema.
  Domain Service: retry scheduler (jitter computation).
testStrategy: >
  RED: test demonstrating absent jitter. GREEN: add jitter with
  seedable RNG. REFACTOR: extract RNG factory.
reviewMatrix:
  code: true
  adversarial: true
  security: false
  ux: false
  skill: false
potentialChallenges:
  - Deterministic test behaviour with a randomized jitter
  - Backwards compatibility for callers holding deterministic timings
```

### Phase 4: Review — FAN-OUT

After `review_plan`, invoke the relevant review skills **in parallel**:

1. Run `/review-code` against the plan
2. Run `/review-adversarial` against the plan
3. Run any other enabled reviewers (`/review-security`, `/review-ux`,
   `/review-skill`)
4. Record each skill's structured output via `record_review` (one call each)

```yaml
# review.yaml (one per reviewer)
reviewer: review-adversarial
verdict: FAIL # PASS | FAIL | SUGGEST_CHANGES
findings:
  - reviewer: review-adversarial
    severity: HIGH
    description: Plan doesn't address partial failure in retry scheduler
    fix: Add rollback path if the scheduler throws mid-retry
    status: open
```

**After ALL reviews are recorded**, aggregate and decide:

- **Clean** (zero CRITICAL + zero HIGH + full coverage): show to human, wait for
  explicit approval, then call `approve_plan`.
- **Blocking findings present**: the skill MAY auto-reject by calling
  `reject_plan --input source=auto --input reason=<why>`. This returns to
  `planned` so you can revise (a new `plan` call produces `planVersion + 1`) and
  re-run the review cycle. Every round — clean or rejected — is snapshotted to
  `reviewHistory`.
- **Human rejects**: the human calls `reject_plan --input source=human`. Same
  transition, different `outcome` label.

### Phase 5: Implement

**Use tdd.** Follow red-green-refactor:

1. Write failing test (RED)
2. Minimum code to pass (GREEN)
3. Refactor while green

**Use moldable-dev.** Inspect runtime state to verify behavior — not just tests.

### Phase 6: Code Review — AUTONOMOUS LOOP

After `review_code`, the model logs which reviewers are needed based on
`reviewMatrix`. The loop is:

1. Fan out the enabled reviewers in parallel.
2. Record each verdict via `record_review`.
3. Check the verdicts.
   - **Clean**: call `resolve_findings` with the resolutions map → state
     `resolved`.
   - **CRITICAL or HIGH present**: call
     `iterate --input source=auto --input reason=<summary>` → state back to
     `implementing`, `codeReviewIteration` bumped, round snapshotted to
     `reviewHistory` with `outcome: "rejected_auto"`.
4. Go back to step 1 until clean or the safety cap trips.

**Loop-safety rules** — the autonomous loop MUST respect both:

- **Signature loop detection**: after each iteration, call `hydrate` and read
  the `summary` resource. If the `signature` field matches the previous
  iteration's signature, the loop is not making progress. Bail out, surface the
  findings to the human, and stop calling `iterate`.
- **Iteration cap**: stop autonomous iteration once `codeReviewIteration >= 5`.
  Surface to the human instead.

See [references/review-matrix.md](references/review-matrix.md) for the full gate
and loop-safety rules.

### Phase 7: Harvest (optional)

Before calling `complete`, optionally record what you learned. The harvest phase
captures **new** UAT scenarios and KB entries that should be added to the repo —
compare against the prior art recorded in Phase 2 to avoid duplicating what was
already known.

```yaml
# harvest.yaml
uatProposals:
  - scenario: Retry scheduler under jitter + seeded RNG
    rationale: Regression guard — the bug was jitter-missing
    path: uat/retry-jitter.yaml
    committed: false
kbProposals:
  - kind: pattern # decision | pattern | anti-pattern | runbook | postmortem
    title: Seedable RNG for deterministic retry tests
    body: >
      Use a factory that returns a seeded PRNG in tests and Math.random in
      production. Avoid Math.random in tests — it hides jitter regressions.
    path: kb/patterns/seedable-rng.md
    committed: false
```

```bash
swamp model method run issue-<N> harvest --input-file harvest.yaml
```

Then:

```bash
swamp model method run issue-<N> complete
```

`complete` accepts either `resolved` (harvest skipped) or `harvested` (harvest
performed) as the source state, so the harvest phase is genuinely optional.

### Resuming a Session

Two equally valid paths:

```bash
swamp model get issue-<N> --json                  # full blob
swamp data get issue-<N> current --json           # current state resource
```

For the autonomous loop, prefer the cheap path:

```bash
swamp model method run issue-<N> hydrate          # refreshes the summary
swamp data get issue-<N> hydrate --json           # read the compact summary
```

The `hydrate` method is side-effect-free against `state` — it only writes to the
separate `summary` resource, so reading the summary is safe to do from any state
at any time.

Read the state field and pick up from the corresponding phase above.

## Key Rules

1. **Never skip the feedback loop.** Always show the plan to the human before
   `approve_plan`. Autonomous iteration is allowed ONLY inside the code-review
   loop (Phase 6), and ONLY under the loop-safety rules.
2. **Never call approve_plan without explicit human approval.**
3. **Respect the approval gate.** Do not try to resolve findings with
   `status: accepted` or `status: wontfix` just to make the gate pass unless
   that is the genuine resolution — `hasBlockingFindings` checks
   `status === "open"`, so downgrading status without fixing is a gate bypass.
4. **Persist everything through the model.** Don't just have a conversation —
   call model methods so state survives context compression. Use `hydrate` for
   cheap state checks during long autonomous loops.
5. **Use moldable-dev throughout** — triage, plan, implement, review.
6. **DDD analysis is mandatory** in every plan.
7. **TDD test strategy is mandatory** in every plan.
8. **Harvest before you forget.** If the issue surfaced a new pattern, a new
   anti-pattern, or a regression-worthy UAT scenario, `harvest` it before
   `complete`. Future issues will start from a better baseline.

See [references/state-machine.md](references/state-machine.md) for the full
state diagram and transition rules. See
[references/review-matrix.md](references/review-matrix.md) for the review
matrix, the approval gate, and autonomous-loop safety.
