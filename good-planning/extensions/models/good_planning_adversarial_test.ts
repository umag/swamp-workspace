// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// Adversarial suite for @magistr/good-planning (STANDARD.md `adversarial`).
//
// good_planning.ts is PURE LOGIC — no fetch, no Deno.Command, no file I/O, no
// external credentials — so "hostile input" here means: zod-boundary
// rejections and admissions (what a caller can and cannot smuggle past the
// method arguments schema), stored-data corruption, and injection-shaped
// strings that must be stored inertly (this model never interpolates user
// input into a shell command, HTML, or SQL — there is nothing to inject
// INTO). No credential-handling tests: the review-security pass on the
// approved plan found no security-relevant surface (accepted, byte-frozen).
//
// This file ALSO pins GP-1..GP-8 — eight latent bugs found while reading the
// then-byte-frozen source, tracked in the LOCAL good-planning-latent-bugs
// issue-lifecycle model (never the swamp.club Lab). As of 2026.08.02.1 every
// GP-* pin below asserts the FIXED behavior: these eight bugs were real-fixed
// in good_planning.ts (see its `upgrades[]` entry), not merely characterized.
//
// Own copy of the fake-context harness (established porkbun/comfyui
// precedent) plus the `run()` real-zod-boundary wrapper from
// good_planning_methods_test.ts.

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { ZodError } from "npm:zod@4";

import {
  commitGateReport,
  computeMaxTolerableLoss,
  computeTriggerPoint,
  governabilityScore,
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

const emptyLossBudget = {
  sunkCostUsd: 0,
  shutdownCostUsd: 0,
  committedLiabilitiesUsd: 0,
  workingCapitalUnwindUsd: 0,
  tailProvisionsUsd: 0,
};

// ============================================================================
// Hostile input — zod-boundary rejections (empty required strings)
// ============================================================================

Deno.test("hostile: start rejects empty strategicChoice at the zod boundary", () => {
  assertThrows(
    () =>
      model.methods.start.arguments.parse({
        strategicChoice: "",
        horizon: "1y",
      }),
    ZodError,
  );
});

Deno.test("hostile: start rejects empty horizon at the zod boundary", () => {
  assertThrows(
    () =>
      model.methods.start.arguments.parse({
        strategicChoice: "x",
        horizon: "",
      }),
    ZodError,
  );
});

Deno.test("hostile: add_assumption rejects empty statement/signpostName", () => {
  assertThrows(
    () =>
      model.methods.add_assumption.arguments.parse({
        statement: "",
        impact: "high",
        vulnerability: "low",
        signpostName: "z",
      }),
    ZodError,
  );
  assertThrows(
    () =>
      model.methods.add_assumption.arguments.parse({
        statement: "y",
        impact: "high",
        vulnerability: "low",
        signpostName: "",
      }),
    ZodError,
  );
});

Deno.test("hostile: add_tripwire rejects an out-of-enum impact/vulnerability/thresholdExpr", () => {
  assertThrows(
    () =>
      model.methods.add_tripwire.arguments.parse({
        signpostName: "s",
        thresholdExpr: "",
        preAuthorizedAction: "act",
      }),
    ZodError,
  );
});

Deno.test("hostile: set_pullback_ladder rejects an empty rungs array at the zod boundary", () => {
  // The article: an empty pullback ladder means the plan has quietly
  // abandoned floor discipline. `.min(1)` is the only guard against that —
  // pin that it actually rejects, not just accepts a non-empty array.
  assertThrows(
    () => model.methods.set_pullback_ladder.arguments.parse({ rungs: [] }),
    ZodError,
  );
});

// ============================================================================
// Hostile input — negative numbers rejected by .nonnegative()
// ============================================================================

Deno.test("hostile: add_commitment rejects negative budgetUsd at the zod boundary", () => {
  assertThrows(
    () =>
      model.methods.add_commitment.arguments.parse({
        kind: "commitment",
        description: "x",
        owner: "alice",
        budgetUsd: -1,
        byDate: "2026-09-01",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
      }),
    ZodError,
  );
});

Deno.test("hostile: add_allocation rejects negative protectedBudgetUsd", () => {
  assertThrows(
    () =>
      model.methods.add_allocation.arguments.parse({
        priority: "p",
        protectedBudgetUsd: -500,
      }),
    ZodError,
  );
});

Deno.test("hostile: add_ceiling rejects negative leadTimeWeeks/safetyMarginWeeks", () => {
  assertThrows(
    () =>
      model.methods.add_ceiling.arguments.parse({
        crux: "c",
        leadTimeWeeks: -1,
        safetyMarginWeeks: 0,
        signpostName: "s",
        optionPremiums: [],
      }),
    ZodError,
  );
  assertThrows(
    () =>
      model.methods.add_ceiling.arguments.parse({
        crux: "c",
        leadTimeWeeks: 1,
        safetyMarginWeeks: -1,
        signpostName: "s",
        optionPremiums: [],
      }),
    ZodError,
  );
});

Deno.test("hostile: set_loss_budget rejects a negative component", () => {
  assertThrows(
    () =>
      model.methods.set_loss_budget.arguments.parse({
        ...emptyLossBudget,
        sunkCostUsd: -1,
      }),
    ZodError,
  );
});

// ============================================================================
// Hostile input — no upper bound (accepted, no size guard)
// ============================================================================

Deno.test("hostile: add_commitment accepts an enormous budgetUsd (no upper bound)", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_commitment", {
    kind: "commitment",
    description: "moonshot",
    owner: "alice",
    budgetUsd: Number.MAX_SAFE_INTEGER,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  }, context);
  const c = (state(store).commitments as Array<Record<string, unknown>>)[0];
  assertEquals(c.budgetUsd, Number.MAX_SAFE_INTEGER);
});

