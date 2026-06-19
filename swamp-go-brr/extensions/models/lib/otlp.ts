// Pure OTLP/JSON serializer + W3C id helpers + the AUTHORITATIVE attribute scrub
// for @magistr/swamp-go-brr observability (issue gobrr-observability). This module
// imports ONLY the standard library + lib/scrub.ts (scrub.ts imports nothing, so no
// cycle) and operates on its OWN plain-object input types — gobrr maps its domain
// structs into these. It NEVER imports gobrr.ts / source_integration.ts, keeping
// lib/ cycle-free. Every string span/metric attribute is scrubbed UNCONDITIONALLY
// here at the serialization boundary (scrub-at-the-storage-boundary), so a caller
// that forgets to scrub cannot leak a secret to the wire.
import { scrubSecrets } from "./scrub.ts";

// ── W3C ids (generated at the impure method boundary, like gobrr's now()) ─────

function hex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
/** A W3C trace id: 16 bytes = 32 lowercase hex chars. */
export function newTraceId(): string {
  return hex(16);
}
/** A W3C span id: 8 bytes = 16 lowercase hex chars. */
export function newSpanId(): string {
  return hex(8);
}
export function isTraceId(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}
export function isSpanId(s: string): boolean {
  return /^[0-9a-f]{16}$/.test(s);
}

// ── canonical inputs (gobrr maps Run/Task/StepOutput into these) ──────────────

export type AttrValue = string | number | boolean;
export type SpanStatus = "unset" | "ok" | "error";

export interface OtlpSpanInput {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startUnixNano: string;
  endUnixNano: string;
  status: SpanStatus;
  attributes: Record<string, AttrValue>;
}
export interface OtlpTraceInput {
  traceId: string;
  serviceName: string;
  spans: OtlpSpanInput[];
}
export interface OtlpMetricPoint {
  attributes: Record<string, AttrValue>;
  value: number;
  timeUnixNano?: string; // measurement time; many collectors drop epoch-0 points
}
export interface OtlpMetricSeries {
  name: string;
  unit?: string;
  kind: "sum" | "gauge";
  points: OtlpMetricPoint[];
}
export interface OtlpMetricInput {
  serviceName: string;
  metrics: OtlpMetricSeries[];
}

/** The closed allowlist of metric label keys — NO free-text labels (spec, intake,
 * path, diff) may become a metric label (cardinality + leak control). */
export const METRIC_LABELS = ["runId", "taskId", "gate", "outcome"] as const;

// ── encoding helpers ──────────────────────────────────────────────────────────

function encodeAttr(
  key: string,
  val: AttrValue,
): { key: string; value: Record<string, unknown> } {
  if (typeof val === "string") {
    // authoritative, unconditional scrub of every string attribute value
    return { key, value: { stringValue: scrubSecrets(val) } };
  }
  if (typeof val === "boolean") return { key, value: { boolValue: val } };
  if (Number.isInteger(val)) {
    return { key, value: { intValue: String(val) } }; // OTLP int64 is stringified
  }
  return { key, value: { doubleValue: val } };
}

function statusCode(s: SpanStatus): number {
  return s === "ok" ? 1 : s === "error" ? 2 : 0; // OTLP STATUS_CODE_{UNSET,OK,ERROR}
}

function serviceResource(serviceName: string) {
  return {
    attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
  };
}

// ── serializers (pure; scrub at this boundary) ────────────────────────────────

export function serializeTrace(input: OtlpTraceInput): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: serviceResource(input.serviceName),
      scopeSpans: [{
        scope: { name: "swamp-go-brr" },
        spans: input.spans.map((s) => {
          const span: Record<string, unknown> = {
            traceId: input.traceId,
            spanId: s.spanId,
            name: scrubSecrets(s.name),
            kind: 1, // SPAN_KIND_INTERNAL
            startTimeUnixNano: s.startUnixNano,
            endTimeUnixNano: s.endUnixNano,
            status: { code: statusCode(s.status) },
            attributes: Object.entries(s.attributes).map(([k, v]) =>
              encodeAttr(k, v)
            ),
          };
          if (s.parentSpanId !== undefined) span.parentSpanId = s.parentSpanId;
          return span;
        }),
      }],
    }],
  };
}

export function serializeMetrics(
  input: OtlpMetricInput,
): Record<string, unknown> {
  const allow = METRIC_LABELS as readonly string[];
  return {
    resourceMetrics: [{
      resource: serviceResource(input.serviceName),
      scopeMetrics: [{
        scope: { name: "swamp-go-brr" },
        metrics: input.metrics.map((m) => {
          const dataPoints = m.points.map((p) => {
            for (const k of Object.keys(p.attributes)) {
              if (!allow.includes(k)) {
                throw new Error(`metric label not allowlisted: ${k}`);
              }
            }
            return {
              attributes: Object.entries(p.attributes).map(([k, v]) =>
                encodeAttr(k, v)
              ),
              timeUnixNano: p.timeUnixNano ?? "0",
              asDouble: p.value,
            };
          });
          const body = m.kind === "sum"
            ? {
              sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true },
            }
            : { gauge: { dataPoints } };
          return { name: m.name, unit: m.unit ?? "", ...body };
        }),
      }],
    }],
  };
}
