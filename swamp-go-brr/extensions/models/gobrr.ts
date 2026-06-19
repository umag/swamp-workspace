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
// Pure secret-scrub, shared with source-integration via lib/ (no cycle — lib/scrub.ts
// imports nothing). gobrr is the authoritative scrub site for the verifyTail it stores.
import { scrubSecrets } from "./lib/scrub.ts";
// Pure OTLP serializer + W3C id generators (cycle-free: lib/otlp imports only stdlib +
// lib/scrub). gobrr generates ids at the impure method boundary (like now()) and maps
// its structs into otlp's canonical inputs; the pure builders take ids as data.
import {
  newSpanId,
  newTraceId,
  type OtlpMetricInput,
  type OtlpMetricPoint,
  type OtlpSpanInput,
  type OtlpTraceInput,
  serializeMetrics,
  serializeTrace,
} from "./lib/otlp.ts";

// ───────────────────────────── value objects ─────────────────────────────

/** Gate kind: `real` (code task, gated by running tests) vs `advisory` (test task). */
export const GateEnum = z.enum(["real", "advisory"]);

// One shared outcome vocabulary across next()/report()/complete.
/** The shared per-task / per-step outcome vocabulary. */
export const OutcomeEnum = z.enum([
  "done",
  "test_failed",
  "exhausted",
  "infra_error",
  "merge_conflict",
  "waiting_followup",
  "blocked",
]);

/** Typed leaf/transport failure kinds (envelope, nonce, claude_error, allowlist, transport). */
export const FailureKindEnum = z.enum([
  "envelope_parse", // stdout was not a well-formed nonce-fenced envelope
  "envelope_oversize", // stdout exceeded the size contract
  "nonce_mismatch", // fence nonce did not match — possible forgery
  "claude_error", // the guest's `claude --print` exited non-zero (ERROR: prefix)
  "out_of_allowlist", // a diff hunk targeted a path outside the write allowlist
  "unsafe_change", // a denied control path / symlink / gitlink / mode change — possible attack
  "transport", // collect_result / boot / ssh failure
]);

/** How a task's change merged: clean | conflict-resolved | conflict-unresolved. */
export const MergeDispositionEnum = z.enum([
  "clean",
  "conflict-resolved",
  "conflict-unresolved",
]);

/** A task lease: owner, expiry, last heartbeat, and the assigned vmId. */
export const LeaseSchema = z.object({
  owner: z.string(),
  expiresAt: z.string(), // ISO-8601
  heartbeatAt: z.string(),
  vmId: z.string().optional(),
});

/** Advisory test info self-reported by the leaf — NEVER the gate. */
export const TestReportSchema = z.object({
  // advisory — self-reported by the agent, NEVER the gate.
  redFirst: z.boolean().optional(),
  testsRun: z.number().optional(),
  note: z.string().optional(),
});

/** An untrusted follow-up request: a spec plus its write allowlist. */
export const FollowupSchema = z.object({
  spec: z.string(),
  writeAllowlist: z.array(z.string()),
});

/** The structured result `report()` consumes: diff, host-observed changedPaths, optional testReport/followups/failureKind. */
export const WorkResultSchema = z.object({
  diff: z.string().default(""),
  changedPaths: z.array(z.string()).default([]),
  testReport: TestReportSchema.optional(),
  followups: z.array(FollowupSchema).default([]),
  note: z.string().optional(),
  failureKind: FailureKindEnum.optional(),
});

