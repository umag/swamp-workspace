/**
 * Coverage suite: sweeps every guard/branch in cozystack.ts that the
 * contract/methods/adversarial suites don't already exercise on BOTH sides,
 * so deleting any one of these guards turns a test red (STANDARD.md's
 * coverage role — a behavioral regression guard, not a numeric percentage).
 *
 * cozystack.ts is UNMODIFIED; every test PINS existing behavior. This suite
 * carries the retry-loop characterization (isTransientKubectlError,
 * fail-then-succeed / retry-exhaustion) — the ONE place in this repo's tests
 * that stubs `globalThis.setTimeout`, always invoke-immediately (never a
 * no-op discard, which would hang the retry Promise forever) and always
 * restored per-test in `finally`, so it can never leak into another test's
 * timing.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./cozystack.ts";

// ---------------------------------------------------------------------------
// Harness (see cozystack_test.ts for the fuller doc comment on the fake)
// ---------------------------------------------------------------------------

interface CapturedCall {
  command: string;
  args: string[];
  stdin?: string;
}

interface ScriptedCall {
  expect?: { command?: string; argsInclude?: string[] };
  success?: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
}

function withCommandStub(
  script: ScriptedCall[],
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  const queue = [...script];
  const encoder = new TextEncoder();

  function concatChunks(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function resolveCall(
    command: string,
    args: string[],
    stdinChunks?: Uint8Array[],
  ) {
    const idx = calls.length;
    const stdin = stdinChunks && stdinChunks.length > 0
      ? new TextDecoder().decode(concatChunks(stdinChunks))
      : undefined;
    calls.push({ command, args, stdin });
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `command fake: unrouted call #${idx} — ${command} ${
          args.join(" ")
        } (script queue exhausted; script enough responses for every ` +
          `subprocess this execution path issues)`,
      );
    }
    if (next.expect?.command && next.expect.command !== command) {
      throw new Error(
        `command fake: call #${idx} expected command "${next.expect.command}" ` +
          `but got "${command}" (args: ${args.join(" ")})`,
      );
    }
    if (next.expect?.argsInclude) {
      for (const a of next.expect.argsInclude) {
        if (!args.includes(a)) {
          throw new Error(
            `command fake: call #${idx} (${command} ${
              args.join(" ")
            }) missing expected arg "${a}"`,
          );
        }
      }
    }
    const success = next.success ?? true;
    return {
      success,
      stdout: encoder.encode(next.stdout ?? ""),
      stderr: encoder.encode(next.stderr ?? ""),
      code: next.code ?? (success ? 0 : 1),
    };
  }

  class FakeCommand {
    #command: string;
    #args: string[];
    constructor(command: string, options: { args?: string[] } = {}) {
      this.#command = command;
      this.#args = options.args ?? [];
    }
    output() {
      return Promise.resolve(resolveCall(this.#command, this.#args));
    }
    spawn() {
      const chunks: Uint8Array[] = [];
      const command = this.#command;
      const args = this.#args;
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              chunks.push(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => Promise.resolve(resolveCall(command, args, chunks)),
      };
    }
  }

  const original = Deno.Command;
  const descriptor = Object.getOwnPropertyDescriptor(Deno, "Command");
  const canAssign = !descriptor || descriptor.writable !== false;
  if (canAssign) {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = FakeCommand;
  } else {
    Object.defineProperty(Deno, "Command", {
      value: FakeCommand,
      configurable: true,
      writable: true,
    });
  }
  return fn(calls).finally(() => {
    Object.defineProperty(Deno, "Command", {
      value: original,
      configurable: true,
      writable: true,
    });
  });
}

/** Stub globalThis.setTimeout to invoke its callback IMMEDIATELY. cozystack.ts's
 * retry loop is `await new Promise((r) => setTimeout(r, retryDelay))` — a
 * no-op stub that discards the callback would leave that Promise unresolved
 * forever and hang the test to timeout. Always restored in `finally`, scoped
 * to just the tests below, so it never perturbs any other suite's timing
 * (in particular, the property suite's fast-check runs never see this stub). */
