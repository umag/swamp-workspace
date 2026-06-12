// @magistr/swamp-go-brr/gobrr — a PURE host-side orchestrator for an autonomous
// development loop. A Run aggregate over a dynamic Task DAG. All decision logic
// lives in the exported pure helpers below (unit-tested with no subprocess); the
// model `methods` are thin wrappers that read the `run` resource, call a helper,
// and write the new version. No Deno.Command, no cross-model reads — report()
// receives the WorkResult + verify exit code as arguments.
import { z } from "npm:zod@4";
// Pure path-ACL kernel, shared with the source-integration model. gobrr imports
// ONLY these pure string helpers (no filesystem I/O) — its purity is unaffected.
import { pathEscapes, pathInSet } from "./lib/acl.ts";
export { normalizePath, pathEscapes, pathInSet } from "./lib/acl.ts";

// ───────────────────────────── value objects ─────────────────────────────

export const GateEnum = z.enum(["real", "advisory"]);

// One shared outcome vocabulary across next()/report()/complete.
export const OutcomeEnum = z.enum([
  "done",
  "test_failed",
  "exhausted",
  "infra_error",
  "merge_conflict",
  "waiting_followup",
  "blocked",
]);

export const FailureKindEnum = z.enum([
  "envelope_parse", // stdout was not a well-formed nonce-fenced envelope
  "envelope_oversize", // stdout exceeded the size contract
  "nonce_mismatch", // fence nonce did not match — possible forgery
  "claude_error", // the guest's `claude --print` exited non-zero (ERROR: prefix)
  "out_of_allowlist", // a diff hunk targeted a path outside the write allowlist
  "unsafe_change", // a denied control path / symlink / gitlink / mode change — possible attack
  "transport", // collect_result / boot / ssh failure
]);

export const MergeDispositionEnum = z.enum([
  "clean",
  "conflict-resolved",
  "conflict-unresolved",
]);

export const LeaseSchema = z.object({
  owner: z.string(),
  expiresAt: z.string(), // ISO-8601
  heartbeatAt: z.string(),
  vmId: z.string().optional(),
});

export const TestReportSchema = z.object({
  // advisory — self-reported by the agent, NEVER the gate.
  redFirst: z.boolean().optional(),
  testsRun: z.number().optional(),
  note: z.string().optional(),
});

export const FollowupSchema = z.object({
  spec: z.string(),
  writeAllowlist: z.array(z.string()),
});

export const WorkResultSchema = z.object({
  diff: z.string().default(""),
  changedPaths: z.array(z.string()).default([]),
  testReport: TestReportSchema.optional(),
  followups: z.array(FollowupSchema).default([]),
  note: z.string().optional(),
  failureKind: FailureKindEnum.optional(),
});

export const RunConfigSchema = z.object({
  verifyCommand: z.string(), // host-pinned test command (the gate)
  verifyInputs: z.array(z.string()), // complete verify surface (tree globs)
  repoScope: z.string(), // the human-confirmed jj repo/path; followups bounded to it
  toolchainImage: z.string(), // digest-pinned image for docker-verify
  leafModel: z.string().default(""), // model id for the leaf `claude --print` ("" = substrate default)
  leafEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"), // claude --print --effort (matches fc-task-server inject_task)
  maxConcurrentVMs: z.number().default(5), // each FC instance has its own socket; resource guard, not a substrate limit
  maxAttempts: z.number().default(2),
  maxFollowupDepth: z.number().default(3),
  maxInvocations: z.number().default(100),
  leaseTtlSeconds: z.number().default(1800),
  wallclockSeconds: z.number().default(7200),
  stallN: z.number().default(2), // failureSignature repeats
  stallK: z.number().default(3), // no `done` in last K offers
  perInvocationCostEstimate: z.number().default(0), // advisory only
  pinnedVersions: z.record(z.string(), z.string()).default({}),
});

export const TaskStatusEnum = z.enum([
  "pending",
  "leased",
  "waiting_followup",
  "done",
  "test_failed",
  "exhausted",
  "infra_error",
  "merge_conflict",
  "blocked",
]);

