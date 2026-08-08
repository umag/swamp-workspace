// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Methods suite for @magistr/distress (STANDARD.md `methods`).
//
// Drives all five methods — call / ack / resolve / list / test — through
// `model.methods.<m>.execute()` against a fake context whose `runModel`,
// `readModelData`, `readResource` and `writeResource` are all in-memory. No
// network, no subprocess, no swamp runtime.
//
// Every call goes through the method's real zod `arguments` schema first, so
// a CLI-boundary regression (an argument silently dropped because it is
// missing from the schema, or a default that stopped applying) surfaces here
// rather than in production.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import { type Beacon, type Call, model } from "./distress.ts";

// ============================================================================
// Harness
// ============================================================================

type Stored = Record<string, unknown>;

type RunCall = {
  definition: string;
  method: string;
  arguments: Record<string, unknown>;
};

type Behavior =
  | { kind: "ok"; proofRow?: Stored }
  | { kind: "silent" } // resolves, delivers nothing (the serve no-op)
  | { kind: "throw"; message: string };

type Harness = {
  store: Record<string, Stored>;
  runs: RunCall[];
  context: Record<string, unknown>;
  beacon: () => Beacon | undefined;
  call: (id: string) => Call | undefined;
};

const GLOBALS = model.globalArguments;

function makeHarness(opts: {
  globals?: Record<string, unknown>;
  behavior?: Record<string, Behavior>;
  store?: Record<string, Stored>;
  instance?: string;
} = {}): Harness {
  const store: Record<string, Stored> = { ...(opts.store ?? {}) };
  const runs: RunCall[] = [];
  // Per-callee proof rows, so readModelData can show a genuinely NEW record
  // appearing only when the callee actually ran.
  const proofRows: Record<string, Stored[]> = {};
  let seq = 0;

  const context = {
    globalArgs: GLOBALS.parse(opts.globals ?? {}),
    definition: { name: opts.instance ?? "distress" },
    logger: { info: () => {}, warning: () => {} },
    readResource: (name: string) => Promise.resolve(store[name] ?? null),
    writeResource: (_spec: string, name: string, data: Stored) => {
      store[name] = structuredClone(data);
      return Promise.resolve({ name });
    },
    readModelData: (name: string, spec?: string) =>
      Promise.resolve([...(proofRows[`${name}/${spec ?? ""}`] ?? [])]),
    runModel: (o: RunCall) => {
      runs.push(structuredClone(o));
      const behavior = opts.behavior?.[o.definition] ?? { kind: "ok" as const };
      if (behavior.kind === "throw") throw new Error(behavior.message);
      if (behavior.kind === "silent") return Promise.resolve({ resources: [] });
      seq += 1;
      // A real send writes a resource; mirror that for every declared spec.
      for (const key of Object.keys(proofRows)) {
        if (key.startsWith(`${o.definition}/`)) {
          proofRows[key].push({ id: `row-${seq}`, name: `msg-${seq}` });
        }
      }
      return Promise.resolve({ resources: [{ name: `msg-${seq}` }] });
    },
    declareProofSpec: (definition: string, spec: string) => {
      proofRows[`${definition}/${spec}`] = [];
    },
  };

  return {
    store,
    runs,
    context: context as unknown as Record<string, unknown>,
    beacon: () => store.current as Beacon | undefined,
    call: (id: string) => store[id] as Call | undefined,
  };
}

type MethodEntry = {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
};

function run(
  name: string,
  args: Record<string, unknown>,
  h: Harness,
): Promise<unknown> {
  const method = (model.methods as unknown as Record<string, MethodEntry>)[
    name
  ];
  return method.execute(method.arguments.parse(args), h.context);
}

const TELEGRAM = {
  name: "telegram",
  definition: "tg-bot",
  method: "sendMessage",
  preset: "text",
  minSeverity: "info",
  proofSpec: "sentMessage",
  format: "plain",
};

const HERDR = {
  name: "herdr",
  definition: "herd",
  method: "notify",
  preset: "title-body",
  minSeverity: "info",
  format: "plain",
  maxChars: 300,
};

// ============================================================================
// call
// ============================================================================

