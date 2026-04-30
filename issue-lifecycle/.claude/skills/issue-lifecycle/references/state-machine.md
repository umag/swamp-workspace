# Issue Lifecycle State Machine

## State Diagram

```
                    ┌─────────┐
                    │  filed  │
                    └────┬────┘
                         │ triage()
                    ┌────▼────┐
                    │ triaged │
                    └────┬────┘
                         │ plan() / record_prior_art()
                    ┌────▼────┐
              ┌─────│ planned │◄──────────────────┐
              │     └────┬────┘                    │
              │          │ review_plan()            │
              │     ┌────▼──────┐                  │
              │     │ reviewing │──────────────────┤
              │     └────┬──────┘   reject_plan()  │
              │          │ approve_plan()           │
              │     ┌────▼────────┐                 │
              │     │  approved   │                 │
              │     └────┬────────┘                 │
              │          │ implement()              │
              │     ┌────▼──────────┐               │
              │     │ implementing  │◄──────────┐   │
              │     └────┬──────────┘           │   │
              │          │ review_code()         │   │
              │     ┌────▼─────────────┐         │   │
              │     │ code_reviewing   │─────────┤   │
              │     └────┬─────────────┘ iterate │   │
              │          │                       │   │
              │          │ resolve_findings()     │   │
              │     ┌────▼────────┐               │   │
              │     │  resolved   │───────────────┘   │
              │     └────┬────────┘  iterate()         │
              │          │                              │
              │          ├─► harvest() ──┐              │
              │          │               │              │
              │          │          ┌────▼────────┐     │
              │          │          │  harvested  │     │
              │          │          └────┬────────┘     │
              │          │               │              │
              │          │ complete()    │ complete()   │
              │     ┌────▼───────────────▼──┐           │
              │     │        complete       │           │
              │     └───────────────────────┘           │
              │                                          │
              │ close() from any state                   │
              │     ┌──────────┐                         │
              └────►│  closed  │◄────────────────────────┘
                    └──────────┘

                  hydrate() — any state, no transition
                              (writes compact summary resource)
```

## Transition Guards

| Method             | Guard                                                                                                 | Notes                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`            | no prior state                                                                                        | Creates initial `filed` state                                                                                                                          |
| `triage`           | state == `filed`                                                                                      | Accepts optional `triageDetail` (confidence, reasoning, isRegression, clarifyingQuestions, reproduced)                                                 |
| `record_prior_art` | state in [`triaged`, `planned`]                                                                       | No transition — records UAT/KB refs looked up before planning                                                                                          |
| `plan`             | state in [`triaged`, `planned`]                                                                       | Bumps `planVersion` on re-entry; resets `reviews` but preserves `reviewHistory`                                                                        |
| `review_plan`      | state == `planned`                                                                                    | Sets `reviewRoundStartedAt` for the round                                                                                                              |
| `record_review`    | state in [`reviewing`, `code_reviewing`]                                                              | Accumulates into current `reviews[]`                                                                                                                   |
| `approve_plan`     | state == `reviewing` AND **every** matrix reviewer recorded AND zero open CRITICAL AND zero open HIGH | Snapshots round to `reviewHistory` with `outcome: "clean"`                                                                                             |
| `reject_plan`      | state == `reviewing`                                                                                  | `source: "auto"` → `outcome: "rejected_auto"`; `source: "human"` → `"rejected_human"`. Returns to `planned`                                            |
| `implement`        | state == `approved`                                                                                   | Records branch name                                                                                                                                    |
| `review_code`      | state == `implementing`                                                                               | Resets `reviews` for the new code-review round                                                                                                         |
| `resolve_findings` | state == `code_reviewing`                                                                             | Snapshots round to `reviewHistory` with `outcome: "clean"`                                                                                             |
| `iterate`          | state in [`resolved`, `code_reviewing`]                                                               | From `code_reviewing`, snapshots the round as `rejected_auto`/`rejected_human`. From `resolved`, does NOT double-snapshot. Bumps `codeReviewIteration` |
| `harvest`          | state == `resolved`                                                                                   | Optional — records UAT + KB improvement proposals                                                                                                      |
| `complete`         | state in [`resolved`, `harvested`]                                                                    | Accepts both exit paths                                                                                                                                |
| `close`            | any state                                                                                             | Records `closedReason`                                                                                                                                 |
| `hydrate`          | any state                                                                                             | **No transition** — writes a compact summary to the `summary` resource for the autonomous loop                                                         |

## State Fields

| Field                  | Set By                                                          | Description                                                                                                                                |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`                | Every method                                                    | Current lifecycle state (one of `StateEnum`)                                                                                               |
| `title`, `description` | `start`                                                         | Issue basics                                                                                                                               |
| `labels`               | `start`                                                         | Optional issue labels                                                                                                                      |
| `priority`, `category` | `triage`                                                        | Triage classification                                                                                                                      |
| `affectedAreas`        | `triage`                                                        | Which parts of the codebase are affected                                                                                                   |
| `triageDetail`         | `triage` (optional)                                             | Confidence, reasoning, isRegression, clarifyingQuestions, reproduced status                                                                |
| `priorArt`             | `record_prior_art`                                              | Existing UAT scenarios and KB entries searched before planning                                                                             |
| `plan`                 | `plan`                                                          | Implementation plan with DDD + TDD + reviewMatrix + potentialChallenges + planVersion                                                      |
| `planVersion`          | `plan`                                                          | Monotonic plan counter — bumped on every `plan` call                                                                                       |
| `reviews`              | `record_review`                                                 | Array of review results **for the current round** — reset on `plan`/`review_plan`/`review_code`/`reject_plan`/`iterate`/`resolve_findings` |
| `reviewHistory`        | `approve_plan` / `reject_plan` / `resolve_findings` / `iterate` | Append-only audit — one `ReviewRound` per completed round (plan_review or code_review)                                                     |
| `codeReviewIteration`  | `iterate`                                                       | Monotonic code-review counter — bumped on every `iterate` call                                                                             |
| `reviewRoundStartedAt` | `review_plan` / `review_code`                                   | Cleared on round completion; used for loop timing                                                                                          |
| `branch`               | `implement`                                                     | Git branch name                                                                                                                            |
| `resolutions`          | `resolve_findings`                                              | Map of finding description → resolution action (cumulative across iterations)                                                              |
| `harvest`              | `harvest`                                                       | UAT + KB improvement proposals                                                                                                             |
| `completedAt`          | `complete`                                                      | Completion timestamp                                                                                                                       |
| `closedReason`         | `close`                                                         | Why the issue was abandoned                                                                                                                |
