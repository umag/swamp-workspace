// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// ADVERSARIAL suite (ext-quality-bf-issue-lifecycle, wave-4 batch-4d;
// latent-bug real-fix in 2026.08.02.1). This suite assumes the source is
// broken until proven otherwise: illegal transitions from varied source
// states, malformed reviewer input (bad severity/verdict enums), hostile
// approve_plan / tests_approved gate combinations, corrupted stored state,
// and pins for the LOCAL latent bugs IL-1 through IL-7 (see the LOCAL
// issue-lifecycle-latent-bugs issue-lifecycle model for the full triage —
// never the swamp.club Lab).
//
// Four bugs are FIXED as of 2026.08.02.1 — the pins below assert the FIXED
// behavior, not the original bug:
//   IL-1 (fixed) — start refuses to overwrite an in-flight issue (any state
//     other than complete/closed) unless force:true is passed.
//   IL-2 (fixed) — approve_plan/tests_approved also block on a reviewer FAIL
//     verdict, even with zero open/blocking findings.
//   IL-4 (fixed) — resolve_findings keys resolutions per matching reviewer,
//     so two different reviewers' findings sharing description text no
//     longer collapse into one resolutions-map entry.
//   IL-7 (fixed) — record_review replaces (last-write-wins), not appends, a
//     reviewer's second submission within the same round.
//
// Three bugs are KEPT AS DESIGNED — re-affirmed, not fixed:
//   IL-3 (by design) — no model-enforced iteration cap; MAX_CODE_ITERATIONS /
//     MAX_TEST_ITERATIONS are skill-layer policy, not the pure model's job.
//   IL-5 (by design) — close has no guardState call; it is the
//     abandon/escape hatch and must work from any state, including
//     terminal ones.
//
// Harness is a byte-identical copy of issue_lifecycle.test.ts's fake context.

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  AttestationSchema,
  attestImpl,
  blockingControls,
  type CommandRunner,
  type ControlSpec,
  type FileReader,
  type Finding,
  type IssueState,
  IssueStateSchema,
  joinRepoPath,
  model,
  RUN_PERMISSION_ERROR,
  runControl,
  STDERR_TAIL_LIMIT,
  verifyImpl,
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
      } else if (spec === "attestation") {
        AttestationSchema.parse(data);
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

// ---------------------------------------------------------------------------
// Verification helpers — scripted CommandRunner, nothing is ever spawned
// ---------------------------------------------------------------------------

/** Every control exits 0. */
const okRunner: CommandRunner = () =>
  Promise.resolve({ code: 0, stdout: "", stderr: "" });

/** Every control exits non-zero with diagnostic output. */
const failRunner: CommandRunner = () =>
  Promise.resolve({ code: 1, stdout: "", stderr: "control rejected the tree" });

/** A minimal required local control. */
const TEST_CONTROLS: ControlSpec[] = [
  {
    name: "test",
    command: "deno",
    args: ["task", "test"],
    cwd: ".",
    tier: "local",
    required: true,
  },
];

/** Drive `implementing` → `verifying` with every control green. */
function passVerification(h: Harness): Promise<unknown> {
  return verifyImpl(
    okRunner,
    { controls: TEST_CONTROLS, repoDir: "/repo", runner: "local" },
    h.ctx,
  );
}

/** Drive `implementing` → `verifying` with a failing control. */
function failVerification(h: Harness): Promise<unknown> {
  return verifyImpl(
    failRunner,
    { controls: TEST_CONTROLS, repoDir: "/repo", runner: "local" },
    h.ctx,
  );
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

async function withImplementingState(h: Harness): Promise<void> {
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x", description: "" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
}

async function withResolvedState(h: Harness): Promise<void> {
  await withImplementingState(h);
  await passVerification(h);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
}

/** Reach `resolved` carrying a verification round whose control FAILED. */
async function withResolvedAfterFailingControl(h: Harness): Promise<void> {
  await withImplementingState(h);
  await failVerification(h);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
}

// ============================================================================
// IL-1 (fixed) — start now guards against overwriting an in-flight issue
// ============================================================================

Deno.test("IL-1 (fixed): start refuses to overwrite an in-flight approved plan", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  const before = h.getState()!;
  assertEquals(before.state, "approved");
  assertEquals(before.reviewHistory.length, 1);
  assertEquals(before.title, "Test issue");

  await assertRejects(
    () =>
      run(
        "start",
        { title: "Different issue entirely", description: "d2", labels: [] },
        h.ctx,
      ),
    Error,
    "force",
  );

  // Nothing was overwritten.
  const after = h.getState()!;
  assertEquals(after.state, "approved");
  assertEquals(after.title, "Test issue");
  assertEquals(after.reviewHistory.length, 1);
  assertEquals(after.planVersion, 1);
});

Deno.test("IL-1 (fixed): start with force:true still overwrites an in-flight issue", async () => {
  const h = createHarness();
  await withApprovedPlan(h);

  await run(
    "start",
    {
      title: "Different issue entirely",
      description: "d2",
      labels: [],
      force: true,
    },
    h.ctx,
  );

  const after = h.getState()!;
  assertEquals(after.state, "filed");
  assertEquals(after.title, "Different issue entirely");
  assertEquals(
    after.reviewHistory,
    [],
    "force:true still wipes reviewHistory — that's the explicit opt-in",
  );
  assertEquals(after.plan, undefined);
  assertEquals(after.planVersion, 1);
});

Deno.test("IL-1 (fixed): start succeeds from a terminal state (complete) without force", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  const s = h.getState()!;
  await h.ctx.writeResource("state", "current", {
    ...s,
    state: "complete",
    completedAt: "2026-07-31T00:00:00.000Z",
  });

  await run(
    "start",
    { title: "Fresh issue after complete", description: "d3", labels: [] },
    h.ctx,
  );
  const after = h.getState()!;
  assertEquals(after.state, "filed");
  assertEquals(after.title, "Fresh issue after complete");
});

