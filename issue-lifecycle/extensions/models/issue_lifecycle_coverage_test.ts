// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// COVERAGE suite (ext-quality-bf-issue-lifecycle, wave-4 batch-4d).
// issue_lifecycle.ts is BYTE-FROZEN by this change. Guard-throw regression
// tests for all 17 guardState call sites (triage, record_prior_art,
// record_reproduction, plan, review_plan, record_review, approve_plan,
// reject_plan, implement, review_tests, iterate_tests, tests_approved,
// review_code, resolve_findings, iterate, harvest, complete) already live
// in issue_lifecycle_methods_test.ts (one success + one guard-throw per
// method) — this file fills the BRANCH gaps the methods/adversarial suites
// don't reach: allMatrixReviewersRecorded across every reviewMatrix
// dimension, hasBlockingFindings' full status filter, both branches of
// iterate's double-snapshot guard, reject_plan/iterate/iterate_tests'
// zod `source` default, record_reproduction's create-vs-merge branches,
// plan's planVersion-bump predicate (keyed on `data.plan`, not on which of
// the two guarded states you're in), and complete's silently-discarded
// `summary` argument.
//
// Harness is a byte-identical copy of issue_lifecycle.test.ts's fake context.

import { assertEquals, assertExists } from "jsr:@std/assert@1";

import {
  allMatrixReviewersRecorded,
  type Finding,
  hasBlockingFindings,
  type IssueState,
  IssueStateSchema,
  model,
  type ReviewMatrix,
  type ReviewResult,
} from "./issue_lifecycle.ts";

// ============================================================================
// Test harness (byte-identical copy)
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
  getState(): IssueState | null;
}

