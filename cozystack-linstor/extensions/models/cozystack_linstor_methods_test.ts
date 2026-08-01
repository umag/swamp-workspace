/**
 * Method-level tests for @magistr/cozystack-linstor — every one of the 6
 * methods (getLinstorControllerStatus, listNodes, listStoragePools,
 * createZfsPool, setZfsFailmode, applyStorageClasses), happy path + failure
 * path, driven through `model.methods.<m>.arguments.parse()` + `.execute()`
 * against a stubbed `Deno.Command` and a fake context — PLUS the two live
 * pre-flight checks (`cluster-reachable`, `linstor-controller-ready`)
 * executed directly via `model.checks[<name>].execute(ctx)`, since these are
 * the guards that gate the destructive ops (createZfsPool/setZfsFailmode/
 * applyStorageClasses) and must not ship untested (round-1 review HIGH-1).
 *
 * cozystack_linstor.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./cozystack_linstor.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  kubeconfig: "/tmp/kubeconfig-test",
  context: "cozy-test",
};

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

/** A stub whose .output() call REJECTS — models a `kubectl` binary that
 * cannot even be spawned (ENOENT), exercising the checks' `catch` branch. */
function installThrowingCmdStub(message: string) {
  const invocations: Invocation[] = [];
  const original = Deno.Command;
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
      return Promise.reject(new Error(message));
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type ChecksMap = Record<string, {
  execute: (ctx: unknown) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

function runCheck(name: string, ctx: unknown) {
  const check = (model.checks as ChecksMap)[name];
  assert(check, `check ${name} must exist on the model`);
  return check.execute(ctx);
}

const KC_FLAGS = [
  "--kubeconfig",
  "/tmp/kubeconfig-test",
  "--context",
  "cozy-test",
];

// ---------------------------------------------------------------------------
// getLinstorControllerStatus
// ---------------------------------------------------------------------------

Deno.test("getLinstorControllerStatus: happy path — kubectl get -o json, writes linstor-controller-status", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: JSON.stringify({
      status: { readyReplicas: 1 },
      spec: { replicas: 1 },
    }),
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 1);
  assertEquals(stub.invocations[0].command, "kubectl");
  assertEquals(stub.invocations[0].args, [
    "get",
    "deploy/linstor-controller",
    "-n",
    "cozy-linstor",
    "-o",
    "json",
    ...KC_FLAGS,
  ]);
  const res = written.find((w) => w.name === "linstor-controller-status")!;
  assertEquals(res.payload.success, true);
});

Deno.test("getLinstorControllerStatus: failure path — kubectl exits non-zero, catch branch writes success:false with the wrapped message", async () => {
  const stub = installCmdStub([{
    success: false,
    stdout: "",
    stderr: 'deployments.apps "linstor-controller" not found',
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "linstor-controller-status")!;
  assertEquals(res.payload.success, false);
  assert(
    (res.payload.message as string).includes("linstor-controller not found"),
  );
  assert(
    (res.payload.message as string).includes(
      'deployments.apps "linstor-controller" not found',
    ),
  );
});

// ---------------------------------------------------------------------------
// listNodes
// ---------------------------------------------------------------------------

Deno.test("listNodes: happy path — linstor node list via kubectl exec, exact argv, writes one node resource per entry", async () => {
  const payload = JSON.stringify([{
    nodes: [{
      name: "worker-0",
      type: "SATELLITE",
      connection_status: "ONLINE",
      net_interfaces: [{ name: "default", address: "192.0.2.10" }],
    }],
  }]);
  const stub = installCmdStub([{ success: true, stdout: payload, stderr: "" }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 1);
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
    ...KC_FLAGS,
  ]);
  const node = written.find((w) => w.spec === "node")!;
  assertEquals(node.payload.name, "worker-0");
});

Deno.test("listNodes: failure path — a non-transient kubectl error throws immediately (single invocation, no retry)", async () => {
  const stub = installCmdStub([
    { success: false, stdout: "", stderr: "Error: unauthorized" },
  ]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(
      () => run("listNodes", {}, ctx),
      Error,
      "linstor node list --output-version=v1 failed: Error: unauthorized",
    );
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    1,
    "a non-transient error must not trigger a retry",
  );
});

// ---------------------------------------------------------------------------
// listStoragePools
// ---------------------------------------------------------------------------

Deno.test("listStoragePools: happy path — linstor storage-pool list via kubectl exec, exact argv", async () => {
  const payload = JSON.stringify([{
    stor_pools: [{
      node_name: "worker-0",
      stor_pool_name: "data",
      provider_kind: "ZFS",
      props: { "StorDriver/StorPoolName": "data" },
      free_space: { free_capacity: 1000, total_capacity: 2000 },
    }],
  }]);
  const stub = installCmdStub([{ success: true, stdout: payload, stderr: "" }]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
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
    "storage-pool",
    "list",
    "--output-version=v1",
    "-m",
    ...KC_FLAGS,
  ]);
  const pool = written.find((w) => w.spec === "storagePool")!;
  assertEquals(pool.name, "worker-0-data");
});

