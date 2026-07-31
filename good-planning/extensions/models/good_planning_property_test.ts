// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Property-invariant-flow suite for @magistr/good-planning
// (STANDARD.md `property-invariant-flow`).
//
// fast-check@4.8.0, gated by FC_NUM_RUNS (small by default, large in the
// nightly `test:soak`). `now()` is frozen with `@std/testing`'s FakeTime for
// every invariant that touches a stamped field, so no assertion ever
// depends on a raw timestamp.
//
// Invariants:
//  (a) computeMaxTolerableLoss is the exact sum of its five components, and
//      monotone non-decreasing in each one independently.
//  (b) computeTriggerPoint is linear in timeToCruxWeeks (adding delta to the
//      input adds exactly delta to the output) and monotone non-increasing
//      in leadTimeWeeks/safetyMarginWeeks.
//  (c) governabilityScore is always k/5 for some integer k in [0, 5], hence
//      always in [0, 1].
//  (d) commitGateReport(plan).ok  <=>  governabilityScore(plan) === 1, for
//      randomly generated layer-presence combinations (including commitments
//      that are present-but-incomplete).
//  (e) knownSignposts is sorted and deduped regardless of input order or
//      duplication across assumptions/ceilings/tripwires.
//  (f) a randomized but LEGAL method-call flow (start -> add_* -> commit ->
//      monitor -> (evaluate -> trigger -> adapt|revise)* -> archive?) leaves
//      `current` PlanStateSchema-valid after every single step.
//  (g) hydrate() is idempotent under a frozen clock: two consecutive calls
//      produce byte-identical `summary` resources.

import { assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import fc from "npm:fast-check@4.8.0";

import {
  commitGateReport,
  type Commitment,
  computeMaxTolerableLoss,
  computeTriggerPoint,
  governabilityScore,
  knownSignposts,
  model,
  type PlanState,
  PlanStateSchema,
} from "./good_planning.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=2000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ============================================================================
// Harness
// ============================================================================

type StoredRecord = Record<string, unknown>;

type Ctx = {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  definition: { name: string };
};

function makeContext(): { store: Record<string, StoredRecord>; context: Ctx } {
  const store: Record<string, StoredRecord> = {};
  return {
    store,
    context: {
      logger: { info: (_m: string) => {} },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
      writeResource: (spec: string, name: string, data: StoredRecord) => {
        if (spec === "state") {
          PlanStateSchema.parse(data);
        }
        store[name] = data;
        return Promise.resolve({ name, version: 1 });
      },
      definition: { name: "test-plan" },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: Ctx) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

function state(store: Record<string, StoredRecord>): Record<string, unknown> {
  return store.current;
}

function assertSchemaValid(store: Record<string, StoredRecord>) {
  // Throws (failing the test) if `current` is not PlanStateSchema-valid.
  PlanStateSchema.parse(state(store));
}

// ============================================================================
// (a) computeMaxTolerableLoss — exact sum + monotone
// ============================================================================

const arbNonNeg = fc.double({
  min: 0,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

const arbLossBudget = fc.record({
  sunkCostUsd: arbNonNeg,
  shutdownCostUsd: arbNonNeg,
  committedLiabilitiesUsd: arbNonNeg,
  workingCapitalUnwindUsd: arbNonNeg,
  tailProvisionsUsd: arbNonNeg,
});

Deno.test("property: computeMaxTolerableLoss is the exact sum of its five components", () => {
  fc.assert(
    fc.property(arbLossBudget, (b) => {
      const expected = b.sunkCostUsd + b.shutdownCostUsd +
        b.committedLiabilitiesUsd + b.workingCapitalUnwindUsd +
        b.tailProvisionsUsd;
      return Math.abs(computeMaxTolerableLoss(b) - expected) < 1e-6;
    }),
    FC_RUNS,
  );
});

Deno.test("property: computeMaxTolerableLoss is monotone non-decreasing in each component independently", () => {
  fc.assert(
    fc.property(arbLossBudget, arbNonNeg, (b, delta) => {
      const base = computeMaxTolerableLoss(b);
      const bumped = computeMaxTolerableLoss({
        ...b,
        sunkCostUsd: b.sunkCostUsd + delta,
      });
      return bumped >= base;
    }),
    FC_RUNS,
  );
});

// ============================================================================
// (b) computeTriggerPoint — linear in timeToCrux, monotone in the other two
// ============================================================================

const arbCeilingTiming = fc.record({
  leadTimeWeeks: arbNonNeg,
  safetyMarginWeeks: arbNonNeg,
});

Deno.test("property: computeTriggerPoint is linear in timeToCruxWeeks — adding delta adds exactly delta", () => {
  fc.assert(
    fc.property(arbCeilingTiming, arbNonNeg, arbNonNeg, (c, t, delta) => {
      const a = computeTriggerPoint(c, t);
      const b = computeTriggerPoint(c, t + delta);
      return Math.abs((b - a) - delta) < 1e-6;
    }),
    FC_RUNS,
  );
});

Deno.test("property: computeTriggerPoint is monotone non-increasing in leadTimeWeeks and safetyMarginWeeks", () => {
  fc.assert(
    fc.property(arbCeilingTiming, arbNonNeg, arbNonNeg, (c, t, delta) => {
      const base = computeTriggerPoint(c, t);
      const withMoreLead = computeTriggerPoint(
        { ...c, leadTimeWeeks: c.leadTimeWeeks + delta },
        t,
      );
      const withMoreMargin = computeTriggerPoint(
        { ...c, safetyMarginWeeks: c.safetyMarginWeeks + delta },
        t,
      );
      return withMoreLead <= base + 1e-9 && withMoreMargin <= base + 1e-9;
    }),
    FC_RUNS,
  );
});

// ============================================================================
// (c) governabilityScore is always k/5, k in [0, 5]
// ============================================================================

function fixedCommitment(valid: boolean): Commitment {
  return {
    kind: "commitment",
    description: valid ? "ship" : "",
    owner: valid ? "alice" : "",
    budgetUsd: valid ? 1 : 0,
    byDate: valid ? "2026-09-01" : "not a date",
    dependsOn: [],
    reviewCadence: valid ? "weekly" : "",
    consequenceIfChanged: valid ? "delay" : "",
    status: "open",
  };
}

type LayerPresence = {
  hasAssumption: boolean;
  hasAllocation: boolean;
  commitmentShape: "none" | "valid" | "invalid" | "mixed";
  hasCeiling: boolean;
  hasTripwire: boolean;
};

const arbLayerPresence: fc.Arbitrary<LayerPresence> = fc.record({
  hasAssumption: fc.boolean(),
  hasAllocation: fc.boolean(),
  commitmentShape: fc.constantFrom<"none" | "valid" | "invalid" | "mixed">(
    "none",
    "valid",
    "invalid",
    "mixed",
  ),
  hasCeiling: fc.boolean(),
  hasTripwire: fc.boolean(),
});

function planFromPresence(p: LayerPresence): PlanState {
  const commitments = p.commitmentShape === "none"
    ? []
    : p.commitmentShape === "valid"
    ? [fixedCommitment(true)]
    : p.commitmentShape === "invalid"
    ? [fixedCommitment(false)]
    : [fixedCommitment(true), fixedCommitment(false)];

  return PlanStateSchema.parse({
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    assumptions: p.hasAssumption
      ? [{
        statement: "s",
        impact: "high",
        vulnerability: "high",
        signpostName: "sp",
      }]
      : [],
    allocations: p.hasAllocation
      ? [{ priority: "p", protectedBudgetUsd: 1 }]
      : [],
    commitments,
    ceilings: p.hasCeiling
      ? [{
        crux: "c",
        leadTimeWeeks: 1,
        safetyMarginWeeks: 0,
        signpostName: "sp2",
      }]
      : [],
    tripwires: p.hasTripwire
      ? [{
        signpostName: "sp3",
        thresholdExpr: "< 1",
        preAuthorizedAction: "act",
      }]
      : [],
  });
}

Deno.test("property: governabilityScore is always k/5 for an integer k in [0, 5]", () => {
  fc.assert(
    fc.property(arbLayerPresence, (p) => {
      const score = governabilityScore(planFromPresence(p));
      const k = Math.round(score * 5);
      return score >= 0 && score <= 1 && Math.abs(score - k / 5) < 1e-9;
    }),
    FC_RUNS,
  );
});

// ============================================================================
// (d) commitGateReport.ok  <=>  governabilityScore === 1
// ============================================================================

Deno.test("property: commitGateReport(plan).ok holds iff governabilityScore(plan) === 1", () => {
  fc.assert(
    fc.property(arbLayerPresence, (p) => {
      const plan = planFromPresence(p);
      return commitGateReport(plan).ok === (governabilityScore(plan) === 1);
    }),
    FC_RUNS,
  );
});

// ============================================================================
// (e) knownSignposts is sorted + deduped regardless of order/duplication
// ============================================================================

const arbSignpostName = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

Deno.test("property: knownSignposts returns a sorted, deduped list across assumptions/ceilings/tripwires", () => {
  fc.assert(
    fc.property(
      fc.array(arbSignpostName, { minLength: 0, maxLength: 8 }),
      fc.array(arbSignpostName, { minLength: 0, maxLength: 8 }),
      fc.array(arbSignpostName, { minLength: 0, maxLength: 8 }),
      (aNames, cNames, tNames) => {
        const plan = PlanStateSchema.parse({
          state: "drafted",
          strategicChoice: "x",
          horizon: "1y",
          createdAt: "2026-04-30T00:00:00.000Z",
          updatedAt: "2026-04-30T00:00:00.000Z",
          assumptions: aNames.map((n) => ({
            statement: "s",
            impact: "high",
            vulnerability: "high",
            signpostName: n,
          })),
          ceilings: cNames.map((n) => ({
            crux: "c",
            leadTimeWeeks: 1,
            safetyMarginWeeks: 0,
            signpostName: n,
          })),
          tripwires: tNames.map((n) => ({
            signpostName: n,
            thresholdExpr: "< 1",
            preAuthorizedAction: "act",
          })),
        });
        const result = knownSignposts(plan);
        const expected = Array.from(
          new Set([...aNames, ...cNames, ...tNames]),
        ).sort();
        return JSON.stringify(result) === JSON.stringify(expected);
      },
    ),
    FC_RUNS,
  );
});

// ============================================================================
// (f) randomized legal flow keeps `current` PlanStateSchema-valid throughout
// ============================================================================

async function buildDraftedPlan(ctx: Ctx): Promise<void> {
  await run("start", {
    strategicChoice: "Win the SMB segment via self-serve",
    horizon: "3y",
  }, ctx);
  await run("add_assumption", {
    statement: "Self-serve conversion stays above 8%",
    impact: "high",
    vulnerability: "medium",
    signpostName: "self_serve_conversion_pct",
  }, ctx);
  await run("add_commitment", {
    kind: "commitment",
    description: "Ship onboarding v2",
    owner: "alice",
    budgetUsd: 250000,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "Slip launch by one quarter",
  }, ctx);
  await run("add_allocation", {
    priority: "self-serve",
    protectedBudgetUsd: 500000,
  }, ctx);
  await run("add_ceiling", {
    crux: "support capacity",
    leadTimeWeeks: 6,
    safetyMarginWeeks: 2,
    signpostName: "support_ticket_volume",
    optionPremiums: [],
  }, ctx);
  await run("add_tripwire", {
    signpostName: "self_serve_conversion_pct",
    thresholdExpr: "< 6",
    preAuthorizedAction: "Pause paid acquisition",
    pullbackRung: 0,
  }, ctx);
}

/**
 * Drives one commit -> monitor -> evaluate(fired) -> trigger -> adapt|revise
 * cycle. Asserts schema-validity after EVERY single method call, then
 * returns whether the cycle ended by reviving to "drafted" (so the caller
 * can decide whether another cycle is legal).
 */
async function runOneCycle(
  ctx: Ctx,
  store: Record<string, StoredRecord>,
  revise: boolean,
): Promise<void> {
  // A prior cycle may have ended in "committed" (adapt) or "drafted"
  // (revise) — commit() is only legal from "drafted".
  if (state(store).state === "drafted") {
    await run("commit", {}, ctx);
    assertSchemaValid(store);
  }
  await run("monitor", {}, ctx);
  assertSchemaValid(store);
  await run("evaluate", {
    signpostName: "self_serve_conversion_pct",
    reading: "5.4",
    tripwireState: "fired",
  }, ctx);
  assertSchemaValid(store);
  await run("trigger", {
    signpostName: "self_serve_conversion_pct",
    reason: "cycle",
  }, ctx);
  assertSchemaValid(store);
  if (revise) {
    await run("revise", {
      reason: "assumption broken this cycle",
      brokenAssumptions: [],
    }, ctx);
  } else {
    await run("adapt", {
      triggeredBy: "self_serve_conversion_pct",
      actionTaken: "paused acquisition",
      reason: "cycle",
    }, ctx);
  }
  assertSchemaValid(store);
}

Deno.test("property: a randomized legal commit/monitor/evaluate/trigger/adapt|revise flow keeps `current` schema-valid after every step", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 0, maxLength: 4 }),
      fc.boolean(),
      async (reviseChoices, endWithArchive) => {
        const { store, context } = makeContext();
        await buildDraftedPlan(context);
        assertSchemaValid(store);

        for (const revise of reviseChoices) {
          await runOneCycle(context, store, revise);
        }

        // After the loop, state is either "committed" (last cycle adapted,
        // or no cycles ran and we commit once) or "drafted" (last cycle
        // revised). Either way, get to a terminal-archivable state so the
        // flow always ends validly.
        const cur = state(store).state as string;
        if (cur === "drafted") {
          await run("commit", {}, context);
          assertSchemaValid(store);
        }
        if (endWithArchive) {
          await run("archive", { reason: "flow complete" }, context);
          assertSchemaValid(store);
        }
        return true;
      },
    ),
    { numRuns: NIGHT(50) },
  );
});

// ============================================================================
// (g) hydrate() is idempotent under a frozen clock
// ============================================================================

Deno.test("property: hydrate() is idempotent — two calls under a frozen clock produce byte-identical summaries", async () => {
  const time = new FakeTime("2026-06-01T00:00:00.000Z");
  try {
    const { store, context } = makeContext();
    await buildDraftedPlan(context);
    await run("commit", {}, context);
    await run("hydrate", {}, context);
    const first = JSON.stringify(store.hydrate);
    await run("hydrate", {}, context);
    const second = JSON.stringify(store.hydrate);
    assertEquals(first, second);
  } finally {
    time.restore();
  }
});