Deno.test("call: delivers, records the call, and indexes it", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", {
    summary: "backend returned 500 on every retry",
    severity: "urgent",
    category: "backend-error",
    agentName: "nightly-ingest",
  }, h);

  assertEquals(h.runs.length, 1);
  assertEquals(h.runs[0].definition, "tg-bot");
  assertEquals(h.runs[0].method, "sendMessage");
  assertStringIncludes(
    String(h.runs[0].arguments.text),
    "backend returned 500 on every retry",
  );

  const beacon = h.beacon()!;
  assertEquals(beacon.calls.length, 1);
  assertEquals(beacon.totals.raised, 1);
  assertEquals(beacon.totals.delivered, 1);
  assertEquals(beacon.deliveries.length, 1);

  const call = h.call(beacon.calls[0].callId)!;
  assertEquals(call.status, "open");
  assertEquals(call.severity, "urgent");
  assertEquals(call.delivered, true);
  assertEquals(call.deliveries[0].ok, true);
  assertEquals(call.deliveries[0].kind, "initial");
});

Deno.test("call: the page carries the command that answers it", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM] },
    instance: "sos",
  });
  await run("call", { summary: "need a decision on the schema" }, h);
  const text = String(h.runs[0].arguments.text);
  assertStringIncludes(text, "swamp model method run sos ack");
  assertStringIncludes(text, "--input callId=dc-");
});

Deno.test("call: defaults severity to concern and category to other", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "something is off" }, h);
  const call = h.call(h.beacon()!.calls[0].callId)!;
  assertEquals(call.severity, "concern");
  assertEquals(call.category, "other");
});

Deno.test("call: minSeverity keeps a low call off a high channel", async () => {
  const h = makeHarness({
    globals: {
      channels: [{ ...TELEGRAM, minSeverity: "urgent" }, HERDR],
    },
  });
  await run("call", { summary: "fyi", severity: "info" }, h);
  assertEquals(h.runs.length, 1);
  assertEquals(h.runs[0].definition, "herd");
});

Deno.test("call: failover stops at the first proven delivery", async () => {
  const h = makeHarness({ globals: { channels: [HERDR, TELEGRAM] } });
  await run("call", { summary: "low key problem", severity: "concern" }, h);
  assertEquals(h.runs.map((r) => r.definition), ["herd"]);
});

Deno.test("call: failover moves on when a channel cannot prove delivery", async () => {
  const h = makeHarness({
    globals: { channels: [HERDR, TELEGRAM] },
    behavior: { herd: { kind: "silent" } },
  });
  await run("call", { summary: "still needs to land", severity: "concern" }, h);
  assertEquals(h.runs.map((r) => r.definition), ["herd", "tg-bot"]);
  const call = h.call(h.beacon()!.calls[0].callId)!;
  assertEquals(call.delivered, true);
  assertEquals(call.deliveries[0].ok, false);
  assertStringIncludes(call.deliveries[0].error!, "no resource handles");
  assertEquals(call.deliveries[1].ok, true);
});

Deno.test("call: urgent broadcasts to every eligible channel", async () => {
  const h = makeHarness({ globals: { channels: [HERDR, TELEGRAM] } });
  await run(
    "call",
    { summary: "everything is on fire", severity: "urgent" },
    h,
  );
  assertEquals(h.runs.map((r) => r.definition), ["herd", "tg-bot"]);
});

Deno.test("call: throws when it reached nobody, but records first", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM] },
    behavior: { "tg-bot": { kind: "silent" } },
  });
  await assertRejects(
    () => run("call", { summary: "unreachable", severity: "urgent" }, h),
    Error,
    "reached nobody",
  );
  const beacon = h.beacon()!;
  assertEquals(beacon.calls.length, 1);
  assertEquals(beacon.totals.failed, 1);
  const call = h.call(beacon.calls[0].callId)!;
  assertEquals(call.delivered, false);
  assert(call.deliveries.length > 0, "the failed attempt must be recorded");
});

Deno.test("call: with no channels configured, throws and still records", async () => {
  const h = makeHarness({ globals: { channels: [] } });
  await assertRejects(
    () => run("call", { summary: "nobody home" }, h),
    Error,
    "no channel is configured",
  );
  const call = h.call(h.beacon()!.calls[0].callId)!;
  assertEquals(call.suppressedReason, "no-channel");
});

