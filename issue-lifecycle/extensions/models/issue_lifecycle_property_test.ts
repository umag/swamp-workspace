// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// PROPERTY-INVARIANT-FLOW suite (ext-quality-bf-issue-lifecycle, wave-4
// batch-4d). issue_lifecycle.ts is BYTE-FROZEN by this change.
//
// P1 — no illegal transition ever succeeds: for every guarded method and
//      every state outside its allowed set, execute() throws.
// P2 — blocking counts are monotone: adding findings to a review round can
//      only ever hold or increase hasBlockingFindings().total, never
//      decrease it.
// P3 — a randomized-but-LEGAL walk through the state machine (bounded to a
//      fixed skeleton with a handful of yes/no branch points: reject-then-
//      replan, iterate_tests-then-retry, iterate-then-retry, harvest-or-
//      skip) always ends in `complete` with every intermediate write still
//      IssueStateSchema-valid (enforced by the harness itself) and with
//      reviewHistory phase counts matching the branches actually taken.
// P4 — hydrate never mutates `current` (IL-6: `summary.snapshotAt` is the
//      one intentionally time-dependent field; @std/testing FakeTime
//      freezes `now()` for the whole test so the comparison can be a full
//      deep-equality without excluding anything by hand).
// P5 — the approve_plan gate holds in both directions under the FIXED gate
//      (2026.08.02.1, IL-2): given full matrix coverage, it throws iff
//      hasBlockingFindings(...).total > 0 OR any reviewer's verdict is
//      FAIL, and succeeds iff neither holds. verdict is drawn independently
//      of finding severity/status so the two gate dimensions
//      (blocking-findings and FAIL-verdict) are exercised in every
//      combination, not just the one where they happen to coincide.
//
// Every arbitrary below is restricted to the domain where the invariant
// genuinely holds — see the comment on each property. FC_NUM_RUNS
// (env, `--allow-env=FC_NUM_RUNS` in deno.json) overrides the run count;
// verified locally at FC_NUM_RUNS=5000 (3 runs) per the wave-4 property
// discipline rule before this suite was called green.
//
// Harness is a byte-identical copy of issue_lifecycle.test.ts's fake context.

import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { FakeTime } from "jsr:@std/testing@1/time";

import {
  AttestationSchema,
  type CommandRunner,
  type ControlSpec,
  failingReviewers,
  type Finding,
  hasBlockingFindings,
  type IssueState,
  IssueStateSchema,
  model,
  type ReviewResult,
  StateEnum,
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
  getSummary(): StoredRecord | null;
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

function passReview(reviewer: string): Record<string, unknown> {
  return { reviewer, verdict: "PASS", findings: [] };
}

function numRuns(): number {
  const raw = Deno.env.get("FC_NUM_RUNS");
  const n = raw ? Number(raw) : 100;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

const FIXED_TS = "2026-07-31T00:00:00.000Z";

function defaultPlanArgs(): Record<string, unknown> {
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
    },
    potentialChallenges: [],
  };
}

// ============================================================================
// P1 — no illegal transition ever succeeds
// ============================================================================

