// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Coverage suite for @magistr/distress (STANDARD.md `coverage`).
//
// Regression tests for guards that the methods and adversarial suites reach
// only incidentally — the ones where deleting the guard would still leave
// those suites green. Each test names the guard it protects.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  buildChannelArgs,
  buildMessage,
  buildRateNotice,
  type Call,
  type Channel,
  deriveDedupeKey,
  eligibleChannels,
  emptyBeacon,
  escapeFor,
  filterCalls,
  findOpenDuplicate,
  fnv1a,
  type IndexEntry,
  isRateLimited,
  makeCallId,
  messageFields,
  model,
  normalizeSummary,
  pruneStamps,
  redactSecrets,
  severityRank,
  shouldBroadcast,
  soleOpenCallId,
  toIndexEntry,
  truncate,
  upsertEntry,
} from "./distress.ts";

// ============================================================================
// Fixtures
// ============================================================================

function channel(over: Partial<Channel> = {}): Channel {
  return {
    name: "c",
    definition: "d",
    method: "m",
    preset: "text",
    arguments: {},
    minSeverity: "info",
    format: "plain",
    proofRequire: {},
    enabled: true,
    ...over,
  } as Channel;
}

function entry(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    callId: "dc-1",
    dedupeKey: "k",
    status: "open",
    severity: "concern",
    category: "other",
    summary: "s",
    createdAt: "2026-08-09T12:00:00.000Z",
    lastSeenAt: "2026-08-09T12:00:00.000Z",
    repeats: 0,
    repeatsSinceEscalation: 0,
    escalations: 0,
    delivered: true,
    ...over,
  };
}

function sampleCall(over: Partial<Call> = {}): Call {
  return {
    callId: "dc-x",
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    lastSeenAt: "2026-08-09T12:00:00.000Z",
    status: "open",
    severity: "concern",
    category: "other",
    summary: "s",
    agent: {},
    dedupeKey: "k",
    repeats: 0,
    repeatsSinceEscalation: 0,
    escalations: 0,
    delivered: false,
    deliveries: [],
    ...over,
  };
}

type Stored = Record<string, unknown>;

type MethodEntry = {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
};

function makeCtx(opts: {
  globals?: Record<string, unknown>;
  store?: Record<string, Stored>;
  runModel?: (o: unknown) => Promise<unknown>;
}) {
  const store: Record<string, Stored> = { ...(opts.store ?? {}) };
  const runs: Array<Record<string, unknown>> = [];
  return {
    store,
    runs,
    ctx: {
      globalArgs: model.globalArguments.parse(opts.globals ?? {}),
      definition: { name: "distress" },
      logger: { info: () => {}, warning: () => {} },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
      writeResource: (_s: string, name: string, data: Stored) => {
        store[name] = structuredClone(data);
        return Promise.resolve({ name });
      },
      readModelData: () => Promise.resolve([]),
      runModel: (o: Record<string, unknown>) => {
        runs.push(structuredClone(o));
        return opts.runModel
          ? opts.runModel(o)
          : Promise.resolve({ resources: [{ name: `m${runs.length}` }] });
      },
    },
  };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as unknown as Record<string, MethodEntry>)[
    name
  ];
  return method.execute(method.arguments.parse(args), ctx);
}

// ============================================================================
// severityRank / routing boundaries
// ============================================================================

Deno.test("guard: severityRank floors unknown values instead of throwing", () => {
  assertEquals(severityRank("info"), 0);
  assertEquals(severityRank("critical"), 3);
  assertEquals(severityRank("nonsense"), 0);
  assertEquals(severityRank(""), 0);
});

Deno.test("guard: broadcastFrom is inclusive at the boundary", () => {
  const cfg = { dispatch: "failover", broadcastFrom: "urgent" };
  assertEquals(shouldBroadcast(cfg, "concern"), false);
  assertEquals(shouldBroadcast(cfg, "urgent"), true, "boundary is inclusive");
  assertEquals(shouldBroadcast(cfg, "critical"), true);
});

Deno.test("guard: dispatch=broadcast overrides the severity threshold", () => {
  const cfg = { dispatch: "broadcast", broadcastFrom: "critical" };
  assertEquals(shouldBroadcast(cfg, "info"), true);
});

