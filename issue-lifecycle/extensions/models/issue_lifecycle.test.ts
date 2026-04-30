// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import {
  allMatrixReviewersRecorded,
  type Finding,
  findingSignature,
  hasBlockingFindings,
  type IssueState,
  IssueStateSchema,
  model,
  PlanStepSchema,
  type ReviewMatrix,
  type ReviewResult,
  StateEnum,
} from "./issue_lifecycle.ts";

// ============================================================================
// Test harness — fake context with strict schema validation on writes
// ============================================================================

type StoredRecord = Record<string, unknown>;

interface FakeCtx {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  definition: { name: string };
  readResource: (name: string) => Promise<StoredRecord | null>;
  writeResource: (
    spec: string,
    name: string,
    data: StoredRecord,
  ) => Promise<{ spec: string; name: string }>;
}

interface Harness {
  ctx: FakeCtx;
  writes: Array<{ spec: string; name: string; data: StoredRecord }>;
  getState(): IssueState | null;
  getSummary(): StoredRecord | null;
}

function createHarness(initial?: StoredRecord): Harness {
  const store = new Map<string, StoredRecord>();
  if (initial) {
    store.set("state::current", initial);
  }
  const writes: Array<{ spec: string; name: string; data: StoredRecord }> = [];

  const ctx: FakeCtx = {
    logger: { info: () => {} },
    definition: { name: "issue-test" },
    readResource: (name: string) => {
      const key = `state::${name}`;
      const v = store.get(key);
      return Promise.resolve(v ? structuredClone(v) : null);
    },
    // Async so synchronous throws from schema validation become Promise
    // rejections (which assertRejects expects).
    // deno-lint-ignore require-await
    writeResource: async (spec, name, data) => {
      // Strict validation: any write to the `state` spec must parse as
      // IssueStateSchema. Any write to the `summary` spec must carry a
      // `state` field (the compact summary produced by hydrate).
      if (spec === "state") {
        IssueStateSchema.parse(data);
      } else if (spec === "summary") {
        if (typeof (data as { state?: unknown }).state !== "string") {
          throw new Error(
            "summary write must include a `state` field (compact summary)",
          );
        }
      } else {
        throw new Error(`Unknown resource spec: ${spec}`);
      }
      store.set(`${spec}::${name}`, structuredClone(data));
      writes.push({ spec, name, data: structuredClone(data) });
      return { spec, name };
    },
  };

  return {
    ctx,
    writes,
    getState(): IssueState | null {
      const raw = store.get("state::current");
      return raw ? IssueStateSchema.parse(raw) : null;
    },
    getSummary(): StoredRecord | null {
      return store.get("summary::hydrate") ?? null;
    },
  };
}

// Shorthand: run a model method by name
// deno-lint-ignore no-explicit-any
async function run(method: string, args: any, ctx: FakeCtx): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const m = (model.methods as any)[method];
  if (!m) throw new Error(`unknown method: ${method}`);
  await m.execute(args, ctx);
}

// Build a minimal passing plan for tests that need a plan in place
function defaultPlanArgs(overrides?: {
  matrix?: Partial<ReviewMatrix>;
}): Record<string, unknown> {
  return {
    summary: "Test plan",
    steps: ["Step one", "Step two"],
    dddAnalysis: "Aggregate: issue state. Value object: FindingSchema.",
    testStrategy: "RED: write failing test. GREEN: implement. REFACTOR.",
    reviewMatrix: {
      code: true,
      adversarial: true,
      security: false,
      ux: false,
      skill: false,
      ...(overrides?.matrix ?? {}),
    },
    potentialChallenges: [],
  };
}

function finding(
  reviewer: string,
  severity: Finding["severity"],
  description: string,
  status: Finding["status"] = "open",
): Finding {
  return {
    reviewer,
    severity,
    description,
    status,
  };
}

function passReview(reviewer: string): Record<string, unknown> {
  return { reviewer, verdict: "PASS", findings: [] };
}

function failReview(
  reviewer: string,
  findings: Finding[],
): Record<string, unknown> {
  return { reviewer, verdict: "FAIL", findings };
}