// Guarded method -> its allowed source states + a minimal valid args object.
// (`start`, `close`, `hydrate` have no state guard and are intentionally
// excluded — there is no illegal state for them to be tested against.)
const GUARD_TABLE: Record<string, { allowed: string[]; args: unknown }> = {
  triage: {
    allowed: ["filed"],
    args: {
      priority: "medium",
      category: "bug",
      affectedAreas: [],
      clarifyingQuestions: [],
    },
  },
  record_prior_art: {
    allowed: ["triaged", "planned"],
    args: { uatScenarios: [], kbEntries: [] },
  },
  record_reproduction: {
    allowed: ["triaged", "planned"],
    args: { status: "reproduced" },
  },
  plan: { allowed: ["triaged", "planned"], args: defaultPlanArgs() },
  review_plan: { allowed: ["planned"], args: {} },
  record_review: {
    allowed: ["reviewing", "reviewing_tests", "code_reviewing"],
    args: passReview("review-code"),
  },
  approve_plan: { allowed: ["reviewing"], args: {} },
  reject_plan: {
    allowed: ["reviewing"],
    args: { reason: "x", source: "human" },
  },
  implement: {
    allowed: ["approved"],
    args: { branch: "feat/x", description: "" },
  },
  review_tests: { allowed: ["writing_tests"], args: {} },
  iterate_tests: {
    allowed: ["reviewing_tests"],
    args: { reason: "x", source: "human" },
  },
  tests_approved: { allowed: ["reviewing_tests"], args: {} },
  verify: {
    allowed: ["implementing"],
    args: {
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
  },
  iterate_verification: {
    allowed: ["verifying"],
    args: { reason: "x", source: "human" },
  },
  review_code: { allowed: ["verifying"], args: {} },
  resolve_findings: {
    allowed: ["code_reviewing"],
    args: { resolutions: {} },
  },
  iterate: {
    allowed: ["resolved", "code_reviewing"],
    args: { reason: "x", source: "human" },
  },
  attest: {
    allowed: ["resolved"],
    args: {
      commitSha: "0".repeat(40),
      repoDir: "/repo",
      configPaths: [],
      producedBy: "test",
    },
  },
  harvest: {
    allowed: ["resolved", "attested"],
    args: { uatProposals: [], kbProposals: [] },
  },
  complete: {
    allowed: ["resolved", "attested", "harvested"],
    args: { summary: "" },
  },
};

function minimalState(state: string): StoredRecord {
  return {
    state,
    title: "t",
    description: "d",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
}

Deno.test("P1: no illegal transition ever succeeds", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...Object.keys(GUARD_TABLE)),
      fc.constantFrom(...StateEnum.options),
      async (method, illegalState) => {
        const cfg = GUARD_TABLE[method];
        // Restrict the domain to genuinely illegal (state, method) pairs —
        // asserting a throw for a LEGAL pair would be an over-strong,
        // always-failing property.
        fc.pre(!cfg.allowed.includes(illegalState));

        const h = createHarness(minimalState(illegalState));
        let threw = false;
        try {
          await run(method, cfg.args as Record<string, unknown>, h.ctx);
        } catch (err) {
          threw = err instanceof Error &&
            err.message.startsWith(`Cannot call '${method}'`);
        }
        return threw;
      },
    ),
    { numRuns: numRuns() },
  );
});

// ============================================================================
// P2 — blocking counts are monotone under additional findings
// ============================================================================

const findingArb = fc.record({
  reviewer: fc.constantFrom("review-code", "review-adversarial"),
  severity: fc.constantFrom<Finding["severity"]>(
    "CRITICAL",
    "HIGH",
    "MEDIUM",
    "LOW",
  ),
  description: fc.string({ maxLength: 20 }),
  status: fc.constantFrom<Finding["status"]>(
    "open",
    "resolved",
    "accepted",
    "wontfix",
  ),
});

Deno.test("P2: hasBlockingFindings total is monotone non-decreasing under additional findings", () => {
  fc.assert(
    fc.property(
      fc.array(findingArb, { maxLength: 6 }),
      fc.array(findingArb, { maxLength: 6 }),
      (base, extra) => {
        const baseReviews: ReviewResult[] = [
          {
            reviewer: "review-code",
            verdict: "FAIL",
            findings: base,
            timestamp: FIXED_TS,
          },
        ];
        const extendedReviews: ReviewResult[] = [
          ...baseReviews,
          {
            reviewer: "review-adversarial",
            verdict: "FAIL",
            findings: extra,
            timestamp: FIXED_TS,
          },
        ];
        return hasBlockingFindings(extendedReviews).total >=
          hasBlockingFindings(baseReviews).total;
      },
    ),
    { numRuns: numRuns() },
  );
});

// ============================================================================
// P3 — a randomized-but-legal walk always ends in `complete`, schema-valid
// throughout
// ============================================================================

