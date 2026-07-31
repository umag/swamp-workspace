// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// ADVERSARIAL suite (ext-quality-bf-issue-lifecycle, wave-4 batch-4d).
// issue_lifecycle.ts is BYTE-FROZEN by this change. This suite assumes the
// source is broken until proven otherwise: illegal transitions from varied
// source states, malformed reviewer input (bad severity/verdict enums),
// hostile approve_plan / tests_approved gate combinations, corrupted stored
// state, and pins for the LOCAL latent bugs IL-1 (start overwrites an
// in-flight issue), IL-2 (approve gate ignores verdict — a FAIL verdict with
// zero open findings still approves), IL-3 (no model-enforced iteration
// cap), IL-4 (resolutions keyed by description text collide across
// reviewers), and IL-5 (close is guardless and terminal-agnostic). See the
// LOCAL issue-lifecycle-latent-bugs issue-lifecycle model for the full
// triage — never the swamp.club Lab.
//
// Harness is a byte-identical copy of issue_lifecycle.test.ts's fake context.

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  type Finding,
  type IssueState,
  IssueStateSchema,
  model,
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

function defaultPlanArgs(): Record<string, unknown> {
  return {
    summary: "Test plan",
    steps: ["Step one", "Step two"],
    dddAnalysis: "Aggregate: issue state.",
    testStrategy: "RED/GREEN/REFACTOR.",
    reviewMatrix: {
      code: true,
      adversarial: true,
      security: false,
      ux: false,
      skill: false,
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

async function withReviewingPlan(h: Harness): Promise<void> {
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  await run("review_plan", {}, h.ctx);
}

async function withApprovedPlan(h: Harness): Promise<void> {
  await withReviewingPlan(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);
}

// ============================================================================
// IL-1 — start overwrites an in-flight issue (no guard, no read-before-write)
// ============================================================================

Deno.test("IL-1: start overwrites an in-flight approved plan, wiping history", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  const before = h.getState()!;
  assertEquals(before.state, "approved");
  assertEquals(before.reviewHistory.length, 1);
  assertEquals(before.title, "Test issue");

  // Re-invoking start with no guard silently clobbers everything.
  await run(
    "start",
    { title: "Different issue entirely", description: "d2", labels: [] },
    h.ctx,
  );

  const after = h.getState()!;
  assertEquals(after.state, "filed");
  assertEquals(after.title, "Different issue entirely");
  assertEquals(
    after.reviewHistory,
    [],
    "IL-1: start wipes reviewHistory with no confirmation",
  );
  assertEquals(after.plan, undefined, "IL-1: start wipes the plan");
  assertEquals(after.planVersion, 1, "IL-1: start resets planVersion to 1");
});

// ============================================================================
// IL-2 — approve gate ignores `verdict`; FAIL verdict with 0 open findings
// still approves
// ============================================================================

Deno.test("IL-2: approve_plan succeeds even when a reviewer's verdict is FAIL, as long as findings are empty/resolved", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  // review-code posts verdict=FAIL but with an empty findings array —
  // hasBlockingFindings only counts open CRITICAL/HIGH findings, never
  // inspects `verdict`.
  await run("record_review", failReview("review-code", []), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await run("approve_plan", {}, h.ctx);

  const s = h.getState()!;
  assertEquals(s.state, "approved");
  assertEquals(
    s.reviewHistory[0].reviews.find((r) => r.reviewer === "review-code")
      ?.verdict,
    "FAIL",
    "IL-2: a FAIL-verdict review is preserved verbatim in history yet did " +
      "not block approval",
  );
});

Deno.test("IL-2: approve_plan succeeds when a reviewer's verdict is FAIL but the finding is already resolved", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "CRITICAL", "pre-resolved issue", "resolved"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await run("approve_plan", {}, h.ctx);
  assertEquals(h.getState()!.state, "approved");
});

// ============================================================================
// IL-3 — no model-enforced iteration cap (LOW, by design; skill-enforced)
// ============================================================================

Deno.test("IL-3: iterate has no model-enforced cap — 10 consecutive rounds all succeed", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  await run("review_code", {}, h.ctx);

  for (let i = 0; i < 10; i++) {
    await run(
      "record_review",
      failReview("review-code", [
        finding("review-code", "HIGH", `round ${i}`),
      ]),
      h.ctx,
    );
    await run("record_review", passReview("review-adversarial"), h.ctx);
    await run("iterate", { reason: `round ${i}`, source: "auto" }, h.ctx);
    await run("review_code", {}, h.ctx);
  }

  const s = h.getState()!;
  assertEquals(s.state, "code_reviewing");
  assertEquals(
    s.codeReviewIteration,
    11,
    "IL-3: the model bumps the counter without ever refusing on cap — MAX_CODE_ITERATIONS is a skill-layer safeguard only",
  );
});

