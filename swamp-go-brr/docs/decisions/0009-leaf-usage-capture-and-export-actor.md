---
issue: gobrr-observability
date: 2026-06-18
kind: decision
---

# Per-leaf usage is agent-declared; the OTLP push is a side-effectful model

## Context

The human wanted real per-leaf **cost, tokens, and time**, and the OTLP data
actually shipped to a backend (Honeycomb or VictoriaMetrics). `claude --print`
emits usage only with `--output-format json`. gobrr is pure (no network), and
inline-loop.md forbids side effects in the driver ("side-effects live in models,
never a bespoke script").

## Decision

1. **Opt-in JSON leaf output.** The firecracker fabric `submit` gains an
   optional `outputFormat` (default `text`, byte-identical to the old path). In
   `json` mode the runner uses `claude --print --output-format json` with NO
   `2>&1` merge and NO `ERROR:` prefix (either would corrupt the JSON). A
   version floor is pinned in concurrency.md; an old fabric simply returns text
   and usage is absent (graceful).

2. **source-integration owns the untrusted parse.** `extractLeafJson` size-caps
   BEFORE `JSON.parse`, maps `is_error` / non-zero exit → `claude_error` BEFORE
   the envelope parse (the SINGLE `claude_error` site for text AND json — so
   stall/retry semantics are unchanged), extracts `.result` for the unchanged
   `@@EDIT` parse, and returns range-validated declared usage. This is the right
   home: it already safely parses leaf stdout with caps + scrub.

3. **Provenance (ADR 0001/0005).** claude's tokens/cost are AGENT-DECLARED —
   stored as `leafDeclared` and emitted under `leaf.declared.*`, NEVER read by
   `next()`/halt. The leaf wall-clock the loop measures is HOST truth under
   `leaf.host.duration_ms`.

4. **Export is a new side-effectful model.** `@magistr/swamp-go-brr/otlp-export`
   (`export_run`) is the ONLY network egress: it POSTs the derived `traceOtlp`/
   `metricsOtlp` over OTLP/HTTP (https only) to an endpoint+token passed as
   GLOBAL ARGS the workflow wires from a vault CEL. It never resolves vault
   itself, never persists/ logs the resolved URL or key (only a
   userinfo/query-stripped host), and is best-effort (typed
   `{status: ok|skipped|error}`, never throws/aborts the run).

## Consequences

- gobrr stays pure; the side effect lives in a model (honors inline-loop.md).
  This adds a 5th model — a deliberate, human-approved reversal of the original
  "no new model".
- Two extensions ship together (firecracker fabric + swamp-go-brr),
  version-bumped in lockstep; the fabric JSON mode releases first.
- In-guest (inside-microVM) sub-spans and traceparent propagation INTO the leaf
  remain non-goals (no in-VM consumer today) — separate follow-ups.