// Drive start + triage so most tests don't repeat the boilerplate
async function filedAndTriaged(h: Harness): Promise<void> {
  await run(
    "start",
    { title: "Test issue", description: "details", labels: [] },
    h.ctx,
  );
  await run(
    "triage",
    {
      priority: "medium",
      category: "bug",
      affectedAreas: ["extensions"],
      clarifyingQuestions: [],
    },
    h.ctx,
  );
}

async function withApprovedPlan(h: Harness): Promise<void> {
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run(
    "record_review",
    passReview("review-code"),
    h.ctx,
  );
  await run(
    "record_review",
    passReview("review-adversarial"),
    h.ctx,
  );
  await run("approve_plan", {}, h.ctx);
}

// ============================================================================
// Schema round-trips
// ============================================================================

Deno.test("IssueStateSchema parses a legacy blob via defaults", () => {
  const legacy = {
    state: "filed",
    title: "Legacy",
    description: "no new fields at all",
    createdAt: "2026-04-05T12:00:00.000Z",
    updatedAt: "2026-04-05T12:00:00.000Z",
  };
  const parsed = IssueStateSchema.parse(legacy);
  assertEquals(parsed.reviewHistory, []);
  assertEquals(parsed.planVersion, 1);
  assertEquals(parsed.codeReviewIteration, 1);
  assertEquals(parsed.reviews, []);
  assertEquals(parsed.labels, []);
  assertEquals(parsed.affectedAreas, []);
  assertEquals(parsed.triageDetail, undefined);
  assertEquals(parsed.priorArt, undefined);
  assertEquals(parsed.harvest, undefined);
});

Deno.test("PlanStepSchema accepts bare string", () => {
  const parsed = PlanStepSchema.parse("Step one");
  assertEquals(parsed, "Step one");
});

Deno.test("PlanStepSchema accepts rich step object", () => {
  const rich = {
    order: 1,
    description: "Write failing test",
    files: ["src/foo.ts"],
    risks: "Might touch bundler path",
  };
  const parsed = PlanStepSchema.parse(rich);
  assertEquals(parsed, rich);
});

Deno.test("StateEnum includes harvested", () => {
  const values = StateEnum.options;
  assertEquals(values.includes("harvested"), true);
  assertEquals(values.includes("code_reviewing"), true);
});

// ============================================================================
// start
// ============================================================================

Deno.test("start creates filed state", async () => {
  const h = createHarness();
  await run(
    "start",
    { title: "Bug", description: "broken", labels: ["bug"] },
    h.ctx,
  );
  const s = h.getState();
  assertExists(s);
  assertEquals(s!.state, "filed");
  assertEquals(s!.title, "Bug");
  assertEquals(s!.labels, ["bug"]);
  assertEquals(s!.reviewHistory, []);
  assertEquals(s!.planVersion, 1);
  assertEquals(s!.codeReviewIteration, 1);
});

// ============================================================================
// triage
// ============================================================================

Deno.test("triage with optional triageDetail round-trips", async () => {
  const h = createHarness();
  await run(
    "start",
    { title: "T", description: "d", labels: [] },
    h.ctx,
  );
  await run(
    "triage",
    {
      priority: "high",
      category: "bug",
      affectedAreas: ["core"],
      confidence: "high",
      reasoning: "Clear reproduction steps",
      isRegression: true,
      clarifyingQuestions: [],
      reproduced: { status: "reproduced" },
    },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "triaged");
  assertEquals(s.triageDetail?.confidence, "high");
  assertEquals(s.triageDetail?.isRegression, true);
  assertEquals(s.triageDetail?.reproduced?.status, "reproduced");
});

Deno.test("triage without detail leaves triageDetail undefined", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  const s = h.getState()!;
  assertEquals(s.state, "triaged");
  assertEquals(s.triageDetail, undefined);
});

// ============================================================================
// record_prior_art
// ============================================================================

Deno.test("record_prior_art allowed from triaged", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run(
    "record_prior_art",
    {
      uatScenarios: [
        { path: "uat/case-a.yaml", summary: "existing case A", reusable: true },
      ],
      kbEntries: [],
    },
    h.ctx,
  );
  const s = h.getState()!;
  assertExists(s.priorArt);
  assertEquals(s.priorArt!.uatScenarios.length, 1);
});