Deno.test("IL-1 (fixed): start succeeds from a terminal state (closed) without force", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("close", { reason: "abandoned" }, h.ctx);
  assertEquals(h.getState()!.state, "closed");

  await run(
    "start",
    { title: "Fresh issue after close", description: "d4", labels: [] },
    h.ctx,
  );
  const after = h.getState()!;
  assertEquals(after.state, "filed");
  assertEquals(after.title, "Fresh issue after close");
});

// ============================================================================
// IL-2 (fixed) — approve_plan / tests_approved now also block on a reviewer
// FAIL verdict, even with zero open/blocking findings
// ============================================================================

Deno.test("IL-2 (fixed): approve_plan blocks when a reviewer's verdict is FAIL, even with empty findings", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  // review-code posts verdict=FAIL but with an empty findings array —
  // hasBlockingFindings alone would miss this; failingReviewers() catches it.
  await run("record_review", failReview("review-code", []), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "review-code",
  );
  assertEquals(
    h.getState()!.state,
    "reviewing",
    "approval must not proceed on a FAIL verdict",
  );
});

Deno.test("IL-2 (fixed): approve_plan blocks when a reviewer's verdict is FAIL even though the finding is already resolved", async () => {
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

  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "review-code",
  );
});

Deno.test("IL-2 (fixed): tests_approved blocks when a reviewer's verdict is FAIL, even with zero blocking findings", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", failReview("review-code", []), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await assertRejects(
    () => run("tests_approved", {}, h.ctx),
    Error,
    "review-code",
  );
});

Deno.test("IL-2 (fixed): tests_approved override_reason bypasses the FAIL-verdict gate too", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", failReview("review-code", []), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await run(
    "tests_approved",
    { override_reason: "human accepts FAIL verdict with no open findings" },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "implementing");
  const testRound = s.reviewHistory.find((r) => r.phase === "test_review")!;
  assertEquals(testRound.outcome, "human_override");
});

// ============================================================================
// IL-3 (re-affirmed by-design in 2026.08.02.1) — no model-enforced iteration
// cap; MAX_CODE_ITERATIONS/MAX_TEST_ITERATIONS are skill-layer policy, not
// enforced here, so the human override_reason escape hatch is never coupled
// to a model-level cap.
// ============================================================================

Deno.test("IL-3: iterate has no model-enforced cap — 10 consecutive rounds all succeed", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  await passVerification(h);
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
    await passVerification(h);
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
// IL-4 (fixed) — resolutions are keyed per matching reviewer, so shared
// description text across reviewers no longer collapses into one entry
// ============================================================================

Deno.test("IL-4 (fixed): resolve_findings expands a shared description into one composite key per matching reviewer", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  await passVerification(h);
  await run("review_code", {}, h.ctx);

  // Two DIFFERENT reviewers, two DIFFERENT findings, but the exact same
  // description string ("needs error handling") — resolve_findings now
  // expands the key to one composite `${reviewer} :: ${description}` entry
  // per reviewer whose finding matches, instead of collapsing to one key.
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
    2,
    "IL-4 (fixed): a shared description expands into one composite key per matching reviewer",
  );
  assertEquals(
    s.resolutions["review-code :: needs error handling"],
    "fixed in both call sites",
  );
  assertEquals(
    s.resolutions["review-adversarial :: needs error handling"],
    "fixed in both call sites",
  );
});

Deno.test("IL-4 (fixed): resolve_findings does not spuriously expand a single-reviewer description", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  await passVerification(h);
  await run("review_code", {}, h.ctx);

  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "MEDIUM", "single reviewer finding"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await run(
    "resolve_findings",
    { resolutions: { "single reviewer finding": "fixed" } },
    h.ctx,
  );

  const s = h.getState()!;
  assertEquals(Object.keys(s.resolutions).length, 1);
  assertEquals(
    s.resolutions["review-code :: single reviewer finding"],
    "fixed",
  );
});

