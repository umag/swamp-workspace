// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Property-invariant-flow suite for @magistr/distress (STANDARD.md
// `property-invariant-flow`).
//
// fast-check@4.8.0, gated by FC_NUM_RUNS (small by default, large in the
// nightly `test:soak`).
//
// The generators here deliberately range WIDER than the code's own
// constants: message caps down to 80 and up to 8000 rather than the shipped
// 3500, severity strings outside the enum, timestamps outside every window,
// and unicode/markup/template text in every free-text field. An oracle
// computed from the same constant as the code under test would certify the
// bug rather than catch it, so each invariant is stated independently:
// truncation is checked against the caller's bound, escaping against an
// independent unescaper, and the loop guard against a count of pages rather
// than against the guard's own counters.
//
// Invariants:
//  (a) truncate always respects the caller's bound, and is the identity
//      exactly when the input already fits.
//  (b) escapeHtml is losslessly invertible and leaves no raw markup.
//  (c) escapeMarkdown escapes every reserved character and nothing else.
//  (d) renderTemplate replaces known keys, leaves unknown ones visible, and
//      never rescans what it substituted (no recursive expansion).
//  (e) buildChannelArgs always satisfies its preset's required keys and
//      never emits a prototype-shaped key.
//  (f) buildMessage output is bounded by maxChars for every input.
//  (g) eligibleChannels is monotone in severity (a higher severity can only
//      gain channels), and order-preserving.
//  (h) isRateLimited is monotone in the number of recent deliveries.
//  (i) pruneStamps keeps exactly the parseable in-window stamps.
//  (j) upsertEntry: bounded, duplicate-free, contains the upserted row, and
//      never drops a live call while a resolved one is still present.
//  (k) deriveDedupeKey folds digit runs and is insensitive to case and
//      whitespace, so a counting loop is always one incident.
//  (l) FLOW: N repeats of one incident produce exactly one indexed call and
//      strictly fewer pages than N.
//  (m) FLOW: resolve re-opens a dedupe key — the next call is a new record.
//  (n) FLOW: every raised call is recorded, whatever the channels do.

import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";

import {
  buildChannelArgs,
  buildMessage,
  type Call,
  type Channel,
  deriveDedupeKey,
  eligibleChannels,
  escapeHtml,
  escapeMarkdown,
  type IndexEntry,
  isRateLimited,
  messageFields,
  model,
  PRESETS,
  pruneStamps,
  renderTemplate,
  SEVERITIES,
  severityRank,
  truncate,
  upsertEntry,
} from "./distress.ts";

const NUM_RUNS = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");
const cfg = { numRuns: NUM_RUNS };

// ============================================================================
// Generators — deliberately wider than the shipped defaults
// ============================================================================

/** Free text including markup, templates, unicode and control characters. */
const nastyText = fc.oneof(
  fc.string(),
  fc.string({ unit: "grapheme" }),
  fc.constantFrom(
    "<script>alert(1)</script>",
    "{{text}}{{body}}{{title}}",
    "*_[]()~`>#+-=|{}.!\\",
    "a & b < c > d \" e ' f",
    "\u0000\u001b[31m\u007f",
    "🚨 𝕕𝕚𝕤𝕥𝕣𝕖𝕤𝕤 �",
    "",
  ),
);

const severityGen = fc.oneof(
  fc.constantFrom(...SEVERITIES),
  // Out-of-vocabulary severities: stored records outlive enum edits.
  fc.constantFrom("apocalyptic", "", "INFO", "critical "),
);

const channelGen: fc.Arbitrary<Channel> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 12 }),
  definition: fc.string({ minLength: 1, maxLength: 12 }),
  method: fc.constantFrom("sendMessage", "notify", "send"),
  preset: fc.constantFrom(
    ...(Object.keys(PRESETS) as Array<keyof typeof PRESETS>),
  ),
  arguments: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 8 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { maxKeys: 4 },
  ),
  minSeverity: fc.constantFrom(...SEVERITIES),
  format: fc.constantFrom("plain", "html", "markdown"),
  proofRequire: fc.constant({}),
  enabled: fc.boolean(),
}) as unknown as fc.Arbitrary<Channel>;

