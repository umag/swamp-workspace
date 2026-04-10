// Copyright 2026 magistr. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "npm:zod@4";

// ============================================================================
// Schemas
// ============================================================================

export const CategoryEnum = z.enum([
  "bug",
  "feature",
  "improvement",
  "refactor",
  "security",
]);

export const ConfidenceEnum = z.enum(["high", "medium", "low"]);

export const ReproducedSchema = z.object({
  status: z.enum(["reproduced", "could-not-reproduce", "not-applicable"]),
  notes: z.string().optional(),
});

export const TriageDetailSchema = z.object({
  confidence: ConfidenceEnum.optional(),
  reasoning: z.string().optional(),
  isRegression: z.boolean().optional(),
  clarifyingQuestions: z.array(z.string()).default([]),
  reproduced: ReproducedSchema.optional(),
});

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

export const ReviewResultSchema = z.object({
  reviewer: z.string(),
  verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
  findings: z.array(FindingSchema),
  timestamp: z.iso.datetime(),
});

export const ReviewMatrixSchema = z.object({
  code: z.boolean().default(true),
  adversarial: z.boolean().default(true),
  security: z.boolean().default(false),
  ux: z.boolean().default(false),
  skill: z.boolean().default(false),
});

// Plan steps: legacy bare strings OR new rich objects. Union for backward compat.
export const PlanStepSchema = z.union([
  z.string(),
  z.object({
    order: z.number().int().positive(),
    description: z.string(),
    files: z.array(z.string()).default([]),
    risks: z.string().optional(),
  }),
]);

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

// Prior-art lookup (Phase 2 entry side)
export const UatScenarioRefSchema = z.object({
  path: z.string(),
  summary: z.string(),
  reusable: z.boolean().default(true),
});

export const KbEntryRefSchema = z.object({
  path: z.string(),
  summary: z.string(),
});

export const PriorArtSchema = z.object({
  uatScenarios: z.array(UatScenarioRefSchema).default([]),
  kbEntries: z.array(KbEntryRefSchema).default([]),
  searchedAt: z.iso.datetime(),
});

// Harvest proposals (Phase 6 exit side)
export const UatProposalSchema = z.object({
  scenario: z.string(),
  rationale: z.string(),
  path: z.string().optional(),
  committed: z.boolean().default(false),
});

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

export const HarvestSchema = z.object({
  uatProposals: z.array(UatProposalSchema).default([]),
  kbProposals: z.array(KbProposalSchema).default([]),
  harvestedAt: z.iso.datetime(),
});

// Compact summary written by `hydrate` for the autonomous loop. Lives in its
// own `summary` resource (not `state`) so it has no shape overlap with the
// main IssueStateSchema and mutation of one can never corrupt the other.
export const HydrateSummarySchema = z.object({
  state: z.string(),
  planVersion: z.number().int().nonnegative(),
  planIterationsThisVersion: z.number().int().nonnegative(),
  codeReviewIteration: z.number().int().nonnegative(),
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

export const StateEnum = z.enum([
  "filed",
  "triaged",
  "planned",
  "reviewing",
  "approved",
  "implementing",
  "code_reviewing",
  "resolved",
  "harvested",
  "complete",
  "closed",
]);

// Append-only audit entry for every completed review round
export const ReviewRoundSchema = z.object({
  phase: z.enum(["plan_review", "code_review"]),
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
  ]),
  rejectReason: z.string().optional(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
});

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
  codeReviewIteration: z.number().int().positive().default(1),
  branch: z.string().optional(),
  resolutions: z.record(z.string(), z.string()).default({}),
  harvest: HarvestSchema.optional(),
  closedReason: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reviewRoundStartedAt: z.iso.datetime().optional(),
});

export type IssueState = z.infer<typeof IssueStateSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewMatrix = z.infer<typeof ReviewMatrixSchema>;
export type ReviewRound = z.infer<typeof ReviewRoundSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// ============================================================================
// Helpers (exported for tests)
// ============================================================================

export function now(): string {
  return new Date().toISOString();
}

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
  phase: "plan_review" | "code_review",
  outcome: ReviewRound["outcome"],
  rejectReason: string | undefined,
  startedAt: string,
): ReviewRound {
  const iteration = phase === "plan_review"
    ? data.reviewHistory.filter(
      (r) => r.phase === "plan_review" && r.planVersion === data.planVersion,
    ).length + 1
    : data.codeReviewIteration;
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
  // Parse through the schema so defaults fill in for legacy instances
  return IssueStateSchema.parse(raw);
}

export const model = {
  type: "@magistr/issue-lifecycle",
  version: "2026.04.09.1",

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
  },

  methods: {
    start: {
      description: "File a new issue — creates initial state",
      arguments: z.object({
        title: z.string(),
        description: z.string(),
        labels: z.array(z.string()).default([]),
      }),
      execute: async (
        args: { title: string; description: string; labels: string[] },
        context: DefinitionCtx,
      ) => {
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
          ["reviewing", "code_reviewing"],
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

        const handle = await context.writeResource("state", "current", {
          ...data,
          reviews: [...data.reviews, review],
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    approve_plan: {
      description:
        "Approve the plan. Requires (a) all reviewers in the matrix have " +
        "recorded a result for this round AND (b) zero open CRITICAL and " +
        "zero open HIGH findings. NEVER auto-call — human must explicitly approve.",
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
        "Start implementation — record branch name. Follow TDD: write failing test first.",
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
          state: "implementing",
          branch: args.branch,
          updatedAt: now(),
        });

        context.logger.info(
          "Implementation started — follow TDD: write failing test first",
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
        guardState(data.state, "implementing", "review_code");

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
        "resolutions map. Transitions code_reviewing → resolved.",
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

        context.logger.info("Recording {count} finding resolutions", {
          count: Object.keys(args.resolutions).length,
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
          resolutions: { ...data.resolutions, ...args.resolutions },
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
        guardState(data.state, "resolved", "harvest");

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
        guardState(data.state, ["resolved", "harvested"], "complete");

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

        const summary = {
          state: data.state,
          planVersion: data.planVersion,
          planIterationsThisVersion,
          codeReviewIteration: data.codeReviewIteration,
          blocking,
          coverage,
          historyLength: data.reviewHistory.length,
          signature: findingSignature(data.reviews),
          snapshotAt: now(),
        };

        context.logger.info(
          "Hydrate: state={state}, planV={planV}, blocking={blocking}, coverage={coverage}",
          {
            state: summary.state,
            planV: summary.planVersion,
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
