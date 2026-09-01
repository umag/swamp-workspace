// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT

import { z } from "npm:zod@4";

// ============================================================================
// Schemas
// ============================================================================
//
// All Zod schemas in this module are tagged `@internal`. Their value types
// recursively reference symbols inside `npm:zod@4` that the package marks
// private (e.g. `ZodType`, `output`, `$ZodInternals`); this is intrinsic to
// Zod 4 and cannot be worked around without rewriting every schema as a
// hand-typed TypeScript interface, which would defeat the point of using
// Zod. The `@internal` tag keeps the schemas exported (the test file
// imports them) but excludes them from `deno doc --lint`'s public-API view.
//
// Consumers should depend on the public TypeScript types below
// (`IssueState`, `Finding`, …, `HydrateSummary`) and call the model's
// methods, not import the schemas directly.

/**
 * Issue category — what kind of work this issue represents.
 *
 * @internal
 */
export const CategoryEnum = z.enum([
  "bug",
  "feature",
  "improvement",
  "refactor",
  "security",
]);

/**
 * Triage confidence in the recorded classification.
 *
 * @internal
 */
export const ConfidenceEnum = z.enum(["high", "medium", "low"]);

/**
 * Bug-reproduction outcome captured during triage.
 *
 * @internal
 */
export const ReproducedSchema = z.object({
  status: z.enum(["reproduced", "could-not-reproduce", "not-applicable"]),
  notes: z.string().optional(),
});

/**
 * Optional richer triage record — confidence, reasoning, regression flag,
 * clarifying questions, reproduction outcome.
 *
 * @internal
 */
export const TriageDetailSchema = z.object({
  confidence: ConfidenceEnum.optional(),
  reasoning: z.string().optional(),
  isRegression: z.boolean().optional(),
  clarifyingQuestions: z.array(z.string()).default([]),
  reproduced: ReproducedSchema.optional(),
});

/**
 * One reviewer finding — severity, category, optional location, status.
 *
 * @internal
 */
export const FindingSchema = z.object({
  reviewer: z.string(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  category: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  description: z.string(),
  fix: z.string().optional(),
  status: z.enum(["open", "resolved", "accepted", "wontfix"]).default("open"),
});

/**
 * One reviewer's verdict + findings, captured in a review round.
 *
 * @internal
 */
export const ReviewResultSchema = z.object({
  reviewer: z.string(),
  verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
  findings: z.array(FindingSchema),
  timestamp: z.iso.datetime(),
});

/**
 * Which of the five reviewers run for this plan / iteration.
 *
 * @internal
 */
export const ReviewMatrixSchema = z.object({
  code: z.boolean().default(true),
  adversarial: z.boolean().default(true),
  security: z.boolean().default(false),
  ux: z.boolean().default(false),
  skill: z.boolean().default(false),
});

/**
 * Plan step — legacy bare strings OR new rich step objects. Union kept
 * for backward compatibility with older lifecycle records.
 *
 * @internal
 */
export const PlanStepSchema = z.union([
  z.string(),
  z.object({
    order: z.number().int().positive(),
    description: z.string(),
    files: z.array(z.string()).default([]),
    risks: z.string().optional(),
  }),
]);

/**
 * Implementation plan with DDD analysis, TDD strategy, review matrix.
 *
 * @internal
 */
export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(PlanStepSchema),
  dddAnalysis: z.string().describe(
    "DDD building blocks affected: aggregates, entities, value objects, services",
  ),
  testStrategy: z.string().describe(
    "TDD approach: what tests first, red-green-refactor sequence",
  ),
  reviewMatrix: ReviewMatrixSchema,
  potentialChallenges: z.array(z.string()).default([]),
  planVersion: z.number().int().positive().default(1),
});

/**
 * Reference to an existing UAT scenario discovered during prior-art lookup.
 *
 * @internal
 */
export const UatScenarioRefSchema = z.object({
  path: z.string(),
  summary: z.string(),
  reusable: z.boolean().default(true),
});

/**
 * Reference to an existing knowledge-base entry discovered during prior-art
 * lookup.
 *
 * @internal
 */
export const KbEntryRefSchema = z.object({
  path: z.string(),
  summary: z.string(),
});

/**
 * Prior-art bundle: existing UAT scenarios and KB entries known going into
 * the issue. Enables Phase 6 harvest to diff against new proposals.
 *
 * @internal
 */
export const PriorArtSchema = z.object({
  uatScenarios: z.array(UatScenarioRefSchema).default([]),
  kbEntries: z.array(KbEntryRefSchema).default([]),
  searchedAt: z.iso.datetime(),
});

/**
 * Proposed UAT scenario surfaced from this lifecycle's harvest phase.
 *
 * @internal
 */
export const UatProposalSchema = z.object({
  scenario: z.string(),
  rationale: z.string(),
  path: z.string().optional(),
  committed: z.boolean().default(false),
});

/**
 * Proposed knowledge-base entry surfaced from this lifecycle's harvest phase.
 *
 * @internal
 */
export const KbProposalSchema = z.object({
  kind: z.enum([
    "decision",
    "pattern",
    "anti-pattern",
    "runbook",
    "postmortem",
  ]),
  title: z.string(),
  body: z.string(),
  path: z.string().optional(),
  committed: z.boolean().default(false),
});

/**
 * Harvest output — UAT and KB proposals from this lifecycle.
 *
 * @internal
 */
export const HarvestSchema = z.object({
  uatProposals: z.array(UatProposalSchema).default([]),
  kbProposals: z.array(KbProposalSchema).default([]),
  harvestedAt: z.iso.datetime(),
});

/**
 * One mechanical verification control declared by the repository — the
 * lint/format/typecheck/test commands CI would otherwise re-execute.
 * Declared in `agent-constraints/verification-controls.md`, never hardcoded
 * in the model.
 *
 * `tier` records where the control is *allowed* to run: `local` controls are
 * cheap and run in the branch checkout; `managed` controls are reserved for
 * a higher-assurance runner (a swamp worker) and are recorded but not
 * executed locally.
 *
 * @internal
 */
export const ControlSpecSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  tier: z.enum(["local", "managed"]).default("local"),
  required: z.boolean().default(true),
});

/**
 * Outcome of executing one control.
 *
 * `status` deliberately separates `fail` (the control ran and rejected the
 * tree) from `error` (the control could not be executed at all — binary
 * missing, permission denied, spawn failure). Both block attestation. The
 * distinction exists because collapsing "the tool could not evaluate this"
 * into a benign skip is exactly how a quality gate reports success while
 * verifying nothing.
 *
 * @internal
 */
export const ControlResultSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  status: z.enum(["pass", "fail", "error", "skipped"]),
  exitCode: z.number().int().nullable().default(null),
  durationMs: z.number().int().nonnegative(),
  runner: z.string().min(1),
  required: z.boolean().default(true),
  stderrTail: z.string().default(""),
});

/**
 * One verification round: the controls that ran, where, and when.
 *
 * @internal
 */