// ============================================================================
// IL-4 — resolutions keyed by description text collide across reviewers
// ============================================================================

Deno.test("IL-4: resolve_findings collapses two different findings that share description text into one resolution entry", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  await run("review_code", {}, h.ctx);

  // Two DIFFERENT reviewers, two DIFFERENT findings, but the exact same
  // description string ("needs error handling") — resolutions is a flat
  // Record<string,string> keyed by that string, so both collapse to one key.
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "MEDIUM", "needs error handling"),
    ]),
    h.ctx,
  );
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "MEDIUM", "needs error handling"),
    ]),
    h.ctx,
  );

  await run(
    "resolve_findings",
    { resolutions: { "needs error handling": "fixed in both call sites" } },
    h.ctx,
  );

  const s = h.getState()!;
  assertEquals(s.state, "resolved");
  assertEquals(
    Object.keys(s.resolutions).length,
    1,
    "IL-4: one resolutions map key represents two distinct findings from two different reviewers",
  );
});

// ============================================================================
// IL-5 — close is guardless and terminal-agnostic
// ============================================================================

Deno.test("IL-5: close works from complete (a terminal state) with no guard", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  const s = h.getState()!;
  // Manually place the harness in `complete` to exercise close's total
  // absence of a guardState call against a terminal state.
  await h.ctx.writeResource("state", "current", {
    ...s,
    state: "complete",
    completedAt: "2026-07-31T00:00:00.000Z",
  });
  await run("close", { reason: "reopened by mistake, closing again" }, h.ctx);
  assertEquals(h.getState()!.state, "closed");
});

Deno.test("IL-5: close works from closed (idempotent no-op re-close)", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("close", { reason: "first close" }, h.ctx);
  await run("close", { reason: "second close" }, h.ctx);
  const s = h.getState()!;
  assertEquals(s.state, "closed");
  assertEquals(s.closedReason, "second close");
});

// ============================================================================
// IL-7 — duplicate-reviewer double-count in blocking (only tightens the gate)
// ============================================================================

Deno.test("IL-7: recording the same reviewer twice in one round double-counts its open findings", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  // review-code posts once with a HIGH finding...
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "HIGH", "duplicate submission"),
    ]),
    h.ctx,
  );
  // ...then posts AGAIN in the same round (record_review has no dedup guard).
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "HIGH", "duplicate submission"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);

  // Coverage is a Set-of-reviewer-names check so it's unaffected (still
  // complete), but the blocking gate iterates the raw `reviews` array and
  // counts both HIGH findings — a stricter-than-intended but LOW-risk bug
  // since it only ever makes approval HARDER, never easier.
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "0 CRITICAL and 2 HIGH",
  );
});

// ============================================================================
// Malformed reviewer input — bad severity / verdict enums rejected by zod
// ============================================================================

Deno.test("adversarial: record_review arguments schema rejects an unrecognized verdict", () => {
  assertThrows(
    () =>
      model.methods.record_review.arguments.parse({
        reviewer: "review-code",
        verdict: "MAYBE",
        findings: [],
      }),
    Error,
  );
});

Deno.test("adversarial: record_review arguments schema rejects an unrecognized finding severity", () => {
  assertThrows(
    () =>
      model.methods.record_review.arguments.parse({
        reviewer: "review-code",
        verdict: "FAIL",
        findings: [{
          reviewer: "review-code",
          severity: "URGENT",
          description: "not a real severity",
          status: "open",
        }],
      }),
    Error,
  );
});

Deno.test("adversarial: triage arguments schema rejects an unrecognized priority", () => {
  assertThrows(
    () =>
      model.methods.triage.arguments.parse({
        priority: "urgent",
        category: "bug",
        affectedAreas: [],
      }),
    Error,
  );
});

Deno.test("adversarial: plan arguments schema rejects a non-positive step order", () => {
  assertThrows(
    () =>
      model.methods.plan.arguments.parse({
        ...defaultPlanArgs(),
        steps: [{ order: 0, description: "bad order", files: [] }],
      }),
    Error,
  );
});