/** The host-pinned run config: verify command/inputs, repoScope, toolchain image, and all run caps. */
export const RunConfigSchema = z.object({
  verifyCommand: z.string(), // host-pinned test command (the gate)
  verifyInputs: z.array(z.string()), // complete verify surface (tree globs)
  repoScope: z.string(), // the human-confirmed jj repo/path; followups bounded to it
  toolchainImage: z.string(), // digest-pinned image for docker-verify
  leafModel: z.string().default(""), // model id for the leaf `claude --print` ("" = substrate default)
  leafEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"), // claude --print --effort (matches fc-task-server inject_task)
  maxConcurrentVMs: z.number().default(8), // each FC instance has its own socket; resource guard, not a substrate limit
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

/** Task lifecycle states (pending -> leased -> done/exhausted/blocked/...). */
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

/** A single Task node in the DAG (spec, write allowlist, deps, gate, status, lease, span id). */
export const TaskSchema = z.object({
  id: z.string(),
  spec: z.string().meta({ sensitive: true }), // task instruction (may carry secrets)
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
  // W3C span id (root fact — generated once in seed_tasks/add_followup execute, NOT
  // derivable). .optional() with NO default: absence is meaningful (a pre-feature task
  // has none, and buildTrace suppresses its spans rather than inventing one).
  spanId: z.string().optional(),
});

/** Run status: running | halted | complete. */
export const RunStatusEnum = z.enum(["running", "halted", "complete"]);

/** The authoritative Run aggregate — the Task DAG plus scheduler state. */
export const RunSchema = z.object({
  status: RunStatusEnum.default("running"),
  intake: z.string().meta({ sensitive: true }), // human input that seeded the run
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
  // W3C trace id (root fact — generated once in start execute). .optional() with NO
  // default: a pre-feature run has none and buildTrace returns status="unavailable".
  traceId: z.string().optional(),
});

// ───────────────────────── mirror interfaces (bridge) ─────────────────────
// Kept structurally identical to the schemas; drift surfaces as a `deno check`
// failure at the `as` casts in readRun / the bridge test.

/** Mirror type of GateEnum. */
export type Gate = "real" | "advisory";
/** Mirror type of OutcomeEnum. */
export type Outcome = z.infer<typeof OutcomeEnum>;
/** Mirror type of FailureKindEnum. */
export type FailureKind = z.infer<typeof FailureKindEnum>;
/** Mirror type of MergeDispositionEnum. */
export type MergeDisposition = z.infer<typeof MergeDispositionEnum>;
/** Mirror type of TaskStatusEnum. */
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

/** Mirror interface of LeaseSchema (kept structurally identical; drift fails `deno check`). */
export interface Lease {
  owner: string;
  expiresAt: string;
  heartbeatAt: string;
  vmId?: string;
}
/** Mirror interface of FollowupSchema. */
export interface Followup {
  spec: string;
  writeAllowlist: string[];
}
/** Mirror interface of WorkResultSchema. */
export interface WorkResult {
  diff: string;
  changedPaths: string[];
  testReport?: { redFirst?: boolean; testsRun?: number; note?: string };
  followups: Followup[];
  note?: string;
  failureKind?: FailureKind;
}
/** Mirror interface of RunConfigSchema. */
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
/** Mirror interface of TaskSchema. */
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
  spanId?: string;
}
/** Mirror interface of RunSchema. */
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
  traceId?: string;
}

// ───────────────────────────── pure helpers ──────────────────────────────

/** Current time as an ISO-8601 string (the one impure clock seam). */
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

/** True when `lease` is null or its expiry is at/before `nowTs`. */
export function leaseExpired(lease: Lease | null, nowTs: string): boolean {
  if (!lease) return true;
  return nowTs > lease.expiresAt;
}

/** How many tasks are currently in the `leased` state. */
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

/** The result of `nextDecision`: the chosen action + reason (leased/all-green/halt/...). */
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

/** Seconds elapsed between two ISO-8601 timestamps. */
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

/** Detect a stall (no `done` in the last K offers); returns the culprits + a failure signature. */
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

/** Per-gate promise-keeping stats: kept/broken, pass rate, green-first-try rate, mean attempts-to-green. */
export interface TrustStats {
  kept: number;
  broken: number;
  passRate: number;
  greenFirstTryRate: number;
  meanAttemptsToGreen: number;
}

/**
 * Per-task-type promise-keeping projection DERIVED from the task list (no stored
 * state) — Promise Theory: trust is the measured, gate-exit-code assessment, never
 * agent self-report. Keyed on task.gate (real=code, advisory=test). A `done` task
 * kept its promise; `exhausted` broke it. (`merge_conflict` is also counted broken;
 * it is a reserved status with no scheduler transition yet — the branch is a
 * forward-compatibility guard.) Excluded: `blocked` (cascaded non-execution from a
 * dead dependency), `infra_error` (a HOST failure — it never consumes an attempt
 * and is surfaced via completeReport buckets), and every non-terminal status
 * (`pending`, `leased`, `waiting_followup`, and the transient `test_failed` which
 * is re-queued to `pending`). `attemptsToGreen = task.attempts + 1` (attempts
 * increments on each verify failure AND each reaped/expired lease, never on the
 * green run) — so it counts every invocation to green, including a timed-out lease,
 * not only verify-gate failures. A gate with no counted task emits no bucket.
 * Deriving from the final status captures BOTH the applyReport and the
 * scheduler-reap `exhausted` paths.
 */
