/**
 * EU Cloud Sovereignty Framework v1.2.1 correction suite for
 * `@magistr/arckit/workspace` — ports three verified upstream arc-kit
 * defects (plus one related backward-compatible widening) into this fork's
 * `arckit_workspace.ts`. Ground truth is cited from the Commission's
 * Implementation guidance PDF and the Annex Sovereignty assessment
 * calculator XLSX (both at commission.europa.eu), and — for the SEAL Dutch
 * labels only — the NDS Cloudprogramma notitie "Verkenning Overheidsbrede
 * Soevereine Clouddiensten" (11 juni 2026), Tabel 1 p.8.
 *
 * TDD RED ROUND (weights): the first Deno.test block below
 * ("SOV_WEIGHTS individually") is written and MUST BE RUN against the
 * unmodified `arckit_workspace.ts` before any fix lands — the live
 * SOV_WEIGHTS table has three wrong values (SOV-1, SOV-5, SOV-7) that
 * happen to still sum to 100, which is exactly why a sum-only test would
 * never have caught them. Every weight is asserted individually, never only
 * the sum, so those three (and only those three) go red.
 *
 * The remaining fixes (SEAL3 English name, overallSeal minimum-gate,
 * SOV_MAX_SCORES/optional maxScore) are covered further down; those
 * necessarily reference exports (SOV_MAX_SCORES) and return fields
 * (overallSeal, overallSealGovernedBy) that do not exist before the fix —
 * referencing them fails the whole file to typecheck pre-fix, the same
 * "whole file fails to load is the expected red state" convention already
 * established in arckit_workspace_nl_test.ts's header comment.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  computeSovereigntyScore,
  SEAL_LABELS,
  SOV_MAX_SCORES,
} from "./arckit_workspace.ts";

// =============================================================================
// FIX 1 — SOV_WEIGHTS: three of eight values were wrong (SOV-1, SOV-5, SOV-7)
// =============================================================================

/**
 * Ground truth (EU CSF v1.2.1 Implementation guidance p.7; calculator cells
 * D4/D45/D76/D102/D133/D169/D195/D231) — do not derive this from any
 * in-repo duplicate table, hardcode it, so a bug shared by both tables
 * cannot cancel out.
 */
const EXPECTED_SOV_WEIGHTS: Record<string, number> = {
  "SOV-1": 20,
  "SOV-2": 10,
  "SOV-3": 10,
  "SOV-4": 15,
  "SOV-5": 10,
  "SOV-6": 15,
  "SOV-7": 15,
  "SOV-8": 5,
};

const SOV_IDS = Object.keys(EXPECTED_SOV_WEIGHTS);

interface SovereigntyScoreResult {
  score: number;
  breakdown: Array<
    { id: string; weight: number; contribution: number }
  >;
  floorsEvaluated: boolean;
  floorsPassed: boolean;
  objectivesBelowFloor: string[];
  overallSeal?: string;
  overallSealGovernedBy?: string[];
}

function asScore(x: unknown): SovereigntyScoreResult {
  return x as SovereigntyScoreResult;
}

// One test per objective, asserting its weight INDIVIDUALLY: isolate every
// objective at zero (all seven others at full marks) and read the weight
// off the breakdown entry for targetId itself, which the implementation
// computes as round((0/10)*weight,2) === 0 regardless of weight — so
// instead we isolate the OTHER direction, targetId alone at full marks,
// which pins its own weight as the total score (every other objective
// contributes 0).
for (const targetId of SOV_IDS) {
  Deno.test(`SOV_WEIGHTS["${targetId}"] === ${EXPECTED_SOV_WEIGHTS[targetId]} (ground truth: EU CSF v1.2.1 guidance p.7 / calculator)`, () => {
    const objectives = SOV_IDS.map((id) => ({
      id,
      score: id === targetId ? 10 : 0,
      maxScore: 10,
    }));
    const r = asScore(computeSovereigntyScore({ objectives }));
    assertAlmostEquals(
      r.score,
      EXPECTED_SOV_WEIGHTS[targetId],
      0.01,
      `${targetId}'s weight should be ${
        EXPECTED_SOV_WEIGHTS[targetId]
      } — isolating it at full marks (all seven others at 0) should score exactly its weight, got ${r.score}`,
    );
  });
}