Deno.test("hostile: a 10,000-character strategicChoice is accepted verbatim (no max-length guard)", async () => {
  const { context, store } = makeContext();
  const huge = "x".repeat(10_000);
  await run("start", { strategicChoice: huge, horizon: "1y" }, context);
  assertEquals((state(store).strategicChoice as string).length, 10_000);
});

// ============================================================================
// Hostile input — injection-shaped strings stored inertly
// ============================================================================

Deno.test("hostile: template-literal and shell-metacharacter strings are stored verbatim, never evaluated", async () => {
  const { context, store } = makeContext();
  const hostile = "${process.env.SECRET}; rm -rf /; `whoami`";
  await run("start", { strategicChoice: hostile, horizon: "1y" }, context);
  assertEquals(state(store).strategicChoice, hostile);
});

Deno.test("hostile: newline-embedded description does not corrupt the stored record", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  const hostile = "line one\nline two\x00line three";
  await run("add_commitment", {
    kind: "commitment",
    description: hostile,
    owner: "alice",
    budgetUsd: 1,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  }, context);
  const c = (state(store).commitments as Array<Record<string, unknown>>)[0];
  assertEquals(c.description, hostile);
});

// ============================================================================
// Spec-violating stored state — corrupted `current` resource
// ============================================================================

Deno.test("hostile: a corrupted stored resource (missing required 'state') throws a ZodError on read, not a silent misread", async () => {
  const corrupted: StoredRecord = {
    // `state` is required — omitted here.
    strategicChoice: "x",
    horizon: "1y",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  };
  const { context } = makeContext({ current: corrupted });
  const err = await assertRejects(() => run("hydrate", {}, context), ZodError);
  // Pin WHICH field zod flagged, not just that some ZodError was thrown.
  assertEquals(
    err.issues.some((i) => i.path.includes("state")),
    true,
  );
});

Deno.test("hostile: an out-of-enum stored 'state' value throws a ZodError on read", async () => {
  const corrupted: StoredRecord = {
    state: "not-a-real-state",
    strategicChoice: "x",
    horizon: "1y",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  };
  const { context } = makeContext({ current: corrupted });
  const err = await assertRejects(() => run("audit", {}, context), ZodError);
  assertEquals(
    err.issues.some((i) => i.path.includes("state")),
    true,
  );
});

// ============================================================================
// GP-1 (MEDIUM) — start() guards against overwriting an existing plan
// ============================================================================

Deno.test("pin: GP-1 fixed — re-invoking start() without force on a committed plan throws and leaves the plan untouched", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  assertEquals(state(store).state, "committed");
  assertEquals(
    (state(store).commitments as unknown[]).length,
    1,
  );

  // fixed: start() now reads-before-write and refuses to clobber a plan.
  await assertRejects(
    () =>
      run("start", {
        strategicChoice: "a completely different plan",
        horizon: "1y",
      }, ctx),
    Error,
    "already exists",
  );
  const s = state(store);
  assertEquals(s.state, "committed");
  assertEquals((s.commitments as unknown[]).length, 1);
  assertEquals(s.planVersion, 1);
});

