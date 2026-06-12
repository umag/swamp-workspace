# Phase 5: Code review (post-implementation)

## Prerequisites

- State: `code_reviewing` (Phase 4b just called `review_code`)
- The branch carries the test suite approved in Phase 4a (`tests_approved`), all
  plan steps executed, and tests passing locally

Phase 5 mirrors Phase 3 (adversarial review) but applies the matrix fan-out to
the implemented code rather than the plan.

The autonomous iteration loop is **identical** to Phase 3 — read
[autonomous-loop.md](autonomous-loop.md) for the loop logic. This file covers
the Phase-5-specific bits: what reviewers do differently when reviewing code vs
a plan, how to structure code-fix revisions, and how to present the final
result.

## Entry prerequisite

The `review_code` method was called at the end of Phase 4b, transitioning state
to `code_reviewing` and bumping `codeReviewIteration`. If you're resuming a
session and state is `code_reviewing`, you may need to re-enter by calling
`review_code` again (this will snapshot the previous round into `reviewHistory`
and start a fresh round — safe).

## Step 1: Fan out reviewers in parallel

Same matrix as Phase 3: for each `reviewMatrix` entry that's `true`, invoke the
matching `tessl__review-*` skill in parallel.

The key difference is **what each reviewer inspects**:

| Reviewer                    | Phase 3 target                 | Phase 5 target                                                  |
| --------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `tessl__review-code`        | Plan steps, file lists, intent | Actual diff, test output, conventions                           |
| `tessl__review-adversarial` | Plan assumptions, risks, scope | Edge cases, race conditions, real code paths                    |
| `tessl__review-security`    | Planned security surface       | Actual attack surface, credential handling, input validation    |
| `tessl__review-ux`          | Planned UX changes             | Actual CLI output, help text, error messages                    |
| `tessl__review-skill`       | Planned SKILL.md changes       | Actual SKILL.md diff, progressive disclosure, trigger precision |

Give each reviewer the branch diff as its primary input:

```bash
git diff main..<state.branch>
```

Plus a summary of what the change is supposed to do (pulled from
`state.plan.summary`) so the reviewer can check whether the code actually
matches the plan.

## Step 2: Default adversarial dimensions (code review flavor)

Same 7 dimensions as Phase 3, but evaluated against the code:

- **Architecture** — does the implementation match the plan's DDD analysis?
- **Scope** — did the implementation stay within the approved plan? Extra
  unrelated changes are a HIGH finding.
- **Risk** — were the `potentialChallenges` from the plan actually addressed?
  Missing mitigations are HIGH.
- **Testing** — do the new tests cover the cases the plan said they would?
  Missing tests for an approved test strategy are HIGH.
- **Complexity** — did the implementation grow beyond what the plan required?
- **Correctness** — does the code do what the plan said?
- **Documentation** — were the `## Documentation impact` items from the plan
  summary actually updated?

Plus:

- **Trace existing execution paths** (same as Phase 3, but applied to the actual
  code) — if the implementation added a new entry point that duplicates existing
  logic, that's HIGH.

## Step 3: Record findings

Same shape as Phase 3:

```bash
swamp model method run <issue-name> record_review \
  --input reviewer=review-<name> \
  --input verdict=<PASS|FAIL|SUGGEST_CHANGES> \
  --input-file /tmp/code-findings-issue-<issue-name>.yaml
```

Use `code-findings-` prefix so Phase 3 and Phase 5 YAML files don't collide if
sessions overlap.

Finding shape is identical to Phase 3 (see
[adversarial-review.md](adversarial-review.md) Step 5).

## Step 4: Hand off to the autonomous loop

Read [autonomous-loop.md](autonomous-loop.md). The loop's Phase 5 mapping uses:

- `iterate --input source=auto` to return to `implementing`
- (You make code fixes addressing the CRIT/HIGH findings)
- `review_code` to re-enter `code_reviewing`
- `resolve_findings` on clean exit (only after explicit human trigger)

Each `iterate` call bumps `codeReviewIteration` and snapshots the current round
into `reviewHistory`. `MAX_CODE_ITERATIONS` defaults to `5`.

## Step 5: Clean exit — present to human

Same format as Phase 3's present-to-human section. The iteration history table
will have `phase: code_review` entries; filter those if Phase 3 and Phase 5
rounds are both in history.

Wait for the trigger phrase, then call `resolve_findings`:

```bash
swamp model method run <issue-name> resolve_findings \
  --input-file /tmp/resolutions-issue-<issue-name>.yaml
```

Where the YAML maps any remaining MED/LOW findings that the human accepted to a
resolution note:

```yaml
resolutions:
  "MED: consider renaming foo to bar": "accepted — defer to follow-up"
  "LOW: comment typo": "fixed inline"
```

State transitions from `code_reviewing` → `resolved`. At this point you can
either:

- Call `complete` directly (skip harvest — quick path)
- Call `harvest` first, then `complete` (run Phase 6 — recommended)

## Step 6: Offer Phase 6 (harvest)

Before calling `complete`, ask the human:

> Implementation is verified and code review passed. Would you like to run the
> knowledge harvest step to extract UAT scenarios and KB entries from this
> lifecycle? This is optional but helps build up the test base and knowledge
> base over time. Say `harvest` to proceed, or `skip harvest` to call complete
> directly.

On `harvest` → read [knowledge-harvest.md](knowledge-harvest.md). On
`skip harvest` → call `complete` directly.

## Next phase

- If harvest requested: read [knowledge-harvest.md](knowledge-harvest.md).
- If skipped:
  `swamp model method run <issue-name> complete --input summary="..."`, state
  becomes `complete`.
