# State machine + methods reference

Complete state transition diagram and method table for
`@magistr/issue-lifecycle` v2026.06.12.1.

## State diagram

```
          ┌─────────┐
          │  filed  │
          └────┬────┘
               │ triage()
          ┌────▼────┐
          │ triaged │
          └────┬────┘
               │ record_prior_art() (optional, stays in triaged)
               │ plan() (v1)
          ┌────▼────┐
┌────────▶│ planned │◀───── reject_plan() (source=auto|human)
│         └────┬────┘             ▲
│              │ review_plan()    │
│         ┌────▼──────┐           │
│         │ reviewing │───────────┘
│         └────┬──────┘
│              │ approve_plan() (human-gated)
│         ┌────▼────────┐
│         │  approved   │
│         └────┬────────┘
│              │ implement()
│         ┌────▼──────────┐
│         │ writing_tests │◀──── iterate_tests() (source=auto|human)
│         └────┬──────────┘             ▲
│              │ review_tests()         │
│         ┌────▼────────────┐           │
│         │ reviewing_tests │───────────┘
│         └────┬────────────┘
│              │ tests_approved() (autonomous gate; override after cap)
│         ┌────▼──────────┐
│         │ implementing  │◀───── iterate() (source=auto|human)
│         └────┬──────────┘             ▲
│              │ review_code()          │
│         ┌────▼─────────────┐          │
│         │ code_reviewing   │──────────┘
│         └────┬─────────────┘
│              │ resolve_findings() (human-gated)
│         ┌────▼────────┐
│         │  resolved   │───── complete() ────┐
│         └────┬────────┘                      │
│              │ harvest()                     │
│         ┌────▼────────┐                      │
│         │  harvested  │─── complete() ───────┤
│         └─────────────┘                      │
│                                              │
│ close() (from any state)                     │
│         ┌──────────┐                    ┌────▼───────┐
└────────▶│  closed  │                    │  complete  │
          └──────────┘                    └────────────┘
```

Key features of the current machine:

- **TDD test-review sub-cycle** between `approved` and `implementing`:
  `implement()` enters `writing_tests`, the suite is reviewed in
  `reviewing_tests`, and code may only be written after `tests_approved()`.
  `tests_approved` is the lifecycle's **single autonomous acceptance** — the
  model enforces full matrix coverage + zero open CRITICAL/HIGH itself.
- **`harvested` state** between `resolved` and `complete` — optional, set by
  `harvest()`. `complete()` accepts both `resolved` and `harvested`.
- **`iterate()` accepts both `resolved` and `code_reviewing`** as source, so
  autonomous code-review loops can bounce directly without double-snapshotting.
- **`reject_plan()`, `iterate_tests()`, and `iterate()` take a `source` arg**
  (`auto` | `human`) that tags the `reviewHistory` outcome as `rejected_auto` or
  `rejected_human`, so audits can distinguish autonomous rejections from human
  rejections.

## Autonomous loop visualization

The skill drives autonomous iteration in three places — `planned ↔ reviewing`
(plan review), `writing_tests ↔ reviewing_tests` (test review), and
`implementing ↔ code_reviewing` (code review) — until zero CRITICAL and zero
HIGH findings remain:

```
planned ──[review_plan]──▶ reviewing
                               │
         ┌── autonomous ───────┤
         │                     │
         ▼                     │
    [fan out reviewers]        │
         │                     │
         ▼                     │
    [hydrate]                  │
         │                     │
         ▼                     │
   CRIT+HIGH > 0?              │
         │                     │
    yes  ├── reject_plan ──────┤
         │     (source=auto)   │ re-plan (bumps planVersion)
         │                     │ → review_plan
         │                     │
    no   └── present to human  │
              (wait for trigger)│
              ▼                 │
         approve_plan ──────────┘ (sacred human gate)
              │
              ▼
          approved
```

The test-review sub-loop is the same shape with one crucial difference — the
clean exit is **autonomous**, not human-gated:

```
writing_tests ──[review_tests]──▶ reviewing_tests
                                       │
         ┌── autonomous ───────────────┤
         │                             │
         ▼                             │
    [fan out reviewers on the tests]   │
         │                             │
         ▼                             │
    [hydrate]                          │
         │                             │
         ▼                             │
   CRIT+HIGH > 0?                      │
         │                             │
    yes  ├── iterate_tests ────────────┤
         │     (source=auto)           │ rewrite tests
         │                             │ → review_tests
         │                             │
    no   └── tests_approved ───────────┘ (AUTONOMOUS — no trigger phrase)
              │
              ▼
         implementing
```

Safeguards (skill-enforced, not model-enforced):

- **MAX_PLAN_ITERATIONS** (default 5) — cap on autonomous plan-review rounds per
  plan version
- **MAX_TEST_ITERATIONS** (default 5) — cap on autonomous test-review rounds
- **MAX_CODE_ITERATIONS** (default 5) — cap on autonomous code-review rounds
- **Loop detection** — two identical finding signatures in a row triggers
  handover