Deno.test("call: requireDelivery=false reports failure without throwing", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM], requireDelivery: false },
    behavior: { "tg-bot": { kind: "throw", message: "chat not found" } },
  });
  await run("call", { summary: "best effort" }, h);
  const call = h.call(h.beacon()!.calls[0].callId)!;
  assertEquals(call.delivered, false);
  assertStringIncludes(call.deliveries[0].error!, "chat not found");
});

Deno.test("call: a repeat folds into the open call and does not page", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  const args = {
    summary: "stuck retrying read_file",
    category: "stuck",
    agentName: "worker-1",
  };
  await run("call", args, h);
  await run("call", args, h);
  await run("call", args, h);

  assertEquals(h.runs.length, 1, "only the first call pages");
  const beacon = h.beacon()!;
  assertEquals(beacon.calls.length, 1, "all three are one incident");
  assertEquals(beacon.totals.raised, 1);
  assertEquals(beacon.totals.deduped, 2);
  const call = h.call(beacon.calls[0].callId)!;
  assertEquals(call.repeats, 2);
  assertEquals(call.suppressedReason, "dedupe");
});

Deno.test("call: a counting loop folds into ONE incident", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  for (let i = 1; i <= 6; i++) {
    await run("call", {
      summary: `attempt ${i} of the same tool call failed`,
      category: "stuck",
      agentName: "looper",
    }, h);
  }
  assertEquals(h.runs.length, 1);
  assertEquals(h.beacon()!.calls.length, 1);
  assertEquals(h.call(h.beacon()!.calls[0].callId)!.repeats, 5);
});

Deno.test("call: escalates once the repeat threshold is crossed", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM], escalateAfterRepeats: 3 },
  });
  const args = { summary: "still stuck", category: "stuck" };
  for (let i = 0; i < 4; i++) await run("call", args, h);

  assertEquals(h.runs.length, 2, "initial page plus one escalation");
  assertStringIncludes(String(h.runs[1].arguments.text), "STILL STUCK");
  assertStringIncludes(String(h.runs[1].arguments.text), "3 repeats");
  const call = h.call(h.beacon()!.calls[0].callId)!;
  assertEquals(call.escalations, 1);
  assertEquals(call.repeatsSinceEscalation, 0, "counter resets after paging");
});

Deno.test("call: a hotter repeat raises the call's severity", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", {
    summary: "disk filling up",
    severity: "concern",
    dedupeKey: "disk",
  }, h);
  await run("call", {
    summary: "disk filling up",
    severity: "critical",
    dedupeKey: "disk",
  }, h);
  assertEquals(h.call(h.beacon()!.calls[0].callId)!.severity, "critical");
});

Deno.test("call: an explicit dedupeKey separates identical summaries", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "job failed", dedupeKey: "job-a" }, h);
  await run("call", { summary: "job failed", dedupeKey: "job-b" }, h);
  assertEquals(h.runs.length, 2);
  assertEquals(h.beacon()!.calls.length, 2);
});

Deno.test("call: the hourly cap stops paging but never stops recording", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM], maxCallsPerHour: 2 },
  });
  for (let i = 0; i < 5; i++) {
    await run(
      "call",
      { summary: `distinct problem ${i}`, dedupeKey: `k${i}` },
      h,
    );
  }
  const beacon = h.beacon()!;
  assertEquals(beacon.calls.length, 5, "every call is recorded");
  assertEquals(beacon.totals.suppressed, 3);
  // 2 real pages + exactly one throttle notice.
  assertEquals(h.runs.length, 3);
  assertStringIncludes(String(h.runs[2].arguments.text), "throttled");
  const suppressed = h.call(beacon.calls[4].callId)!;
  assertEquals(suppressed.suppressedReason, "rate-limit");
  assertEquals(suppressed.delivered, false);
});

Deno.test("call: a rate-limited call does not throw", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM], maxCallsPerHour: 1 },
  });
  await run("call", { summary: "first", dedupeKey: "a" }, h);
  // Would throw if suppression were treated as a delivery failure.
  await run("call", { summary: "second", dedupeKey: "b" }, h);
  assertEquals(h.beacon()!.totals.suppressed, 1);
});

