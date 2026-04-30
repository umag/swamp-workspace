// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT
//
// @magistr/good-planning — operationalizes Felipe Bovolon's "Good Planning
// Bad Planning" four-layer architecture as queryable swamp state.
//
// Strategy chooses a direction. Planning decides whether that choice can
// survive contact with money, capacity, time, and surprise. The
// organization does not become what it declares; it becomes what it
// actually funds, sequences, protects, and revises.
//
// Source: https://bovolon.substack.com/p/good-planning-bad-planning

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
// (`PlanState`, `Commitment`, …, `HydrateSummary`) and call the model's
// methods, not import the schemas directly.

/**
 * Plan lifecycle state.
 *
 * @internal
 */
export const StateEnum = z.enum([
  "drafted",
  "committed",
  "monitoring",
  "adapting",
  "archived",
]);

/**
 * Three-level severity used for assumption impact and vulnerability.
 *
 * @internal
 */
export const SeverityEnum = z.enum(["high", "medium", "low"]);

/**
 * Per-assumption state derived from its signpost reading.
 *
 * @internal
 */
export const AssumptionStateEnum = z.enum([
  "holding",
  "breaking",
  "broken",
]);

/**
 * Per-tripwire state.
 *
 * @internal
 */
export const TripwireStateEnum = z.enum(["dormant", "warning", "fired"]);

/**
 * Article distinction between actions the org can directly execute
 * (commitments) and external responses it can influence but not control
 * (hypotheses).
 *
 * @internal
 */
export const CommitmentKindEnum = z.enum(["commitment", "hypothesis"]);

/**
 * Lifecycle status of a commitment line item.
 *
 * @internal
 */
export const CommitmentStatusEnum = z.enum([
  "open",
  "completed",
  "slipped",
]);

/**
 * Lifecycle status of a ceiling.
 *
 * @internal
 */
export const CeilingStatusEnum = z.enum(["open", "exercised"]);

/**
 * Layer 1 — assumption with signpost. See {@link Assumption} for the
 * public TypeScript shape.
 *
 * @internal
 */
export const AssumptionSchema = z.object({
  statement: z.string().min(1),
  impact: SeverityEnum,
  vulnerability: SeverityEnum,
  signpostName: z.string().min(1),
  signpostExpr: z.string().optional(),
  state: AssumptionStateEnum.default("holding"),
  lastReading: z.string().optional(),
  lastEvaluatedAt: z.iso.datetime().optional(),
});

/**
 * Layer 2/3 — the article's six-property unit of planning. See
 * {@link Commitment} for the public shape and
 * {@link commitmentSatisfiesSixProperties} for material-completeness checks.
 *
 * @internal
 */
export const CommitmentSchema = z.object({
  kind: CommitmentKindEnum,
  description: z.string(),
  owner: z.string(),
  budgetUsd: z.number().nonnegative(),
  byDate: z.string(),
  dependsOn: z.array(z.string()).default([]),
  reviewCadence: z.string(),
  consequenceIfChanged: z.string(),
  status: CommitmentStatusEnum.default("open"),
});

/**
 * One recorded attempt to raid a protected allocation.
 *
 * @internal
 */
export const RaidAttemptSchema = z.object({
  attemptedAt: z.iso.datetime(),
  amountUsd: z.number().nonnegative(),
  reason: z.string(),
  outcome: z.enum(["denied", "permitted"]),
});

/**
 * Layer 2 — protected allocation per priority (Beyond Budgeting).
 *
 * @internal
 */
export const AllocationSchema = z.object({
  priority: z.string().min(1),
  protectedBudgetUsd: z.number().nonnegative(),
  target: z.string().optional(),
  forecast: z.string().optional(),
  raidLog: z.array(RaidAttemptSchema).default([]),
});

/**
 * Layer 4a — ceiling discipline. See {@link Ceiling} and
 * {@link computeTriggerPoint}.
 *
 * @internal
 */
export const CeilingSchema = z.object({
  crux: z.string().min(1),
  leadTimeWeeks: z.number().nonnegative(),
  safetyMarginWeeks: z.number().nonnegative(),
  signpostName: z.string().min(1),
  optionPremiums: z.array(z.string()).default([]),
  status: CeilingStatusEnum.default("open"),
  lastTimeToCruxWeeks: z.number().optional(),
  lastTriggerPointWeeks: z.number().optional(),
  lastEvaluatedAt: z.iso.datetime().optional(),
});

/**
 * Layer 4b — tripwire (signpost + threshold + pre-authorized action).
 *
 * @internal
 */
export const TripwireSchema = z.object({
  signpostName: z.string().min(1),
  thresholdExpr: z.string().min(1),
  preAuthorizedAction: z.string().min(1),
  pullbackRung: z.number().int().nonnegative().optional(),
  state: TripwireStateEnum.default("dormant"),
  lastReading: z.string().optional(),
  lastEvaluatedAt: z.iso.datetime().optional(),
  lastFiredAt: z.iso.datetime().optional(),
});

/**
 * Layer 4b — maximum tolerable loss components. See
 * {@link computeMaxTolerableLoss} for the article's formula.
 *
 * @internal
 */
export const LossBudgetSchema = z.object({
  sunkCostUsd: z.number().nonnegative().default(0),
  shutdownCostUsd: z.number().nonnegative().default(0),
  committedLiabilitiesUsd: z.number().nonnegative().default(0),
  workingCapitalUnwindUsd: z.number().nonnegative().default(0),
  tailProvisionsUsd: z.number().nonnegative().default(0),
});

/**
 * Append-only audit row for one adaptation taken.
 *
 * @internal
 */
