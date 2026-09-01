// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// METHODS suite (ext-quality-bf-issue-lifecycle, wave-4 batch-4d; latent-bug
// real-fix in 2026.08.02.1 touched `start`, `approve_plan`, `tests_approved`,
// `resolve_findings`, and `record_review` — see issue_lifecycle_adversarial_
// test.ts for the IL-1/2/4/7 fix pins). Every test here characterizes the
// shipped behavior of the 20 model methods (start,
// triage, record_prior_art, record_reproduction, plan, review_plan,
// record_review, approve_plan, reject_plan, implement, review_tests,
// iterate_tests, tests_approved, review_code, resolve_findings, iterate,
// harvest, complete, close, hydrate): one success-from-valid-precondition
// test, one guardState-throw-from-illegal-state test (exact message
// asserted) for each of the 17 guarded methods, plus a sweep pinning the
// unknown-key-stripping behavior of every method's zod arguments schema and
// a sweep pinning the "No issue state found — run 'start' first"
// precondition shared by every method except `start`.
//
// Harness is a byte-identical copy of issue_lifecycle.test.ts's fake context
// (per the good-planning / good_planning_methods_test.ts precedent — each
// new suite file carries its own harness copy rather than importing a
// shared test-only module).

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import {
  AttestationSchema,
  type CommandRunner,
  type ControlSpec,
  type Finding,
  type IssueState,
  IssueStateSchema,
  model,
  type ReviewMatrix,
  verifyImpl,
} from "./issue_lifecycle.ts";

// ============================================================================
// Test harness — fake context with strict schema validation on writes
// (byte-identical copy of issue_lifecycle.test.ts's harness)
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

async function withPlannedPlan(h: Harness): Promise<void> {
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
}

async function withReviewingPlan(h: Harness): Promise<void> {
  await withPlannedPlan(h);
  await run("review_plan", {}, h.ctx);
}

async function withApprovedPlan(h: Harness): Promise<void> {
  await withReviewingPlan(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("approve_plan", {}, h.ctx);
}

async function withWritingTests(h: Harness, branch = "feat/x"): Promise<void> {
  await withApprovedPlan(h);
  await run("implement", { branch }, h.ctx);
}

async function withReviewingTests(h: Harness): Promise<void> {
  await withWritingTests(h);
  await run("review_tests", {}, h.ctx);
}

async function withImplementing(h: Harness): Promise<void> {
  await withReviewingTests(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("tests_approved", {}, h.ctx);
}

async function withCodeReviewing(h: Harness): Promise<void> {
  await withImplementing(h);
  await passVerification(h);
  await run("review_code", {}, h.ctx);
}

async function withResolved(h: Harness): Promise<void> {
  await withCodeReviewing(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
}

// ============================================================================
// start — guards against overwriting an in-flight issue (2026.08.02.1, IL-1
// fix); an empty harness has no `current` yet, so the guard is a no-op here
// and start still always writes fresh state on first call
// ============================================================================

Deno.test("methods: start succeeds from empty harness", async () => {
  const h = createHarness();
  await run(
    "start",
    { title: "New issue", description: "d", labels: [] },
    h.ctx,
  );
  const s = h.getState()!;
  assertEquals(s.state, "filed");
  assertEquals(s.title, "New issue");
});

// ============================================================================
// triage
// ============================================================================

Deno.test("methods: triage succeeds from filed", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await run(
    "triage",
    {
      priority: "medium",
      category: "bug",
      affectedAreas: [],
      clarifyingQuestions: [],
    },
    h.ctx,
  );
  assertEquals(h.getState()!.state, "triaged");
});

Deno.test("methods: triage guardState-throws from triaged (already triaged)", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await assertRejects(
    () =>
      run(
        "triage",
        {
          priority: "low",
          category: "bug",
          affectedAreas: [],
          clarifyingQuestions: [],
        },
        h.ctx,
      ),
    Error,
    "Cannot call 'triage' in state 'triaged'. Expected: filed",
  );
});

// ============================================================================
// record_prior_art
// ============================================================================

Deno.test("methods: record_prior_art succeeds from triaged", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("record_prior_art", { uatScenarios: [], kbEntries: [] }, h.ctx);
  assertExists(h.getState()!.priorArt);
});

