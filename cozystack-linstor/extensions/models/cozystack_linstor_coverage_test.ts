/**
 * Coverage suite: sweeps every remaining guard/branch in cozystack_linstor.ts
 * that the contract-fixture/methods/adversarial suites don't already
 * exercise on BOTH sides, so deleting any one of these guards turns a test
 * red (STANDARD.md's coverage role — a behavioral regression guard, not a
 * numeric percentage). Includes the FOLD-IN 2 (LOW) finding approved
 * alongside plan v2: the linstor-controller-ready check's parseInt-NaN
 * fail-open.
 *
 * cozystack_linstor.ts is UNMODIFIED; every test PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./cozystack_linstor.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Resp = { success: boolean; stdout: string; stderr: string };
type Invocation = { command: string; args: string[] };

function installCmdStub(queue: Resp[]) {
  const invocations: Invocation[] = [];
  const original = Deno.Command;
  const enc = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: { args: string[] }) {
      this.#cmd = cmd;
      this.#args = opts.args;
    }
    output() {
      invocations.push({ command: this.#cmd, args: this.#args });
      const r = queue.shift() ?? { success: true, stdout: "", stderr: "" };
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        signal: null,
        stdout: enc.encode(r.stdout),
        stderr: enc.encode(r.stderr),
      });
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type ChecksMap = Record<string, {
  execute: (ctx: unknown) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

function runCheck(name: string, ctx: unknown) {
  const check = (model.checks as ChecksMap)[name];
  return check.execute(ctx);
}

// ---------------------------------------------------------------------------
// isTransientError: all 8 substrings retry exactly once (via linstor())
// ---------------------------------------------------------------------------

const TRANSIENT_SUBSTRINGS = [
  "connection refused",
  "connection reset",
  "Unable to connect to the server",
  "i/o timeout",
  "TLS handshake timeout",
  "net/http: request canceled",
  "ECONNREFUSED",
  "ETIMEDOUT",
];

Deno.test("isTransientError: every one of the 8 documented substrings triggers exactly one retry", async () => {
  using time = new FakeTime();
  for (const substring of TRANSIENT_SUBSTRINGS) {
    const stub = installCmdStub([
      {
        success: false,
        stdout: "",
        stderr: `some prefix: ${substring} some suffix`,
      },
      { success: true, stdout: JSON.stringify([{ nodes: [] }]), stderr: "" },
    ]);
    const { ctx } = makeCtx();
    try {
      const p = run("listNodes", {}, ctx);
      await time.tickAsync(5000);
      await p;
    } finally {
      stub.restore();
    }
    assertEquals(
      stub.invocations.length,
      2,
      `"${substring}" must be recognized as transient and retried once`,
    );
  }
});

Deno.test("isTransientError: a substring NOT on the documented list is treated as non-transient — no retry", async () => {
  const stub = installCmdStub([
    { success: false, stdout: "", stderr: "permission denied" },
  ]);
  const { ctx } = makeCtx();
  try {
    await run("listNodes", {}, ctx).catch(() => {});
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    1,
    "an unrecognized error string must not retry",
  );
});

// ---------------------------------------------------------------------------
// kubeconfig/context present+absent — kubectl-based, linstor-based, checks
// ---------------------------------------------------------------------------

Deno.test("kubectl-based (getLinstorControllerStatus): kubeconfig only — --context is never appended", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({ status: {}, spec: {} }),
    stderr: "",
  }]);
  const { ctx } = makeCtx({ kubeconfig: "/tmp/kc" });
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args.slice(-2), ["--kubeconfig", "/tmp/kc"]);
  assert(!stub.invocations[0].args.includes("--context"));
});

Deno.test("kubectl-based (getLinstorControllerStatus): context only — --kubeconfig is never appended", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({ status: {}, spec: {} }),
    stderr: "",
  }]);
  const { ctx } = makeCtx({ context: "cozy" });
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args.slice(-2), ["--context", "cozy"]);
  assert(!stub.invocations[0].args.includes("--kubeconfig"));
});

Deno.test("kubectl-based (getLinstorControllerStatus): neither set — no flags appended at all", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({ status: {}, spec: {} }),
    stderr: "",
  }]);
  const { ctx } = makeCtx({});
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "get",
    "deploy/linstor-controller",
    "-n",
    "cozy-linstor",
    "-o",
    "json",
  ]);
});

Deno.test("linstor-based (listNodes): both kubeconfig and context set — both flags appended, kubeconfig before context", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{ nodes: [] }]),
    stderr: "",
  }]);
  const { ctx } = makeCtx({ kubeconfig: "/tmp/kc", context: "cozy" });
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations[0].args.slice(-4),
    ["--kubeconfig", "/tmp/kc", "--context", "cozy"],
  );
});

Deno.test("linstor-based (listNodes): neither set — no flags appended", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{ nodes: [] }]),
    stderr: "",
  }]);
  const { ctx } = makeCtx({});
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    "node",
    "list",
    "--output-version=v1",
    "-m",
  ]);
});

Deno.test("checks: both kubeconfig+context set — both appended for cluster-reachable and linstor-controller-ready", async () => {
  const stub1 = installCmdStub([{ success: true, stdout: "", stderr: "" }]);
  const ctx1 = makeCtx({ kubeconfig: "/tmp/kc", context: "cozy" }).ctx;
  try {
    await runCheck("cluster-reachable", ctx1);
  } finally {
    stub1.restore();
  }
  assertEquals(stub1.invocations[0].args, [
    "cluster-info",
    "--request-timeout=5s",
    "--kubeconfig",
    "/tmp/kc",
    "--context",
    "cozy",
  ]);

  const stub2 = installCmdStub([{ success: true, stdout: "1", stderr: "" }]);
  const ctx2 = makeCtx({ kubeconfig: "/tmp/kc", context: "cozy" }).ctx;
  try {
    await runCheck("linstor-controller-ready", ctx2);
  } finally {
    stub2.restore();
  }
  assertEquals(stub2.invocations[0].args, [
    "get",
    "deploy/linstor-controller",
    "-n",
    "cozy-linstor",
    "-o",
    "jsonpath={.status.readyReplicas}",
    "--kubeconfig",
    "/tmp/kc",
    "--context",
    "cozy",
  ]);
});

Deno.test("checks: neither kubeconfig nor context set — no flags appended for either check", async () => {
  const stub1 = installCmdStub([{ success: true, stdout: "", stderr: "" }]);
  const ctx1 = makeCtx({}).ctx;
  try {
    await runCheck("cluster-reachable", ctx1);
  } finally {
    stub1.restore();
  }
  assertEquals(stub1.invocations[0].args, [
    "cluster-info",
    "--request-timeout=5s",
  ]);

  const stub2 = installCmdStub([{ success: true, stdout: "1", stderr: "" }]);
  const ctx2 = makeCtx({}).ctx;
  try {
    await runCheck("linstor-controller-ready", ctx2);
  } finally {
    stub2.restore();
  }
  assertEquals(stub2.invocations[0].args, [
    "get",
    "deploy/linstor-controller",
    "-n",
    "cozy-linstor",
    "-o",
    "jsonpath={.status.readyReplicas}",
  ]);
});

// ---------------------------------------------------------------------------
// FOLD-IN 2 (LOW): linstor-controller-ready parseInt-NaN fail-open
// ---------------------------------------------------------------------------

Deno.test("FOLD-IN check linstor-controller-ready: a non-numeric stdout ('abc') fails OPEN — parseInt('abc')=NaN, NaN<1 is false, so pass:true", async () => {
  // `!output.success || !stdout || parseInt(stdout) < 1` — every disjunct is
  // false for a non-empty, non-numeric stdout: output.success is true,
  // stdout is truthy, and parseInt("abc") is NaN, and `NaN < 1` evaluates to
  // false (NaN compares false against everything). The destructive-op
  // pre-flight gate therefore PASSES on a malformed readyReplicas value
  // instead of failing closed. Low-probability in practice (kubectl's
  // jsonpath usually yields a digit string or empty), but a real fail-open
  // direction on a safety gate — pinned here, not fixed (model source frozen).
  const stub = installCmdStub([{ success: true, stdout: "abc", stderr: "" }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("linstor-controller-ready", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(
    result.pass,
    true,
    "documented fail-open gap: a non-numeric readyReplicas value passes the guard",
  );
});

// ---------------------------------------------------------------------------
// getLinstorControllerStatus: `|| 0` / `|| 1` defaults on both sides
// ---------------------------------------------------------------------------

Deno.test("getLinstorControllerStatus: readyReplicas and replicas BOTH absent -> defaults 0/1, success:false", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({}),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "linstor-controller-status")!;
  assertEquals(res.payload.success, false);
  assertEquals(res.payload.message, "linstor-controller: 0/1 ready");
});

Deno.test("getLinstorControllerStatus: explicit replicas:0 (falsy) ALSO falls back to desired=1 via `|| 1`", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({
      status: { readyReplicas: 0 },
      spec: { replicas: 0 },
    }),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "linstor-controller-status")!;
  assertEquals(
    res.payload.message,
    "linstor-controller: 0/1 ready",
    "explicit 0 replicas is indistinguishable from an absent field",
  );
});

Deno.test("getLinstorControllerStatus: readyReplicas >= replicas with non-default counts -> success:true, exact ratio in message", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({
      status: { readyReplicas: 3 },
      spec: { replicas: 3 },
    }),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "linstor-controller-status")!;
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, "linstor-controller: 3/3 ready");
});

// ---------------------------------------------------------------------------
// listStoragePools: reports/free_space/provider_kind/props guards, both sides
// ---------------------------------------------------------------------------

Deno.test("listStoragePools: `reports` is an EMPTY array (still truthy!) -> state:error, NOT ok (no length check, just truthiness)", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{
      stor_pools: [{
        node_name: "worker-0",
        stor_pool_name: "data",
        reports: [],
      }],
    }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "storagePool")!;
  assertEquals(
    res.payload.state,
    "error",
    '`pool.reports ? "error" : "ok"` — an empty array is still truthy',
  );
});

Deno.test("listStoragePools: `reports` explicitly null -> state:ok (null is falsy, unlike an empty array)", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{
      stor_pools: [{
        node_name: "worker-0",
        stor_pool_name: "data",
        reports: null,
      }],
    }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "storagePool")!;
  assertEquals(res.payload.state, "ok");
});

Deno.test("listStoragePools: free_space present but free_capacity/total_capacity explicitly null -> both 'unknown' (`!= null` false for null)", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{
      stor_pools: [{
        node_name: "worker-0",
        stor_pool_name: "data",
        free_space: { free_capacity: null, total_capacity: null },
      }],
    }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "storagePool")!;
  assertEquals(res.payload.free, "unknown");
  assertEquals(res.payload.capacity, "unknown");
});

Deno.test("listStoragePools: total_capacity is a positive number -> rendered as its string form (not 'unknown')", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{
      stor_pools: [{
        node_name: "worker-0",
        stor_pool_name: "data",
        free_space: { free_capacity: 5, total_capacity: 9999999999 },
      }],
    }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "storagePool")!;
  assertEquals(res.payload.free, "5");
  assertEquals(res.payload.capacity, "9999999999");
});

Deno.test("listStoragePools: provider_kind is an empty string (falsy, present) -> falls back to 'unknown'", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{
      stor_pools: [{
        node_name: "worker-0",
        stor_pool_name: "data",
        provider_kind: "",
      }],
    }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "storagePool")!;
  assertEquals(res.payload.driver, "unknown");
});

Deno.test("listStoragePools: props['StorDriver/StorPoolName'] is an empty string (falsy, present) -> falls back to stor_pool_name", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{
      stor_pools: [{
        node_name: "worker-0",
        stor_pool_name: "data",
        props: { "StorDriver/StorPoolName": "" },
      }],
    }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "storagePool")!;
  assertEquals(res.payload.poolName, "data");
});

// ---------------------------------------------------------------------------
// listNodes: type/connection_status/net_interfaces fallbacks
// ---------------------------------------------------------------------------

Deno.test("listNodes: type and connection_status BOTH absent -> both fall back to 'unknown'; net_interfaces absent -> addresses ''", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{ nodes: [{ name: "bare-node" }] }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  const node = written.find((w) => w.name === "bare-node")!;
  assertEquals(node.payload.type, "unknown");
  assertEquals(node.payload.state, "unknown");
  assertEquals(node.payload.addresses, "");
});

// ---------------------------------------------------------------------------
// warnings: present (non-empty stderr) vs empty (no stderr) — createZfsPool,
// setZfsFailmode, applyStorageClasses all share this `stderr ? split : []` shape
// ---------------------------------------------------------------------------

Deno.test("createZfsPool: a non-empty create-device-pool stderr becomes a filtered, non-empty warnings array", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify([{ stor_pools: [] }]), stderr: "" },
    {
      success: true,
      stdout: "",
      stderr: "WARNING: pool created with defaults\n\nWARNING: check ashift",
    },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "create-zfs-worker-0-data")!;
  assertEquals(res.payload.warnings, [
    "WARNING: pool created with defaults",
    "WARNING: check ashift",
  ]);
});

Deno.test("createZfsPool: empty create-device-pool stderr -> `warnings` key is absent (undefined), not an empty array", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify([{ stor_pools: [] }]), stderr: "" },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "create-zfs-worker-0-data")!;
  assertEquals(res.payload.warnings, undefined);
});

Deno.test("setZfsFailmode / applyStorageClasses: same warnings shape — present vs empty", async () => {
  const stub1 = installCmdStub([{
    success: true,
    stdout: "",
    stderr: "note: failmode set\n",
  }]);
  const { ctx: ctx1, written: w1 } = makeCtx();
  try {
    await run("setZfsFailmode", { node: "worker-0" }, ctx1);
  } finally {
    stub1.restore();
  }
  assertEquals(
    w1.find((w) => w.name === "set-failmode-worker-0-data")!.payload.warnings,
    ["note: failmode set"],
  );

  const stub2 = installCmdStub([{
    success: true,
    stdout: "applied\n",
    stderr: "",
  }]);
  const { ctx: ctx2, written: w2 } = makeCtx();
  try {
    await run("applyStorageClasses", { manifestPath: "./sc.yaml" }, ctx2);
  } finally {
    stub2.restore();
  }
  assertEquals(
    w2.find((w) => w.name === "apply-storage-classes")!.payload.warnings,
    undefined,
  );
});

// ---------------------------------------------------------------------------
// `data[0]?.x || data.x || data` fallback chain — all three shapes, both
// listNodes and listStoragePools
// ---------------------------------------------------------------------------

Deno.test("listNodes: shape 2 — bare `{nodes:[...]}` (no top-level array) uses the `data.nodes` fallback", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({ nodes: [{ name: "n2" }] }),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(written.find((w) => w.spec === "node")!.payload.name, "n2");
});

Deno.test("listNodes: shape 3 — a bare top-level array of node objects uses the final `data` fallback", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{ name: "n3" }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(written.find((w) => w.spec === "node")!.payload.name, "n3");
});

Deno.test("listStoragePools: shape 2 — bare `{stor_pools:[...]}` uses the `data.stor_pools` fallback", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({
      stor_pools: [{ node_name: "worker-0", stor_pool_name: "p2" }],
    }),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(
    written.find((w) => w.spec === "storagePool")!.payload.storagePool,
    "p2",
  );
});

Deno.test("listStoragePools: shape 3 — a bare top-level array of pool objects uses the final `data` fallback", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify([{ node_name: "worker-0", stor_pool_name: "p3" }]),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(
    written.find((w) => w.spec === "storagePool")!.payload.storagePool,
    "p3",
  );
});

// ---------------------------------------------------------------------------
// Dead-code note (documentation only — not independently testable)
// ---------------------------------------------------------------------------
// The trailing `throw new Error(\`linstor ... failed after ${maxRetries + 1}
// attempts\`)` AFTER the retry `for` loop (cozystack_linstor.ts, end of
// `linstor()`) is UNREACHABLE: at attempt === maxRetries (3), the in-loop
// condition `attempt < maxRetries` is false regardless of the error's
// transience, so the in-loop `throw` (pinned by the adversarial suite's
// RETRY exhaustion test) always fires first and the loop never completes
// normally. There is no code path that reaches the post-loop throw, so no
// test can exercise it — this note records that fact rather than asserting
// it, matching the plan's characterization-only scope for this backfill.