Deno.test("listStoragePools: failure path — a non-transient kubectl error throws immediately", async () => {
  const stub = installCmdStub([
    { success: false, stdout: "", stderr: "Error: forbidden" },
  ]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(
      () => run("listStoragePools", {}, ctx),
      Error,
      "linstor storage-pool list --output-version=v1 failed: Error: forbidden",
    );
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 1);
});

// ---------------------------------------------------------------------------
// createZfsPool
// ---------------------------------------------------------------------------

Deno.test("createZfsPool: happy path — no existing pool, issues list, physical-storage inventory read, THEN create-device-pool with default poolName/storagePool", async () => {
  const emptyList = JSON.stringify([{ stor_pools: [] }]);
  const deviceFree = JSON.stringify([{
    physical_storage: [{
      size: 10737418240,
      rotational: false,
      nodes: { "worker-0": [{ device: "/dev/vdb" }] },
    }],
  }]);
  const stub = installCmdStub([
    { success: true, stdout: emptyList, stderr: "" },
    { success: true, stdout: deviceFree, stderr: "" },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 3);
  assertEquals(stub.invocations[0].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    "storage-pool",
    "list",
    "-n",
    "worker-0",
    "--output-version=v1",
    "-m",
    ...KC_FLAGS,
  ]);
  assertEquals(stub.invocations[1].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    "physical-storage",
    "list",
    "--output-version=v1",
    "-m",
    ...KC_FLAGS,
  ]);
  assertEquals(stub.invocations[2].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    "physical-storage",
    "create-device-pool",
    "zfs",
    "worker-0",
    "/dev/vdb",
    "--pool-name",
    "data",
    "--storage-pool",
    "data",
    ...KC_FLAGS,
  ]);
  const res = written.find((w) => w.name === "create-zfs-worker-0-data")!;
  assertEquals(res.payload.success, true);
  assert((res.payload.message as string).includes("Created ZFS pool"));
});

Deno.test("createZfsPool: failure path — the pre-flight list call fails non-transiently, no create-device-pool invocation", async () => {
  const stub = installCmdStub([
    { success: false, stdout: "", stderr: "Error: node not found" },
  ]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(() =>
      run("createZfsPool", { node: "ghost", device: "/dev/vdb" }, ctx)
    );
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    1,
    "list failed — no create call issued",
  );
});

// ---------------------------------------------------------------------------
// setZfsFailmode
// ---------------------------------------------------------------------------

