---
kind: decision
issue: il-drop-test-phase
date: 2026-09-20
---

# Decision: a state-machine contraction cannot be migrated via `upgrades[]`

swamp's `upgradeAttributes(old) => new` transforms a model's **`globalArguments`
only** — it never touches resource records (`state.current` and friends). See
the swamp skill `references/extension/references/model/upgrades.md`: "each
[upgrade] transforming `globalArguments`".

Consequence for `@magistr/issue-lifecycle`, whose `globalArguments` is
`z.object({})` (empty): removing a `StateEnum` value (here `writing_tests` /
`reviewing_tests`) **cannot** be auto-migrated for an in-flight instance via
`upgrades[]`. An instance persisted in a removed state would fail
`IssueStateSchema.parse` on its next read.

What actually works:

- A no-op `upgrades[]` entry is **still mandatory** — the rule is that the last
  upgrade's `toVersion` must equal the model `version`, and it bumps
  `typeVersion` on existing instances.
- Zod strips an unknown key (e.g. the removed `testReviewIteration`) from an old
  record on read automatically — dropping a **field** needs no migration.
- To protect an instance parked in a removed **state**, coerce it inside
  `readState()` (the read path), not in `upgradeAttributes`. If the removed
  states are transient and no parked instance is expected, accept the risk
  explicitly rather than adding a shim
  ([[feedback_no_needless_backward_compat]]).

Related: [[anti-pattern-model-change-without-skill-sync]].