export function trustSummary(run: Run): Record<string, TrustStats> {
  const acc: Record<
    string,
    { kept: number; broken: number; greenFirstTry: number; atgTotal: number }
  > = {};
  for (const t of run.tasks) {
    const kept = t.status === "done";
    const broken = t.status === "exhausted" || t.status === "merge_conflict";
    if (!kept && !broken) continue; // blocked / infra_error / non-terminal
    const a = acc[t.gate] ??
      { kept: 0, broken: 0, greenFirstTry: 0, atgTotal: 0 };
    if (kept) {
      a.kept += 1;
      a.atgTotal += t.attempts + 1; // attempts not incremented on the green run
      if (t.attempts === 0) a.greenFirstTry += 1;
    } else {
      a.broken += 1;
    }
    acc[t.gate] = a;
  }
  const out: Record<string, TrustStats> = {};
  for (const [gate, a] of Object.entries(acc)) {
    const total = a.kept + a.broken;
    out[gate] = {
      kept: a.kept,
      broken: a.broken,
      passRate: total > 0 ? a.kept / total : 0,
      greenFirstTryRate: a.kept > 0 ? a.greenFirstTry / a.kept : 0,
      meanAttemptsToGreen: a.kept > 0 ? a.atgTotal / a.kept : 0,
    };
  }
  return out;
}

/** The final run report: status, per-status buckets, per-task summary, trust stats, cost estimate. */
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
    trust: trustSummary(run), // per-gate promise-keeping (measured, not self-reported)
  };
}

/** A compact, partial run summary for cheap mid-run inspection. */
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
    // reuse completeReport's already-computed projection; partial mid-run.
    trustSoFar: (r as { trust: Record<string, TrustStats> }).trust,
    snapshotAt: run.updatedAt,
  };
}

// ───────────────────────── step-output audit record ──────────────────────────
// The per-leaf-invocation ASSESSMENT record. gobrr stores ONLY the raw PRUNED
// measurements report() is given (the diff/envelope/verify inputs exist nowhere after
// the call); every rollup is DERIVED by stepOutputProjection, never stored (ADR 0002).
// Complementary to the derived trustSummary (aggregate promise-keeping).

// Re-bound caps for the persisted tails. The diff arrives ALREADY scrubbed from
// source-integration apply() (re-bound only); verifyTail is scrubbed here.
/** Byte cap retained for the stored (already-scrubbed) diff tail. */
export const DIFF_TAIL_BYTES = 8000;
/** Byte cap retained for the scrubbed docker-verify stdout tail. */
export const VERIFY_TAIL_BYTES = 4000;

// AGENT-DECLARED envelope summary — the leaf's stated intent (block count, edits per
// file, target paths). NEVER host truth (ADR 0001); produced by source-integration's
// summarizeEnvelope and forwarded through report(). Defined here (the consumer) so
// source-integration imports the TYPE without forming an import cycle.
/** The AGENT-DECLARED envelope summary (block count, declared paths/edits) — never host truth (ADR 0001). */
export const EnvelopeSummarySchema = z.object({
  blockCount: z.number(),
  declaredTargetPaths: z.array(z.string()),
  declaredEditsPerFile: z.record(z.string(), z.number()),
});

// AGENT-DECLARED per-leaf usage (ADR 0001/0005 — self-reported, NEVER a gate input).
// Validated + range-bounded at the source-integration parse boundary before it lands here.
/** Agent-declared per-leaf usage (tokens/cost/duration); advisory, never a gate (ADR 0009). */
export const LeafDeclaredSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
});

/** One immutable per-leaf-invocation audit record. */
export const StepOutputSchema = z.object({
  taskId: z.string(),
  invocation: z.number(), // 1-based index of the invocation that produced this result
  recordedAt: z.string(),
  outcome: OutcomeEnum,
  failureKind: FailureKindEnum.nullable(),
  envelope: EnvelopeSummarySchema.nullable(), // declared; null on parse-fail / no envelope
  changedPaths: z.array(z.string()), // HOST-OBSERVED
  diffTail: z.string().meta({ sensitive: true }), // scrubbed upstream; re-bound to the tail
  verifyExitCode: z.number(),
  verifyTail: z.string().meta({ sensitive: true }), // scrubbed + tail-bounded here
  // observability (issue gobrr-observability): per-invocation W3C span id (loop-generated,
  // durable on the 7d record since the lease is nulled at report), the HOST-measured leaf
  // wall-clock, and the AGENT-DECLARED usage (provenance kept separate from host facts).
  invocationSpanId: z.string().optional(),
  hostDurationMs: z.number().optional(),
  leafDeclared: LeafDeclaredSchema.optional(),
});