export const AdaptEventSchema = z.object({
  at: z.iso.datetime(),
  reason: z.string(),
  triggeredBy: z.string().describe(
    "Tripwire signpost name or ceiling crux that caused the adapt",
  ),
  reading: z.string().optional(),
  actionTaken: z.string(),
  outcome: z.enum(["committed", "revised"]),
});

/**
 * Append-only audit row for one plan revision (assumption-broken cycle).
 *
 * @internal
 */
export const ReviseEventSchema = z.object({
  at: z.iso.datetime(),
  reason: z.string(),
  brokenAssumptions: z.array(z.string()).default([]),
});

/**
 * Snapshot of the four diagnostic questions. See
 * {@link auditDiagnosticQuestions}.
 *
 * @internal
 */
export const PlanReviewSchema = z.object({
  at: z.iso.datetime(),
  layer1Visible: z.boolean(),
  layer1Answer: z.string(),
  layer2Aligned: z.boolean(),
  layer2Answer: z.string(),
  layer3Coherent: z.boolean(),
  layer3Answer: z.string(),
  layer4CeilingPresent: z.boolean(),
  layer4CeilingAnswer: z.string(),
  layer4FloorPresent: z.boolean(),
  layer4FloorAnswer: z.string(),
  governabilityScore: z.number().min(0).max(1),
});

/**
 * Compact governability scorecard. See {@link HydrateSummary}.
 *
 * @internal
 */
export const HydrateSummarySchema = z.object({
  state: StateEnum,
  planVersion: z.number().int().positive(),
  strategicChoice: z.string(),
  horizon: z.string(),
  layerCounts: z.object({
    assumptions: z.number().int().nonnegative(),
    commitments: z.number().int().nonnegative(),
    hypotheses: z.number().int().nonnegative(),
    allocations: z.number().int().nonnegative(),
    ceilings: z.number().int().nonnegative(),
    tripwires: z.number().int().nonnegative(),
  }),
  governabilityScore: z.number().min(0).max(1),
  firedTripwires: z.number().int().nonnegative(),
  brokenAssumptions: z.number().int().nonnegative(),
  exercisedCeilings: z.number().int().nonnegative(),
  maxTolerableLossUsd: z.number().nonnegative(),
  totalProtectedBudgetUsd: z.number().nonnegative(),
  historyLength: z.number().int().nonnegative(),
  snapshotAt: z.iso.datetime(),
});

/**
 * Plan aggregate root — see {@link PlanState}.
 *
 * @internal
 */
