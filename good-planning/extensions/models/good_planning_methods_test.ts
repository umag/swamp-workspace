// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Methods suite for @magistr/good-planning (STANDARD.md `methods`).
//
// Exercises every one of the model's 17 methods along three axes:
//   - success  — the happy path, asserting the written resource shape
//   - guard    — the `guardState` throw when called from the wrong state
//   - no-plan  — the "No plan — run 'start' first" throw when `current`
//                has never been written
//
// `good_planning.ts` is BYTE-FROZEN by the ext-quality-bf-good-planning
// backfill — every assertion here characterizes already-shipped behavior.
// Uses its own copy of the fake-context harness (the established
// porkbun/comfyui precedent: each new suite file is self-contained) plus a
// `run()` wrapper that parses through the method's real zod `arguments`
// schema before `execute()`, so a CLI-boundary regression (an arg silently
// stripped because it's missing from the schema) would surface here too.

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";

import { model, PlanStateSchema } from "./good_planning.ts";

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

/** Drive the model to a fully-populated drafted plan via a fresh context. */
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

const NO_PLAN = "No plan — run 'start' first";

// ============================================================================
// start
// ============================================================================

Deno.test("start: success — creates a drafted plan with all layer collections empty", async () => {
  const { context, store } = makeContext();
  await run("start", {
    strategicChoice: "Win the SMB segment",
    horizon: "2y",
    notes: "board offsite output",
  }, context);
  const s = state(store);
  assertEquals(s.state, "drafted");
  assertEquals(s.strategicChoice, "Win the SMB segment");
  assertEquals(s.horizon, "2y");
  assertEquals(s.notes, "board offsite output");
  assertEquals(s.assumptions, []);
  assertEquals(s.planVersion, 1);
});

Deno.test("start: success — notes is optional and omitted when not given", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  assertEquals(state(store).notes, undefined);
});

// ============================================================================
// add_assumption
// ============================================================================

Deno.test("add_assumption: success — appends an assumption, forcing state to 'holding'", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_assumption", {
    statement: "y",
    impact: "high",
    vulnerability: "low",
    signpostName: "z",
  }, context);
  const s = state(store);
  assertEquals((s.assumptions as unknown[]).length, 1);
  assertEquals(
    (s.assumptions as Array<Record<string, unknown>>)[0].state,
    "holding",
  );
});

Deno.test("add_assumption: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("add_assumption", {
        statement: "late addition",
        impact: "low",
        vulnerability: "low",
        signpostName: "late_signal",
      }, ctx),
    Error,
    "Cannot call 'add_assumption'",
  );
});

Deno.test("add_assumption: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      run("add_assumption", {
        statement: "y",
        impact: "high",
        vulnerability: "low",
        signpostName: "z",
      }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// add_commitment
// ============================================================================

Deno.test("add_commitment: success — appends a six-property-complete commitment with status 'open'", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_commitment", {
    kind: "commitment",
    description: "ship",
    owner: "alice",
    budgetUsd: 100,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  }, context);
  const c = (state(store).commitments as Array<Record<string, unknown>>)[0];
  assertEquals(c.status, "open");
});

Deno.test("add_commitment: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("add_commitment", {
        kind: "commitment",
        description: "late",
        owner: "bob",
        budgetUsd: 1,
        byDate: "2026-10-01",
        dependsOn: [],
        reviewCadence: "monthly",
        consequenceIfChanged: "n/a",
      }, ctx),
    Error,
    "Cannot call 'add_commitment'",
  );
});

Deno.test("add_commitment: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      run("add_commitment", {
        kind: "commitment",
        description: "ship",
        owner: "alice",
        budgetUsd: 100,
        byDate: "2026-09-01",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
      }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// add_allocation
// ============================================================================

Deno.test("add_allocation: success — appends an allocation with an empty raidLog", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_allocation", {
    priority: "self-serve",
    protectedBudgetUsd: 500000,
  }, context);
  const a = (state(store).allocations as Array<Record<string, unknown>>)[0];
  assertEquals(a.raidLog, []);
});

Deno.test("add_allocation: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("add_allocation", {
        priority: "late",
        protectedBudgetUsd: 1,
      }, ctx),
    Error,
    "Cannot call 'add_allocation'",
  );
});

Deno.test("add_allocation: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      run("add_allocation", {
        priority: "self-serve",
        protectedBudgetUsd: 1,
      }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// add_ceiling
// ============================================================================

Deno.test("add_ceiling: success — appends a ceiling with status 'open'", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_ceiling", {
    crux: "support capacity",
    leadTimeWeeks: 6,
    safetyMarginWeeks: 2,
    signpostName: "support_ticket_volume",
    optionPremiums: [],
  }, context);
  const c = (state(store).ceilings as Array<Record<string, unknown>>)[0];
  assertEquals(c.status, "open");
});

