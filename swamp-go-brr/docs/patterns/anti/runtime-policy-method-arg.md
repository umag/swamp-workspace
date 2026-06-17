---
issue: gobrr-desired-state-workorders
date: 2026-06-17
kind: anti-pattern
---

# Don't expose an unproven behaviour variant as a runtime method argument

Plan v1 proposed adding a `framing` argument to the `build_workorder` method
(with zod enum validation) plus a permanent runtime selector branch. Review
rejected it:

- Nothing released depended on a runtime-selectable framing — it was
  backward-compat for UNRELEASED behaviour (scope creep / over-engineering).
- A method argument widens the public contract, and for a leaf prompt it risks
  the selector leaking into the gate's independence.
- A permanent dual-path has no cleanup trigger and calcifies.

Prefer [eval-gated-policy-constant](../eval-gated-policy-constant.md): a module
constant + an eval-gated flip + dual-path collapse on adoption. Reach for a
runtime argument only when a RELEASED consumer genuinely needs to choose at call
time.