Deno.test("SOV_WEIGHTS: the eight ground-truth weights still sum to 100 (both the wrong set and the right set do — this is why a sum-only test cannot catch the bug; kept as a sanity check, never the only assertion)", () => {
  assertEquals(
    Object.values(EXPECTED_SOV_WEIGHTS).reduce((a, b) => a + b, 0),
    100,
  );
});

// =============================================================================
// FIX 2 — SEAL3's English name; the Dutch stays "Digitale veerkracht"
// =============================================================================

Deno.test('SEAL_LABELS.SEAL3.en === "Technological sovereignty" (Commission guidance p.2-3, p.10) — was wrongly "Digital resilience"', () => {
  assertEquals(SEAL_LABELS["SEAL3"].en, "Technological sovereignty");
});

Deno.test('SEAL_LABELS.SEAL3.nl === "Digitale veerkracht" (NDS Cloudprogramma notitie, Tabel 1 p.8, verbatim) — guard against a future "helpful" fix that tries to match it to the English name', () => {
  assertEquals(SEAL_LABELS["SEAL3"].nl, "Digitale veerkracht");
});

Deno.test("SEAL_LABELS: every other SEAL0..SEAL4 English/Dutch label is unchanged by the SEAL3 fix", () => {
  assertEquals(SEAL_LABELS["SEAL0"], {
    en: "No sovereignty",
    nl: "Geen soevereiniteit",
  });
  assertEquals(SEAL_LABELS["SEAL1"], {
    en: "Jurisdictional sovereignty",
    nl: "Jurisdictionele soevereiniteit",
  });
  assertEquals(SEAL_LABELS["SEAL2"], {
    en: "Data sovereignty",
    nl: "Data-soevereiniteit",
  });
  assertEquals(SEAL_LABELS["SEAL4"], {
    en: "Full digital sovereignty",
    nl: "Volledige digitale soevereiniteit",
  });
});

// =============================================================================
// FIX 3 — overallSeal: the minimum SEAL across all eight objectives, which
// is the framework's actual rejection gate (guidance p.9), never an average.
// =============================================================================

function fullMarksObjectives(): Array<
  { id: string; score: number; maxScore: number }
> {
  return SOV_IDS.map((id) => ({ id, score: 10, maxScore: 10 }));
}

function withSeals(
  objectives: Array<{ id: string; score: number; maxScore: number }>,
  seals: Record<string, string>,
): Array<{ id: string; score: number; maxScore: number; seal?: string }> {
  return objectives.map((o) => ({ ...o, seal: seals[o.id] }));
}

Deno.test("overallSeal: the lowest SEAL among the eight objectives, not an average or a mode", () => {
  const seals: Record<string, string> = {
    "SOV-1": "SEAL4",
    "SOV-2": "SEAL4",
    "SOV-3": "SEAL4",
    "SOV-4": "SEAL4",
    "SOV-5": "SEAL1", // the lone low one — must govern the overall result
    "SOV-6": "SEAL4",
    "SOV-7": "SEAL4",
    "SOV-8": "SEAL4",
  };
  const r = asScore(
    computeSovereigntyScore({
      objectives: withSeals(fullMarksObjectives(), seals),
    }),
  );
  assertEquals(r.overallSeal, "SEAL1");
  assertEquals(r.overallSealGovernedBy, ["SOV-5"]);
});