Deno.test("methods: record_prior_art guardState-throws from filed", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await assertRejects(
    () => run("record_prior_art", { uatScenarios: [], kbEntries: [] }, h.ctx),
    Error,
    "Cannot call 'record_prior_art' in state 'filed'. Expected: triaged, planned",
  );
});

// ============================================================================
// record_reproduction
// ============================================================================

Deno.test("methods: record_reproduction succeeds from triaged", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("record_reproduction", { status: "reproduced" }, h.ctx);
  assertEquals(h.getState()!.triageDetail!.reproduced!.status, "reproduced");
});

Deno.test("methods: record_reproduction guardState-throws from filed", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await assertRejects(
    () => run("record_reproduction", { status: "reproduced" }, h.ctx),
    Error,
    "Cannot call 'record_reproduction' in state 'filed'. Expected: triaged, planned",
  );
});

// ============================================================================
// plan
// ============================================================================

Deno.test("methods: plan succeeds from triaged", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await run("plan", defaultPlanArgs(), h.ctx);
  const s = h.getState()!;
  assertEquals(s.state, "planned");
  assertEquals(s.planVersion, 1);
});

Deno.test("methods: plan guardState-throws from filed", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await assertRejects(
    () => run("plan", defaultPlanArgs(), h.ctx),
    Error,
    "Cannot call 'plan' in state 'filed'. Expected: triaged, planned",
  );
});

// ============================================================================
// review_plan
// ============================================================================

Deno.test("methods: review_plan succeeds from planned", async () => {
  const h = createHarness();
  await withPlannedPlan(h);
  await run("review_plan", {}, h.ctx);
  assertEquals(h.getState()!.state, "reviewing");
});

Deno.test("methods: review_plan guardState-throws from triaged", async () => {
  const h = createHarness();
  await filedAndTriaged(h);
  await assertRejects(
    () => run("review_plan", {}, h.ctx),
    Error,
    "Cannot call 'review_plan' in state 'triaged'. Expected: planned",
  );
});

// ============================================================================
// record_review
// ============================================================================

Deno.test("methods: record_review succeeds from reviewing", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run("record_review", passReview("review-code"), h.ctx);
  assertEquals(h.getState()!.reviews.length, 1);
});

Deno.test("methods: record_review guardState-throws from planned", async () => {
  const h = createHarness();
  await withPlannedPlan(h);
  await assertRejects(
    () => run("record_review", passReview("review-code"), h.ctx),
    Error,
    "Cannot call 'record_review' in state 'planned'. Expected: reviewing, reviewing_tests, code_reviewing",
  );
});

// ============================================================================
// approve_plan
// ============================================================================

Deno.test("methods: approve_plan succeeds from reviewing with clean coverage", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  assertEquals(h.getState()!.state, "approved");
});

Deno.test("methods: approve_plan guardState-throws from planned", async () => {
  const h = createHarness();
  await withPlannedPlan(h);
  await assertRejects(
    () => run("approve_plan", {}, h.ctx),
    Error,
    "Cannot call 'approve_plan' in state 'planned'. Expected: reviewing",
  );
});

// ============================================================================
// reject_plan
// ============================================================================

Deno.test("methods: reject_plan succeeds from reviewing", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "x"),
    ]),
    h.ctx,
  );
  await run("reject_plan", { reason: "revise", source: "auto" }, h.ctx);
  assertEquals(h.getState()!.state, "planned");
});

Deno.test("methods: reject_plan guardState-throws from planned", async () => {
  const h = createHarness();
  await withPlannedPlan(h);
  await assertRejects(
    () => run("reject_plan", { reason: "x", source: "human" }, h.ctx),
    Error,
    "Cannot call 'reject_plan' in state 'planned'. Expected: reviewing",
  );
});

// ============================================================================
// implement
// ============================================================================

Deno.test("methods: implement succeeds from approved", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await run("implement", { branch: "feat/x" }, h.ctx);
  assertEquals(h.getState()!.state, "writing_tests");
});

