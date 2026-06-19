// RED-phase tests for the gobrr OTLP-observability surface (issue
// gobrr-observability): persisted W3C ids (root facts), per-leaf declared/host
// usage on the StepOutput audit record, the buildTrace span-tree projection
// (orphan suppression + 4-state status + per-leaf attributes), buildMetrics, and
// the intake/spec sensitive marks. Kept in a separate file so the existing
// gobrr.test.ts stays green while these are RED.
// Run: /home/zeroclaw/.swamp/deno/deno test extensions/models/gobrr_observability.test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMetrics,
  buildStepOutput,
  buildTrace,
  type Run,
  RunSchema,
  type StepOutput,
  type Task,
  TaskSchema,
} from "./gobrr.ts";

const T0 = "2026-06-18T00:00:00.000Z";
const TRACE = "a".repeat(32);

function task(over: Partial<Task> & { id: string }): Task {
  return {
    spec: "do a thing",
    writeAllowlist: ["src/a.ts"],
    dependsOn: [],
    gate: "real",
    status: "done",
    attempts: 0,
    followupDepth: 0,
    lease: null,
    outcome: "done",
    failureKind: null,
    failureSignature: null,
    mergeDisposition: "clean",
    createdAt: T0,
    ...over,
  };
}

function run(tasks: Task[], over: Partial<Run> = {}): Run {
  return {
    status: "complete",
    intake: "build it",
    // config is structurally validated elsewhere; cast keeps this fixture terse.
    config: {
      verifyCommand: "deno test",
      verifyInputs: ["tests/"],
      repoScope: "src",
      toolchainImage: "img@sha256:abc",
      leafModel: "",
      leafEffort: "low",
      maxConcurrentVMs: 1,
      maxAttempts: 2,
      maxFollowupDepth: 3,
      maxInvocations: 100,
      leaseTtlSeconds: 1800,
      wallclockSeconds: 7200,
      stallN: 2,
      stallK: 3,
      perInvocationCostEstimate: 0,
      pinnedVersions: {},
    },
    tasks,
    invocations: tasks.length,
    costEstimate: 0,
    offers: [],
    haltReason: null,
    haltOptions: [],
    stallCulprits: [],
    stallSignature: null,
    createdAt: T0,
    updatedAt: T0,
    traceId: TRACE,
    ...over,
  } as Run;
}

function rec(over: Partial<StepOutput> & { taskId: string }): StepOutput {
  return {
    invocation: 1,
    recordedAt: T0,
    outcome: "done",
    failureKind: null,
    envelope: null,
    changedPaths: ["src/a.ts"],
    diffTail: "",
    verifyExitCode: 0,
    verifyTail: "",
    invocationSpanId: "f".repeat(16),
    hostDurationMs: 4200,
    leafDeclared: {
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadTokens: 0,
      costUsd: 0.0123,
      durationMs: 3900,
    },
    ...over,
  } as StepOutput;
}

// ── ids as root facts: optional, no default ──────────────────────────────────

Deno.test("RunSchema.traceId is optional with NO default (absence is meaningful)", () => {
  const parsed = RunSchema.parse({
    status: "running",
    intake: "x",
    config: run([]).config,
    tasks: [],
    invocations: 0,
    costEstimate: 0,
    offers: [],
    haltReason: null,
    haltOptions: [],
    stallCulprits: [],
    stallSignature: null,
    createdAt: T0,
    updatedAt: T0,
  }) as Run;
  // pre-feature run parses fine AND traceId stays undefined (no auto-heal)
  assertEquals(parsed.traceId, undefined);
});

Deno.test("TaskSchema.spanId is optional with no default", () => {
  const t = TaskSchema.parse({
    id: "t1",
    spec: "s",
    writeAllowlist: ["src/a.ts"],
    dependsOn: [],
    gate: "real",
    createdAt: T0,
  }) as Task;
  assertEquals(t.spanId, undefined);
});

// ── intake / spec marked sensitive ───────────────────────────────────────────

Deno.test("RunSchema.intake and TaskSchema.spec are marked sensitive", () => {
  assertEquals((RunSchema.shape.intake.meta() ?? {}).sensitive, true);
  assertEquals((TaskSchema.shape.spec.meta() ?? {}).sensitive, true);
});

