---
issue: gobrr-desired-state-workorders
date: 2026-06-17
kind: pattern
---

# Ship a behaviour change behind a selected-policy constant, flip it on an eval

When a new behaviour variant must be PROVEN superior before adoption:

- Express both variants inside ONE pure function parameterised by a policy value
  (e.g. `buildWorkorderPrompt(framing)`).
- Select the shipped variant with a module CONSTANT (`WORKORDER_FRAMING`), NOT a
  runtime method argument — keeps the public contract unchanged, avoids a
  runtime dual-path, and (for gobrr) keeps the gate independent of the leaf.
- Default the constant to the OLD behaviour, pinned byte-identical by a
  regression test, so merging the change is a no-op until adoption.
- Gate the flip on an eval: deterministic CI checks for well-formedness PLUS a
  human-signed-off live A/B with a stated criterion, recorded in an ADR.
- On adoption: flip the constant, then COLLAPSE the function to the single
  chosen path (remove the losing branch + the policy parameter) so no dual-path
  calcifies.

The eval drives the pure function directly with both variants; production never
carries a speculative runtime selector. See the rejected alternative in
[anti/runtime-policy-method-arg](anti/runtime-policy-method-arg.md) and the
extraction-pinning companion in
[byte-identity-extraction-golden](byte-identity-extraction-golden.md).