- **Pivot required** — findings tagged `pivot-required` or prefixed
  `FUNDAMENTAL:` trigger handover

See [autonomous-loop.md](autonomous-loop.md) for the full loop logic.

## Transition guards

| Method             | Guard                                                                                                                           | Error if violated                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `start`            | none (writes from empty)                                                                                                        | —                                                                         |
| `triage`           | state == `filed`                                                                                                                | "Cannot call 'triage' in state 'X'"                                       |
| `record_prior_art` | state in [`triaged`, `planned`]                                                                                                 | "Cannot call 'record_prior_art' in state 'X'"                             |
| `plan`             | state in [`triaged`, `planned`]                                                                                                 | "Cannot call 'plan' in state 'X'"                                         |
| `review_plan`      | state == `planned`                                                                                                              | "Cannot call 'review_plan' in state 'X'"                                  |
| `record_review`    | state in [`reviewing`, `reviewing_tests`, `code_reviewing`]                                                                     | "Cannot call 'record_review' in state 'X'"                                |
| `approve_plan`     | state == `reviewing` **AND** every active matrix reviewer has recorded a result **AND** 0 open CRITICAL + 0 open HIGH           | "missing reviews from ..." or "N CRITICAL and M HIGH findings still open" |
| `reject_plan`      | state == `reviewing`                                                                                                            | "Cannot call 'reject_plan' in state 'X'"                                  |
| `implement`        | state == `approved`                                                                                                             | "Cannot call 'implement' in state 'X'"                                    |
| `review_tests`     | state == `writing_tests`                                                                                                        | "Cannot call 'review_tests' in state 'X'"                                 |
| `iterate_tests`    | state == `reviewing_tests`                                                                                                      | "Cannot call 'iterate_tests' in state 'X'"                                |
| `tests_approved`   | state == `reviewing_tests` **AND** full matrix coverage **AND** (0 open CRITICAL + 0 open HIGH, OR non-empty `override_reason`) | "missing reviews from ..." or "N CRITICAL and M HIGH findings still open" |
| `review_code`      | state == `implementing`                                                                                                         | "Cannot call 'review_code' in state 'X'"                                  |
| `resolve_findings` | state == `code_reviewing`                                                                                                       | "Cannot call 'resolve_findings' in state 'X'"                             |
| `iterate`          | state in [`resolved`, `code_reviewing`]                                                                                         | "Cannot call 'iterate' in state 'X'"                                      |
| `harvest`          | state == `resolved`                                                                                                             | "Cannot call 'harvest' in state 'X'"                                      |
| `complete`         | state in [`resolved`, `harvested`]                                                                                              | "Cannot call 'complete' in state 'X'"                                     |
| `close`            | (any state) — transitions to `closed`                                                                                           | never errors                                                              |
| `hydrate`          | (any state)                                                                                                                     | never errors; read-only (writes the `summary` spec, not `state`)          |

**Note on the acceptance gates:** `approve_plan` blocks on CRITICAL or HIGH
**and** requires every matrix reviewer to have recorded a result for the current
round. `tests_approved` enforces the same gate autonomously — no human trigger —
and additionally supports an explicit `override_reason` for a human
force-approve after the iteration cap (override still requires full matrix
coverage). This is what lets the skill's autonomous loops trust the model to
refuse premature acceptance even if the skill itself has a bug.

## Method reference

| Method             | Args                                                                                                                         | Output                                                             | Description                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `start`            | `title`, `description`, `labels?`                                                                                            | `state` resource (name: `current`)                                 | File a new issue                                                      |
| `triage`           | `priority`, `category`, `affectedAreas`, `confidence?`, `reasoning?`, `isRegression?`, `clarifyingQuestions?`, `reproduced?` | updates `current`                                                  | Triage with optional classification detail                            |
| `record_prior_art` | `uatScenarios`, `kbEntries`                                                                                                  | updates `current`                                                  | Record pre-planning knowledge lookup results                          |
| `plan`             | `summary`, `steps`, `dddAnalysis`, `testStrategy`, `reviewMatrix?`, `potentialChallenges?`                                   | updates `current`, bumps `planVersion`                             | Create or revise implementation plan                                  |
| `review_plan`      | —                                                                                                                            | updates `current`, sets `reviewRoundStartedAt`                     | Enter plan review phase                                               |
| `record_review`    | `reviewer`, `verdict`, `findings?`                                                                                           | updates `current`, appends to `reviews`                            | Record one reviewer's findings                                        |
| `approve_plan`     | —                                                                                                                            | updates `current`, snapshots to `reviewHistory`                    | Human-gated plan approval                                             |
| `reject_plan`      | `reason`, `source?`                                                                                                          | updates `current`, snapshots to `reviewHistory`, resets `reviews`  | Reject and return to `planned`                                        |
| `implement`        | `branch`, `description?`                                                                                                     | updates `current`                                                  | Start TDD on a branch — enters `writing_tests`                        |
| `review_tests`     | —                                                                                                                            | updates `current`, sets `reviewRoundStartedAt`                     | Enter test review phase                                               |
| `iterate_tests`    | `reason`, `source?`                                                                                                          | updates `current`, snapshots, bumps `testReviewIteration`          | Return to `writing_tests` for another test-review round               |
| `tests_approved`   | `override_reason?`                                                                                                           | updates `current`, snapshots to `reviewHistory`                    | Autonomous test-gate acceptance → `implementing` (override after cap) |
| `review_code`      | —                                                                                                                            | updates `current`, sets `reviewRoundStartedAt`                     | Enter code review phase                                               |
| `resolve_findings` | `resolutions`                                                                                                                | updates `current`, snapshots to `reviewHistory`                    | Merge resolutions, transition to `resolved`                           |
| `iterate`          | `reason`, `source?`                                                                                                          | updates `current`, snapshots, bumps `codeReviewIteration`          | Return to `implementing` for another code-review round                |
| `harvest`          | `uatProposals`, `kbProposals`                                                                                                | updates `current`, writes `harvest` field                          | Record UAT/KB harvest proposals                                       |
| `complete`         | `summary?`                                                                                                                   | updates `current`, sets `completedAt`                              | Mark issue complete                                                   |
| `close`            | `reason`                                                                                                                     | updates `current`, sets `closedReason`                             | Abandon from any state                                                |
| `hydrate`          | —                                                                                                                            | writes **separate** `hydrate` resource (does NOT mutate `current`) | Compact decision summary for autonomous loop                          |

