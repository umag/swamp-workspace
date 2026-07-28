/**
 * Contract-fixture suite: pins the CONCRETE kubectl/helm wire shapes from
 * cozystack-platform/fixtures/*.json directly, independent of cozystack.ts's
 * resource schemas (several of which use passthrough/z.any()-shaped fields).
 * A suite that only asserted "the written resource validates against the
 * model's schema" would be toothless; this suite hardcodes the expected
 * keyset + value shapes derived from the Kubernetes/Cozystack API object
 * shapes so a real wire-format drift turns a test red (see STANDARD.md's
 * contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed
 * `Deno.Command`, no subprocess is spawned and no network call is made.
 *
 * cozystack.ts is UNMODIFIED by this change — every test characterizes
 * already-shipped behavior.
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { model } from "./cozystack.ts";
import deployOperator from "../../fixtures/deploy_operator.json" with {
  type: "json",
};
import deployFluxTenants from "../../fixtures/deploy_flux_tenants.json" with {
  type: "json",
};
import nodesFixture from "../../fixtures/nodes.json" with { type: "json" };
import platformPackage from "../../fixtures/platform_package.json" with {
  type: "json",
};
import appDefinitions from "../../fixtures/app_definitions.json" with {
  type: "json",
};
import appsFixture from "../../fixtures/apps.json" with { type: "json" };
import tenantsFixture from "../../fixtures/tenants.json" with {
  type: "json",
};
import packagesFixture from "../../fixtures/packages.json" with {
  type: "json",
};
import workloadsFixture from "../../fixtures/workloads.json" with {
  type: "json",
};
import helmReleasesFixture from "../../fixtures/helmreleases.json" with {
  type: "json",
};
import secretFixture from "../../fixtures/secret.json" with { type: "json" };
import tenantSecretFixture from "../../fixtures/tenant_secret.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness — stateful, call-count/queue-scripted Deno.Command fake.
//
// Covers both invocation styles cozystack.ts uses across its 9 construction
// sites (8 direct `new Deno.Command` + the `kubectl()` helper): buffered
// `.output()`, and `.spawn()` + `stdin.getWriter().write()/.close()` +
// `.output()` (the `apply -f -` manifest-capture path). Each test scripts an
// ordered queue of responses; a call beyond the scripted queue throws a loud
// "unrouted" error instead of silently returning undefined, so a miscounted
// multi-call flow (install's helm-then-kubectl, getTenantKubeconfig's
// config-view-then-get-secret, assignPodCIDRs' get-then-N-patches) fails
// visibly rather than producing a confusing downstream assertion failure.
// ---------------------------------------------------------------------------

interface CapturedCall {
  command: string;
  args: string[];
  stdin?: string;
}

interface ScriptedCall {
  /** Optional self-documenting assertion — fails loudly on a mismatch rather
   * than silently returning the wrong canned response. */
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type CheckMap = Record<string, {
  execute: (ctx?: unknown) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

/** model.checks has a DIFFERENT shape from model.methods — execute(ctx)/(),
 * no `arguments`, no `writeResource` calls, returns {pass, errors} — so it
 * needs its own runner rather than the methods-oriented `run()` above. */
function runCheck(name: string, ctx?: unknown) {
  const check = (model.checks as CheckMap)[name];
  assert(check, `check ${name} must exist on the model`);
  return check.execute(ctx);
}

const GLOBAL_ARGS = {};

// ---------------------------------------------------------------------------
// deploy_operator.json — getOperatorStatus
// ---------------------------------------------------------------------------

Deno.test("contract: deploy_operator.json — ready>=desired writes success:true with the ready/desired message", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: {
        command: "kubectl",
        argsInclude: ["deploy/cozystack-operator"],
      },
      stdout: JSON.stringify(deployOperator),
    }],
    async () => {
      await run("getOperatorStatus", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "operator-status");
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, "Operator: 1/1 ready");
  assert(typeof res.payload.timestamp === "string");
});

// ---------------------------------------------------------------------------
// deploy_flux_tenants.json — getFluxTenantsStatus
// ---------------------------------------------------------------------------

Deno.test("contract: deploy_flux_tenants.json — hostNetwork+tolerations present writes success:true, no warnings", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(deployFluxTenants) }],
    async () => {
      await run("getFluxTenantsStatus", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "flux-tenants-status");
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.warnings, undefined);
  assertMatch(res.payload.message as string, /hostNetwork=true/);
});

// ---------------------------------------------------------------------------
// nodes.json — getNodePodCIDRs
// ---------------------------------------------------------------------------

