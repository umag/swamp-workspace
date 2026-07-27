import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  bayesFormatEligible,
  bayesianRating,
  DEFAULT_MIN_VOTES,
  globalAverageC,
} from "./bayesian.ts";

Deno.test("bayesianRating: IMDB weighted mean of R and prior C", () => {
  // (v/(v+m))*R + (m/(v+m))*C , v=1 m=5 R=90 C=50
  // = (1/6)*90 + (5/6)*50 = 15 + 41.666... = 56.666...
  assertAlmostEquals(bayesianRating(90, 1, 5, 50), 56.6666667, 1e-6);
});

Deno.test("bayesianRating: more votes pull toward R, fewer toward C", () => {
  const few = bayesianRating(90, 1, 5, 50);
  const many = bayesianRating(90, 100, 5, 50);
  assert(many > few, "more votes should weight R (90) more heavily");
  assert(many > 88 && many < 90);
});

Deno.test("bayesianRating: v+m==0 returns the prior mean C (no div by zero)", () => {
  assertEquals(bayesianRating(90, 0, 0, 50), 50);
});

Deno.test("globalAverageC: mean of all scores, 50.0 on empty (bayesian.py:115)", () => {
  assertEquals(globalAverageC([]), 50.0);
  assertEquals(globalAverageC([10, 20, 30]), 20);
  assertAlmostEquals(globalAverageC([7, 8, 9, 10]), 8.5, 1e-9);
});

Deno.test("DEFAULT_MIN_VOTES is 5 (bayesian.py:17)", () => {
  assertEquals(DEFAULT_MIN_VOTES, 5);
});

// ── the Nullable MOVIE filter trap (bayesian.py:128) ─────────────────────────
// In SQL, `format != 'MOVIE'` over a Nullable column excludes NULL-format rows
// (NULL != 'MOVIE' => NULL, filtered out). The naive TS `f !== 'MOVIE'` would
// INCLUDE nulls (null !== 'MOVIE' => true) — a silent corpus expansion. The
// null-safe predicate must reproduce SQL: null is NOT eligible.
Deno.test("bayesFormatEligible reproduces SQL Nullable semantics", () => {
  assertEquals(bayesFormatEligible("TV"), true);
  assertEquals(bayesFormatEligible("MOVIE"), false);
  assertEquals(bayesFormatEligible(null), false); // SQL would drop it too
  assertEquals(bayesFormatEligible(undefined), false);
});
