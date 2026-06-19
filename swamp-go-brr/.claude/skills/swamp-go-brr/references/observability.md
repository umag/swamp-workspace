# Observability (OTLP traces + per-leaf cost/tokens/time)

Scope: this covers the OBSERVABILITY wiring only — per-leaf usage capture,
gobrr's derived OTLP resources, and the OTLP push. The core loop lives in
[inline-loop.md](inline-loop.md). Issue `gobrr-observability` (ADR 0008 + 0009).

## 1. Capture per-leaf usage (opt-in)

Submit leaves with `outputFormat: "json"` so the worker runs
`claude --print --output-format json` and the result carries `usage`,
`total_cost_usd`, `duration_ms`. Requires the firecracker JSON-mode floor — see
[concurrency.md](concurrency.md). An older fabric returns plain text → usage is
simply absent (the run still works).

`source-integration apply` is JSON-aware: it size-caps, maps `is_error` →
`claude_error` (the single claude-error site for text + json), parses `.result`
as the usual `@@EDIT` envelope, and returns range-validated declared usage. The
loop measures the leaf wall-clock itself (host truth) and passes both to
`report` audit:

```
report --input taskId=… --input owner=… --input verifyExitCode=… \
  --input-file audit.yaml   # audit: { invocationSpanId, hostDurationMs, leafDeclared }
```

PROVENANCE: claude's `usage`/`total_cost_usd` are AGENT-DECLARED →
`leaf.declared.*`, never a gate input. The loop-measured wall-clock is HOST
truth → `leaf.host.duration_ms`.

## 2. Derive the OTLP resources (pure, in gobrr)

```
swamp model method run <run> emit_otlp
swamp data get <run> traceOtlp   --json | jq -r .content.status   # ok|unavailable|empty|partial
swamp data get <run> traceOtlp   --json | jq   .content.resourceSpans
swamp data get <run> metricsOtlp --json | jq   .content.resourceMetrics
```

`traceOtlp` is the run→task→invocation span tree (per-leaf tokens/cost/time on
the invocation span). `metricsOtlp` is per-gate leaf
token/cost/duration/invocation sums (numeric; labels restricted to the
`METRIC_LABELS` allowlist — no free text). A spanId-less (pre-feature) task is
suppressed whole, never orphaned.

## 3. Export (the loop's ONLY network push)

Export is a model-method call — NOT inline driver code (honors the inline-loop
side-effects-live-in-models rule). `@magistr/swamp-go-brr/otlp-export`:

```
swamp model method run <exporter> export_run    # endpoint+token are global args (vault CEL)
swamp data get <exporter> exportStatus --json | jq -r .content.status   # ok|skipped|error
```

The endpoint (https only) + bearer token come from a vault CEL the workflow
wires; the exporter never stores/logs the resolved URL or key, and a failed push
records a typed status without aborting the run. The OTLP is vendor-neutral —
point it at Honeycomb or an OTLP collector in front of VictoriaMetrics.

Non-goals (separate follow-ups): in-guest sub-spans from inside the microVM, and
W3C traceparent propagation INTO the leaf (no in-VM consumer today).