/** The append-only step-output log resource `{records: StepOutput[]}`. */
export const StepOutputsResourceSchema = z.object({
  records: z.array(StepOutputSchema),
});

/** Mirror interface of EnvelopeSummarySchema. */
export interface EnvelopeSummary {
  blockCount: number;
  declaredTargetPaths: string[];
  declaredEditsPerFile: Record<string, number>;
}
/** Mirror interface of LeafDeclaredSchema. */
export interface LeafDeclared {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  durationMs?: number;
}
/** Mirror interface of StepOutputSchema. */
export interface StepOutput {
  taskId: string;
  invocation: number;
  recordedAt: string;
  outcome: Outcome;
  failureKind: FailureKind | null;
  envelope: EnvelopeSummary | null;
  changedPaths: string[];
  diffTail: string;
  verifyExitCode: number;
  verifyTail: string;
  invocationSpanId?: string;
  hostDurationMs?: number;
  leafDeclared?: LeafDeclared;
}

/** Input to `buildStepOutput` (raw measurements before tail-bounding + scrub). */
export interface BuildStepOutputInput {
  taskId: string;
  invocation: number;
  recordedAt: string;
  outcome: Outcome;
  failureKind: FailureKind | null;
  envelope: EnvelopeSummary | null;
  changedPaths: string[];
  diff: string; // already scrubbed by apply()
  verifyExitCode: number;
  verifyTail: string; // RAW docker-verify stdout — scrubbed here
  invocationSpanId?: string;
  hostDurationMs?: number;
  leafDeclared?: LeafDeclared;
}

/**
 * Build one immutable step-output record from what report() was given. The diff is
 * already scrubbed at the apply boundary, so it is re-bound to its tail only. The
 * verifyTail is NEW untrusted docker-verify stdout, so it is scrubbed UNCONDITIONALLY
 * here (gobrr is the authoritative last-line scrub site) before being tail-bounded.
 */
export function buildStepOutput(input: BuildStepOutputInput): StepOutput {
  return {
    taskId: input.taskId,
    invocation: input.invocation,
    recordedAt: input.recordedAt,
    outcome: input.outcome,
    failureKind: input.failureKind,
    envelope: input.envelope,
    changedPaths: input.changedPaths,
    diffTail: input.diff.slice(-DIFF_TAIL_BYTES),
    verifyExitCode: input.verifyExitCode,
    verifyTail: scrubSecrets(input.verifyTail).slice(-VERIFY_TAIL_BYTES),
    invocationSpanId: input.invocationSpanId,
    hostDurationMs: input.hostDurationMs,
    leafDeclared: input.leafDeclared,
  };
}

/** A declared target path absent from the host-observed changedPaths (the dropped-block signature). */
export interface StepOutputMismatch {
  taskId: string;
  invocation: number;
  path: string;
}
/** A task whose attempts exceed its recorded step-outputs (a reaped/unrecorded invocation). */
export interface ReapedGap {
  taskId: string;
  attempts: number;
  recorded: number;
  gap: number;
}
/** Derived rollup over the records + tasks: record count, declared-vs-observed mismatches, reaped gaps. */
export interface StepOutputProjection {
  count: number;
  mismatches: StepOutputMismatch[];
  reaped: ReapedGap[];
}

/**
 * DERIVED rollup over the stored records + the task list (never stored — ADR 0002).
 *  - mismatches: a DECLARED target path (from declaredTargetPaths or a positive
 *    declaredEditsPerFile entry) ABSENT from the HOST-OBSERVED changedPaths of the same
 *    record — the dropped-block signature. ALL such paths per record are reported.
 *    Informational, never a gate.
 *  - reaped: task.attempts exceeding the number of that task's records. A reaped /
 *    expired-lease invocation produces NO report (hence no record) yet bumps attempts,
 *    so the gap is a LOWER-BOUND count of invocations that left no audit record (a reap
 *    OR a best-effort append failure). Never use it as a hard gate. (Conversely an
 *    infra_error IS recorded but does NOT bump attempts, so records can exceed attempts;
 *    the `attempts > recorded` guard keeps the gap non-negative.)
 */