Deno.test("add_ceiling: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("add_ceiling", {
        crux: "late",
        leadTimeWeeks: 1,
        safetyMarginWeeks: 0,
        signpostName: "late_signpost",
        optionPremiums: [],
      }, ctx),
    Error,
    "Cannot call 'add_ceiling'",
  );
});

Deno.test("add_ceiling: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      run("add_ceiling", {
        crux: "support capacity",
        leadTimeWeeks: 6,
        safetyMarginWeeks: 2,
        signpostName: "support_ticket_volume",
        optionPremiums: [],
      }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// add_tripwire
// ============================================================================

Deno.test("add_tripwire: success — appends a tripwire with state 'dormant'", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_tripwire", {
    signpostName: "self_serve_conversion_pct",
    thresholdExpr: "< 6",
    preAuthorizedAction: "Pause paid acquisition",
  }, context);
  const t = (state(store).tripwires as Array<Record<string, unknown>>)[0];
  assertEquals(t.state, "dormant");
});

Deno.test("add_tripwire: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("add_tripwire", {
        signpostName: "late_signpost",
        thresholdExpr: "< 1",
        preAuthorizedAction: "act",
      }, ctx),
    Error,
    "Cannot call 'add_tripwire'",
  );
});

Deno.test("add_tripwire: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      run("add_tripwire", {
        signpostName: "self_serve_conversion_pct",
        thresholdExpr: "< 6",
        preAuthorizedAction: "Pause paid acquisition",
      }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// set_pullback_ladder
// ============================================================================

Deno.test("set_pullback_ladder: success — records the ordered rungs", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("set_pullback_ladder", {
    rungs: ["pause paid acquisition", "cut travel", "hiring freeze"],
  }, context);
  assertEquals(state(store).pullbackLadder, [
    "pause paid acquisition",
    "cut travel",
    "hiring freeze",
  ]);
});

Deno.test("set_pullback_ladder: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () => run("set_pullback_ladder", { rungs: ["late"] }, ctx),
    Error,
    "Cannot call 'set_pullback_ladder'",
  );
});

Deno.test("set_pullback_ladder: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => run("set_pullback_ladder", { rungs: ["x"] }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// set_loss_budget
// ============================================================================

Deno.test("set_loss_budget: success — records the five components verbatim", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("set_loss_budget", {
    sunkCostUsd: 10,
    shutdownCostUsd: 20,
    committedLiabilitiesUsd: 30,
    workingCapitalUnwindUsd: 40,
    tailProvisionsUsd: 50,
  }, context);
  assertEquals(state(store).lossBudget, {
    sunkCostUsd: 10,
    shutdownCostUsd: 20,
    committedLiabilitiesUsd: 30,
    workingCapitalUnwindUsd: 40,
    tailProvisionsUsd: 50,
  });
});

Deno.test("set_loss_budget: guard — throws when plan is not 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () => run("set_loss_budget", {}, ctx),
    Error,
    "Cannot call 'set_loss_budget'",
  );
});

Deno.test("set_loss_budget: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => run("set_loss_budget", {}, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// commit
// ============================================================================

Deno.test("commit: success — drafted -> committed for a fully-populated plan", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  assertEquals(state(store).state, "committed");
});

Deno.test("commit: guard — throws on a second commit (already 'committed')", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () => run("commit", {}, ctx),
    Error,
    "Cannot call 'commit'",
  );
});

Deno.test("commit: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(() => run("commit", {}, context), Error, NO_PLAN);
});

// ============================================================================
// monitor
// ============================================================================

Deno.test("monitor: success — committed -> monitoring", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  assertEquals(state(store).state, "monitoring");
});

Deno.test("monitor: guard — throws when plan is still 'drafted'", async () => {
  const { ctx } = await buildDraftedPlan();
  await assertRejects(
    () => run("monitor", {}, ctx),
    Error,
    "Cannot call 'monitor'",
  );
});

Deno.test("monitor: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(() => run("monitor", {}, context), Error, NO_PLAN);
});

// ============================================================================
// evaluate
// ============================================================================

Deno.test("evaluate: success — updates every assumption/tripwire/ceiling sharing the signpost", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  await run("evaluate", {
    signpostName: "self_serve_conversion_pct",
    reading: "5.4",
    assumptionState: "breaking",
    tripwireState: "fired",
  }, ctx);
  const s = state(store);
  assertEquals(
    (s.assumptions as Array<Record<string, unknown>>)[0].state,
    "breaking",
  );
  assertEquals(
    (s.tripwires as Array<Record<string, unknown>>)[0].state,
    "fired",
  );
});