Deno.test("overallSeal: a tie at the minimum names EVERY objective achieving it in overallSealGovernedBy", () => {
  const seals: Record<string, string> = {
    "SOV-1": "SEAL2",
    "SOV-2": "SEAL3",
    "SOV-3": "SEAL2",
    "SOV-4": "SEAL3",
    "SOV-5": "SEAL3",
    "SOV-6": "SEAL3",
    "SOV-7": "SEAL3",
    "SOV-8": "SEAL3",
  };
  const r = asScore(
    computeSovereigntyScore({
      objectives: withSeals(fullMarksObjectives(), seals),
    }),
  );
  assertEquals(r.overallSeal, "SEAL2");
  assertEquals(r.overallSealGovernedBy!.slice().sort(), ["SOV-1", "SOV-3"]);
});

Deno.test("overallSeal: uniform SEAL across all eight objectives names all eight in overallSealGovernedBy", () => {
  const seals = Object.fromEntries(SOV_IDS.map((id) => [id, "SEAL2"]));
  const r = asScore(
    computeSovereigntyScore({
      objectives: withSeals(fullMarksObjectives(), seals),
    }),
  );
  assertEquals(r.overallSeal, "SEAL2");
  assertEquals(r.overallSealGovernedBy!.slice().sort(), SOV_IDS.slice().sort());
});

Deno.test("overallSeal: undefined — NEVER fabricated as SEAL0 — when even one objective has no recorded SEAL", () => {
  const seals: Record<string, string> = {
    "SOV-1": "SEAL4",
    "SOV-2": "SEAL4",
    "SOV-3": "SEAL4",
    "SOV-4": "SEAL4",
    // SOV-5 deliberately left unsealed
    "SOV-6": "SEAL4",
    "SOV-7": "SEAL4",
    "SOV-8": "SEAL4",
  };
  const objectives = withSeals(fullMarksObjectives(), seals).map((o) =>
    o.id === "SOV-5" ? { id: o.id, score: o.score, maxScore: o.maxScore } : o
  );
  const r = asScore(computeSovereigntyScore({ objectives }));
  assertEquals(r.overallSeal, undefined);
  assertEquals(r.overallSealGovernedBy, []);
});

Deno.test("overallSeal: undefined when NO objective has a recorded SEAL (unchanged legacy call shape)", () => {
  const r = asScore(
    computeSovereigntyScore({ objectives: fullMarksObjectives() }),
  );
  assertEquals(r.overallSeal, undefined);
  assertEquals(r.overallSealGovernedBy, []);
});

// =============================================================================
// FIX 4 — SOV_MAX_SCORES / optional maxScore: the guard ceiling and the
// contribution divisor are DIFFERENT numbers when maxScore is omitted.
// =============================================================================

Deno.test("SOV_MAX_SCORES is exported with the eight calculator-cited actual maxima", () => {
  assertEquals(SOV_MAX_SCORES, {
    "SOV-1": 1000.03,
    "SOV-2": 1002,
    "SOV-3": 1000,
    "SOV-4": 1002,
    "SOV-5": 1001,
    "SOV-6": 1000,
    "SOV-7": 1001,
    "SOV-8": 1000,
  });
});

Deno.test("computeSovereigntyScore: maxScore is optional — omitting it entirely does not throw", () => {
  const objectives = SOV_IDS.map((id) => ({ id, score: 5 }));
  const r = asScore(computeSovereigntyScore({ objectives }));
  assert(typeof r.score === "number");
});

Deno.test("computeSovereigntyScore: with maxScore omitted, a score AT the objective's actual SOV_MAX_SCORES ceiling is accepted for every one of the eight objectives — a flat nominal-1000 clamp would have falsely rejected SOV-1/2/4/5/7", () => {
  for (const id of SOV_IDS) {
    const objectives = SOV_IDS.map((otherId) => ({
      id: otherId,
      score: otherId === id ? SOV_MAX_SCORES[otherId] : 0,
      // maxScore omitted throughout
    }));
    const r = asScore(computeSovereigntyScore({ objectives }));
    assert(
      typeof r.score === "number",
      `${id} at its actual maximum (${
        SOV_MAX_SCORES[id]
      }) should be accepted, not throw`,
    );
  }
});