Deno.test("methods: implement guardState-throws from reviewing", async () => {
  const h = createHarness();
  await withReviewingPlan(h);
  await assertRejects(
    () => run("implement", { branch: "feat/x" }, h.ctx),
    Error,
    "Cannot call 'implement' in state 'reviewing'. Expected: approved",
  );
});

// ============================================================================
// review_tests
// ============================================================================

Deno.test("methods: review_tests succeeds from writing_tests", async () => {
  const h = createHarness();
  await withWritingTests(h);
  await run("review_tests", {}, h.ctx);
  assertEquals(h.getState()!.state, "reviewing_tests");
});

Deno.test("methods: review_tests guardState-throws from approved", async () => {
  const h = createHarness();
  await withApprovedPlan(h);
  await assertRejects(
    () => run("review_tests", {}, h.ctx),
    Error,
    "Cannot call 'review_tests' in state 'approved'. Expected: writing_tests",
  );
});

// ============================================================================
// iterate_tests
// ============================================================================

Deno.test("methods: iterate_tests succeeds from reviewing_tests", async () => {
  const h = createHarness();
  await withReviewingTests(h);
  await run(
    "record_review",
    failReview("review-code", [finding("review-code", "HIGH", "x")]),
    h.ctx,
  );
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("iterate_tests", { reason: "fix", source: "auto" }, h.ctx);
  assertEquals(h.getState()!.state, "writing_tests");
});

Deno.test("methods: iterate_tests guardState-throws from writing_tests", async () => {
  const h = createHarness();
  await withWritingTests(h);
  await assertRejects(
    () => run("iterate_tests", { reason: "x", source: "auto" }, h.ctx),
    Error,
    "Cannot call 'iterate_tests' in state 'writing_tests'. Expected: reviewing_tests",
  );
});

// ============================================================================
// tests_approved
// ============================================================================

Deno.test("methods: tests_approved succeeds from reviewing_tests with clean coverage", async () => {
  const h = createHarness();
  await withImplementing(h);
  assertEquals(h.getState()!.state, "implementing");
});

Deno.test("methods: tests_approved guardState-throws from writing_tests", async () => {
  const h = createHarness();
  await withWritingTests(h);
  await assertRejects(
    () => run("tests_approved", {}, h.ctx),
    Error,
    "Cannot call 'tests_approved' in state 'writing_tests'. Expected: reviewing_tests",
  );
});

// ============================================================================
// review_code
// ============================================================================

Deno.test("methods: review_code succeeds from implementing", async () => {
  const h = createHarness();
  await withImplementing(h);
  await passVerification(h);
  await run("review_code", {}, h.ctx);
  assertEquals(h.getState()!.state, "code_reviewing");
});

Deno.test("methods: review_code guardState-throws from reviewing_tests", async () => {
  const h = createHarness();
  await withReviewingTests(h);
  await assertRejects(
    () => run("review_code", {}, h.ctx),
    Error,
    "Cannot call 'review_code' in state 'reviewing_tests'. Expected: verifying",
  );
});

// ============================================================================
// verify / iterate_verification — the pre-PR verification gate
// ============================================================================

Deno.test("methods: verify succeeds from implementing and records controls", async () => {
  const h = createHarness();
  await withImplementing(h);
  await passVerification(h);

  const st = h.getState()!;
  assertEquals(st.state, "verifying");
  assertEquals(st.verification!.controls.length, 1);
  assertEquals(st.verification!.controls[0].status, "pass");
  assertEquals(st.verification!.controls[0].runner, "local");
  assertEquals(st.verification!.controls[0].command, "deno task test");
});

Deno.test("methods: verify records a non-zero exit as fail, not error", async () => {
  const h = createHarness();
  await withImplementing(h);
  await failVerification(h);

  const c = h.getState()!.verification!.controls[0];
  assertEquals(c.status, "fail");
  assertEquals(c.exitCode, 1);
  assertStringIncludes(c.stderrTail, "control rejected the tree");
});