Deno.test("call: critical pages through the hourly cap", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM], maxCallsPerHour: 1 },
  });
  await run("call", { summary: "routine", dedupeKey: "a" }, h);
  await run("call", {
    summary: "production is down",
    severity: "critical",
    dedupeKey: "b",
  }, h);
  assertEquals(h.runs.length, 2);
  assertEquals(h.call(h.beacon()!.calls[1].callId)!.delivered, true);
});

Deno.test("call: proofSpec demands a NEW record from the callee", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM] },
  });
  // Declare the spec, and pre-seed it: a stale record must not be mistaken
  // for proof that THIS send landed.
  (h.context.declareProofSpec as (d: string, s: string) => void)(
    "tg-bot",
    "sentMessage",
  );
  await run("call", { summary: "prove it" }, h);
  const call = h.call(h.beacon()!.calls[0].callId)!;
  assertEquals(call.deliveries[0].ok, true);
  assertEquals(call.deliveries[0].proof, "row-1");
});

// ============================================================================
// ack / resolve
// ============================================================================

Deno.test("ack: records the note and makes it visible to the agent", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "which bucket should I use?" }, h);
  const id = h.beacon()!.calls[0].callId;

  await run("ack", { callId: id, note: "use archive-2026", by: "mag1" }, h);
  const call = h.call(id)!;
  assertEquals(call.status, "acked");
  assertEquals(call.acknowledgement?.note, "use archive-2026");
  assertEquals(call.acknowledgement?.by, "mag1");
  assertEquals(h.beacon()!.calls[0].ackNote, "use archive-2026");

  await run("list", {}, h);
  const listing = h.store.recent as { calls: Array<{ ackNote?: string }> };
  assertEquals(listing.calls[0].ackNote, "use archive-2026");
});

Deno.test("ack: with one call open, callId may be omitted", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "only one" }, h);
  await run("ack", { note: "seen" }, h);
  assertEquals(h.beacon()!.calls[0].status, "acked");
});

Deno.test("ack: refuses to guess between several open calls", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "one", dedupeKey: "a" }, h);
  await run("call", { summary: "two", dedupeKey: "b" }, h);
  await assertRejects(
    () => run("ack", { note: "which?" }, h),
    Error,
    "2 unresolved calls",
  );
});

Deno.test("ack: an unknown callId is an error, not a silent no-op", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await assertRejects(
    () => run("ack", { callId: "dc-nope" }, h),
    Error,
    'No distress call "dc-nope"',
  );
});

Deno.test("resolve: closes the call and re-opens the dedupe key", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "disk full", dedupeKey: "disk" }, h);
  const first = h.beacon()!.calls[0].callId;
  await run("resolve", { callId: first, note: "pruned the cache" }, h);
  assertEquals(h.call(first)!.status, "resolved");
  assertEquals(h.call(first)!.resolution?.note, "pruned the cache");

  await run("call", { summary: "disk full", dedupeKey: "disk" }, h);
  assertEquals(h.runs.length, 2, "a recurrence after resolution pages again");
  assertEquals(h.beacon()!.calls.length, 2);
});

Deno.test("resolve: is idempotent", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "x" }, h);
  const id = h.beacon()!.calls[0].callId;
  await run("resolve", { callId: id }, h);
  await run("resolve", { callId: id }, h);
  await run("resolve", { callId: id }, h);
  assertEquals(h.call(id)!.status, "resolved");
});

Deno.test("resolve: an acked call can still be resolved", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "x" }, h);
  const id = h.beacon()!.calls[0].callId;
  await run("ack", { callId: id, note: "on it" }, h);
  await run("resolve", { callId: id, note: "done" }, h);
  assertEquals(h.call(id)!.status, "resolved");
  assertEquals(h.call(id)!.acknowledgement?.note, "on it");
});

// ============================================================================
// list
// ============================================================================

Deno.test("list: defaults to unresolved (open + acked)", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("call", { summary: "a", dedupeKey: "a" }, h);
  await run("call", { summary: "b", dedupeKey: "b" }, h);
  await run("call", { summary: "c", dedupeKey: "c" }, h);
  const ids = h.beacon()!.calls.map((c) => c.callId);
  await run("ack", { callId: ids[1] }, h);
  await run("resolve", { callId: ids[2] }, h);

  await run("list", {}, h);
  const listing = h.store.recent as {
    filter: string;
    count: number;
    calls: Array<{ callId: string }>;
  };
  assertEquals(listing.filter, "unresolved");
  assertEquals(listing.count, 2);
  assertEquals(listing.calls.map((c) => c.callId), [ids[0], ids[1]]);
});