Deno.test("guard: eligibleChannels preserves configured priority order", () => {
  const chans = [
    channel({ name: "a" }),
    channel({ name: "b", enabled: false }),
    channel({ name: "c", minSeverity: "critical" }),
    channel({ name: "d" }),
  ];
  assertEquals(
    eligibleChannels(chans, "urgent").map((c) => c.name),
    ["a", "d"],
  );
  assertEquals(
    eligibleChannels(chans, "critical").map((c) => c.name),
    ["a", "c", "d"],
  );
});

// ============================================================================
// Rate limiting
// ============================================================================

Deno.test("guard: the rate cap triggers at the cap, not above it", () => {
  const cfg = { maxCallsPerHour: 3, criticalBypassesRateLimit: true };
  assertEquals(isRateLimited(["a", "b"], cfg, "info"), false);
  assertEquals(isRateLimited(["a", "b", "c"], cfg, "info"), true);
});

Deno.test("guard: the critical bypass can be turned off", () => {
  const recent = ["a", "b", "c"];
  assertEquals(
    isRateLimited(recent, {
      maxCallsPerHour: 3,
      criticalBypassesRateLimit: false,
    }, "critical"),
    true,
  );
  assertEquals(
    isRateLimited(recent, {
      maxCallsPerHour: 3,
      criticalBypassesRateLimit: true,
    }, "critical"),
    false,
  );
});

Deno.test("guard: pruneStamps drops stale and unparseable entries", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const stamps = [
    "2026-08-09T10:59:00.000Z", // outside a 1h window
    "2026-08-09T11:30:00.000Z", // inside
    "garbage",
    "2026-08-09T12:00:00.000Z", // now
  ];
  assertEquals(pruneStamps(stamps, now, 3_600_000), [
    "2026-08-09T11:30:00.000Z",
    "2026-08-09T12:00:00.000Z",
  ]);
});

Deno.test("guard: the throttle notice goes to the TOP eligible channel", async () => {
  const h = makeCtx({
    globals: {
      channels: [
        channel({ name: "primary", definition: "first" }),
        channel({ name: "backup", definition: "second" }),
      ],
      maxCallsPerHour: 1,
    },
  });
  await run("call", { summary: "one", dedupeKey: "a" }, h.ctx);
  await run("call", { summary: "two", dedupeKey: "b" }, h.ctx);
  assertEquals(h.runs.length, 2);
  assertEquals(h.runs[1].definition, "first");
});

// ============================================================================
// Dedupe
// ============================================================================

Deno.test("guard: dedupeWindowSeconds=0 disables dedupe entirely", async () => {
  const h = makeCtx({
    globals: { channels: [channel()], dedupeWindowSeconds: 0 },
  });
  await run("call", { summary: "same", dedupeKey: "k" }, h.ctx);
  await run("call", { summary: "same", dedupeKey: "k" }, h.ctx);
  assertEquals(h.runs.length, 2);
  const beacon = h.store.current as { calls: unknown[] };
  assertEquals(beacon.calls.length, 2);
});

Deno.test("guard: findOpenDuplicate ignores resolved calls", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const calls = [entry({ callId: "dc-1", status: "resolved" })];
  assertEquals(findOpenDuplicate(calls, "k", now, 900), null);
  assertEquals(
    findOpenDuplicate([entry({ status: "acked" })], "k", now, 900)?.callId,
    "dc-1",
    "an acked call is still the same incident",
  );
});

Deno.test("guard: findOpenDuplicate honours the window edge", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const inside = [entry({ lastSeenAt: "2026-08-09T11:45:00.000Z" })];
  const outside = [entry({ lastSeenAt: "2026-08-09T11:44:59.000Z" })];
  assert(findOpenDuplicate(inside, "k", now, 900) !== null);
  assertEquals(findOpenDuplicate(outside, "k", now, 900), null);
});