export const VerificationSchema = z.object({
  controls: z.array(ControlResultSchema).default([]),
  runner: z.string().default("local"),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

/**
 * Per-reviewer summary embedded in an attestation — finding counts by
 * severity rather than the finding bodies, so the manifest stays small and
 * carries no source excerpts.
 *
 * @internal
 */
export const AttestedReviewSchema = z.object({
  reviewer: z.string(),
  verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});

/**
 * The attestation manifest — the structured evidence a verification
 * environment hands to CI so CI can *validate* rather than re-execute.
 *
 * `configChecksums` is the independently verifiable half: a validator
 * recomputes each digest from the checked-out tree and compares. Result
 * integrity (the `controls` array) is trusted to whoever ran the controls,
 * which is why `runner` is recorded on the manifest and on every control.
 *
 * @internal
 */
export const AttestationSchema = z.object({
  attestationVersion: z.literal(1),
  issue: z.string().min(1),
  commitSha: z.string().min(1),
  branch: z.string().optional(),
  planVersion: z.number().int().positive(),
  prUrl: z.string().optional(),
  configChecksums: z.record(z.string(), z.string()).default({}),
  controls: z.array(ControlResultSchema).default([]),
  reviews: z.array(AttestedReviewSchema).default([]),
  runner: z.string().min(1),
  producedAt: z.iso.datetime(),
  producedBy: z.string().default("unknown"),
  modelVersion: z.string().min(1),
});

/**
 * Compact summary written by `hydrate` for the autonomous loop. Lives in
 * its own `summary` resource (not `state`) so it has no shape overlap with
 * the main IssueStateSchema and mutation of one can never corrupt the other.
 *
 * @internal
 */
export const HydrateSummarySchema = z.object({
  state: z.string(),
  planVersion: z.number().int().nonnegative(),
  planIterationsThisVersion: z.number().int().nonnegative(),
  testReviewIteration: z.number().int().nonnegative(),
  codeReviewIteration: z.number().int().nonnegative(),
  verificationIteration: z.number().int().nonnegative(),
  controls: z.object({
    ran: z.boolean(),
    total: z.number().int().nonnegative(),
    blocking: z.array(z.string()),
  }),
  blocking: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  coverage: z.object({
    complete: z.boolean(),
    missing: z.array(z.string()),
  }),
  historyLength: z.number().int().nonnegative(),
  signature: z.string(),
  snapshotAt: z.iso.datetime(),
});

/**
 * Issue lifecycle state — every state in the state machine.
 *
 * @internal
 */
export const StateEnum = z.enum([
  "filed",
  "triaged",
  "planned",
  "reviewing",
  "approved",
  "writing_tests",
  "reviewing_tests",
  "implementing",
  "verifying",
  "code_reviewing",
  "resolved",
  "attested",
  "harvested",
  "complete",
  "closed",
]);

/**
 * Append-only audit entry capturing one completed review round.
 *
 * @internal
 */
export const ReviewRoundSchema = z.object({
  phase: z.enum([
    "plan_review",
    "test_review",
    "verification",
    "code_review",
  ]),
  planVersion: z.number().int().positive(),
  iteration: z.number().int().positive(),
  reviews: z.array(ReviewResultSchema),
  outcome: z.enum([
    "clean",
    "rejected_auto",
    "rejected_human",
    "cap_reached",
    "loop_detected",
    "pivot_required",
    "human_override",
  ]),
  rejectReason: z.string().optional(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
});

/**
 * The Issue aggregate root — full lifecycle state stored under
 * `state.current`.
 *
 * @internal
 */
export const IssueStateSchema = z.object({
  state: StateEnum,
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()).default([]),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  category: CategoryEnum.optional(),
  affectedAreas: z.array(z.string()).default([]),
  triageDetail: TriageDetailSchema.optional(),
  priorArt: PriorArtSchema.optional(),
  plan: PlanSchema.optional(),
  reviews: z.array(ReviewResultSchema).default([]),
  reviewHistory: z.array(ReviewRoundSchema).default([]),
  planVersion: z.number().int().positive().default(1),
  testReviewIteration: z.number().int().positive().default(1),
  codeReviewIteration: z.number().int().positive().default(1),
  verificationIteration: z.number().int().positive().default(1),
  branch: z.string().optional(),
  verification: VerificationSchema.optional(),
  attestation: AttestationSchema.optional(),
  resolutions: z.record(z.string(), z.string()).default({}),
  harvest: HarvestSchema.optional(),
  closedReason: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reviewRoundStartedAt: z.iso.datetime().optional(),
});

// ============================================================================
// Public TypeScript types — these are the shapes consumers should depend on
// ============================================================================
//
// Hand-written interfaces rather than `z.infer<typeof Schema>`: the latter
// resolves through Zod's internal `output` type which `deno doc --lint`
// flags as private. Keeping them in lockstep with the schemas above is a
// minor maintenance cost paid for a public, properly-documented API.

/** Issue category. */
export type Category =
  | "bug"
  | "feature"
  | "improvement"
  | "refactor"
  | "security";

/** Triage confidence. */
export type Confidence = "high" | "medium" | "low";

/** Issue priority assigned at triage. */
export type Priority = "critical" | "high" | "medium" | "low";

/** Reproduction outcome captured during triage. */
export type ReproducedStatus =
  | "reproduced"
  | "could-not-reproduce"
  | "not-applicable";

/** Bug-reproduction record. */
export interface Reproduced {
  /** Did we reproduce, fail to reproduce, or skip? */
  status: ReproducedStatus;
  /** Optional notes (env, steps, observations). */
  notes?: string;
}

/** Optional richer triage detail. */
export interface TriageDetail {
  /** Confidence in the classification. */
  confidence?: Confidence;
  /** Free-form reasoning behind the classification. */
  reasoning?: string;
  /** True if the issue is a regression of previously-working behavior. */
  isRegression?: boolean;
  /** Open clarifying questions for the human. */
  clarifyingQuestions: string[];
  /** Reproduction outcome (bugs only). */
  reproduced?: Reproduced;
}

/** Finding severity. */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Finding lifecycle status. */
export type FindingStatus = "open" | "resolved" | "accepted" | "wontfix";

/** One reviewer finding. */
export interface Finding {
  /** Reviewer skill name (e.g. `review-code`). */
  reviewer: string;
  /** Finding severity (drives the autonomous-loop blocking gate). */
  severity: Severity;
  /** Optional category tag for grouping. */
  category?: string;
  /** Optional source-file path the finding refers to. */
  file?: string;
  /** Optional line number within `file`. */
  line?: number;
  /** Free-form description of the issue. */
  description: string;
  /** Optional suggested fix. */
  fix?: string;
  /** Lifecycle status. */
  status: FindingStatus;
}

/** Review verdict. */
export type Verdict = "PASS" | "FAIL" | "SUGGEST_CHANGES";

/** One reviewer's recorded verdict + findings. */
export interface ReviewResult {
  /** Reviewer skill name. */
  reviewer: string;
  /** Reviewer's overall verdict. */
  verdict: Verdict;
  /** Findings (may be empty for PASS). */
  findings: Finding[];
  /** ISO-8601 timestamp the review was recorded. */
  timestamp: string;
}

/** Which reviewers run for a given plan / iteration. */
export interface ReviewMatrix {
  /** General code review (default true). */
  code: boolean;
  /** Adversarial review (default true). */
  adversarial: boolean;
  /** Security review (default false; opt in for risky changes). */
  security: boolean;
  /** UX review (default false; opt in for CLI / surface changes). */
  ux: boolean;
  /** Skill review (default false; opt in when a SKILL.md is touched). */
  skill: boolean;
}

/** Rich plan step. Legacy bare-string steps are still accepted via `PlanStep`. */
export interface PlanStepObject {
  /** Sequential 1-based step order. */
  order: number;
  /** What the step does. */
  description: string;
  /** Files this step touches. */
  files: string[];
  /** Optional risks the step carries. */
  risks?: string;
}

/** A plan step — bare string OR rich object (backward-compat union). */
export type PlanStep = string | PlanStepObject;

/** Implementation plan with DDD analysis, TDD strategy, and review matrix. */
export interface Plan {
  /** One-paragraph plan summary. */
  summary: string;
  /** Ordered steps. */
  steps: PlanStep[];
  /** Which DDD building blocks the plan affects. */
  dddAnalysis: string;
  /** Red-green-refactor sequence and what to test first. */
  testStrategy: string;
  /** Review matrix that gates approval. */
  reviewMatrix: ReviewMatrix;
  /** Risks and unknowns the plan acknowledges. */
  potentialChallenges: string[];
  /** Plan version (bumps on every successful `plan` call). */
  planVersion: number;
}

/** Reference to an existing UAT scenario. */
export interface UatScenarioRef {
  /** Filesystem path to the scenario. */
  path: string;
  /** One-line description. */
  summary: string;
  /** Whether this scenario should be reused as-is or replaced. */
  reusable: boolean;
}

/** Reference to an existing knowledge-base entry. */
export interface KbEntryRef {
  /** Filesystem path to the entry. */
  path: string;
  /** One-line description. */
  summary: string;
}

/** Prior-art bundle: what was known going in. */
export interface PriorArt {
  /** Existing UAT scenarios. */
  uatScenarios: UatScenarioRef[];
  /** Existing KB entries. */
  kbEntries: KbEntryRef[];
  /** ISO-8601 timestamp of the lookup. */
  searchedAt: string;
}

/** Proposed UAT scenario from this lifecycle's harvest. */
export interface UatProposal {
  /** Scenario description. */
  scenario: string;
  /** Why this scenario should be added. */
  rationale: string;
  /** Optional intended path on disk. */
  path?: string;
  /** Whether the proposal has been written to disk. */
  committed: boolean;
}

/** Knowledge-base entry kind. */
export type KbKind =
  | "decision"
  | "pattern"
  | "anti-pattern"
  | "runbook"
  | "postmortem";

/** Proposed knowledge-base entry from this lifecycle's harvest. */
export interface KbProposal {
  /** Entry kind (decision, pattern, …). */
  kind: KbKind;
  /** Entry title. */
  title: string;
  /** Entry body (markdown). */
  body: string;
  /** Optional intended path on disk. */
  path?: string;
  /** Whether the proposal has been written to disk. */
  committed: boolean;
}

/** Harvest bundle — UAT and KB proposals at lifecycle end. */
export interface Harvest {
  /** Proposed UAT scenarios. */
  uatProposals: UatProposal[];
  /** Proposed KB entries. */
  kbProposals: KbProposal[];
  /** ISO-8601 timestamp of the harvest. */
  harvestedAt: string;
}

/** Issue lifecycle state. */
export type State =
  | "filed"
  | "triaged"
  | "planned"
  | "reviewing"
  | "approved"
  | "writing_tests"
  | "reviewing_tests"
  | "implementing"
  | "verifying"
  | "code_reviewing"
  | "resolved"
  | "attested"
  | "harvested"
  | "complete"
  | "closed";

/** Review round phase. */
export type ReviewPhase =
  | "plan_review"
  | "test_review"
  | "verification"
  | "code_review";

/** Review round outcome. */
export type ReviewOutcome =
  | "clean"
  | "rejected_auto"
  | "rejected_human"
  | "cap_reached"
  | "loop_detected"
  | "pivot_required"
  | "human_override";

/** Append-only audit entry for one completed review round. */
export interface ReviewRound {
  /** Plan-review or code-review phase. */
  phase: ReviewPhase;
  /** Plan version at the time of the round. */
  planVersion: number;
  /** Iteration number within the phase. */
  iteration: number;
  /** Per-reviewer results recorded during the round. */
  reviews: ReviewResult[];
  /** Round outcome (clean, rejected, loop-detected, etc.). */
  outcome: ReviewOutcome;
  /** Free-form reason if the round was rejected or aborted. */
  rejectReason?: string;
  /** ISO-8601 timestamp the round started. */
  startedAt: string;
  /** ISO-8601 timestamp the round ended. */
  completedAt: string;
}

/** Counts of blocking findings (CRITICAL + HIGH). */
export interface BlockingCounts {
  /** Open CRITICAL findings. */
  critical: number;
  /** Open HIGH findings. */
  high: number;
  /** Sum of CRITICAL + HIGH. */
  total: number;
}

/** Coverage check for the plan's review matrix. */
export interface MatrixCoverage {
  /** True if every reviewer in the matrix has recorded a result. */
  complete: boolean;
  /** Names of reviewers (e.g. `review-code`) still missing. */
  missing: string[];
}

/** Where a control is allowed to run. */
export type ControlTier = "local" | "managed";

/** Outcome of executing one control. */
export type ControlStatus = "pass" | "fail" | "error" | "skipped";

/** One mechanical verification control declared by the repository. */
export interface ControlSpec {
  /** Short control name, e.g. `fmt`. */
  name: string;
  /** Executable to spawn. */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Working directory, relative to the repo root. */
  cwd: string;
  /** Whether this control may run locally or needs a managed runner. */
  tier: ControlTier;
  /** Required controls must pass before `attest` will emit a manifest. */
  required: boolean;
}

/** Result of executing one control. */
export interface ControlResult {
  /** Short control name. */
  name: string;
  /** The command line as executed. */
  command: string;
  /** pass, fail (ran and rejected), error (could not run), or skipped. */
  status: ControlStatus;
  /** Process exit code, or null when the process never started. */
  exitCode: number | null;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Identifier of the environment that ran the control. */
  runner: string;
  /** Whether this control blocks attestation. */
  required: boolean;
  /** Tail of stderr, truncated, for in-context failure diagnosis. */
  stderrTail: string;
}

/** One verification round. */
export interface Verification {
  /** Per-control results for the round. */
  controls: ControlResult[];
  /** Identifier of the environment that ran the round. */
  runner: string;
  /** ISO-8601 timestamp the round started. */
  startedAt: string;
  /** ISO-8601 timestamp the round ended. */
  completedAt?: string;
}

/** Per-reviewer summary embedded in an attestation. */
export interface AttestedReview {
  /** Reviewer name, e.g. `review-security`. */
  reviewer: string;
  /** The reviewer's verdict. */
  verdict: Verdict;
  /** Open CRITICAL findings at attestation time. */
  critical: number;
  /** Open HIGH findings at attestation time. */
  high: number;
  /** Open MEDIUM findings at attestation time. */
  medium: number;
  /** Open LOW findings at attestation time. */
  low: number;
}

/** Structured evidence handed to CI in place of re-execution. */
export interface Attestation {
  /** Manifest schema version. */
  attestationVersion: 1;
  /** Issue / lifecycle instance name. */
  issue: string;
  /** Commit the verification ran against. */
  commitSha: string;
  /** Branch carrying the work. */
  branch?: string;
  /** Plan version the work implements. */
  planVersion: number;
  /** Pull request URL, once opened. */
  prUrl?: string;
  /** Path → SHA-256 digest for every config input to the verification. */
  configChecksums: Record<string, string>;
  /** Control results backing the manifest. */
  controls: ControlResult[];
  /** Per-reviewer finding summary. */
  reviews: AttestedReview[];
  /** Identifier of the environment that produced the manifest. */
  runner: string;
  /** ISO-8601 timestamp the manifest was produced. */
  producedAt: string;
  /** Hostname or worker id that produced the manifest. */
  producedBy: string;
  /** Model version that produced the manifest. */
  modelVersion: string;
}

/** Compact summary written by `hydrate`. */
export interface HydrateSummary {
  /** Current lifecycle state. */
  state: string;
  /** Current plan version. */
  planVersion: number;
  /** Plan iterations recorded for the current plan version. */
  planIterationsThisVersion: number;
  /** Test-review iteration cursor. */
  testReviewIteration: number;
  /** Code-review iteration cursor. */
  codeReviewIteration: number;
  /** Verification iteration cursor. */
  verificationIteration: number;
  /** Verification control status for the latest round. */
  controls: {
    /** True once `verify` has run at least once. */
    ran: boolean;
    /** Number of controls in the latest round. */
    total: number;
    /** Names of required controls that did not pass. */
    blocking: string[];
  };
  /** Open blocking-finding counts. */
  blocking: BlockingCounts;
  /** Review-matrix coverage for the current round. */
  coverage: MatrixCoverage;
  /** Cumulative review-round history length. */
  historyLength: number;
  /** Stable signature over the open blocking findings (for loop detection). */
  signature: string;
  /** ISO-8601 timestamp of the snapshot. */
  snapshotAt: string;
}

/** The Issue aggregate root — full lifecycle state. */
export interface IssueState {
  /** Current state in the lifecycle state machine. */
  state: State;
  /** Issue title. */
  title: string;
  /** Issue body / description. */
  description: string;
  /** Labels attached to the issue. */
  labels: string[];
  /** Priority assigned at triage. */
  priority?: Priority;
  /** Category assigned at triage. */
  category?: Category;
  /** Affected areas (subsystems, modules, components). */
  affectedAreas: string[];
  /** Optional richer triage record. */
  triageDetail?: TriageDetail;
  /** Optional prior-art bundle from before planning. */
  priorArt?: PriorArt;
  /** Implementation plan; unset until `plan` runs. */
  plan?: Plan;
  /** Reviewer results for the current review round. */
  reviews: ReviewResult[];
  /** Append-only history of completed review rounds. */
  reviewHistory: ReviewRound[];
  /** Plan version (bumps on every `plan` call). */
  planVersion: number;
  /** Test-review iteration cursor (bumps on every `iterate_tests`). */
  testReviewIteration: number;
  /** Code-review iteration cursor (bumps on every `iterate`). */
  codeReviewIteration: number;
  /** Verification iteration cursor (bumps on every `iterate_verification`). */
  verificationIteration: number;
  /** Optional implementation branch name. */
  branch?: string;
  /** Latest verification round; unset until `verify` runs. */
  verification?: Verification;
  /** Attestation manifest; unset until `attest` runs. */
  attestation?: Attestation;
  /** Map of finding-description → resolution-action. */
  resolutions: Record<string, string>;
  /** Optional harvest bundle from Phase 6. */
  harvest?: Harvest;
  /** Reason recorded if the issue was abandoned via `close`. */
  closedReason?: string;
  /** ISO-8601 timestamp set when the issue completes. */
  completedAt?: string;
  /** ISO-8601 timestamp the issue was filed. */
  createdAt: string;
  /** ISO-8601 timestamp of the last mutation. */
  updatedAt: string;
  /** ISO-8601 timestamp the current review round started. */
  reviewRoundStartedAt?: string;
}

// ============================================================================
// Helpers (exported for tests)
// ============================================================================

/** Current ISO-8601 timestamp string. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * State-machine guard. Throws with a useful message naming the current
 * state, the expected state(s), and the method being called.
 *
 * @param current   The lifecycle's current state.
 * @param expected  Allowed source state, or list of allowed states.
 * @param method    Method name for the error message.
 */
export function guardState(
  current: string,
  expected: string | string[],
  method: string,
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(current)) {
    throw new Error(
      `Cannot call '${method}' in state '${current}'. Expected: ${
        allowed.join(", ")
      }`,
    );
  }
}

/**
 * Count open CRITICAL and HIGH findings in a set of reviews.
 * Replaces the old CRITICAL-only check. Used by approve_plan and the
 * autonomous loop's exit condition.
 */
export function hasBlockingFindings(
  reviews: ReviewResult[],
): { critical: number; high: number; total: number } {
  let critical = 0;
  let high = 0;
  for (const r of reviews) {
    for (const f of r.findings) {
      if (f.status !== "open") continue;
      if (f.severity === "CRITICAL") critical++;
      else if (f.severity === "HIGH") high++;
    }
  }
  return { critical, high, total: critical + high };
}

/**
 * List reviewers whose recorded verdict in the current round is `FAIL`.
 * `hasBlockingFindings` only inspects `findings` — a reviewer can post
 * `verdict: "FAIL"` with zero findings (or findings that are all
 * non-open/non-blocking) and it would sail through undetected. Used by
 * `approve_plan` and `tests_approved` alongside `hasBlockingFindings` so a
 * FAIL verdict always blocks approval regardless of what findings (if any)
 * accompany it (IL-2). Since `record_review` now keeps at most one entry per
 * reviewer per round, the result is already de-duplicated by reviewer.
 */
export function failingReviewers(reviews: ReviewResult[]): string[] {
  return reviews.filter((r) => r.verdict === "FAIL").map((r) => r.reviewer);
}

/**
 * Verify every reviewer in the matrix has recorded a result.
 * Matrix entry `security: true` requires a review from `review-security`.
 * Used by approve_plan to enforce full coverage before approval.
 */
export function allMatrixReviewersRecorded(
  reviews: ReviewResult[],
  matrix: ReviewMatrix,
): { complete: boolean; missing: string[] } {
  const expected = Object.entries(matrix)
    .filter(([_, on]) => on)
    .map(([name]) => `review-${name}`);
  const recorded = new Set(reviews.map((r) => r.reviewer));
  const missing = expected.filter((r) => !recorded.has(r));
  return { complete: missing.length === 0, missing };
}

/**
 * Stable signature over the set of open CRITICAL/HIGH findings in the current
 * round. Used by the autonomous loop's loop-detection safeguard: if two
 * successive iterations produce the same signature, the skill bails out to
 * prevent infinite spinning. Sorted + truncated to 60 chars so minor textual
 * edits don't mask a loop.
 */
export function findingSignature(reviews: ReviewResult[]): string {
  const items: string[] = [];
  for (const r of reviews) {
    for (const f of r.findings) {
      if (f.status !== "open") continue;
      if (f.severity !== "CRITICAL" && f.severity !== "HIGH") continue;
      const category = f.category ?? f.reviewer;
      items.push(
        `${f.severity}|${category}|${f.description.slice(0, 60)}`,
      );
    }
  }
  items.sort();
  return items.join("\n");
}

/**
 * Capture the current review round as an append-only history entry before
 * resetting `reviews` for the next round.
 */
export function snapshotReviewRound(
  data: IssueState,
  phase: ReviewPhase,
  outcome: ReviewRound["outcome"],
  rejectReason: string | undefined,
  startedAt: string,
): ReviewRound {
  let iteration: number;
  if (phase === "plan_review") {
    iteration = data.reviewHistory.filter(
      (r) => r.phase === "plan_review" && r.planVersion === data.planVersion,
    ).length + 1;
  } else if (phase === "test_review") {
    iteration = data.testReviewIteration;
  } else if (phase === "verification") {
    iteration = data.verificationIteration;
  } else {
    iteration = data.codeReviewIteration;
  }
  return {
    phase,
    planVersion: data.planVersion,
    iteration,
    reviews: data.reviews,
    outcome,
    rejectReason,
    startedAt,
    completedAt: now(),
  };
}

/**
 * Expand a `description -> action` resolutions map into per-reviewer
 * composite keys before merging into the cumulative `resolutions` record
 * (IL-4). `resolutions` is a flat `Record<string, string>` keyed by finding
 * description text; two different reviewers whose findings happen to share
 * description text used to collapse into a single entry. For every
 * current-round finding whose `description` matches a supplied key, this
 * rewrites the key to `` `${reviewer} :: ${description}` `` — one entry per
 * matching reviewer. A key that matches no current-round finding is kept
 * verbatim (legacy-safe: callers passing hand-written keys unrelated to a
 * specific finding still work).
 */
function expandResolutionKeys(
  resolutions: Record<string, string>,
  reviews: ReviewResult[],
): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [description, action] of Object.entries(resolutions)) {
    const reviewers = new Set<string>();
    for (const r of reviews) {
      for (const f of r.findings) {
        if (f.description === description) reviewers.add(f.reviewer);
      }
    }
    if (reviewers.size === 0) {
      expanded[description] = action;
    } else {
      for (const reviewer of reviewers) {
        expanded[`${reviewer} :: ${description}`] = action;
      }
    }
  }
  return expanded;
}

