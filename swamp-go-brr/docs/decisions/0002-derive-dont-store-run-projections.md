---
issue: gobrr-trust-ledger
date: 2026-06-16
kind: decision
---

# Derive aggregate projections from the task list, don't store mutated state

## Context

The trust ledger (per-task-type promise-keeping stats) was first designed as
**stored state**: a `trustLedger` field on the Run, mutated in `applyReport` on
each terminal outcome. Review caught a real bug: a task can also reach
`exhausted` via the **scheduler lease-reap path** (`nextDecision`), which never
calls `applyReport` — so the stored ledger would silently miss those broken
promises. The stored design also forced churn in four places (RunSchema, the Run
interface, `start`, and the test factory) plus a schema↔interface bridge risk.

## Decision

Compute trust as a **pure projection derived from `run.tasks` final statuses**
(`trustSummary(run)`), not stored state. The task list is already the single
source of truth; every terminal transition (from `applyReport` AND the scheduler
reap) lands on the task's `status` in `run.tasks`, so a derived scan sees them
all. No stored field, no dual-write, no schema/init/factory change.

## Consequences

- **Eliminates the dual-write class of bug.** Any code path that sets a terminal
  status is automatically reflected — you can't forget to update a second place.
- This is the same principle as `source-integration` reading **host-observed**
  `changedPaths`/`diff` from `jj diff`
  ([0001](0001-source-integration-host-observed-state.md)) rather than trusting
  agent-declared paths: read the source of truth, don't duplicate it.
- General rule: **prefer a derived projection over the aggregate's collection to
  a separately-maintained denormalized field**, unless the projection is
  expensive or the source rows are pruned. (gobrr never removes tasks, so the
  scan is total and cheap.)
- Promise Theory tie-in: trust is the **measured** assessment (gate exit code
  via task status), never asserted/stored ahead of the measurement.