Deno.test("guard: findOpenDuplicate prefers the most recent match", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const calls = [
    entry({ callId: "old", lastSeenAt: "2026-08-09T11:50:00.000Z" }),
    entry({ callId: "new", lastSeenAt: "2026-08-09T11:59:00.000Z" }),
  ];
  assertEquals(findOpenDuplicate(calls, "k", now, 900)?.callId, "new");
});

Deno.test("guard: the derived key separates agents but folds digit runs", () => {
  const a = deriveDedupeKey({ category: "stuck", summary: "retry 1 failed" });
  const b = deriveDedupeKey({
    category: "stuck",
    summary: "retry 9999 failed",
  });
  assertEquals(a, b, "a counting loop is one incident");

  const withAgent = deriveDedupeKey({
    category: "stuck",
    summary: "retry 1 failed",
    agentName: "worker-a",
  });
  assert(withAgent !== a, "different agents are different incidents");

  const otherCategory = deriveDedupeKey({
    category: "welfare",
    summary: "retry 1 failed",
  });
  assert(otherCategory !== a, "different categories are different incidents");
});

Deno.test("guard: normalizeSummary is case- and whitespace-insensitive", () => {
  assertEquals(
    normalizeSummary("  Retry   12\tFAILED\n"),
    "retry # failed",
  );
});

Deno.test("guard: escalation only resets its counter on a PROVEN send", async () => {
  // If a failed escalation reset the counter, the next escalation would be
  // another N repeats away — the call would go quiet exactly when it is
  // getting worse.
  let allowed = false;
  const h = makeCtx({
    globals: { channels: [channel()], escalateAfterRepeats: 2 },
    runModel: () =>
      Promise.resolve(
        allowed ? { resources: [{ name: "m" }] } : { resources: [] },
      ),
  });
  allowed = true;
  await run("call", { summary: "s", dedupeKey: "k" }, h.ctx);
  allowed = false;
  await run("call", { summary: "s", dedupeKey: "k" }, h.ctx);
  await run("call", { summary: "s", dedupeKey: "k" }, h.ctx); // escalation, fails

  const beacon = h.store.current as {
    calls: Array<{ callId: string }>;
    totals: { failed: number };
  };
  const call = h.store[beacon.calls[0].callId] as Call;
  assertEquals(call.escalations, 0);
  assertEquals(call.repeatsSinceEscalation, 2, "counter is NOT reset");
  assertEquals(beacon.totals.failed, 1);

  allowed = true;
  await run("call", { summary: "s", dedupeKey: "k" }, h.ctx);
  const retried = h.store[beacon.calls[0].callId] as Call;
  assertEquals(
    retried.escalations,
    1,
    "the next repeat retries the escalation",
  );
});

// ============================================================================
// Index maintenance
// ============================================================================

Deno.test("guard: upsertEntry replaces rather than appends a known call", () => {
  const calls = [entry({ callId: "a" }), entry({ callId: "b" })];
  const next = upsertEntry(calls, entry({ callId: "a", repeats: 7 }), 100);
  assertEquals(next.length, 2);
  assertEquals(next.map((c) => c.callId), ["b", "a"]);
  assertEquals(next[1].repeats, 7);
});

Deno.test("guard: upsertEntry never exceeds the history limit", () => {
  let calls: IndexEntry[] = [];
  for (let i = 0; i < 50; i++) {
    calls = upsertEntry(
      calls,
      entry({ callId: `dc-${i}`, status: "resolved" }),
      10,
    );
    assert(calls.length <= 10, `index grew to ${calls.length}`);
  }
  assertEquals(calls.length, 10);
  assertEquals(calls[9].callId, "dc-49", "the newest is always kept");
});

Deno.test("guard: pruning sacrifices resolved calls before live ones", () => {
  let calls: IndexEntry[] = [];
  for (let i = 0; i < 5; i++) {
    calls = upsertEntry(calls, entry({ callId: `open-${i}` }), 6);
  }
  for (let i = 0; i < 5; i++) {
    calls = upsertEntry(
      calls,
      entry({ callId: `done-${i}`, status: "resolved" }),
      6,
    );
  }
  assertEquals(calls.length, 6);
  assertEquals(calls.filter((c) => c.status !== "resolved").length, 5);
  assertEquals(calls.filter((c) => c.status === "resolved").length, 1);
});

