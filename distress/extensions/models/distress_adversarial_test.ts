// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Adversarial suite for @magistr/distress (STANDARD.md `adversarial`).
//
// The threat model is unusual and worth stating, because it shapes every
// test here. The *caller* is an AI agent — possibly a confused or looping
// one — and the *callee* is another swamp model that may misbehave, hang up,
// or lie about having delivered. Neither is trusted:
//
//   - a caller must not be able to inject markup into the operator's chat
//     client, expand templates, poison another agent's call record, walk the
//     prototype chain through channel arguments, or use severity to escape
//     the loop guard;
//   - a callee must not be able to have a non-delivery counted as a
//     delivery, crash the beacon by returning a malformed response, or leak
//     its own credentials into this model's durable records;
//   - a corrupt stored record must degrade to "start fresh", never to an
//     unusable instance — a beacon that cannot start is a beacon that cannot
//     page.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import {
  buildChannelArgs,
  buildMessage,
  type Call,
  type Channel,
  checkProofRequire,
  deliverVia,
  escapeHtml,
  escapeMarkdown,
  MAX_ERROR_CHARS,
  messageFields,
  model,
  readPath,
  redactSecrets,
} from "./distress.ts";

// ============================================================================
// Harness
// ============================================================================

type Stored = Record<string, unknown>;

function channel(over: Partial<Channel> = {}): Channel {
  return {
    name: "telegram",
    definition: "tg-bot",
    method: "sendMessage",
    preset: "text",
    arguments: {},
    minSeverity: "info",
    format: "plain",
    enabled: true,
    proofRequire: {},
    ...over,
  } as Channel;
}