Deno.test("record_prior_art rejected from filed", async () => {
  const h = createHarness();
  await run(
    "start",
    { title: "X", description: "y", labels: [] },
    h.ctx,
  );
  await assertRejects(
    () =>
      run(
        "record_prior_art",
        { uatScenarios: [], kbEntries: [] },
        h.ctx,
      ),
    Error,
    "Cannot call 'record_prior_art' in state 'filed'",
  );
});

// ============================================================================
// plan
// ============================================================================

Deno.test("plan bumps planVersion when re-entered from planned", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(h.getState()!.planVersion, 1);
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(h.getState()!.planVersion, 2);
});

Deno.test("plan resets reviews but preserves reviewHistory", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "missing rollback"),
    ]),
    h.ctx,
  );
  await run(
    "reject_plan",
    { reason: "revise rollback", source: "auto" },
    h.ctx,
  );
  const before = h.getState()!;
  assertEquals(before.reviewHistory.length, 1);
  assertEquals(before.reviews.length, 0);

  await run("plan", defaultPlanArgs(), h.ctx);
  const after = h.getState()!;
  assertEquals(after.reviews.length, 0);
  assertEquals(after.reviewHistory.length, 1);
  assertEquals(after.planVersion, 2);
});

Deno.test("plan accepts rich PlanStepSchema objects", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run(
    "plan",
    {
      ...defaultPlanArgs(),
      steps: [
        { order: 1, description: "Write test", files: ["a.ts"], risks: "n/a" },
        { order: 2, description: "Implement", files: ["b.ts"] },
      ],
    },
    h.ctx,
  );
  const p = h.getState()!.plan!;
  assertEquals(p.steps.length, 2);
});

// ============================================================================
// review_plan
// ============================================================================

Deno.test("review_plan sets reviewRoundStartedAt", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  const s = h.getState()!;
  assertEquals(s.state, "reviewing");
  assertExists(s.reviewRoundStartedAt);
});

// ============================================================================
// approve_plan gate
// ============================================================================

Deno.test("approve_plan blocks on missing matrix coverage", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  // review-adversarial is in the matrix but not recorded
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "review-adversarial",
  );
});

Deno.test("approve_plan blocks on open CRITICAL", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "CRITICAL", "null deref in hot path"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "CRITICAL",
  );
});

Deno.test("approve_plan blocks on open HIGH", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "race condition on retry"),
    ]),
    h.ctx,
  );
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "HIGH",
  );
});

Deno.test("approve_plan succeeds with full coverage and zero blocking", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);
  const s = h.getState()!;
  assertEquals(s.state, "approved");
  assertEquals(s.reviewHistory.length, 1);
  assertEquals(s.reviewHistory[0].phase, "plan_review");
  assertEquals(s.reviewHistory[0].outcome, "clean");
  assertEquals(s.reviewHistory[0].iteration, 1);
});

// ============================================================================
// reject_plan
// ============================================================================

Deno.test("reject_plan source=auto snapshots rejected_auto", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "missing rollback"),
    ]),
    h.ctx,
  );
  await run(
    "reject_plan",
    { reason: "Fix rollback", source: "auto" },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "planned");
  assertEquals(s.reviewHistory.length, 1);
  assertEquals(s.reviewHistory[0].outcome, "rejected_auto");
  assertEquals(s.reviewHistory[0].rejectReason, "Fix rollback");
});

Deno.test("reject_plan source=human snapshots rejected_human", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run(
    "reject_plan",
    { reason: "human wants different approach", source: "human" },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "planned");
  assertEquals(s.reviewHistory[0].outcome, "rejected_human");
});

// ============================================================================
// review_code / iterate loop
// ============================================================================

Deno.test("iterate from code_reviewing bumps iteration and snapshots", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_code", {}, h.ctx);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "CRITICAL", "missing test"),
    ]),
    h.ctx,
  );
  await run(
    "record_review",
    passReview("review-adversarial"),
    h.ctx,
  );
  await run(
    "iterate",
    { reason: "Add missing test", source: "auto" },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "implementing");
  assertEquals(s.codeReviewIteration, 2);
  // One plan_review (clean, from approve_plan) + one code_review (rejected_auto)
  assertEquals(s.reviewHistory.length, 2);
  const codeRound = s.reviewHistory.find((r) => r.phase === "code_review")!;
  assertEquals(codeRound.outcome, "rejected_auto");
  assertEquals(codeRound.iteration, 1);
});