Deno.test("guard: toIndexEntry surfaces the ack note for the agent", () => {
  const bare = toIndexEntry(sampleCall());
  assertEquals(bare.ackNote, undefined);
  const acked = toIndexEntry(sampleCall({
    acknowledgement: { at: "2026-08-09T12:00:00.000Z", note: "use plan B" },
  }));
  assertEquals(acked.ackNote, "use plan B");
});

Deno.test("guard: filterCalls covers the whole status vocabulary", () => {
  const calls = [
    entry({ callId: "o", status: "open" }),
    entry({ callId: "a", status: "acked" }),
    entry({ callId: "r", status: "resolved" }),
  ];
  assertEquals(filterCalls(calls, "open").map((c) => c.callId), ["o"]);
  assertEquals(filterCalls(calls, "acked").map((c) => c.callId), ["a"]);
  assertEquals(filterCalls(calls, "resolved").map((c) => c.callId), ["r"]);
  assertEquals(filterCalls(calls, "unresolved").map((c) => c.callId), [
    "o",
    "a",
  ]);
  assertEquals(filterCalls(calls, "all").length, 3);
});

Deno.test("guard: filterCalls returns a copy, not the live index", () => {
  const calls = [entry()];
  const all = filterCalls(calls, "all");
  all.pop();
  assertEquals(calls.length, 1);
});

Deno.test("guard: soleOpenCallId refuses both ambiguity and emptiness", () => {
  const beacon = emptyBeacon("2026-08-09T12:00:00.000Z");
  assertThrows(
    () => soleOpenCallId(beacon),
    Error,
    "No unresolved distress calls",
  );
  beacon.calls = [entry({ callId: "a" }), entry({ callId: "b" })];
  assertThrows(() => soleOpenCallId(beacon), Error, "pass callId explicitly");
  beacon.calls = [
    entry({ callId: "a" }),
    entry({
      callId: "b",
      status: "resolved",
    }),
  ];
  assertEquals(soleOpenCallId(beacon), "a");
});

Deno.test("guard: emptyBeacon starts every counter at zero", () => {
  const b = emptyBeacon("2026-08-09T12:00:00.000Z");
  assertEquals(b.calls, []);
  assertEquals(b.deliveries, []);
  assertEquals(b.suppressedSinceNotice, 0);
  assertEquals(
    b.totals,
    { raised: 0, delivered: 0, deduped: 0, suppressed: 0, failed: 0 },
  );
});

// ============================================================================
// Rendering
// ============================================================================

Deno.test("guard: truncate marks the cut and never exceeds the bound", () => {
  assertEquals(truncate("short", 10), "short");
  const cut = truncate("x".repeat(100), 20);
  assertEquals(cut.length, 20);
  assertStringIncludes(cut, "[truncated]");
  // A bound smaller than the marker still respects the bound.
  assertEquals(truncate("x".repeat(100), 5).length, 5);
});

Deno.test("guard: escapeFor falls back to plain for an unknown format", () => {
  assertEquals(escapeFor("a < b", "plain"), "a < b");
  assertEquals(escapeFor("a < b", "klingon"), "a < b");
  assertEquals(escapeFor("a < b", "html"), "a &lt; b");
});

Deno.test("guard: only present fields appear in the body", () => {
  const bare = buildMessage(sampleCall(), {
    instance: "distress",
    format: "plain",
    maxChars: 3500,
    kind: "initial",
  });
  assert(!bare.body.includes("Task:"));
  assert(!bare.body.includes("Suggested:"));
  assert(!bare.body.includes("Agent:"));
  assert(!bare.body.includes("For:"));

  const full = buildMessage(
    sampleCall({
      task: "t",
      suggestedAction: "sa",
      agent: { name: "n", model: "m", session: "s", host: "h" },
    }),
    {
      instance: "distress",
      format: "plain",
      maxChars: 3500,
      kind: "initial",
      operator: "mag1",
    },
  );
  assertStringIncludes(full.body, "Task: t");
  assertStringIncludes(full.body, "Suggested: sa");
  assertStringIncludes(full.body, "Agent: n (m)");
  assertStringIncludes(full.body, "Session: s");
  assertStringIncludes(full.body, "Host: h");
  assertStringIncludes(full.body, "For: mag1");
});

