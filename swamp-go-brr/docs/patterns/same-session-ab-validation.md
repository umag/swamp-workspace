---
issue: gobrr-envelope-format-hardening
date: 2026-06-17
kind: pattern
---

# Validate a prompt/behaviour change with a SAME-SESSION old-vs-new A/B

When checking whether a change to a non-deterministic actor (a leaf prompt, a
model/effort setting) improves a measurable rate (e.g. `envelope_parse`
failures, gate pass-rate):

- Run the **old and new versions in the SAME session** — same fabric pool, same
  `leafModel`/`leafEffort`, same fixture, interleaved. **Never** compare the new
  run against a rate **recorded in a prior session**: fabric warmth, model
  routing, and sampling variance differ across sessions and confound the delta.
- Derive the OLD artifact **deterministically from the NEW** so they differ by
  ONLY the change under test (e.g. strip the exact added prompt lines; assert
  the strip target exists before relying on it).
- Concentrate the fixture on the tasks where the failure was actually observed,
  not an easy set that saturates both arms.
- Define "not worse" against the **same-session** old rate, not a remembered
  number.

## Why — it changed the conclusion

The envelope-format hardening looked **marginal** through the desired-state
pilots: those were cross-session, N=5 per cell, and the dropped-`@@ENDEDIT`
failures read as "balanced across framings, non-terminal." A dedicated
same-session old-vs-new spot-check (60 leaves, hard fixture) instead measured
`envelope_parse` failures falling from **6/30 (80% parse-success)** on the old
prompt to **0/30 (100%)** on the hardened prompt — a clear win the cross-session
view had hidden. Same-session isolation is what surfaced the real effect.

See [eval-gated-policy-constant](eval-gated-policy-constant.md) for the adoption
side and `tests/eval/workorder-framing/README.md` for the run recipe.