const callGen: fc.Arbitrary<Call> = fc.record({
  callId: fc.string({ minLength: 1, maxLength: 30 }),
  createdAt: fc.constant("2026-08-09T12:00:00.000Z"),
  updatedAt: fc.constant("2026-08-09T12:00:00.000Z"),
  lastSeenAt: fc.constant("2026-08-09T12:00:00.000Z"),
  status: fc.constantFrom("open", "acked", "resolved"),
  severity: severityGen,
  category: fc.constantFrom("stuck", "welfare", "other"),
  summary: nastyText,
  detail: fc.option(nastyText, { nil: undefined }),
  task: fc.option(nastyText, { nil: undefined }),
  suggestedAction: fc.option(nastyText, { nil: undefined }),
  agent: fc.record({
    name: fc.option(nastyText, { nil: undefined }),
    model: fc.option(nastyText, { nil: undefined }),
    session: fc.option(nastyText, { nil: undefined }),
    host: fc.option(nastyText, { nil: undefined }),
  }),
  dedupeKey: fc.string({ maxLength: 20 }),
  repeats: fc.nat({ max: 10_000 }),
  repeatsSinceEscalation: fc.nat({ max: 10_000 }),
  escalations: fc.nat({ max: 100 }),
  delivered: fc.boolean(),
  deliveries: fc.constant([]),
}) as unknown as fc.Arbitrary<Call>;

const entryGen: fc.Arbitrary<IndexEntry> = fc.record({
  callId: fc.string({ minLength: 1, maxLength: 8 }),
  dedupeKey: fc.string({ maxLength: 8 }),
  status: fc.constantFrom("open", "acked", "resolved"),
  severity: fc.constantFrom(...SEVERITIES),
  category: fc.constantFrom("stuck", "other"),
  summary: fc.string({ maxLength: 20 }),
  createdAt: fc.constant("2026-08-09T12:00:00.000Z"),
  lastSeenAt: fc.constant("2026-08-09T12:00:00.000Z"),
  repeats: fc.nat({ max: 100 }),
  repeatsSinceEscalation: fc.nat({ max: 100 }),
  escalations: fc.nat({ max: 10 }),
  delivered: fc.boolean(),
}) as unknown as fc.Arbitrary<IndexEntry>;