Deno.test("guard: an escalation page says so in its headline", () => {
  const msg = buildMessage(
    sampleCall({ category: "stuck", repeats: 12 }),
    {
      instance: "distress",
      format: "plain",
      maxChars: 3500,
      kind: "escalation",
    },
  );
  assertStringIncludes(msg.title, "STILL STUCK (12 repeats)");
  assertStringIncludes(msg.body, "Unresolved since");
});

Deno.test("guard: the throttle notice renders in the channel's format", () => {
  const html = buildRateNotice({
    suppressed: 4,
    latestSummary: "a < b",
    instance: "distress",
    format: "html",
    maxChars: 3500,
    maxCallsPerHour: 12,
  });
  assertStringIncludes(html.text, "<b>");
  assertStringIncludes(html.text, "a &lt; b");

  const plain = buildRateNotice({
    suppressed: 4,
    latestSummary: "a < b",
    instance: "distress",
    format: "plain",
    maxChars: 3500,
    maxCallsPerHour: 12,
  });
  assert(!plain.text.includes("<b>"));
});

Deno.test("guard: messageFields exposes empty strings, never undefined", () => {
  const call = sampleCall();
  const fields = messageFields(
    buildMessage(call, {
      instance: "distress",
      format: "plain",
      maxChars: 3500,
      kind: "initial",
    }),
    call,
  );
  for (const [key, value] of Object.entries(fields)) {
    assertEquals(typeof value, "string", `${key} is not a string`);
  }
  assertEquals(fields.task, "");
  assertEquals(fields.agentName, "");
});

Deno.test("guard: a template placeholder must be exactly {{word}}", () => {
  const call = sampleCall();
  const fields = messageFields(
    buildMessage(call, {
      instance: "distress",
      format: "plain",
      maxChars: 3500,
      kind: "initial",
    }),
    call,
  );
  const args = buildChannelArgs(
    channel({
      arguments: {
        a: "{{ summary }}",
        b: "{{summary}}",
        c: "{{summary}}{{summary}}",
        d: "{{sum-mary}}",
      },
    }),
    fields,
  );
  assertEquals(args.a, "{{ summary }}", "spaces are not a placeholder");
  assertEquals(args.b, "s");
  assertEquals(args.c, "ss", "every occurrence is replaced");
  assertEquals(args.d, "{{sum-mary}}", "only \\w+ is a placeholder");
});

Deno.test("guard: non-string channel arguments pass through untouched", () => {
  const call = sampleCall();
  const args = buildChannelArgs(
    channel({
      arguments: { disableWebPagePreview: true, replyToMessageId: 42 },
    }),
    messageFields(
      buildMessage(call, {
        instance: "distress",
        format: "plain",
        maxChars: 3500,
        kind: "initial",
      }),
      call,
    ),
  );
  assertEquals(args.disableWebPagePreview, true);
  assertEquals(args.replyToMessageId, 42);
});

// ============================================================================
// Ids and redaction
// ============================================================================

Deno.test("guard: makeCallId is deterministic and shaped for sorting", () => {
  const iso = "2026-08-09T14:22:33.123Z";
  const id = makeCallId(iso, "k", 0);
  assertEquals(id, makeCallId(iso, "k", 0), "no randomness");
  assert(id.startsWith("dc-20260809T142233Z-"), `unexpected shape: ${id}`);
  assert(makeCallId(iso, "other", 0) !== id, "the key participates");
});

Deno.test("guard: same-instant calls get distinct ids", () => {
  // Regression: the id was once (instant, dedupeKey) only, so two distinct
  // calls raised in the same millisecond with the same key collided and the
  // second silently OVERWROTE the first's record.
  const iso = "2026-08-09T14:22:33.123Z";
  const ids = new Set([0, 1, 2, 3, 4].map((n) => makeCallId(iso, "same", n)));
  assertEquals(ids.size, 5);
});

Deno.test("guard: fnv1a is stable and fixed-width", () => {
  assertEquals(fnv1a("").length, 8);
  assertEquals(fnv1a("abc"), fnv1a("abc"));
  assert(fnv1a("abc") !== fnv1a("abd"));
});