function withImmediateTimers<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    _timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === "function") handler(...args);
    return 0;
  }) as typeof setTimeout;
  return fn().finally(() => {
    globalThis.setTimeout = original;
  });
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
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
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
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

type CheckMap = Record<string, {
  execute: (ctx?: unknown) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

function runCheck(name: string, ctx?: unknown) {
  const check = (model.checks as CheckMap)[name];
  return check.execute(ctx);
}

const GLOBAL_ARGS = {};
const TRANSIENT_FAIL: ScriptedCall = {
  success: false,
  stderr: "dial tcp 10.0.0.1:6443: connection refused",
};

// ===========================================================================
// Retry loop: isTransientKubectlError — fail-then-succeed and exhaustion
// ===========================================================================

Deno.test("retry: patchFluxTenants — two transient failures then success succeeds on the 3rd attempt (retry COUNT, no real sleep)", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withImmediateTimers(() =>
    withCommandStub(
      [TRANSIENT_FAIL, TRANSIENT_FAIL, { stdout: "patched" }],
      async (calls) => {
        await run("patchFluxTenants", {}, ctx);
        assertEquals(calls.length, 3, "exactly 2 retries before success");
      },
    )
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("retry: patchFluxTenants — retries=10 exhausted (11 total attempts) throws, no real sleep", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const script = Array.from({ length: 11 }, () => TRANSIENT_FAIL);
  await withImmediateTimers(() =>
    withCommandStub(script, async (calls) => {
      await assertRejects(
        () => run("patchFluxTenants", {}, ctx),
        Error,
        "failed",
      );
      assertEquals(
        calls.length,
        11,
        "retries=10 means 11 total attempts (0..10 inclusive) before giving up",
      );
    })
  );
});

Deno.test("retry: a NON-transient failure (e.g. NotFound) does not retry at all — fails on the first attempt", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      success: false,
      stderr: 'Error from server (NotFound): deployments.apps "x" not found',
    }],
    async (calls) => {
      await assertRejects(() => run("patchFluxTenants", {}, ctx));
      assertEquals(
        calls.length,
        1,
        "non-transient errors never enter the retry branch",
      );
    },
  );
});

// ===========================================================================
// parseAge — <24h, >=24h, and "unknown" (no creationTimestamp)
// ===========================================================================

Deno.test("parseAge: an app with no creationTimestamp writes age 'unknown'", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "ns" },
        spec: {},
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "ns", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "app")!;
  assertEquals(res.payload.age, "unknown");
});

Deno.test("parseAge: an app created a few hours ago writes age in 'Nh' form (<24h)", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  const recent = new Date(Date.now() - 3 * 3600_000).toISOString();
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "ns", creationTimestamp: recent },
        spec: {},
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "ns", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "app")!;
  assert(
    /^\d+h$/.test(res.payload.age as string),
    `expected 'Nh', got ${res.payload.age}`,
  );
});

Deno.test("parseAge: an app created days ago writes age in 'Nd' form (>=24h)", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "ns", creationTimestamp: old },
        spec: {},
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "ns", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "app")!;
  assertEquals(res.payload.age, "5d");
});

// ===========================================================================
// getCondition / getConditionMessage — undefined conditions, no match, match
// ===========================================================================

Deno.test("getCondition/getConditionMessage: conditions ABSENT -> ready/status both undefined", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "ns" },
        spec: {},
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "ns", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "app")!;
  assertEquals(res.payload.ready, undefined);
  assertEquals(res.payload.status, undefined);
});

Deno.test("getCondition/getConditionMessage: conditions PRESENT but no 'Ready' type -> both undefined", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "ns" },
        spec: {},
        status: { conditions: [{ type: "Progressing", status: "True" }] },
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "ns", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "app")!;
  assertEquals(res.payload.ready, undefined);
});

Deno.test("getCondition/getConditionMessage: a matching 'Ready' condition returns its status and message", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "ns" },
        spec: {},
        status: {
          conditions: [{ type: "Ready", status: "False", message: "waiting" }],
        },
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "ns", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "app")!;
  assertEquals(res.payload.ready, "False");
  assertEquals(res.payload.status, "waiting");
});

