---
kind: anti-pattern
issue: tdd-subcycle-doc-drift
date: 2026-06-12
---

# Anti-pattern: shipping a state-machine change without syncing the skill docs

Case study from this repo. `2026.04.30.5` added the TDD test-review sub-cycle to
the model
(`approved → writing_tests ↔ reviewing_tests →
[tests_approved] → implementing`)
with correct guards and full test coverage — and updated only README.md and the
manifest description. None of the 9 bundled skills mentioned the new states or
methods.

Consequence chain (observed in production use, 2026-06):

1. Agents follow `SKILL.md`'s phase table and `implementation.md`, which still
   described `approved → implementing` with interleaved red-green-refactor — so
   they wrote implementation code while the model sat in `writing_tests`.
2. The model's guard rejected the next documented step (`review_code` from
   `writing_tests`), and agents "recovered" by discovering
   `review_tests`/`tests_approved` from the error message — rubber-stamping the
   test review _after_ all code existed.
3. A later skills-only release (`2026.05.24.1`) rewrote the very section that
   needed the sub-cycle, deepening the contradiction — because nothing failed
   when docs and model disagreed.

The damage is worse than missing docs: **stale process docs actively train
agents to bypass the new machine**, and the model's guards convert the gate into
a post-hoc formality rather than stopping the violation.

Rule: a PR that changes `StateEnum`, a method guard, or a transition MUST touch
the corresponding skill references in the same commit — and the drift-guard
contract test (see `kb/pattern-doc-drift-guard.md`) enforces exactly that
mechanically. Fixed in `2026.06.12.1`.