Deno.test("guard: redactSecrets leaves ordinary errors readable", () => {
  const plain = "connection refused talking to tg-bot";
  assertEquals(redactSecrets(plain), plain);
});

Deno.test("guard: redaction covers each pattern independently", () => {
  assertStringIncludes(
    redactSecrets("GET /bot123:ABC/sendMessage"),
    "/bot<redacted>/",
  );
  assertStringIncludes(
    redactSecrets("Authorization: Bearer abc.def.ghi"),
    "Bearer <redacted>",
  );
  assertStringIncludes(redactSecrets("token=abc123"), "token=<redacted>");
  assertStringIncludes(
    redactSecrets("postgres://u:p@host/db"),
    "postgres://<redacted>@host/db",
  );
});

// ============================================================================
// Method-level guards
// ============================================================================

Deno.test("guard: resolve on an unknown call is an error", async () => {
  const h = makeCtx({ globals: { channels: [channel()] } });
  await assertRejects(
    () => run("resolve", { callId: "dc-nope" }, h.ctx),
    Error,
    "No distress call",
  );
});

Deno.test("guard: ack refuses a resolved call", async () => {
  const h = makeCtx({ globals: { channels: [channel()] } });
  await run("call", { summary: "x" }, h.ctx);
  const beacon = h.store.current as { calls: Array<{ callId: string }> };
  const id = beacon.calls[0].callId;
  await run("resolve", { callId: id }, h.ctx);
  await assertRejects(
    () => run("ack", { callId: id }, h.ctx),
    Error,
    "already resolved",
  );
});

Deno.test("guard: historyLimit bounds the stored index under real traffic", async () => {
  const h = makeCtx({
    globals: {
      channels: [channel()],
      historyLimit: 10,
      maxCallsPerHour: 1000,
    },
  });
  for (let i = 0; i < 25; i++) {
    await run("call", { summary: `problem ${i}`, dedupeKey: `k${i}` }, h.ctx);
    await run("resolve", {
      callId: (h.store.current as { calls: Array<{ callId: string }> })
        .calls.at(-1)!.callId,
    }, h.ctx);
  }
  const beacon = h.store.current as { calls: unknown[]; totals: Stored };
  assertEquals(beacon.calls.length, 10);
  assertEquals(beacon.totals.raised, 25, "counters still see every call");
});

Deno.test("guard: no method writes a swamp-reserved data name", async () => {
  // `latest` is reserved by swamp for internal use and a write to it fails
  // the whole run — a failure no in-process fake can produce, so it is
  // asserted here explicitly. Found live: `list` and `test` both used
  // "latest" as their resource name and blew up on first real invocation.
  const RESERVED = new Set(["latest", "all", "any", "none"]);
  const h = makeCtx({ globals: { channels: [channel()] } });
  await run("call", { summary: "x" }, h.ctx);
  await run("list", {}, h.ctx);
  await run("test", { allowFailure: true }, h.ctx);
  const id = (h.store.current as { calls: Array<{ callId: string }> })
    .calls[0].callId;
  await run("ack", { callId: id }, h.ctx);
  await run("resolve", { callId: id }, h.ctx);

  for (const name of Object.keys(h.store)) {
    assert(
      !RESERVED.has(name),
      `resource name "${name}" is reserved by swamp`,
    );
  }
});

Deno.test("guard: the beacon resource is written on every mutating method", async () => {
  const h = makeCtx({ globals: { channels: [channel()] } });
  await run("call", { summary: "x" }, h.ctx);
  const afterCall = structuredClone(h.store.current);
  const id = (h.store.current as { calls: Array<{ callId: string }> })
    .calls[0].callId;

  await run("ack", { callId: id, note: "n" }, h.ctx);
  assert(
    JSON.stringify(h.store.current) !== JSON.stringify(afterCall),
    "ack did not update the index",
  );
  await run("resolve", { callId: id }, h.ctx);
  assertEquals(
    (h.store.current as { calls: Array<{ status: string }> }).calls[0].status,
    "resolved",
  );
});