Deno.test("pin: GP-1 fixed — start(force:true) intentionally replaces an existing plan", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("start", {
    strategicChoice: "a completely different plan",
    horizon: "1y",
    force: true,
  }, ctx);
  const s = state(store);
  assertEquals(s.state, "drafted");
  assertEquals(s.commitments, []);
  assertEquals(s.assumptions, []);
  assertEquals(s.planVersion, 1);
});

// ============================================================================
// GP-2 (MEDIUM) — adapt() resets the fired tripwire it responded to
// ============================================================================

Deno.test("pin: GP-2 fixed — adapt() resets the triggering tripwire to 'dormant'; a stale re-trigger without a fresh evaluate() rejects", async () => {
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
    reason: "first fire",
  }, ctx);
  await run("adapt", {
    triggeredBy: "self_serve_conversion_pct",
    actionTaken: "paused acquisition",
    reason: "first adapt",
  }, ctx);
  // fixed: adapt() reset the tripwire it responded to back to "dormant".
  assertEquals(
    (state(store).tripwires as Array<Record<string, unknown>>)[0].state,
    "dormant",
  );
  await run("monitor", {}, ctx);
  // fixed: no fresh evaluate() happened since adapt() cleared it — rejects.
  await assertRejects(
    () =>
      run("trigger", {
        signpostName: "self_serve_conversion_pct",
        reason: "re-fired on stale reading",
      }, ctx),
    Error,
    "No fired tripwire",
  );
});

// ============================================================================
// GP-3 (MEDIUM) — commitmentSatisfiesSixProperties requires a strict ISO byDate
// ============================================================================

Deno.test("pin: GP-3 fixed — byDate '2026' is not a strict ISO date/date-time and IS flagged missing", async () => {
  const { context } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await assertRejects(
    () =>
      run("add_commitment", {
        kind: "commitment",
        description: "ship",
        owner: "alice",
        budgetUsd: 1,
        byDate: "2026",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
      }, context),
    Error,
    "byDate",
  );
});

Deno.test("pin: GP-3 — byDate 'next quarter' does not parse and IS flagged missing", async () => {
  const { context } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await assertRejects(
    () =>
      run("add_commitment", {
        kind: "commitment",
        description: "ship",
        owner: "alice",
        budgetUsd: 1,
        byDate: "next quarter",
        dependsOn: [],
        reviewCadence: "weekly",
        consequenceIfChanged: "delay",
      }, context),
    Error,
    "byDate",
  );
});

// ============================================================================
// GP-4 (LOW) — evaluate() rejects a mismatched-layer payload
// ============================================================================

Deno.test("pin: GP-4 fixed — timeToCruxWeeks on a signpost with no matching ceiling rejects, naming the field", async () => {
  const { ctx } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  // self_serve_conversion_pct is on an assumption + tripwire, NOT a ceiling.
  await assertRejects(
    () =>
      run("evaluate", {
        signpostName: "self_serve_conversion_pct",
        reading: "5.4",
        timeToCruxWeeks: 3,
      }, ctx),
    Error,
    "timeToCruxWeeks",
  );
});

Deno.test("pin: GP-4 fixed — timeToCruxWeeks on the signpost's real ceiling still applies", async () => {
  const { ctx, store } = await buildDraftedPlan();
  await run("commit", {}, ctx);
  await run("monitor", {}, ctx);
  await run("evaluate", {
    signpostName: "support_ticket_volume",
    reading: "1200/wk",
    timeToCruxWeeks: 7,
  }, ctx);
  const ceiling = (state(store).ceilings as Array<Record<string, unknown>>)[0];
  assertEquals(ceiling.lastTimeToCruxWeeks, 7);
});

// ============================================================================
// GP-5 (LOW) — commitGateReport / governabilityScore are broken-assumption-aware
// ============================================================================

