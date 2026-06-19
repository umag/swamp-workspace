// RED-phase tests for lib/otlp.ts — the pure OTLP/JSON serializer + W3C id
// helpers + the authoritative attribute scrub. lib/otlp.ts imports ONLY stdlib +
// lib/scrub.ts (cycle-free); it is the unconditional last-line scrub site for
// every span/metric string attribute. Issue gobrr-observability.
// Run: /home/zeroclaw/.swamp/deno/deno test extensions/models/lib/otlp.test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isSpanId,
  isTraceId,
  METRIC_LABELS,
  newSpanId,
  newTraceId,
  type OtlpMetricInput,
  type OtlpTraceInput,
  serializeMetrics,
  serializeTrace,
} from "./otlp.ts";

// dig the spans array out of a serialized OTLP doc without `any`.
function spansOf(out: Record<string, unknown>): Array<Record<string, unknown>> {
  const rs = (out.resourceSpans as Array<Record<string, unknown>>)[0];
  const ss = (rs.scopeSpans as Array<Record<string, unknown>>)[0];
  return ss.spans as Array<Record<string, unknown>>;
}

// ── W3C id helpers ──────────────────────────────────────────────────────────

Deno.test("newTraceId is 32 lowercase hex and validates", () => {
  const id = newTraceId();
  assert(/^[0-9a-f]{32}$/.test(id), `bad traceId: ${id}`);
  assert(isTraceId(id));
});

Deno.test("newSpanId is 16 lowercase hex and validates", () => {
  const id = newSpanId();
  assert(/^[0-9a-f]{16}$/.test(id), `bad spanId: ${id}`);
  assert(isSpanId(id));
});

Deno.test("id generators are unique across calls", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newTraceId()));
  assertEquals(ids.size, 50);
});

Deno.test("isTraceId/isSpanId reject wrong width, uppercase, empty", () => {
  assert(!isTraceId(""));
  assert(!isTraceId("ABCDEF0123456789abcdef0123456789")); // uppercase
  assert(!isTraceId("dead")); // too short
  assert(!isSpanId("")); // empty must never pass (no sentinel)
  assert(!isSpanId("0".repeat(32))); // span id is 16, not 32
});

// ── serializeTrace: structure + linkage + status + scrub ─────────────────────

function traceInput(): OtlpTraceInput {
  return {
    traceId: "a".repeat(32),
    serviceName: "swamp-go-brr",
    spans: [
      {
        spanId: "1".repeat(16),
        name: "run",
        startUnixNano: "1000",
        endUnixNano: "2000",
        status: "ok",
        attributes: { "gobrr.invocations": 3 },
      },
      {
        spanId: "2".repeat(16),
        parentSpanId: "1".repeat(16),
        name: "task t1",
        startUnixNano: "1100",
        endUnixNano: "1900",
        status: "error",
        attributes: { "task.gate": "real", "task.attempts": 2 },
      },
    ],
  };
}

Deno.test("serializeTrace emits resourceSpans->scopeSpans->spans with the traceId on every span", () => {
  const out = serializeTrace(traceInput()) as Record<string, unknown>;
  const rs = (out.resourceSpans as unknown[])[0] as Record<string, unknown>;
  const scope = (rs.scopeSpans as unknown[])[0] as Record<string, unknown>;
  const spans = scope.spans as Array<Record<string, unknown>>;
  assertEquals(spans.length, 2);
  for (const s of spans) assertEquals(s.traceId, "a".repeat(32));
});

Deno.test("serializeTrace preserves parent->child linkage and omits parentSpanId on the root", () => {
  const out = serializeTrace(traceInput()) as Record<string, unknown>;
  const spans = spansOf(out);
  const root = spans.find((s) => s.spanId === "1".repeat(16))!;
  const child = spans.find((s) => s.spanId === "2".repeat(16))!;
  assert(!("parentSpanId" in root) || root.parentSpanId === undefined);
  assertEquals(child.parentSpanId, "1".repeat(16));
});

Deno.test("serializeTrace maps status ok->1 error->2 unset->0 (OTLP STATUS_CODE)", () => {
  const out = serializeTrace(traceInput()) as Record<string, unknown>;
  const spans = spansOf(out);
  const root = spans.find((s) => s.spanId === "1".repeat(16))!;
  const child = spans.find((s) => s.spanId === "2".repeat(16))!;
  assertEquals((root.status as Record<string, unknown>).code, 1);
  assertEquals((child.status as Record<string, unknown>).code, 2);
});

Deno.test("serializeTrace encodes int vs string attribute values per OTLP", () => {
  const out = serializeTrace(traceInput()) as Record<string, unknown>;
  const spans = spansOf(out);
  const child = spans.find((s) => s.spanId === "2".repeat(16))!;
  const attrs = child.attributes as Array<
    { key: string; value: Record<string, unknown> }
  >;
  const gate = attrs.find((a) => a.key === "task.gate")!;
  const attempts = attrs.find((a) => a.key === "task.attempts")!;
  assertEquals(gate.value.stringValue, "real");
  assertEquals(attempts.value.intValue, "2"); // OTLP ints are stringified
});

Deno.test("serializeTrace SCRUBS secret-shaped string attributes unconditionally (authoritative site)", () => {
  const input = traceInput();
  input.spans[1].attributes["leaf.spec"] = "deploy with token=abc12345secret";
  input.spans[1].name = "task sk-ant-abcdef123456 run";
  const out = JSON.stringify(serializeTrace(input));
  assert(!out.includes("abc12345secret"), "secret value leaked into attribute");
  assert(!out.includes("sk-ant-abcdef123456"), "secret leaked into span name");
  // The contract here is that the secret VALUES are absent; the redaction marker
  // itself is owned by lib/scrub.test.ts, so we deliberately do not couple to it.
});

// ── serializeMetrics: label allowlist + numeric encoding ─────────────────────

Deno.test("METRIC_LABELS is a closed allowlist (no free-text labels like spec/intake/path)", () => {
  for (const bad of ["spec", "intake", "path", "diff"]) {
    assert(
      !(METRIC_LABELS as readonly string[]).includes(bad),
      `free-text label ${bad} must not be allowed`,
    );
  }
  assert((METRIC_LABELS as readonly string[]).includes("gate"));
});

Deno.test("serializeMetrics rejects a point label outside METRIC_LABELS", () => {
  const input: OtlpMetricInput = {
    serviceName: "swamp-go-brr",
    metrics: [{
      name: "gobrr.leaf.tokens",
      kind: "sum",
      points: [{ attributes: { spec: "leaked!" }, value: 5 }],
    }],
  };
  let threw = false;
  try {
    serializeMetrics(input);
  } catch {
    threw = true;
  }
  assert(threw, "serializeMetrics must reject a non-allowlisted label key");
});

Deno.test("serializeMetrics emits resourceMetrics with allowlisted labels", () => {
  const input: OtlpMetricInput = {
    serviceName: "swamp-go-brr",
    metrics: [{
      name: "gobrr.leaf.cost_usd",
      unit: "USD",
      kind: "sum",
      points: [{ attributes: { gate: "real" }, value: 0.42 }],
    }],
  };
  const out = serializeMetrics(input) as Record<string, unknown>;
  assert(Array.isArray(out.resourceMetrics));
  assert((out.resourceMetrics as unknown[]).length === 1);
});
