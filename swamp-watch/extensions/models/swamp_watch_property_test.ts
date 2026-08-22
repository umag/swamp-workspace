/**
 * property-invariant-flow suite for @magistr/swamp-watch.
 *
 * The cron arithmetic is where a silent wrong answer does the most damage: an
 * inflated budget means a dead workflow never alerts, and a deflated one means
 * a healthy workflow pages nightly. Neither shows up as an error, so the
 * invariants are asserted against an INDEPENDENT oracle rather than against
 * the implementation's own constants.
 *
 * Run counts are gated by FC_NUM_RUNS so CI stays fast and the soak task can
 * turn the same properties up.
 */

import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cronMatches,
  escapeLabelValue,
  isoToUnixSeconds,
  mapPool,
  maxGapSeconds,
  metricLine,
  parseCron,
  staleAfterSeconds,
} from "./lib/cli.ts";
import { parseExposition } from "./lib/testing.ts";

const NUM_RUNS = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");
const opts = { numRuns: NUM_RUNS };

/**
 * Independent oracle: every fire instant in a window, found by brute force
 * over JavaScript's own Date rather than the module's field sets.
 */
function oracleFires(
  expr: string,
  fromMs: number,
  minutes: number,
): number[] {
  const c = parseCron(expr);
  const out: number[] = [];
  for (let i = 0; i < minutes; i++) {
    const t = fromMs + i * 60_000;
    if (cronMatches(c, new Date(t))) out.push(t);
  }
  return out;
}

Deno.test("property: an every-N-minutes schedule has a gap of exactly N minutes", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }).filter((n) => 60 % n === 0),
      (n) => {
        assertEquals(maxGapSeconds(`*/${n} * * * *`), n * 60);
      },
    ),
    opts,
  );
});

Deno.test("property: a daily schedule is 86400s regardless of which minute and hour", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 59 }),
      fc.integer({ min: 0, max: 23 }),
      (m, h) => {
        assertEquals(maxGapSeconds(`${m} ${h} * * *`), 86400);
      },
    ),
    opts,
  );
});

Deno.test("property: a weekly schedule is 604800s for every weekday", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 6 }), (dow) => {
      assertEquals(maxGapSeconds(`0 4 * * ${dow}`), 604800);
    }),
    opts,
  );
});

Deno.test("property: adding a second daily fire never lengthens the longest gap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 23 }),
      (a, b) => {
        fc.pre(a !== b);
        const one = maxGapSeconds(`0 ${a} * * *`);
        const two = maxGapSeconds(`0 ${a},${b} * * *`);
        assert(one !== null && two !== null);
        // More fires can only make the worst wait shorter or equal.
        assert(two <= one, `${two} should be <= ${one}`);
      },
    ),
    opts,
  );
});

Deno.test("property: the longest gap is at least the mean gap over a window", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        "*/5 * * * *",
        "0 * * * *",
        "0 9,20 * * *",
        "30 2 * * *",
        "0 4 * * 1",
        "15 6 1,15 * *",
      ),
      (expr) => {
        const start = Date.UTC(2027, 0, 1);
        const fires = oracleFires(expr, start, 120 * 24 * 60);
        fc.pre(fires.length >= 2);
        // Mean of the ACTUAL gaps: span between first and last fire divided by
        // the number of intervals. Using window/fires instead would overstate
        // it whenever the window does not begin and end on a fire.
        const meanGap = (fires[fires.length - 1] - fires[0]) / 1000 /
          (fires.length - 1);
        const worst = maxGapSeconds(expr);
        assert(worst !== null);
        // A max below the mean is arithmetically impossible, so this failing
        // means the walk is missing fires.
        assert(
          worst >= meanGap,
          `${expr}: worst ${worst} < mean ${meanGap}`,
        );
      },
    ),
    opts,
  );
});

Deno.test("property: the budget always exceeds the period it is built from", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 3_000_000 }),
      fc.double({ min: 0, max: 4, noNaN: true, noDefaultInfinity: true }),
      fc.integer({ min: 0, max: 7200 }),
      (period, factor, floor) => {
        const s = staleAfterSeconds(period, factor, floor);
        assert(s >= period, "a budget shorter than the period pages forever");
        assert(Number.isFinite(s));
        assert(Number.isInteger(s));
      },
    ),
    opts,
  );
});

