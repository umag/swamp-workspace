// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Coverage suite for @magistr/good-planning (STANDARD.md `coverage`).
//
// Closes branch gaps a reviewer identified that neither the existing
// contract-fixture (good_planning.test.ts) nor the new methods/adversarial
// suites otherwise protect:
//   - evaluate()'s ceiling branch when `timeToCruxWeeks` is omitted
//   - adapt()'s exercisedCeilingCrux matching vs. non-matching branch
//   - guardState()'s array-form vs. scalar-form rejection message
//   - every FALSE branch of auditDiagnosticQuestions (isolated, not just the
//     one "everything absent" case the contract-fixture already covers)
//   - hydrate()'s hypothesis/commitment split arithmetic
//   - archive()'s guard-throw from every non-terminal-reachable state
//
// Own copy of the fake-context harness (established porkbun/comfyui
// precedent) plus the `run()` real-zod-boundary wrapper.

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";

import {
  auditDiagnosticQuestions,
  governabilityScore,
  guardState,
  model,
  type PlanState,
  PlanStateSchema,
} from "./good_planning.ts";

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

function makeContext(
  initial: Record<string, StoredRecord> = {},
): { store: Record<string, StoredRecord>; context: Ctx } {
  const store: Record<string, StoredRecord> = { ...initial };
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

async function buildDraftedPlan(): Promise<
  { store: Record<string, StoredRecord>; ctx: Ctx }
> {
  const { store, context } = makeContext();
  await run("start", {
    strategicChoice: "Win the SMB segment via self-serve",
    horizon: "3y",
  }, context);
  await run("add_assumption", {
    statement: "Self-serve conversion stays above 8%",
    impact: "high",
    vulnerability: "medium",
    signpostName: "self_serve_conversion_pct",
  }, context);
  await run("add_commitment", {
    kind: "commitment",
    description: "Ship onboarding v2",
    owner: "alice",
    budgetUsd: 250000,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "Slip launch by one quarter",
  }, context);
  await run("add_allocation", {
    priority: "self-serve",
    protectedBudgetUsd: 500000,
  }, context);
  await run("add_ceiling", {
    crux: "support capacity",
    leadTimeWeeks: 6,
    safetyMarginWeeks: 2,
    signpostName: "support_ticket_volume",
    optionPremiums: ["pre-qualify second support vendor"],
  }, context);
  await run("add_tripwire", {
    signpostName: "self_serve_conversion_pct",
    thresholdExpr: "< 6",
    preAuthorizedAction: "Pause paid acquisition; investigate funnel",
    pullbackRung: 0,
  }, context);
  return { store, ctx: context };
}

// ============================================================================
// evaluate() — ceiling branch when timeToCruxWeeks is omitted
// ============================================================================

Deno.test("coverage: evaluate() on a ceiling's signpost WITHOUT timeToCruxWeeks only stamps lastEvaluatedAt", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  await run("evaluate", {
    signpostName: "support_ticket_volume",
    reading: "900/wk",
    // timeToCruxWeeks intentionally omitted
  }, ctx);
  const c = (state(store).ceilings as Array<Record<string, unknown>>)[0];
  assertEquals(c.lastTimeToCruxWeeks, undefined);
  assertEquals(c.lastTriggerPointWeeks, undefined);
  assertEquals(typeof c.lastEvaluatedAt, "string");
});

// ============================================================================
// adapt() — exercisedCeilingCrux matching vs. non-matching branch
// ============================================================================

async function reachAdapting(): Promise<
  { store: Record<string, StoredRecord>; ctx: Ctx }
> {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  await run("evaluate", {
    signpostName: "self_serve_conversion_pct",
    reading: "5.4",
    tripwireState: "fired",
  }, ctx);
  await run("trigger", {
    signpostName: "self_serve_conversion_pct",
    reason: "fired",
  }, ctx);
  return { store, ctx };
}

Deno.test("coverage: adapt() with a MATCHING exercisedCeilingCrux marks that ceiling 'exercised'", async () => {
  const { ctx, store } = await reachAdapting();
  await run("adapt", {
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "exercised the support vendor option",
    reason: "tripwire fired",
    exercisedCeilingCrux: "support capacity",
  }, ctx);
  const c = (state(store).ceilings as Array<Record<string, unknown>>)[0];
  assertEquals(c.status, "exercised");
});

Deno.test("coverage: adapt() with a NON-matching exercisedCeilingCrux leaves every ceiling untouched, no error", async () => {
  const { ctx, store } = await reachAdapting();
  await run("adapt", {
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "paused acquisition",
    reason: "tripwire fired",
    exercisedCeilingCrux: "a crux that does not exist",
  }, ctx);
  const c = (state(store).ceilings as Array<Record<string, unknown>>)[0];
  assertEquals(c.status, "open");
  assertEquals(state(store).state, "committed");
});

Deno.test("coverage: adapt() with NO exercisedCeilingCrux leaves ceilings array reference-equal in content (no-op branch)", async () => {
  const { ctx, store } = await reachAdapting();
  await run("adapt", {
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "paused acquisition",
    reason: "tripwire fired",
  }, ctx);
  const c = (state(store).ceilings as Array<Record<string, unknown>>)[0];
  assertEquals(c.status, "open");
});

// ============================================================================
// guardState() — array-form vs. scalar-form rejection
// ============================================================================