Deno.test("IL-4 (fixed): resolve_findings stores a key that matches no current-round finding verbatim (legacy-safe)", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  await passVerification(h);
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);

  await run(
    "resolve_findings",
    { resolutions: { "no matching finding description": "n/a" } },
    h.ctx,
  );

  const s = h.getState()!;
  assertEquals(Object.keys(s.resolutions), [
    "no matching finding description",
  ]);
  assertEquals(s.resolutions["no matching finding description"], "n/a");
});

// ============================================================================
// IL-5 (re-affirmed by-design in 2026.08.02.1) — close is guardless and
// terminal-agnostic; it is the abandon/escape hatch and manifest.yaml
// promises "close works from any state" — an escape hatch must never be
// blockable, including from terminal/error states.
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
// IL-7 (fixed) — record_review now replaces (last-write-wins), not appends,
// a reviewer's second submission within the same round
// ============================================================================

Deno.test("IL-7 (fixed): recording the same reviewer twice in one round replaces the earlier entry", async () => {
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
  // ...then posts AGAIN in the same round — record_review now replaces the
  // earlier entry from the same reviewer instead of appending a second one.
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "HIGH", "duplicate submission"),
    ]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);

  assertEquals(
    h.getState()!.reviews.length,
    2,
    "IL-7 (fixed): the duplicate review-code submission replaces, not appends",
  );

  // The blocking gate no longer double-counts the same reviewer's HIGH
  // finding across two submissions.
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "0 CRITICAL and 1 HIGH",
  );
});

Deno.test("IL-7 (fixed): a reviewer's second submission replaces the verdict and findings from their first (last write wins)", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run(
    "record_review",
    failReview("review-code", [
      finding("review-code", "CRITICAL", "first pass finding"),
    ]),
    h.ctx,
  );
  // Same reviewer re-submits clean — should fully replace, not merge.
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);

  const s = h.getState()!;
  assertEquals(s.reviews.length, 2, "one entry per distinct reviewer");
  const codeReview = s.reviews.find((r) => r.reviewer === "review-code")!;
  assertEquals(codeReview.verdict, "PASS");
  assertEquals(codeReview.findings, []);

  // The stale CRITICAL finding from the first submission no longer blocks.
  await run("approve_plan", {}, h.ctx);
  assertEquals(h.getState()!.state, "approved");
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

// ============================================================================
// Verification: the model now spawns subprocesses and reads files
// ============================================================================
//
// Until 2026.08.31.1 this model was pure logic — no fetch, no subprocess, no
// file I/O. `verify` and `attest` end that, and the control specs they act on
// come from a repo file an agent edits. Everything below treats those specs
// as hostile input.

const LOCAL_CONTROL: ControlSpec = {
  name: "test",
  command: "deno",
  args: ["task", "test"],
  cwd: ".",
  tier: "local",
  required: true,
};

const neverRuns: CommandRunner = () => {
  throw new Error("runner must not be invoked for this control");
};

Deno.test("adversarial: a control cwd escaping the repo root is rejected before anything spawns", async () => {
  for (const cwd of ["../../etc", "a/../../b", ".."]) {
    await assertRejects(
      () => runControl(neverRuns, { ...LOCAL_CONTROL, cwd }, "/repo", "local"),
      Error,
      "must stay inside the repo",
    );
  }
});

Deno.test("adversarial: an absolute control cwd is rejected before anything spawns", async () => {
  await assertRejects(
    () =>
      runControl(
        neverRuns,
        { ...LOCAL_CONTROL, cwd: "/etc" },
        "/repo",
        "local",
      ),
    Error,
    "must be relative to the repo root",
  );
});

Deno.test("adversarial: a control cwd is joined onto the repo root, never used bare", () => {
  assertEquals(joinRepoPath("/repo", "scripts"), "/repo/scripts");
  assertEquals(joinRepoPath("/repo/", "scripts"), "/repo/scripts");
  assertEquals(joinRepoPath("/repo", "."), "/repo");
  assertEquals(joinRepoPath("/repo", "./a/./b"), "/repo/a/b");
});

Deno.test("adversarial: a control the runtime cannot spawn is 'error', never a silent skip", async () => {
  const spawnFails: CommandRunner = () =>
    Promise.resolve({
      code: null,
      stdout: "",
      stderr: "",
      spawnError: "No such file or directory (os error 2)",
    });
  const result = await runControl(spawnFails, LOCAL_CONTROL, "/repo", "local");
  assertEquals(result.status, "error");
  assertEquals(result.exitCode, null);
  assertStringIncludes(result.stderrTail, "os error 2");
  // An unrunnable required control blocks exactly as a failing one does.
  assertEquals(blockingControls([result]).length, 1);
});