Deno.test("methods: verify guardState-throws from code_reviewing", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await assertRejects(
    () => passVerification(h),
    Error,
    "Cannot call 'verify' in state 'code_reviewing'. Expected: implementing",
  );
});

Deno.test("methods: iterate_verification returns to implementing and bumps the cursor", async () => {
  const h = createHarness();
  await withImplementing(h);
  await failVerification(h);
  await run(
    "iterate_verification",
    { reason: "lint failed", source: "auto" },
    h.ctx,
  );

  const st = h.getState()!;
  assertEquals(st.state, "implementing");
  assertEquals(st.verificationIteration, 2);
  const round = st.reviewHistory.at(-1)!;
  assertEquals(round.phase, "verification");
  assertEquals(round.outcome, "rejected_auto");
  assertEquals(round.rejectReason, "lint failed");
});

Deno.test("methods: iterate_verification guardState-throws from implementing", async () => {
  const h = createHarness();
  await withImplementing(h);
  await assertRejects(
    () => run("iterate_verification", { reason: "x", source: "auto" }, h.ctx),
    Error,
    "Cannot call 'iterate_verification' in state 'implementing'. Expected: verifying",
  );
});

Deno.test("methods: review_code is unreachable from implementing — verification is the only path", async () => {
  const h = createHarness();
  await withImplementing(h);
  await assertRejects(
    () => run("review_code", {}, h.ctx),
    Error,
    "Cannot call 'review_code' in state 'implementing'. Expected: verifying",
  );
});

// ============================================================================
// attest — the manifest CI validates in place of re-execution
// ============================================================================

Deno.test("methods: attest succeeds from resolved and writes the attestation resource", async () => {
  const h = createHarness();
  await withResolved(h);
  await run(
    "attest",
    {
      commitSha: "a".repeat(40),
      repoDir: "/repo",
      configPaths: [],
      producedBy: "test-host",
    },
    h.ctx,
  );

  const st = h.getState()!;
  assertEquals(st.state, "attested");
  assertEquals(st.attestation!.commitSha, "a".repeat(40));
  assertEquals(st.attestation!.attestationVersion, 1);
  assertEquals(st.attestation!.controls.length, 1);
  assertEquals(st.attestation!.producedBy, "test-host");
  assertEquals(st.attestation!.modelVersion, model.version);

  // Written to its own resource, keyed by commit — not only onto state.
  const written = h.writes.filter((w) => w.spec === "attestation");
  assertEquals(written.length, 1);
  assertEquals(written[0].name, "a".repeat(40));
});

Deno.test("methods: attest summarizes each reviewer's open findings by severity", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    {
      reviewer: "review-adversarial",
      verdict: "SUGGEST_CHANGES",
      findings: [
        finding("review-adversarial", "MEDIUM", "rename this"),
        finding("review-adversarial", "LOW", "typo"),
        finding("review-adversarial", "HIGH", "already handled", "resolved"),
      ],
    },
    h.ctx,
  );
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  await run(
    "attest",
    { commitSha: "b".repeat(40), repoDir: "/repo", configPaths: [] },
    h.ctx,
  );

  const reviews = h.getState()!.attestation!.reviews;
  const adv = reviews.find((r) => r.reviewer === "review-adversarial")!;
  assertEquals(adv.verdict, "SUGGEST_CHANGES");
  assertEquals(adv.medium, 1);
  assertEquals(adv.low, 1);
  // The resolved HIGH is not evidence of an unverified tree.
  assertEquals(adv.high, 0);
});

Deno.test("methods: attest guardState-throws from code_reviewing", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await assertRejects(
    () =>
      run(
        "attest",
        { commitSha: "c".repeat(40), repoDir: "/repo", configPaths: [] },
        h.ctx,
      ),
    Error,
    "Cannot call 'attest' in state 'code_reviewing'. Expected: resolved",
  );
});

Deno.test("methods: harvest and complete both accept attested", async () => {
  const h = createHarness();
  await withResolved(h);
  await run(
    "attest",
    { commitSha: "d".repeat(40), repoDir: "/repo", configPaths: [] },
    h.ctx,
  );
  await run("harvest", { uatProposals: [], kbProposals: [] }, h.ctx);
  assertEquals(h.getState()!.state, "harvested");
  await run("complete", { summary: "" }, h.ctx);
  assertEquals(h.getState()!.state, "complete");
});