Deno.test("computeSovereigntyScore: SOV-2 and SOV-4 accept a score of 1002; SOV-5 and SOV-7 accept 1001 — the four cases a nominal-1000 clamp would reject", () => {
  for (
    const [id, maxScore] of [
      ["SOV-2", 1002],
      ["SOV-4", 1002],
      ["SOV-5", 1001],
      ["SOV-7", 1001],
    ] as const
  ) {
    const objectives = SOV_IDS.map((otherId) => ({
      id: otherId,
      score: otherId === id ? maxScore : 0,
    }));
    // Must not throw.
    computeSovereigntyScore({ objectives });
  }
});

Deno.test("computeSovereigntyScore: with maxScore omitted, score > SOV_MAX_SCORES[id] is still rejected — the guard ceiling isn't unbounded, only widened to the actual figure", () => {
  const objectives = SOV_IDS.map((id) => ({
    id,
    score: id === "SOV-2" ? SOV_MAX_SCORES["SOV-2"] + 0.01 : 0,
  }));
  assertThrows(() => computeSovereigntyScore({ objectives }));
});

Deno.test("computeSovereigntyScore: an EXPLICIT maxScore is honoured exactly as before (guard AND divisor) — SOV-2 score 1002 against an explicit maxScore:1000 is rejected, proving the default does not silently widen an explicit caller value", () => {
  const objectives = SOV_IDS.map((id) => ({
    id,
    score: id === "SOV-2" ? 1002 : 0,
    maxScore: id === "SOV-2" ? 1000 : 10,
  }));
  assertThrows(() => computeSovereigntyScore({ objectives }));
});

Deno.test("computeSovereigntyScore: with maxScore omitted, the contribution DIVISOR is the flat nominal 1000, not SOV_MAX_SCORES[id] — SOV-2 alone at its actual max (1002, all others 0) contributes 10.02 (weight 10 * 1002/1000), not 10.00", () => {
  const objectives = SOV_IDS.map((id) => ({
    id,
    score: id === "SOV-2" ? SOV_MAX_SCORES["SOV-2"] : 0,
  }));
  const r = asScore(computeSovereigntyScore({ objectives }));
  const entry = r.breakdown.find((b) => b.id === "SOV-2");
  assert(entry, "breakdown missing SOV-2");
  assertAlmostEquals(entry!.contribution, 10.02, 0.001);
});

Deno.test("computeSovereigntyScore: a maximal response (score = SOV_MAX_SCORES[id] for every objective, maxScore omitted throughout) scores just OVER 100% — 100.0756% per the calculator's own flat-1000-divisor formula — never capped at 100", () => {
  const objectives = SOV_IDS.map((id) => ({
    id,
    score: SOV_MAX_SCORES[id],
  }));
  const r = asScore(computeSovereigntyScore({ objectives }));
  assert(
    r.score > 100,
    `a maximal response must score ABOVE 100 (calculator: 100.0756%), got ${r.score}`,
  );
  // This implementation rounds each objective's contribution to 2dp before
  // summing (documented on computeSovereigntyScore's return type: "score:
  // 0..100, rounded to 2dp"), so the returned total is very close to but not
  // bit-identical to the calculator's unrounded 100.0756 — epsilon 0.01
  // comfortably covers that residual double-rounding gap.
  assertAlmostEquals(r.score, 100.0756, 0.01);
});

Deno.test("computeSovereigntyScore: full marks at maxScore=10 (unchanged legacy shape, explicit maxScore throughout) still scores exactly 100 — the FIX4 default never applies when maxScore is given", () => {
  const r = asScore(
    computeSovereigntyScore({
      objectives: SOV_IDS.map((id) => ({ id, score: 10, maxScore: 10 })),
    }),
  );
  assertAlmostEquals(r.score, 100, 0.01);
});