Deno.test("pin: GP-5 fixed — a plan whose only assumption is 'broken' fails the commit gate and scores layer-1 absent", () => {
  const plan: PlanState = PlanStateSchema.parse({
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    assumptions: [{
      statement: "everything is fine",
      impact: "high",
      vulnerability: "high",
      signpostName: "s",
      state: "broken",
    }],
    commitments: [{
      kind: "commitment",
      description: "ship",
      owner: "alice",
      budgetUsd: 1,
      byDate: "2026-09-01",
      dependsOn: [],
      reviewCadence: "weekly",
      consequenceIfChanged: "delay",
    }],
    allocations: [{ priority: "p", protectedBudgetUsd: 1 }],
    ceilings: [{
      crux: "c",
      leadTimeWeeks: 1,
      safetyMarginWeeks: 0,
      signpostName: "s2",
    }],
    tripwires: [{
      signpostName: "s3",
      thresholdExpr: "< 1",
      preAuthorizedAction: "act",
    }],
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  // fixed: hasLiveAssumption() treats an all-broken plan as Layer-1 absent,
  // in lockstep across both commitGateReport and governabilityScore.
  const report = commitGateReport(plan);
  assertEquals(report.ok, false);
  assertEquals(report.gaps.some((g) => g.layer === "assumption"), true);
  assertEquals(governabilityScore(plan), 0.8);
});

Deno.test("pin: GP-5 fixed — a plan with one broken and one holding assumption still scores layer-1 present", () => {
  const plan: PlanState = PlanStateSchema.parse({
    state: "drafted",
    strategicChoice: "x",
    horizon: "1y",
    assumptions: [
      {
        statement: "broken one",
        impact: "high",
        vulnerability: "high",
        signpostName: "s",
        state: "broken",
      },
      {
        statement: "holding one",
        impact: "high",
        vulnerability: "high",
        signpostName: "s2",
      },
    ],
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  assertEquals(
    commitGateReport(plan).gaps.some((g) => g.layer === "assumption"),
    false,
  );
  assertEquals(governabilityScore(plan), 0.2);
});

// ============================================================================
// GP-6 (LOW) — tripwire.pullbackRung is bounds-checked against a non-empty ladder
// ============================================================================

Deno.test("pin: GP-6 fixed — pullbackRung far beyond a non-empty pullbackLadder.length is rejected", async () => {
  const { context } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("set_pullback_ladder", { rungs: ["only-rung"] }, context);
  await assertRejects(
    () =>
      run("add_tripwire", {
        signpostName: "s",
        thresholdExpr: "< 1",
        preAuthorizedAction: "act",
        pullbackRung: 99, // dangling index into a 1-rung ladder
      }, context),
    Error,
    "pullbackRung",
  );
});

Deno.test("pin: GP-6 fixed — pullbackRung is still accepted (deferred) before set_pullback_ladder is ever called, but a too-short ladder set afterward is rejected", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_tripwire", {
    signpostName: "s",
    thresholdExpr: "< 1",
    preAuthorizedAction: "act",
    pullbackRung: 5,
  }, context);
  const t = (state(store).tripwires as Array<Record<string, unknown>>)[0];
  assertEquals(t.pullbackRung, 5);
  assertEquals(state(store).pullbackLadder, []);
  // fixed: a ladder too short to cover the already-deferred rung is rejected.
  await assertRejects(
    () => run("set_pullback_ladder", { rungs: ["a", "b"] }, context),
    Error,
    "stranded",
  );
});

Deno.test("pin: GP-6 fixed — a pullback ladder long enough for an existing rung, plus a matching add_tripwire, both succeed", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("set_pullback_ladder", { rungs: ["a", "b", "c"] }, context);
  await run("add_tripwire", {
    signpostName: "s",
    thresholdExpr: "< 1",
    preAuthorizedAction: "act",
    pullbackRung: 2,
  }, context);
  const t = (state(store).tripwires as Array<Record<string, unknown>>)[0];
  assertEquals(t.pullbackRung, 2);
});

Deno.test("pin: GP-6 fixed — add_tripwire with no pullbackRung is always accepted regardless of ladder length", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("set_pullback_ladder", { rungs: ["a"] }, context);
  await run("add_tripwire", {
    signpostName: "s",
    thresholdExpr: "< 1",
    preAuthorizedAction: "act",
  }, context);
  const t = (state(store).tripwires as Array<Record<string, unknown>>)[0];
  assertEquals(t.pullbackRung, undefined);
});

// ============================================================================
// GP-7 (LOW) — add_* methods dedup identical calls (idempotent)
// ============================================================================

Deno.test("pin: GP-7 fixed — calling add_assumption twice with identical args is idempotent (length stays 1)", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  const args = {
    statement: "same statement",
    impact: "high" as const,
    vulnerability: "low" as const,
    signpostName: "s",
  };
  await run("add_assumption", args, context);
  await run("add_assumption", args, context);
  assertEquals((state(store).assumptions as unknown[]).length, 1);
});

