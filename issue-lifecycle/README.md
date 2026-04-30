# Issue Lifecycle Extension Model

The `@magistr/issue-lifecycle` extension model drives issues from filing through
completion with DDD analysis, TDD strategy, parallel review fan-out, autonomous
code-review iteration, and optional knowledge harvest. State persists across
sessions so you can walk away and resume later.

Bundled with 9 Claude Code skills that provide the full development workflow:
planning with domain-driven design, test-driven development, moldable
inspection, and five parallel review skills.

## State Machine

```
filed ──[triage]──> triaged
triaged ──[plan]──> planned
planned ──[review_plan]──> reviewing
reviewing ──[approve_plan]──> approved
reviewing ──[reject_plan]──> planned  (feedback loop)
approved ──[implement]──> implementing
implementing ──[review_code]──> code_reviewing
code_reviewing ──[resolve_findings]──> resolved
code_reviewing ──[iterate]──> implementing  (autonomous loop)
resolved ──[iterate]──> implementing
resolved ──[harvest]──> harvested  (optional)
resolved ──[complete]──> complete
harvested ──[complete]──> complete
```

`approve_plan` requires full matrix coverage AND zero open CRITICAL AND zero
open HIGH findings. `close` works from any state. `hydrate` reads from any state
without mutating it.

## Using with Claude Code (recommended)

Tell Claude:

```
triage issue #42 and plan the fix
```

The `issue-lifecycle` skill takes over. Claude creates the model instance,
investigates with moldable-dev, triages, records prior art, generates a plan
with DDD analysis and TDD strategy, fans out review skills in parallel, and
shows you the aggregated findings.

From there it's a conversation: approve, reject, iterate on code review
autonomously (with loop-safety guards), harvest learnings, and complete.

## Using via CLI (manual mode)

### Setup

```bash
swamp extension pull @magistr/issue-lifecycle
swamp model create @magistr/issue-lifecycle issue-42
```

### Triage

```bash
swamp model method run issue-42 start \
  --input title="Fix retry jitter" \
  --input description="Retries lack jitter, causing thundering herd" --json

swamp model method run issue-42 triage \
  --input priority=high \
  --input category=bug \
  --input affectedAreas='["extensions/models"]' \
  --input confidence=high \
  --input reasoning="Reproduced in three environments" --json

swamp model method run issue-42 record_prior_art \
  --input uatScenarios='[]' \
  --input kbEntries='[]' --json
```

### Planning

```bash
swamp model method run issue-42 plan --input-file plan.yaml --json
swamp model method run issue-42 review_plan --json
```

### Review and approval

```bash
# Record each reviewer's findings
swamp model method run issue-42 record_review --input-file review-code.yaml --json
swamp model method run issue-42 record_review --input-file review-adversarial.yaml --json

# Approve (or reject)
swamp model method run issue-42 approve_plan --json
swamp model method run issue-42 reject_plan --input reason="..." --input source=human --json
```

### Implementation

```bash
swamp model method run issue-42 implement --input branch=feat/retry-jitter --json
swamp model method run issue-42 review_code --json

# Record code review findings, then resolve or iterate
swamp model method run issue-42 resolve_findings --input resolutions='{}' --json
swamp model method run issue-42 iterate --input reason="..." --input source=auto --json
```

### Harvest and complete

```bash
swamp model method run issue-42 harvest --input-file harvest.yaml --json
swamp model method run issue-42 complete --json
```

### Inspection

```bash
# Full state
swamp model get issue-42 --json
swamp data get issue-42 current --json

# Cheap summary for autonomous loops
swamp model method run issue-42 hydrate --json
swamp data get issue-42 hydrate --json
```

## Methods

| Method             | Description                                 | State Transition                               |
| ------------------ | ------------------------------------------- | ---------------------------------------------- |
| `start`            | File a new issue                            | -> `filed`                                     |
| `triage`           | Classify with optional detail               | `filed` -> `triaged`                           |
| `record_prior_art` | Record existing UAT/KB entries              | no change                                      |
| `plan`             | Create/revise plan (bumps planVersion)      | `triaged`\|`planned` -> `planned`              |
| `review_plan`      | Enter plan review phase                     | `planned` -> `reviewing`                       |
| `record_review`    | Record one reviewer's findings              | no change                                      |
| `approve_plan`     | Approve (gated on coverage + zero blocking) | `reviewing` -> `approved`                      |
| `reject_plan`      | Reject with auto/human source               | `reviewing` -> `planned`                       |
| `implement`        | Start coding on a branch                    | `approved` -> `implementing`                   |
| `review_code`      | Enter code review phase                     | `implementing` -> `code_reviewing`             |
| `resolve_findings` | Record resolutions, snapshot round          | `code_reviewing` -> `resolved`                 |
| `iterate`          | Return to implementation                    | `resolved`\|`code_reviewing` -> `implementing` |
| `harvest`          | Record UAT/KB improvement proposals         | `resolved` -> `harvested`                      |
| `complete`         | Mark done                                   | `resolved`\|`harvested` -> `complete`          |
| `close`            | Abandon from any state                      | any -> `closed`                                |
| `hydrate`          | Write compact summary (no state mutation)   | no change                                      |

## Data stored

| Resource  | What it stores                                                                  |
| --------- | ------------------------------------------------------------------------------- |
| `state`   | Full lifecycle state: phase, plan, reviews, reviewHistory, harvest, resolutions |
| `summary` | Compact hydrate snapshot: state, blocking counts, coverage, iteration cursors   |

## Approval gate

`approve_plan` enforces all three conditions:

1. Every reviewer listed in `reviewMatrix` has recorded a `ReviewResult`
2. Zero open `CRITICAL` findings
3. Zero open `HIGH` findings

## Bundled skills

| Skill                | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `issue-lifecycle`    | Orchestrates the full lifecycle (this model's driver skill) |
| `ddd`                | Domain-driven design building block selection               |
| `tdd`                | Red-green-refactor workflow enforcement                     |
| `moldable-dev`       | Contextual inspectors, live-data queries, reusable reports  |
| `review-code`        | General code review (types, imports, architecture, tests)   |
| `review-adversarial` | Adversarial review across 7 dimensions                      |
| `review-security`    | OWASP-adapted security audit                                |
| `review-ux`          | CLI output, help text, error message review                 |
| `review-skill`       | Skill quality review (frontmatter, triggers, budget)        |

Each skill ships `evals/trigger_evals.json` for CI routing tests via promptfoo.

## Development

```bash
# Extension tests
cd extensions/models
deno fmt --check
deno lint
deno check issue_lifecycle.ts issue_lifecycle.test.ts
deno test issue_lifecycle.test.ts

# Skill routing evals
deno run --allow-read --allow-write scripts/build-promptfoo-tests.ts
npx promptfoo eval -c promptfoo.generated.yaml
```

## Publishing

```bash
# Check next version
swamp extension version --manifest manifest.yaml --json

# Dry run
swamp extension push manifest.yaml --dry-run

# Push
swamp extension push manifest.yaml --yes
```