// ============================================================================
// Verification: subprocess + checksum helpers
// ============================================================================
//
// This is the only I/O in the module. Every function that spawns a process
// or reads a file takes its effect as an explicit first parameter, so the
// whole verification path is unit-testable without spawning anything and
// the compiler proves no un-injected call survives.

/** Raw result of running one subprocess. */
export interface RunResult {
  /** Process exit code, or null if it never started. */
  code: number | null;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
}

/**
 * Injectable process runner. Production code passes {@link defaultRunner};
 * tests pass a scripted fake that records calls and answers from a table.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<RunResult>;

/** Injectable file reader, for checksum computation. */
export type FileReader = (path: string) => Promise<Uint8Array>;

/**
 * Sentinel thrown when the runtime denies `allow-run`. The verification
 * path must fail closed with a named error rather than reporting a control
 * it never executed as anything other than a failure.
 */
export const RUN_PERMISSION_ERROR =
  "allow-run is not granted to this model — verification controls cannot be " +
  "executed. Refusing to report an unverified tree as verified.";

/** Default runner: spawns the command with `Deno.Command`. */
export const defaultRunner: CommandRunner = async (command, args, cwd) => {
  try {
    const output = await new Deno.Command(command, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: output.code,
      stdout: dec.decode(output.stdout),
      stderr: dec.decode(output.stderr),
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotCapable) {
      throw new Error(RUN_PERMISSION_ERROR, { cause: err });
    }
    return {
      code: null,
      stdout: "",
      stderr: "",
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }
};

/** Default file reader. */
export const defaultFileReader: FileReader = (path) => Deno.readFile(path);

/** How much stderr to retain per control, in characters. */
export const STDERR_TAIL_LIMIT = 2000;

/**
 * Keep only the tail of a control's stderr. Failure output is read by an
 * agent in-context to drive the fix, so the last lines (where the summary
 * lives) matter more than the first.
 */
export function stderrTail(
  stderr: string,
  limit: number = STDERR_TAIL_LIMIT,
): string {
  if (stderr.length <= limit) return stderr;
  return stderr.slice(stderr.length - limit);
}

/**
 * Execute one control and classify the outcome.
 *
 * A control that could not be spawned is `error`, never `skipped` — the
 * caller must not be able to mistake "did not run" for "nothing to check".
 * A `managed`-tier control is `skipped` when the current runner is local;
 * `attest` treats a skipped required control as blocking.
 */
export async function runControl(
  run: CommandRunner,
  spec: ControlSpec,
  repoDir: string,
  runner: string,
): Promise<ControlResult> {
  const commandLine = [spec.command, ...spec.args].join(" ");
  const base = {
    name: spec.name,
    command: commandLine,
    runner,
    required: spec.required,
  };

  if (spec.tier === "managed" && runner === "local") {
    return {
      ...base,
      status: "skipped" as const,
      exitCode: null,
      durationMs: 0,
      stderrTail:
        `control '${spec.name}' is tier=managed and the current runner is ` +
        `'local' — it was not executed`,
    };
  }

  const cwd = joinRepoPath(repoDir, spec.cwd);
  const startedAt = Date.now();
  const result = await run(spec.command, spec.args, cwd);
  const durationMs = Date.now() - startedAt;

  if (result.spawnError !== undefined) {
    return {
      ...base,
      status: "error" as const,
      exitCode: null,
      durationMs,
      stderrTail: stderrTail(result.spawnError),
    };
  }

  return {
    ...base,
    status: result.code === 0 ? ("pass" as const) : ("fail" as const),
    exitCode: result.code,
    durationMs,
    stderrTail: stderrTail(result.stderr || result.stdout),
  };
}

/**
 * Run every declared control in one pass, in declaration order.
 *
 * Fan-out rather than a caller-side loop: one method call acquires the
 * model lock once and produces the whole round, instead of N calls
 * contending on it.
 *
 * Controls run sequentially on purpose — they share a working tree and a
 * Deno cache, and a parallel `fmt` and `test` can race on generated files.
 * A control that throws the allow-run sentinel aborts the round rather than
 * being swallowed into a partial result.
 */
export async function runControls(
  run: CommandRunner,
  specs: ControlSpec[],
  repoDir: string,
  runner: string,
): Promise<ControlResult[]> {
  const results: ControlResult[] = [];
  for (const spec of specs) {
    results.push(await runControl(run, spec, repoDir, runner));
  }
  return results;
}

/**
 * Join a control's declared `cwd` onto the repo root, rejecting anything
 * that escapes it. Control specs come from a repo file that an agent edits,
 * so the path is treated as untrusted input.
 */
export function joinRepoPath(repoDir: string, relative: string): string {
  if (relative === "" || relative === ".") return repoDir;
  if (relative.startsWith("/")) {
    throw new Error(
      `Control cwd must be relative to the repo root, got absolute '${relative}'`,
    );
  }
  const segments = relative.split("/").filter((p) => p !== "" && p !== ".");
  if (segments.includes("..")) {
    throw new Error(
      `Control cwd must stay inside the repo, got '${relative}'`,
    );
  }
  return `${repoDir.replace(/\/$/, "")}/${segments.join("/")}`;
}

/**
 * Controls that block attestation: any required control that did not pass.
 * `error` and `skipped` block exactly as `fail` does.
 */
export function blockingControls(controls: ControlResult[]): ControlResult[] {
  return controls.filter((c) => c.required && c.status !== "pass");
}

/** Lowercase hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute `path → sha256` for every config input to the verification, so a
 * validator can recompute them from a checked-out tree and prove the same
 * review prompts, constraints and task definitions were in force.
 *
 * Paths are repo-relative and the result is key-sorted, so the manifest is
 * byte-stable across machines. A path that cannot be read is recorded as
 * `MISSING` rather than omitted — a silently absent entry would let a
 * deleted constraints file pass validation.
 */
export async function computeChecksums(
  readFile: FileReader,
  repoDir: string,
  paths: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of [...paths].sort()) {
    try {
      out[rel] = await sha256Hex(
        await readFile(joinRepoPath(repoDir, rel)),
      );
    } catch {
      out[rel] = "MISSING";
    }
  }
  return out;
}