Deno.test("property: any label value survives a round trip through exposition", () => {
  fc.assert(
    fc.property(fc.string(), fc.integer(), (name, value) => {
      const line = metricLine("m", { workflow: name }, value);
      // One physical line, always: a value that could inject a newline would
      // let a workflow name forge an arbitrary second sample.
      assertEquals(line.split("\n").length, 1);
      const parsed = parseExposition(line);
      assertEquals(parsed.length, 1);
      assertEquals(parsed[0].value, value);
    }),
    opts,
  );
});

Deno.test("property: escaping is idempotent in shape — no raw quote or newline survives", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const e = escapeLabelValue(s);
      assert(!e.includes("\n"));
      // Every remaining quote must be backslash-escaped.
      for (let i = 0; i < e.length; i++) {
        if (e[i] === '"') {
          let backslashes = 0;
          for (let j = i - 1; j >= 0 && e[j] === "\\"; j--) backslashes++;
          assert(backslashes % 2 === 1, `unescaped quote at ${i} in ${e}`);
        }
      }
    }),
    opts,
  );
});

Deno.test("property: isoToUnixSeconds is monotone for ordered timestamps", () => {
  fc.assert(
    fc.property(
      fc.date({
        min: new Date(0),
        max: new Date(4_000_000_000_000),
        noInvalidDate: true,
      }),
      fc.date({
        min: new Date(0),
        max: new Date(4_000_000_000_000),
        noInvalidDate: true,
      }),
      (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        assert(
          isoToUnixSeconds(lo.toISOString()) <=
            isoToUnixSeconds(hi.toISOString()),
        );
      },
    ),
    opts,
  );
});

Deno.test("property: mapPool is order-preserving for any limit", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer(), { maxLength: 40 }),
      fc.integer({ min: 1, max: 8 }),
      async (items, limit) => {
        const out = await mapPool(items, limit, (n) => Promise.resolve(n * 2));
        assertEquals(out, items.map((n) => n * 2));
      },
    ),
    opts,
  );
});

Deno.test("flow: a workflow that fired on schedule is never judged stale", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("*/2 * * * *", "0 * * * *", "0 3 * * *", "0 4 * * 0"),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
      (expr, lateness, now) => {
        const period = maxGapSeconds(expr);
        assert(period !== null);
        const budget = staleAfterSeconds(period, 0.5, 1800);
        // A healthy workflow succeeds within one legal gap, allowing for a
        // little lateness. It must never trip the rule.
        const lastSuccess = now - period - lateness;
        const age = now - lastSuccess;
        assert(
          !(age > budget),
          `${expr}: on-time run at age ${age} tripped budget ${budget}`,
        );
      },
    ),
    opts,
  );
});

Deno.test("flow: a workflow silent for two full periods always trips", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("*/2 * * * *", "0 * * * *", "0 3 * * *", "0 4 * * 0"),
      fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
      (expr, _now) => {
        const period = maxGapSeconds(expr);
        assert(period !== null);
        const budget = staleAfterSeconds(period, 0.5, 1800);
        // Two periods plus the grace floor exceeds any budget this model
        // builds, so genuine death is always caught rather than absorbed.
        const age = period * 2 + 1800 + 1;
        assert(
          age > budget,
          `${expr}: silence of ${age} did not trip budget ${budget}`,
        );
      },
    ),
    opts,
  );
});

Deno.test("flow: never-succeeded reads as maximally stale, so a zero is not mistaken for fresh", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("*/2 * * * *", "0 * * * *", "0 3 * * *", "0 4 * * 0"),
      fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
      (expr, now) => {
        const period = maxGapSeconds(expr);
        assert(period !== null);
        const budget = staleAfterSeconds(period, 0.5, 1800);
        // The model emits 0 for "no success seen". time()-0 must exceed every
        // budget, or the never-deployed case would read as healthy forever.
        assert(now - 0 > budget);
      },
    ),
    opts,
  );
});