// Six independent yes/no branch points along the one legal skeleton:
// filed -> triaged -> planned -> [reject once?] -> reviewing -> approved
//       -> writing_tests -> [iterate_tests once?] -> reviewing_tests
//       -> implementing -> [verification fails once?] -> verifying
//       -> [iterate once?] -> code_reviewing -> resolved -> [attest?]
//       -> [harvest?] -> complete
//
// `verifying` is on the only path from `implementing` to `code_reviewing`,
// so every walk exercises it — that is the invariant the state added.
Deno.test("P3: a randomized legal walk always ends in complete, schema-valid throughout", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(), // rejectPlanOnce
      fc.boolean(), // iterateTestsOnce
      fc.boolean(), // verifyFailsOnce
      fc.boolean(), // iterateCodeOnce
      fc.boolean(), // attestBeforeFinish
      fc.boolean(), // harvestBeforeComplete
      async (
        rejectPlanOnce,
        iterateTestsOnce,
        verifyFailsOnce,
        iterateCodeOnce,
        attest,
        harvest,
      ) => {
        const h = createHarness();

        await run(
          "start",
          { title: "walk", description: "d", labels: [] },
          h.ctx,
        );
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
        await run("plan", defaultPlanArgs(), h.ctx);

        // --- plan review round(s) ---
        await run("review_plan", {}, h.ctx);
        if (rejectPlanOnce) {
          await run("record_review", passReview("review-code"), h.ctx);
          await run(
            "record_review",
            {
              reviewer: "review-adversarial",
              verdict: "FAIL",
              findings: [{
                reviewer: "review-adversarial",
                severity: "HIGH",
                description: "walk-reject",
                status: "open",
              }],
            },
            h.ctx,
          );
          await run(
            "reject_plan",
            { reason: "walk reject", source: "auto" },
            h.ctx,
          );
          await run("plan", defaultPlanArgs(), h.ctx);
          await run("review_plan", {}, h.ctx);
        }
        await run("record_review", passReview("review-code"), h.ctx);
        await run("record_review", passReview("review-adversarial"), h.ctx);
        await run("approve_plan", {}, h.ctx);

        // --- TDD test-review round(s) ---
        await run("implement", { branch: "feat/walk" }, h.ctx);
        await run("review_tests", {}, h.ctx);
        if (iterateTestsOnce) {
          await run("record_review", passReview("review-code"), h.ctx);
          await run(
            "record_review",
            {
              reviewer: "review-adversarial",
              verdict: "FAIL",
              findings: [{
                reviewer: "review-adversarial",
                severity: "HIGH",
                description: "walk-iterate-tests",
                status: "open",
              }],
            },
            h.ctx,
          );
          await run(
            "iterate_tests",
            { reason: "walk iterate tests", source: "auto" },
            h.ctx,
          );
          await run("review_tests", {}, h.ctx);
        }
        await run("record_review", passReview("review-code"), h.ctx);
        await run("record_review", passReview("review-adversarial"), h.ctx);
        await run("tests_approved", {}, h.ctx);

        // --- verification round(s) ---
        if (verifyFailsOnce) {
          await failVerification(h);
          await run(
            "iterate_verification",
            { reason: "walk verify fail", source: "auto" },
            h.ctx,
          );
        }
        await passVerification(h);

        // --- code review round(s) ---
        await run("review_code", {}, h.ctx);
        if (iterateCodeOnce) {
          await run("record_review", passReview("review-code"), h.ctx);
          await run(
            "record_review",
            {
              reviewer: "review-adversarial",
              verdict: "FAIL",
              findings: [{
                reviewer: "review-adversarial",
                severity: "CRITICAL",
                description: "walk-iterate-code",
                status: "open",
              }],
            },
            h.ctx,
          );
          await run(
            "iterate",
            { reason: "walk iterate code", source: "auto" },
            h.ctx,
          );
          // `iterate` lands back in `implementing`, so the walk must pass
          // through verification again — there is no other way to reach
          // `code_reviewing`.
          await passVerification(h);
          await run("review_code", {}, h.ctx);
        }
        await run("record_review", passReview("review-code"), h.ctx);
        await run("record_review", passReview("review-adversarial"), h.ctx);
        await run("resolve_findings", { resolutions: {} }, h.ctx);

        if (attest) {
          await run(
            "attest",
            {
              commitSha: "0".repeat(40),
              repoDir: "/repo",
              configPaths: [],
              producedBy: "walk",
            },
            h.ctx,
          );
        }
        if (harvest) {
          await run(
            "harvest",
            { uatProposals: [], kbProposals: [] },
            h.ctx,
          );
        }
        await run("complete", { summary: "" }, h.ctx);

        const s = h.getState()!;
        if (s.state !== "complete") return false;

        const planRounds = s.reviewHistory.filter((r) =>
          r.phase === "plan_review"
        );
        const testRounds = s.reviewHistory.filter((r) =>
          r.phase === "test_review"
        );
        const codeRounds = s.reviewHistory.filter((r) =>
          r.phase === "code_review"
        );
        const verifyRounds = s.reviewHistory.filter((r) =>
          r.phase === "verification"
        );
        return (
          planRounds.length === (rejectPlanOnce ? 2 : 1) &&
          testRounds.length === (iterateTestsOnce ? 2 : 1) &&
          codeRounds.length === (iterateCodeOnce ? 2 : 1) &&
          // Only a FAILED verification snapshots a round; a clean pass
          // flows straight into review_code.
          verifyRounds.length === (verifyFailsOnce ? 1 : 0) &&
          s.verification !== undefined &&
          (attest ? s.attestation !== undefined : true) &&
          (harvest ? s.harvest !== undefined : true)
        );
      },
    ),
    { numRuns: numRuns() },
  );
});