export function stepOutputProjection(
  records: StepOutput[],
  tasks: Task[],
): StepOutputProjection {
  const mismatches: StepOutputMismatch[] = [];
  for (const r of records) {
    if (!r.envelope) continue; // null-safe: a record with no declared summary
    const observed = new Set(r.changedPaths);
    const declared = new Set<string>(r.envelope.declaredTargetPaths);
    for (const [p, n] of Object.entries(r.envelope.declaredEditsPerFile)) {
      if (n > 0) declared.add(p);
    }
    for (const p of [...declared].sort()) {
      if (!observed.has(p)) {
        mismatches.push({
          taskId: r.taskId,
          invocation: r.invocation,
          path: p,
        });
      }
    }
  }
  const recordedByTask = new Map<string, number>();
  for (const r of records) {
    recordedByTask.set(r.taskId, (recordedByTask.get(r.taskId) ?? 0) + 1);
  }
  const reaped: ReapedGap[] = [];
  for (const t of tasks) {
    const recorded = recordedByTask.get(t.id) ?? 0;
    if (t.attempts > recorded) {
      reaped.push({
        taskId: t.id,
        attempts: t.attempts,
        recorded,
        gap: t.attempts - recorded,
      });
    }
  }
  return { count: records.length, mismatches, reaped };
}

// ─────────────────────── OTLP derivation (issue gobrr-observability) ──────────
// PURE projections (ADR 0002): buildTrace/buildMetrics DERIVE an OTLP tree/metrics
// from the Run + the 7d step-output records. They consume the raw records (the only
// home of per-invocation span ids + leaf usage) — that IS the source of truth, not a
// second run.tasks scan that could drift from trustSummary. Serialization + the
// authoritative attribute scrub live in lib/otlp.ts. Ids are generated in the execute
// methods (never here). gobrr stays pure: it never exports — @magistr/swamp-go-brr/
// otlp-export ships the resources these produce.

const SERVICE_NAME = "swamp-go-brr";

function isoToNanos(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(ms * 1_000_000) : "0";
}

function runStatus(run: Run): "ok" | "error" | "unset" {
  return run.status === "complete"
    ? "ok"
    : run.status === "halted"
    ? "error"
    : "unset";
}
function taskSpanStatus(t: Task): "ok" | "error" | "unset" {
  if (t.status === "done") return "ok";
  if (BAD_STATUSES.includes(t.status)) return "error";
  return "unset";
}

/** The result of `buildTrace`: a 4-state status, the suppressed-task count, and the OTLP trace input. */
export interface TraceResult {
  status: "unavailable" | "empty" | "partial" | "ok";
  suppressedTasks: number; // pre-feature tasks (no spanId) whose spans were suppressed
  trace?: OtlpTraceInput;
}

/**
 * Derive an OTLP span tree: run (root) → task → invocation → (host stage timings as
 * attributes). The root span id is a deterministic 16-hex slice of the traceId. A task
 * with NO spanId (pre-feature) is suppressed ENTIRELY — its task span AND all its
 * invocation spans — so a settled invocation span is never orphaned/promoted to a root.
 * Status: unavailable (no traceId) | empty (traceId, zero attempts, no records) | partial
 * (traceId, attempts>0 but records GC'd at 7d) | ok.
 */