/**
 * Collapse the current round's reviews into per-reviewer severity counts for
 * the attestation manifest. Only open findings are counted — a resolved
 * finding is not evidence of an unverified tree.
 */
export function summarizeReviews(reviews: ReviewResult[]): AttestedReview[] {
  return reviews.map((r) => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of r.findings) {
      if (f.status !== "open") continue;
      if (f.severity === "CRITICAL") counts.critical++;
      else if (f.severity === "HIGH") counts.high++;
      else if (f.severity === "MEDIUM") counts.medium++;
      else counts.low++;
    }
    return { reviewer: r.reviewer, verdict: r.verdict, ...counts };
  });
}

// ============================================================================
// Model
// ============================================================================

type LoggerCtx = {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
};

type ReadWriteCtx = LoggerCtx & {
  readResource:
    | ((name: string) => Promise<Record<string, unknown> | null>)
    | undefined;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

type DefinitionCtx = ReadWriteCtx & { definition: { name: string } };

async function readState(
  context: ReadWriteCtx,
): Promise<IssueState | null> {
  const raw = await context.readResource!("current");
  if (!raw) return null;
  // Parse through the schema so defaults fill in for legacy instances.
  // The hand-written `IssueState` interface above is kept structurally
  // identical to the schema's parse output. Drift between them would
  // surface as a `deno check` failure at this cast.
  return IssueStateSchema.parse(raw) as IssueState;
}

/**
 * `verify` implementation with the process runner injected, so the whole
 * verification path is testable without spawning anything. The method
 * wrapper passes {@link defaultRunner}.
 */
export async function verifyImpl(
  run: CommandRunner,
  args: { controls: ControlSpec[]; repoDir: string; runner: string },
  context: ReadWriteCtx,
): Promise<{ dataHandles: unknown[] }> {
  const data = await readState(context);
  if (!data) throw new Error("No issue state found — run 'start' first");
  guardState(data.state, "implementing", "verify");

  const startedAt = now();
  context.logger.info(
    "Verification round {iter}: running {count} control(s) on {runner}",
    {
      iter: data.verificationIteration,
      count: args.controls.length,
      runner: args.runner,
    },
  );

  const controls = await runControls(
    run,
    args.controls,
    args.repoDir,
    args.runner,
  );

  const blocking = blockingControls(controls);
  for (const c of controls) {
    context.logger.info(
      "  {status} {name} ({ms}ms) — {command}",
      {
        status: c.status.toUpperCase(),
        name: c.name,
        ms: c.durationMs,
        command: c.command,
      },
    );
  }

  const handle = await context.writeResource("state", "current", {
    ...data,
    state: "verifying",
    verification: {
      controls,
      runner: args.runner,
      startedAt,
      completedAt: now(),
    },
    reviewRoundStartedAt: startedAt,
    updatedAt: now(),
  });

  if (blocking.length > 0) {
    context.logger.info(
      "{count} required control(s) did not pass: {names} — fix them in " +
        "context, then call iterate_verification and verify again",
      {
        count: blocking.length,
        names: blocking.map((c) => `${c.name}(${c.status})`).join(", "),
      },
    );
  } else {
    context.logger.info(
      "All required controls passed — call review_code to enter the " +
        "review fan-out",
    );
  }

  return { dataHandles: [handle] };
}

/**
 * `attest` implementation with the file reader injected, so checksum
 * computation is testable without touching the filesystem. The method
 * wrapper passes {@link defaultFileReader}.
 */
export async function attestImpl(
  readFile: FileReader,
  args: {
    commitSha: string;
    repoDir: string;
    configPaths: string[];
    prUrl?: string;
    producedBy: string;
  },
  context: ReadWriteCtx,
): Promise<{ dataHandles: unknown[] }> {
  const data = await readState(context);
  if (!data) throw new Error("No issue state found — run 'start' first");
  guardState(data.state, "resolved", "attest");

  // --- Gates. Every one of these fails closed: no manifest is written
  // --- unless the tree actually cleared the bar it claims to attest.
  const verification = data.verification;
  if (!verification) {
    throw new Error(
      "Cannot attest: no verification round recorded. Run 'verify' " +
        "before attesting — an attestation with no controls behind it " +
        "is worse than none.",
    );
  }

  const blocked = blockingControls(verification.controls);
  if (blocked.length > 0) {
    throw new Error(
      `Cannot attest: ${blocked.length} required control(s) did not ` +
        `pass: ${
          blocked.map((c) => `${c.name}(${c.status})`).join(", ")
        }. Fix them and re-run verify.`,
    );
  }

  const blocking = hasBlockingFindings(data.reviews);
  if (blocking.total > 0) {
    throw new Error(
      `Cannot attest: ${blocking.critical} CRITICAL and ` +
        `${blocking.high} HIGH findings still open.`,
    );
  }

  const failing = failingReviewers(data.reviews);
  if (failing.length > 0) {
    throw new Error(
      `Cannot attest: reviewer(s) ${
        failing.join(", ")
      } recorded a FAIL verdict.`,
    );
  }

  const configChecksums = await computeChecksums(
    readFile,
    args.repoDir,
    args.configPaths,
  );
  const missing = Object.entries(configChecksums)
    .filter(([, digest]) => digest === "MISSING")
    .map(([path]) => path);
  if (missing.length > 0) {
    throw new Error(
      `Cannot attest: ${missing.length} config path(s) could not be ` +
        `read: ${
          missing.join(", ")
        }. A manifest that silently omits a config input cannot prove ` +
        `which prompts and constraints were in force.`,
    );
  }

  const attestation = {
    attestationVersion: 1 as const,
    issue: data.title,
    commitSha: args.commitSha,
    branch: data.branch,
    planVersion: data.planVersion,
    prUrl: args.prUrl,
    configChecksums,
    controls: verification.controls,
    reviews: summarizeReviews(data.reviews),
    runner: verification.runner,
    producedAt: now(),
    producedBy: args.producedBy,
    modelVersion: MODEL_VERSION,
  };

  context.logger.info(
    "Attesting {commit} — {controls} control(s), {configs} config " +
      "checksum(s), {reviews} reviewer(s), runner {runner}",
    {
      commit: args.commitSha.slice(0, 12),
      controls: attestation.controls.length,
      configs: Object.keys(configChecksums).length,
      reviews: attestation.reviews.length,
      runner: attestation.runner,
    },
  );

  const attestationHandle = await context.writeResource(
    "attestation",
    args.commitSha,
    attestation,
  );
  const stateHandle = await context.writeResource("state", "current", {
    ...data,
    state: "attested",
    attestation,
    updatedAt: now(),
  });

  context.logger.info(
    "Attested — commit the manifest to the branch, then open the PR",
  );
  return { dataHandles: [stateHandle, attestationHandle] };
}

/**
 * Model version, stamped into every attestation manifest so a validator can
 * tell which model produced it.
 *
 * Deliberately a SEPARATE literal from `model.version` below rather than the
 * single source of truth for it. `scripts/quality/check_upgrade_chain.ts` —
 * and swamp's own push-time validator — require `version:` to be a plain
 * double-quoted string on the declaration; `version: MODEL_VERSION` reads as
 * "no depth-1 version key" to both and silently skips the chain-terminus
 * check. `issue_lifecycle_docs.test.ts` pins the two equal instead.
 */
export const MODEL_VERSION = "2026.08.31.1";

/**
 * Internal model object — its value type recursively references Zod
 * internals that are private at the JSR-publish level. Consumers should
 * depend on the public types and helpers above and call methods via
 * swamp's CLI or `swamp model method run`, not import this object.
 *
 * @internal
 */
export const model = {
  type: "@magistr/issue-lifecycle",
  version: "2026.08.31.1",
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.02.1",
      description:
        "Latent-bug fixes IL-1 (guard start against overwriting an " +
        "in-flight issue; force opt-out), IL-2 (approve_plan/tests_approved " +
        "now block on a FAIL reviewer verdict), IL-4 (resolutions keyed " +
        "per-reviewer), IL-7 (record_review reviewer dedup). No " +
        "globalArguments or resource-schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.19.1",
      toVersion: "2026.08.31.1",
      description:
        "Pre-PR verification + attestation. Adds the `verifying` and " +
        "`attested` states, the `verify`, `iterate_verification` and " +
        "`attest` methods, and an `attestation` resource. `review_code` now " +
        "requires `verifying`, so mechanical controls cannot be skipped on " +
        "the way to review. Existing records gain `verificationIteration: " +
        "1`; `verification` and `attestation` stay unset until the new " +
        "methods run.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  globalArguments: z.object({}),

  resources: {
    state: {
      description: "Issue lifecycle state — persists across sessions",
      schema: IssueStateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    summary: {
      description:
        "Compact decision-making summary written by the `hydrate` method. " +
        "Non-authoritative — derived from `state`. Safe for the autonomous " +
        "loop to read cheaply without parsing the full state blob.",
      schema: HydrateSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    attestation: {
      description:
        "Attestation manifest written by the `attest` method — commit sha, " +
        "config checksums, control results and per-reviewer finding counts. " +
        "This is the artifact CI validates in place of re-executing the " +
        "controls; write it to the branch before opening the PR.",
      schema: AttestationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    start: {
      description:
        "File a new issue — creates initial state. Refuses to overwrite an " +
        "in-flight issue (any state other than complete/closed) unless " +
        "force:true is passed; a fresh instance or one already " +
        "complete/closed always proceeds.",
      arguments: z.object({
        title: z.string(),
        description: z.string(),
        labels: z.array(z.string()).default([]),
        force: z.boolean().default(false).describe(
          "Overwrite an in-flight issue (any state other than " +
            "complete/closed) even though it has not reached a terminal " +
            "state. Required to re-file over an active issue; never " +
            "required for a fresh instance or one already complete/closed.",
        ),
      }),
      execute: async (
        args: {
          title: string;
          description: string;
          labels: string[];
          force: boolean;
        },
        context: DefinitionCtx,
      ) => {
        // Read-before-write guard (IL-1): a bare `start` used to overwrite
        // whatever was there — approved plans, review history, everything —
        // with no confirmation. A fresh instance (no `current` yet) or one
        // already in a terminal state (complete/closed) always proceeds;
        // anything else requires an explicit force:true.
        const existing = await readState(context);
        if (existing) {
          const isTerminal = existing.state === "complete" ||
            existing.state === "closed";
          if (!isTerminal && !args.force) {
            throw new Error(
              `Cannot start: an issue already exists in state ` +
                `'${existing.state}'. Pass force:true to overwrite it, or ` +
                `close/complete it first.`,
            );
          }
        }

        context.logger.info("Filing issue {title}", { title: args.title });

        const handle = await context.writeResource("state", "current", {
          state: "filed",
          title: args.title,
          description: args.description,
          labels: args.labels,
          affectedAreas: [],
          reviews: [],
          reviewHistory: [],
          resolutions: {},
          planVersion: 1,
          testReviewIteration: 1,
          codeReviewIteration: 1,
          createdAt: now(),
          updatedAt: now(),
        });

        context.logger.info("Issue filed as {name}", {
          name: context.definition.name,
        });
        return { dataHandles: [handle] };
      },
    },

    triage: {
      description:
        "Triage the issue — set priority, category, affected areas, and " +
        "optional classification detail (confidence, reasoning, isRegression, " +
        "clarifyingQuestions, reproduced). Use moldable-dev to investigate first.",
      arguments: z.object({
        priority: z.enum(["critical", "high", "medium", "low"]),
        category: CategoryEnum,
        affectedAreas: z.array(z.string()),
        confidence: ConfidenceEnum.optional(),
        reasoning: z.string().optional(),
        isRegression: z.boolean().optional(),
        clarifyingQuestions: z.array(z.string()).default([]),
        reproduced: ReproducedSchema.optional(),
      }),
      execute: async (
        args: {
          priority: "critical" | "high" | "medium" | "low";
          category: z.infer<typeof CategoryEnum>;
          affectedAreas: string[];
          confidence?: z.infer<typeof ConfidenceEnum>;
          reasoning?: string;
          isRegression?: boolean;
          clarifyingQuestions: string[];
          reproduced?: z.infer<typeof ReproducedSchema>;
        },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "filed", "triage");

        context.logger.info(
          "Triaging: priority={priority}, category={category}, confidence={confidence}",
          {
            priority: args.priority,
            category: args.category,
            confidence: args.confidence ?? "unspecified",
          },
        );

        const hasDetail = args.confidence !== undefined ||
          args.reasoning !== undefined ||
          args.isRegression !== undefined ||
          args.clarifyingQuestions.length > 0 ||
          args.reproduced !== undefined;

        const triageDetail = hasDetail
          ? {
            confidence: args.confidence,
            reasoning: args.reasoning,
            isRegression: args.isRegression,
            clarifyingQuestions: args.clarifyingQuestions,
            reproduced: args.reproduced,
          }
          : undefined;

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "triaged",
          priority: args.priority,
          category: args.category,
          affectedAreas: args.affectedAreas,
          triageDetail,
          updatedAt: now(),
        });

        context.logger.info("Issue triaged");
        return { dataHandles: [handle] };
      },
    },

    record_prior_art: {
      description:
        "Record existing UAT scenarios and KB entries found during the " +
        "knowledge lookup step before planning. Enables Phase 6 harvest to diff " +
        "what was known going in vs. what's newly proposed going out.",
      arguments: z.object({
        uatScenarios: z.array(UatScenarioRefSchema).default([]),
        kbEntries: z.array(KbEntryRefSchema).default([]),
      }),
      execute: async (
        args: {
          uatScenarios: z.infer<typeof UatScenarioRefSchema>[];
          kbEntries: z.infer<typeof KbEntryRefSchema>[];
        },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, ["triaged", "planned"], "record_prior_art");

        context.logger.info(
          "Recording prior art: {uat} UAT, {kb} KB entries",
          {
            uat: args.uatScenarios.length,
            kb: args.kbEntries.length,
          },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          priorArt: {
            uatScenarios: args.uatScenarios,
            kbEntries: args.kbEntries,
            searchedAt: now(),
          },
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    record_reproduction: {
      description:
        "Record or update the bug-reproduction outcome after triage — " +
        "optional step for bugs/regressions. Merges into " +
        "triageDetail.reproduced without touching classification; state is " +
        "unchanged. Callable from triaged or planned; a second call " +
        "overwrites the first (retry-later supported).",
      arguments: ReproducedSchema,
      execute: async (
        args: { status: ReproducedStatus; notes?: string },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, ["triaged", "planned"], "record_reproduction");

        context.logger.info("Recording reproduction outcome: {status}", {
          status: args.status,
        });

        const handle = await context.writeResource("state", "current", {
          ...data,
          triageDetail: {
            ...(data.triageDetail ?? { clarifyingQuestions: [] }),
            reproduced: { status: args.status, notes: args.notes },
          },
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    plan: {
      description:
        "Create or revise the implementation plan with DDD analysis and TDD " +
        "test strategy. Bumps planVersion on every successful call. " +
        "Accepts potentialChallenges for risk analysis.",
      arguments: z.object({
        summary: z.string(),
        steps: z.array(PlanStepSchema),
        dddAnalysis: z.string().describe(
          "Which aggregates, entities, value objects, and domain services are affected",
        ),
        testStrategy: z.string().describe(
          "What tests to write first, red-green-refactor sequence",
        ),
        reviewMatrix: ReviewMatrixSchema.default({
          code: true,
          adversarial: true,
          security: false,
          ux: false,
          skill: false,
        }),
        potentialChallenges: z.array(z.string()).default([]),
      }),
      execute: async (
        args: {
          summary: string;
          steps: z.infer<typeof PlanStepSchema>[];
          dddAnalysis: string;
          testStrategy: string;
          reviewMatrix: ReviewMatrix;
          potentialChallenges: string[];
        },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, ["triaged", "planned"], "plan");

        const nextVersion = data.plan ? data.planVersion + 1 : 1;

        context.logger.info(
          "Creating plan v{version}: {summary}",
          { version: nextVersion, summary: args.summary },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "planned",
          plan: {
            summary: args.summary,
            steps: args.steps,
            dddAnalysis: args.dddAnalysis,
            testStrategy: args.testStrategy,
            reviewMatrix: args.reviewMatrix,
            potentialChallenges: args.potentialChallenges,
            planVersion: nextVersion,
          },
          planVersion: nextVersion,
          reviews: [],
          updatedAt: now(),
        });

        context.logger.info(
          "Plan v{version} created — run review_plan to start reviews",
          { version: nextVersion },
        );
        return { dataHandles: [handle] };
      },
    },

    review_plan: {
      description:
        "Enter the plan review phase — the skill then fans out review skills " +
        "in parallel (per reviewMatrix) and calls record_review for each.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "planned", "review_plan");

        context.logger.info(
          "Starting plan review phase for plan v{version}",
          { version: data.planVersion },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "reviewing",
          reviews: [],
          reviewRoundStartedAt: now(),
          updatedAt: now(),
        });

        context.logger.info(
          "Plan review started — invoke review skills and record findings via record_review",
        );
        return { dataHandles: [handle] };
      },
    },

    record_review: {
      description:
        "Record one reviewer's findings. Call once per active entry in reviewMatrix.",
      arguments: z.object({
        reviewer: z.string().describe(
          "Skill name: review-code, review-adversarial, review-security, review-ux, review-skill",
        ),
        verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
        findings: z.array(FindingSchema).default([]),
      }),
      execute: async (
        args: {
          reviewer: string;
          verdict: "PASS" | "FAIL" | "SUGGEST_CHANGES";
          findings: Finding[];
        },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(
          data.state,
          ["reviewing", "reviewing_tests", "code_reviewing"],
          "record_review",
        );

        context.logger.info(
          "Recording review from {reviewer}: {verdict} ({findings} findings)",
          {
            reviewer: args.reviewer,
            verdict: args.verdict,
            findings: args.findings.length,
          },
        );

        const review: ReviewResult = {
          reviewer: args.reviewer,
          verdict: args.verdict,
          findings: args.findings,
          timestamp: now(),
        };

        // Last-write-wins: a second submission from a reviewer that already
        // recorded a result this round REPLACES the earlier entry in place
        // rather than appending a duplicate. Without this, the same
        // reviewer's stale findings stick around and hasBlockingFindings
        // double-counts them in the approval gate (IL-7).
        const alreadyRecorded = data.reviews.some(
          (r) => r.reviewer === args.reviewer,
        );
        const reviews = alreadyRecorded
          ? data.reviews.map((r) => r.reviewer === args.reviewer ? review : r)
          : [...data.reviews, review];

        const handle = await context.writeResource("state", "current", {
          ...data,
          reviews,
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    approve_plan: {
      description:
        "Approve the plan. Requires (a) all reviewers in the matrix have " +
        "recorded a result for this round, (b) zero open CRITICAL and " +
        "zero open HIGH findings, AND (c) no reviewer recorded a FAIL " +
        "verdict (even with zero/non-blocking findings). NEVER auto-call " +
        "— human must explicitly approve.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "reviewing", "approve_plan");

        const matrix = data.plan?.reviewMatrix;
        if (!matrix) throw new Error("No plan found — nothing to approve");

        const coverage = allMatrixReviewersRecorded(data.reviews, matrix);
        if (!coverage.complete) {
          throw new Error(
            `Cannot approve: missing reviews from ${
              coverage.missing.join(", ")
            }. Record every reviewer in the matrix before approving.`,
          );
        }

        const blocking = hasBlockingFindings(data.reviews);
        if (blocking.total > 0) {
          throw new Error(
            `Cannot approve: ${blocking.critical} CRITICAL and ${blocking.high} HIGH findings still open. ` +
              `Resolve them or reject the plan and iterate.`,
          );
        }

        const failing = failingReviewers(data.reviews);
        if (failing.length > 0) {
          throw new Error(
            `Cannot approve: reviewer(s) ${
              failing.join(", ")
            } recorded a FAIL verdict. ` +
              `Resolve their concerns, have them re-review with a clean verdict, or reject the plan and iterate.`,
          );
        }

        const historyEntry = snapshotReviewRound(
          data,
          "plan_review",
          "clean",
          undefined,
          data.reviewRoundStartedAt ?? now(),
        );

        context.logger.info(
          "Plan v{version} approved after {iterations} iteration(s) — proceed to implementation",
          {
            version: data.planVersion,
            iterations: historyEntry.iteration,
          },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "approved",
          reviewHistory: [...data.reviewHistory, historyEntry],
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    reject_plan: {
      description:
        "Reject the plan — returns to 'planned' state so the next plan call " +
        "can create a revised version. Snapshots the current review round to " +
        "reviewHistory. `source=auto` means the skill rejected autonomously; " +
        "`source=human` means a human rejected.",
      arguments: z.object({
        reason: z.string(),
        source: z.enum(["auto", "human"]).default("human"),
      }),
      execute: async (
        args: { reason: string; source: "auto" | "human" },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "reviewing", "reject_plan");

        context.logger.info(
          "Plan v{version} rejected ({source}): {reason}",
          {
            version: data.planVersion,
            source: args.source,
            reason: args.reason,
          },
        );

        const outcome: ReviewRound["outcome"] = args.source === "auto"
          ? "rejected_auto"
          : "rejected_human";

        const historyEntry = snapshotReviewRound(
          data,
          "plan_review",
          outcome,
          args.reason,
          data.reviewRoundStartedAt ?? now(),
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "planned",
          reviews: [],
          reviewHistory: [...data.reviewHistory, historyEntry],
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        context.logger.info(
          "Plan returned to 'planned' state — revise and re-submit",
        );
        return { dataHandles: [handle] };
      },
    },

    implement: {
      description:
        "Start implementation — record branch name and enter the TDD test-" +
        "writing sub-phase (state 'writing_tests'). Write failing tests first; " +
        "submit them for review via review_tests. Code is written only after " +
        "tests pass review (tests_approved transitions to 'implementing').",
      arguments: z.object({
        branch: z.string(),
        description: z.string().default(""),
      }),
      execute: async (
        args: { branch: string; description: string },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "approved", "implement");

        context.logger.info("Starting implementation on branch {branch}", {
          branch: args.branch,
        });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "writing_tests",
          branch: args.branch,
          updatedAt: now(),
        });

        context.logger.info(
          "Now in writing_tests — author failing TDD tests, then call review_tests",
        );
        return { dataHandles: [handle] };
      },
    },

    review_tests: {
      description:
        "Enter the test review phase — fans out reviewers (per reviewMatrix) " +
        "to review the TDD tests authored in writing_tests. Mirrors review_plan " +
        "and review_code: resets the round's reviews and stamps " +
        "reviewRoundStartedAt.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "writing_tests", "review_tests");

        const matrix = data.plan?.reviewMatrix ?? {
          code: true,
          adversarial: true,
          security: false,
          ux: false,
          skill: false,
        };
        const reviewers = Object.entries(matrix)
          .filter(([_, enabled]) => enabled)
          .map(([name]) => `review-${name}`);

        context.logger.info(
          "Starting test review iteration {iter} with {count} reviewers: {reviewers}",
          {
            iter: data.testReviewIteration,
            count: reviewers.length,
            reviewers: reviewers.join(", "),
          },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "reviewing_tests",
          reviews: [],
          reviewRoundStartedAt: now(),
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    iterate_tests: {
      description:
        "Return to writing_tests because test review surfaced findings. " +
        "Snapshots the current test-review round to reviewHistory, bumps " +
        "testReviewIteration. `source=auto` means the skill iterated " +
        "autonomously inside the test-review loop.",
      arguments: z.object({
        reason: z.string(),
        source: z.enum(["auto", "human"]).default("human"),
      }),
      execute: async (
        args: { reason: string; source: "auto" | "human" },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "reviewing_tests", "iterate_tests");

        const outcome: ReviewRound["outcome"] = args.source === "auto"
          ? "rejected_auto"
          : "rejected_human";

        context.logger.info(
          "Iterating test review ({source}): {reason}",
          { source: args.source, reason: args.reason },
        );

        const historyEntry = snapshotReviewRound(
          data,
          "test_review",
          outcome,
          args.reason,
          data.reviewRoundStartedAt ?? now(),
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "writing_tests",
          reviews: [],
          reviewHistory: [...data.reviewHistory, historyEntry],
          testReviewIteration: data.testReviewIteration + 1,
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        context.logger.info(
          "Back to writing_tests — rewrite tests to address findings, then " +
            "re-run review_tests",
        );
        return { dataHandles: [handle] };
      },
    },

    tests_approved: {
      description:
        "Tests pass review — transition reviewing_tests → implementing so " +
        "code can be written against the approved tests. Default (autonomous) " +
        "gate: full matrix coverage AND zero open CRITICAL AND zero open HIGH " +
        "findings AND no reviewer FAIL verdict. Pass `override_reason` to " +
        "force-approve (human override) when the autonomous loop has hit " +
        "the iteration cap and the human judges the remaining findings " +
        "(or FAIL verdict) acceptable. Override still requires matrix " +
        "coverage and bypasses both the findings gate and the verdict gate. " +
        "Snapshots outcome=clean (autonomous) or outcome=human_override " +
        "(with the supplied reason).",
      arguments: z.object({
        override_reason: z.string().optional().describe(
          "When set, bypasses the blocking-findings gate as an explicit " +
            "human override (e.g., after the test-review loop hit the " +
            "5-iteration cap without converging). Records the reason in the " +
            "review round snapshot for audit.",
        ),
      }),
      execute: async (
        args: { override_reason?: string },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "reviewing_tests", "tests_approved");

        const matrix = data.plan?.reviewMatrix;
        if (!matrix) {
          throw new Error(
            "No plan found — tests cannot be approved without a plan",
          );
        }

        const coverage = allMatrixReviewersRecorded(data.reviews, matrix);
        if (!coverage.complete) {
          throw new Error(
            `Cannot approve tests: missing reviews from ${
              coverage.missing.join(", ")
            }. Record every reviewer in the matrix before approving tests.`,
          );
        }

        const blocking = hasBlockingFindings(data.reviews);
        const isOverride = args.override_reason !== undefined &&
          args.override_reason.trim().length > 0;

        if (blocking.total > 0 && !isOverride) {
          throw new Error(
            `Cannot approve tests: ${blocking.critical} CRITICAL and ${blocking.high} HIGH findings still open. ` +
              `Resolve them via iterate_tests and rewrite the tests, or pass ` +
              `override_reason to force-approve as a human override.`,
          );
        }

        const failing = failingReviewers(data.reviews);
        if (failing.length > 0 && !isOverride) {
          throw new Error(
            `Cannot approve tests: reviewer(s) ${
              failing.join(", ")
            } recorded a FAIL verdict. ` +
              `Resolve their concerns via iterate_tests and rewrite the tests, or pass ` +
              `override_reason to force-approve as a human override.`,
          );
        }

        const outcome: ReviewRound["outcome"] = isOverride
          ? "human_override"
          : "clean";

        const historyEntry = snapshotReviewRound(
          data,
          "test_review",
          outcome,
          isOverride ? args.override_reason : undefined,
          data.reviewRoundStartedAt ?? now(),
        );

        if (isOverride) {
          context.logger.info(
            "Tests force-approved by human override after {iterations} iteration(s) " +
              "with {critical} CRITICAL and {high} HIGH still open: {reason}",
            {
              iterations: historyEntry.iteration,
              critical: blocking.critical,
              high: blocking.high,
              reason: args.override_reason,
            },
          );
        } else {
          context.logger.info(
            "Tests approved after {iterations} iteration(s) — proceed to write code",
            { iterations: historyEntry.iteration },
          );
        }

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "implementing",
          reviews: [],
          reviewHistory: [...data.reviewHistory, historyEntry],
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Run the repository's mechanical verification controls (fmt, lint, " +
        "typecheck, tests) against the working tree and record the results. " +
        "Transitions implementing → verifying. This is the pre-PR half of " +
        "the verification loop: it executes every declared control in one " +
        "pass, so CI can later validate an attestation instead of " +
        "re-executing them. Controls are supplied by the caller (read from " +
        "agent-constraints/verification-controls.md) — the model never " +
        "hardcodes a build command. A control that cannot be spawned is " +
        "recorded as 'error', never skipped.",
      arguments: z.object({
        controls: z.array(ControlSpecSchema).min(1).describe(
          "Control specs from agent-constraints/verification-controls.md",
        ),
        repoDir: z.string().describe(
          "Absolute path to the repository root the controls run against",
        ),
        runner: z.string().default("local").describe(
          "Identifier of the executing environment, e.g. 'local' or " +
            "'worker:unraid-worker'. Recorded on every control result.",
        ),
      }),
      execute: (
        args: {
          controls: ControlSpec[];
          repoDir: string;
          runner: string;
        },
        context: ReadWriteCtx,
      ) => verifyImpl(defaultRunner, args, context),
    },

    iterate_verification: {
      description:
        "Return to implementing because verification controls failed. " +
        "Snapshots the verification round to reviewHistory and bumps " +
        "verificationIteration. Mirrors iterate / iterate_tests. " +
        "`source=auto` means the skill iterated autonomously inside the " +
        "verification loop.",
      arguments: z.object({
        reason: z.string(),
        source: z.enum(["auto", "human"]).default("human"),
      }),
      execute: async (
        args: { reason: string; source: "auto" | "human" },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "verifying", "iterate_verification");

        const outcome: ReviewRound["outcome"] = args.source === "auto"
          ? "rejected_auto"
          : "rejected_human";

        context.logger.info(
          "Iterating verification ({source}): {reason}",
          { source: args.source, reason: args.reason },
        );

        const historyEntry = snapshotReviewRound(
          data,
          "verification",
          outcome,
          args.reason,
          data.reviewRoundStartedAt ?? now(),
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "implementing",
          reviewHistory: [...data.reviewHistory, historyEntry],
          verificationIteration: data.verificationIteration + 1,
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        context.logger.info(
          "Back to implementing — fix the failing controls, then call verify",
        );
        return { dataHandles: [handle] };
      },
    },

    review_code: {
      description:
        "Enter the code review phase — the skill then fans out reviewers " +
        "based on reviewMatrix. Snapshots the previous round to history on " +
        "re-entry, so autonomous code-review iterations are preserved.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "verifying", "review_code");

        const matrix = data.plan?.reviewMatrix ?? {
          code: true,
          adversarial: true,
          security: false,
          ux: false,
          skill: false,
        };
        const reviewers = Object.entries(matrix)
          .filter(([_, enabled]) => enabled)
          .map(([name]) => `review-${name}`);

        context.logger.info(
          "Starting code review iteration {iter} with {count} reviewers: {reviewers}",
          {
            iter: data.codeReviewIteration,
            count: reviewers.length,
            reviewers: reviewers.join(", "),
          },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "code_reviewing",
          reviews: [],
          reviewRoundStartedAt: now(),
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    resolve_findings: {
      description:
        "Record resolution for review findings. Merges into cumulative " +
        "resolutions map, keyed per reviewer where the description matches " +
        "a current-round finding (IL-4 fix — two different reviewers' " +
        "findings sharing description text no longer collapse into one " +
        "entry). Transitions code_reviewing → resolved.",
      arguments: z.object({
        resolutions: z.record(z.string(), z.string()).describe(
          "Map of finding description → resolution action",
        ),
      }),
      execute: async (
        args: { resolutions: Record<string, string> },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "code_reviewing", "resolve_findings");

        const expandedResolutions = expandResolutionKeys(
          args.resolutions,
          data.reviews,
        );

        context.logger.info("Recording {count} finding resolutions", {
          count: Object.keys(expandedResolutions).length,
        });

        const historyEntry = snapshotReviewRound(
          data,
          "code_review",
          "clean",
          undefined,
          data.reviewRoundStartedAt ?? now(),
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "resolved",
          resolutions: { ...data.resolutions, ...expandedResolutions },
          reviewHistory: [...data.reviewHistory, historyEntry],
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        context.logger.info(
          "Findings resolved — call harvest, complete, or iterate",
        );
        return { dataHandles: [handle] };
      },
    },

    iterate: {
      description:
        "Return to implementation — not all findings resolved. Snapshots " +
        "the current code-review round, bumps codeReviewIteration. " +
        "`source=auto` means the skill iterated autonomously.",
      arguments: z.object({
        reason: z.string(),
        source: z.enum(["auto", "human"]).default("human"),
      }),
      execute: async (
        args: { reason: string; source: "auto" | "human" },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        // Allow iterate from either resolved or code_reviewing so autonomous
        // code-review loops can bounce directly without passing through
        // resolve_findings (which would incorrectly mark everything resolved).
        guardState(
          data.state,
          ["resolved", "code_reviewing"],
          "iterate",
        );

        const outcome: ReviewRound["outcome"] = args.source === "auto"
          ? "rejected_auto"
          : "rejected_human";

        context.logger.info(
          "Iterating code review ({source}): {reason}",
          { source: args.source, reason: args.reason },
        );

        // If we're in code_reviewing, snapshot the current round. If we're in
        // resolved, the snapshot was already taken by resolve_findings —
        // avoid double-snapshotting.
        let reviewHistory = data.reviewHistory;
        if (data.state === "code_reviewing") {
          const historyEntry = snapshotReviewRound(
            data,
            "code_review",
            outcome,
            args.reason,
            data.reviewRoundStartedAt ?? now(),
          );
          reviewHistory = [...reviewHistory, historyEntry];
        }

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "implementing",
          reviews: [],
          reviewHistory,
          codeReviewIteration: data.codeReviewIteration + 1,
          reviewRoundStartedAt: undefined,
          updatedAt: now(),
        });

        context.logger.info(
          "Back to implementation — address findings and re-review",
        );
        return { dataHandles: [handle] };
      },
    },

    attest: {
      description:
        "Emit the attestation manifest — the structured evidence CI " +
        "validates instead of re-executing the controls. Transitions " +
        "resolved → attested. Asserts, before writing anything, that every " +
        "required control passed, that no reviewer recorded a FAIL verdict, " +
        "and that zero CRITICAL / HIGH findings remain open. `attest` " +
        "asserts; it does not approve — it cannot be used to wave work " +
        "through a gate it failed. Write the returned manifest to the branch " +
        "and commit it BEFORE opening the PR.",
      arguments: z.object({
        commitSha: z.string().min(1).describe(
          "The commit the verification ran against (git rev-parse HEAD)",
        ),
        repoDir: z.string().describe(
          "Absolute path to the repository root, for checksum computation",
        ),
        configPaths: z.array(z.string()).default([]).describe(
          "Repo-relative paths whose contents are checksummed into the " +
            "manifest: review skills, agent-constraints, CLAUDE.md, task " +
            "definitions. A validator recomputes these from the PR tree.",
        ),
        prUrl: z.string().optional().describe(
          "Pull request URL, when the PR already exists",
        ),
        producedBy: z.string().default("unknown").describe(
          "Hostname or worker id that produced the manifest",
        ),
      }),
      execute: (
        args: {
          commitSha: string;
          repoDir: string;
          configPaths: string[];
          prUrl?: string;
          producedBy: string;
        },
        context: ReadWriteCtx,
      ) => attestImpl(defaultFileReader, args, context),
    },

    harvest: {
      description:
        "Record UAT and KB improvement proposals from this lifecycle. " +
        "Optional pre-complete step — transitions resolved → harvested. " +
        "Skippable by calling complete directly from resolved.",
      arguments: z.object({
        uatProposals: z.array(UatProposalSchema).default([]),
        kbProposals: z.array(KbProposalSchema).default([]),
      }),
      execute: async (
        args: {
          uatProposals: z.infer<typeof UatProposalSchema>[];
          kbProposals: z.infer<typeof KbProposalSchema>[];
        },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, ["resolved", "attested"], "harvest");

        context.logger.info(
          "Harvesting knowledge: {uat} UAT proposals, {kb} KB proposals",
          {
            uat: args.uatProposals.length,
            kb: args.kbProposals.length,
          },
        );

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "harvested",
          harvest: {
            uatProposals: args.uatProposals,
            kbProposals: args.kbProposals,
            harvestedAt: now(),
          },
          updatedAt: now(),
        });

        context.logger.info("Harvest recorded — call complete to finish");
        return { dataHandles: [handle] };
      },
    },

    complete: {
      description:
        "Mark the issue as complete. Accepts either 'resolved' (harvest " +
        "skipped) or 'harvested' (harvest performed) as source state.",
      arguments: z.object({
        summary: z.string().default(""),
      }),
      execute: async (
        _args: { summary: string },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(
          data.state,
          ["resolved", "attested", "harvested"],
          "complete",
        );

        context.logger.info("Completing issue");

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "complete",
          completedAt: now(),
          updatedAt: now(),
        });

        context.logger.info("Issue complete");
        return { dataHandles: [handle] };
      },
    },

    close: {
      description: "Close/abandon the issue from any state",
      arguments: z.object({
        reason: z.string(),
      }),
      execute: async (
        args: { reason: string },
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");

        context.logger.info("Closing issue from state {state}: {reason}", {
          state: data.state,
          reason: args.reason,
        });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "closed",
          closedReason: args.reason,
          updatedAt: now(),
        });

        context.logger.info("Issue closed");
        return { dataHandles: [handle] };
      },
    },

    hydrate: {
      description:
        "Return a compact summary for the autonomous loop's decision-making: " +
        "current state, planVersion, blocking finding counts, matrix coverage, " +
        "iteration cursors, history length. Writes a 'hydrate' resource so " +
        "the skill can read the summary without parsing the full state blob. " +
        "Does NOT mutate the 'current' state resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ReadWriteCtx,
      ) => {
        const data = await readState(context);
        if (!data) throw new Error("No issue state found — run 'start' first");

        const blocking = hasBlockingFindings(data.reviews);
        const matrix = data.plan?.reviewMatrix ?? {
          code: true,
          adversarial: true,
          security: false,
          ux: false,
          skill: false,
        };
        const coverage = allMatrixReviewersRecorded(data.reviews, matrix);
        const planIterationsThisVersion = data.reviewHistory.filter(
          (r) =>
            r.phase === "plan_review" && r.planVersion === data.planVersion,
        ).length;

        const controls = data.verification?.controls ?? [];
        const summary = {
          state: data.state,
          planVersion: data.planVersion,
          planIterationsThisVersion,
          testReviewIteration: data.testReviewIteration,
          codeReviewIteration: data.codeReviewIteration,
          verificationIteration: data.verificationIteration,
          controls: {
            ran: data.verification !== undefined,
            total: controls.length,
            blocking: blockingControls(controls).map((c) => c.name),
          },
          blocking,
          coverage,
          historyLength: data.reviewHistory.length,
          signature: findingSignature(data.reviews),
          snapshotAt: now(),
        };

        context.logger.info(
          "Hydrate: state={state}, planV={planV}, testIter={testIter}, " +
            "codeIter={codeIter}, controls={controls}, blocking={blocking}, " +
            "coverage={coverage}",
          {
            state: summary.state,
            planV: summary.planVersion,
            testIter: summary.testReviewIteration,
            codeIter: summary.codeReviewIteration,
            controls: summary.controls.ran
              ? `${
                summary.controls.total - summary.controls.blocking.length
              }/${summary.controls.total} pass`
              : "not run",
            blocking: `${blocking.critical}C+${blocking.high}H`,
            coverage: coverage.complete
              ? "complete"
              : `missing:${coverage.missing.join(",")}`,
          },
        );

        // NOTE: writes to the `summary` resource, NOT `state`. The two
        // resources have incompatible schemas — writing `summary` under
        // `state` would fail IssueStateSchema validation. This diverges
        // intentionally from ora v2026.04.09.1 to fix that latent bug.
        const handle = await context.writeResource(
          "summary",
          "hydrate",
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