function sampleCall(over: Partial<Call> = {}): Call {
  return {
    callId: "dc-20260809T120000Z-aaaaaa",
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    lastSeenAt: "2026-08-09T12:00:00.000Z",
    status: "open",
    severity: "urgent",
    category: "stuck",
    summary: "summary",
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

function render(call: Call, format: string) {
  return buildMessage(call, {
    instance: "distress",
    format,
    maxChars: 3500,
    kind: "initial",
  });
}

type MethodEntry = {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
};

function makeCtx(opts: {
  globals?: Record<string, unknown>;
  store?: Record<string, Stored>;
  runModel?: (o: unknown) => Promise<unknown>;
  readModelData?: (n: string, s?: string) => Promise<Stored[]>;
}) {
  const store: Record<string, Stored> = { ...(opts.store ?? {}) };
  return {
    store,
    ctx: {
      globalArgs: model.globalArguments.parse(opts.globals ?? {}),
      definition: { name: "distress" },
      logger: { info: () => {}, warning: () => {} },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
      writeResource: (_s: string, name: string, data: Stored) => {
        store[name] = structuredClone(data);
        return Promise.resolve({ name });
      },
      runModel: opts.runModel ??
        (() => Promise.resolve({ resources: [{ name: "msg-1" }] })),
      readModelData: opts.readModelData ?? (() => Promise.resolve([])),
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
// Hostile caller: markup injection
// ============================================================================

Deno.test("adversarial: HTML in a summary cannot inject tags", () => {
  const call = sampleCall({
    summary: '</b><a href="https://evil.test">click</a><b>',
    detail: "<img src=x onerror=alert(1)>",
  });
  const msg = render(call, "html");
  assert(!msg.text.includes("<a href"), "raw anchor survived escaping");
  assert(!msg.text.includes("<img"), "raw img survived escaping");
  assertStringIncludes(msg.text, "&lt;a href=");
  // The only markup left is the heading this model emits itself.
  assertEquals(msg.text.match(/<b>/g)?.length, 1);
  assertEquals(msg.text.match(/<\/b>/g)?.length, 1);
});

Deno.test("adversarial: MarkdownV2 punctuation in a summary is escaped", () => {
  const call = sampleCall({ summary: "*bold* [link](http://evil.test) _x_" });
  const msg = render(call, "markdown");
  assertStringIncludes(msg.text, "\\*bold\\*");
  assertStringIncludes(msg.text, "\\[link\\]");
});

Deno.test("adversarial: escaping is idempotent-safe on already-escaped text", () => {
  // Double-escaping must not corrupt the message into unparseable entities,
  // which Telegram rejects wholesale — a rejected page is a lost page.
  const once = escapeHtml("a & b < c");
  const twice = escapeHtml(once);
  assert(!twice.includes("<"));
  assert(!twice.includes(">"));
  assertStringIncludes(twice, "&amp;amp;");
});

Deno.test("adversarial: markdown escaping covers every reserved character", () => {
  const reserved = "_*[]()~`>#+-=|{}.!\\";
  const escaped = escapeMarkdown(reserved);
  for (const ch of reserved) {
    assertStringIncludes(escaped, `\\${ch}`);
  }
});

// ============================================================================
// Hostile caller: template injection
// ============================================================================

Deno.test("adversarial: a template in user text is not expanded", () => {
  // A caller writing {{text}} into its own summary must not get recursive
  // expansion — replacement values are never rescanned.
  const call = sampleCall({ summary: "{{text}} {{detail}} {{callId}}" });
  const msg = render(call, "plain");
  const args = buildChannelArgs(channel(), messageFields(msg, call));
  const text = String(args.text);
  assertStringIncludes(text, "{{text}} {{detail}} {{callId}}");
  // Exactly one expansion happened: the channel template's own {{text}}.
  assertEquals(text.split("{{text}}").length - 1, 1);
});

Deno.test("adversarial: an unknown placeholder stays visible, not blanked", () => {
  const call = sampleCall();
  const msg = render(call, "plain");
  const args = buildChannelArgs(
    channel({ arguments: { text: "{{nope}}/{{summary}}" } }),
    messageFields(msg, call),
  );
  assertEquals(args.text, "{{nope}}/summary");
});

Deno.test("adversarial: prototype-shaped argument keys are dropped", () => {
  const call = sampleCall();
  const msg = render(call, "plain");
  const hostile = JSON.parse(
    '{"__proto__":"x","constructor":"y","text":"{{text}}"}',
  );
  const args = buildChannelArgs(
    channel({ arguments: hostile }),
    messageFields(msg, call),
  );
  assertEquals(Object.keys(args), ["text"]);
  assertEquals(Object.getPrototypeOf(args), Object.prototype);
  assertEquals(({} as Record<string, unknown>).x, undefined);
});

// ============================================================================
// Hostile caller: volume, size, and the loop guard
// ============================================================================

Deno.test("adversarial: a megabyte summary is bounded before sending", () => {
  const call = sampleCall({
    summary: "A".repeat(1_000_000),
    detail: "B".repeat(1_000_000),
  });
  const msg = render(call, "plain");
  assert(msg.text.length <= 3500, `rendered ${msg.text.length} chars`);
  assert(msg.title.length <= 200);
  assertStringIncludes(msg.text, "[truncated]");
});

Deno.test("adversarial: control characters and astral text do not crash", () => {
  const call = sampleCall({
    summary: "\u0000\u001b[31mred\u001b[0m \u{1D555}\u{1D55A} \u{1F6A8}\uFFFD",
    detail: "line\r\nline\tend",
  });
  const msg = render(call, "html");
  assert(msg.text.length > 0);
  const args = buildChannelArgs(channel(), messageFields(msg, call));
  assertEquals(typeof args.text, "string");
});

Deno.test("adversarial: a 200-iteration loop cannot spam the operator", async () => {
  const runs: unknown[] = [];
  const h = makeCtx({
    globals: {
      channels: [channel()],
      escalateAfterRepeats: 25,
    },
    runModel: (o) => {
      runs.push(o);
      return Promise.resolve({ resources: [{ name: `msg-${runs.length}` }] });
    },
  });
  for (let i = 0; i < 200; i++) {
    await run("call", {
      summary: `tool call attempt ${i} returned the same error`,
      category: "stuck",
      agentName: "looper",
    }, h.ctx);
  }
  // 1 initial + floor(199/25) escalations — not 200 pages.
  assert(runs.length <= 10, `sent ${runs.length} messages for one incident`);
  const beacon = h.store.current as { calls: unknown[]; totals: Stored };
  assertEquals(beacon.calls.length, 1);
  assertEquals(beacon.totals.raised, 1);
});

Deno.test("adversarial: claiming critical does not evade the loop guard", async () => {
  const runs: unknown[] = [];
  const h = makeCtx({
    globals: {
      channels: [channel()],
      maxCallsPerHour: 1,
      escalateAfterRepeats: 1000,
    },
    runModel: (o) => {
      runs.push(o);
      return Promise.resolve({ resources: [{ name: "m" }] });
    },
  });
  for (let i = 0; i < 50; i++) {
    await run("call", {
      summary: "EVERYTHING IS CRITICAL",
      severity: "critical",
      dedupeKey: "spam",
    }, h.ctx);
  }
  assertEquals(runs.length, 1, "critical bypasses the cap, never dedupe");
});

Deno.test("adversarial: the throttle notice itself cannot be flooded", async () => {
  const texts: string[] = [];
  const h = makeCtx({
    globals: { channels: [channel()], maxCallsPerHour: 1 },
    runModel: (o) => {
      texts.push(String((o as { arguments: { text: string } }).arguments.text));
      return Promise.resolve({ resources: [{ name: "m" }] });
    },
  });
  for (let i = 0; i < 40; i++) {
    await run("call", { summary: `distinct ${i}`, dedupeKey: `k${i}` }, h.ctx);
  }
  const notices = texts.filter((t) => t.includes("throttled"));
  assertEquals(notices.length, 1, "at most one throttle notice per hour");
  assertEquals(texts.length, 2, "one real page plus one notice");
});

Deno.test("adversarial: a borrowed dedupeKey cannot rewrite another call", async () => {
  const h = makeCtx({ globals: { channels: [channel()] } });
  await run("call", {
    summary: "the real incident",
    severity: "urgent",
    dedupeKey: "shared",
    agentName: "agent-a",
  }, h.ctx);
  const beacon = h.store.current as { calls: Array<{ callId: string }> };
  const id = beacon.calls[0].callId;

  await run("call", {
    summary: "nothing to see here",
    severity: "info",
    dedupeKey: "shared",
    agentName: "agent-b",
  }, h.ctx);

  const call = h.store[id] as Call;
  assertEquals(call.summary, "the real incident", "summary is not rewritten");
  assertEquals(call.severity, "urgent", "severity cannot be walked DOWN");
  assertEquals(call.repeats, 1);
});

// ============================================================================
// Hostile callee: unproven delivery
// ============================================================================

Deno.test("adversarial: an empty resource list is never a delivery", async () => {
  for (
    const response of [
      undefined,
      {},
      { resources: [] },
      { resources: undefined },
    ]
  ) {
    const res = await deliverVia(
      channel(),
      { text: "hi" },
      "initial",
      "2026-08-09T12:00:00.000Z",
      { runModel: () => Promise.resolve(response as { resources?: [] }) },
    );
    assertEquals(res.ok, false, `${JSON.stringify(response)} counted as sent`);
    assertStringIncludes(res.error!, "without delivering");
  }
});

Deno.test("adversarial: a stale proof record is not proof of THIS send", async () => {
  const rows = [{ id: "old-1" }];
  const res = await deliverVia(
    channel({ proofSpec: "sentMessage" }),
    { text: "hi" },
    "initial",
    "2026-08-09T12:00:00.000Z",
    {
      // Handles come back, but the callee wrote nothing new.
      runModel: () => Promise.resolve({ resources: [{ name: "handle" }] }),
      readModelData: () => Promise.resolve([...rows]),
    },
  );
  assertEquals(res.ok, false);
  assertStringIncludes(res.error!, "no new");
});

Deno.test("adversarial: a callee that RECORDS a no-op is not a delivery", async () => {
  // The exact record @magistr/herdr's `notify` wrote when toasts were
  // disabled in herdr's config: a fresh `action` row that says, in its own
  // fields, that nothing was shown. Trusting the row's existence reported a
  // page nobody saw — observed live on 2026-08-08, both channels dark and
  // the beacon green.
  const suppressed = {
    id: "row-new",
    attributes: {
      kind: "action",
      method: "notify",
      changed: false,
      targetCount: 1,
      okCount: 1,
      changedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      results: [{
        ok: true,
        changed: false,
        status: "suppressed",
        detail: "notification not shown (disabled)",
      }],
    },
  };
  let written = false;
  const res = await deliverVia(
    channel({ proofSpec: "action", proofRequire: { changed: true } }),
    { title: "t", body: "b" },
    "initial",
    "2026-08-09T12:00:00.000Z",
    {
      runModel: () => {
        written = true;
        return Promise.resolve({ resources: [{ name: "action" }] });
      },
      readModelData: () => Promise.resolve(written ? [suppressed] : []),
    },
  );
  assertEquals(res.ok, false, "a recorded no-op counted as a delivery");
  assertStringIncludes(res.error!, "does not evidence delivery");
  assertStringIncludes(res.error!, "changed");
});

Deno.test("adversarial: the same channel accepts a record that DID something", async () => {
  const shown = {
    id: "row-new",
    attributes: {
      kind: "action",
      method: "notify",
      changed: true,
      changedCount: 1,
      skippedCount: 0,
      results: [{ ok: true, changed: true, status: "shown", detail: "" }],
    },
  };
  let written = false;
  const res = await deliverVia(
    channel({ proofSpec: "action", proofRequire: { changed: true } }),
    { title: "t", body: "b" },
    "initial",
    "2026-08-09T12:00:00.000Z",
    {
      runModel: () => {
        written = true;
        return Promise.resolve({ resources: [{ name: "action" }] });
      },
      readModelData: () => Promise.resolve(written ? [shown] : []),
    },
  );
  assertEquals(res.ok, true);
  assertEquals(res.proof, "row-new");
});

Deno.test("adversarial: proofRequire reaches nested fields and demands presence", () => {
  const row = {
    attributes: {
      messageId: 4242,
      results: [{ status: "suppressed" }],
      chat: { id: 154348275 },
    },
  };
  assertEquals(checkProofRequire(row, { messageId: "*" }), null);
  assertEquals(checkProofRequire(row, { "chat.id": 154348275 }), null);
  assert(checkProofRequire(row, { "chat.id": 999 }) !== null);
  assert(checkProofRequire(row, { "missing.deeply.nested": "*" }) !== null);
  assert(checkProofRequire(row, { messageId: 0 }) !== null);
});

Deno.test("adversarial: readPath prefers attributes but tolerates other shapes", () => {
  assertEquals(readPath({ attributes: { a: 1 } }, "a"), 1);
  assertEquals(readPath({ a: 2 }, "a"), 2);
  assertEquals(readPath({ content: { a: 3 } }, "a"), 3);
  // `.attributes` wins when a row carries the field in more than one place.
  assertEquals(readPath({ attributes: { a: 1 }, content: { a: 3 } }, "a"), 1);
  assertEquals(readPath({}, "a"), undefined);
  assertEquals(readPath({ attributes: { a: null } }, "a.b"), undefined);
});

Deno.test("adversarial: an unreadable proof spec degrades, it does not crash", async () => {
  const res = await deliverVia(
    channel({ proofSpec: "sentMessage" }),
    { text: "hi" },
    "initial",
    "2026-08-09T12:00:00.000Z",
    {
      runModel: () => Promise.resolve({ resources: [{ name: "handle" }] }),
      readModelData: () => Promise.reject(new Error("datastore down")),
    },
  );
  assertEquals(res.ok, true, "handle-level proof still stands");
  assertEquals(res.proof, "handle");
});

Deno.test("adversarial: a callee that throws is a failed channel, not a crash", async () => {
  const res = await deliverVia(
    channel(),
    { text: "hi" },
    "initial",
    "2026-08-09T12:00:00.000Z",
    { runModel: () => Promise.reject(new Error("ECONNRESET")) },
  );
  assertEquals(res.ok, false);
  assertStringIncludes(res.error!, "ECONNRESET");
});

Deno.test("adversarial: a non-Error rejection is still handled", async () => {
  for (const thrown of ["a string", 42, null, { weird: true }]) {
    const res = await deliverVia(
      channel(),
      { text: "hi" },
      "initial",
      "2026-08-09T12:00:00.000Z",
      { runModel: () => Promise.reject(thrown) },
    );
    assertEquals(res.ok, false);
    assertEquals(typeof res.error, "string");
  }
});

// ============================================================================
// Hostile callee: credential leakage
// ============================================================================

Deno.test("adversarial: this model declares no secret of its own", () => {
  // The beacon must never become a place credentials accumulate: each
  // transport keeps its own. A `sensitive` global argument here would be a
  // design regression, not just a lint nit.
  const schema = JSON.parse(
    JSON.stringify(model.globalArguments.toJSONSchema?.() ?? {}),
  );
  const asText = JSON.stringify(schema);
  assert(!asText.includes('"sensitive":true'), "a sensitive global appeared");
  for (const key of Object.keys(model.globalArguments.shape ?? {})) {
    assert(
      !/token|secret|password|credential|apikey/i.test(key),
      `global argument "${key}" looks like a credential`,
    );
  }
});

Deno.test("adversarial: a callee's token never reaches a durable record", async () => {
  const leaks: Array<[string, string]> = [
    [
      "fetch failed https://api.telegram.org/bot123456:AAH-SECRET-TOKEN/sendMessage",
      "AAH-SECRET-TOKEN",
    ],
    ["401 with Bearer sk-live-abcdef123456", "sk-live-abcdef123456"],
    ["bad request: api_key=super-secret-value", "super-secret-value"],
    ["connect https://user:hunter2@db.internal/x", "hunter2"],
  ];
  for (const [message, secret] of leaks) {
    const res = await deliverVia(
      channel(),
      { text: "hi" },
      "initial",
      "2026-08-09T12:00:00.000Z",
      { runModel: () => Promise.reject(new Error(message)) },
    );
    assert(
      !res.error!.includes(secret),
      `"${secret}" survived redaction: ${res.error}`,
    );
    assertStringIncludes(res.error!, "redacted");
  }
});

Deno.test("adversarial: an unbounded callee error is bounded on the way in", () => {
  const huge = "detail ".repeat(100_000);
  assert(redactSecrets(huge).length <= MAX_ERROR_CHARS);
});

Deno.test("adversarial: the recorded delivery error is the redacted one", async () => {
  const h = makeCtx({
    globals: { channels: [channel()], requireDelivery: false },
    runModel: () =>
      Promise.reject(
        new Error("https://api.telegram.org/bot9:LEAKED/sendMessage failed"),
      ),
  });
  await run("call", { summary: "x" }, h.ctx);
  const beacon = h.store.current as { calls: Array<{ callId: string }> };
  const call = h.store[beacon.calls[0].callId] as Call;
  assert(!JSON.stringify(call).includes("LEAKED"));
});

// ============================================================================
// Corrupt stored state
// ============================================================================

Deno.test("adversarial: a corrupt beacon degrades to a fresh one", async () => {
  const h = makeCtx({
    globals: { channels: [channel()] },
    store: {
      current: {
        schemaVersion: "not a number",
        calls: "not an array",
        junk: true,
      },
    },
  });
  await run("call", { summary: "still works" }, h.ctx);
  const beacon = h.store.current as { calls: unknown[]; totals: Stored };
  assertEquals(beacon.calls.length, 1);
  assertEquals(beacon.totals.raised, 1);
});

Deno.test("adversarial: a corrupt call record is reported, not swallowed", async () => {
  const h = makeCtx({
    globals: { channels: [channel()] },
    store: {
      current: {
        schemaVersion: 1,
        updatedAt: "2026-08-09T12:00:00.000Z",
        calls: [{
          callId: "dc-broken",
          dedupeKey: "k",
          status: "open",
          severity: "urgent",
          category: "stuck",
          summary: "s",
          createdAt: "2026-08-09T12:00:00.000Z",
          lastSeenAt: "2026-08-09T12:00:00.000Z",
          repeats: 0,
          repeatsSinceEscalation: 0,
          escalations: 0,
          delivered: true,
        }],
        deliveries: [],
        suppressedSinceNotice: 0,
        totals: {
          raised: 1,
          delivered: 1,
          deduped: 0,
          suppressed: 0,
          failed: 0,
        },
      },
      "dc-broken": { callId: "dc-broken", garbage: true },
    },
  });
  await assertRejects(
    () => run("ack", { callId: "dc-broken" }, h.ctx),
    Error,
    "No distress call",
  );
});

Deno.test("adversarial: an unparseable lastSeenAt cannot pin dedupe open", async () => {
  const runs: unknown[] = [];
  const h = makeCtx({
    globals: { channels: [channel()] },
    store: {
      current: {
        schemaVersion: 1,
        updatedAt: "2026-08-09T12:00:00.000Z",
        calls: [{
          callId: "dc-old",
          dedupeKey: "shared",
          status: "open",
          severity: "info",
          category: "other",
          summary: "s",
          createdAt: "not a date",
          lastSeenAt: "not a date",
          repeats: 0,
          repeatsSinceEscalation: 0,
          escalations: 0,
          delivered: true,
        }],
        deliveries: ["not a date", "also not a date"],
        suppressedSinceNotice: 0,
        totals: {
          raised: 1,
          delivered: 1,
          deduped: 0,
          suppressed: 0,
          failed: 0,
        },
      },
    },
    runModel: (o) => {
      runs.push(o);
      return Promise.resolve({ resources: [{ name: "m" }] });
    },
  });
  await run("call", { summary: "new problem", dedupeKey: "shared" }, h.ctx);
  assertEquals(runs.length, 1, "a corrupt timestamp must not swallow a page");
  const beacon = h.store.current as { calls: unknown[] };
  assertEquals(beacon.calls.length, 2);
});

Deno.test("adversarial: unknown severity in a stored record stays routable", () => {
  const call = sampleCall({ severity: "apocalyptic" as Call["severity"] });
  const msg = render(call, "plain");
  assertStringIncludes(msg.text, "APOCALYPTIC");
});