// ============================================================================
// P4 — hydrate never mutates `current` (IL-6 excluded via frozen time)
// ============================================================================

// A restricted-but-representative arbitrary over valid IssueState shapes:
// varies title/description/labels/state/priority/category/affectedAreas
// only. Every combination parses via IssueStateSchema regardless of `state`
// (the schema is purely structural — it does not cross-validate `state`
// against the presence of `plan`/`reviews`/etc.), which is exactly the
// domain hydrate's "no guard, works from anywhere" contract promises.
const validStateArb = fc.record({
  state: fc.constantFrom(...StateEnum.options),
  title: fc.string({ maxLength: 30 }),
  description: fc.string({ maxLength: 30 }),
  labels: fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }),
  affectedAreas: fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }),
  priority: fc.constantFrom("critical", "high", "medium", "low"),
  category: fc.constantFrom(
    "bug",
    "feature",
    "improvement",
    "refactor",
    "security",
  ),
});

Deno.test("P4: hydrate never mutates current (frozen clock excludes IL-6's snapshotAt from being a source of flakiness)", async () => {
  const time = new FakeTime("2026-07-31T12:00:00.000Z");
  try {
    await fc.assert(
      fc.asyncProperty(validStateArb, async (fields) => {
        const h = createHarness({
          ...fields,
          createdAt: FIXED_TS,
          updatedAt: FIXED_TS,
        });
        const before = JSON.stringify(h.getState());

        await run("hydrate", {}, h.ctx);

        const after = JSON.stringify(h.getState());
        if (after !== before) return false;

        const summary = h.getSummary();
        return summary !== null &&
          (summary as { state: string }).state === fields.state;
      }),
      { numRuns: numRuns() },
    );
  } finally {
    time.restore();
  }
});

// ============================================================================
// P5 — the approve_plan gate holds in both directions
// ============================================================================

