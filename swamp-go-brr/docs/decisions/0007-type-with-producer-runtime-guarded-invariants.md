---
issue: si-applied-result-typing
date: 2026-06-18
kind: decision
---

# Type a result with its producer; guard cross-actor invariants at runtime

## Context

`source-integration.apply()` writes a per-task result into the `applied`
resource; the agent driver reads it and assembles a `WorkResult` for
`gobrr.report()`. The result was typed `z.record(string, z.unknown())` — opaque.
Issue `si-applied-result-typing` set out to type it so the host-observed-vs-
agent-declared `changedPaths` provenance was "checked, not by convention."

## Decision

1. **The type lives with its producer.** `AppliedTaskResult` is `apply()`'s
   output. `gobrr` never reads the `applied` resource (grep-verified: zero
   references) — the agent driver does. So the schema belongs in
   `source_integration.ts`, not `gobrr.ts`. Co-locating a type "near a related
   type" in a module that does not consume it inverts the dependency for no
   gain. (Contrast `EnvelopeSummary`, which lives in `gobrr.ts` precisely
   because `gobrr.report()` consumes it.)

2. **The cycle rationale was empty.** Imports are already one-directional
   (`source_integration` imports from `gobrr`, never the reverse). A new schema
   in `source_integration.ts` that value-imports `EnvelopeSummarySchema` /
   `FailureKindEnum` from `gobrr.ts` adds no cycle.

3. **Provenance is a runtime invariant, not a type.** `changedPaths` (host) and
   `declaredTargetPaths` (declared) are both `string[]`; structural typing
   cannot tell them apart. A nominal brand could — but the "driver" is the agent
   (no in-repo TS call site), so a brand can never bind at the only boundary
   that matters, now or structurally ever. The provenance invariant is therefore
   guarded at RUNTIME by `gobrr.stepOutputProjection` (declared paths absent
   from host-observed `changedPaths` surface as `mismatches`), per ADR 0002/0005
   — not by the type system.

## Consequences

- Typing the result is still worth it: it removes the opaque `unknown`, makes
  the shape self-documenting and validated at write, and (see the sibling
  pattern `type-to-mark-sensitive`) unlocks marking the secret-bearing `diff`
  field sensitive.
- Don't promise compile-time provenance for a value that crosses an agent-driven
  (non-TS) boundary; state plainly that the runtime audit is the guard. Relates
  to `0001-source-integration-host-observed-state` and
  `0002-derive-dont-store-run-projections`.