/**
 * Independent inverse of `escapeHtml`. Written from the HTML spec rather
 * than from the implementation, so it cannot agree with a broken escaper by
 * sharing its mistake. Order matters: `&amp;` must be undone last.
 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const MARKDOWN_RESERVED = new Set("_*[]()~`>#+-=|{}.!\\");

// ============================================================================
// (a) truncate
// ============================================================================

Deno.test("property: truncate respects the caller's bound", () => {
  fc.assert(
    fc.property(nastyText, fc.integer({ min: 1, max: 8000 }), (s, max) => {
      const out = truncate(s, max);
      assert(
        out.length <= max,
        `${out.length} > ${max} for input of ${s.length}`,
      );
      if (s.length <= max) assertEquals(out, s);
    }),
    cfg,
  );
});

// ============================================================================
// (b)(c) escaping
// ============================================================================

Deno.test("property: escapeHtml is lossless and leaves no raw markup", () => {
  fc.assert(
    fc.property(nastyText, (s) => {
      const escaped = escapeHtml(s);
      assert(!escaped.includes("<"), "raw < survived");
      assert(!escaped.includes(">"), "raw > survived");
      assertEquals(unescapeHtml(escaped), s, "escaping lost information");
    }),
    cfg,
  );
});

Deno.test("property: escapeMarkdown escapes exactly the reserved set", () => {
  fc.assert(
    fc.property(nastyText, (s) => {
      const escaped = escapeMarkdown(s);
      // Every reserved character in the output is backslash-prefixed, and
      // every backslash in the output introduces a reserved character.
      for (let i = 0; i < escaped.length; i++) {
        const ch = escaped[i];
        if (ch === "\\") {
          assert(
            i + 1 < escaped.length && MARKDOWN_RESERVED.has(escaped[i + 1]),
            `dangling escape at ${i}`,
          );
          i++;
          continue;
        }
        assert(!MARKDOWN_RESERVED.has(ch), `unescaped "${ch}" at ${i}`);
      }
    }),
    cfg,
  );
});

// ============================================================================
// (d) templates
// ============================================================================

Deno.test("property: renderTemplate substitutes without rescanning", () => {
  const safeValue = fc.string({ maxLength: 20 }).filter((s) =>
    !s.includes("{{")
  );
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.stringMatching(/^\w{1,8}$/),
        safeValue,
        { maxKeys: 5 },
      ),
      nastyText,
      (fields, extra) => {
        const keys = Object.keys(fields);
        const tpl = keys.map((k) => `{{${k}}}`).join("|") + "|{{__absent__}}";
        const out = renderTemplate(tpl, fields);
        for (const k of keys) {
          assert(!out.includes(`{{${k}}}`), `known key {{${k}}} survived`);
        }
        assert(
          out.includes("{{__absent__}}"),
          "an unknown placeholder must stay visible",
        );
        // A value that itself contains a placeholder is never re-expanded.
        const withBraces = renderTemplate("{{a}}", { a: `{{a}}${extra}` });
        assertEquals(withBraces, `{{a}}${extra}`);
      },
    ),
    cfg,
  );
});

// ============================================================================
// (e) channel arguments
// ============================================================================

Deno.test("property: channel args satisfy the preset and stay prototype-safe", () => {
  fc.assert(
    fc.property(channelGen, callGen, (channel, call) => {
      const msg = buildMessage(call, {
        instance: "distress",
        format: channel.format,
        maxChars: 3500,
        kind: "initial",
      });
      const args = buildChannelArgs(channel, messageFields(msg, call));
      for (const key of Object.keys(args)) {
        assert(
          key !== "__proto__" && key !== "constructor" && key !== "prototype",
          `unsafe key "${key}" reached the callee`,
        );
      }
      // Every key the preset defines is present unless the channel's own
      // arguments deliberately replaced it.
      const presetKeys = Object.keys(PRESETS[channel.preset]);
      for (const key of presetKeys) {
        assert(key in args, `preset key "${key}" was lost`);
      }
      assertEquals(Object.getPrototypeOf(args), Object.prototype);
    }),
    cfg,
  );
});

// ============================================================================
// (f) message bounds
// ============================================================================

Deno.test("property: a rendered page never exceeds its cap", () => {
  fc.assert(
    fc.property(
      callGen,
      fc.integer({ min: 80, max: 8000 }),
      fc.constantFrom("plain", "html", "markdown"),
      fc.constantFrom("initial", "escalation", "test"),
      (call, maxChars, format, kind) => {
        const msg = buildMessage(call, {
          instance: "distress",
          format,
          maxChars,
          kind: kind as "initial",
        });
        assert(
          msg.text.length <= maxChars,
          `text ${msg.text.length} > cap ${maxChars}`,
        );
        assert(msg.title.length <= 200, `title ${msg.title.length} > 200`);
      },
    ),
    cfg,
  );
});

// ============================================================================
// (g)(h)(i) routing and rate limiting
// ============================================================================

Deno.test("property: eligibility only grows with severity", () => {
  fc.assert(
    fc.property(
      fc.array(channelGen, { maxLength: 8 }),
      fc.constantFrom(...SEVERITIES),
      fc.constantFrom(...SEVERITIES),
      (channels, s1, s2) => {
        const [lo, hi] = severityRank(s1) <= severityRank(s2)
          ? [s1, s2]
          : [s2, s1];
        // Compared by IDENTITY, not by name: two channels may legitimately
        // share a label, and a name-based comparison would then be
        // ambiguous rather than wrong-about-the-code.
        const loSel = eligibleChannels(channels, lo);
        const hiSel = eligibleChannels(channels, hi);
        for (const c of loSel) {
          assert(hiSel.includes(c), "a channel was lost at higher severity");
        }
        // Selection is always a subsequence of the configured order.
        const positions = hiSel.map((c) => channels.indexOf(c));
        for (let i = 1; i < positions.length; i++) {
          assert(positions[i] > positions[i - 1], "configured order was lost");
        }
      },
    ),
    cfg,
  );
});

Deno.test("property: rate limiting is monotone in recent deliveries", () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 50 }),
      fc.integer({ min: 1, max: 20 }),
      fc.boolean(),
      fc.constantFrom(...SEVERITIES),
      (n, cap, bypass, severity) => {
        const conf = {
          maxCallsPerHour: cap,
          criticalBypassesRateLimit: bypass,
        };
        const stamps = (k: number) => Array.from({ length: k }, () => "s");
        const limitedNow = isRateLimited(stamps(n), conf, severity);
        const limitedLater = isRateLimited(stamps(n + 1), conf, severity);
        // Once limited, adding another delivery cannot un-limit.
        if (limitedNow) assert(limitedLater);
        if (severity === "critical" && bypass) assert(!limitedNow);
      },
    ),
    cfg,
  );
});

Deno.test("property: pruneStamps keeps exactly the parseable in-window stamps", () => {
  const base = Date.parse("2026-08-09T12:00:00.000Z");
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.integer({ min: -7_200_000, max: 0 }).map((d) =>
            new Date(base + d).toISOString()
          ),
          fc.constantFrom("garbage", "", "2026-13-45T99:99:99Z"),
        ),
        { maxLength: 30 },
      ),
      fc.integer({ min: 1000, max: 7_200_000 }),
      (stamps, windowMs) => {
        const kept = pruneStamps(stamps, base, windowMs);
        // Independent oracle: parse and compare without reusing the helper.
        const expected = stamps.filter((s) => {
          const t = Date.parse(s);
          return !Number.isNaN(t) && base - t < windowMs;
        });
        assertEquals(kept, expected);
        assert(kept.length <= stamps.length);
      },
    ),
    cfg,
  );
});

// ============================================================================
// (j) index maintenance
// ============================================================================

Deno.test("property: the index stays bounded, unique, and live-first", () => {
  fc.assert(
    fc.property(
      fc.array(entryGen, { maxLength: 40 }),
      fc.integer({ min: 1, max: 20 }),
      (entries, limit) => {
        let index: IndexEntry[] = [];
        for (const e of entries) {
          const before = index;
          index = upsertEntry(index, e, limit);

          assert(index.length <= limit, `index grew to ${index.length}`);
          const ids = index.map((c) => c.callId);
          assertEquals(new Set(ids).size, ids.length, "duplicate callId");
          assertEquals(
            index.at(-1)?.callId,
            e.callId,
            "the upserted row must always survive",
          );

          // A resolved row is never kept while a live one was dropped.
          const carried = before.filter((c) => c.callId !== e.callId);
          const liveDropped = carried.filter((c) =>
            c.status !== "resolved" && !ids.includes(c.callId)
          ).length;
          if (liveDropped > 0) {
            const resolvedKept = index.filter((c) =>
              c.status === "resolved" && c.callId !== e.callId
            ).length;
            assertEquals(
              resolvedKept,
              0,
              "a resolved row was kept while a live one was dropped",
            );
          }

          // Surviving carried-over rows keep their original relative order.
          const survivors = carried
            .filter((c) =>
              ids.includes(c.callId)
            )
            .map((c) => c.callId);
          assertEquals(ids.slice(0, survivors.length), survivors);
        }
      },
    ),
    cfg,
  );
});

// ============================================================================
// (k) dedupe key
// ============================================================================

Deno.test("property: a counting loop always derives one key", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 30 }),
      fc.nat({ max: 1_000_000 }),
      fc.nat({ max: 1_000_000 }),
      fc.string({ maxLength: 30 }),
      (prefix, a, b, suffix) => {
        const key = (n: number) =>
          deriveDedupeKey({
            category: "stuck",
            summary: `${prefix}${n}${suffix}`,
          });
        assertEquals(key(a), key(b), "digits must not split an incident");
      },
    ),
    cfg,
  );
});

Deno.test("property: the dedupe key ignores case and whitespace runs", () => {
  fc.assert(
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{1,6}$/), {
        minLength: 1,
        maxLength: 5,
      }),
      (words) => {
        const plain = deriveDedupeKey({
          category: "stuck",
          summary: words.join(" "),
        });
        const loud = deriveDedupeKey({
          category: "stuck",
          summary: `  ${words.join("   ").toUpperCase()}  `,
        });
        assertEquals(plain, loud);
      },
    ),
    cfg,
  );
});

// ============================================================================
// (l)(m)(n) multi-step flows through the real method
// ============================================================================

type Stored = Record<string, unknown>;

type MethodEntry = {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
};

function harness(globals: Record<string, unknown>, deliver = true) {
  const store: Record<string, Stored> = {};
  const pages: Array<Record<string, unknown>> = [];
  return {
    store,
    pages,
    ctx: {
      globalArgs: model.globalArguments.parse(globals),
      definition: { name: "distress" },
      logger: { info: () => {}, warning: () => {} },
      readResource: (n: string) => Promise.resolve(store[n] ?? null),
      writeResource: (_s: string, n: string, d: Stored) => {
        store[n] = structuredClone(d);
        return Promise.resolve({ name: n });
      },
      readModelData: () => Promise.resolve([]),
      runModel: (o: Record<string, unknown>) => {
        pages.push(o);
        return Promise.resolve({
          resources: deliver ? [{ name: `m${pages.length}` }] : [],
        });
      },
    },
  };
}

function invoke(name: string, args: Record<string, unknown>, ctx: unknown) {
  const m = (model.methods as unknown as Record<string, MethodEntry>)[name];
  return m.execute(m.arguments.parse(args), ctx);
}

const CHANNEL = {
  name: "c",
  definition: "d",
  method: "sendMessage",
  preset: "text",
  minSeverity: "info",
  format: "plain",
};

Deno.test("flow: N repeats of one incident stay one call and page less than N", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 30 }),
      fc.integer({ min: 2, max: 40 }),
      nastyText,
      async (repeats, escalateAfter, summary) => {
        const h = harness({
          channels: [CHANNEL],
          escalateAfterRepeats: escalateAfter,
          maxCallsPerHour: 1000,
        });
        for (let i = 0; i < repeats; i++) {
          await invoke("call", {
            summary: `${summary} attempt ${i}`,
            category: "stuck",
            dedupeKey: "fixed",
          }, h.ctx);
        }
        const beacon = h.store.current as {
          calls: unknown[];
          totals: { raised: number; deduped: number };
        };
        assertEquals(beacon.calls.length, 1, "one incident, one record");
        assertEquals(beacon.totals.raised, 1);
        assertEquals(beacon.totals.deduped, repeats - 1);
        assert(
          h.pages.length < repeats,
          `paged ${h.pages.length} times for ${repeats} repeats`,
        );
        // Pages are exactly 1 initial + one per completed escalation window.
        assertEquals(
          h.pages.length,
          1 + Math.floor((repeats - 1) / escalateAfter),
        );
      },
    ),
    { numRuns: Math.min(NUM_RUNS, 40) },
  );
});

Deno.test("flow: resolving re-opens the key for a genuinely new call", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      async (cycles) => {
        const h = harness({ channels: [CHANNEL], maxCallsPerHour: 1000 });
        for (let i = 0; i < cycles; i++) {
          await invoke("call", { summary: "recurring", dedupeKey: "k" }, h.ctx);
          const beacon = h.store.current as {
            calls: Array<{ callId: string; status: string }>;
          };
          const open = beacon.calls.filter((c) => c.status !== "resolved");
          assertEquals(open.length, 1, "never more than one open at a time");
          await invoke("resolve", { callId: open[0].callId }, h.ctx);
        }
        const beacon = h.store.current as { calls: unknown[] };
        assertEquals(beacon.calls.length, cycles);
        assertEquals(h.pages.length, cycles);
      },
    ),
    { numRuns: Math.min(NUM_RUNS, 30) },
  );
});

Deno.test("flow: every raised call is recorded, whatever the channels do", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 12 }),
      fc.boolean(),
      fc.integer({ min: 1, max: 5 }),
      async (n, deliver, cap) => {
        const h = harness({
          channels: [CHANNEL],
          maxCallsPerHour: cap,
          requireDelivery: false,
          historyLimit: 2000,
        }, deliver);
        for (let i = 0; i < n; i++) {
          await invoke("call", {
            summary: `problem ${i}`,
            dedupeKey: `k${i}`,
          }, h.ctx);
        }
        const beacon = h.store.current as {
          calls: Array<{ callId: string }>;
          totals: { raised: number };
        };
        assertEquals(beacon.totals.raised, n);
        assertEquals(beacon.calls.length, n, "a call is never lost");
        assertEquals(
          new Set(beacon.calls.map((c) => c.callId)).size,
          n,
          "call ids collided",
        );
        for (const c of beacon.calls) {
          assert(h.store[c.callId], `no durable record for ${c.callId}`);
        }
      },
    ),
    { numRuns: Math.min(NUM_RUNS, 40) },
  );
});