// verdict is drawn INDEPENDENTLY of severity/status (unlike the pre-fix
// generator, which derived verdict solely from `findings.length > 0`) so the
// two gate dimensions — hasBlockingFindings and failingReviewers — are each
// exercised on their own and in combination.
const gatedReviewArb = fc.record({
  verdict: fc.constantFrom<"PASS" | "FAIL" | "SUGGEST_CHANGES">(
    "PASS",
    "FAIL",
    "SUGGEST_CHANGES",
  ),
  findings: fc.array(
    fc.record({
      severity: fc.constantFrom<Finding["severity"]>(
        "CRITICAL",
        "HIGH",
        "MEDIUM",
        "LOW",
      ),
      status: fc.constantFrom<Finding["status"]>(
        "open",
        "resolved",
        "accepted",
        "wontfix",
      ),
    }),
    { maxLength: 4 },
  ),
});

Deno.test("P5: approve_plan throws iff blocking findings exist OR any reviewer's verdict is FAIL (full matrix coverage always held constant)", async () => {
  await fc.assert(
    fc.asyncProperty(
      gatedReviewArb,
      gatedReviewArb,
      async (codeDraw, adversarialDraw) => {
        const h = createHarness();
        await run(
          "start",
          { title: "gate", description: "d", labels: [] },
          h.ctx,
        );
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
        await run("plan", defaultPlanArgs(), h.ctx);
        await run("review_plan", {}, h.ctx);

        const forReviewer = (
          owner: string,
          draw: typeof codeDraw,
        ): Finding[] =>
          draw.findings.map((d, i) => ({
            reviewer: owner,
            severity: d.severity,
            description: `f${i}`,
            status: d.status,
          }));

        const codeFindings = forReviewer("review-code", codeDraw);
        const adversarialFindings = forReviewer(
          "review-adversarial",
          adversarialDraw,
        );

        await run(
          "record_review",
          {
            reviewer: "review-code",
            verdict: codeDraw.verdict,
            findings: codeFindings,
          },
          h.ctx,
        );
        await run(
          "record_review",
          {
            reviewer: "review-adversarial",
            verdict: adversarialDraw.verdict,
            findings: adversarialFindings,
          },
          h.ctx,
        );

        const reviews: ReviewResult[] = [
          {
            reviewer: "review-code",
            verdict: codeDraw.verdict,
            findings: codeFindings,
            timestamp: FIXED_TS,
          },
          {
            reviewer: "review-adversarial",
            verdict: adversarialDraw.verdict,
            findings: adversarialFindings,
            timestamp: FIXED_TS,
          },
        ];
        const expectedBlocking = hasBlockingFindings(reviews).total;
        const expectedFailingVerdict = failingReviewers(reviews).length > 0;
        const expectThrow = expectedBlocking > 0 || expectedFailingVerdict;

        let threw = false;
        try {
          await run("approve_plan", {}, h.ctx);
        } catch {
          threw = true;
        }

        if (expectThrow) {
          return threw;
        }
        return !threw && h.getState()!.state === "approved";
      },
    ),
    { numRuns: numRuns() },
  );
});

// Sanity: assertEquals/assert are used only for a static shape check on the
// guard table so an accidental typo in a state name fails loudly at test
// load time rather than silently skipping every fc.pre() draw.
Deno.test("P1 fixture sanity: every GUARD_TABLE allowed state is a real StateEnum value", () => {
  const valid = new Set(StateEnum.options);
  for (const [method, cfg] of Object.entries(GUARD_TABLE)) {
    for (const s of cfg.allowed) {
      assert(
        valid.has(s as typeof StateEnum.options[number]),
        `${method}: '${s}' is not a StateEnum value`,
      );
    }
  }
  // Enumerated from the model rather than hardcoded: a new guarded method
  // must be added to GUARD_TABLE or P1 silently stops covering it. The three
  // exclusions are the methods with no state guard at all.
  const UNGUARDED = new Set(["start", "close", "hydrate"]);
  const guardedMethods = Object.keys(model.methods).filter(
    (m) => !UNGUARDED.has(m),
  ).sort();
  assertEquals(Object.keys(GUARD_TABLE).sort(), guardedMethods);
});