Deno.test("list: status filters and limit both apply", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  for (let i = 0; i < 4; i++) {
    await run("call", { summary: `s${i}`, dedupeKey: `k${i}` }, h);
  }
  await run("resolve", { callId: h.beacon()!.calls[0].callId }, h);

  await run("list", { status: "resolved" }, h);
  assertEquals((h.store.recent as { count: number }).count, 1);

  await run("list", { status: "all", limit: 2 }, h);
  assertEquals((h.store.recent as { count: number }).count, 2);
});

Deno.test("list: an empty beacon lists nothing rather than throwing", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  await run("list", {}, h);
  assertEquals((h.store.recent as { count: number }).count, 0);
});

// ============================================================================
// test
// ============================================================================

Deno.test("test: probes every enabled channel regardless of minSeverity", async () => {
  const h = makeHarness({
    globals: {
      channels: [{ ...TELEGRAM, minSeverity: "critical" }, HERDR],
    },
  });
  await run("test", {}, h);
  assertEquals(h.runs.map((r) => r.definition), ["tg-bot", "herd"]);
  const result = h.store.channels as { okCount: number; failCount: number };
  assertEquals(result.okCount, 2);
  assertEquals(result.failCount, 0);
});

Deno.test("test: skips a disabled channel", async () => {
  const h = makeHarness({
    globals: { channels: [{ ...TELEGRAM, enabled: false }, HERDR] },
  });
  await run("test", {}, h);
  assertEquals(h.runs.map((r) => r.definition), ["herd"]);
});

Deno.test("test: fails when no channel could be proven", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM] },
    behavior: { "tg-bot": { kind: "silent" } },
  });
  await assertRejects(
    () => run("test", {}, h),
    Error,
    "cannot",
  );
  const result = h.store.channels as { okCount: number; failCount: number };
  assertEquals(result.okCount, 0);
  assertEquals(result.failCount, 1);
});

Deno.test("test: allowFailure reports without failing the run", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM] },
    behavior: { "tg-bot": { kind: "silent" } },
  });
  await run("test", { allowFailure: true }, h);
  assertEquals((h.store.channels as { okCount: number }).okCount, 0);
});

Deno.test("test: refuses to run with no channels configured", async () => {
  const h = makeHarness({ globals: { channels: [] } });
  await assertRejects(
    () => run("test", {}, h),
    Error,
    "No channels configured",
  );
});

Deno.test("test: a partial failure still succeeds and is recorded", async () => {
  const h = makeHarness({
    globals: { channels: [TELEGRAM, HERDR] },
    behavior: { "tg-bot": { kind: "throw", message: "401 unauthorized" } },
  });
  await run("test", {}, h);
  const result = h.store.channels as {
    okCount: number;
    failCount: number;
    channels: Array<{ channel: string; ok: boolean; error?: string }>;
  };
  assertEquals(result.okCount, 1);
  assertEquals(result.failCount, 1);
  assertStringIncludes(result.channels[0].error!, "401 unauthorized");
});

// ============================================================================
// runtime degradation
// ============================================================================

Deno.test("call: a runtime without runModel fails loudly", async () => {
  const h = makeHarness({ globals: { channels: [TELEGRAM] } });
  delete (h.context as Record<string, unknown>).runModel;
  await assertRejects(
    () => run("call", { summary: "no transport" }, h),
    Error,
    "runModel is unavailable",
  );
});

Deno.test("call: a channel is used per its own format and length budget", async () => {
  const h = makeHarness({
    globals: {
      channels: [
        { ...HERDR, maxChars: 200 },
        { ...TELEGRAM, format: "html" },
      ],
      dispatch: "broadcast",
    },
  });
  await run("call", {
    summary: "a & b <script> failed",
    detail: "z".repeat(4000),
  }, h);

  const toast = h.runs[0].arguments as { title: string; body: string };
  assert(toast.body.length <= 200, "herdr body respects its own cap");
  const telegram = String(h.runs[1].arguments.text);
  assertStringIncludes(telegram, "&amp;");
  assertStringIncludes(telegram, "&lt;script&gt;");
});
