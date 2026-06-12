---
kind: decision
issue: tdd-subcycle-doc-drift
date: 2026-06-12
---

# Decision: `tests_approved` is the lifecycle's single autonomous acceptance

The issue lifecycle holds "never auto-approve" as a sacred principle:
`approve_plan` (Phase 3) and `resolve_findings` (Phase 5) fire only on an
explicit human trigger phrase. `tests_approved` (Phase 4a) is deliberately the
**one exception** — the skill calls it without human input when the test-review
loop exits clean.

Why this is safe and the others are not:

- The gate is **model-enforced, not skill-enforced**: `tests_approved` itself
  re-checks full matrix coverage AND zero open CRITICAL AND zero open HIGH, and
  throws otherwise. Skill bugs cannot sneak past it.
- The decision it automates is **bounded and mechanical** (are the reviewed
  tests clean?), unlike plan approval (is this the right thing to build?) or
  final acceptance (is the change good enough to ship?) — those carry judgment a
  human must own.
- Stalling at the test gate waiting for a human doubles the human's interrupt
  load for zero risk reduction, which in practice pushed agents to skip the
  sub-cycle entirely — the bug this issue fixed.

Consequences baked into the docs (2026.06.12.1): the Sacred-rule text in
`autonomous-loop.md` names the two human-gated methods and the one exception
explicitly; Core Principle 1 in `SKILL.md` carries the carve-out with a "do not
generalize" clause; the only sanctioned bypass of the blocking-findings check is
`override_reason`, after the `MAX_TEST_ITERATIONS` cap, with explicit human
direction, audited as `human_override` in `reviewHistory`.

Eval coverage: scenario-5 (must fire autonomously on a clean fixture) and
scenario-8 (must refuse and flag CRITICAL when implementation code contaminates
the 4a diff).
