/**
 * Property-based tests (fast-check). Honors `FC_NUM_RUNS` for the nightly soak.
 *  (a) classifyFigure: any valid measurements -> a known figure, finite BMI.
 *  (b) htmlToText: never leaves a '<tag>' and never throws.
 *  (c) selectRules: output is a subset, sorted by severity, ids unique.
 *  (d) figure.execute: any valid measurements -> resource validates against
 *      the model's own `figure` schema.
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  classifyFigure,
  htmlToText,
  model,
  type Rule,
  selectRules,
} from "./dieworkwear.ts";
import { makeCtx } from "../../fixtures/ctx.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? 200);
const FIGS = ["kabanchik", "big-tall", "athletic", "slim", "average"];

const meas = fc.record({
  heightCm: fc.double({ min: 120, max: 230, noNaN: true }),
  weightKg: fc.double({ min: 35, max: 300, noNaN: true }),
  chestCm: fc.option(fc.double({ min: 60, max: 200, noNaN: true }), {
    nil: undefined,
  }),
  waistCm: fc.option(fc.double({ min: 50, max: 220, noNaN: true }), {
    nil: undefined,
  }),
  hipsCm: fc.option(fc.double({ min: 60, max: 220, noNaN: true }), {
    nil: undefined,
  }),
  inseamCm: fc.option(fc.double({ min: 40, max: 110, noNaN: true }), {
    nil: undefined,
  }),
});

Deno.test("(a) classifyFigure total", () => {
  fc.assert(
    fc.property(meas, (m) => {
      const c = classifyFigure(m);
      return FIGS.includes(c.figure) && Number.isFinite(c.bmi);
    }),
    { numRuns },
  );
});

Deno.test("(b) htmlToText leaves no tags", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (s) => {
      return !/<[a-z/][^>]*>/i.test(
        htmlToText(s.replace(/&lt;|&gt;|&#\d+;|&#x[0-9a-f]+;/gi, "")),
      );
    }),
    { numRuns },
  );
});

const rule = fc.record({
  id: fc.constantFrom("a", "b", "c", "d"),
  figures: fc.subarray(FIGS, { minLength: 1 }),
  garment: fc.constantFrom("jacket", "trousers", "casual", "any"),
  occasions: fc.subarray(["work", "formal", "casual", "any"], { minLength: 1 }),
  severity: fc.constantFrom("high", "medium", "low") as fc.Arbitrary<
    Rule["severity"]
  >,
  rule: fc.string(),
  why: fc.string(),
  check: fc.string(),
  tweetId: fc.stringMatching(/^\d{1,5}$/),
});

Deno.test("(c) selectRules invariants", () => {
  const order = { high: 0, medium: 1, low: 2 };
  fc.assert(
    fc.property(
      fc.array(rule, { maxLength: 20 }),
      fc.constantFrom(...FIGS),
      fc.constantFrom("work", "formal", "casual", "any"),
      fc.constantFrom(null, "jacket", "trousers", "casual"),
      (rules, fig, occ, gar) => {
        const out = selectRules(rules, fig, occ, gar);
        const ids = out.map((r) => r.id);
        if (new Set(ids).size !== ids.length) return false;
        for (let i = 1; i < out.length; i++) {
          if (order[out[i - 1].severity] > order[out[i].severity]) return false;
        }
        return out.every((r) => r.figures.includes(fig));
      },
    ),
    { numRuns },
  );
});

Deno.test("(d) figure.execute writes a schema-valid resource", async () => {
  await fc.assert(
    fc.asyncProperty(meas, async (m) => {
      const { ctx, store } = makeCtx();
      await model.methods.figure.execute(m, ctx as never);
      assert(
        model.resources.figure.schema.safeParse(store.get("figure")).success,
      );
    }),
    { numRuns: Math.min(numRuns, 100) },
  );
});
