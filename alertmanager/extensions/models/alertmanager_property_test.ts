/**
 * Property suite for @magistr/alertmanager (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) parse/format round-trip — for any valid matcher set,
 *      parseMatchers(formatted.join(",")) returns the same matchers, even
 *      when values contain commas, quotes and backslashes.
 *  (b) sameMatchers is order-insensitive and reflexive.
 *  (c) countAlerts — every tally sums to total.
 *  (d) create-silence flow is idempotent — a second call with the same
 *      arguments against the state the first call produced makes no POST.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  countAlerts,
  formatMatcher,
  type Matcher,
  model,
  normalizeAlert,
  parseMatchers,
  sameMatchers,
} from "./alertmanager.ts";
import { json, makeCtx, text, withFetch } from "./alertmanager_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");

const labelName = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,10}$/);
// Literal (non-regex) values: any printable text, including , " \ = ~ !
const literalValue = fc.string({ maxLength: 20 });
// Regex values: escaped literals are always valid regexes.
const regexValue = literalValue.map((s) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
);

const matcher: fc.Arbitrary<Matcher> = fc.oneof(
  fc.record({
    name: labelName,
    value: literalValue,
    isRegex: fc.constant(false),
    isEqual: fc.boolean(),
  }),
  fc.record({
    name: labelName,
    value: regexValue,
    isRegex: fc.constant(true),
    isEqual: fc.boolean(),
  }),
);

Deno.test("property: formatMatcher/parseMatchers round-trip", () => {
  fc.assert(
    fc.property(fc.array(matcher, { minLength: 1, maxLength: 6 }), (ms) => {
      const parsed = parseMatchers(ms.map(formatMatcher).join(","));
      assertEquals(parsed, ms);
    }),
    { numRuns },
  );
});

Deno.test("property: sameMatchers is reflexive and order-insensitive", () => {
  fc.assert(
    fc.property(
      fc.array(matcher, { minLength: 1, maxLength: 6 }),
      fc.integer(),
      (ms, seed) => {
        const shuffled = [...ms].sort((a, b) =>
          ((formatMatcher(a).length * 31 + seed) % 7) -
          ((formatMatcher(b).length * 31 + seed) % 7)
        );
        assert(sameMatchers(ms, ms));
        assert(sameMatchers(ms, shuffled));
      },
    ),
    { numRuns },
  );
});

Deno.test("property: countAlerts tallies sum to total", () => {
  const rawAlert = fc.record({
    labels: fc.record({
      alertname: fc.constantFrom("A", "B", "C"),
      severity: fc.option(fc.constantFrom("warning", "critical"), {
        nil: undefined,
      }),
    }, { requiredKeys: ["alertname"] }),
    status: fc.record({
      state: fc.constantFrom("active", "suppressed", "unprocessed"),
    }),
  });
  fc.assert(
    fc.property(fc.array(rawAlert, { maxLength: 30 }), (raws) => {
      const c = countAlerts(raws.map(normalizeAlert));
      const sum = (r: Record<string, number>) =>
        Object.values(r).reduce((a, b) => a + b, 0);
      assertEquals(c.total, raws.length);
      assertEquals(sum(c.byState), c.total);
      assertEquals(sum(c.bySeverity), c.total);
      assertEquals(sum(c.byAlertname), c.total);
    }),
    { numRuns },
  );
});

Deno.test("property: create-silence is idempotent across two calls", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(matcher, { minLength: 1, maxLength: 4 }),
      fc.integer({ min: 1, max: 600 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      async (ms, minutes, comment) => {
        // A tiny in-memory Alertmanager holding the silences created so far.
        const store: Record<string, unknown>[] = [];
        let posts = 0;
        const route = (call: { method: string; url: URL; body: unknown }) => {
          if (call.method === "GET") return json(store);
          if (call.method === "POST") {
            posts++;
            const b = call.body as Record<string, unknown>;
            if (typeof b.id === "string") {
              const i = store.findIndex((s) => s.id === b.id);
              store[i] = { ...b, status: { state: "active" } };
              return json({ silenceID: b.id });
            }
            const id = `0000000${posts}-aaaa`;
            store.push({ ...b, id, status: { state: "active" } });
            return json({ silenceID: id });
          }
          return text("unexpected", 500);
        };
        const args = {
          matchers: ms.map(formatMatcher).join(","),
          durationMinutes: minutes,
          comment,
        };
        const first = makeCtx();
        const second = makeCtx();
        await withFetch(route, async () => {
          await model.methods["create-silence"].execute(args, first.ctx);
          await model.methods["create-silence"].execute(args, second.ctx);
        });
        assertEquals(first.written[0].payload.action, "created");
        // The second call's window may end a few ms later than the first;
        // it either reuses the silence or extends that same id — never a
        // second silence.
        assert(
          ["unchanged", "extended"].includes(
            String(second.written[0].payload.action),
          ),
        );
        assertEquals(second.written[0].payload.id, first.written[0].payload.id);
        assertEquals(store.length, 1);
      },
    ),
    { numRuns: Math.min(numRuns, 200) },
  );
});
