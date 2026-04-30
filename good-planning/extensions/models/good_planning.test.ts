// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import {
  auditDiagnosticQuestions,
  commitGateReport,
  type Commitment,
  commitmentSatisfiesSixProperties,
  computeMaxTolerableLoss,
  computeTriggerPoint,
  governabilityScore,
  guardState,
  knownSignposts,
  type LossBudget,
  model,
  type PlanState,
  PlanStateSchema,
} from "./good_planning.ts";

// ============================================================================
// Test harness
// ============================================================================

type StoredRecord = Record<string, unknown>;

function makeContext(
  initial: Record<string, StoredRecord> = {},
): {
  store: Record<string, StoredRecord>;
  context: {
    logger: { info: (msg: string, data?: Record<string, unknown>) => void };
    readResource: (
      name: string,
    ) => Promise<Record<string, unknown> | null>;
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => Promise<unknown>;
    definition: { name: string };
  };
} {
  const store: Record<string, StoredRecord> = { ...initial };
  return {
    store,
    context: {
      logger: { info: (_m: string) => {} },
      readResource: (name: string) => Promise.resolve(store[name] ?? null),
      writeResource: (spec: string, name: string, data: StoredRecord) => {
        // Strict schema check on writes — catches schema regressions inside
        // method bodies, not just at deserialization.
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

// Convenience: drive the model to a fully-populated drafted plan
async function buildDraftedPlan(): Promise<{
  store: Record<string, StoredRecord>;
  ctx: ReturnType<typeof makeContext>["context"];
}> {
  const { store, context } = makeContext();
  await model.methods.start.execute({
    strategicChoice: "Win the SMB segment via self-serve",
    horizon: "3y",
  }, context);
  await model.methods.add_assumption.execute({
    statement: "Self-serve conversion stays above 8%",
    impact: "high",
    vulnerability: "medium",
    signpostName: "self_serve_conversion_pct",
  }, context);
  await model.methods.add_commitment.execute({
    kind: "commitment",
    description: "Ship onboarding v2",
    owner: "alice",
    budgetUsd: 250000,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "Slip launch by one quarter",
  }, context);
  await model.methods.add_allocation.execute({
    priority: "self-serve",
    protectedBudgetUsd: 500000,
  }, context);
  await model.methods.add_ceiling.execute({
    crux: "support capacity",
    leadTimeWeeks: 6,
    safetyMarginWeeks: 2,
    signpostName: "support_ticket_volume",
    optionPremiums: ["pre-qualify second support vendor"],
  }, context);
  await model.methods.add_tripwire.execute({
    signpostName: "self_serve_conversion_pct",
    thresholdExpr: "< 6",
    preAuthorizedAction: "Pause paid acquisition; investigate funnel",
    pullbackRung: 0,
  }, context);
  return { store, ctx: context };
}

// ============================================================================
// Article claim: every plan embeds a model of reality (Layer 1)
// ============================================================================

Deno.test("PlanStateSchema parses an empty plan with defaults", () => {
  const parsed = PlanStateSchema.parse({
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  assertEquals(parsed.assumptions, []);
  assertEquals(parsed.commitments, []);
  assertEquals(parsed.allocations, []);
  assertEquals(parsed.ceilings, []);
  assertEquals(parsed.tripwires, []);
  assertEquals(parsed.lossBudget.sunkCostUsd, 0);
  assertEquals(parsed.planVersion, 1);
});

// ============================================================================
// Article claim: without the six properties you have a wish list
// ============================================================================

Deno.test("commitmentSatisfiesSixProperties — empty owner is missing", () => {
  const c: Commitment = {
    kind: "commitment",
    description: "x",
    owner: "",
    budgetUsd: 100,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
    status: "open",
  };
  const r = commitmentSatisfiesSixProperties(c);
  assertEquals(r.ok, false);
  assertEquals(r.missing, ["owner"]);
});

Deno.test("commitmentSatisfiesSixProperties — zero budget is missing", () => {
  const c: Commitment = {
    kind: "commitment",
    description: "x",
    owner: "alice",
    budgetUsd: 0,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
    status: "open",
  };
  assertEquals(commitmentSatisfiesSixProperties(c).missing, ["budgetUsd"]);
});

Deno.test("commitmentSatisfiesSixProperties — bad date is missing", () => {
  const c: Commitment = {
    kind: "commitment",
    description: "x",
    owner: "alice",
    budgetUsd: 100,
    byDate: "not a date",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
    status: "open",
  };
  assertEquals(commitmentSatisfiesSixProperties(c).missing, ["byDate"]);
});

Deno.test("commitmentSatisfiesSixProperties — full commitment is ok", () => {
  const c: Commitment = {
    kind: "commitment",
    description: "ship",
    owner: "alice",
    budgetUsd: 100,
    byDate: "2026-09-01",
    dependsOn: ["x"],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
    status: "open",
  };
  assertEquals(commitmentSatisfiesSixProperties(c).ok, true);
});

Deno.test("add_commitment refuses incomplete commitment", async () => {
  const { context } = makeContext();
  await model.methods.start.execute({
    strategicChoice: "x",
    horizon: "1y",
  }, context);
  await assertRejects(
    () =>
      model.methods.add_commitment.execute({
        kind: "commitment",
        description: "wishful",
        owner: "",
        budgetUsd: 0,
        byDate: "2026-09-01",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
      }, context),
    Error,
    "wish list",
  );
});

// ============================================================================
// Article math: trigger_point = time_to_crux − lead_time − safety_margin
// ============================================================================

Deno.test("computeTriggerPoint — positive when on time", () => {
  const c = { leadTimeWeeks: 6, safetyMarginWeeks: 2 };
  assertEquals(computeTriggerPoint(c, 12), 4);
});

Deno.test("computeTriggerPoint — negative means already late", () => {
  const c = { leadTimeWeeks: 6, safetyMarginWeeks: 2 };
  assertEquals(computeTriggerPoint(c, 5), -3);
});

Deno.test("computeTriggerPoint — zero safety margin", () => {
  const c = { leadTimeWeeks: 4, safetyMarginWeeks: 0 };
  assertEquals(computeTriggerPoint(c, 5), 1);
});

// ============================================================================
// Article math: max_tolerable_loss = sunk + shutdown + liabilities + wc + tail
// ============================================================================

Deno.test("computeMaxTolerableLoss sums all five components", () => {
  const b: LossBudget = {
    sunkCostUsd: 100,
    shutdownCostUsd: 200,
    committedLiabilitiesUsd: 300,
    workingCapitalUnwindUsd: 400,
    tailProvisionsUsd: 500,
  };
  assertEquals(computeMaxTolerableLoss(b), 1500);
});

// ============================================================================
// Article claim: state machine — every legal transition allowed, illegal throws
// ============================================================================

Deno.test("guardState allows expected state", () => {
  guardState("drafted", "drafted", "test");
  guardState("drafted", ["drafted", "monitoring"], "test");
});

Deno.test("guardState throws on illegal state with useful message", () => {
  try {
    guardState("monitoring", "drafted", "add_assumption");
    throw new Error("should have thrown");
  } catch (e) {
    assertStringIncludes((e as Error).message, "monitoring");
    assertStringIncludes((e as Error).message, "add_assumption");
    assertStringIncludes((e as Error).message, "drafted");
  }
});

Deno.test("end-to-end happy path: drafted → committed → monitoring → adapting → committed", async () => {
  const { ctx, store } = await buildDraftedPlan();
  // commit
  await model.methods.commit.execute({}, ctx);
  assertEquals((store.current as unknown as PlanState).state, "committed");
  // monitor
  await model.methods.monitor.execute({}, ctx);
  assertEquals((store.current as unknown as PlanState).state, "monitoring");
  // evaluate the tripwire signpost
  await model.methods.evaluate.execute({
    signpostName: "self_serve_conversion_pct",
    reading: "5.4",
    tripwireState: "fired",
  }, ctx);
  assertEquals(
    (store.current as unknown as PlanState).tripwires[0].state,
    "fired",
  );
  // trigger
  await model.methods.trigger.execute({
    signpostName: "self_serve_conversion_pct",
    reason: "conversion below threshold",
  }, ctx);
  assertEquals((store.current as unknown as PlanState).state, "adapting");
  // adapt
  await model.methods.adapt.execute({
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "Paused paid acquisition; investigation kicked off",
    reason: "Tripwire fired",
  }, ctx);
  assertEquals((store.current as unknown as PlanState).state, "committed");
  assertEquals((store.current as unknown as PlanState).adaptHistory.length, 1);
});

Deno.test("revise bumps planVersion and returns to drafted", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.monitor.execute({}, ctx);
  await model.methods.evaluate.execute({
    signpostName: "self_serve_conversion_pct",
    reading: "0",
    tripwireState: "fired",
    assumptionState: "broken",
  }, ctx);
  await model.methods.trigger.execute({
    signpostName: "self_serve_conversion_pct",
    reason: "fundamental assumption broken",
  }, ctx);
  await model.methods.revise.execute({
    reason: "Self-serve thesis no longer holds",
    brokenAssumptions: ["Self-serve conversion stays above 8%"],
  }, ctx);
  const s = store.current as unknown as PlanState;
  assertEquals(s.state, "drafted");
  assertEquals(s.planVersion, 2);
  assertEquals(s.reviseHistory.length, 1);
});

// ============================================================================
// Article claim: commit gate refuses to leave drafted unless all layers present
// ============================================================================

Deno.test("commitGateReport flags every empty layer", () => {
  const empty: PlanState = {
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    assumptions: [],
    commitments: [],
    allocations: [],
    ceilings: [],
    tripwires: [],
    pullbackLadder: [],
    lossBudget: {
      sunkCostUsd: 0,
      shutdownCostUsd: 0,
      committedLiabilitiesUsd: 0,
      workingCapitalUnwindUsd: 0,
      tailProvisionsUsd: 0,
    },
    adaptHistory: [],
    reviseHistory: [],
    audits: [],
    planVersion: 1,
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  };
  const r = commitGateReport(empty);
  assertEquals(r.ok, false);
  const layers = r.gaps.map((g) => g.layer).sort();
  assertEquals(
    layers,
    [
      "assumption",
      "ceiling",
      "coordinative",
      "floor",
      "allocative",
    ].sort(),
  );
});

Deno.test("commit() throws on incomplete plan listing every gap", async () => {
  const { context } = makeContext();
  await model.methods.start.execute({
    strategicChoice: "x",
    horizon: "1y",
  }, context);
  await assertRejects(
    () => model.methods.commit.execute({}, context),
    Error,
    "[assumption]",
  );
});

Deno.test("commit() succeeds when every layer is populated", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  assertEquals((store.current as unknown as PlanState).state, "committed");
});

// ============================================================================
// Article claim: signposts are observed; typos must surface
// ============================================================================

Deno.test("evaluate() throws on unknown signpost listing known ones", async () => {
  const { ctx } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.monitor.execute({}, ctx);
  await assertRejects(
    () =>
      model.methods.evaluate.execute({
        signpostName: "self_serve_conversoin_pct", // typo
        reading: "5",
      }, ctx),
    Error,
    "Unknown signpost",
  );
});

Deno.test("knownSignposts dedups across layers", async () => {
  const { store } = await buildDraftedPlan();
  const known = knownSignposts(store.current as unknown as PlanState);
  // assumption + tripwire share one signpost; ceiling adds a different one
  assertEquals(known.length, 2);
});

// ============================================================================
// Article claim: trigger requires a real signal — not a typo or stale state
// ============================================================================

Deno.test("trigger() refuses when no tripwire fired and no ceiling breached", async () => {
  const { ctx } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.monitor.execute({}, ctx);
  // evaluate with state still dormant
  await model.methods.evaluate.execute({
    signpostName: "self_serve_conversion_pct",
    reading: "9",
    tripwireState: "dormant",
  }, ctx);
  await assertRejects(
    () =>
      model.methods.trigger.execute({
        signpostName: "self_serve_conversion_pct",
        reason: "trying to spin",
      }, ctx),
    Error,
    "No fired tripwire",
  );
});

Deno.test("ceiling triggers adapt when triggerPointWeeks ≤ 0", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.monitor.execute({}, ctx);
  await model.methods.evaluate.execute({
    signpostName: "support_ticket_volume",
    reading: "1200/wk",
    timeToCruxWeeks: 7, // 7 - 6 - 2 = -1
  }, ctx);
  const c = (store.current as unknown as PlanState).ceilings[0];
  assertEquals(c.lastTriggerPointWeeks, -1);
  // trigger should now succeed for this signpost (ceiling breached)
  await model.methods.trigger.execute({
    signpostName: "support_ticket_volume",
    reason: "ceiling breached",
  }, ctx);
  assertEquals((store.current as unknown as PlanState).state, "adapting");
});

// ============================================================================
// Article claim: adversarial loop hazard — same fired tripwire, no progress
// ============================================================================

Deno.test("re-firing same tripwire after adapt requires fresh evaluate", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.monitor.execute({}, ctx);
  await model.methods.evaluate.execute({
    signpostName: "self_serve_conversion_pct",
    reading: "5.4",
    tripwireState: "fired",
  }, ctx);
  await model.methods.trigger.execute({
    signpostName: "self_serve_conversion_pct",
    reason: "first fire",
  }, ctx);
  await model.methods.adapt.execute({
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "paused acquisition",
    reason: "first adapt",
  }, ctx);
  // After adapt we are in committed. To re-trigger, must monitor + re-evaluate.
  // The tripwire's state is preserved as "fired" — but trigger is gated by
  // the state machine: cannot trigger from committed.
  await assertRejects(
    () =>
      model.methods.trigger.execute({
        signpostName: "self_serve_conversion_pct",
        reason: "trying to re-fire without monitor",
      }, ctx),
    Error,
    "Cannot call 'trigger'",
  );
  // Returning through monitor + re-evaluate is required.
  await model.methods.monitor.execute({}, ctx);
  await model.methods.evaluate.execute({
    signpostName: "self_serve_conversion_pct",
    reading: "5.4",
    tripwireState: "fired",
  }, ctx);
  await model.methods.trigger.execute({
    signpostName: "self_serve_conversion_pct",
    reason: "second fire after re-evaluate",
  }, ctx);
  assertEquals((store.current as unknown as PlanState).state, "adapting");
});

// ============================================================================
// Article claim: hydrate writes summary only — never mutates state
// ============================================================================

Deno.test("hydrate writes summary without touching state", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  const beforeUpdatedAt = (store.current as unknown as PlanState).updatedAt;
  await model.methods.hydrate.execute({}, ctx);
  // state.updatedAt unchanged; summary present
  assertEquals(
    (store.current as unknown as PlanState).updatedAt,
    beforeUpdatedAt,
  );
  assertExists(store.hydrate);
  const summary = store.hydrate as Record<string, unknown>;
  assertEquals(summary.state, "committed");
  assertEquals(
    (summary.layerCounts as Record<string, number>).assumptions,
    1,
  );
});

Deno.test("hydrate is idempotent", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.hydrate.execute({}, ctx);
  await model.methods.hydrate.execute({}, ctx);
  // store still has only the summary key — second call overwrote, no error
  assertExists(store.hydrate);
});