Deno.test("iterate from resolved does not double-snapshot", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  const beforeLen = h.getState()!.reviewHistory.length;
  await run(
    "iterate",
    { reason: "revisit", source: "human" },
    h.ctx,
  );
  const afterLen = h.getState()!.reviewHistory.length;
  assertEquals(afterLen, beforeLen, "no extra snapshot from resolved branch");
  assertEquals(h.getState()!.codeReviewIteration, 2);
});

// ============================================================================
// harvest + complete
// ============================================================================

Deno.test("harvest transitions resolved → harvested", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  await run(
    "harvest",
    {
      uatProposals: [
        { scenario: "edge case X", rationale: "surfaced during review" },
      ],
      kbProposals: [],
    },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "harvested");
  assertEquals(s.harvest?.uatProposals.length, 1);
});

Deno.test("complete works from resolved (harvest skipped)", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  await run("complete", { summary: "" }, h.ctx);
  assertEquals(h.getState()!.state, "complete");
});

Deno.test("complete works from harvested", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  await run(
    "harvest",
    { uatProposals: [], kbProposals: [] },
    h.ctx,
  );
  await run("complete", { summary: "" }, h.ctx);
  assertEquals(h.getState()!.state, "complete");
});

// ============================================================================
// close
// ============================================================================

Deno.test("close accepts every state", async () => {
  for (const targetState of StateEnum.options) {
    if (targetState === "closed") continue; // already closed — skip
    const h = createHarness({
      state: targetState,
      title: "t",
      description: "d",
      labels: [],
      affectedAreas: [],
      reviews: [],
      reviewHistory: [],
      planVersion: 1,
      codeReviewIteration: 1,
      resolutions: {},
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    });
    await run("close", { reason: "abandoned" }, h.ctx);
    const s = h.getState()!;
    assertEquals(
      s.state,
      "closed",
      `close should work from '${targetState}'`,
    );
    assertEquals(s.closedReason, "abandoned");
  }
});

// ============================================================================
// hydrate
// ============================================================================

Deno.test("hydrate writes summary without mutating current", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  const currentBefore = JSON.stringify(h.getState());

  await run("hydrate", {}, h.ctx);

  const currentAfter = JSON.stringify(h.getState());
  assertEquals(
    currentAfter,
    currentBefore,
    "hydrate must not mutate the current state instance",
  );

  const summary = h.getSummary();
  assertExists(summary, "hydrate must write a summary resource");
  assertEquals((summary as { state: string }).state, "approved");
  assertExists((summary as { signature: string }).signature);
  assertExists(
    (summary as { coverage: { complete: boolean } }).coverage,
  );
});

// ============================================================================
// Pure helper tests
// ============================================================================

Deno.test("hasBlockingFindings returns per-severity counts", () => {
  const reviews: ReviewResult[] = [
    {
      reviewer: "review-code",
      verdict: "FAIL",
      timestamp: "2026-04-09T00:00:00.000Z",
      findings: [
        finding("review-code", "CRITICAL", "a"),
        finding("review-code", "HIGH", "b"),
        finding("review-code", "MEDIUM", "c"),
        finding("review-code", "LOW", "d"),
      ],
    },
  ];
  const result = hasBlockingFindings(reviews);
  assertEquals(result, { critical: 1, high: 1, total: 2 });
});

Deno.test("hasBlockingFindings ignores resolved findings", () => {
  const reviews: ReviewResult[] = [
    {
      reviewer: "review-code",
      verdict: "FAIL",
      timestamp: "2026-04-09T00:00:00.000Z",
      findings: [finding("review-code", "CRITICAL", "a", "resolved")],
    },
  ];
  assertEquals(hasBlockingFindings(reviews).total, 0);
});

Deno.test("allMatrixReviewersRecorded returns the exact missing set", () => {
  const matrix: ReviewMatrix = {
    code: true,
    adversarial: true,
    security: true,
    ux: false,
    skill: false,
  };
  const reviews: ReviewResult[] = [
    {
      reviewer: "review-code",
      verdict: "PASS",
      findings: [],
      timestamp: "2026-04-09T00:00:00.000Z",
    },
  ];
  const result = allMatrixReviewersRecorded(reviews, matrix);
  assertEquals(result.complete, false);
  assertEquals(
    result.missing.sort(),
    ["review-adversarial", "review-security"],
  );
});