// ===========================================================================
// getOperatorStatus — readyReplicas||0 and (spec.replicas||1) defaults
// ===========================================================================

Deno.test("getOperatorStatus: readyReplicas MISSING defaults to 0, spec.replicas MISSING defaults to 1 -> not ready", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify({ spec: {}, status: {} }) }],
    async () => {
      await run("getOperatorStatus", {}, ctx);
    },
  );
  const res = written.find((w) => w.name === "operator-status")!;
  assertEquals(res.payload.success, false);
  assertEquals(res.payload.message, "Operator: 0/1 ready");
});

Deno.test("getOperatorStatus: readyReplicas and spec.replicas BOTH present -> uses the real values", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        spec: { replicas: 3 },
        status: { readyReplicas: 3 },
      }),
    }],
    async () => {
      await run("getOperatorStatus", {}, ctx);
    },
  );
  const res = written.find((w) => w.name === "operator-status")!;
  assertEquals(res.payload.message, "Operator: 3/3 ready");
});

// ===========================================================================
// data.items || [] — every list-shaped method, absent-items guard
// ===========================================================================

Deno.test("data.items||[] guard: listAppDefinitions with items ABSENT writes zero resources, does not throw", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: JSON.stringify({}) }], async () => {
    await run("listAppDefinitions", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "appDef").length, 0);
});

Deno.test("data.items||[] guard: listTenants with items ABSENT writes zero resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: JSON.stringify({}) }], async () => {
    await run("listTenants", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "tenant").length, 0);
});

Deno.test("data.items||[] guard: listPackages with items ABSENT writes zero resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: JSON.stringify({}) }], async () => {
    await run("listPackages", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "package").length, 0);
});

Deno.test("data.items||[] guard: listWorkloads with items ABSENT writes zero resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: JSON.stringify({}) }], async () => {
    await run("listWorkloads", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "workload").length, 0);
});

Deno.test("data.items||[] guard: listHelmReleases with items ABSENT writes zero resources, logs 0/0 ready", async () => {
  const { ctx, written, logs } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: JSON.stringify({}) }], async () => {
    await run("listHelmReleases", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "result").length, 0);
  const summary = logs.find((l) =>
    typeof l.args[0] === "string" &&
    (l.args[0] as string).includes("HelmReleases:")
  );
  assertEquals(summary?.args[0], "HelmReleases: 0/0 ready");
});

Deno.test("data.items||[] guard: listApps' per-resource response with items ABSENT writes zero app resources (no throw)", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "postgreses.apps.cozystack.io\n" },
      { stdout: JSON.stringify({}) },
    ],
    async () => {
      await run("listApps", { namespace: "tenant-root" }, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "app").length, 0);
});

// ===========================================================================
// listApps — api-resources parsing: single line, no trailing newline
// ===========================================================================

Deno.test("listApps: api-resources output with a single resource name and NO trailing newline still parses", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "postgreses.apps.cozystack.io" },
      {
        expect: { argsInclude: ["postgreses.apps.cozystack.io"] },
        stdout: JSON.stringify({ items: [] }),
      },
    ],
    async (calls) => {
      await run("listApps", { namespace: "tenant-root" }, ctx);
      assertEquals(calls.length, 2);
    },
  );
});

// ===========================================================================
// assignPodCIDRs — boundary: all-skipped and all-assigned
// ===========================================================================

Deno.test("assignPodCIDRs: every node already has a podCIDR -> zero patches issued, message says 0 nodes", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        items: [
          { metadata: { name: "n0" }, spec: { podCIDR: "10.244.0.0/24" } },
          { metadata: { name: "n1" }, spec: { podCIDR: "10.244.1.0/24" } },
        ],
      }),
    }],
    async (calls) => {
      await run("assignPodCIDRs", {}, ctx);
      assertEquals(calls.length, 1, "only the initial get nodes — no patches");
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.message, "Assigned PodCIDRs to 0 nodes");
});

