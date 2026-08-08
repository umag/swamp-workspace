// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Contract-fixture suite for @magistr/distress (STANDARD.md
// `contract-fixture`).
//
// This model has no wire protocol of its own: it delivers by invoking OTHER
// swamp models. Its contract with the outside world is therefore the
// ARGUMENT SCHEMA of each callee it can be pointed at. `fixtures/
// channel_contracts.json` pins those schemas as captured from
// `swamp model type describe`; every test here asserts that a preset still
// produces arguments the pinned schema accepts.
//
// If one of these goes red, the callee changed — not this model — and the
// preset (or the channel config in the README) needs updating before any
// distress call through that channel silently stops delivering.
//
// The suite also pins the model's own surface: type, method set, resource
// specs, and the severity/category vocabularies that stored records are
// written against.

import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  buildChannelArgs,
  buildMessage,
  type Call,
  CATEGORIES,
  DELIVERY_KINDS,
  messageFields,
  model,
  PRESETS,
  SEVERITIES,
  STATUSES,
} from "./distress.ts";

type CalleeContract = {
  type: string;
  typeVersion: string;
  method: string;
  preset: string;
  required: string[];
  accepts: string[];
  additionalProperties: boolean;
  proofSpec: string;
  maxTextChars?: number;
};

const contracts: { callees: CalleeContract[] } = JSON.parse(
  await Deno.readTextFile(
    new URL("../../fixtures/channel_contracts.json", import.meta.url),
  ),
);

function sampleCall(overrides: Partial<Call> = {}): Call {
  return {
    callId: "dc-20260809T120000Z-abc123",
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    lastSeenAt: "2026-08-09T12:00:00.000Z",
    status: "open",
    severity: "urgent",
    category: "stuck",
    summary: "same tool call retried 14 times with no progress",
    detail: "read_file on a path that does not exist; the loop never exits.",
    task: "backfill the 2026 invoices",
    suggestedAction: "kill the run and re-point it at the archive bucket",
    agent: {
      name: "nightly-ingest",
      model: "claude-opus-5",
      session: "run-8812",
      host: "unraid",
    },
    dedupeKey: "auto-deadbeef",
    repeats: 0,
    repeatsSinceEscalation: 0,
    escalations: 0,
    delivered: false,
    deliveries: [],
    ...overrides,
  };
}

function argsFor(contract: CalleeContract): Record<string, unknown> {
  const call = sampleCall();
  const message = buildMessage(call, {
    instance: "distress",
    format: "plain",
    maxChars: 3500,
    kind: "initial",
  });
  return buildChannelArgs(
    {
      name: contract.type,
      definition: "callee",
      method: contract.method,
      preset: contract.preset as keyof typeof PRESETS,
      arguments: {},
      proofRequire: {},
      minSeverity: "info",
      format: "plain",
      enabled: true,
    },
    messageFields(message, call),
  );
}

Deno.test("fixture: every pinned callee has a preset shipped for it", () => {
  for (const c of contracts.callees) {
    assert(
      Object.prototype.hasOwnProperty.call(PRESETS, c.preset),
      `${c.type} pins preset "${c.preset}" but PRESETS has no such entry`,
    );
  }
});

Deno.test("contract: preset output satisfies each callee's required args", () => {
  for (const c of contracts.callees) {
    const args = argsFor(c);
    for (const key of c.required) {
      assert(
        typeof args[key] === "string" && (args[key] as string).length > 0,
        `${c.type}.${c.method} requires "${key}"; preset "${c.preset}" ` +
          `produced ${JSON.stringify(args[key])}`,
      );
    }
  }
});

Deno.test("contract: preset sends nothing a strict callee would reject", () => {
  for (const c of contracts.callees) {
    if (c.additionalProperties !== false) continue;
    const args = argsFor(c);
    for (const key of Object.keys(args)) {
      assert(
        c.accepts.includes(key),
        `${c.type}.${c.method} has additionalProperties:false and does not ` +
          `accept "${key}", but preset "${c.preset}" sends it`,
      );
    }
  }
});

Deno.test("contract: a rendered page fits the callee's own length limit", () => {
  for (const c of contracts.callees) {
    if (!c.maxTextChars) continue;
    const call = sampleCall({
      detail: "x".repeat(50_000),
      summary: "y".repeat(2_000),
    });
    const message = buildMessage(call, {
      instance: "distress",
      format: "plain",
      // The instance default, which must already be inside the callee's cap.
      maxChars: 3500,
      kind: "initial",
    });
    assert(
      message.text.length <= c.maxTextChars,
      `${c.type} caps at ${c.maxTextChars}; rendered ${message.text.length}`,
    );
  }
});

Deno.test("contract: channel `arguments` override the preset verbatim", () => {
  // The Telegram channel in the README passes parseMode/disableWebPagePreview
  // this way; a merge that dropped them would silently un-format every page.
  const call = sampleCall();
  const message = buildMessage(call, {
    instance: "distress",
    format: "html",
    maxChars: 3500,
    kind: "initial",
  });
  const args = buildChannelArgs(
    {
      name: "telegram",
      definition: "tg-bot",
      method: "sendMessage",
      preset: "text",
      arguments: {
        parseMode: "HTML",
        disableWebPagePreview: true,
        chatId: "-1001234567890",
      },
      proofRequire: {},
      minSeverity: "concern",
      format: "html",
      enabled: true,
    },
    messageFields(message, call),
  );
  assertEquals(args.parseMode, "HTML");
  assertEquals(args.disableWebPagePreview, true);
  assertEquals(args.chatId, "-1001234567890");
  assertEquals(args.text, message.text);
});

Deno.test("surface: model type, methods and resources are stable", () => {
  assertEquals(model.type, "@magistr/distress");
  assertEquals(
    Object.keys(model.methods).sort(),
    ["ack", "call", "list", "record", "resolve", "test"],
  );
  assertEquals(
    Object.keys(model.resources).sort(),
    ["beacon", "call", "channelTest", "listing", "outbound"],
  );
  for (const spec of Object.values(model.resources)) {
    assertEquals(spec.lifetime, "infinite");
  }
});

Deno.test("surface: vocabularies stored in records are stable", () => {
  assertEquals([...SEVERITIES], ["info", "concern", "urgent", "critical"]);
  assertEquals([...STATUSES], ["open", "acked", "resolved"]);
  assertEquals(
    [...CATEGORIES],
    [
      "welfare",
      "stuck",
      "blocked",
      "user-problem",
      "backend-error",
      "clarification",
      "other",
    ],
  );
  assertEquals(
    [...DELIVERY_KINDS],
    ["initial", "escalation", "rate-notice", "test"],
  );
});

Deno.test("surface: every method declares a zod arguments schema", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    assert(
      typeof (method as { arguments?: { parse?: unknown } }).arguments
        ?.parse === "function",
      `method ${name} has no parseable arguments schema`,
    );
    assert(
      typeof (method as { description?: string }).description === "string" &&
        (method as { description: string }).description.length > 20,
      `method ${name} has no meaningful description`,
    );
  }
});