Deno.test("findingSignature is stable under reordering", () => {
  const mk = (desc: string): ReviewResult => ({
    reviewer: "review-code",
    verdict: "FAIL",
    timestamp: "2026-04-09T00:00:00.000Z",
    findings: [finding("review-code", "CRITICAL", desc)],
  });
  const a = findingSignature([mk("alpha"), mk("beta")]);
  const b = findingSignature([mk("beta"), mk("alpha")]);
  assertEquals(a, b);
});

Deno.test("findingSignature ignores MEDIUM and LOW", () => {
  const sig = findingSignature([
    {
      reviewer: "r",
      verdict: "FAIL",
      timestamp: "2026-04-09T00:00:00.000Z",
      findings: [
        finding("r", "MEDIUM", "noise"),
        finding("r", "LOW", "noise"),
      ],
    },
  ]);
  assertEquals(sig, "");
});

// ============================================================================
// End-to-end scenario
// ============================================================================

Deno.test("end-to-end: filed → auto-reject → re-plan → approve → review_code → resolve → harvest → complete", async () => {
  const h = createHarness();

  // Phase 1–2: file, triage, prior art
  await run(
    "start",
    {
      title: "Fix broken retry",
      description: "API retries silently fail",
      labels: [],
    },
    h.ctx,
  );
  await run(
    "triage",
    {
      priority: "high",
      category: "bug",
      affectedAreas: ["extensions"],
      confidence: "high",
      reasoning: "Stack trace is deterministic",
      clarifyingQuestions: [],
    },
    h.ctx,
  );
  await run(
    "record_prior_art",
    { uatScenarios: [], kbEntries: [] },
    h.ctx,
  );

  // Plan v1
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(h.getState()!.planVersion, 1);

  // Plan v1 review → HIGH → auto reject
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "missing rollback"),
    ]),
    h.ctx,
  );
  await run(
    "reject_plan",
    { reason: "Fix rollback in plan v2", source: "auto" },
    h.ctx,
  );

  // Plan v2 → clean approve
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(h.getState()!.planVersion, 2);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);

  // Implement + code review (clean)
  await run("implement", { branch: "feat/retry-fix" }, h.ctx);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);

  // Harvest → complete
  await run(
    "harvest",
    {
      uatProposals: [],
      kbProposals: [
        {
          kind: "pattern",
          title: "retry backoff",
          body: "Use exponential backoff with jitter",
        },
      ],
    },
    h.ctx,
  );
  await run("complete", { summary: "" }, h.ctx);

  const s = h.getState()!;
  assertEquals(s.state, "complete");
  assertEquals(s.plan!.planVersion, 2);
  assertEquals(s.planVersion, 2);
  assertEquals(s.reviewHistory.length, 3);

  // One rejected_auto plan round + one clean plan round + one clean code round
  const planRounds = s.reviewHistory.filter((r) => r.phase === "plan_review");
  const codeRounds = s.reviewHistory.filter((r) => r.phase === "code_review");
  assertEquals(planRounds.length, 2);
  assertEquals(codeRounds.length, 1);
  assertEquals(planRounds[0].outcome, "rejected_auto");
  assertEquals(planRounds[0].planVersion, 1);
  assertEquals(planRounds[1].outcome, "clean");
  assertEquals(planRounds[1].planVersion, 2);
  assertEquals(codeRounds[0].outcome, "clean");
  assertExists(s.harvest);
  assertEquals(s.harvest!.kbProposals.length, 1);
});

// ============================================================================
// Guard: a write to the `state` spec that doesn't match the schema must fail
// in the fake — this is the invariant that surfaces the hydrate bug in ora.
// ============================================================================

Deno.test("fake harness rejects invalid writes to the state spec", async () => {
  const h = createHarness();
  await assertRejects(
    () =>
      h.ctx.writeResource("state", "current", {
        state: "not-a-real-state",
        title: "t",
        description: "d",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
      } as StoredRecord),
  );
});

// assertNotEquals is imported for future use in hydrate assertions.
// Silence unused-import lint if any future refactor drops its usage.
const _kept = assertNotEquals;
const _kept2 = assertStringIncludes;
