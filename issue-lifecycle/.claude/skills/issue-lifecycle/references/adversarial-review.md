# Phase 3: Adversarial review

## Prerequisites

- State: `planned` (just after a `plan` call — mandatory pairing)
- The plan exists with `reviewMatrix` populated

Read this **immediately after every `plan` or `iterate` call — no exceptions.**
Planning and adversarial review are always paired: you never present a plan for
human approval without having run a review round first.

This file covers **what a review round does**: fan-out, dimensions, codebase
verification, finding shape. The **autonomous iteration loop** that wraps rounds
lives in [autonomous-loop.md](autonomous-loop.md) — read that file in parallel
with this one, it drives the control flow for both plan review and code review
phases.

## Step 1: Enter the review phase

```bash
swamp model method run <issue-name> review_plan
```

State transitions from `planned` → `reviewing`. The model stamps
`reviewRoundStartedAt` for the history entry.

## Step 2: Fan out reviewers in parallel

For each `reviewMatrix` entry that is `true`, invoke the matching review skill
**in parallel** (single message, multiple tool calls):

| Matrix entry        | Skill to invoke             |
| ------------------- | --------------------------- |
| `code: true`        | `tessl__review-code`        |
| `adversarial: true` | `tessl__review-adversarial` |
| `security: true`    | `tessl__review-security`    |
| `ux: true`          | `tessl__review-ux`          |
| `skill: true`       | `tessl__review-skill`       |

See [review-matrix.md](review-matrix.md) for activation rules (which entries to
set during planning).

## Step 3: Default adversarial dimensions

For `tessl__review-adversarial`, pass the following dimensions if
`agent-constraints/adversarial-dimensions.md` doesn't override them:

- **Architecture** — domain boundaries, abstraction level, patterns
- **Scope** — too much / too little, scope creep, unnecessary changes
- **Risk** — failure modes, edge cases, race conditions, backwards compat
- **Testing** — strategy sufficiency, edge case coverage, integration gaps
- **Complexity** — over-engineered, unnecessary abstractions
- **Correctness** — logical gaps, pattern match with codebase
- **Documentation** — affected docs that would become stale

Plus one crucial check bundled in by default:

- **Trace existing execution paths** — when the plan adds a new entry point to
  an existing capability (new way to run something, acquire locks, dispatch
  events), find how existing callers invoke that capability and verify the plan
  routes through the same shared code path. New entry points that reimplement
  existing logic are a **HIGH** severity finding.
- **Right-size backward compatibility** — flag compat shims, deprecation paths,
  dual code paths, version flags, or migration scaffolding that the plan adds
  when nothing depends on the old behavior (code unreleased, in active
  development, or no external consumers). Needless backward compat is scope
  creep / over-engineering — raise it as a **MEDIUM** (or **HIGH** if it
  materially expands scope). The plan should just change the code unless a real
  released consumer or published contract is named.

## Step 4: Verify findings against the actual codebase

Every finding's `file` path should exist. Every claim about a function or type
must be verifiable. Grep for the things each plan step claims to touch — if a
step references a file or function that doesn't exist, that's a **CRITICAL**
finding (the plan is confabulated).

For rich plan steps (with `files` and `risks`), read every file in the list and
confirm:

- The file exists
- The functions / classes / types the plan will modify actually live there
- The proposed change doesn't conflict with existing patterns in the file
- Nearby code (adjacent functions, sibling files) isn't already doing what the
  step proposes (duplication risk)

## Step 5: Record each reviewer's findings

For **every** active matrix entry, call `record_review`:

```bash
swamp model method run <issue-name> record_review \
  --input reviewer=review-<name> \
  --input verdict=<PASS|FAIL|SUGGEST_CHANGES> \
  --input-file /tmp/findings-issue-<issue-name>.yaml
```

Where the YAML contains:

```yaml
findings:
  - reviewer: review-adversarial
    severity: HIGH # CRITICAL | HIGH | MEDIUM | LOW
    category: architecture # architecture | scope | risk | testing | complexity | correctness | documentation | pivot-required
    file: src/auth/AuthService.ts # optional
    line: 42 # optional
    description: >
      The plan adds a new token-mint path in AuthService that bypasses the
      existing TokenFactory. Existing callers route through TokenFactory for
      audit logging.
    fix: >
      Route the new code path through TokenFactory; extend TokenFactory with
      the missing capability if needed.
    status: open
```

**Issue-scoped filenames required.** Use
`/tmp/findings-issue-<issue-name>.yaml`, never generic `/tmp/findings.yaml`.
Stale content from other lifecycle sessions leaks into the current review.

### Severity guidance

- **CRITICAL** — plan will not work / is confabulated / introduces a security
  hole / breaks the build. Blocks approval. Forces iteration.
- **HIGH** — plan is missing a significant concern (test coverage gap,
  architecture violation, bypass of existing shared logic). Blocks approval.
  Forces iteration.
- **MEDIUM** — quality concern the human should see but isn't a blocker (naming,
  minor redundancy, nice-to-have test case). Shown as a warning.
- **LOW** — trivial or aspirational (consider for future, style nit). Shown as a
  warning, never blocks.

### Special finding categories

Two category values trigger special handling in the autonomous loop:

- **`pivot-required`** — the whole approach is wrong; no mechanical fix can
  salvage the current plan. Triggers handover to human.
- **Description prefix `FUNDAMENTAL:`** — same as above. Use the description
  prefix when the category doesn't fit `pivot-required` but you still want to
  signal a fundamental concern.

## Step 6: Hand off to the autonomous loop

Once every active matrix reviewer has recorded its findings, control passes to
the autonomous loop. Read [autonomous-loop.md](autonomous-loop.md) for the
exit-condition evaluation, safeguards, auto-iterate mechanics, and
present-to-human / handover exit modes.

For Phase 3 (plan review), the loop uses:

- `reject_plan --input source=auto` to return to `planned`
- `plan` to create the revised plan (bumps `planVersion`)
- `review_plan` to re-enter `reviewing`
- `approve_plan` on clean exit (only after explicit human trigger phrase)

## Next phase

Plan approved → human says `go` → `approve_plan` called → state becomes
`approved`. Read [implementation.md](implementation.md) when the human says to
implement.
