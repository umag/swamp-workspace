/**
 * Property-based tests (fast-check) for @magistr/cozystack-linstor.
 *
 * cozystack_linstor.ts exports no pure helpers — every property here is
 * observed by driving `model.methods.<m>.execute()` / `model.checks[<n>]
 * .execute()` against a stubbed `Deno.Command` and reading back the captured
 * argv / written resource, per the approved plan.
 *
 * Properties:
 *  (a) argv-builder injectivity, over the CANONICAL (non-collapsing) input
 *      subset — createZfsPool issues THREE linstor calls (pre-flight
 *      storage-pool list, physical-storage inventory read, then
 *      create-device-pool); the pre-flight list is stubbed EMPTY and the
 *      inventory read always reports the requested device free, so the
 *      destructive path is always reached, and injectivity is signed over
 *      the THIRD (create-device-pool) invocation's argv only, per the
 *      round-1 review finding that the naive "whole call" framing is false
 *      (the first two calls' argv depend only on `node`).
 *  (b) parser round-trip — listNodes/listStoragePools preserve every
 *      generated wire element, in order, with count == length.
 *  (c) kubeconfig/context flag invariant — across the boolean cross-product,
 *      for every one of the 6 methods PLUS both live checks.
 *  (d) retry-count invariant — N transient failures (N via linstor()) succeed
 *      after exactly N+1 Command invocations when N<=3; N>=4 always throws
 *      after exactly 4 invocations (the reachable in-loop throw).
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./cozystack_linstor.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

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
// (a) createZfsPool argv-builder injectivity — 3rd (create-device-pool) call
// ---------------------------------------------------------------------------

/** Run createZfsPool against an EMPTY pre-flight list and a physical-storage
 * inventory that reports the given `device` as available on the given
 * `node` (so the destructive create-device-pool call is always reached) and
 * return that THIRD invocation's exact argv. */
async function createDeviceArgvFor(
  args: Record<string, unknown>,
): Promise<string[]> {
  const node = args.node as string;
  const device = args.device as string;
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify([{ stor_pools: [] }]), stderr: "" },
    {
      success: true,
      stdout: JSON.stringify([{
        physical_storage: [{
          size: 10737418240,
          rotational: false,
          nodes: { [node]: [{ device }] },
        }],
      }]),
      stderr: "",
    },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx } = makeCtx();
  try {
    await run("createZfsPool", args, ctx);
  } finally {
    stub.restore();
  }
  return stub.invocations[2].args;
}

// Canonical domain: all four fields ALWAYS explicit (never omitted), so the
// poolName/storagePool "default 'data'" collapse never enters this property
// — that collapse is pinned separately as a named example below.
const arbCanonicalCreateArgs = fc.record({
  node: fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/),
  device: fc.stringMatching(/^\/dev\/[a-z]{1,6}[0-9]{0,2}$/),
  poolName: fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
  storagePool: fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
});

function canonicalSignature(a: Record<string, unknown>): string {
  return JSON.stringify([a.node, a.device, a.poolName, a.storagePool]);
}

Deno.test("property: createZfsPool's create-device-pool argv is deterministic — same canonical input -> same argv", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalCreateArgs, async (args) => {
      const a = await createDeviceArgvFor(args);
      const b = await createDeviceArgvFor(args);
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: createZfsPool's create-device-pool argv is INJECTIVE over the canonical (node,device,poolName,storagePool) tuple", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalCreateArgs,
      arbCanonicalCreateArgs,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const argvA = JSON.stringify(await createDeviceArgvFor(a));
        const argvB = JSON.stringify(await createDeviceArgvFor(b));
        return sigA === sigB ? argvA === argvB : argvA !== argvB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});

Deno.test("collapse: createZfsPool poolName omitted and poolName:'data' produce the IDENTICAL create-device-pool argv", async () => {
  const withOmitted = await createDeviceArgvFor({
    node: "worker-0",
    device: "/dev/vdb",
  });
  const withDefault = await createDeviceArgvFor({
    node: "worker-0",
    device: "/dev/vdb",
    poolName: "data",
  });
  assertEquals(withOmitted, withDefault);
});

Deno.test("collapse: createZfsPool storagePool omitted and storagePool:'data' produce the IDENTICAL create-device-pool argv", async () => {
  const withOmitted = await createDeviceArgvFor({
    node: "worker-0",
    device: "/dev/vdb",
  });
  const withDefault = await createDeviceArgvFor({
    node: "worker-0",
    device: "/dev/vdb",
    storagePool: "data",
  });
  assertEquals(withOmitted, withDefault);
});

// ---------------------------------------------------------------------------
// (b) parser round-trip — listNodes / listStoragePools
// ---------------------------------------------------------------------------

const arbWireNode = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
  type: fc.constantFrom("SATELLITE", "CONTROLLER", "COMBINED"),
  connection_status: fc.constantFrom("ONLINE", "OFFLINE"),
  net_interfaces: fc.array(
    fc.record({
      name: fc.stringMatching(/^[a-z0-9]{1,8}$/),
      address: fc.stringMatching(/^192\.0\.2\.[0-9]{1,3}$/),
    }),
    { maxLength: 3 },
  ),
});

Deno.test("property: listNodes preserves every generated node, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbWireNode, { maxLength: 15 }),
      async (nodes) => {
        const stub = installCmdStub([
          { success: true, stdout: JSON.stringify([{ nodes }]), stderr: "" },
        ]);
        const { ctx, written } = makeCtx();
        try {
          await run("listNodes", {}, ctx);
        } finally {
          stub.restore();
        }
        const got = written.filter((w) => w.spec === "node").map((w) =>
          w.payload.name
        );
        const want = nodes.map((n) => n.name);
        return JSON.stringify(got) === JSON.stringify(want);
      },
    ),
    FC_RUNS,
  );
});