// ============================================================================
// resolve_findings
// ============================================================================

Deno.test("methods: resolve_findings succeeds from code_reviewing", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run("record_review", passReview("review-adversarial"), h.ctx);
  await run("resolve_findings", { resolutions: {} }, h.ctx);
  assertEquals(h.getState()!.state, "resolved");
});

Deno.test("methods: resolve_findings guardState-throws from implementing", async () => {
  const h = createHarness();
  await withImplementing(h);
  await assertRejects(
    () => run("resolve_findings", { resolutions: {} }, h.ctx),
    Error,
    "Cannot call 'resolve_findings' in state 'implementing'. Expected: code_reviewing",
  );
});

// ============================================================================
// iterate
// ============================================================================

Deno.test("methods: iterate succeeds from code_reviewing", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await run("record_review", passReview("review-code"), h.ctx);
  await run(
    "record_review",
    failReview("review-adversarial", [
      finding("review-adversarial", "HIGH", "x"),
    ]),
    h.ctx,
  );
  await run("iterate", { reason: "fix", source: "auto" }, h.ctx);
  assertEquals(h.getState()!.state, "implementing");
});

Deno.test("methods: iterate succeeds from resolved", async () => {
  const h = createHarness();
  await withResolved(h);
  await run("iterate", { reason: "revisit", source: "human" }, h.ctx);
  assertEquals(h.getState()!.state, "implementing");
});

Deno.test("methods: iterate guardState-throws from implementing", async () => {
  const h = createHarness();
  await withImplementing(h);
  await assertRejects(
    () => run("iterate", { reason: "x", source: "auto" }, h.ctx),
    Error,
    "Cannot call 'iterate' in state 'implementing'. Expected: resolved, code_reviewing",
  );
});

// ============================================================================
// harvest
// ============================================================================

Deno.test("methods: harvest succeeds from resolved", async () => {
  const h = createHarness();
  await withResolved(h);
  await run("harvest", { uatProposals: [], kbProposals: [] }, h.ctx);
  assertEquals(h.getState()!.state, "harvested");
});

Deno.test("methods: harvest guardState-throws from code_reviewing", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await assertRejects(
    () => run("harvest", { uatProposals: [], kbProposals: [] }, h.ctx),
    Error,
    "Cannot call 'harvest' in state 'code_reviewing'. Expected: resolved",
  );
});

// ============================================================================
// complete
// ============================================================================

Deno.test("methods: complete succeeds from resolved", async () => {
  const h = createHarness();
  await withResolved(h);
  await run("complete", { summary: "" }, h.ctx);
  assertEquals(h.getState()!.state, "complete");
});

Deno.test("methods: complete succeeds from harvested", async () => {
  const h = createHarness();
  await withResolved(h);
  await run("harvest", { uatProposals: [], kbProposals: [] }, h.ctx);
  await run("complete", { summary: "" }, h.ctx);
  assertEquals(h.getState()!.state, "complete");
});

Deno.test("methods: complete guardState-throws from code_reviewing", async () => {
  const h = createHarness();
  await withCodeReviewing(h);
  await assertRejects(
    () => run("complete", { summary: "" }, h.ctx),
    Error,
    "Cannot call 'complete' in state 'code_reviewing'. Expected: resolved, attested, harvested",
  );
});

// ============================================================================
// close — no state guard, works from any state
// ============================================================================

Deno.test("methods: close succeeds from filed", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await run("close", { reason: "abandoned" }, h.ctx);
  assertEquals(h.getState()!.state, "closed");
});

Deno.test("methods: close succeeds from resolved", async () => {
  const h = createHarness();
  await withResolved(h);
  await run("close", { reason: "superseded" }, h.ctx);
  assertEquals(h.getState()!.state, "closed");
});

// ============================================================================
// hydrate — no state guard, read-only, works from any state
// ============================================================================

