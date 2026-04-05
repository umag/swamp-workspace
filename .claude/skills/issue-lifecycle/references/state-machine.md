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
                         │ plan()
                    ┌────▼────┐
              ┌─────│ planned │◄───────────────┐
              │     └────┬────┘                 │
              │          │ review_plan()         │
              │     ┌────▼──────┐               │
              │     │ reviewing │               │
              │     └────┬──────┘               │
              │          │ approve_plan()        │
              │     ┌────▼────────┐ reject()    │
              │     │  approved   │─────────────┘
              │     └────┬────────┘
              │          │ implement()
              │     ┌────▼──────────┐
              │     │ implementing  │◄──────────┐
              │     └────┬──────────┘            │
              │          │ review_code()          │
              │     ┌────▼─────────────┐         │
              │     │ code_reviewing   │         │
              │     └────┬─────────────┘         │
              │          │ resolve_findings()     │
              │     ┌────▼────────┐  iterate()   │
              │     │  resolved   │──────────────┘
              │     └────┬────────┘
              │          │ complete()
              │     ┌────▼────────┐
              │     │  complete   │
              │     └─────────────┘
              │
              │ close() (from any state)
              │     ┌──────────┐
              └────►│  closed  │
                    └──────────┘
```

## Transition Guards

| Method | Guard | Error if violated |
|--------|-------|-------------------|
| `triage` | state == `filed` | "Cannot triage: issue not in filed state" |
| `plan` | state in [`triaged`, `planned`] | "Cannot plan: triage first" |
| `review_plan` | state == `planned` | "Cannot review: plan first" |
| `record_review` | state in [`reviewing`, `code_reviewing`] | "Not in review phase" |
| `approve_plan` | state == `reviewing` AND no unresolved CRITICAL | "Cannot approve: CRITICAL findings" |
| `reject_plan` | state == `reviewing` | "Not in reviewing state" |
| `implement` | state == `approved` | "Plan not approved" |
| `review_code` | state == `implementing` | "Not in implementing state" |
| `resolve_findings` | state == `code_reviewing` | "Not in code review" |
| `iterate` | state == `resolved` | "Not in resolved state" |
| `complete` | state == `resolved` | "Not in resolved state" |
| `close` | (any) | (no guard) |

## State Fields

| Field | Set By | Description |
|-------|--------|-------------|
| `state` | Every method | Current lifecycle state |
| `title`, `description` | `start` | Issue basics |
| `priority`, `category` | `triage` | Triage classification |
| `affectedAreas` | `triage` | Which parts of codebase affected |
| `plan` | `plan` | Implementation plan with DDD + TDD + reviewMatrix |
| `reviews` | `record_review` | Array of review results from skills |
| `branch` | `implement` | Git branch name |
| `resolutions` | `resolve_findings` | Map of finding → resolution |
| `completedAt` | `complete` | Completion timestamp |
| `closedReason` | `close` | Why the issue was abandoned |