// ============================================================================
// Article claim: audit answers the four diagnostic questions
// ============================================================================

Deno.test("audit returns five answers and appends to audits[]", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.audit.execute({}, ctx);
  const s = store.current as unknown as PlanState;
  assertEquals(s.audits.length, 1);
  assertEquals(s.audits[0].layer1Visible, true);
  assertEquals(s.audits[0].layer2Aligned, true);
  assertEquals(s.audits[0].layer3Coherent, true);
  assertEquals(s.audits[0].layer4CeilingPresent, true);
  assertEquals(s.audits[0].layer4FloorPresent, true);
  assertEquals(s.audits[0].governabilityScore, 1);
});

Deno.test("audit reports gaps when layers are absent", () => {
  const onlyAssumption: PlanState = PlanStateSchema.parse({
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    assumptions: [{
      statement: "y",
      impact: "high",
      vulnerability: "high",
      signpostName: "z",
    }],
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  const a = auditDiagnosticQuestions(onlyAssumption);
  assertEquals(a.layer1Visible, true);
  assertEquals(a.layer2Aligned, false);
  assertEquals(a.layer3Coherent, false);
  assertEquals(a.layer4CeilingPresent, false);
  assertEquals(a.layer4FloorPresent, false);
  assertEquals(governabilityScore(onlyAssumption), 0.2);
});

// ============================================================================
// Article claim: archive is terminal — works from committed and monitoring
// ============================================================================

Deno.test("archive from committed", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.archive.execute({ reason: "rolled into v2" }, ctx);
  assertEquals((store.current as unknown as PlanState).state, "archived");
});

Deno.test("archive from monitoring", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await model.methods.commit.execute({}, ctx);
  await model.methods.monitor.execute({}, ctx);
  await model.methods.archive.execute({ reason: "horizon ended" }, ctx);
  assertEquals((store.current as unknown as PlanState).state, "archived");
});

// ============================================================================
// Article claim: legacy-tolerant parsing — readState applies defaults
// ============================================================================

Deno.test("readState fills defaults from minimal stored shape", async () => {
  // Store something missing the optional collections
  const minimal: StoredRecord = {
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  };
  const { context, store } = makeContext({ current: minimal });
  // hydrate calls readState → must succeed with defaults
  await model.methods.hydrate.execute({}, context);
  const summary = store.hydrate as Record<string, unknown>;
  assertEquals(
    (summary.layerCounts as Record<string, number>).assumptions,
    0,
  );
});