Deno.test("coverage: guardState scalar-form rejection names the single expected state", () => {
  assertThrows(
    () => guardState("monitoring", "drafted", "add_assumption"),
    Error,
    "Expected: drafted",
  );
});

Deno.test("coverage: guardState array-form rejection names every allowed state, matching archive()'s own usage", () => {
  assertThrows(
    () => guardState("drafted", ["committed", "monitoring"], "archive"),
    Error,
    "Expected: committed, monitoring",
  );
});

Deno.test("coverage: guardState array-form allows a state anywhere in the list, not just the first", () => {
  // Does not throw for either allowed member.
  guardState("committed", ["committed", "monitoring"], "archive");
  guardState("monitoring", ["committed", "monitoring"], "archive");
});

// ============================================================================
// auditDiagnosticQuestions() — every FALSE branch, isolated
// ============================================================================

function minimalPlan(overrides: Partial<PlanState>): PlanState {
  return PlanStateSchema.parse({
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  });
}

Deno.test("coverage: layer2Aligned is false when allocations exist but sum to zero protected budget", () => {
  const plan = minimalPlan({
    allocations: [{ priority: "p", protectedBudgetUsd: 0, raidLog: [] }],
  });
  const a = auditDiagnosticQuestions(plan);
  assertEquals(a.layer2Aligned, false);
  assertEquals(
    a.layer2Answer,
    "Budget reproduces last year's pattern. Strategy says one thing, money says another.",
  );
});

Deno.test("coverage: layer3Coherent is false when commitments exist but are incomplete, with an accurate count in the answer", () => {
  const plan = minimalPlan({
    commitments: [
      {
        kind: "commitment",
        description: "ship",
        owner: "", // missing -> incomplete
        budgetUsd: 1,
        byDate: "2026-09-01",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
        status: "open",
      },
      {
        kind: "commitment",
        description: "ship 2",
        owner: "bob",
        budgetUsd: 1,
        byDate: "2026-09-01",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
        status: "open",
      },
    ],
  });
  const a = auditDiagnosticQuestions(plan);
  assertEquals(a.layer3Coherent, false);
  assertEquals(
    a.layer3Answer,
    "2 commitment(s), 1 incomplete — wish list, not a plan",
  );
});

Deno.test("coverage: layer4CeilingPresent/layer4FloorPresent are false and score reflects each individually", () => {
  const withOnlyCeiling = minimalPlan({
    ceilings: [{
      crux: "c",
      leadTimeWeeks: 1,
      safetyMarginWeeks: 0,
      signpostName: "s",
      optionPremiums: [],
      status: "open",
    }],
  });
  const a1 = auditDiagnosticQuestions(withOnlyCeiling);
  assertEquals(a1.layer4CeilingPresent, true);
  assertEquals(a1.layer4FloorPresent, false);
  assertEquals(governabilityScore(withOnlyCeiling), 0.2);

  const withOnlyTripwire = minimalPlan({
    tripwires: [{
      signpostName: "s",
      thresholdExpr: "< 1",
      preAuthorizedAction: "act",
      state: "dormant",
    }],
  });
  const a2 = auditDiagnosticQuestions(withOnlyTripwire);
  assertEquals(a2.layer4CeilingPresent, false);
  assertEquals(a2.layer4FloorPresent, true);
  assertEquals(governabilityScore(withOnlyTripwire), 0.2);
});

// ============================================================================
// hydrate() — hypothesis/commitment split arithmetic
// ============================================================================

Deno.test("coverage: hydrate splits commitments vs. hypotheses correctly when both kinds are present", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_commitment", {
    kind: "commitment",
    description: "a real commitment",
    owner: "alice",
    budgetUsd: 1,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  }, context);
  await run("add_commitment", {
    kind: "hypothesis",
    description: "an external bet",
    owner: "bob",
    budgetUsd: 1,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  }, context);
  await run("add_commitment", {
    kind: "hypothesis",
    description: "another external bet",
    owner: "carol",
    budgetUsd: 1,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  }, context);
  await run("hydrate", {}, context);
  const layerCounts = (store.hydrate as Record<string, unknown>)
    .layerCounts as Record<string, number>;
  assertEquals(layerCounts.commitments, 1);
  assertEquals(layerCounts.hypotheses, 2);
});

// ============================================================================
// archive() — guard-throw from every non-terminal-reachable state
// ============================================================================

Deno.test("coverage: archive() throws from 'drafted' (before any commit)", async () => {
  const { ctx } = await buildDraftedPlan();
  await assertRejects(
    () => run("archive", { reason: "too early" }, ctx),
    Error,
    "Cannot call 'archive' in state 'drafted'",
  );
});

Deno.test("coverage: archive() throws from 'adapting'", async () => {
  const { ctx, store } = await reachAdapting();
  assertEquals(state(store).state, "adapting"); // sanity on the fixture
  await assertRejects(
    () => run("archive", { reason: "mid-adapt" }, ctx),
    Error,
    "Cannot call 'archive' in state 'adapting'",
  );
});

Deno.test("coverage: archive() throws on a SECOND archive (already 'archived')", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("archive", { reason: "first archive" }, ctx);
  await assertRejects(
    () => run("archive", { reason: "second archive" }, ctx),
    Error,
    "Cannot call 'archive' in state 'archived'",
  );
});