// ── StepOutput leaf usage round-trips through buildStepOutput ─────────────────

Deno.test("buildStepOutput preserves invocationSpanId + hostDurationMs + leafDeclared", () => {
  const so = buildStepOutput({
    taskId: "t1",
    invocation: 1,
    recordedAt: T0,
    outcome: "done",
    failureKind: null,
    envelope: null,
    changedPaths: ["src/a.ts"],
    diff: "",
    verifyExitCode: 0,
    verifyTail: "",
    invocationSpanId: "f".repeat(16),
    hostDurationMs: 4200,
    leafDeclared: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      costUsd: 0.01,
      durationMs: 100,
    },
  });
  assertEquals(so.invocationSpanId, "f".repeat(16));
  assertEquals(so.hostDurationMs, 4200);
  assertEquals(so.leafDeclared?.inputTokens, 10);
  assertEquals(so.leafDeclared?.costUsd, 0.01);
});

// ── buildTrace: 4-state status ────────────────────────────────────────────────

Deno.test("buildTrace status=unavailable when the run has no traceId", () => {
  const r = run([task({ id: "t1" })], { traceId: undefined });
  assertEquals(buildTrace(r, []).status, "unavailable");
});

Deno.test("buildTrace status=empty for a new run (traceId, all attempts==0, no records)", () => {
  const r = run([task({ id: "t1", status: "pending", attempts: 0 })]);
  assertEquals(buildTrace(r, []).status, "empty");
});

Deno.test("buildTrace status=partial when records are GC'd but attempts>0", () => {
  const r = run([task({ id: "t1", attempts: 1, spanId: "2".repeat(16) })]);
  assertEquals(buildTrace(r, []).status, "partial");
});

Deno.test("buildTrace status=ok when records exist", () => {
  const r = run([task({ id: "t1", attempts: 1, spanId: "2".repeat(16) })]);
  const res = buildTrace(r, [rec({ taskId: "t1" })]);
  assertEquals(res.status, "ok");
  assert(res.trace !== undefined);
});

// ── buildTrace: structural nesting (no orphans, no dups) ──────────────────────

Deno.test("buildTrace nests run->task->invocation with one traceId and no duplicate spanIds", () => {
  const r = run([
    task({ id: "t1", attempts: 1, spanId: "2".repeat(16) }),
    task({ id: "t2", attempts: 1, spanId: "3".repeat(16), dependsOn: ["t1"] }),
  ]);
  const recs = [
    rec({ taskId: "t1", invocationSpanId: "a1".padEnd(16, "0") }),
    rec({ taskId: "t2", invocationSpanId: "b2".padEnd(16, "0") }),
  ];
  const spans = buildTrace(r, recs).trace!.spans;
  const ids = spans.map((s) => s.spanId);
  assertEquals(new Set(ids).size, ids.length, "duplicate spanIds");
  const root = spans.find((s) => s.parentSpanId === undefined)!;
  // every non-root span chains to an existing parent (no orphan -> no missing parent)
  for (const s of spans) {
    if (s.spanId === root.spanId) continue;
    assert(
      ids.includes(s.parentSpanId!),
      `orphan span ${s.spanId} parent ${s.parentSpanId} missing`,
    );
  }
  // task spans parent to the run root
  const t1span = spans.find((s) => s.spanId === "2".repeat(16))!;
  assertEquals(t1span.parentSpanId, root.spanId);
});

// ── buildTrace: orphan suppression ────────────────────────────────────────────

Deno.test("buildTrace suppresses ALL spans for a spanId-less task (task + invocations), never orphan-to-root", () => {
  // t1 has a spanId; t2 is pre-feature (no spanId) but HAS a record with an invocationSpanId
  const r = run([
    task({ id: "t1", attempts: 1, spanId: "2".repeat(16) }),
    task({ id: "t2", attempts: 1, spanId: undefined }),
  ]);
  const recs = [
    rec({ taskId: "t1", invocationSpanId: "a1".padEnd(16, "0") }),
    rec({ taskId: "t2", invocationSpanId: "c3".padEnd(16, "0") }),
  ];
  const res = buildTrace(r, recs);
  assertEquals(res.suppressedTasks, 1);
  const spans = res.trace!.spans;
  // bound the span set: run root + t1 task + t1 invocation = 3 (t2 fully suppressed)
  assertEquals(spans.length, 3);
  // t2's invocation spanId is absent and no span is named for t2 (no synthetic span)
  assert(!spans.some((s) => s.spanId === "c3".padEnd(16, "0")));
  assert(!spans.some((s) => /(^|\s)t2(\s|$)/.test(s.name)));
  const roots = spans.filter((s) => s.parentSpanId === undefined);
  assertEquals(roots.length, 1); // only the run root has no parent
});

