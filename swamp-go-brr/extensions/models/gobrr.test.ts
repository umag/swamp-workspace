// Deno tests for @magistr/swamp-go-brr/gobrr — the PURE orchestrator core.
// Run: /home/zeroclaw/.swamp/deno/deno test extensions/models/gobrr.test.ts
// These cover the load-bearing logic; live FC/jj/Docker is integration-only.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addFollowup,
  applyReport,
  deriveGate,
  haltOptionsFor,
  hasCycle,
  leaseExpired,
  normalizePath,
  pathEscapes,
  pathInSet,
  readyTaskIds,
  type Run,
  type RunConfig,
  type Task,
  trustSummary,
  wouldCycle,
} from "./gobrr.ts";

const T0 = "2026-06-09T00:00:00.000Z";
const LATER = "2026-06-09T01:00:00.000Z";

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    verifyCommand: "deno test",
    verifyInputs: ["tests/"],
    repoScope: "src",
    toolchainImage: "img@sha256:abc",
    leafModel: "",
    leafEffort: "low",
    maxConcurrentVMs: 1,
    maxAttempts: 2,
    maxFollowupDepth: 3,
    maxInvocations: 100,
    leaseTtlSeconds: 1800,
    wallclockSeconds: 7200,
    stallN: 2,
    stallK: 3,
    perInvocationCostEstimate: 0,
    pinnedVersions: {},
    ...over,
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    spec: "do a thing",
    writeAllowlist: ["src/a.ts"],
    dependsOn: [],
    gate: "real",
    status: "pending",
    attempts: 0,
    followupDepth: 0,
    lease: null,
    outcome: null,
    failureKind: null,
    failureSignature: null,
    mergeDisposition: null,
    createdAt: T0,
    ...over,
  };
}