## State fields

| Field                                   | Set by                                                                                          | Description                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                                 | every method                                                                                    | Current lifecycle state                                                                                                                               |
| `title`, `description`, `labels`        | `start`                                                                                         | Issue basics                                                                                                                                          |
| `priority`, `category`, `affectedAreas` | `triage`                                                                                        | Triage classification                                                                                                                                 |
| `triageDetail`                          | `triage`                                                                                        | Optional classification detail: `confidence`, `reasoning`, `isRegression`, `clarifyingQuestions`, `reproduced`                                        |
| `priorArt`                              | `record_prior_art`                                                                              | Pre-planning knowledge lookup results                                                                                                                 |
| `plan`                                  | `plan`                                                                                          | Plan object with `summary`, `steps`, `dddAnalysis`, `testStrategy`, `reviewMatrix`, `potentialChallenges`, `planVersion`                              |
| `planVersion`                           | `plan`                                                                                          | Current plan version number (bumped on every `plan` call)                                                                                             |
| `reviews`                               | `record_review`                                                                                 | **Current round's** reviewer results (reset at every `review_plan`, `review_tests`, `review_code`, `plan`, `reject_plan`, `iterate_tests`, `iterate`) |
| `reviewHistory`                         | `approve_plan`, `reject_plan`, `iterate_tests`, `tests_approved`, `resolve_findings`, `iterate` | **Append-only** audit of every completed review round                                                                                                 |
| `testReviewIteration`                   | `start` (init), `iterate_tests` (bump)                                                          | Test-review iteration counter                                                                                                                         |
| `codeReviewIteration`                   | `start` (init), `iterate` (bump)                                                                | Code-review iteration counter                                                                                                                         |
| `branch`                                | `implement`                                                                                     | Git branch name                                                                                                                                       |
| `resolutions`                           | `resolve_findings`                                                                              | Cumulative map of finding → resolution                                                                                                                |
| `harvest`                               | `harvest`                                                                                       | UAT + KB harvest proposals                                                                                                                            |
| `completedAt`                           | `complete`                                                                                      | Completion timestamp                                                                                                                                  |
| `closedReason`                          | `close`                                                                                         | Why the issue was abandoned                                                                                                                           |
| `reviewRoundStartedAt`                  | `review_plan`, `review_tests`, `review_code`                                                    | Timestamp used as `startedAt` in history snapshot                                                                                                     |

## Hydrate resource (separate from `current`)

`hydrate()` writes a **separate** resource under the **`summary` spec** (name:
`hydrate`) so the skill can read a compact summary without parsing the full
`current` blob. (It does not live under the `state` spec — the two specs have
incompatible schemas by design.) The `hydrate` resource contains:

| Field                       | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `state`                     | Current lifecycle state                                           |
| `planVersion`               | Current plan version                                              |
| `planIterationsThisVersion` | Number of `plan_review` rounds for this plan version              |
| `testReviewIteration`       | Current test-review iteration counter                             |
| `codeReviewIteration`       | Current code-review iteration counter                             |
| `blocking`                  | `{critical, high, total}` open blocking findings in current round |
| `coverage`                  | `{complete, missing}` matrix coverage status                      |
| `historyLength`             | Total `reviewHistory` length                                      |
| `signature`                 | Stable hash over open CRIT/HIGH findings (for loop detection)     |
| `snapshotAt`                | Timestamp                                                         |

Read with:

```bash
swamp model method run <issue-name> hydrate
swamp data get <issue-name> hydrate --json
```

`hydrate()` is idempotent and read-only with respect to `current` — calling it
never mutates the lifecycle state.
