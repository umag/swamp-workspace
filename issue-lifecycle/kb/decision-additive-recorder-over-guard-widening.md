---
kind: decision
issue: triage-recall-doc-bug
date: 2026-06-12
---

# Decision: prefer additive recorder methods over guard widening

When a documented flow needs to write one more piece of data to an
already-transitioned aggregate, add a dedicated optional recorder method — do
not widen an existing command's guard to allow re-calls.

Case: `triage.md` documented recording the bug reproduction by re-calling
`triage`, but the guard is single-shot. Three fixes were planned and reviewed in
sequence:

1. **Guard widening + replace-wholesale** — rejected in review: a re-call
   without the optional detail args silently wiped previously recorded
   `triageDetail` (data loss; knowledge-harvest reads `reproduced.notes`
   downstream).
2. **Guard widening + merge semantics** — passed review, but drags in merge-rule
   complexity (nullish carryover per field, the `clarifyingQuestions`
   omitted-vs-empty ambiguity from zod defaults) and incidentally makes the
   whole classification mutable after triage.
3. **Additive recorder (`record_reproduction`)** — chosen (human call at the
   gate). Mirrors `record_prior_art`: guard `[triaged, planned]`,
   state-preserving, touches exactly one field, second call overwrites.

Why the recorder wins:

- **Invariants stay intact** — classification remains single-shot and frozen at
  triage; the new method cannot perturb it by construction.
- **No merge-semantics surface** — one field, replace-on-recall, no carryover
  rules to document or test.
- **The drift-guard enforces documentation automatically** — its runtime
  enumeration of `model.methods` fails the suite until the new method is
  documented in state-machine.md ([[pattern-doc-drift-guard]]); guard widenings
  change a table cell the sweep cannot check.
- **One method, one purpose** — matches the repo's extension rule and the
  existing recorder precedent.

Cost: +1 method on the API surface and synced manifest/README lists — cheap next
to merge-rule maintenance.

Related: `kb/decision-tests-approved-autonomous-gate.md` (gate semantics),
`kb/anti-pattern-model-change-without-skill-sync.md` (same-commit doc rule,
honored here).
