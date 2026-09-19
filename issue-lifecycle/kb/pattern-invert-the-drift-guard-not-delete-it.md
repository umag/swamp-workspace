---
kind: pattern
issue: il-drop-test-phase
date: 2026-09-20
---

# Pattern: invert a drift-guard when removing a phase, don't delete it

When you remove a lifecycle phase whose presence a contract test asserts
(`issue_lifecycle_docs.test.ts` required the TDD sub-cycle in the skill docs),
do **not** delete the assertions — rewrite them to pin the phase's **absence**.

The docs drift-guard has two layers, and they behave differently under a
removal:

- **Layer 2** enumerates `StateEnum.options` and `Object.keys(model.methods)`
  dynamically and requires each to be backtick-documented. It **self-adjusts** —
  a removed state/method simply stops being required. Leave it alone.
- **Layer 1** hardcodes tokens (`tests_approved`, `writing_tests`, the
  `record_review` guard row). On removal every one of these **inverts**: replace
  "must contain X" with "must NOT contain X". A shared `REMOVED_PHASE_TOKENS`
  list checked against SKILL.md / implementation.md / autonomous-loop.md keeps
  the phase from silently creeping back into the docs later.

Deleting the guard instead leaves nothing stopping a future edit (or a doc
regeneration) from re-teaching the removed phase to agents while the model no
longer supports it — the exact drift class
[[anti-pattern-model-change-without-skill-sync]] warns about, in reverse.