Deno.test("methods: hydrate succeeds from filed", async () => {
  const h = createHarness();
  await run("start", { title: "t", description: "d", labels: [] }, h.ctx);
  await run("hydrate", {}, h.ctx);
  const summary = h.getSummary();
  assertExists(summary);
  assertEquals((summary as { state: string }).state, "filed");
});

// ============================================================================
// Shared precondition: "No issue state found" on every method but `start`
// ============================================================================

const VALID_ARGS_BY_METHOD: Record<string, Record<string, unknown>> = {
  triage: {
    priority: "medium",
    category: "bug",
    affectedAreas: [],
    clarifyingQuestions: [],
  },
  record_prior_art: { uatScenarios: [], kbEntries: [] },
  record_reproduction: { status: "reproduced" },
  plan: defaultPlanArgs(),
  review_plan: {},
  record_review: passReview("review-code"),
  approve_plan: {},
  reject_plan: { reason: "x", source: "human" },
  implement: { branch: "feat/x", description: "" },
  review_tests: {},
  iterate_tests: { reason: "x", source: "human" },
  tests_approved: {},
  verify: {
    controls: [
      {
        name: "test",
        command: "deno",
        args: ["task", "test"],
        cwd: ".",
        tier: "local",
        required: true,
      },
    ],
    repoDir: "/repo",
    runner: "local",
  },
  iterate_verification: { reason: "x", source: "human" },
  review_code: {},
  resolve_findings: { resolutions: {} },
  iterate: { reason: "x", source: "human" },
  attest: {
    commitSha: "0".repeat(40),
    repoDir: "/repo",
    configPaths: [],
    producedBy: "test",
  },
  harvest: { uatProposals: [], kbProposals: [] },
  complete: { summary: "" },
  close: { reason: "x" },
  hydrate: {},
};

Deno.test("methods: every method but start throws 'No issue state found' on an empty harness", async () => {
  for (const [method, args] of Object.entries(VALID_ARGS_BY_METHOD)) {
    const h = createHarness();
    await assertRejects(
      () => run(method, args, h.ctx),
      Error,
      "No issue state found — run 'start' first",
      `method '${method}' should require existing state`,
    );
  }
});

// ============================================================================
// additionalProperties: false — verified against the REAL behavior, not the
// assumption. `swamp model type describe --json` renders every method's
// arguments schema with `additionalProperties: false` (its own zod ->
// JSON-Schema conversion), but that is swamp's CLI-level view — a bare
// `z.object({...})`'s own `.parse()` (what these methods actually declare;
// none of the 20 call `.strict()`) SILENTLY STRIPS unrecognized keys rather
// than throwing. Both facts are pinned below rather than assuming the
// stricter one holds at the unit level.
// ============================================================================

const ALL_VALID_ARGS_BY_METHOD: Record<string, Record<string, unknown>> = {
  start: { title: "t", description: "d", labels: [] },
  ...VALID_ARGS_BY_METHOD,
};

Deno.test("methods: every method's arguments schema silently strips an unknown property (zod default 'strip' mode, not 'strict')", () => {
  const methods = model.methods as MethodMap;
  for (const [method, validArgs] of Object.entries(ALL_VALID_ARGS_BY_METHOD)) {
    assertExists(
      methods[method],
      `expected a '${method}' method on the model`,
    );
    const parsed = methods[method].arguments.parse({
      ...validArgs,
      __unknown_field__: "not part of any method's schema",
    }) as Record<string, unknown>;
    assertEquals(
      Object.prototype.hasOwnProperty.call(parsed, "__unknown_field__"),
      false,
      `method '${method}' arguments schema should strip, not pass through, an unknown property`,
    );
  }
});

Deno.test("methods: every declared method name is covered by VALID_ARGS_BY_METHOD", () => {
  const declared = Object.keys(model.methods).sort();
  const covered = Object.keys(ALL_VALID_ARGS_BY_METHOD).sort();
  assertEquals(
    covered,
    declared,
    "the fixture table must track every method the model declares — a new " +
      "method added to the source without a fixture entry fails here",
  );
});