Deno.test("buildTrace keeps spanIds unique across MULTIPLE invocations of one task", () => {
  const r = run([task({ id: "t1", attempts: 2, spanId: "2".repeat(16) })]);
  const recs = [
    rec({
      taskId: "t1",
      invocation: 1,
      invocationSpanId: "d1".padEnd(16, "0"),
    }),
    rec({
      taskId: "t1",
      invocation: 2,
      invocationSpanId: "d2".padEnd(16, "0"),
    }),
  ];
  const spans = buildTrace(r, recs).trace!.spans;
  const ids = spans.map((s) => s.spanId);
  assertEquals(
    new Set(ids).size,
    ids.length,
    "duplicate spanIds across invocations",
  );
  // both invocation spans parent to the single t1 task span
  const invs = spans.filter((s) => s.parentSpanId === "2".repeat(16));
  assertEquals(invs.length, 2);
});

// ── buildTrace: per-leaf declared vs host attributes + provenance ─────────────

Deno.test("buildTrace puts leaf.declared.* and leaf.host.* on the invocation span", () => {
  const r = run([task({ id: "t1", attempts: 1, spanId: "2".repeat(16) })]);
  const res = buildTrace(r, [rec({ taskId: "t1" })]);
  const inv = res.trace!.spans.find((s) => s.parentSpanId === "2".repeat(16))!;
  assertEquals(inv.attributes["leaf.declared.input_tokens"], 1200);
  assertEquals(inv.attributes["leaf.declared.cost_usd"], 0.0123);
  assertEquals(inv.attributes["leaf.host.duration_ms"], 4200);
});

Deno.test("PROVENANCE: host vs declared are distinct BY VALUE (host=4200, declared=3900)", () => {
  const HOST_KEYS = ["leaf.host.duration_ms"]; // known host-measured keys (extend as added)
  const r = run([task({ id: "t1", attempts: 1, spanId: "2".repeat(16) })]);
  const res = buildTrace(r, [rec({ taskId: "t1" })]);
  const inv = res.trace!.spans.find((s) => s.parentSpanId === "2".repeat(16))!;
  // host duration is the loop-measured 4200, NEVER the declared 3900
  assertEquals(inv.attributes["leaf.host.duration_ms"], 4200);
  assertEquals(inv.attributes["leaf.declared.duration_ms"], 3900);
  assertEquals(inv.attributes["leaf.declared.input_tokens"], 1200);
  // every host-namespaced key must be a known host metric (no declared value smuggled in)
  for (const s of res.trace!.spans) {
    for (const k of Object.keys(s.attributes)) {
      if (k.startsWith("leaf.host.")) {
        assert(HOST_KEYS.includes(k), `unknown leaf.host.* key ${k}`);
      }
    }
  }
});

// ── buildMetrics: per-gate token/cost/time, allowlisted labels, no drift ─────

Deno.test("buildMetrics emits per-gate token/cost/time points with only allowlisted labels", () => {
  const r = run([
    task({ id: "t1", attempts: 1, gate: "real", spanId: "2".repeat(16) }),
  ]);
  const m = buildMetrics(r, [rec({ taskId: "t1" })]);
  const names = m.metrics.map((x) => x.name);
  assert(names.some((n) => n.includes("tokens")));
  assert(names.some((n) => n.includes("cost")));
  for (const metric of m.metrics) {
    for (const p of metric.points) {
      for (const key of Object.keys(p.attributes)) {
        assert(
          ["runId", "taskId", "gate", "outcome"].includes(key),
          `non-allowlisted metric label ${key}`,
        );
      }
    }
  }
});