const arbWirePool = fc.record({
  node_name: fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
  stor_pool_name: fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
  provider_kind: fc.constantFrom("ZFS", "LVM", "LVM_THIN"),
  free_space: fc.record({
    free_capacity: fc.integer({ min: 0, max: 999999999 }),
    total_capacity: fc.integer({ min: 0, max: 999999999 }),
  }),
});

Deno.test("property: listStoragePools preserves every generated pool, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbWirePool, { maxLength: 15 }),
      async (pools) => {
        const stub = installCmdStub([
          {
            success: true,
            stdout: JSON.stringify([{ stor_pools: pools }]),
            stderr: "",
          },
        ]);
        const { ctx, written } = makeCtx();
        try {
          await run("listStoragePools", {}, ctx);
        } finally {
          stub.restore();
        }
        const got = written.filter((w) => w.spec === "storagePool").map((w) =>
          w.payload.storagePool
        );
        const want = pools.map((p) => p.stor_pool_name);
        return JSON.stringify(got) === JSON.stringify(want);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) kubeconfig/context flag invariant — every method + both checks
// ---------------------------------------------------------------------------

type Scenario = {
  label: string;
  stubs: Resp[];
  invoke: (ctx: unknown) => Promise<unknown>;
};

function scenarios(): Scenario[] {
  return [
    {
      label: "getLinstorControllerStatus",
      stubs: [{
        success: true,
        stdout: JSON.stringify({ status: {}, spec: {} }),
        stderr: "",
      }],
      invoke: (ctx) => run("getLinstorControllerStatus", {}, ctx),
    },
    {
      label: "listNodes",
      stubs: [{
        success: true,
        stdout: JSON.stringify([{ nodes: [] }]),
        stderr: "",
      }],
      invoke: (ctx) => run("listNodes", {}, ctx),
    },
    {
      label: "listStoragePools",
      stubs: [{
        success: true,
        stdout: JSON.stringify([{ stor_pools: [] }]),
        stderr: "",
      }],
      invoke: (ctx) => run("listStoragePools", {}, ctx),
    },
    {
      label: "createZfsPool",
      stubs: [
        {
          success: true,
          stdout: JSON.stringify([{ stor_pools: [] }]),
          stderr: "",
        },
        {
          success: true,
          stdout: JSON.stringify([{
            physical_storage: [{
              size: 10737418240,
              rotational: false,
              nodes: { "worker-0": [{ device: "/dev/vdb" }] },
            }],
          }]),
          stderr: "",
        },
        { success: true, stdout: "", stderr: "" },
      ],
      invoke: (ctx) =>
        run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx),
    },
    {
      label: "setZfsFailmode",
      stubs: [{ success: true, stdout: "", stderr: "" }],
      invoke: (ctx) => run("setZfsFailmode", { node: "worker-0" }, ctx),
    },
    {
      label: "applyStorageClasses",
      stubs: [{ success: true, stdout: "", stderr: "" }],
      invoke: (ctx) =>
        run("applyStorageClasses", { manifestPath: "./sc.yaml" }, ctx),
    },
    {
      label: "check cluster-reachable",
      stubs: [{ success: true, stdout: "", stderr: "" }],
      invoke: (ctx) => runCheck("cluster-reachable", ctx),
    },
    {
      label: "check linstor-controller-ready",
      stubs: [{ success: true, stdout: "1", stderr: "" }],
      invoke: (ctx) => runCheck("linstor-controller-ready", ctx),
    },
  ];
}

Deno.test("property: --kubeconfig/--context are appended to EVERY invocation iff present in globalArgs, for every method and both checks", async () => {
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.boolean(), async (hasKc, hasCtx) => {
      const globalArgs: Record<string, unknown> = {};
      if (hasKc) globalArgs.kubeconfig = "/tmp/kc";
      if (hasCtx) globalArgs.context = "cozy";
      for (const scenario of scenarios()) {
        const stub = installCmdStub(scenario.stubs.map((r) => ({ ...r })));
        const { ctx } = makeCtx(globalArgs);
        try {
          await scenario.invoke(ctx);
        } finally {
          stub.restore();
        }
        for (const inv of stub.invocations) {
          if (inv.args.includes("--kubeconfig") !== hasKc) return false;
          if (inv.args.includes("--context") !== hasCtx) return false;
        }
      }
      return true;
    }),
    { numRuns: NIGHT(50) },
  );
});

// ---------------------------------------------------------------------------
// (d) retry-count invariant — N<=3 succeeds after N+1 calls; N>=4 throws at 4
// ---------------------------------------------------------------------------

Deno.test("property: retry-count invariant — N transient failures succeed after N+1 invocations (N<=3) or throw after exactly 4 (N>=4)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 6 }), async (n) => {
      using time = new FakeTime();
      const failures: Resp[] = Array.from({ length: n }, () => ({
        success: false,
        stdout: "",
        stderr: "connection refused",
      }));
      const stub = installCmdStub([
        ...failures,
        { success: true, stdout: JSON.stringify([{ nodes: [] }]), stderr: "" },
      ]);
      const { ctx } = makeCtx();
      let threw = false;
      try {
        const p = run("listNodes", {}, ctx).catch(() => {
          threw = true;
        });
        for (let i = 0; i < Math.min(n, 3); i++) {
          await time.tickAsync(5000);
        }
        await p;
      } finally {
        stub.restore();
      }
      if (n <= 3) {
        return !threw && stub.invocations.length === n + 1;
      }
      return threw && stub.invocations.length === 4;
    }),
    { numRuns: NIGHT(50) },
  );
});