export const PlanStateSchema = z.object({
  state: StateEnum,
  strategicChoice: z.string(),
  horizon: z.string(),
  notes: z.string().optional(),
  assumptions: z.array(AssumptionSchema).default([]),
  commitments: z.array(CommitmentSchema).default([]),
  allocations: z.array(AllocationSchema).default([]),
  ceilings: z.array(CeilingSchema).default([]),
  tripwires: z.array(TripwireSchema).default([]),
  pullbackLadder: z.array(z.string()).default([]),
  // Zod 4's .default() on an object schema requires the full input shape
  // at the type level — the inner field defaults don't propagate. Keep the
  // explicit zero literal even though it looks redundant.
  lossBudget: LossBudgetSchema.default({
    sunkCostUsd: 0,
    shutdownCostUsd: 0,
    committedLiabilitiesUsd: 0,
    workingCapitalUnwindUsd: 0,
    tailProvisionsUsd: 0,
  }),
  adaptHistory: z.array(AdaptEventSchema).default([]),
  reviseHistory: z.array(ReviseEventSchema).default([]),
  audits: z.array(PlanReviewSchema).default([]),
  planVersion: z.number().int().positive().default(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

// ============================================================================
// Public TypeScript types — these are the shapes consumers should depend on
// ============================================================================
//
// Hand-written interfaces rather than `z.infer<typeof Schema>`: the latter
// resolves through Zod's internal `output` type which `deno doc --lint`
// flags as private. Keeping them in lockstep with the schemas above is a
// minor maintenance cost paid for a public, properly-documented API.

/** Plan lifecycle state. */
export type State =
  | "drafted"
  | "committed"
  | "monitoring"
  | "adapting"
  | "archived";

/** Three-level severity. */
export type Severity = "high" | "medium" | "low";

/** Assumption state derived from its signpost reading. */
export type AssumptionState = "holding" | "breaking" | "broken";

/** Tripwire state. */
export type TripwireState = "dormant" | "warning" | "fired";

/** Commitment kind: action vs external bet. */
export type CommitmentKind = "commitment" | "hypothesis";

/** Commitment lifecycle status. */
export type CommitmentStatus = "open" | "completed" | "slipped";

/** Ceiling lifecycle status. */
export type CeilingStatus = "open" | "exercised";

/** Layer 1 — explicit assumption with signpost. */
export interface Assumption {
  /** What the plan believes about the world. */
  statement: string;
  /** How much fails if this is wrong. */
  impact: Severity;
  /** How likely it is to be wrong. */
  vulnerability: Severity;
  /** Named observable indicator that tells you whether the assumption holds. */
  signpostName: string;
  /** Optional CEL/expression for evaluating the signpost. */
  signpostExpr?: string;
  /** Current state derived from latest signpost reading. */
  state: AssumptionState;
  /** Last observed value of the signpost. */
  lastReading?: string;
  /** ISO-8601 timestamp of last evaluate(). */
  lastEvaluatedAt?: string;
}

/** Layer 2/3 — the six-property unit of planning. */
export interface Commitment {
  /** Direct action vs external response. */
  kind: CommitmentKind;
  /** What is being committed to / hypothesized. */
  description: string;
  /** Personally accountable person. */
  owner: string;
  /** Real money attached. */
  budgetUsd: number;
  /** Time implication, parseable as a date. */
  byDate: string;
  /** Other commitment descriptions this depends on (free-form). */
  dependsOn: string[];
  /** When and how progress is reviewed. */
  reviewCadence: string;
  /** What happens if the commitment changes. */
  consequenceIfChanged: string;
  /** Current lifecycle status. */
  status: CommitmentStatus;
}

/** Recorded attempt to raid a protected allocation. */
export interface RaidAttempt {
  /** ISO-8601 timestamp. */
  attemptedAt: string;
  /** Amount the raid would have moved. */
  amountUsd: number;
  /** Stated rationale. */
  reason: string;
  /** Whether the raid was denied or permitted. */
  outcome: "denied" | "permitted";
}

/** Layer 2 — protected allocation per priority. */
export interface Allocation {
  /** Priority name (matches a strategic choice or commitment cluster). */
  priority: string;
  /** Money that survives mid-cycle reallocation pressure. */
  protectedBudgetUsd: number;
  /** Optional target string (kept separate from forecast and allocation). */
  target?: string;
  /** Optional forecast string (kept separate from target and allocation). */
  forecast?: string;
  /** Append-only log of raid attempts. */
  raidLog: RaidAttempt[];
}

/** Layer 4a — ceiling discipline. */
export interface Ceiling {
  /** First binding crux of success (capacity, talent, regulator, etc.). */
  crux: string;
  /** Lead time required to relieve the crux. */
  leadTimeWeeks: number;
  /** Safety margin to keep on top of lead time. */
  safetyMarginWeeks: number;
  /** Named signpost that tracks time-to-crux. */
  signpostName: string;
  /** Pre-cleared low-regret actions (vendor qualification, permits, etc.). */
  optionPremiums: string[];
  /** Whether the option premium has been exercised. */
  status: CeilingStatus;
  /** Last observed weeks-to-crux. */
  lastTimeToCruxWeeks?: number;
  /** Last computed trigger point. */
  lastTriggerPointWeeks?: number;
  /** ISO-8601 timestamp of last evaluate(). */
  lastEvaluatedAt?: string;
}

/** Layer 4b — tripwire. */
export interface Tripwire {
  /** Named signpost this tripwire watches. */
  signpostName: string;
  /** Human-readable threshold expression (e.g. "< 6%"). */
  thresholdExpr: string;
  /** What gets done when the threshold is crossed. Must be concrete. */
  preAuthorizedAction: string;
  /** Optional index into the plan's pullbackLadder. */
  pullbackRung?: number;
  /** Current state. */
  state: TripwireState;
  /** Last observed reading. */
  lastReading?: string;
  /** ISO-8601 timestamp of last evaluate(). */
  lastEvaluatedAt?: string;
  /** ISO-8601 timestamp of last fire. */
  lastFiredAt?: string;
}

/** Layer 4b — max tolerable loss components. */
export interface LossBudget {
  /** Already-spent unrecoverable cost. */
  sunkCostUsd: number;
  /** Cost to wind down. */
  shutdownCostUsd: number;
  /** Liabilities already incurred. */
  committedLiabilitiesUsd: number;
  /** Working capital that must unwind. */
  workingCapitalUnwindUsd: number;
  /** Tail-risk provisions. */
  tailProvisionsUsd: number;
}

/** Append-only adapt event. */
export interface AdaptEvent {
  /** ISO-8601 timestamp. */
  at: string;
  /** Stated rationale. */
  reason: string;
  /** Signpost name or ceiling crux that caused the adapt. */
  triggeredBy: string;
  /** Reading at the time of trigger. */
  reading?: string;
  /** What was done. */
  actionTaken: string;
  /** Whether the plan returned to committed or had to revise. */
  outcome: "committed" | "revised";
}

/** Append-only revise event. */
export interface ReviseEvent {
  /** ISO-8601 timestamp. */
  at: string;
  /** Stated rationale. */
  reason: string;
  /** Names of the assumptions that broke. */
  brokenAssumptions: string[];
}

/** Snapshot of the four diagnostic questions (Layer 4 splits → 5 answers). */
export interface PlanReview {
  /** ISO-8601 timestamp. */
  at: string;
  /** Q1 — assumption visibility. */
  layer1Visible: boolean;
  /** Q1 answer. */
  layer1Answer: string;
  /** Q2 — strategy/budget alignment. */
  layer2Aligned: boolean;
  /** Q2 answer. */
  layer2Answer: string;
  /** Q3 — commitment coherence (six-property completeness). */
  layer3Coherent: boolean;
  /** Q3 answer. */
  layer3Answer: string;
  /** Q4a — ceiling presence. */
  layer4CeilingPresent: boolean;
  /** Q4a answer. */
  layer4CeilingAnswer: string;
  /** Q4b — floor presence. */
  layer4FloorPresent: boolean;
  /** Q4b answer. */
  layer4FloorAnswer: string;
  /** Governability score in [0, 1]. */
  governabilityScore: number;
}

/** Counts of each layer's items in a plan. */
export interface LayerCounts {
  /** Number of recorded assumptions. */
  assumptions: number;
  /** Number of commitments (kind === "commitment"). */
  commitments: number;
  /** Number of hypotheses (kind === "hypothesis"). */
  hypotheses: number;
  /** Number of protected allocations. */
  allocations: number;
  /** Number of ceilings. */
  ceilings: number;
  /** Number of tripwires. */
  tripwires: number;
}

/** Compact governability scorecard written by `hydrate`. */
export interface HydrateSummary {
  /** Plan lifecycle state. */
  state: State;
  /** Current plan version (bumps on revise). */
  planVersion: number;
  /** The strategic choice the plan operationalizes. */
  strategicChoice: string;
  /** Planning horizon. */
  horizon: string;
  /** Counts per layer. */
  layerCounts: LayerCounts;
  /** Score in [0, 1]; 1 means every layer is materially present. */
  governabilityScore: number;
  /** Number of tripwires currently fired. */
  firedTripwires: number;
  /** Number of assumptions currently broken. */
  brokenAssumptions: number;
  /** Number of ceilings whose option has been exercised. */
  exercisedCeilings: number;
  /** Total max tolerable loss. */
  maxTolerableLossUsd: number;
  /** Sum of protected allocations. */
  totalProtectedBudgetUsd: number;
  /** Combined adapt + revise history length. */
  historyLength: number;
  /** ISO-8601 timestamp of this snapshot. */
  snapshotAt: string;
}

/** Plan aggregate root — the full state stored under `state.current`. */
export interface PlanState {
  /** Current lifecycle state. */
  state: State;
  /** The where-to-play / how-to-win sentence. */
  strategicChoice: string;
  /** Planning horizon (e.g. "3y", "12m"). */
  horizon: string;
  /** Optional free-form notes. */
  notes?: string;
  /** Layer 1 — assumptions. */
  assumptions: Assumption[];
  /** Layer 2/3 — commitments and hypotheses. */
  commitments: Commitment[];
  /** Layer 2 — protected allocations. */
  allocations: Allocation[];
  /** Layer 4a — ceilings. */
  ceilings: Ceiling[];
  /** Layer 4b — tripwires. */
  tripwires: Tripwire[];
  /** Layer 4b — ordered list of cuts (index 0 first). */
  pullbackLadder: string[];
  /** Layer 4b — max tolerable loss components. */
  lossBudget: LossBudget;
  /** Append-only adapt history. */
  adaptHistory: AdaptEvent[];
  /** Append-only revise history. */
  reviseHistory: ReviseEvent[];
  /** Append-only audit history. */
  audits: PlanReview[];
  /** Plan version (bumps on revise). */
  planVersion: number;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

// ============================================================================
// Helpers (exported for tests AND public API)
// ============================================================================

/** Current ISO-8601 timestamp string. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * State-machine guard. Throws with a useful message naming the current
 * state, the expected state(s), and the method being called.
 *
 * @param current   The plan's current state.
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
 * Trigger point per the article:
 *   trigger = time_to_hit_crux − lead_time_to_relieve − safety_margin
 * Negative means already late.
 *
 * @param ceiling           Ceiling's lead time and safety margin.
 * @param timeToCruxWeeks   Observed weeks until the binding crux hits.
 * @returns Weeks of slack remaining; non-positive means act now.
 */
export function computeTriggerPoint(
  ceiling: Pick<Ceiling, "leadTimeWeeks" | "safetyMarginWeeks">,
  timeToCruxWeeks: number,
): number {
  return timeToCruxWeeks - ceiling.leadTimeWeeks - ceiling.safetyMarginWeeks;
}

/**
 * Maximum tolerable loss per the article:
 *   sunk + shutdown + liabilities + working-capital-unwind + tail
 *
 * @param b  The plan's loss budget.
 * @returns Total max tolerable loss in USD.
 */
export function computeMaxTolerableLoss(b: LossBudget): number {
  return b.sunkCostUsd + b.shutdownCostUsd + b.committedLiabilitiesUsd +
    b.workingCapitalUnwindUsd + b.tailProvisionsUsd;
}

/**
 * The article's six properties of a real commitment. Returns the list of
 * property names that are materially missing — empty strings count as
 * missing, and `byDate` must parse as a date string.
 *
 * @param c  The commitment to check.
 * @returns `{ ok, missing }` — empty `missing` means commitment is real.
 */
export function commitmentSatisfiesSixProperties(
  c: Commitment,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.owner.trim()) missing.push("owner");
  if (c.budgetUsd <= 0) missing.push("budgetUsd");
  if (!c.byDate.trim() || isNaN(Date.parse(c.byDate))) {
    missing.push("byDate");
  }
  // dependsOn may legitimately be empty (a top-level commitment).
  if (!c.reviewCadence.trim()) missing.push("reviewCadence");
  if (!c.consequenceIfChanged.trim()) missing.push("consequenceIfChanged");
  if (!c.description.trim()) missing.push("description");
  return { ok: missing.length === 0, missing };
}

/**
 * Names of the five layers used by `commitGateReport` and the audit.
 * Layer 4 splits into ceiling + floor.
 */
export type LayerName =
  | "assumption"
  | "allocative"
  | "coordinative"
  | "ceiling"
  | "floor";

/** A single commit-gate gap. */
export interface LayerGap {
  /** Which of the five layers has the gap. */
  layer: LayerName;
  /** Human-readable explanation, ideally quoting article language. */
  reason: string;
  /** Optional structured detail (e.g. per-commitment missing properties). */
  detail?: Record<string, unknown>;
}

/**
 * The commit gate. Returns the structured list of gaps so `commit()` can
 * format a useful error AND tests can assert on the structure without
 * string-matching method bodies.
 *
 * @param plan  The plan being committed.
 * @returns `{ ok, gaps }` — empty gaps means the plan is committable.
 */
export function commitGateReport(plan: PlanState): {
  ok: boolean;
  gaps: LayerGap[];
} {
  const gaps: LayerGap[] = [];

  // Layer 1: assumption
  if (plan.assumptions.length === 0) {
    gaps.push({
      layer: "assumption",
      reason:
        "No assumptions recorded. The article: 'every plan embeds a model " +
        "of reality... the question is whether they are visible or buried.'",
    });
  }

  // Layer 2: allocation
  if (plan.allocations.length === 0) {
    gaps.push({
      layer: "allocative",
      reason: "No protected allocations. An unfunded priority is a fantasy.",
    });
  }

  // Layer 3: coordination — at least one commitment, all six-property complete
  if (plan.commitments.length === 0) {
    gaps.push({
      layer: "coordinative",
      reason: "No commitments recorded. You have a wish list, not a plan.",
    });
  } else {
    const incomplete: Record<string, string[]> = {};
    plan.commitments.forEach((c, i) => {
      const r = commitmentSatisfiesSixProperties(c);
      if (!r.ok) {
        incomplete[`commitments[${i}] (${c.description || "<no desc>"})`] =
          r.missing;
      }
    });
    if (Object.keys(incomplete).length > 0) {
      gaps.push({
        layer: "coordinative",
        reason: "One or more commitments are missing required properties. " +
          "Without all six, you have a wish list, not a plan.",
        detail: incomplete,
      });
    }
  }

  // Layer 4a: ceiling
  if (plan.ceilings.length === 0) {
    gaps.push({
      layer: "ceiling",
      reason: "No ceiling crux identified. Upside surprises destroy value as " +
        "effectively as downside ones.",
    });
  }

  // Layer 4b: floor
  if (plan.tripwires.length === 0) {
    gaps.push({
      layer: "floor",
      reason: "No tripwires. Signposts without tripwires are monitoring; " +
        "tripwires without pre-authorized actions are alarmism.",
    });
  }

  return { ok: gaps.length === 0, gaps };
}

/**
 * Governability score in [0, 1] — fraction of the five layers that are
 * materially present. Article claim is that most companies fail layers
 * 1, 2, and 4; this function quantifies the failure.
 *
 * @param plan  The plan to score.
 * @returns Score in [0, 1].
 */
export function governabilityScore(plan: PlanState): number {
  let score = 0;
  if (plan.assumptions.length > 0) score++;
  if (plan.allocations.length > 0) score++;
  if (
    plan.commitments.length > 0 &&
    plan.commitments.every((c) => commitmentSatisfiesSixProperties(c).ok)
  ) {
    score++;
  }
  if (plan.ceilings.length > 0) score++;
  if (plan.tripwires.length > 0) score++;
  return score / 5;
}

/** Five booleans plus answer strings — one per article diagnostic question. */
export interface DiagnosticAnswers {
  /** Q1 visible? */
  layer1Visible: boolean;
  /** Q1 answer text. */
  layer1Answer: string;
  /** Q2 aligned? */
  layer2Aligned: boolean;
  /** Q2 answer text. */
  layer2Answer: string;
  /** Q3 coherent? */
  layer3Coherent: boolean;
  /** Q3 answer text. */
  layer3Answer: string;
  /** Q4a ceiling present? */
  layer4CeilingPresent: boolean;
  /** Q4a answer text. */
  layer4CeilingAnswer: string;
  /** Q4b floor present? */
  layer4FloorPresent: boolean;
  /** Q4b answer text. */
  layer4FloorAnswer: string;
}

/**
 * Answer the four diagnostic questions from the article (Layer 4 splits
 * into ceiling + floor → five answers).
 *
 * @param plan  The plan to audit.
 * @returns Five booleans plus their human-readable answers.
 */
export function auditDiagnosticQuestions(plan: PlanState): DiagnosticAnswers {
  const namedAssumptions = plan.assumptions
    .map((a) => `${a.statement} [signpost: ${a.signpostName}]`);
  const layer1Visible = plan.assumptions.length > 0;
  const layer1Answer = layer1Visible
    ? `${plan.assumptions.length} assumption(s) with signposts: ${
      namedAssumptions.join("; ")
    }`
    : "None named — the plan quietly assumes certainty it does not possess.";

  const totalProtected = plan.allocations.reduce(
    (s, a) => s + a.protectedBudgetUsd,
    0,
  );
  const layer2Aligned = plan.allocations.length > 0 && totalProtected > 0;
  const layer2Answer = layer2Aligned
    ? `${plan.allocations.length} protected allocation(s), total $${totalProtected}`
    : "Budget reproduces last year's pattern. Strategy says one thing, money says another.";

  const incompleteCount = plan.commitments
    .filter((c) => !commitmentSatisfiesSixProperties(c).ok).length;
  const layer3Coherent = plan.commitments.length > 0 && incompleteCount === 0;
  const layer3Answer = layer3Coherent
    ? `${plan.commitments.length} commitment(s), all six properties complete`
    : `${plan.commitments.length} commitment(s), ${incompleteCount} incomplete — wish list, not a plan`;

  const layer4CeilingPresent = plan.ceilings.length > 0;
  const layer4CeilingAnswer = layer4CeilingPresent
    ? `${plan.ceilings.length} ceiling(s) with crux + lead time defined`
    : "No first-binding crux identified. Success will overwhelm capacity.";

  const layer4FloorPresent = plan.tripwires.length > 0;
  const layer4FloorAnswer = layer4FloorPresent
    ? `${plan.tripwires.length} tripwire(s) with pre-authorized action`
    : "No tripwires. The organization will scramble when reality breaks.";

  return {
    layer1Visible,
    layer1Answer,
    layer2Aligned,
    layer2Answer,
    layer3Coherent,
    layer3Answer,
    layer4CeilingPresent,
    layer4CeilingAnswer,
    layer4FloorPresent,
    layer4FloorAnswer,
  };
}

/**
 * Collect every signpost name referenced by assumptions, ceilings, or
 * tripwires. Used by `evaluate()` to surface typos.
 *
 * @param plan  The plan to inspect.
 * @returns Sorted, deduped list of signpost names.
 */
export function knownSignposts(plan: PlanState): string[] {
  const names = new Set<string>();
  for (const a of plan.assumptions) names.add(a.signpostName);
  for (const c of plan.ceilings) names.add(c.signpostName);
  for (const t of plan.tripwires) names.add(t.signpostName);
  return Array.from(names).sort();
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

async function readState(ctx: ReadWriteCtx): Promise<PlanState | null> {
  const raw = await ctx.readResource!("current");
  if (!raw) return null;
  // Parse through the schema so defaults fill in for legacy instances.
  return PlanStateSchema.parse(raw) as PlanState;
}

/**
 * Internal model object — its type recursively references Zod internals
 * that are private at the JSR-publish level. Consumers should depend on
 * the public types and helpers above and call methods via swamp's CLI or
 * `swamp model method run`, not import this object.
 *
 * @internal
 */
export const model = {
  type: "@magistr/good-planning",
  version: "2026.04.30.1",

  globalArguments: z.object({}),

  resources: {
    state: {
      description:
        "Plan state — strategic choice, four-layer collections, history",
      schema: PlanStateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    summary: {
      description: "Compact governability scorecard written by `hydrate`. " +
        "Non-authoritative; derived from `state`. Safe for autonomous " +
        "monitoring loops to read cheaply.",
      schema: HydrateSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    start: {
      description:
        "Create a draft plan with strategicChoice + horizon. Strategy " +
        "chooses; planning commits — this records the choice the plan " +
        "exists to operationalize.",
      arguments: z.object({
        strategicChoice: z.string().min(1).describe(
          "The where-to-play / how-to-win sentence in one line",
        ),
        horizon: z.string().min(1).describe("e.g. '3y', '12m'"),
        notes: z.string().optional(),
      }),
      execute: async (
        args: { strategicChoice: string; horizon: string; notes?: string },
        ctx: DefinitionCtx,
      ) => {
        ctx.logger.info("Drafting plan {choice}", {
          choice: args.strategicChoice,
        });
        const handle = await ctx.writeResource("state", "current", {
          state: "drafted",
          strategicChoice: args.strategicChoice,
          horizon: args.horizon,
          notes: args.notes,
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
          createdAt: now(),
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    add_assumption: {
      description: "Record a Layer 1 assumption with impact, vulnerability, " +
        "and signpost. Only legal in 'drafted'.",
      arguments: AssumptionSchema.pick({
        statement: true,
        impact: true,
        vulnerability: true,
        signpostName: true,
        signpostExpr: true,
      }),
      execute: async (
        args: Pick<
          Assumption,
          | "statement"
          | "impact"
          | "vulnerability"
          | "signpostName"
          | "signpostExpr"
        >,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "add_assumption");
        const newA: Assumption = { ...args, state: "holding" };
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          assumptions: [...data.assumptions, newA],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    add_commitment: {
      description:
        "Record a commitment OR hypothesis with all six properties. " +
        "Refuses to add if any property is materially missing — empty " +
        "strings, zero budget, or unparseable date all fail. The article: " +
        "'without these six properties you have a wish list.'",
      arguments: CommitmentSchema.omit({ status: true }),
      execute: async (
        args: Omit<Commitment, "status">,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "add_commitment");
        const candidate: Commitment = { ...args, status: "open" };
        const r = commitmentSatisfiesSixProperties(candidate);
        if (!r.ok) {
          throw new Error(
            `Commitment '${candidate.description}' is missing required ` +
              `properties: ${r.missing.join(", ")}. ` +
              "The article: 'without these six properties you have a wish list.'",
          );
        }
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          commitments: [...data.commitments, candidate],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    add_allocation: {
      description:
        "Record a Layer 2 protected allocation. Target / forecast / " +
        "allocation are tracked as separate fields per Beyond Budgeting.",
      arguments: AllocationSchema.pick({
        priority: true,
        protectedBudgetUsd: true,
        target: true,
        forecast: true,
      }),
      execute: async (
        args: Pick<
          Allocation,
          "priority" | "protectedBudgetUsd" | "target" | "forecast"
        >,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "add_allocation");
        const newA: Allocation = { ...args, raidLog: [] };
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          allocations: [...data.allocations, newA],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    add_ceiling: {
      description: "Record a Layer 4a ceiling: first-binding crux + lead " +
        "time + safety margin + signpost. The article's formula: " +
        "trigger_point = time_to_crux − lead_time − safety_margin. " +
        "Pre-clear, don't pre-invest.",
      arguments: CeilingSchema.pick({
        crux: true,
        leadTimeWeeks: true,
        safetyMarginWeeks: true,
        signpostName: true,
        optionPremiums: true,
      }),
      execute: async (
        args: Pick<
          Ceiling,
          | "crux"
          | "leadTimeWeeks"
          | "safetyMarginWeeks"
          | "signpostName"
          | "optionPremiums"
        >,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "add_ceiling");
        const newC: Ceiling = { ...args, status: "open" };
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          ceilings: [...data.ceilings, newC],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    add_tripwire: {
      description:
        "Record a Layer 4b tripwire: signpost + threshold + pre-authorized " +
        "action. Tripwires that merely trigger 'further analysis' are too weak.",
      arguments: TripwireSchema.pick({
        signpostName: true,
        thresholdExpr: true,
        preAuthorizedAction: true,
        pullbackRung: true,
      }),
      execute: async (
        args: Pick<
          Tripwire,
          | "signpostName"
          | "thresholdExpr"
          | "preAuthorizedAction"
          | "pullbackRung"
        >,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "add_tripwire");
        const newT: Tripwire = { ...args, state: "dormant" };
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          tripwires: [...data.tripwires, newT],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    set_pullback_ladder: {
      description: "Record the ordered list of cuts. Index 0 is what gets " +
        "cut first. The article: 'if the answer is not written down before " +
        "stress emerges, the organization will improvise under pressure " +
        "and usually cut the wrong things.'",
      arguments: z.object({
        rungs: z.array(z.string()).min(1),
      }),
      execute: async (
        args: { rungs: string[] },
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "set_pullback_ladder");
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          pullbackLadder: args.rungs,
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    set_loss_budget: {
      description:
        "Record the maximum tolerable loss components. Total = sunk + " +
        "shutdown + liabilities + working-capital-unwind + tail provisions.",
      arguments: LossBudgetSchema,
      execute: async (
        args: LossBudget,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "set_loss_budget");
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          lossBudget: args,
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    commit: {
      description:
        "drafted → committed. Refuses unless every layer is materially " +
        "populated AND every commitment satisfies its six properties. " +
        "This gate is the model — weakening it defeats the article's " +
        "thesis. Do not add 'force' or 'skip' flags.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "drafted", "commit");
        const report = commitGateReport(data);
        if (!report.ok) {
          const lines = report.gaps.map((g) =>
            g.detail
              ? `[${g.layer}] ${g.reason} ${JSON.stringify(g.detail)}`
              : `[${g.layer}] ${g.reason}`
          );
          throw new Error(
            "Cannot commit — plan has unfilled layers:\n" + lines.join("\n"),
          );
        }
        ctx.logger.info("Plan committed at version {v}", {
          v: data.planVersion,
        });
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          state: "committed",
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    monitor: {
      description: "committed → monitoring. Begin signpost evaluation.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "committed", "monitor");
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          state: "monitoring",
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    evaluate: {
      description:
        "Read a signpost's current value and update every assumption, " +
        "ceiling, and tripwire that references it by name. Throws when " +
        "the signpost is not referenced anywhere — silent no-op would " +
        "mask typos and let the plan drift from reality.",
      arguments: z.object({
        signpostName: z.string().min(1),
        reading: z.string().describe("Observed value, free-form string"),
        assumptionState: AssumptionStateEnum.optional().describe(
          "If reading impacts an assumption: holding|breaking|broken",
        ),
        tripwireState: TripwireStateEnum.optional().describe(
          "If reading crosses a threshold: dormant|warning|fired",
        ),
        timeToCruxWeeks: z.number().optional().describe(
          "If reading impacts a ceiling: observed weeks until crux. " +
            "Recomputes triggerPointWeeks via the article's formula.",
        ),
      }),
      execute: async (
        args: {
          signpostName: string;
          reading: string;
          assumptionState?: AssumptionState;
          tripwireState?: TripwireState;
          timeToCruxWeeks?: number;
        },
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "monitoring", "evaluate");

        const known = knownSignposts(data);
        if (!known.includes(args.signpostName)) {
          throw new Error(
            `Unknown signpost '${args.signpostName}'. ` +
              `Known: ${known.join(", ") || "(none)"}. ` +
              "Add the signpost to an assumption, ceiling, or tripwire " +
              "before evaluating it.",
          );
        }

        const stamp = now();

        const assumptions = data.assumptions.map((a) => {
          if (a.signpostName !== args.signpostName) return a;
          return {
            ...a,
            state: args.assumptionState ?? a.state,
            lastReading: args.reading,
            lastEvaluatedAt: stamp,
          };
        });

        const tripwires = data.tripwires.map((t) => {
          if (t.signpostName !== args.signpostName) return t;
          const nextState = args.tripwireState ?? t.state;
          return {
            ...t,
            state: nextState,
            lastReading: args.reading,
            lastEvaluatedAt: stamp,
            lastFiredAt: nextState === "fired" ? stamp : t.lastFiredAt,
          };
        });

        const ceilings = data.ceilings.map((c) => {
          if (c.signpostName !== args.signpostName) return c;
          if (args.timeToCruxWeeks === undefined) {
            return { ...c, lastEvaluatedAt: stamp };
          }
          return {
            ...c,
            lastTimeToCruxWeeks: args.timeToCruxWeeks,
            lastTriggerPointWeeks: computeTriggerPoint(
              c,
              args.timeToCruxWeeks,
            ),
            lastEvaluatedAt: stamp,
          };
        });

        const handle = await ctx.writeResource("state", "current", {
          ...data,
          assumptions,
          tripwires,
          ceilings,
          updatedAt: stamp,
        });
        return { dataHandles: [handle] };
      },
    },

    trigger: {
      description:
        "monitoring → adapting. Call when a tripwire has fired or a " +
        "ceiling's triggerPointWeeks has gone non-positive. Refuses if " +
        "the named signpost is dormant — adapting requires a real signal.",
      arguments: z.object({
        signpostName: z.string().min(1),
        reason: z.string().min(1),
      }),
      execute: async (
        args: { signpostName: string; reason: string },
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "monitoring", "trigger");

        const known = knownSignposts(data);
        if (!known.includes(args.signpostName)) {
          throw new Error(
            `Unknown signpost '${args.signpostName}'. Known: ${
              known.join(", ") || "(none)"
            }`,
          );
        }

        const firedTripwire = data.tripwires.find((t) =>
          t.signpostName === args.signpostName && t.state === "fired"
        );
        const breachedCeiling = data.ceilings.find((c) =>
          c.signpostName === args.signpostName &&
          c.lastTriggerPointWeeks !== undefined &&
          c.lastTriggerPointWeeks <= 0
        );
        if (!firedTripwire && !breachedCeiling) {
          throw new Error(
            `No fired tripwire or breached ceiling for signpost ` +
              `'${args.signpostName}'. evaluate() the signpost first.`,
          );
        }

        ctx.logger.info("Triggering adapt on {signpost}: {reason}", {
          signpost: args.signpostName,
          reason: args.reason,
        });

        const handle = await ctx.writeResource("state", "current", {
          ...data,
          state: "adapting",
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    adapt: {
      description:
        "adapting → committed. Record the action taken (pullback rung " +
        "executed, ceiling option exercised) as an append-only history " +
        "entry. Optionally marks a ceiling as exercised.",
      arguments: z.object({
        triggeredBy: z.string().min(1).describe(
          "Signpost name or ceiling crux that caused the adapt",
        ),
        actionTaken: z.string().min(1),
        reason: z.string().min(1),
        reading: z.string().optional(),
        exercisedCeilingCrux: z.string().optional().describe(
          "If the action exercised a ceiling option, name the crux to mark it",
        ),
      }),
      execute: async (
        args: {
          triggeredBy: string;
          actionTaken: string;
          reason: string;
          reading?: string;
          exercisedCeilingCrux?: string;
        },
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "adapting", "adapt");

        const event: AdaptEvent = {
          at: now(),
          triggeredBy: args.triggeredBy,
          reason: args.reason,
          reading: args.reading,
          actionTaken: args.actionTaken,
          outcome: "committed",
        };

        const ceilings = args.exercisedCeilingCrux
          ? data.ceilings.map((c) =>
            c.crux === args.exercisedCeilingCrux
              ? { ...c, status: "exercised" as const }
              : c
          )
          : data.ceilings;

        const handle = await ctx.writeResource("state", "current", {
          ...data,
          state: "committed",
          ceilings,
          adaptHistory: [...data.adaptHistory, event],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    revise: {
      description:
        "adapting → drafted. An assumption has broken; the strategic " +
        "choice or its underlying model of reality must be re-planned. " +
        "Bumps planVersion. Call instead of `adapt` when the gap cannot " +
        "be closed by executing a pullback or option.",
      arguments: z.object({
        reason: z.string().min(1),
        brokenAssumptions: z.array(z.string()).default([]),
      }),
      execute: async (
        args: { reason: string; brokenAssumptions: string[] },
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, "adapting", "revise");

        ctx.logger.info("Revising plan v{v} → v{n}: {reason}", {
          v: data.planVersion,
          n: data.planVersion + 1,
          reason: args.reason,
        });

        const handle = await ctx.writeResource("state", "current", {
          ...data,
          state: "drafted",
          planVersion: data.planVersion + 1,
          reviseHistory: [
            ...data.reviseHistory,
            {
              at: now(),
              reason: args.reason,
              brokenAssumptions: args.brokenAssumptions,
            },
          ],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    archive: {
      description:
        "Terminal. committed or monitoring → archived. Plan is no longer " +
        "active; preserved for reference.",
      arguments: z.object({
        reason: z.string().default(""),
      }),
      execute: async (
        _args: { reason: string },
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        guardState(data.state, ["committed", "monitoring"], "archive");
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          state: "archived",
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    audit: {
      description:
        "Answer the four diagnostic questions from the article (Layer 4 " +
        "splits into ceiling + floor → five answers). Appends to audits[] " +
        "history. Read-only with respect to plan content; only adds an " +
        "audit record.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");
        const answers = auditDiagnosticQuestions(data);
        const review = {
          at: now(),
          ...answers,
          governabilityScore: governabilityScore(data),
        };
        ctx.logger.info(
          "Audit: L1={l1} L2={l2} L3={l3} L4-ceil={l4c} L4-floor={l4f} score={score}",
          {
            l1: answers.layer1Visible,
            l2: answers.layer2Aligned,
            l3: answers.layer3Coherent,
            l4c: answers.layer4CeilingPresent,
            l4f: answers.layer4FloorPresent,
            score: review.governabilityScore.toFixed(2),
          },
        );
        const handle = await ctx.writeResource("state", "current", {
          ...data,
          audits: [...data.audits, review],
          updatedAt: now(),
        });
        return { dataHandles: [handle] };
      },
    },

    hydrate: {
      description: "Write a compact governability scorecard summary. Does " +
        "NOT mutate the `state` resource — writes to `summary` only. " +
        "Idempotent.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ReadWriteCtx,
      ) => {
        const data = await readState(ctx);
        if (!data) throw new Error("No plan — run 'start' first");

        const hypotheses =
          data.commitments.filter((c) => c.kind === "hypothesis").length;
        const commitments = data.commitments.length - hypotheses;

        const summary: HydrateSummary = {
          state: data.state,
          planVersion: data.planVersion,
          strategicChoice: data.strategicChoice,
          horizon: data.horizon,
          layerCounts: {
            assumptions: data.assumptions.length,
            commitments,
            hypotheses,
            allocations: data.allocations.length,
            ceilings: data.ceilings.length,
            tripwires: data.tripwires.length,
          },
          governabilityScore: governabilityScore(data),
          firedTripwires:
            data.tripwires.filter((t) => t.state === "fired").length,
          brokenAssumptions:
            data.assumptions.filter((a) => a.state === "broken").length,
          exercisedCeilings:
            data.ceilings.filter((c) => c.status === "exercised").length,
          maxTolerableLossUsd: computeMaxTolerableLoss(data.lossBudget),
          totalProtectedBudgetUsd: data.allocations.reduce(
            (s, a) => s + a.protectedBudgetUsd,
            0,
          ),
          historyLength: data.adaptHistory.length + data.reviseHistory.length,
          snapshotAt: now(),
        };

        const handle = await ctx.writeResource(
          "summary",
          "hydrate",
          summary as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
