# Knowledge Harvest: Payment Idempotency Fix

## Problem/Feature Description

The payments team just wrapped up a critical bug fix — a regression where retried payment requests were causing duplicate charges. The full lifecycle ran to completion: the issue was triaged, a plan was written, reviewed, and approved, the code was implemented and code-reviewed, and the findings have now been resolved. The lifecycle is in `resolved` state.

Before calling `complete`, the team lead wants to run the knowledge harvest step to capture what was learned during this lifecycle — both as new UAT scenarios that protect against future regressions, and as knowledge base entries that document the design decisions and near-misses discovered during review.

The complete lifecycle state is in `inputs/lifecycle-state.json`. Use it to produce the harvest artifacts. The repository does not have `agent-constraints/uat-conventions.md` or `agent-constraints/knowledge-base.md`, so fall back to standard defaults.

## Output Specification

Produce the following files:

1. **`uat-proposals.md`** — UAT scenario proposals based on what was learned during this lifecycle. Each proposal should include a rationale (citing the specific finding or lifecycle artifact that motivated it), a destination path in the test suite, and the scenario itself.

2. **`kb-proposals.md`** — Knowledge base entry proposals capturing design decisions, patterns discovered, and lessons learned. Each proposal should include its category, a rationale, a destination path, and the full body of the proposed entry in the team's KB format.

3. **`harvest.yaml`** — The YAML file that would be passed to the harvest model method to record the full set of proposals. Include all proposals whether or not you recommend they be committed immediately.

Do not leave large files on disk.
