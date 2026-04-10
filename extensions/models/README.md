# @magistr/issue-lifecycle

A swamp extension model that drives an issue through its full lifecycle — from
filing through triage, planning, review, implementation, code review,
resolution, optional knowledge harvest, and completion. Designed to be driven by
the `issue-lifecycle` Claude Code skill in this repo.

## Install

```bash
swamp extension pull @magistr/issue-lifecycle
```

## States

```
filed → triaged → planned → reviewing → approved → implementing →
code_reviewing → resolved → (harvested →)? complete
```

Any state can transition to `closed` via the `close` method.

## Methods

| Method             | Transition                                      |
| ------------------ | ----------------------------------------------- |
| `start`            | → `filed`                                       |
| `triage`           | `filed` → `triaged`                             |
| `record_prior_art` | `triaged` \| `planned` (no transition)          |
| `plan`             | `triaged` \| `planned` → `planned`              |
| `review_plan`      | `planned` → `reviewing`                         |
| `record_review`    | `reviewing` \| `code_reviewing` (no transition) |
| `approve_plan`     | `reviewing` → `approved` (gated)                |
| `reject_plan`      | `reviewing` → `planned`                         |
| `implement`        | `approved` → `implementing`                     |
| `review_code`      | `implementing` → `code_reviewing`               |
| `resolve_findings` | `code_reviewing` → `resolved`                   |
| `iterate`          | `resolved` \| `code_reviewing` → `implementing` |
| `harvest`          | `resolved` → `harvested`                        |
| `complete`         | `resolved` \| `harvested` → `complete`          |
| `close`            | any → `closed`                                  |
| `hydrate`          | any (no transition, writes summary)             |

## Approval gate

`approve_plan` requires **all** of:

1. Every reviewer listed in the plan's `reviewMatrix` has recorded a
   `ReviewResult` for the current round.
2. Zero open `CRITICAL` findings across all reviews.
3. Zero open `HIGH` findings across all reviews.

## Development

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

## Related

- Claude skill:
  [`.claude/skills/issue-lifecycle/SKILL.md`](../../.claude/skills/issue-lifecycle/SKILL.md)
- State machine diagram:
  [`.claude/skills/issue-lifecycle/references/state-machine.md`](../../.claude/skills/issue-lifecycle/references/state-machine.md)
- Review matrix rules:
  [`.claude/skills/issue-lifecycle/references/review-matrix.md`](../../.claude/skills/issue-lifecycle/references/review-matrix.md)
