---
issue: si-apply-multi-edit-same-file
date: 2026-06-16
kind: decision
---

# source-integration records HOST-OBSERVED state — fix the file, not the state layer

## Context

A leaf could emit multiple `@@EDIT` blocks for one file and `apply` kept only
the last (silent data loss). When framing the fix it was tempting to treat this
as a state-saving bug ("results are not saved correctly when edits touch the
same file").

## Decision

`source-integration.apply` reports `changedPaths` and `diff` from host
observation of `jj diff --git` (`source_integration.ts` ~511-523:
`changedPaths = observed.map((o) => o.path).sort()`), **never** from the agent's
declared blocks or `plan.writes`.

Consequence: any defect in how multiple blocks combine for one file is a defect
in the **produced file**, not in state recording. Fix the pure transform
(`planApply`); do not add same-file dedup logic to the state/report layer. Once
the on-disk file is the cumulative fold, jj reports it exactly once with the
cumulative diff — correctness follows for free.

## Consequences

- A leaf cannot inflate `changedPaths` by emitting extra blocks — jj reports
  what actually changed on disk.
- Relevant to `gobrr-record-step-outputs`: per-step output recording should
  likewise lean on host observation rather than trusting agent-declared paths.
- The multi-block fix lives entirely in `planApply`; the apply write-loop and
  the report layer were unchanged.