export function buildTrace(run: Run, records: StepOutput[]): TraceResult {
  if (!run.traceId) return { status: "unavailable", suppressedTasks: 0 };
  const rootSpanId = run.traceId.slice(0, 16);
  const spans: OtlpSpanInput[] = [{
    spanId: rootSpanId,
    name: "gobrr.run",
    startUnixNano: isoToNanos(run.createdAt),
    endUnixNano: isoToNanos(run.updatedAt),
    status: runStatus(run),
    attributes: {
      "gobrr.invocations": run.invocations,
      "gobrr.status": run.status,
      "gobrr.cost_estimate": run.costEstimate,
    },
  }];

  const recsByTask = new Map<string, StepOutput[]>();
  for (const r of records) {
    const arr = recsByTask.get(r.taskId) ?? [];
    arr.push(r);
    recsByTask.set(r.taskId, arr);
  }

  let suppressedTasks = 0;
  for (const t of run.tasks) {
    const taskRecs = recsByTask.get(t.id) ?? [];
    if (!t.spanId) {
      // pre-feature task: suppress its task span AND every invocation span (never orphan)
      if (taskRecs.length > 0 || t.attempts > 0) suppressedTasks += 1;
      continue;
    }
    spans.push({
      spanId: t.spanId,
      parentSpanId: rootSpanId,
      name: `task ${t.id}`,
      startUnixNano: isoToNanos(t.createdAt),
      endUnixNano: isoToNanos(run.updatedAt),
      status: taskSpanStatus(t),
      attributes: {
        "task.id": t.id,
        "task.gate": t.gate,
        "task.status": t.status,
        "task.attempts": t.attempts,
        ...(t.failureKind ? { "task.failure_kind": t.failureKind } : {}),
      },
    });
    for (const r of taskRecs) {
      if (!r.invocationSpanId) continue; // no span id for this invocation → skip
      const attrs: Record<string, string | number | boolean> = {
        "invocation.index": r.invocation,
        "invocation.outcome": r.outcome,
        "verify.exit_code": r.verifyExitCode,
      };
      if (r.hostDurationMs !== undefined) {
        attrs["leaf.host.duration_ms"] = r.hostDurationMs;
      }
      const d = r.leafDeclared;
      if (d) {
        if (d.inputTokens !== undefined) {
          attrs["leaf.declared.input_tokens"] = d.inputTokens;
        }
        if (d.outputTokens !== undefined) {
          attrs["leaf.declared.output_tokens"] = d.outputTokens;
        }
        if (d.cacheReadTokens !== undefined) {
          attrs["leaf.declared.cache_read_tokens"] = d.cacheReadTokens;
        }
        if (d.costUsd !== undefined) {
          attrs["leaf.declared.cost_usd"] = d.costUsd;
        }
        if (d.durationMs !== undefined) {
          attrs["leaf.declared.duration_ms"] = d.durationMs;
        }
      }
      const endMs = Date.parse(r.recordedAt);
      const startNanos =
        (Number.isFinite(endMs) && r.hostDurationMs !== undefined)
          ? String(endMs * 1_000_000 - r.hostDurationMs * 1_000_000)
          : isoToNanos(r.recordedAt);
      spans.push({
        spanId: r.invocationSpanId,
        parentSpanId: t.spanId,
        name: `invocation ${t.id}#${r.invocation}`,
        startUnixNano: startNanos,
        endUnixNano: isoToNanos(r.recordedAt),
        status: r.outcome === "done" ? "ok" : "error",
        attributes: attrs,
      });
    }
  }

  const trace: OtlpTraceInput = {
    traceId: run.traceId,
    serviceName: SERVICE_NAME,
    spans,
  };
  if (records.length === 0) {
    const anyAttempts = run.tasks.some((t) => t.attempts > 0);
    return {
      status: anyAttempts ? "partial" : "empty",
      suppressedTasks,
      trace,
    };
  }
  return { status: "ok", suppressedTasks, trace };
}

/**
 * Derive OTLP metrics — per-gate leaf token / cost / time sums from the DECLARED usage
 * on the records (gate is the only label; the lib/otlp METRIC_LABELS allowlist forbids
 * free-text labels). Numeric only; carries no secret-bearing text.
 */