Deno.test("evaluate: guard — throws when plan is not 'monitoring'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("evaluate", {
        signpostName: "self_serve_conversion_pct",
        reading: "5",
      }, ctx),
    Error,
    "Cannot call 'evaluate'",
  );
});

Deno.test("evaluate: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => run("evaluate", { signpostName: "x", reading: "1" }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// trigger
// ============================================================================

Deno.test("trigger: success — monitoring -> adapting once the signpost's tripwire has fired", async () => {
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
    reason: "conversion below threshold",
  }, ctx);
  assertEquals(state(store).state, "adapting");
});

Deno.test("trigger: guard — throws when plan is not 'monitoring'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("trigger", {
        signpostName: "self_serve_conversion_pct",
        reason: "x",
      }, ctx),
    Error,
    "Cannot call 'trigger'",
  );
});

Deno.test("trigger: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => run("trigger", { signpostName: "x", reason: "y" }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// adapt
// ============================================================================

Deno.test("adapt: success — adapting -> committed, appends an AdaptEvent", async () => {
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
  await run("adapt", {
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "paused acquisition",
    reason: "tripwire fired",
  }, ctx);
  const s = state(store);
  assertEquals(s.state, "committed");
  assertEquals((s.adaptHistory as unknown[]).length, 1);
});

Deno.test("adapt: guard — throws when plan is not 'adapting'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () =>
      run("adapt", {
        triggeredBy: "x",
        actionTaken: "y",
        reason: "z",
      }, ctx),
    Error,
    "Cannot call 'adapt'",
  );
});

Deno.test("adapt: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      run(
        "adapt",
        { triggeredBy: "x", actionTaken: "y", reason: "z" },
        context,
      ),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// revise
// ============================================================================

Deno.test("revise: success — adapting -> drafted, bumps planVersion, appends a ReviseEvent", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  await run("evaluate", {
    signpostName: "self_serve_conversion_pct",
    reading: "0",
    tripwireState: "fired",
  }, ctx);
  await run("trigger", {
    signpostName: "self_serve_conversion_pct",
    reason: "assumption broken",
  }, ctx);
  await run("revise", {
    reason: "thesis no longer holds",
    brokenAssumptions: ["Self-serve conversion stays above 8%"],
  }, ctx);
  const s = state(store);
  assertEquals(s.state, "drafted");
  assertEquals(s.planVersion, 2);
  assertEquals((s.reviseHistory as unknown[]).length, 1);
});

Deno.test("revise: guard — throws when plan is not 'adapting'", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await assertRejects(
    () => run("revise", { reason: "x", brokenAssumptions: [] }, ctx),
    Error,
    "Cannot call 'revise'",
  );
});

Deno.test("revise: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => run("revise", { reason: "x", brokenAssumptions: [] }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// archive
// ============================================================================

Deno.test("archive: success — from 'committed' to 'archived'", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("archive", { reason: "superseded" }, ctx);
  assertEquals(state(store).state, "archived");
});

Deno.test("archive: success — from 'monitoring' to 'archived'", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  await run("archive", { reason: "horizon ended" }, ctx);
  assertEquals(state(store).state, "archived");
});

Deno.test("archive: guard — throws when plan is 'drafted' (array-form expected states)", async () => {
  const { ctx } = await buildDraftedPlan();
  await assertRejects(
    () => run("archive", { reason: "too early" }, ctx),
    Error,
    "Cannot call 'archive'",
  );
});

Deno.test("archive: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => run("archive", { reason: "x" }, context),
    Error,
    NO_PLAN,
  );
});

// ============================================================================
// audit
// ============================================================================

Deno.test("audit: success — returns five answers and appends to audits[]", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("audit", {}, ctx);
  const s = state(store);
  assertEquals((s.audits as unknown[]).length, 1);
  assertEquals(
    (s.audits as Array<Record<string, unknown>>)[0].governabilityScore,
    1,
  );
});

Deno.test("audit: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(() => run("audit", {}, context), Error, NO_PLAN);
});

// ============================================================================
// hydrate
// ============================================================================

Deno.test("hydrate: success — writes the 'summary' resource without mutating 'state'", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  const before = state(store).updatedAt;
  await run("hydrate", {}, ctx);
  assertEquals(state(store).updatedAt, before);
  assertExists(store.hydrate);
});

Deno.test("hydrate: no-plan — throws before 'start'", async () => {
  const { context } = makeContext();
  await assertRejects(() => run("hydrate", {}, context), Error, NO_PLAN);
});