Deno.test("setZfsFailmode: happy path — kubectl exec into the linstor-satellite daemonset pod, exact argv", async () => {
  const stub = installCmdStub([{ success: true, stdout: "", stderr: "" }]);
  const { ctx, written } = makeCtx();
  try {
    await run("setZfsFailmode", { node: "worker-0" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "ds/linstor-satellite.worker-0",
    "--",
    "zpool",
    "set",
    "failmode=continue",
    "data",
    ...KC_FLAGS,
  ]);
  const res = written.find((w) => w.name === "set-failmode-worker-0-data")!;
  assertEquals(res.payload.success, true);
});

Deno.test("setZfsFailmode: failure path — kubectl exec fails, throws with the wrapped message", async () => {
  const stub = installCmdStub([
    {
      success: false,
      stdout: "",
      stderr: "error: unable to upgrade connection",
    },
  ]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(
      () => run("setZfsFailmode", { node: "worker-0" }, ctx),
      Error,
      "kubectl exec -n cozy-linstor failed",
    );
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// applyStorageClasses
// ---------------------------------------------------------------------------

Deno.test("applyStorageClasses: happy path — kubectl apply -f <manifestPath>, exact argv", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: "storageclass.storage.k8s.io/linstor-data unchanged\n",
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await run(
      "applyStorageClasses",
      { manifestPath: "./storage-classes.yaml" },
      ctx,
    );
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "apply",
    "-f",
    "./storage-classes.yaml",
    ...KC_FLAGS,
  ]);
  const res = written.find((w) => w.name === "apply-storage-classes")!;
  assertEquals(res.payload.success, true);
});

Deno.test("applyStorageClasses: failure path — kubectl apply fails, throws with the wrapped message", async () => {
  const stub = installCmdStub([
    {
      success: false,
      stdout: "",
      stderr: 'error: unable to recognize "./bad.yaml"',
    },
  ]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(
      () => run("applyStorageClasses", { manifestPath: "./bad.yaml" }, ctx),
      Error,
      "kubectl apply -f ./bad.yaml failed",
    );
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// checks["cluster-reachable"] — executed directly (round-1 review HIGH-1)
// ---------------------------------------------------------------------------

Deno.test("check cluster-reachable: pass:true when kubectl cluster-info succeeds", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: "Kubernetes control plane is running\n",
    stderr: "",
  }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("cluster-reachable", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "cluster-info",
    "--request-timeout=5s",
    ...KC_FLAGS,
  ]);
  assertEquals(result, { pass: true });
});

Deno.test("check cluster-reachable: pass:false with the first stderr line when kubectl exits non-zero", async () => {
  const stub = installCmdStub([{
    success: false,
    stdout: "",
    stderr:
      "Unable to connect to the server: dial tcp: i/o timeout\nmore detail here",
  }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("cluster-reachable", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(result.pass, false);
  assertEquals(
    result.errors,
    ["Cluster unreachable: Unable to connect to the server: dial tcp: i/o timeout"],
  );
});

Deno.test("check cluster-reachable: catch branch — kubectl cannot even be spawned, pass:false with the wrapped error", async () => {
  const stub = installThrowingCmdStub("No such file or directory (os error 2)");
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("cluster-reachable", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(result.pass, false);
  assertEquals(result.errors, [
    "kubectl not available: No such file or directory (os error 2)",
  ]);
});

// ---------------------------------------------------------------------------
// checks["linstor-controller-ready"] — executed directly (round-1 review HIGH-1)
// ---------------------------------------------------------------------------

Deno.test("check linstor-controller-ready: pass:true when readyReplicas is a numeric string >= 1", async () => {
  const stub = installCmdStub([{ success: true, stdout: "1\n", stderr: "" }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("linstor-controller-ready", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "get",
    "deploy/linstor-controller",
    "-n",
    "cozy-linstor",
    "-o",
    "jsonpath={.status.readyReplicas}",
    ...KC_FLAGS,
  ]);
  assertEquals(result, { pass: true });
});

Deno.test("check linstor-controller-ready: fail branch — readyReplicas < 1 (stdout '0')", async () => {
  const stub = installCmdStub([{ success: true, stdout: "0", stderr: "" }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("linstor-controller-ready", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(result.pass, false);
  assertEquals(result.errors, [
    "linstor-controller deployment not ready in cozy-linstor namespace",
  ]);
});

Deno.test("check linstor-controller-ready: fail branch — empty stdout (deployment not found yet)", async () => {
  const stub = installCmdStub([{ success: true, stdout: "", stderr: "" }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("linstor-controller-ready", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(result.pass, false);
});

Deno.test("check linstor-controller-ready: fail branch — kubectl itself exits non-zero", async () => {
  const stub = installCmdStub([{
    success: false,
    stdout: "",
    stderr: "error",
  }]);
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("linstor-controller-ready", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(result.pass, false);
});

Deno.test("check linstor-controller-ready: catch branch — kubectl cannot even be spawned, pass:false with the wrapped error", async () => {
  const stub = installThrowingCmdStub("No such file or directory (os error 2)");
  const { ctx } = makeCtx();
  let result: { pass: boolean; errors?: string[] };
  try {
    result = await runCheck("linstor-controller-ready", ctx);
  } finally {
    stub.restore();
  }
  assertEquals(result.pass, false);
  assertEquals(result.errors, [
    "Cannot check linstor-controller: No such file or directory (os error 2)",
  ]);
});