export function buildMetrics(run: Run, records: StepOutput[]): OtlpMetricInput {
  const gateOf = new Map(run.tasks.map((t) => [t.id, t.gate]));
  const acc = new Map<
    string,
    { tokens: number; cost: number; dur: number; count: number }
  >();
  for (const r of records) {
    const gate = gateOf.get(r.taskId) ?? "real";
    const a = acc.get(gate) ?? { tokens: 0, cost: 0, dur: 0, count: 0 };
    const d = r.leafDeclared;
    if (d) {
      a.tokens += (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
      a.cost += d.costUsd ?? 0;
    }
    a.dur += r.hostDurationMs ?? d?.durationMs ?? 0;
    a.count += 1;
    acc.set(gate, a);
  }
  const tokenPts: OtlpMetricPoint[] = [],
    costPts: OtlpMetricPoint[] = [],
    durPts: OtlpMetricPoint[] = [],
    countPts: OtlpMetricPoint[] = [];
  const tsNanos = isoToNanos(run.updatedAt); // measurement time for every point
  for (const [gate, a] of acc) {
    tokenPts.push({
      attributes: { gate },
      value: a.tokens,
      timeUnixNano: tsNanos,
    });
    costPts.push({
      attributes: { gate },
      value: a.cost,
      timeUnixNano: tsNanos,
    });
    durPts.push({ attributes: { gate }, value: a.dur, timeUnixNano: tsNanos });
    countPts.push({
      attributes: { gate },
      value: a.count,
      timeUnixNano: tsNanos,
    });
  }
  return {
    serviceName: SERVICE_NAME,
    metrics: [
      { name: "gobrr.leaf.tokens", unit: "1", kind: "sum", points: tokenPts },
      {
        name: "gobrr.leaf.cost_usd",
        unit: "USD",
        kind: "sum",
        points: costPts,
      },
      {
        name: "gobrr.leaf.duration_ms",
        unit: "ms",
        kind: "sum",
        points: durPts,
      },
      {
        name: "gobrr.leaf.invocations",
        unit: "1",
        kind: "sum",
        points: countPts,
      },
    ],
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

/** Read the append-only step-output log. Returns [] when readResource is absent (some
 * contexts inject none) or the resource has not been written yet (before the first
 * report). The audit log is best-effort — a malformed blob degrades to [], never throws. */
async function readStepOutputs(context: Ctx): Promise<StepOutput[]> {
  if (!context.readResource) return [];
  const raw = await context.readResource("stepOutputs");
  if (!raw) return [];
  const parsed = StepOutputsResourceSchema.safeParse(raw);
  return parsed.success ? (parsed.data.records as StepOutput[]) : [];
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
  version: "2026.06.19.3",
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
    stepOutputs: {
      description:
        "Append-only per-leaf-invocation audit log {records: StepOutput[]}: the raw PRUNED measurements report() was given (declared envelope summary, host-observed changedPaths + scrubbed diffTail, verify exit + scrubbed verifyTail, outcome/failureKind). One resource per run; rollups are DERIVED via stepOutputProjection, never stored. Lifetime 7d (bounded retention, issue si-applied-resource-lifetime) — longer than the transient per-task inputs (24h) so a post-halt inspection survives, while not retaining the scrubbed tails forever; garbageCollection 50.",
      schema: StepOutputsResourceSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
    traceOtlp: {
      description:
        "DERIVED OTLP/JSON span tree (run -> task -> invocation), produced by emit_otlp. content.status is one of ok|unavailable|empty|partial (unavailable = pre-feature run with no traceId; partial = >7d run whose step records were GC'd). Read via `swamp data get <name> traceOtlp --json | jq -r .content.status` (the OTLP body is .content.resourceSpans). Lifetime 7d (ADR 0004 — carries scrubbed attribute text). Hand-off artifact for @magistr/swamp-go-brr/otlp-export; gobrr never pushes it.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    metricsOtlp: {
      description:
        "DERIVED OTLP/JSON metrics (per-gate leaf tokens/cost/duration/invocations), produced by emit_otlp. Numeric only (no status, always fully populated; labels restricted to the METRIC_LABELS allowlist — no free-text). Read via `swamp data get <name> metricsOtlp --json | jq .content.resourceMetrics`.",
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
          traceId: newTraceId(), // root fact — generated once, here at the impure boundary
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
            spanId: newSpanId(), // root fact — one span id per task, at the impure boundary
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
        "Report a leased task's WorkResult + the deterministic verify exit code (and optional audit: the declared envelopeSummary + raw docker-verify verifyTail). Greens ONLY on verifyExitCode===0; rejects out-of-allowlist / verifyInputs hunks; parse-fail → infra_error. Persists the gate decision FIRST, then best-effort-appends one step-output audit record.",
      arguments: z.object({
        taskId: z.string(),
        owner: z.string(),
        workResult: WorkResultSchema,
        verifyExitCode: z.number(),
        audit: z.object({
          envelopeSummary: EnvelopeSummarySchema.nullable().default(null),
          verifyTail: z.string().default(""),
          // observability: the loop generates the invocation span id + measures the leaf
          // wall-clock (host) and passes the source-integration-validated declared usage.
          invocationSpanId: z.string().optional(),
          hostDurationMs: z.number().optional(),
          leafDeclared: LeafDeclaredSchema.optional(),
        }).optional(),
      }),
      execute: async (
        args: {
          taskId: string;
          owner: string;
          workResult: z.infer<typeof WorkResultSchema>;
          verifyExitCode: number;
          audit?: {
            envelopeSummary: EnvelopeSummary | null;
            verifyTail: string;
            invocationSpanId?: string;
            hostDurationMs?: number;
            leafDeclared?: LeafDeclared;
          };
        },
        context: Ctx,
      ) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        // invocation index = the task's prior attempts + 1 (read BEFORE applyReport,
        // which may bump attempts on a verify failure / reap).
        const before = run.tasks.find((t) => t.id === args.taskId);
        const res = applyReport(
          run,
          args.taskId,
          args.owner,
          args.workResult as WorkResult,
          args.verifyExitCode,
          now(),
        );
        if ("error" in res) throw new Error(res.error); // throw BEFORE any write
        const after = res.run.tasks.find((t) => t.id === args.taskId)!;
        context.logger.info("report {taskId} → {outcome}", {
          taskId: args.taskId,
          outcome: after.outcome ?? "",
        });
        // The gate decision is sacred: persist the run FIRST and let it propagate.
        const handles: unknown[] = [await persist(context, res.run)];
        // The audit append is BEST-EFFORT — a step-output write failure must never
        // block or obscure the already-persisted gate decision. Log and swallow.
        try {
          const record = buildStepOutput({
            taskId: args.taskId,
            invocation: (before?.attempts ?? 0) + 1,
            recordedAt: now(),
            outcome: after.outcome!, // always set by a successful applyReport
            failureKind: after.failureKind,
            envelope: args.audit?.envelopeSummary ?? null,
            changedPaths: args.workResult.changedPaths,
            diff: args.workResult.diff,
            verifyExitCode: args.verifyExitCode,
            verifyTail: args.audit?.verifyTail ?? "",
            invocationSpanId: args.audit?.invocationSpanId,
            hostDurationMs: args.audit?.hostDurationMs,
            leafDeclared: args.audit?.leafDeclared,
          });
          const existing = await readStepOutputs(context);
          handles.push(
            await context.writeResource("stepOutputs", "stepOutputs", {
              records: [...existing, record],
            }),
          );
          context.logger.info("stepOutputs append {taskId} (n={n})", {
            taskId: args.taskId,
            n: existing.length + 1,
          });
        } catch (e) {
          context.logger.info("stepOutputs append failed (non-fatal): {err}", {
            err: String(e),
          });
        }
        return { dataHandles: handles };
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
        const ts = now();
        const parent = run.tasks.find((t) => t.id === args.parentId);
        if (!parent || parent.lease?.owner !== args.owner) {
          throw new Error("parent not leased by owner");
        }
        // An expired owner must not mutate the DAG (mirror applyReport's expiry check).
        if (leaseExpired(parent.lease, ts)) {
          throw new Error("parent lease expired");
        }
        const res = addFollowup(
          run,
          args.parentId,
          args.spec,
          args.writeAllowlist,
          ts,
        );
        if ("error" in res) throw new Error(res.error);
        // give the new followup task a span id (root fact, impure boundary); idempotent —
        // only fills a missing id, so existing tasks' span ids are untouched.
        const withSpan: Run = {
          ...res.run,
          tasks: res.run.tasks.map((t) =>
            t.spanId ? t : { ...t, spanId: newSpanId() }
          ),
        };
        return { dataHandles: [await persist(context, withSpan)] };
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
        // Measure lease VALIDITY, not just ownership: a lapsed lease must not be renewed
        // (resurrected past its TTL, dodging the scheduler reap). Mirrors applyReport.
        if (leaseExpired(task.lease, ts)) {
          throw new Error("lease expired — cannot heartbeat a lapsed lease");
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
        "Write a compact summary of the run (counts, halt reason + options, leased VMs, stall culprits, cost estimate) plus the derived step-output projection (record count, declared-vs-observed mismatches, reaped-invocation gaps).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const records = await readStepOutputs(context);
        const summary = {
          ...hydrateSummary(run),
          // derived on read from the stored records + tasks — never persisted (ADR 0002)
          stepOutputs: stepOutputProjection(records, run.tasks),
        };
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

    emit_otlp: {
      description:
        "Derive + write the OTLP observability resources: `traceOtlp` (the run->task->invocation span tree, with content.status = ok|unavailable|empty|partial) and `metricsOtlp` (per-gate leaf tokens/cost/duration/invocations). PURE derivation from the run + 7d step records (ADR 0002); gobrr never exports — @magistr/swamp-go-brr/otlp-export ships these.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const run = await readRun(context);
        if (!run) throw new Error("no run — call start first");
        const records = await readStepOutputs(context);
        const t = buildTrace(run, records);
        const traceContent: Record<string, unknown> = {
          status: t.status,
          suppressedTasks: t.suppressedTasks,
          ...(t.trace ? serializeTrace(t.trace) : { resourceSpans: [] }),
        };
        const metricsContent = serializeMetrics(buildMetrics(run, records));
        context.logger.info("emit_otlp: trace status={status} spans={n}", {
          status: t.status,
          n: t.trace ? t.trace.spans.length : 0,
        });
        return {
          dataHandles: [
            await context.writeResource("traceOtlp", "traceOtlp", traceContent),
            await context.writeResource(
              "metricsOtlp",
              "metricsOtlp",
              metricsContent,
            ),
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