function createHarness(initial?: StoredRecord): Harness {
  const store = new Map<string, StoredRecord>();
  if (initial) {
    store.set("state::current", initial);
  }

  const ctx: FakeCtx = {
    logger: { info: () => {} },
    definition: { name: "issue-test" },
    readResource: (name: string) => {
      const key = `state::${name}`;
      const v = store.get(key);
      return Promise.resolve(v ? structuredClone(v) : null);
    },
    // deno-lint-ignore require-await
    writeResource: async (spec, name, data) => {
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
      return { spec, name };
    },
  };

  return {
    ctx,
    getState(): IssueState | null {
      const raw = store.get("state::current");
      return raw ? IssueStateSchema.parse(raw) : null;
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

async function run(
  method: string,
  args: Record<string, unknown>,
  ctx: FakeCtx,
): Promise<void> {
  const m = (model.methods as MethodMap)[method];
  if (!m) throw new Error(`unknown method: ${method}`);
  await m.execute(args, ctx);
}

function defaultPlanArgs(overrides?: {
  matrix?: Partial<ReviewMatrix>;
}): Record<string, unknown> {
  return {
    summary: "Test plan",
    steps: ["Step one"],
    dddAnalysis: "Aggregate: issue state.",
    testStrategy: "RED/GREEN/REFACTOR.",
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
  return { reviewer, severity, description, status };
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
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);
}

async function implementWithTestsApproved(
  h: Harness,
  branch = "feat/x",
): Promise<void> {
  await run("implement", { branch }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
}

// ============================================================================
// allMatrixReviewersRecorded — branch fill across security/ux/skill
// ============================================================================

Deno.test("coverage: allMatrixReviewersRecorded — security-only matrix requires exactly review-security", () => {
  const matrix: ReviewMatrix = {
    code: false,
    adversarial: false,
    security: true,
    ux: false,
    skill: false,
  };
  const result = allMatrixReviewersRecorded([], matrix);
  assertEquals(result.complete, false);
  assertEquals(result.missing, ["review-security"]);
});

Deno.test("coverage: allMatrixReviewersRecorded — ux-only matrix requires exactly review-ux", () => {
  const matrix: ReviewMatrix = {
    code: false,
    adversarial: false,
    security: false,
    ux: true,
    skill: false,
  };
  const result = allMatrixReviewersRecorded([], matrix);
  assertEquals(result.complete, false);
  assertEquals(result.missing, ["review-ux"]);
});

Deno.test("coverage: allMatrixReviewersRecorded — skill-only matrix requires exactly review-skill", () => {
  const matrix: ReviewMatrix = {
    code: false,
    adversarial: false,
    security: false,
    ux: false,
    skill: true,
  };
  const result = allMatrixReviewersRecorded([], matrix);
  assertEquals(result.complete, false);
  assertEquals(result.missing, ["review-skill"]);
});

Deno.test("coverage: allMatrixReviewersRecorded — all five reviewers enabled and all five recorded is complete", () => {
  const matrix: ReviewMatrix = {
    code: true,
    adversarial: true,
    security: true,
    ux: true,
    skill: true,
  };
  const timestamp = "2026-07-31T00:00:00.000Z";
  const reviews: ReviewResult[] = [
    "code",
    "adversarial",
    "security",
    "ux",
    "skill",
  ].map((name) => ({
    reviewer: `review-${name}`,
    verdict: "PASS",
    findings: [],
    timestamp,
  }));
  const result = allMatrixReviewersRecorded(reviews, matrix);
  assertEquals(result.complete, true);
  assertEquals(result.missing, []);
});

Deno.test("coverage: allMatrixReviewersRecorded — an all-false matrix is trivially complete", () => {
  const matrix: ReviewMatrix = {
    code: false,
    adversarial: false,
    security: false,
    ux: false,
    skill: false,
  };
  const result = allMatrixReviewersRecorded([], matrix);
  assertEquals(result.complete, true);
  assertEquals(result.missing, []);
});

// ============================================================================
// hasBlockingFindings — full status filter (open/resolved/accepted/wontfix)
// ============================================================================

Deno.test("coverage: hasBlockingFindings ignores 'accepted' findings", () => {
  const reviews: ReviewResult[] = [{
    reviewer: "review-code",
    verdict: "FAIL",
    timestamp: "2026-07-31T00:00:00.000Z",
    findings: [finding("review-code", "CRITICAL", "a", "accepted")],
  }];
  assertEquals(hasBlockingFindings(reviews).total, 0);
});

Deno.test("coverage: hasBlockingFindings ignores 'wontfix' findings", () => {
  const reviews: ReviewResult[] = [{
    reviewer: "review-code",
    verdict: "FAIL",
    timestamp: "2026-07-31T00:00:00.000Z",
    findings: [finding("review-code", "HIGH", "b", "wontfix")],
  }];
  assertEquals(hasBlockingFindings(reviews).total, 0);
});

Deno.test("coverage: hasBlockingFindings counts only the still-'open' findings in a mixed-status set", () => {
  const reviews: ReviewResult[] = [{
    reviewer: "review-code",
    verdict: "FAIL",
    timestamp: "2026-07-31T00:00:00.000Z",
    findings: [
      finding("review-code", "CRITICAL", "open-one", "open"),
      finding("review-code", "CRITICAL", "resolved-one", "resolved"),
      finding("review-code", "HIGH", "accepted-one", "accepted"),
      finding("review-code", "HIGH", "wontfix-one", "wontfix"),
      finding("review-code", "HIGH", "open-two", "open"),
    ],
  }];
  assertEquals(hasBlockingFindings(reviews), {
    critical: 1,
    high: 1,
    total: 2,
  });
});

// ============================================================================
// iterate — both branches of the double-snapshot guard
// ============================================================================

Deno.test("coverage: iterate from code_reviewing appends exactly one new reviewHistory entry", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await implementWithTestsApproved(h);
  await run("review_code", {}, h.ctx);
  const before = h.getState()!.reviewHistory.length;
  await run(
    "record_review",
    failReview("review-code", [finding("review-code", "HIGH", "x")]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("iterate", { reason: "fix", source: "auto" }, h.ctx);
  const after = h.getState()!.reviewHistory.length;
  assertEquals(after, before + 1, "code_reviewing branch snapshots once");
});

Deno.test("coverage: iterate from resolved appends zero new reviewHistory entries (already snapshotted by resolve_findings)", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await implementWithTestsApproved(h);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  const before = h.getState()!.reviewHistory.length;
  await run("iterate", { reason: "revisit", source: "human" }, h.ctx);
  const after = h.getState()!.reviewHistory.length;
  assertEquals(after, before, "resolved branch must not double-snapshot");
});

// ============================================================================
// reject_plan / iterate / iterate_tests — zod `source` default is "human"
// ============================================================================

Deno.test("coverage: reject_plan/iterate/iterate_tests arguments schema defaults source to 'human'", () => {
  const rp = model.methods.reject_plan.arguments.parse({ reason: "x" }) as {
    source: string;
  };
  const it = model.methods.iterate.arguments.parse({ reason: "x" }) as {
    source: string;
  };
  const itt = model.methods.iterate_tests.arguments.parse({ reason: "x" }) as {
    source: string;
  };
  assertEquals(rp.source, "human");
  assertEquals(it.source, "human");
  assertEquals(itt.source, "human");
});

// ============================================================================
// record_reproduction — create vs merge branches
// ============================================================================

Deno.test("coverage: record_reproduction CREATE branch — no prior triageDetail at all", async () => {
  const h = createHarness();
  await filedAndTriaged(h); // detail-less triage → triageDetail undefined
  assertEquals(h.getState()!.triageDetail, undefined);
  await run(
    "record_reproduction",
    { status: "not-applicable", notes: "n/a for this refactor" },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.triageDetail!.reproduced!.status, "not-applicable");
  assertEquals(s.triageDetail!.clarifyingQuestions, []);
  assertEquals(s.triageDetail!.confidence, undefined);
});

Deno.test("coverage: record_reproduction MERGE branch — preserves confidence/reasoning/isRegression/clarifyingQuestions from the original triage", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await run(
    "triage",
    {
      priority: "high",
      category: "bug",
      affectedAreas: ["core"],
      confidence: "medium",
      reasoning: "partial repro only",
      isRegression: true,
      clarifyingQuestions: ["does this happen on v1.2?"],
    },
    h.ctx,
  );
  await run(
    "record_reproduction",
    { status: "reproduced", notes: "confirmed on v1.3" },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.triageDetail!.confidence, "medium");
  assertEquals(s.triageDetail!.reasoning, "partial repro only");
  assertEquals(s.triageDetail!.isRegression, true);
  assertEquals(s.triageDetail!.clarifyingQuestions, [
    "does this happen on v1.2?",
  ]);
  assertEquals(s.triageDetail!.reproduced!.status, "reproduced");
  assertEquals(s.triageDetail!.reproduced!.notes, "confirmed on v1.3");
});

// ============================================================================
// plan — planVersion-bump predicate is keyed on `data.plan`, not on which of
// the two guarded states (triaged | planned) the call came from
// ============================================================================

Deno.test("coverage: plan bumps planVersion a second time when re-entered from planned (v2 -> v3)", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(h.getState()!.planVersion, 2);
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(
    h.getState()!.planVersion,
    3,
    "the bump is not hardcoded to a single 1->2 transition",
  );
});

Deno.test("coverage: plan's version-bump branch keys on `data.plan` presence, not the guarded state itself", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  const withPlan = h.getState()!;
  assertEquals(withPlan.planVersion, 1);

  // Corrupt the store back to `triaged` while leaving `plan` populated —
  // both `triaged` and `planned` are guard-legal source states for `plan`,
  // but the version-bump ternary reads `data.plan`, not `data.state`.
  await h.ctx.writeResource("state", "current", {
    ...withPlan,
    state: "triaged",
  });
  await run("plan", defaultPlanArgs(), h.ctx);
  assertEquals(
    h.getState()!.planVersion,
    2,
    "re-planning from a corrupted 'triaged'-with-existing-plan state still bumps, because the branch predicate is `data.plan`",
  );
});

// ============================================================================
// complete — the `summary` argument is accepted by the schema but never
// persisted anywhere on the state object
// ============================================================================

Deno.test("coverage: complete's summary argument is validated but silently discarded (not stored on state)", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);
  await implementWithTestsApproved(h);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);

  await run(
    "complete",
    { summary: "this text is provided but the model has nowhere to put it" },
    h.ctx,
  );

  const s = h.getState()!;
  assertEquals(s.state, "complete");
  assertExists(s.completedAt);
  // Confirms the only side effects of `complete` are `state` and
  // `completedAt` — the schema round-trip on `IssueStateSchema` would fail
  // this test if a `summary` field somehow leaked onto the aggregate root.
  assertEquals(
    (s as unknown as Record<string, unknown>).summary,
    undefined,
  );
});