Deno.test("contract: nodes.json — one assigned + one unassigned node writes success:false with a per-node warning", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(nodesFixture) }],
    async () => {
      await run("getNodePodCIDRs", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "node-pod-cidrs");
  assertEquals(res.payload.success, false);
  assertEquals(res.payload.message, "1 nodes missing PodCIDRs");
  assertEquals(res.payload.warnings, ["node-2: no PodCIDR assigned"]);
});

// ---------------------------------------------------------------------------
// platform_package.json — getPlatformPackage
// ---------------------------------------------------------------------------

Deno.test("contract: platform_package.json — Ready=True writes success:true with variant echoed in the message", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(platformPackage) }],
    async () => {
      await run("getPlatformPackage", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "platform-package-status");
  assertEquals(res.payload.success, true);
  assertEquals(
    res.payload.message,
    "Platform Package: variant=isp-full, ready=True",
  );
});

// ---------------------------------------------------------------------------
// app_definitions.json — listAppDefinitions
// ---------------------------------------------------------------------------

const EXPECTED_APPDEF_KEYS = [
  "name",
  "kind",
  "plural",
  "singular",
  "category",
  "description",
  "timestamp",
].sort();

Deno.test("contract: app_definitions.json — every item becomes an appDef resource with the exact documented keyset", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(appDefinitions) }],
    async () => {
      await run("listAppDefinitions", {}, ctx);
    },
  );
  const appDefs = written.filter((w) => w.spec === "appDef");
  assertEquals(appDefs.length, appDefinitions.items.length);
  for (const w of appDefs) {
    assertEquals(Object.keys(w.payload).sort(), EXPECTED_APPDEF_KEYS);
  }
  const postgres = appDefs.find((w) => w.payload.kind === "Postgres")!;
  assertEquals(postgres.payload.plural, "postgreses");
  assertEquals(postgres.payload.category, "database");
});

// ---------------------------------------------------------------------------
// apps.json — getApp
// ---------------------------------------------------------------------------

Deno.test("contract: apps.json — getApp writes an app resource with specJson == JSON.stringify(spec) and age in 'Nd'/'Nh' shape", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  const item = appsFixture.items[0];
  await withCommandStub([{ stdout: JSON.stringify(item) }], async () => {
    await run(
      "getApp",
      { namespace: "tenant-root", kind: "Postgres", name: "db" },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "app")!;
  assertEquals(res.name, "Postgres-db");
  assertEquals(res.payload.namespace, "tenant-root");
  assertEquals(res.payload.specJson, JSON.stringify(item.spec));
  assertEquals(res.payload.ready, "True");
  assertEquals(res.payload.status, "all good");
  assertMatch(res.payload.age as string, /^\d+[hd]$/);
});

// ---------------------------------------------------------------------------
// tenants.json — listTenants
// ---------------------------------------------------------------------------

Deno.test("contract: tenants.json — every item becomes a tenant resource with host/ready from spec/conditions", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(tenantsFixture) }],
    async () => {
      await run("listTenants", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "tenant")!;
  assertEquals(res.payload.name, "root");
  assertEquals(res.payload.host, "cluster.example");
  assertEquals(res.payload.ready, "True");
});

// ---------------------------------------------------------------------------
// packages.json — listPackages
// ---------------------------------------------------------------------------

Deno.test("contract: packages.json — every item becomes a package resource with variant/ready/status", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(packagesFixture) }],
    async () => {
      await run("listPackages", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "package")!;
  assertEquals(res.payload.name, "cozystack.cozystack-platform");
  assertEquals(res.payload.variant, "isp-full");
  assertEquals(res.payload.ready, "True");
});

// ---------------------------------------------------------------------------
// workloads.json — listWorkloads
// ---------------------------------------------------------------------------

Deno.test("contract: workloads.json — every item becomes a workload resource with kind/type/cpu/memory/operational", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(workloadsFixture) }],
    async () => {
      await run("listWorkloads", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "workload")!;
  assertEquals(res.payload.kind, "VirtualMachine");
  assertEquals(res.payload.type, "vm");
  assertEquals(res.payload.cpu, "2");
  assertEquals(res.payload.memory, "4Gi");
  assertEquals(res.payload.operational, true);
});

// ---------------------------------------------------------------------------
// helmreleases.json — listHelmReleases
// ---------------------------------------------------------------------------

