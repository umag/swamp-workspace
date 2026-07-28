/**
 * Contract-fixture suite: pins the CONCRETE LINSTOR machine-readable (`-m`)
 * wire shape and the Kubernetes `Deployment` status/spec shape from
 * cozystack-linstor/fixtures/*.json directly — independent of
 * cozystack_linstor.ts's control flow, which this suite drives through the
 * real methods to prove the fixture keyset is exactly what the model reads
 * (see STANDARD.md's contract-fixture role: "if this test breaks, did the
 * contract with the outside world change?").
 *
 * All fixtures are PURE doc-derived synthetic data — see
 * fixtures/PROVENANCE.md. Every test here is offline: the boundary is
 * `Deno.Command`, which is reassigned to a fake before any call and restored
 * after — no subprocess is ever spawned.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./cozystack_linstor.ts";
import nodeList from "../../fixtures/node-list.json" with { type: "json" };
import storagePoolList from "../../fixtures/storage-pool-list.json" with {
  type: "json",
};
import deployReady from "../../fixtures/deploy-ready.json" with {
  type: "json",
};
import deployNotReady from "../../fixtures/deploy-notready.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness — Deno.Command is the boundary (not fetch); reassign + restore.
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

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: {},
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

// ---------------------------------------------------------------------------
// node-list.json contract — linstor node list --output-version=v1 -m
// ---------------------------------------------------------------------------

Deno.test("contract: node-list.json — single-interface node maps name/type/state/addresses verbatim", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(nodeList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  const w0 = written.find((w) => w.name === "worker-0")!;
  assertEquals(w0.spec, "node");
  assertEquals(w0.payload.name, "worker-0");
  assertEquals(w0.payload.type, "SATELLITE");
  assertEquals(w0.payload.state, "ONLINE");
  assertEquals(w0.payload.addresses, "default:192.0.2.10");
});

Deno.test("contract: node-list.json — multi-interface node's addresses are comma-joined in declaration order", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(nodeList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  const w1 = written.find((w) => w.name === "worker-1")!;
  assertEquals(w1.payload.state, "OFFLINE");
  assertEquals(
    w1.payload.addresses,
    "default:192.0.2.11, eth1:192.0.2.21",
  );
});

Deno.test("contract: node-list.json — an empty net_interfaces array yields an empty addresses string", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(nodeList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  const w2 = written.find((w) => w.name === "worker-2")!;
  assertEquals(w2.payload.type, "COMBINED");
  assertEquals(w2.payload.addresses, "");
});

Deno.test("contract: node-list.json — every fixture node is written exactly once, count == 3", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(nodeList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(written.filter((w) => w.spec === "node").length, 3);
  assertEquals(
    nodeList[0].nodes.length,
    3,
    "sanity: the fixture itself declares 3 nodes",
  );
});

// ---------------------------------------------------------------------------
// storage-pool-list.json contract — linstor storage-pool list -m
// ---------------------------------------------------------------------------

Deno.test("contract: storage-pool-list.json — a pool with props.StorDriver/StorPoolName and free_space reports ok/ZFS/exact bytes", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(storagePoolList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const p0 = written.find((w) => w.name === "worker-0-data")!;
  assertEquals(p0.spec, "storagePool");
  assertEquals(p0.payload.node, "worker-0");
  assertEquals(p0.payload.storagePool, "data");
  assertEquals(p0.payload.driver, "ZFS");
  assertEquals(p0.payload.poolName, "data");
  assertEquals(p0.payload.free, "3221225472");
  assertEquals(p0.payload.capacity, "10737418240");
  assertEquals(p0.payload.state, "ok");
});

Deno.test("contract: storage-pool-list.json — free_capacity:0 renders the STRING '0', not 'unknown' (`!= null`, not truthy)", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(storagePoolList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const p1 = written.find((w) => w.name === "worker-1-data")!;
  assertEquals(p1.payload.free, "0");
  assertEquals(p1.payload.capacity, "10737418240");
  assertEquals(
    p1.payload.state,
    "error",
    "a pool carrying a `reports` array maps to state:error",
  );
  assertEquals(
    p1.payload.poolName,
    "data",
    "props:{} has no StorDriver/StorPoolName key — falls back to stor_pool_name",
  );
});

Deno.test("contract: storage-pool-list.json — a pool missing provider_kind/props/free_space entirely falls back to 'unknown'/stor_pool_name", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(storagePoolList), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const p2 = written.find((w) => w.name === "worker-2-data")!;
  assertEquals(p2.payload.driver, "unknown");
  assertEquals(p2.payload.poolName, "data");
  assertEquals(p2.payload.free, "unknown");
  assertEquals(p2.payload.capacity, "unknown");
  assertEquals(p2.payload.state, "ok", "no `reports` key -> state:ok");
});

// ---------------------------------------------------------------------------
// deploy-ready.json / deploy-notready.json contract — getLinstorControllerStatus
// ---------------------------------------------------------------------------

Deno.test("contract: deploy-ready.json — readyReplicas >= replicas maps to success:true with the exact ratio in the message", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(deployReady), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("getLinstorControllerStatus", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.name === "linstor-controller-status")!;
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, "linstor-controller: 1/1 ready");
});

Deno.test("contract: deploy-notready.json — readyReplicas < replicas maps to success:false with the exact ratio in the message", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify(deployNotReady), stderr: "" },
  ]);
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

Deno.test("contract: fixtures declare exactly the documented minimal keyset — only .status.readyReplicas + .spec.replicas", () => {
  assertEquals(Object.keys(deployReady).sort(), ["spec", "status"]);
  assertEquals(Object.keys(deployReady.status), ["readyReplicas"]);
  assertEquals(Object.keys(deployReady.spec), ["replicas"]);
  assertEquals(Object.keys(deployNotReady).sort(), ["spec", "status"]);
});