// ============================================================================
// approve_plan gate — hostile combinations
// ============================================================================

Deno.test("adversarial: approve_plan blocks when security is enabled in the matrix but review-security never ran", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run(
    "plan",
    {
      ...defaultPlanArgs(),
      reviewMatrix: {
        code: true,
        adversarial: true,
        security: true,
        ux: false,
        skill: false,
      },
    },
    h.ctx,
  );
  await run("review_plan", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "review-security",
  );
});

Deno.test("adversarial: approve_plan reports combined CRITICAL+HIGH counts from two different reviewers", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "CRITICAL", "a"),
      finding("review-code", "CRITICAL", "b"),
    ]),
    h.ctx,
  );
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "c"),
    ]),
    h.ctx,
  );
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "2 CRITICAL and 1 HIGH",
  );
});

// ============================================================================
// Out-of-order calls from varied illegal source states
// ============================================================================

Deno.test("adversarial: implement rejected from filed (skipping plan/review/approve entirely)", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await assertRejects(
    () => run("implement", { branch: "feat/x" }, h.ctx),
    Error,
    "Cannot call 'implement' in state 'filed'. Expected: approved",
  );
});

Deno.test("adversarial: resolve_findings rejected from writing_tests (skipping the entire code-review phase)", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await assertRejects(
    () => run("resolve_findings", { resolutions: {} }, h.ctx),
    Error,
    "Cannot call 'resolve_findings' in state 'writing_tests'. Expected: code_reviewing",
  );
});

Deno.test("adversarial: harvest rejected from writing_tests", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await assertRejects(
    () => run("harvest", { uatProposals: [], kbProposals: [] }, h.ctx),
    Error,
    "Cannot call 'harvest' in state 'writing_tests'. Expected: resolved",
  );
});

// ============================================================================
// whitespace override_reason still gated (tab / newline variants beyond the
// single-space case already pinned in issue_lifecycle.test.ts)
// ============================================================================

Deno.test("adversarial: tests_approved with a tab-only override_reason still enforces the blocking gate", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "HIGH", "missing"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await assertRejects(
    () => run("tests_approved", { override_reason: "\t\t" }, h.ctx),
    Error,
    "HIGH",
  );
});

Deno.test("adversarial: tests_approved with a newline-only override_reason still enforces the blocking gate", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "CRITICAL", "missing"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await assertRejects(
    () => run("tests_approved", { override_reason: "\n" }, h.ctx),
    Error,
    "CRITICAL",
  );
});

// ============================================================================
// Corrupted stored state — approve_plan / tests_approved "no plan" branches
// (unreachable via the legitimate method flow: review_plan/review_tests only
// transition FROM a state that plan() itself set alongside `data.plan`, so
// these branches only fire against a directly-corrupted store)
// ============================================================================

Deno.test("adversarial: approve_plan throws 'no plan found' against a corrupted reviewing state with no plan", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  const s = h.getState()!;
  await h.ctx.writeResource("state", "current", {
    ...s,
    state: "reviewing",
    plan: undefined,
  });
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "No plan found — nothing to approve",
  );
});

Deno.test("adversarial: tests_approved throws 'no plan found' against a corrupted reviewing_tests state with no plan", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  const s = h.getState()!;
  await h.ctx.writeResource("state", "current", {
    ...s,
    state: "reviewing_tests",
    plan: undefined,
  });
  await assertRejects(
    () => run("tests_approved", {}, h.ctx),
    Error,
    "No plan found — tests cannot be approved without a plan",
  );
});

// ============================================================================
// Empty / boundary inputs
// ============================================================================

Deno.test("adversarial: start with an empty title and description still files successfully (no non-empty validation)", async () => {
  const h = createHarness();
  await run("start", { title: "", description: "", labels: [] }, h.ctx);
  const s = h.getState()!;
  assertEquals(s.state, "filed");
  assertEquals(s.title, "");
});

Deno.test("adversarial: reject_plan with an empty reason string is accepted (no non-empty validation)", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("reject_plan", { reason: "", source: "human" }, h.ctx);
  const s = h.getState()!;
  assertEquals(s.state, "planned");
  assertStringIncludes(s.reviewHistory[0].rejectReason ?? "", "");
});