function run(tasks: Task[], over: Partial<Run> = {}): Run {
  return {
    status: "running",
    intake: "build it",
    config: cfg(),
    tasks,
    invocations: 0,
    costEstimate: 0,
    offers: [],
    haltReason: null,
    haltOptions: [],
    stallCulprits: [],
    stallSignature: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function leased(id: string, owner = "drv", over: Partial<Task> = {}): Task {
  return task({
    id,
    status: "leased",
    lease: { owner, expiresAt: LATER, heartbeatAt: T0 },
    ...over,
  });
}

// ───────────────────────── path + gate derivation ─────────────────────────

Deno.test("normalizePath strips ./ and collapses //", () => {
  assertEquals(normalizePath("./src//a.ts"), "src/a.ts");
});

Deno.test("pathEscapes flags traversal, absolute, and spaces", () => {
  assert(pathEscapes("../etc/passwd"));
  assert(pathEscapes("/etc/passwd"));
  assert(pathEscapes("a b.ts"));
  assert(!pathEscapes("src/a.ts"));
});

Deno.test("pathInSet matches tree prefixes and trailing *", () => {
  assert(pathInSet("tests/unit/x.ts", ["tests/"]));
  assert(pathInSet("tests/unit/x.ts", ["tests"]));
  assert(pathInSet("src/a.ts", ["src/*"]));
  assert(!pathInSet("src/a.ts", ["tests/"]));
});

Deno.test("deriveGate: disjoint allowlist → real", () => {
  const g = deriveGate(["src/a.ts"], ["tests/"]);
  assertEquals(g, { gate: "real" });
});

Deno.test("deriveGate: allowlist ⊆ verifyInputs → advisory", () => {
  const g = deriveGate(["tests/a_test.ts"], ["tests/"]);
  assertEquals(g, { gate: "advisory" });
});

Deno.test("deriveGate: MIXED allowlist is rejected (must split)", () => {
  const g = deriveGate(["src/a.ts", "tests/a_test.ts"], ["tests/"]);
  assert("error" in g);
});

// ───────────────────────── scheduler / DAG ─────────────────────────

Deno.test("readyTaskIds: only pending tasks whose deps are all done, sorted", () => {
  const r = run([
    task({ id: "b", dependsOn: ["a"] }),
    task({ id: "a", status: "done" }),
    task({ id: "c", dependsOn: ["a", "z"] }), // z missing/not done
  ]);
  assertEquals(readyTaskIds(r), ["b"]);
});

Deno.test("hasCycle / wouldCycle detect cycles", () => {
  const cyclic = [
    task({ id: "a", dependsOn: ["b"] }),
    task({ id: "b", dependsOn: ["a"] }),
  ];
  assert(hasCycle(cyclic));
  const acyclic = [task({ id: "a" }), task({ id: "b", dependsOn: ["a"] })];
  assert(!hasCycle(acyclic));
  assert(wouldCycle(acyclic, "a", "b")); // a depends-on b, b→a exists? b deps a → yes cycle
});

// ───────────────────────── follow-ups ─────────────────────────

Deno.test("addFollowup: inserts a blocking node, parent waits", () => {
  const r = run([leased("p")]);
  const res = addFollowup(r, "p", "fix the thing", ["src/b.ts"], LATER);
  assert("run" in res);
  const parent = res.run.tasks.find((t) => t.id === "p")!;
  assertEquals(parent.status, "waiting_followup");
  assert(parent.dependsOn.length === 1);
  const fid = parent.dependsOn[0];
  const fu = res.run.tasks.find((t) => t.id === fid)!;
  assertEquals(fu.followupDepth, 1);
  assertEquals(fu.status, "pending");
});

Deno.test("addFollowup: rejects depth > cap", () => {
  const r = run([leased("p", "drv", { followupDepth: 3 })], {
    config: cfg({ maxFollowupDepth: 3 }),
  });
  const res = addFollowup(r, "p", "deep", ["src/b.ts"], LATER);
  assert("error" in res);
});

Deno.test("addFollowup: rejects target outside repoScope", () => {
  const r = run([leased("p")]);
  const res = addFollowup(r, "p", "escape", ["/etc/passwd"], LATER);
  assert("error" in res);
});

// ───────────────────────── the green gate (forgeability) ─────────────────────────

Deno.test("gate greens a code task ONLY on verifyExitCode===0", () => {
  const r = run([
    leased("a", "drv", { gate: "real", writeAllowlist: ["src/a.ts"] }),
  ]);
  const wr = { diff: "d", changedPaths: ["src/a.ts"], followups: [] };
  const ok = applyReport(r, "a", "drv", wr, 0, LATER);
  assert("run" in ok && ok.run.tasks[0].outcome === "done");
  const bad = applyReport(r, "a", "drv", wr, 1, LATER);
  assert("run" in bad && bad.run.tasks[0].outcome === "test_failed");
});

Deno.test("FORGERY FIX: a code task editing a verifyInputs file is hard-rejected", () => {
  // even with exit 0, touching the gate's own tests must not green.
  const r = run([
    leased("a", "drv", {
      gate: "real",
      writeAllowlist: ["src/a.ts", "tests/a_test.ts"],
    }),
  ]);
  const wr = { diff: "d", changedPaths: ["tests/a_test.ts"], followups: [] };
  const res = applyReport(r, "a", "drv", wr, 0, LATER);
  assert("run" in res);
  assertEquals(res.run.tasks[0].outcome, "infra_error");
  assertEquals(res.run.tasks[0].failureKind, "out_of_allowlist");
});

Deno.test("an advisory (test) task MAY edit verifyInputs and green on exit 0", () => {
  const r = run([
    leased("t", "drv", {
      gate: "advisory",
      writeAllowlist: ["tests/a_test.ts"],
    }),
  ]);
  const wr = { diff: "d", changedPaths: ["tests/a_test.ts"], followups: [] };
  const res = applyReport(r, "t", "drv", wr, 0, LATER);
  assert("run" in res && res.run.tasks[0].outcome === "done");
});

Deno.test("out-of-allowlist escape is rejected even on exit 0", () => {
  const r = run([leased("a", "drv", { writeAllowlist: ["src/a.ts"] })]);
  const wr = { diff: "d", changedPaths: ["src/other.ts"], followups: [] };
  const res = applyReport(r, "a", "drv", wr, 0, LATER);
  assert("run" in res && res.run.tasks[0].outcome === "infra_error");
});

Deno.test("parse failure → infra_error and does NOT consume an attempt", () => {
  const r = run([leased("a", "drv", { attempts: 0 })]);
  const wr = {
    diff: "",
    changedPaths: [],
    followups: [],
    failureKind: "envelope_parse" as const,
  };
  const res = applyReport(r, "a", "drv", wr, 1, LATER);
  assert("run" in res);
  assertEquals(res.run.tasks[0].outcome, "infra_error");
  assertEquals(res.run.tasks[0].attempts, 0);
});

Deno.test("test_failed retries until maxAttempts then exhausted", () => {
  const r = run([leased("a", "drv", { attempts: 1 })], {
    config: cfg({ maxAttempts: 2 }),
  });
  const wr = { diff: "d", changedPaths: ["src/a.ts"], followups: [] };
  const res = applyReport(r, "a", "drv", wr, 1, LATER);
  assert("run" in res);
  assertEquals(res.run.tasks[0].outcome, "exhausted");
  assertEquals(res.run.tasks[0].attempts, 2);
});

Deno.test("report rejects a stale / non-owner / expired lease", () => {
  const r = run([
    leased("a", "drv", {
      lease: { owner: "drv", expiresAt: T0, heartbeatAt: T0 },
    }),
  ]);
  const wr = { diff: "d", changedPaths: ["src/a.ts"], followups: [] };
  assert("error" in applyReport(r, "a", "other", wr, 0, LATER)); // owner mismatch
  assert("error" in applyReport(r, "a", "drv", wr, 0, LATER)); // expired (expiresAt=T0 < LATER)
});

Deno.test("leaseExpired compares against now", () => {
  assert(leaseExpired({ owner: "x", expiresAt: T0, heartbeatAt: T0 }, LATER));
  assert(!leaseExpired({ owner: "x", expiresAt: LATER, heartbeatAt: T0 }, T0));
});

Deno.test("every halt cause yields a non-empty actionable option block", () => {
  for (
    const cause of ["exhausted", "stalled", "blocked", "infra_error"] as const
  ) {
    const opts = haltOptionsFor(cause);
    assert(opts.length >= 1, `${cause} has no options`);
    assert(opts.every((o) => o.trim().length > 0));
  }
});

// ───────────────────────── scheduler decision + parsing ─────────────────────
import { detectStall, markBlocked, nextDecision } from "./gobrr.ts";

Deno.test("nextDecision leases the lowest-id ready task and counts an invocation", () => {
  const r = run([task({ id: "b" }), task({ id: "a" })]);
  const { decision, run: nr } = nextDecision(r, "drv", T0);
  assertEquals(decision.outcome, "leased");
  assertEquals(decision.taskId, "a");
  assertEquals(nr.invocations, 1);
  assertEquals(nr.tasks.find((t) => t.id === "a")!.status, "leased");
});

Deno.test("nextDecision returns all-green when every task is done", () => {
  const r = run([task({ id: "a", status: "done" })]);
  assertEquals(nextDecision(r, "drv", T0).decision.outcome, "all-green");
});

Deno.test("nextDecision reaps an expired lease back to pending (attempt counted)", () => {
  const r = run([
    task({
      id: "a",
      status: "leased",
      attempts: 0,
      lease: { owner: "x", expiresAt: T0, heartbeatAt: T0 },
    }),
  ]);
  const { run: nr } = nextDecision(r, "drv", LATER);
  const a = nr.tasks.find((t) => t.id === "a")!;
  // reaped to pending then re-leased this same call; attempts incremented by the reap
  assert(a.attempts === 1);
});

Deno.test("nextDecision honours the concurrency cap (set to 1 here)", () => {
  const r = run([
    task({
      id: "a",
      status: "leased",
      lease: { owner: "x", expiresAt: LATER, heartbeatAt: T0 },
    }),
    task({ id: "b" }),
  ]);
  const { decision } = nextDecision(r, "drv", T0);
  assertEquals(decision.outcome, "leased");
  assertEquals(decision.taskId, undefined); // in-flight, did NOT lease b
});

Deno.test("nextDecision halts on the wallclock cap", () => {
  const r = run([task({ id: "a" })], { config: cfg({ wallclockSeconds: 1 }) });
  const { decision } = nextDecision(r, "drv", "2026-06-09T05:00:00.000Z");
  assertEquals(decision.cap, "wallclock");
  assert(haltOptionsFor(decision.outcome));
});

Deno.test("markBlocked propagates blocked to descendants of an exhausted task", () => {
  const tasks = markBlocked([
    task({ id: "a", status: "exhausted" }),
    task({ id: "b", dependsOn: ["a"] }),
    task({ id: "c", dependsOn: ["b"] }),
  ]);
  assertEquals(tasks.find((t) => t.id === "b")!.status, "blocked");
  assertEquals(tasks.find((t) => t.id === "c")!.status, "blocked");
});

Deno.test("detectStall fires when the last K offers produced no done task", () => {
  const r = run([
    task({
      id: "a",
      status: "test_failed",
      attempts: 2,
      failureSignature: "a:exit1",
    }),
  ], { offers: ["a", "a", "a"], config: cfg({ stallK: 3 }) });
  const s = detectStall(r);
  assert(s.stalled);
  assertEquals(s.culprits, ["a"]);
});

// (envelope parsing moved to the source-integration model; see
// source_integration.test.ts for the @@EDIT parser + nonce-fence forgery tests.)

import { RunConfigSchema } from "./gobrr.ts";
Deno.test("RunConfig defaults leafEffort to low", () => {
  const c = RunConfigSchema.parse({
    verifyCommand: "deno test",
    verifyInputs: ["tests/"],
    repoScope: "src",
    toolchainImage: "img@sha256:abc",
  });
  assertEquals(c.leafEffort, "low");
  assertEquals(c.maxConcurrentVMs, 5);
  // full effort enum matches the fc-task-server substrate
  for (const e of ["low", "medium", "high", "xhigh", "max"]) {
    assertEquals(
      RunConfigSchema.parse({
        verifyCommand: "x",
        verifyInputs: ["t/"],
        repoScope: "s",
        toolchainImage: "i@sha256:a",
        leafEffort: e,
      }).leafEffort,
      e,
    );
  }
});

// ───────────────────────── trust ledger (derived projection) ─────────────────────────

Deno.test("trustSummary: derives per-gate promise-keeping stats from terminal task statuses", () => {
  const r = run([
    task({ id: "r1", gate: "real", status: "done", attempts: 0 }),
    task({ id: "r2", gate: "real", status: "done", attempts: 2 }),
    task({ id: "r3", gate: "real", status: "exhausted", attempts: 2 }),
    task({ id: "a1", gate: "advisory", status: "done", attempts: 0 }),
    // excluded: cascade non-execution, host failure, and non-terminal
    task({ id: "b1", gate: "real", status: "blocked" }),
    task({ id: "i1", gate: "real", status: "infra_error" }),
    task({ id: "p1", gate: "real", status: "pending" }),
  ]);
  const ts = trustSummary(r);
  assertEquals(ts.real.kept, 2);
  assertEquals(ts.real.broken, 1);
  assertEquals(ts.real.passRate, 2 / 3);
  assertEquals(ts.real.greenFirstTryRate, 0.5); // r1 first-try, r2 not
  assertEquals(ts.real.meanAttemptsToGreen, 2); // (1 + 3) / 2
  assertEquals(ts.advisory.kept, 1);
  assertEquals(ts.advisory.broken, 0);
  assertEquals(ts.advisory.passRate, 1);
  assertEquals(ts.advisory.greenFirstTryRate, 1);
  assertEquals(ts.advisory.meanAttemptsToGreen, 1);
});

Deno.test("trustSummary: merge_conflict counts as broken", () => {
  const r = run([task({ id: "m", gate: "real", status: "merge_conflict" })]);
  assertEquals(trustSummary(r).real.broken, 1);
  assertEquals(trustSummary(r).real.kept, 0);
  // kept=0 → the green-derived rates must be 0, never NaN.
  assertEquals(trustSummary(r).real.greenFirstTryRate, 0);
  assertEquals(trustSummary(r).real.meanAttemptsToGreen, 0);
  assertEquals(trustSummary(r).real.passRate, 0); // 0 kept / 1 total
});

Deno.test("trustSummary: a gate with only excluded tasks produces no bucket; empty run → {}", () => {
  assertEquals(trustSummary(run([])), {});
  const onlyExcluded = run([
    task({ id: "b", gate: "real", status: "blocked" }),
    task({ id: "i", gate: "real", status: "infra_error" }),
  ]);
  assertEquals(trustSummary(onlyExcluded), {});
});
