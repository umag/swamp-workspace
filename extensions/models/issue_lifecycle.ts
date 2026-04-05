// Copyright 2026 magistr. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "npm:zod@4";

// --- Schemas ---

const FindingSchema = z.object({
  reviewer: z.string(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  file: z.string().optional(),
  line: z.number().optional(),
  description: z.string(),
  fix: z.string().optional(),
  status: z.enum(["open", "resolved", "accepted", "wontfix"]).default("open"),
});

const ReviewResultSchema = z.object({
  reviewer: z.string(),
  verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
  findings: z.array(FindingSchema),
  timestamp: z.iso.datetime(),
});

const ReviewMatrixSchema = z.object({
  code: z.boolean().default(true),
  adversarial: z.boolean().default(true),
  security: z.boolean().default(false),
  ux: z.boolean().default(false),
  skill: z.boolean().default(false),
});

const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
  dddAnalysis: z.string().describe("DDD building blocks affected: aggregates, entities, value objects, services"),
  testStrategy: z.string().describe("TDD approach: what tests first, red-green-refactor sequence"),
  reviewMatrix: ReviewMatrixSchema,
});

const StateEnum = z.enum([
  "filed",
  "triaged",
  "planned",
  "reviewing",
  "approved",
  "implementing",
  "code_reviewing",
  "resolved",
  "complete",
  "closed",
]);

const IssueStateSchema = z.object({
  state: StateEnum,
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()).default([]),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  category: z.enum(["bug", "feature", "improvement", "refactor"]).optional(),
  affectedAreas: z.array(z.string()).default([]),
  plan: PlanSchema.optional(),
  reviews: z.array(ReviewResultSchema).default([]),
  branch: z.string().optional(),
  resolutions: z.record(z.string(), z.string()).default({}),
  closedReason: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

// --- Helpers ---

function now(): string {
  return new Date().toISOString();
}

function guardState(
  current: string,
  expected: string | string[],
  method: string,
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(current)) {
    throw new Error(
      `Cannot call '${method}' in state '${current}'. Expected: ${allowed.join(", ")}`,
    );
  }
}

function hasUnresolvedCritical(reviews: z.infer<typeof ReviewResultSchema>[]): boolean {
  return reviews.some((r) =>
    r.findings.some((f) => f.severity === "CRITICAL" && f.status === "open")
  );
}

// --- Model ---