export const TaskSchema = z.object({
  id: z.string(),
  spec: z.string(),
  writeAllowlist: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
  gate: GateEnum, // derived from writeAllowlist ∩ verifyInputs at creation
  status: TaskStatusEnum.default("pending"),
  attempts: z.number().default(0),
  followupDepth: z.number().default(0),
  lease: LeaseSchema.nullable().default(null),
  outcome: OutcomeEnum.nullable().default(null),
  failureKind: FailureKindEnum.nullable().default(null),
  failureSignature: z.string().nullable().default(null),
  mergeDisposition: MergeDispositionEnum.nullable().default(null),
  createdAt: z.string(),
});

export const RunStatusEnum = z.enum(["running", "halted", "complete"]);

export const RunSchema = z.object({
  status: RunStatusEnum.default("running"),
  intake: z.string(), // the human input that seeded the run
  config: RunConfigSchema,
  tasks: z.array(TaskSchema).default([]),
  invocations: z.number().default(0),
  costEstimate: z.number().default(0),
  offers: z.array(z.string()).default([]), // recent task ids offered (for stall)
  haltReason: z.string().nullable().default(null),
  haltOptions: z.array(z.string()).default([]),
  stallCulprits: z.array(z.string()).default([]),
  stallSignature: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ───────────────────────── mirror interfaces (bridge) ─────────────────────
// Kept structurally identical to the schemas; drift surfaces as a `deno check`
// failure at the `as` casts in readRun / the bridge test.

export type Gate = "real" | "advisory";
export type Outcome = z.infer<typeof OutcomeEnum>;
export type FailureKind = z.infer<typeof FailureKindEnum>;
export type MergeDisposition = z.infer<typeof MergeDispositionEnum>;
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export interface Lease {
  owner: string;
  expiresAt: string;
  heartbeatAt: string;
  vmId?: string;
}
export interface Followup {
  spec: string;
  writeAllowlist: string[];
}
export interface WorkResult {
  diff: string;
  changedPaths: string[];
  testReport?: { redFirst?: boolean; testsRun?: number; note?: string };
  followups: Followup[];
  note?: string;
  failureKind?: FailureKind;
}
export interface RunConfig {
  verifyCommand: string;
  verifyInputs: string[];
  repoScope: string;
  toolchainImage: string;
  leafModel: string;
  leafEffort: "low" | "medium" | "high" | "xhigh" | "max";
  maxConcurrentVMs: number;
  maxAttempts: number;
  maxFollowupDepth: number;
  maxInvocations: number;
  leaseTtlSeconds: number;
  wallclockSeconds: number;
  stallN: number;
  stallK: number;
  perInvocationCostEstimate: number;
  pinnedVersions: Record<string, string>;
}
export interface Task {
  id: string;
  spec: string;
  writeAllowlist: string[];
  dependsOn: string[];
  gate: Gate;
  status: TaskStatus;
  attempts: number;
  followupDepth: number;
  lease: Lease | null;
  outcome: Outcome | null;
  failureKind: FailureKind | null;
  failureSignature: string | null;
  mergeDisposition: MergeDisposition | null;
  createdAt: string;
}
export interface Run {
  status: "running" | "halted" | "complete";
  intake: string;
  config: RunConfig;
  tasks: Task[];
  invocations: number;
  costEstimate: number;
  offers: string[];
  haltReason: string | null;
  haltOptions: string[];
  stallCulprits: string[];
  stallSignature: string | null;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────── pure helpers ──────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

/**
 * Derive the gate for a task from its write allowlist vs the host-pinned verify
 * input surface. Disjoint → "real"; subset of verifyInputs → "advisory"; a MIXED
 * allowlist (spans both) is rejected — the decomposer must split it. This is the
 * mechanical test/code split that makes the gate unforgeable in the common case.
 */
export function deriveGate(
  writeAllowlist: string[],
  verifyInputs: string[],
): { gate: Gate } | { error: string } {
  if (writeAllowlist.length === 0) return { error: "empty writeAllowlist" };
  const inVerify = writeAllowlist.filter((p) => pathInSet(p, verifyInputs));
  const outVerify = writeAllowlist.filter((p) => !pathInSet(p, verifyInputs));
  if (inVerify.length > 0 && outVerify.length > 0) {
    return {
      error:
        "mixed allowlist: spans production and verifyInputs — split into a " +
        "code task and a test task",
    };
  }
  return { gate: inVerify.length > 0 ? "advisory" : "real" };
}

/** Detect a dependency cycle in the task DAG. */
export function hasCycle(tasks: Task[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(tasks.map((t) => [t.id, WHITE]));
  const visit = (id: string): boolean => {
    color.set(id, GREY);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const c = color.get(dep);
      if (c === GREY) return true;
      if (c === WHITE && visit(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const t of tasks) {
    if (color.get(t.id) === WHITE && visit(t.id)) return true;
  }
  return false;
}

/** Would adding `from depends on to` create a path `to → … → from` (a cycle)? */
export function wouldCycle(
  tasks: Task[],
  fromId: string,
  toId: string,
): boolean {
  if (fromId === toId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const reaches = (id: string): boolean => {
    if (id === fromId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.dependsOn ?? []).some(reaches);
  };
  return reaches(toId);
}

const TERMINAL_OK: TaskStatus[] = ["done"];

/** A pending task is ready when every dependency is `done`. */
export function readyTaskIds(run: Run): string[] {
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  return run.tasks
    .filter((t) =>
      t.status === "pending" &&
      t.dependsOn.every((d) =>
        TERMINAL_OK.includes(byId.get(d)?.status as TaskStatus)
      )
    )
    .map((t) => t.id)
    .sort(); // total order by id for reproducible resume
}

export function leaseExpired(lease: Lease | null, nowTs: string): boolean {
  if (!lease) return true;
  return nowTs > lease.expiresAt;
}

export function leasedCount(run: Run): number {
  return run.tasks.filter((t) => t.status === "leased").length;
}

/**
 * Insert a follow-up as a new pending Task that `parent` now depends on. The
 * follow-up is an UNTRUSTED request: bounded to the run's repoScope, depth-capped,
 * and rejected if it would create a cycle. The parent parks in `waiting_followup`.
 */
export function addFollowup(
  run: Run,
  parentId: string,
  spec: string,
  writeAllowlist: string[],
  nowTs: string,
): { run: Run } | { error: string } {
  const parent = run.tasks.find((t) => t.id === parentId);
  if (!parent) return { error: `unknown parent ${parentId}` };
  const depth = parent.followupDepth + 1;
  if (depth > run.config.maxFollowupDepth) {
    return {
      error:
        `follow-up depth ${depth} exceeds cap ${run.config.maxFollowupDepth}`,
    };
  }
  if (
    writeAllowlist.some((p) =>
      pathEscapes(p) || !pathInSet(p, [run.config.repoScope])
    )
  ) {
    return { error: "follow-up writeAllowlist escapes the run's repoScope" };
  }
  const g = deriveGate(writeAllowlist, run.config.verifyInputs);
  if ("error" in g) return { error: g.error };
  const fid = `${parentId}.f${parent.dependsOn.length + 1}`;
  const followup: Task = {
    id: fid,
    spec,
    writeAllowlist,
    dependsOn: [],
    gate: g.gate,
    status: "pending",
    attempts: 0,
    followupDepth: depth,
    lease: null,
    outcome: null,
    failureKind: null,
    failureSignature: null,
    mergeDisposition: null,
    createdAt: nowTs,
  };
  const tasks = run.tasks.map((t) =>
    t.id === parentId
      ? {
        ...t,
        dependsOn: [...t.dependsOn, fid],
        status: "waiting_followup" as TaskStatus,
        lease: null,
      }
      : t
  );
  tasks.push(followup);
  if (wouldCycle(tasks, parentId, fid)) {
    return { error: "follow-up would create a dependency cycle" };
  }
  return { run: { ...run, tasks, updatedAt: nowTs } };
}

/**
 * The green gate. Validates lease ownership, enforces the gated-tree allowlist
 * (a code task may not touch verifyInputs; nothing may escape the allowlist),
 * then greens ONLY on verifyExitCode===0 — never on the agent's self-report.
 */
export function applyReport(
  run: Run,
  taskId: string,
  owner: string,
  result: WorkResult,
  verifyExitCode: number,
  nowTs: string,
): { run: Run } | { error: string } {
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task) return { error: `unknown task ${taskId}` };
  if (task.status !== "leased") return { error: `task ${taskId} not leased` };
  if (!task.lease || task.lease.owner !== owner) {
    return { error: `lease owner mismatch for ${taskId}` };
  }
  if (leaseExpired(task.lease, nowTs)) {
    return { error: `lease expired for ${taskId}` };
  }

  const finalize = (patch: Partial<Task>): { run: Run } => ({
    run: {
      ...run,
      tasks: run.tasks.map((
        t,
      ) => (t.id === taskId ? { ...t, lease: null, ...patch } : t)),
      offers: run.offers,
      updatedAt: nowTs,
    },
  });

  // Parse/transport failure: infra_error, does NOT consume an attempt.
  if (result.failureKind) {
    return finalize({
      status: "infra_error",
      outcome: "infra_error",
      failureKind: result.failureKind,
    });
  }

  // Allowlist enforcement (gated-tree invariant). Escapes and, for a real-gate
  // (code) task, any verifyInputs edit are hard-rejected as out_of_allowlist.
  for (const p of result.changedPaths) {
    const escapes = pathEscapes(p) || !pathInSet(p, task.writeAllowlist);
    const touchesVerify = task.gate === "real" &&
      pathInSet(p, run.config.verifyInputs);
    if (escapes || touchesVerify) {
      return finalize({
        status: "infra_error",
        outcome: "infra_error",
        failureKind: "out_of_allowlist",
      });
    }
  }

  // Deterministic green gate — exit code only.
  if (verifyExitCode === 0) {
    return finalize({
      status: "done",
      outcome: "done",
      mergeDisposition: "clean",
    });
  }

  // Test failure → retry until maxAttempts, then exhausted.
  const attempts = task.attempts + 1;
  const sig = `${taskId}:exit${verifyExitCode}`;
  if (attempts >= run.config.maxAttempts) {
    return finalize({
      status: "exhausted",
      outcome: "exhausted",
      attempts,
      failureSignature: sig,
    });
  }
  return finalize({
    status: "pending",
    outcome: "test_failed",
    attempts,
    failureSignature: sig,
  });
}

export interface NextDecision {
  outcome:
    | "leased"
    | "all-green"
    | "exhausted"
    | "blocked"
    | "stalled"
    | "infra_error";
  taskId?: string;
  cap?: "wallclock" | "invocations" | "concurrency";
  reason: string;
}

/** Enumerated, actionable next-step options per halt cause. */
export function haltOptionsFor(cause: NextDecision["outcome"]): string[] {
  switch (cause) {
    case "exhausted":
      return [
        "1. Inspect the exhausted task's failureSignature and widen its spec or writeAllowlist",
        "2. Raise maxAttempts in RunConfig and resume",
        "3. Mark the task accepted and continue without it",
      ];
    case "stalled":
      return [
        "1. Read the stallCulprits + decoded stallSignature; the same failure repeats",
        "2. Re-scope the culprit task(s) — the current approach cannot pass the gate",
        "3. Abort the run and re-decompose",
      ];
    case "blocked":
      return [
        "1. A dependency is exhausted/infra — resolve or accept it to unblock descendants",
        "2. Re-plan the blocked subtree",
      ];
    case "infra_error":
      return [
        "1. Check the firecracker/docker-verify host + pinned versions (fail-closed mismatch?)",
        "2. Re-run; infra_error does not consume task attempts",
      ];
    default:
      return [];
  }
}

// Envelope parsing moved to the source-integration model (the host code-ownership
// actor): it owns the @@EDIT wire format + the nonce-fence forgery defense, parses
// the leaf output, and hands gobrr a structured WorkResult via `report`. gobrr
// stays pure — it never parses untrusted stdout.

// ───────────────────────── scheduler decision ────────────────────────────

const BAD_STATUSES: TaskStatus[] = [
  "exhausted",
  "infra_error",
  "merge_conflict",
  "blocked",
];

export function elapsedSeconds(fromIso: string, nowIso: string): number {
  return (Date.parse(nowIso) - Date.parse(fromIso)) / 1000;
}

function addSeconds(iso: string, secs: number): string {
  return new Date(Date.parse(iso) + secs * 1000).toISOString();
}

/** Propagate `blocked` to descendants of any terminally-bad task (fixpoint). */
export function markBlocked(tasks: Task[]): Task[] {
  let cur = tasks;
  for (let pass = 0; pass < tasks.length + 1; pass++) {
    const byId = new Map(cur.map((t) => [t.id, t]));
    let changed = false;
    const next = cur.map((t) => {
      if (
        (t.status === "pending" || t.status === "waiting_followup") &&
        t.dependsOn.some((d) =>
          BAD_STATUSES.includes(byId.get(d)?.status as TaskStatus)
        )
      ) {
        changed = true;
        return {
          ...t,
          status: "blocked" as TaskStatus,
          outcome: "blocked" as Outcome,
          lease: null,
        };
      }
      return t;
    });
    cur = next;
    if (!changed) break;
  }
  return cur;
}

export function detectStall(
  run: Run,
): { stalled: boolean; culprits: string[]; signature: string | null } {
  const recent = run.offers.slice(-run.config.stallK);
  if (recent.length < run.config.stallK) {
    return { stalled: false, culprits: [], signature: null };
  }
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  const doneInWindow = recent.some((id) => byId.get(id)?.status === "done");
  if (doneInWindow) return { stalled: false, culprits: [], signature: null };
  const culprits = [...new Set(recent)].filter((id) =>
    byId.get(id)?.status !== "done"
  );
  const signature = culprits
    .map((id) => byId.get(id)?.failureSignature)
    .filter(Boolean)
    .join(";");
  return { stalled: true, culprits, signature: signature || null };
}

/**
 * Decide the next action and (when leasing) return the mutated run. Reaps
 * expired leases, propagates `blocked`, enforces wallclock + invocation +
 * concurrency caps, then leases the lowest-id ready task to `owner`.
 */
export function nextDecision(
  run: Run,
  owner: string,
  nowTs: string,
): { decision: NextDecision; run: Run } {
  let tasks = run.tasks.map((t) => {
    if (t.status === "leased" && leaseExpired(t.lease, nowTs)) {
      const attempts = t.attempts + 1;
      if (attempts >= run.config.maxAttempts) {
        return {
          ...t,
          status: "exhausted" as TaskStatus,
          outcome: "exhausted" as Outcome,
          lease: null,
          attempts,
        };
      }
      return {
        ...t,
        status: "pending" as TaskStatus,
        lease: null,
        attempts,
        failureSignature: t.id + ":lease_expired",
      };
    }
    return t;
  });
  tasks = markBlocked(tasks);
  let r: Run = { ...run, tasks, updatedAt: nowTs };

  const halt = (
    cap: NextDecision["cap"],
    outcome: NextDecision["outcome"],
    reason: string,
  ): { decision: NextDecision; run: Run } => {
    const options = haltOptionsFor(outcome);
    return {
      decision: { outcome, cap, reason },
      run: {
        ...r,
        status: "halted",
        haltReason: reason,
        haltOptions: options,
        updatedAt: nowTs,
      },
    };
  };

  if (r.tasks.length > 0 && r.tasks.every((t) => t.status === "done")) {
    return {
      decision: { outcome: "all-green", reason: "all tasks done" },
      run: r,
    };
  }
  if (elapsedSeconds(r.createdAt, nowTs) > r.config.wallclockSeconds) {
    return halt("wallclock", "blocked", "wallclock cap exceeded");
  }
  if (r.invocations >= r.config.maxInvocations) {
    return halt("invocations", "blocked", "invocation cap reached");
  }

  const ready = readyTaskIds(r);
  if (ready.length > 0 && leasedCount(r) < r.config.maxConcurrentVMs) {
    const tid = ready[0];
    const lease: Lease = {
      owner,
      expiresAt: addSeconds(nowTs, r.config.leaseTtlSeconds),
      heartbeatAt: nowTs,
    };
    r = {
      ...r,
      tasks: r.tasks.map((
        t,
      ) => (t.id === tid ? { ...t, status: "leased", lease } : t)),
      invocations: r.invocations + 1,
      costEstimate: r.costEstimate + r.config.perInvocationCostEstimate,
      offers: [...r.offers, tid],
      updatedAt: nowTs,
    };
    return {
      decision: { outcome: "leased", taskId: tid, reason: "leased " + tid },
      run: r,
    };
  }
  if (leasedCount(r) > 0) {
    return {
      decision: { outcome: "leased", reason: "task(s) in flight" },
      run: r,
    };
  }

  const stall = detectStall(r);
  if (stall.stalled) {
    return {
      decision: {
        outcome: "stalled",
        reason: "no progress in last " + r.config.stallK + " offers",
      },
      run: {
        ...r,
        status: "halted",
        haltReason: "stalled",
        haltOptions: haltOptionsFor("stalled"),
        stallCulprits: stall.culprits,
        stallSignature: stall.signature,
        updatedAt: nowTs,
      },
    };
  }
  if (r.tasks.some((t) => t.status === "exhausted")) {
    return halt(
      undefined,
      "exhausted",
      "a task is exhausted and blocks the run",
    );
  }
  return halt(
    undefined,
    "blocked",
    "remaining tasks blocked on failed dependencies",
  );
}

// ───────────────────────── reporting projections ─────────────────────────

export function completeReport(run: Run): Record<string, unknown> {
  const buckets: Record<string, number> = {
    done: 0,
    test_failed: 0,
    exhausted: 0,
    infra_error: 0,
    merge_conflict: 0,
    blocked: 0,
    waiting_followup: 0,
    pending: 0,
    leased: 0,
  };
  for (const t of run.tasks) buckets[t.status] = (buckets[t.status] ?? 0) + 1;
  return {
    status: run.status,
    haltReason: run.haltReason,
    haltOptions: run.haltOptions,
    buckets,
    tasks: run.tasks.map((t) => ({
      id: t.id,
      status: t.status,
      gate: t.gate,
      attempts: t.attempts,
      maxAttempts: run.config.maxAttempts,
      mergeDisposition: t.mergeDisposition,
      failureKind: t.failureKind,
      failureSignature: t.failureSignature,
    })),
    stallCulprits: run.stallCulprits,
    stallSignature: run.stallSignature,
    invocations: run.invocations,
    costEstimate: run.costEstimate,
    costNote:
      "advisory estimate — only wallclock + invocation count are enforced",
  };
}

export function hydrateSummary(run: Run): Record<string, unknown> {
  const r = completeReport(run);
  return {
    status: run.status,
    haltReason: run.haltReason,
    haltOptions: run.haltOptions,
    buckets: (r as { buckets: Record<string, number> }).buckets,
    invocations: run.invocations,
    maxInvocations: run.config.maxInvocations,
    leased: run.tasks.filter((t) => t.status === "leased").map((t) => ({
      id: t.id,
      vmId: t.lease?.vmId ?? null,
    })),
    waitingFollowups: run.tasks.filter((t) => t.status === "waiting_followup")
      .map((t) => t.id),
    stallCulprits: run.stallCulprits,
    stallSignature: run.stallSignature,
    costEstimate: run.costEstimate,
    snapshotAt: run.updatedAt,
  };
}

// ───────────────────────────── the model ─────────────────────────────────

type Ctx = {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  readResource:
    | ((name: string) => Promise<Record<string, unknown> | null>)
    | undefined;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  definition: { name: string };
};

async function readRun(context: Ctx): Promise<Run | null> {
  const raw = await context.readResource!("current");
  if (!raw) return null;
  return RunSchema.parse(raw) as Run;
}

function persist(context: Ctx, run: Run): Promise<unknown> {
  return context.writeResource(
    "run",
    "current",
    run as unknown as Record<string, unknown>,
  );
}

/** @internal — recursively references private Zod internals; call via the CLI. */
export const model = {
  type: "@magistr/swamp-go-brr/gobrr",
  version: "2026.06.12.1",
  globalArguments: z.object({}),

  resources: {
    run: {
      description:
        "Authoritative Run aggregate — the Task DAG + scheduler state.",
      schema: RunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    summary: {
      description:
        "Compact hydrate summary — derived from `run`, cheap to read.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    decision: {
      description:
        "The most recent next() decision — which task to run, or why halted.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    start: {
      description:
        "Start a run: record the human intake + the host-pinned RunConfig (verifyCommand, verifyInputs, repoScope, caps).",
      arguments: z.object({ intake: z.string(), config: RunConfigSchema }),
      execute: async (
        args: { intake: string; config: z.infer<typeof RunConfigSchema> },
        context: Ctx,
      ) => {
        const ts = now();
        const run: Run = {
          status: "running",
          intake: args.intake,
          config: args.config as RunConfig,
          tasks: [],
          invocations: 0,
          costEstimate: 0,
          offers: [],
          haltReason: null,
          haltOptions: [],
          stallCulprits: [],
          stallSignature: null,
          createdAt: ts,
          updatedAt: ts,
        };
        context.logger.info("Run started for {name}", {
          name: context.definition.name,
        });
        return { dataHandles: [await persist(context, run)] };
      },
    },

    seed_tasks: {
      description:
        "Add tasks to the DAG (batch). Derives each gate from writeAllowlist ∩ verifyInputs (rejects a mixed allowlist) and rejects a dependency cycle.",
      arguments: z.object({
        tasks: z.array(z.object({
          id: z.string(),
          spec: z.string(),
          writeAllowlist: z.array(z.string()),
          dependsOn: z.array(z.string()).default([]),
        })),
      }),
      execute: async (
        args: {
          tasks: Array<
            {
              id: string;
              spec: string;
              writeAllowlist: string[];
              dependsOn: string[];
            }
          >;
        },
        context: Ctx,
      ) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const ts = now();
        const added: Task[] = [];
        for (const t of args.tasks) {
          const g = deriveGate(t.writeAllowlist, run.config.verifyInputs);
          if ("error" in g) throw new Error(`task ${t.id}: ${g.error}`);
          added.push({
            id: t.id,
            spec: t.spec,
            writeAllowlist: t.writeAllowlist,
            dependsOn: t.dependsOn,
            gate: g.gate,
            status: "pending",
            attempts: 0,
            followupDepth: 0,
            lease: null,
            outcome: null,
            failureKind: null,
            failureSignature: null,
            mergeDisposition: null,
            createdAt: ts,
          });
        }
        const tasks = [...run.tasks, ...added];
        if (hasCycle(tasks)) {
          throw new Error("seed_tasks would create a dependency cycle");
        }
        context.logger.info("Seeded {n} task(s)", { n: added.length });
        return {
          dataHandles: [
            await persist(context, { ...run, tasks, updatedAt: ts }),
          ],
        };
      },
    },

    next: {
      description:
        "Lease the next ready task to `owner` (or report all-green / halt). Reaps expired leases, propagates blocked, enforces caps.",
      arguments: z.object({ owner: z.string() }),
      execute: async (args: { owner: string }, context: Ctx) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const { decision, run: next } = nextDecision(run, args.owner, now());
        context.logger.info("next → {outcome} {taskId}", {
          outcome: decision.outcome,
          taskId: decision.taskId ?? "",
        });
        const h1 = await persist(context, next);
        const h2 = await context.writeResource(
          "decision",
          "decision",
          decision as unknown as Record<string, unknown>,
        );
        return { dataHandles: [h1, h2] };
      },
    },

    report: {
      description:
        "Report a leased task's WorkResult + the deterministic verify exit code. Greens ONLY on verifyExitCode===0; rejects out-of-allowlist / verifyInputs hunks; parse-fail → infra_error.",
      arguments: z.object({
        taskId: z.string(),
        owner: z.string(),
        workResult: WorkResultSchema,
        verifyExitCode: z.number(),
      }),
      execute: async (
        args: {
          taskId: string;
          owner: string;
          workResult: z.infer<typeof WorkResultSchema>;
          verifyExitCode: number;
        },
        context: Ctx,
      ) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const res = applyReport(
          run,
          args.taskId,
          args.owner,
          args.workResult as WorkResult,
          args.verifyExitCode,
          now(),
        );
        if ("error" in res) throw new Error(res.error);
        context.logger.info("report {taskId} → {outcome}", {
          taskId: args.taskId,
          outcome: res.run.tasks.find((t) => t.id === args.taskId)?.outcome ??
            "",
        });
        return { dataHandles: [await persist(context, res.run)] };
      },
    },

    add_followup: {
      description:
        "Insert a follow-up the leased parent depends on (untrusted request: repoScope-bound, depth-capped, cycle-rejected).",
      arguments: z.object({
        parentId: z.string(),
        owner: z.string(),
        spec: z.string(),
        writeAllowlist: z.array(z.string()),
      }),
      execute: async (
        args: {
          parentId: string;
          owner: string;
          spec: string;
          writeAllowlist: string[];
        },
        context: Ctx,
      ) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const parent = run.tasks.find((t) => t.id === args.parentId);
        if (!parent || parent.lease?.owner !== args.owner) {
          throw new Error("parent not leased by owner");
        }
        const res = addFollowup(
          run,
          args.parentId,
          args.spec,
          args.writeAllowlist,
          now(),
        );
        if ("error" in res) throw new Error(res.error);
        return { dataHandles: [await persist(context, res.run)] };
      },
    },

    heartbeat: {
      description:
        "Renew a task's lease and record its vmId (owner keeps the lease alive while the VM runs).",
      arguments: z.object({
        taskId: z.string(),
        owner: z.string(),
        vmId: z.string().optional(),
      }),
      execute: async (
        args: { taskId: string; owner: string; vmId?: string },
        context: Ctx,
      ) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const ts = now();
        const task = run.tasks.find((t) => t.id === args.taskId);
        if (!task || task.lease?.owner !== args.owner) {
          throw new Error("task not leased by owner");
        }
        const tasks = run.tasks.map((t) =>
          t.id === args.taskId
            ? {
              ...t,
              lease: {
                owner: args.owner,
                expiresAt: addSeconds(ts, run.config.leaseTtlSeconds),
                heartbeatAt: ts,
                vmId: args.vmId ?? t.lease?.vmId,
              },
            }
            : t
        );
        return {
          dataHandles: [
            await persist(context, { ...run, tasks, updatedAt: ts }),
          ],
        };
      },
    },

    hydrate: {
      description:
        "Write a compact summary of the run (counts, halt reason + options, leased VMs, stall culprits, cost estimate).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const summary = hydrateSummary(run);
        context.logger.info("Hydrate: status={status} inv={inv}", {
          status: run.status,
          inv: run.invocations,
        });
        return {
          dataHandles: [
            await context.writeResource("summary", "summary", summary),
          ],
        };
      },
    },

    abort: {
      description:
        "Halt the run (any non-terminal state). Records leased vmIds for the driver to destroy.",
      arguments: z.object({ reason: z.string() }),
      execute: async (args: { reason: string }, context: Ctx) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const ts = now();
        const leasedVms = run.tasks.filter((t) => t.status === "leased").map((
          t,
        ) => ({ id: t.id, vmId: t.lease?.vmId ?? null }));
        context.logger.info("Abort: {reason} ({n} leased VM(s) to destroy)", {
          reason: args.reason,
          n: leasedVms.length,
        });
        const next: Run = {
          ...run,
          status: "halted",
          haltReason: "aborted: " + args.reason,
          haltOptions: [],
          updatedAt: ts,
        };
        const h1 = await persist(context, next);
        const h2 = await context.writeResource(
          "decision",
          "decision",
          { outcome: "aborted", reason: args.reason, leasedVms } as Record<
            string,
            unknown
          >,
        );
        return { dataHandles: [h1, h2] };
      },
    },

    complete: {
      description:
        "Mark the run complete (requires all tasks done) and emit the final report.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        if (
          !(run.tasks.length > 0 && run.tasks.every((t) => t.status === "done"))
        ) {
          throw new Error("cannot complete — not all tasks are done");
        }
        const ts = now();
        const next: Run = { ...run, status: "complete", updatedAt: ts };
        const h1 = await persist(context, next);
        const h2 = await context.writeResource(
          "summary",
          "summary",
          completeReport(next),
        );
        return { dataHandles: [h1, h2] };
      },
    },
  },
};