Deno.test("adversarial: a managed control on a local runner is skipped AND still blocks", async () => {
  const managed: ControlSpec = { ...LOCAL_CONTROL, tier: "managed" };
  const result = await runControl(neverRuns, managed, "/repo", "local");
  assertEquals(result.status, "skipped");
  assertEquals(blockingControls([result]).length, 1);
});

Deno.test("adversarial: an optional control that fails does not block", async () => {
  const optional: ControlSpec = { ...LOCAL_CONTROL, required: false };
  const failing: CommandRunner = () =>
    Promise.resolve({ code: 3, stdout: "", stderr: "nope" });
  const result = await runControl(failing, optional, "/repo", "local");
  assertEquals(result.status, "fail");
  assertEquals(blockingControls([result]).length, 0);
});

Deno.test("adversarial: a runner that throws propagates — a control round never half-succeeds silently", async () => {
  const h = createHarness();
  await withImplementingState(h);
  const throwing: CommandRunner = () => {
    throw new Error(RUN_PERMISSION_ERROR);
  };
  await assertRejects(
    () =>
      verifyImpl(
        throwing,
        { controls: [LOCAL_CONTROL], repoDir: "/repo", runner: "local" },
        h.ctx,
      ),
    Error,
    "allow-run is not granted",
  );
  // State was never advanced — the tree is not recorded as verified.
  assertEquals(h.getState()!.state, "implementing");
});

Deno.test("adversarial: control stderr is truncated to a bounded tail", async () => {
  const noisy: CommandRunner = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "x".repeat(50_000) });
  const result = await runControl(noisy, LOCAL_CONTROL, "/repo", "local");
  assertEquals(result.stderrTail.length, STDERR_TAIL_LIMIT);
});

Deno.test("adversarial: attest refuses when a required control did not pass", async () => {
  const h = createHarness();
  await withResolvedAfterFailingControl(h);
  await assertRejects(
    () =>
      run(
        "attest",
        { commitSha: "a".repeat(40), repoDir: "/repo", configPaths: [] },
        h.ctx,
      ),
    Error,
    "required control(s) did not pass",
  );
  assertEquals(h.getState()!.state, "resolved");
});

Deno.test("adversarial: attest refuses when no verification round was ever recorded", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);
  await run("implement", { branch: "feat/x", description: "" }, h.ctx);
  await run("review_tests", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
  // Forge the state straight into `resolved` — as a buggy skill or a hand
  // edit could — and confirm the model still refuses to attest.
  const forged = { ...h.getState()!, state: "resolved" };
  const h2 = createHarness(forged as unknown as Record<string, unknown>);
  await assertRejects(
    () =>
      run(
        "attest",
        { commitSha: "a".repeat(40), repoDir: "/repo", configPaths: [] },
        h2.ctx,
      ),
    Error,
    "no verification round recorded",
  );
});

Deno.test("adversarial: attest refuses when a declared config path cannot be read", async () => {
  const h = createHarness();
  await withResolvedState(h);
  const missing: FileReader = () => {
    throw new Deno.errors.NotFound("gone");
  };
  await assertRejects(
    () =>
      attestImpl(
        missing,
        {
          commitSha: "a".repeat(40),
          repoDir: "/repo",
          configPaths: ["agent-constraints/verification-controls.md"],
          producedBy: "test",
        },
        h.ctx,
      ),
    Error,
    "could not be read",
  );
  // A manifest that silently omitted the entry would validate against a tree
  // where the constraints file had been deleted.
  assertEquals(h.getState()!.state, "resolved");
});

Deno.test("adversarial: attest refuses while a blocking finding is still open", async () => {
  const h = createHarness();
  await withImplementingState(h);
  await verifyImpl(
    () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    { controls: [LOCAL_CONTROL], repoDir: "/repo", runner: "local" },
    h.ctx,
  );
  await run("review_code", {}, h.ctx);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  // resolve_findings clears the round; re-open a CRITICAL by recording one
  // against the now-resolved state via a fresh harness.
  const withOpen = {
    ...h.getState()!,
    reviews: [{
      reviewer: "review-code",
      verdict: "FAIL",
      findings: [{
        reviewer: "review-code",
        severity: "CRITICAL",
        description: "still broken",
        status: "open",
      }],
      timestamp: new Date().toISOString(),
    }],
  };
  const h2 = createHarness(withOpen as unknown as Record<string, unknown>);
  await assertRejects(
    () =>
      run(
        "attest",
        { commitSha: "a".repeat(40), repoDir: "/repo", configPaths: [] },
        h2.ctx,
      ),
    Error,
    "CRITICAL",
  );
});