export const model = {
  type: "@magistr/issue-lifecycle",
  version: "2026.04.05.1",

  globalArguments: z.object({}),

  resources: {
    state: {
      description: "Issue lifecycle state — persists across sessions",
      schema: IssueStateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
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
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
          definition: { name: string };
        },
      ) => {
        context.logger.info("Filing issue {title}", { title: args.title });

        const handle = await context.writeResource("state", "current", {
          state: "filed",
          title: args.title,
          description: args.description,
          labels: args.labels,
          affectedAreas: [],
          reviews: [],
          resolutions: {},
          createdAt: now(),
          updatedAt: now(),
        });

        context.logger.info("Issue filed as {name}", { name: context.definition.name });
        return { dataHandles: [handle] };
      },
    },

    triage: {
      description: "Triage the issue — set priority, category, affected areas. Use moldable-dev to investigate first.",
      arguments: z.object({
        priority: z.enum(["critical", "high", "medium", "low"]),
        category: z.enum(["bug", "feature", "improvement", "refactor"]),
        affectedAreas: z.array(z.string()),
      }),
      execute: async (
        args: { priority: string; category: string; affectedAreas: string[] },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "filed", "triage");

        context.logger.info("Triaging issue: priority={priority}, category={category}", {
          priority: args.priority,
          category: args.category,
        });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "triaged",
          priority: args.priority,
          category: args.category,
          affectedAreas: args.affectedAreas,
          updatedAt: now(),
        });

        context.logger.info("Issue triaged");
        return { dataHandles: [handle] };
      },
    },

    plan: {
      description: "Create implementation plan with DDD analysis and TDD test strategy. Both are required.",
      arguments: z.object({
        summary: z.string(),
        steps: z.array(z.string()),
        dddAnalysis: z.string().describe("Which aggregates, entities, value objects, and domain services are affected"),
        testStrategy: z.string().describe("What tests to write first, red-green-refactor sequence"),
        reviewMatrix: ReviewMatrixSchema.default({}),
      }),
      execute: async (
        args: {
          summary: string;
          steps: string[];
          dddAnalysis: string;
          testStrategy: string;
          reviewMatrix: z.infer<typeof ReviewMatrixSchema>;
        },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, ["triaged", "planned"], "plan");

        context.logger.info("Creating implementation plan: {summary}", { summary: args.summary });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "planned",
          plan: {
            summary: args.summary,
            steps: args.steps,
            dddAnalysis: args.dddAnalysis,
            testStrategy: args.testStrategy,
            reviewMatrix: args.reviewMatrix,
          },
          reviews: [],
          updatedAt: now(),
        });

        context.logger.info("Plan created — run review_plan to start reviews");
        return { dataHandles: [handle] };
      },
    },

    review_plan: {
      description: "Start plan review phase — triggers parallel review fan-out",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "planned", "review_plan");

        context.logger.info("Starting plan review phase");

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "reviewing",
          reviews: [],
          updatedAt: now(),
        });

        context.logger.info("Plan review started — invoke review skills and record findings via record_review");
        return { dataHandles: [handle] };
      },
    },

    record_review: {
      description: "Record one reviewer's findings. Call once per review skill.",
      arguments: z.object({
        reviewer: z.string().describe("Skill name: review-code, review-adversarial, review-security, review-ux, review-skill"),
        verdict: z.enum(["PASS", "FAIL", "SUGGEST_CHANGES"]),
        findings: z.array(FindingSchema).default([]),
      }),
      execute: async (
        args: {
          reviewer: string;
          verdict: string;
          findings: z.infer<typeof FindingSchema>[];
        },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, ["reviewing", "code_reviewing"], "record_review");

        context.logger.info("Recording review from {reviewer}: {verdict}", {
          reviewer: args.reviewer,
          verdict: args.verdict,
        });

        const review: z.infer<typeof ReviewResultSchema> = {
          reviewer: args.reviewer,
          verdict: args.verdict as "PASS" | "FAIL" | "SUGGEST_CHANGES",
          findings: args.findings,
          timestamp: now(),
        };

        const handle = await context.writeResource("state", "current", {
          ...data,
          reviews: [...data.reviews, review],
          updatedAt: now(),
        });

        const total = data.reviews.length + 1;
        context.logger.info("Review recorded ({total} total)", { total });
        return { dataHandles: [handle] };
      },
    },

    approve_plan: {
      description: "Approve the plan after reviews. Requires no unresolved CRITICAL findings. NEVER auto-call — human must explicitly approve.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "reviewing", "approve_plan");

        if (hasUnresolvedCritical(data.reviews)) {
          throw new Error(
            "Cannot approve: unresolved CRITICAL findings exist. Resolve or reject the plan.",
          );
        }

        context.logger.info("Plan approved — proceed to implementation");

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "approved",
          updatedAt: now(),
        });

        return { dataHandles: [handle] };
      },
    },

    reject_plan: {
      description: "Reject the plan — returns to planned state for revision",
      arguments: z.object({
        reason: z.string(),
      }),
      execute: async (
        args: { reason: string },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "reviewing", "reject_plan");

        context.logger.info("Plan rejected: {reason}", { reason: args.reason });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "planned",
          reviews: [],
          updatedAt: now(),
        });

        context.logger.info("Plan returned to planned state — revise and re-submit");
        return { dataHandles: [handle] };
      },
    },

    implement: {
      description: "Start implementation — record branch name. Follow TDD: write failing test first.",
      arguments: z.object({
        branch: z.string(),
        description: z.string().default(""),
      }),
      execute: async (
        args: { branch: string; description: string },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "approved", "implement");

        context.logger.info("Starting implementation on branch {branch}", { branch: args.branch });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "implementing",
          branch: args.branch,
          updatedAt: now(),
        });

        context.logger.info("Implementation started — follow TDD: write failing test first");
        return { dataHandles: [handle] };
      },
    },

    review_code: {
      description: "Start code review phase — triggers parallel review fan-out based on reviewMatrix",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "implementing", "review_code");

        const matrix = data.plan?.reviewMatrix ?? { code: true, adversarial: true, security: false, ux: false, skill: false };
        const reviewers = Object.entries(matrix)
          .filter(([_, enabled]) => enabled)
          .map(([name]) => `review-${name}`);

        context.logger.info("Starting code review with {count} reviewers: {reviewers}", {
          count: reviewers.length,
          reviewers: reviewers.join(", "),
        });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "code_reviewing",
          reviews: [],
          updatedAt: now(),
        });

        context.logger.info("Code review started — invoke: {reviewers}", { reviewers: reviewers.join(", ") });
        return { dataHandles: [handle] };
      },
    },

    resolve_findings: {
      description: "Record resolution for review findings",
      arguments: z.object({
        resolutions: z.record(z.string(), z.string()).describe("Map of finding description → resolution action"),
      }),
      execute: async (
        args: { resolutions: Record<string, string> },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "code_reviewing", "resolve_findings");

        context.logger.info("Recording {count} finding resolutions", {
          count: Object.keys(args.resolutions).length,
        });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "resolved",
          resolutions: { ...data.resolutions, ...args.resolutions },
          updatedAt: now(),
        });

        context.logger.info("Findings resolved — call complete or iterate");
        return { dataHandles: [handle] };
      },
    },

    iterate: {
      description: "Go back to implementation — not all findings resolved satisfactorily",
      arguments: z.object({
        reason: z.string(),
      }),
      execute: async (
        args: { reason: string },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "resolved", "iterate");

        context.logger.info("Iterating: {reason}", { reason: args.reason });

        const handle = await context.writeResource("state", "current", {
          ...data,
          state: "implementing",
          updatedAt: now(),
        });

        context.logger.info("Back to implementation — address findings and re-review");
        return { dataHandles: [handle] };
      },
    },

    complete: {
      description: "Mark issue as complete — all reviews pass, implementation done",
      arguments: z.object({
        summary: z.string().default(""),
      }),
      execute: async (
        args: { summary: string },
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
        if (!data) throw new Error("No issue state found — run 'start' first");
        guardState(data.state, "resolved", "complete");

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
        context: {
          logger: { info: (msg: string, data?: Record<string, unknown>) => void };
          readResource: ((name: string) => Promise<Record<string, unknown> | null>) | undefined;
          writeResource: (spec: string, name: string, data: unknown) => Promise<unknown>;
        },
      ) => {
        const data = await context.readResource!("current") as z.infer<typeof IssueStateSchema> | null;
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
  },
};
