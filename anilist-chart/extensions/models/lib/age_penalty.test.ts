import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  agePenaltyFactor,
  currentSeasonInfo,
  penalizedScore,
  seasonFromMonth,
  SEASONS,
  seasonsDifference,
} from "./age_penalty.ts";

Deno.test("seasonFromMonth maps months to anime seasons", () => {
  assertEquals(seasonFromMonth(1), "WINTER");
  assertEquals(seasonFromMonth(3), "WINTER");
  assertEquals(seasonFromMonth(4), "SPRING");
  assertEquals(seasonFromMonth(7), "SUMMER");
  assertEquals(seasonFromMonth(10), "FALL");
  assertEquals(seasonFromMonth(12), "FALL");
});

Deno.test("currentSeasonInfo derives season+year from an explicit date", () => {
  const info = currentSeasonInfo(new Date(2026, 6, 21)); // month index 6 = July
  assertEquals(info, { season: "SUMMER", year: 2026 });
});

Deno.test("seasonsDifference: WINTER anchor, 4 seasons/year + adjustment", () => {
  // same year, current WINTER -> 0
  assertEquals(seasonsDifference(2026, "WINTER", 2026), 0);
  // same year, current SUMMER -> index(SUMMER)=2 adjustment
  assertEquals(seasonsDifference(2026, "SUMMER", 2026), 2);
  // one year back, WINTER -> 4
  assertEquals(seasonsDifference(2025, "WINTER", 2026), 4);
  // two years back, FALL -> 8 + index(FALL)=3 = 11
  assertEquals(seasonsDifference(2024, "FALL", 2026), 11);
});

Deno.test("seasonsDifference: null/future -> 0 (age_penalty.py:49)", () => {
  assertEquals(seasonsDifference(null, "SUMMER", 2026), 0);
  assertEquals(seasonsDifference(undefined, "SUMMER", 2026), 0);
  assertEquals(seasonsDifference(2030, "SUMMER", 2026), 0);
});

// ── REQUIRED: the gate cases and the UNCLAMPED factor ────────────────────────
Deno.test("agePenaltyFactor: null start_year -> 1.0 (gated)", () => {
  assertEquals(agePenaltyFactor(null, "SUMMER", 2026, 0.05), 1.0);
  assertEquals(agePenaltyFactor(undefined, "SUMMER", 2026, 0.05), 1.0);
});

Deno.test("agePenaltyFactor: future start_year -> 1.0 (gated)", () => {
  assertEquals(agePenaltyFactor(2030, "SUMMER", 2026, 0.05), 1.0);
});

Deno.test("agePenaltyFactor is UNCLAMPED: old title goes NEGATIVE (drop :239 clamp)", () => {
  // start 1980, WINTER 2026: seasonsOld = (2026-1980)*4 + index(WINTER)=0 = 184
  // factor = 1 - 184*0.05 = -8.2 . A CLAMPED impl (max(0, ...)) would return 0;
  // the settled decision is UNCLAMPED, so this MUST be negative.
  const f = agePenaltyFactor(1980, "WINTER", 2026, 0.05);
  assert(f < 0, `expected negative (unclamped) factor, got ${f}`);
  assertAlmostEquals(f, -8.2, 1e-9);
});

Deno.test("agePenaltyFactor: current-season title has no penalty", () => {
  assertEquals(agePenaltyFactor(2026, "WINTER", 2026, 0.05), 1.0);
});

Deno.test("penalizedScore multiplies raw avg by the (unclamped) factor", () => {
  // recent title, factor 1.0
  assertEquals(penalizedScore(8.0, 2026, "WINTER", 2026, 0.05), 8.0);
  // 2025 WINTER 2026: seasonsOld=4, factor=1-0.2=0.8, 9*0.8=7.2
  assertAlmostEquals(
    penalizedScore(9.0, 2025, "WINTER", 2026, 0.05),
    7.2,
    1e-9,
  );
});

Deno.test("SEASONS order is the index basis (WINTER=0..FALL=3)", () => {
  assertEquals([...SEASONS], ["WINTER", "SPRING", "SUMMER", "FALL"]);
});
