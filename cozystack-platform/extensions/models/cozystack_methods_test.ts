/**
 * Method-level tests for @magistr/cozystack-platform — every one of the 23
 * methods (happy + failure path) plus both model.checks, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` (and the distinct
 * `runCheck()` runner for checks) against a stubbed, stateful `Deno.Command`
 * fake and a fake context.
 *
 * cozystack.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Credential-leak assertions run for getAppSecret/getTenantKubeconfig: the
 * decoded secret payload must never appear in a thrown error, a logger call,
 * or any OTHER written resource.
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

// Note: no method test in this file exercises the kubectl() retry loop (every
// happy/failure scenario here resolves on the first subprocess call), so no
// globalThis.setTimeout stub is needed — see cozystack_coverage_test.ts for
// the dedicated retry-then-succeed / retry-exhaust characterization, which
// DOES stub setTimeout (invoke-immediately, restored in finally).

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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type CheckMap = Record<string, {
  execute: (ctx?: unknown) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

function runCheck(name: string, ctx?: unknown) {
  const check = (model.checks as CheckMap)[name];
  assert(check, `check ${name} must exist on the model`);
  return check.execute(ctx);
}

const GLOBAL_ARGS = {};
const NOT_FOUND = {
  success: false,
  stderr: 'Error from server (NotFound): deployments.apps "x" not found',
};

// ===========================================================================
// getOperatorStatus
// ===========================================================================

Deno.test("getOperatorStatus: happy — ready>=desired writes success:true", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      }),
    }],
    async () => {
      await run("getOperatorStatus", {}, ctx);
    },
  );
  const res = written.find((w) => w.name === "operator-status")!;
  assertEquals(res.payload.success, true);
});

Deno.test("getOperatorStatus: failure path — kubectl error is CAUGHT, writes success:false 'Operator not found'", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await run("getOperatorStatus", {}, ctx);
  });
  const res = written.find((w) => w.name === "operator-status")!;
  assertEquals(res.payload.success, false);
  assert((res.payload.message as string).startsWith("Operator not found:"));
});

// ===========================================================================
// getFluxTenantsStatus
// ===========================================================================

Deno.test("getFluxTenantsStatus: happy — hostNetwork+tolerations present writes success:true", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        spec: {
          replicas: 1,
          template: {
            spec: {
              hostNetwork: true,
              tolerations: [
                { key: "node.kubernetes.io/not-ready" },
                { key: "node.cilium.io/agent-not-ready" },
              ],
            },
          },
        },
        status: { readyReplicas: 1 },
      }),
    }],
    async () => {
      await run("getFluxTenantsStatus", {}, ctx);
    },
  );
  const res = written.find((w) => w.name === "flux-tenants-status")!;
  assertEquals(res.payload.success, true);
});

Deno.test("getFluxTenantsStatus: failure path — kubectl error CAUGHT, writes success:false 'flux-tenants not found'", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await run("getFluxTenantsStatus", {}, ctx);
  });
  const res = written.find((w) => w.name === "flux-tenants-status")!;
  assertEquals(res.payload.success, false);
  assert((res.payload.message as string).startsWith("flux-tenants not found:"));
});

// ===========================================================================
// getNodePodCIDRs — NOT wrapped in try/catch, failure propagates
// ===========================================================================

Deno.test("getNodePodCIDRs: happy — all nodes assigned writes success:true", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        items: [{
          metadata: { name: "n1" },
          spec: { podCIDR: "10.244.0.0/24" },
        }],
      }),
    }],
    async () => {
      await run("getNodePodCIDRs", {}, ctx);
    },
  );
  const res = written.find((w) => w.name === "node-pod-cidrs")!;
  assertEquals(res.payload.success, true);
});

Deno.test("getNodePodCIDRs: failure path — kubectl error is NOT caught, propagates as a rejection", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(() => run("getNodePodCIDRs", {}, ctx));
  });
});

// ===========================================================================
// getPlatformPackage
// ===========================================================================

Deno.test("getPlatformPackage: happy — Ready=True writes success:true", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        spec: { variant: "isp-full" },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      }),
    }],
    async () => {
      await run("getPlatformPackage", {}, ctx);
    },
  );
  const res = written.find((w) => w.name === "platform-package-status")!;
  assertEquals(res.payload.success, true);
});

Deno.test("getPlatformPackage: failure path — kubectl error CAUGHT, writes success:false 'Platform Package not found'", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await run("getPlatformPackage", {}, ctx);
  });
  const res = written.find((w) => w.name === "platform-package-status")!;
  assertEquals(res.payload.success, false);
  assert(
    (res.payload.message as string).startsWith("Platform Package not found:"),
  );
});

// ===========================================================================
// listAppDefinitions — NOT wrapped in try/catch
// ===========================================================================

Deno.test("listAppDefinitions: happy — writes one appDef resource per item", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        items: [{
          metadata: { name: "postgres" },
          spec: { application: { kind: "Postgres" } },
        }],
      }),
    }],
    async () => {
      await run("listAppDefinitions", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "appDef").length, 1);
});

Deno.test("listAppDefinitions: failure path — kubectl error is NOT caught, propagates", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(() => run("listAppDefinitions", {}, ctx));
  });
});

// ===========================================================================
// listApps — two-call flow (api-resources discovery, then per-resource get)
// ===========================================================================

Deno.test("listApps: happy — discovers resource names, then queries each, writes app resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        expect: { command: "kubectl", argsInclude: ["api-resources"] },
        stdout: "postgreses.apps.cozystack.io\n",
      },
      {
        expect: {
          command: "kubectl",
          argsInclude: ["postgreses.apps.cozystack.io"],
        },
        stdout: JSON.stringify({
          items: [{
            metadata: { name: "db", namespace: "tenant-root" },
            spec: {},
          }],
        }),
      },
    ],
    async () => {
      await run("listApps", { namespace: "tenant-root" }, ctx);
    },
  );
  const apps = written.filter((w) => w.spec === "app");
  assertEquals(apps.length, 1);
  assertEquals(apps[0].payload.name, "db");
});

Deno.test("listApps: kind filter narrows which discovered resources are queried", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        stdout: "postgreses.apps.cozystack.io\nkubernetes.apps.cozystack.io\n",
      },
      {
        expect: {
          command: "kubectl",
          argsInclude: ["postgreses.apps.cozystack.io"],
        },
        stdout: JSON.stringify({ items: [] }),
      },
    ],
    async (calls) => {
      await run(
        "listApps",
        { namespace: "tenant-root", kind: "postgres" },
        ctx,
      );
      assertEquals(calls.length, 2, "only the matching kind is queried");
    },
  );
});

Deno.test("listApps: empty discovery throws 'No apps.cozystack.io resources found'", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "" }], async () => {
    await assertRejects(
      () => run("listApps", { namespace: "tenant-root" }, ctx),
      Error,
      "No apps.cozystack.io resources found",
    );
  });
});

Deno.test("listApps: a per-resource get failure is SWALLOWED (caught), other resources still processed", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "postgreses.apps.cozystack.io\nvms.apps.cozystack.io\n" },
      { success: false, stderr: "no postgreses in this namespace" },
      {
        stdout: JSON.stringify({
          items: [{
            metadata: { name: "vm1", namespace: "tenant-root" },
            spec: {},
          }],
        }),
      },
    ],
    async () => {
      await run("listApps", { namespace: "tenant-root" }, ctx);
    },
  );
  const apps = written.filter((w) => w.spec === "app");
  assertEquals(apps.length, 1);
  assertEquals(apps[0].payload.name, "vm1");
});

// ===========================================================================
// getApp — NOT wrapped in try/catch
// ===========================================================================

Deno.test("getApp: happy — writes the app resource", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "tenant-root" },
        spec: { replicas: 2 },
      }),
    }],
    async () => {
      await run(
        "getApp",
        { namespace: "tenant-root", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  assertEquals(written.filter((w) => w.spec === "app").length, 1);
});

Deno.test("getApp: failure path — kubectl error is NOT caught, propagates", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(
      () =>
        run(
          "getApp",
          { namespace: "tenant-root", kind: "Postgres", name: "db" },
          ctx,
        ),
    );
  });
});

// ===========================================================================
// createApp — spawn + stdin manifest
// ===========================================================================

Deno.test("createApp: happy — pipes the manifest via stdin, writes success:true", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "kubectl", argsInclude: ["apply", "-f", "-"] },
      stdout: "postgres.apps.cozystack.io/db created",
    }],
    async (calls) => {
      await run(
        "createApp",
        {
          namespace: "tenant-root",
          kind: "Postgres",
          name: "db",
          specJson: '{"replicas":2}',
        },
        ctx,
      );
      const manifest = JSON.parse(calls[0].stdin!);
      assertEquals(manifest.kind, "Postgres");
      assertEquals(manifest.metadata.name, "db");
      assertEquals(manifest.spec, { replicas: 2 });
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("createApp: failure path — apply failure throws with the kind/name in the message", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "admission webhook denied the request" }],
    async () => {
      await assertRejects(
        () =>
          run(
            "createApp",
            { namespace: "tenant-root", kind: "Postgres", name: "db" },
            ctx,
          ),
        Error,
        "Failed to create Postgres/db",
      );
    },
  );
});

// ===========================================================================
// deleteApp
// ===========================================================================

Deno.test("deleteApp: happy — writes success:true", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: 'postgres.apps.cozystack.io "db" deleted' }],
    async () => {
      await run(
        "deleteApp",
        { namespace: "tenant-root", kind: "Postgres", name: "db" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("deleteApp: failure path — kubectl() throws, not caught", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(
      () =>
        run(
          "deleteApp",
          { namespace: "tenant-root", kind: "Postgres", name: "db" },
          ctx,
        ),
    );
  });
});

// ===========================================================================
// listTenants
// ===========================================================================

Deno.test("listTenants: happy — writes tenant resources, default namespace tenant-root", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "kubectl", argsInclude: ["tenant-root"] },
      stdout: JSON.stringify({
        items: [{
          metadata: { name: "root", namespace: "tenant-root" },
          spec: {},
        }],
      }),
    }],
    async () => {
      await run("listTenants", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "tenant").length, 1);
});

Deno.test("listTenants: failure path — not caught, propagates", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(() => run("listTenants", {}, ctx));
  });
});

// ===========================================================================
// createTenant
// ===========================================================================

Deno.test("createTenant: happy with host — manifest.spec.host is set", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "tenant/myteam created" }],
    async (calls) => {
      await run(
        "createTenant",
        { name: "myteam", host: "myteam.cluster.example" },
        ctx,
      );
      const manifest = JSON.parse(calls[0].stdin!);
      assertEquals(manifest.spec.host, "myteam.cluster.example");
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("createTenant: happy without host — manifest.spec has no host key", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "tenant/myteam created" }],
    async (calls) => {
      await run("createTenant", { name: "myteam" }, ctx);
      const manifest = JSON.parse(calls[0].stdin!);
      assert(!("host" in manifest.spec));
    },
  );
});

Deno.test("createTenant: failure path — apply failure throws with the tenant name", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "quota exceeded" }],
    async () => {
      await assertRejects(
        () => run("createTenant", { name: "myteam" }, ctx),
        Error,
        "Failed to create tenant myteam",
      );
    },
  );
});

// ===========================================================================
// listPackages
// ===========================================================================

Deno.test("listPackages: happy — writes package resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        items: [{
          metadata: { name: "cozystack.cozystack-platform" },
          spec: {},
        }],
      }),
    }],
    async () => {
      await run("listPackages", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "package").length, 1);
});

Deno.test("listPackages: failure path — not caught, propagates", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(() => run("listPackages", {}, ctx));
  });
});

// ===========================================================================
// listWorkloads
// ===========================================================================

Deno.test("listWorkloads: happy scoped to a namespace — uses -n, not -A", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "kubectl", argsInclude: ["-n"] },
      stdout: JSON.stringify({
        items: [{
          metadata: { name: "db-0", namespace: "tenant-root" },
          status: {},
        }],
      }),
    }],
    async () => {
      await run("listWorkloads", { namespace: "tenant-root" }, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "workload").length, 1);
});

Deno.test("listWorkloads: happy without namespace — uses -A (all namespaces)", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "kubectl", argsInclude: ["-A"] },
      stdout: JSON.stringify({ items: [] }),
    }],
    async () => {
      await run("listWorkloads", {}, ctx);
    },
  );
});

Deno.test("listWorkloads: failure path — not caught, propagates", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(() => run("listWorkloads", {}, ctx));
  });
});

// ===========================================================================
// getAppSecret / getTenantKubeconfig — credential-leak assertions
// ===========================================================================

Deno.test("getAppSecret: happy — decodes every data key, writes only to the sensitive secret resource", async () => {
  const { ctx, written, logs } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "tenant-root" },
        data: { password: "c2VjcmV0LXZhbHVlLTEyMw==" }, // "secret-value-123"
      }),
    }],
    async () => {
      await run("getAppSecret", { namespace: "tenant-root", name: "db" }, ctx);
    },
  );
  const secret = written.find((w) => w.spec === "secret")!;
  assert((secret.payload.dataJson as string).includes("secret-value-123"));
  const others = written.filter((w) => w.spec !== "secret");
  for (const w of others) {
    assert(!JSON.stringify(w.payload).includes("secret-value-123"));
  }
  for (const l of logs) {
    assert(!JSON.stringify(l.args).includes("secret-value-123"));
  }
});

Deno.test("getTenantKubeconfig: happy — two calls (server lookup, then secret), decoded token never logged or in another resource", async () => {
  const { ctx, written, logs } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "https://192.0.2.10:6443" },
      {
        stdout: JSON.stringify({
          data: {
            token: "c2VjcmV0LXRlbmFudC10b2tlbg==", // "secret-tenant-token"
            namespace: "dGVuYW50LW15dGVhbQ==",
            "ca.crt": "ZmFrZWNhY2VydGRhdGE=",
          },
        }),
      },
    ],
    async (calls) => {
      await run(
        "getTenantKubeconfig",
        { tenantNamespace: "tenant-myteam", tenantName: "myteam" },
        ctx,
      );
      assertEquals(calls.length, 2);
    },
  );
  const secret = written.find((w) => w.spec === "secret")!;
  assert((secret.payload.dataJson as string).includes("secret-tenant-token"));
  const others = written.filter((w) => w.spec !== "secret");
  for (const w of others) {
    assert(!JSON.stringify(w.payload).includes("secret-tenant-token"));
  }
  for (const l of logs) {
    assert(!JSON.stringify(l.args).includes("secret-tenant-token"));
  }
});

// ===========================================================================
// updateApp — get current, merge, apply
// ===========================================================================

Deno.test("updateApp: happy — merges newFields over current.spec and applies", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        expect: { command: "kubectl", argsInclude: ["get"] },
        stdout: JSON.stringify({
          apiVersion: "apps.cozystack.io/v1alpha1",
          kind: "Postgres",
          spec: { replicas: 2, size: "10Gi" },
        }),
      },
      {
        expect: { command: "kubectl", argsInclude: ["apply"] },
        stdout: "postgres.apps.cozystack.io/db configured",
      },
    ],
    async (calls) => {
      await run(
        "updateApp",
        {
          namespace: "tenant-root",
          kind: "Postgres",
          name: "db",
          specJson: '{"replicas":3}',
        },
        ctx,
      );
      const manifest = JSON.parse(calls[1].stdin!);
      assertEquals(manifest.spec, { replicas: 3, size: "10Gi" });
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("updateApp: failure path — apply failure throws with kind/name", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: JSON.stringify({ spec: {} }) },
      { success: false, stderr: "conflict" },
    ],
    async () => {
      await assertRejects(
        () =>
          run(
            "updateApp",
            {
              namespace: "tenant-root",
              kind: "Postgres",
              name: "db",
              specJson: "{}",
            },
            ctx,
          ),
        Error,
        "Failed to update Postgres/db",
      );
    },
  );
});

// ===========================================================================
// install — TWO subprocesses (helm, then kubectl)
// ===========================================================================

Deno.test("install: happy — helm succeeds, kubectl apply succeeds", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { expect: { command: "helm" }, stdout: "helm upgraded" },
      { expect: { command: "kubectl" }, stdout: "configmap applied" },
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
  assertEquals(res.payload.success, true);
});

Deno.test("install: helm failure throws 'Helm install failed', kubectl is never invoked", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "chart not found" }],
    async (calls) => {
      await assertRejects(
        () =>
          run(
            "install",
            { version: "0.31.0", platformConfigPath: "./cfg.yaml" },
            ctx,
          ),
        Error,
        "Helm install failed",
      );
      assertEquals(
        calls.length,
        1,
        "kubectl apply must not run after helm fails",
      );
    },
  );
});

Deno.test("install: kubectl config-apply failure throws 'Failed to apply platform config'", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "helm upgraded" },
      { success: false, stderr: "invalid YAML" },
    ],
    async () => {
      await assertRejects(
        () =>
          run(
            "install",
            { version: "0.31.0", platformConfigPath: "./cfg.yaml" },
            ctx,
          ),
        Error,
        "Failed to apply platform config",
      );
    },
  );
});

// ===========================================================================
// waitReady
// ===========================================================================

Deno.test("waitReady: happy — writes success:true with rollout stdout as message", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: 'deployment "cozystack-operator" successfully rolled out\n' }],
    async () => {
      await run("waitReady", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
  assertEquals(
    res.payload.message,
    'deployment "cozystack-operator" successfully rolled out',
  );
});

Deno.test("waitReady: failure path — kubectl() throws, not caught", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([NOT_FOUND], async () => {
    await assertRejects(() => run("waitReady", {}, ctx));
  });
});

// ===========================================================================
// applyPackage
// ===========================================================================

Deno.test("applyPackage: happy — manifest carries defaults + required fields, externalIPs omitted", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "package applied" }], async (calls) => {
    await run(
      "applyPackage",
      { host: "cluster.example", apiServerEndpoint: "https://192.0.2.10:6443" },
      ctx,
    );
    const manifest = JSON.parse(calls[0].stdin!);
    const publishing = manifest.spec.components.platform.values.publishing;
    assertEquals(publishing.host, "cluster.example");
    assert(!("externalIPs" in publishing));
    const networking = manifest.spec.components.platform.values.networking;
    assertEquals(networking.podCIDR, "10.244.0.0/16");
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("applyPackage: happy — externalIPs, when given, are included", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "package applied" }], async (calls) => {
    await run(
      "applyPackage",
      {
        host: "cluster.example",
        apiServerEndpoint: "https://192.0.2.10:6443",
        externalIPs: ["203.0.113.10"],
      },
      ctx,
    );
    const manifest = JSON.parse(calls[0].stdin!);
    assertEquals(
      manifest.spec.components.platform.values.publishing.externalIPs,
      ["203.0.113.10"],
    );
  });
});

Deno.test("applyPackage: failure path — apply failure throws 'Failed to apply Platform Package'", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "invalid spec" }],
    async () => {
      await assertRejects(
        () =>
          run(
            "applyPackage",
            {
              host: "cluster.example",
              apiServerEndpoint: "https://192.0.2.10:6443",
            },
            ctx,
          ),
        Error,
        "Failed to apply Platform Package",
      );
    },
  );
});

// ===========================================================================
// patchFluxTenants — retries=10, retryDelay=15000; happy path never sleeps
// ===========================================================================

Deno.test("patchFluxTenants: happy — first attempt succeeds, no retry/sleep involved", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "deployment.apps/flux-tenants patched" }],
    async () => {
      await run("patchFluxTenants", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

// ===========================================================================
// assignPodCIDRs
// ===========================================================================

Deno.test("assignPodCIDRs: happy — assigns unassigned nodes, skips already-assigned ones", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: { name: "node-0" },
              spec: { podCIDR: "10.244.9.0/24" },
            },
            { metadata: { name: "node-1" }, spec: {} },
          ],
        }),
      },
      {
        expect: { command: "kubectl", argsInclude: ["node-1"] },
        stdout: "node/node-1 patched",
      },
    ],
    async (calls) => {
      await run("assignPodCIDRs", {}, ctx);
      assertEquals(calls.length, 2, "only the unassigned node is patched");
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.message, "Assigned PodCIDRs to 1 nodes");
});

Deno.test("assignPodCIDRs: a per-node patch failure is CAUGHT into warnings, not thrown", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        stdout: JSON.stringify({
          items: [{ metadata: { name: "node-0" }, spec: {} }],
        }),
      },
      { success: false, stderr: "node not found" },
    ],
    async () => {
      await run("assignPodCIDRs", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true, "outer result stays success:true");
  assert((res.payload.warnings as string[])[0].includes("Failed to assign"));
});

// ===========================================================================
// listHelmReleases — readyOnly / notReadyOnly filters
// ===========================================================================

Deno.test("listHelmReleases: readyOnly=true excludes not-ready releases from written resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: "a", namespace: "ns" },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          },
          {
            metadata: { name: "b", namespace: "ns" },
            status: { conditions: [{ type: "Ready", status: "False" }] },
          },
        ],
      }),
    }],
    async () => {
      await run("listHelmReleases", { readyOnly: true }, ctx);
    },
  );
  const results = written.filter((w) => w.spec === "result");
  assertEquals(results.length, 1);
  assertEquals(results[0].name, "hr-ns-a");
});

Deno.test("listHelmReleases: notReadyOnly=true excludes ready releases from written resources", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: "a", namespace: "ns" },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          },
          {
            metadata: { name: "b", namespace: "ns" },
            status: { conditions: [{ type: "Ready", status: "False" }] },
          },
        ],
      }),
    }],
    async () => {
      await run("listHelmReleases", { notReadyOnly: true }, ctx);
    },
  );
  const results = written.filter((w) => w.spec === "result");
  assertEquals(results.length, 1);
  assertEquals(results[0].name, "hr-ns-b");
});

// ===========================================================================
// configurePlatform
// ===========================================================================

Deno.test("configurePlatform: happy — patches the root tenant, no externalIPs -> no service patch", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "kubectl", argsInclude: ["root"] },
      stdout: "tenant.apps.cozystack.io/root patched",
    }],
    async (calls) => {
      await run("configurePlatform", {}, ctx);
      assertEquals(
        calls.length,
        1,
        "no externalIPs -> only the tenant patch runs",
      );
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
});

Deno.test("configurePlatform: happy — externalIPs given, patches both tenant and ingress service", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { expect: { argsInclude: ["root"] }, stdout: "patched" },
      {
        expect: { argsInclude: ["ingress-nginx-controller"] },
        stdout: "patched",
      },
    ],
    async (calls) => {
      await run("configurePlatform", { externalIPs: ["203.0.113.20"] }, ctx);
      assertEquals(calls.length, 2);
    },
  );
});

Deno.test("configurePlatform: root tenant patch failure is NOT caught, propagates", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "tenant not found" }],
    async () => {
      await assertRejects(() => run("configurePlatform", {}, ctx));
    },
  );
});

Deno.test("configurePlatform: ingress service patch failure IS caught into warnings, root patch already succeeded", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "tenant patched" },
      { success: false, stderr: "service not found" },
    ],
    async () => {
      await run("configurePlatform", { externalIPs: ["203.0.113.20"] }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.success, true);
  assert(
    (res.payload.warnings as string[])[0].includes(
      "Failed to patch ingress service externalIPs",
    ),
  );
});

// ===========================================================================
// Checks — cluster-reachable / helm-available, all three branches each
// ===========================================================================

Deno.test("check cluster-reachable: kubectl non-success -> pass:false with the stderr first line", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "dial tcp: connection refused\nmore detail" }],
    async () => {
      const result = await runCheck("cluster-reachable", ctx);
      assertEquals(result.pass, false);
      assertEquals(result.errors, [
        "Cluster unreachable: dial tcp: connection refused",
      ]);
    },
  );
});

Deno.test("check cluster-reachable: command construction THROWS -> caught, pass:false 'kubectl not available'", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const original = Deno.Command;
  class ThrowingCommand {
    constructor() {
      throw new Error("kubectl: command not found");
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = ThrowingCommand;
  try {
    const result = await runCheck("cluster-reachable", ctx);
    assertEquals(result.pass, false);
    assert(result.errors![0].startsWith("kubectl not available:"));
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});

Deno.test("check helm-available: helm non-success -> pass:false 'helm binary found but returned error'", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ success: false, stderr: "unexpected" }],
    async () => {
      const result = await runCheck("helm-available", ctx);
      assertEquals(result, {
        pass: false,
        errors: ["helm binary found but returned error"],
      });
    },
  );
});

Deno.test("check helm-available: command construction THROWS -> caught, pass:false 'helm binary not found in PATH'", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const original = Deno.Command;
  class ThrowingCommand {
    constructor() {
      throw new Error("helm: command not found");
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = ThrowingCommand;
  try {
    const result = await runCheck("helm-available", ctx);
    assertEquals(result, {
      pass: false,
      errors: ["helm binary not found in PATH"],
    });
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});