Deno.test("contract: helmreleases.json — one result resource per release, success mirrors Ready condition", async () => {
  const { ctx, written, logs } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(helmReleasesFixture) }],
    async () => {
      await run("listHelmReleases", {}, ctx);
    },
  );
  const results = written.filter((w) => w.spec === "result");
  assertEquals(results.length, 2);
  const ready = results.find((w) => w.name === "hr-cozy-system-cozystack")!;
  assertEquals(ready.payload.success, true);
  const notReady = results.find((w) =>
    w.name === "hr-cozy-ingress-ingress-nginx"
  )!;
  assertEquals(notReady.payload.success, false);
  assertMatch(notReady.payload.message as string, /install retrying/);
  const summary = logs.find((l) =>
    typeof l.args[0] === "string" &&
    (l.args[0] as string).includes("HelmReleases:")
  );
  assertEquals(summary?.args[0], "HelmReleases: 1/2 ready");
});

// ---------------------------------------------------------------------------
// secret.json — getAppSecret (every key atob-decoded)
// ---------------------------------------------------------------------------

Deno.test("contract: secret.json — getAppSecret decodes EVERY data key into dataJson", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: JSON.stringify(secretFixture) }],
    async () => {
      await run("getAppSecret", { namespace: "tenant-root", name: "db" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "secret")!;
  assertEquals(res.name, "db");
  assertEquals(res.payload.namespace, "tenant-root");
  const decoded = JSON.parse(res.payload.dataJson as string);
  assertEquals(decoded, {
    "postgres-password": "fakepw123",
    username: "fakeuser",
  });
});

// ---------------------------------------------------------------------------
// tenant_secret.json — getTenantKubeconfig (token/namespace decoded, ca.crt raw)
// ---------------------------------------------------------------------------

Deno.test("contract: tenant_secret.json — getTenantKubeconfig decodes token+namespace but keeps ca.crt undecoded base64", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        expect: { command: "kubectl", argsInclude: ["view"] },
        stdout: "https://192.0.2.10:6443",
      },
      {
        expect: { command: "kubectl", argsInclude: ["secret"] },
        stdout: JSON.stringify(tenantSecretFixture),
      },
    ],
    async () => {
      await run(
        "getTenantKubeconfig",
        { tenantNamespace: "tenant-myteam", tenantName: "myteam" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "secret")!;
  assertEquals(res.name, "kubeconfig-myteam");
  const outer = JSON.parse(res.payload.dataJson as string);
  const kubeconfig = JSON.parse(outer.kubeconfig as string);
  assertEquals(
    kubeconfig.clusters[0].cluster.server,
    "https://192.0.2.10:6443",
  );
  assertEquals(
    kubeconfig.clusters[0].cluster["certificate-authority-data"],
    "ZmFrZWNhY2VydGRhdGE=",
    "ca.crt must stay base64-encoded — never atob-decoded",
  );
  assertEquals(kubeconfig.contexts[0].context.namespace, "tenant-myteam");
  assertEquals(kubeconfig.users[0].user.token, "faketoken1");
});

// ---------------------------------------------------------------------------
// install — pins that it issues TWO subprocesses (helm, then kubectl)
// ---------------------------------------------------------------------------

Deno.test("contract: install issues exactly two subprocesses — helm upgrade --install, then kubectl apply -f <platformConfigPath>", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        expect: {
          command: "helm",
          argsInclude: ["upgrade", "--install", "cozystack"],
        },
        stdout: 'Release "cozystack" has been upgraded.',
      },
      {
        expect: { command: "kubectl", argsInclude: ["apply"] },
        stdout: "configmap/cozystack-platform configured",
      },
    ],
    async (calls) => {
      await run(
        "install",
        {
          version: "0.31.0",
          platformConfigPath: "./cozystack-platform.yaml",
        },
        ctx,
      );
      assertEquals(calls.length, 2);
      assertEquals(calls[0].command, "helm");
      assertEquals(calls[1].command, "kubectl");
      assert(calls[0].args.includes("cozystackOperator.variant=talos"));
      assert(calls[1].args.includes("./cozystack-platform.yaml"));
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "install");
  assertEquals(res.payload.success, true);
});

// ---------------------------------------------------------------------------
// Checks — runCheck against the two model.checks
// ---------------------------------------------------------------------------

Deno.test("contract: cluster-reachable check — kubectl cluster-info success -> pass:true", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "kubectl", argsInclude: ["cluster-info"] },
      stdout: "Kubernetes control plane is running at https://192.0.2.10:6443",
    }],
    async () => {
      const result = await runCheck("cluster-reachable", ctx);
      assertEquals(result, { pass: true });
    },
  );
});

Deno.test("contract: helm-available check — helm version success -> pass:true", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      expect: { command: "helm", argsInclude: ["version"] },
      stdout: "v3.15.0+g0000000",
    }],
    async () => {
      const result = await runCheck("helm-available", ctx);
      assertEquals(result, { pass: true });
    },
  );
});