Deno.test("assignPodCIDRs: every node is unassigned -> every node is patched", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        stdout: JSON.stringify({
          items: [{ metadata: { name: "n0" }, spec: {} }, {
            metadata: { name: "n1" },
            spec: {},
          }],
        }),
      },
      { stdout: "patched" },
      { stdout: "patched" },
    ],
    async (calls) => {
      await run("assignPodCIDRs", {}, ctx);
      assertEquals(calls.length, 3);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.message, "Assigned PodCIDRs to 2 nodes");
});

// ===========================================================================
// configurePlatform — externalIPs empty array is treated as falsy (no patch)
// ===========================================================================

Deno.test("configurePlatform: externalIPs=[] (empty array) is falsy for the length check — no service patch issued", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "patched" }], async (calls) => {
    await run("configurePlatform", { externalIPs: [] }, ctx);
    assertEquals(
      calls.length,
      1,
      "empty externalIPs array never reaches the service patch",
    );
  });
});

// ===========================================================================
// install — success WITH stderr output populates warnings from both steps
// ===========================================================================

Deno.test("install: helm succeeds but emits stderr -> warnings capture the helm stderr lines", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "helm ok", stderr: "some helm deprecation warning" },
      { stdout: "kubectl ok" },
    ],
    async () => {
      await run(
        "install",
        { version: "0.31.0", platformConfigPath: "./cfg.yaml" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assert(
    (res.payload.warnings as string[]).includes(
      "some helm deprecation warning",
    ),
  );
});

Deno.test("install: both helm AND kubectl emit stderr on success -> warnings accumulate from BOTH steps", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "helm ok", stderr: "helm warning" },
      { stdout: "kubectl ok", stderr: "kubectl warning" },
    ],
    async () => {
      await run(
        "install",
        { version: "0.31.0", platformConfigPath: "./cfg.yaml" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  const warnings = res.payload.warnings as string[];
  assert(warnings.includes("helm warning"));
  assert(warnings.includes("kubectl warning"));
});

// ===========================================================================
// waitReady — stderr populates warnings; empty stdout falls back to default
// ===========================================================================

Deno.test("waitReady: empty stdout falls back to the default 'deployment is ready' message", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "" }], async () => {
    await run("waitReady", {}, ctx);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.message, "Cozystack operator deployment is ready");
});

Deno.test("waitReady: non-empty stderr on success populates warnings", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "rolled out", stderr: "slow rollout warning" }],
    async () => {
      await run("waitReady", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assert((res.payload.warnings as string[]).includes("slow rollout warning"));
});

// ===========================================================================
// Both model.checks — pass / non-success / throw, named explicitly here too
// (the round-1 review finding required these enumerated in THIS suite, even
// though methods_test.ts and cozystack_test.ts also exercise each branch)
// ===========================================================================

Deno.test("check cluster-reachable: all three branches — pass, non-success, throw", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "control plane running" }], async () => {
    assertEquals(await runCheck("cluster-reachable", ctx), { pass: true });
  });
  await withCommandStub([{ success: false, stderr: "timeout" }], async () => {
    const r = await runCheck("cluster-reachable", ctx);
    assertEquals(r.pass, false);
  });
  const original = Deno.Command;
  class Throwing {
    constructor() {
      throw new Error("no kubectl binary");
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = Throwing;
  try {
    const r = await runCheck("cluster-reachable", ctx);
    assertEquals(r.pass, false);
    assert(r.errors![0].startsWith("kubectl not available:"));
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});

Deno.test("check helm-available: all three branches — pass, non-success, throw", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "v3.15.0" }], async () => {
    assertEquals(await runCheck("helm-available", ctx), { pass: true });
  });
  await withCommandStub([{ success: false, stderr: "bad" }], async () => {
    const r = await runCheck("helm-available", ctx);
    assertEquals(r, {
      pass: false,
      errors: ["helm binary found but returned error"],
    });
  });
  const original = Deno.Command;
  class Throwing {
    constructor() {
      throw new Error("no helm binary");
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = Throwing;
  try {
    const r = await runCheck("helm-available", ctx);
    assertEquals(r, { pass: false, errors: ["helm binary not found in PATH"] });
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});