Deno.test("pin: GP-7 fixed — add_assumption calls that differ in even one field are NOT deduped (length 2)", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  await run("add_assumption", {
    statement: "same statement",
    impact: "high",
    vulnerability: "low",
    signpostName: "s",
  }, context);
  await run("add_assumption", {
    statement: "same statement",
    impact: "high",
    vulnerability: "low",
    signpostName: "a-different-signpost",
  }, context);
  assertEquals((state(store).assumptions as unknown[]).length, 2);
});

Deno.test("pin: GP-7 fixed — add_commitment is idempotent for an identical call", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  const args = {
    kind: "commitment" as const,
    description: "ship",
    owner: "alice",
    budgetUsd: 1,
    byDate: "2026-09-01",
    dependsOn: [],
    reviewCadence: "weekly",
    consequenceIfChanged: "delay",
  };
  await run("add_commitment", args, context);
  await run("add_commitment", args, context);
  assertEquals((state(store).commitments as unknown[]).length, 1);
});

Deno.test("pin: GP-7 fixed — add_allocation is idempotent for an identical call", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  const args = { priority: "p", protectedBudgetUsd: 1 };
  await run("add_allocation", args, context);
  await run("add_allocation", args, context);
  assertEquals((state(store).allocations as unknown[]).length, 1);
});

Deno.test("pin: GP-7 fixed — add_ceiling is idempotent for an identical call", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  const args = {
    crux: "c",
    leadTimeWeeks: 1,
    safetyMarginWeeks: 0,
    signpostName: "s",
    optionPremiums: [],
  };
  await run("add_ceiling", args, context);
  await run("add_ceiling", args, context);
  assertEquals((state(store).ceilings as unknown[]).length, 1);
});

Deno.test("pin: GP-7 fixed — add_tripwire is idempotent for an identical call", async () => {
  const { context, store } = makeContext();
  await run("start", { strategicChoice: "x", horizon: "1y" }, context);
  const args = {
    signpostName: "s",
    thresholdExpr: "< 1",
    preAuthorizedAction: "act",
  };
  await run("add_tripwire", args, context);
  await run("add_tripwire", args, context);
  assertEquals((state(store).tripwires as unknown[]).length, 1);
});

// ============================================================================
// GP-8 (LOW) — numeric helpers guard against NaN/Infinity
// ============================================================================

Deno.test("hostile: the zod boundary rejects BOTH NaN and +Infinity for a plain z.number() field — GP-8 is only reachable by calling the exported pure helpers directly, bypassing this boundary", () => {
  // Correction vs. the approved plan's stated finding (which believed
  // `.nonnegative()` admits Infinity through zod): zod 4's plain `z.number()`
  // rejects non-finite values ("invalid_type", received "Infinity") before
  // `.nonnegative()` ever runs, so NEITHER value reaches the method body via
  // the CLI/method-arguments boundary. The pure helpers below have no such
  // gate at all — see the two direct-call pins that follow.
  assertThrows(
    () =>
      model.methods.add_ceiling.arguments.parse({
        crux: "c",
        leadTimeWeeks: NaN,
        safetyMarginWeeks: 0,
        signpostName: "s",
        optionPremiums: [],
      }),
    ZodError,
  );
  assertThrows(
    () =>
      model.methods.add_ceiling.arguments.parse({
        crux: "c",
        leadTimeWeeks: Infinity,
        safetyMarginWeeks: 0,
        signpostName: "s",
        optionPremiums: [],
      }),
    ZodError,
  );
});

Deno.test("pin: GP-8 fixed — computeTriggerPoint throws on non-finite inputs instead of propagating Infinity/NaN", () => {
  assertThrows(
    () =>
      computeTriggerPoint(
        { leadTimeWeeks: Infinity, safetyMarginWeeks: 0 },
        1,
      ),
    Error,
    "finite",
  );
  assertThrows(
    () =>
      computeTriggerPoint(
        { leadTimeWeeks: Infinity, safetyMarginWeeks: 0 },
        Infinity,
      ),
    Error,
    "finite",
  );
});

Deno.test("pin: GP-8 fixed — computeMaxTolerableLoss throws on a non-finite component instead of propagating Infinity", () => {
  assertThrows(
    () =>
      computeMaxTolerableLoss({
        ...emptyLossBudget,
        sunkCostUsd: Infinity,
      }),
    Error,
    "finite",
  );
});
