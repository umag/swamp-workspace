/**
 * Property-based tests (fast-check) for @magistr/cozystack-platform.
 *
 * cozystack.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed, stateful
 * `Deno.Command` and reading back the captured stdin manifest / written
 * resources, per the approved plan.
 *
 * Properties:
 *  (a) Builder injectivity — createApp/createTenant/applyPackage manifest
 *      builders are injective over a CANONICAL, non-collapsing input subset
 *      (see each section below for exactly what is excluded and why).
 *  (b) updateApp is restated as a DETERMINISM/merge-correctness property
 *      over a FIXED current-state fixture — NOT injectivity (a newField
 *      equal to the current value is indistinguishable from omission).
 *  (c) Parser round-trips — listTenants/listPackages/listWorkloads/listApps
 *      preserve every generated k8s item, in order, count==items.length;
 *      absent/empty items -> [].
 *  (d) assignPodCIDRs allocates INDEX-based 10.244.i.0/24 and is idempotent
 *      (a second run patches nothing) via a stateful fake whose "get nodes"
 *      response reflects the first run's patches; node count bounded <=256
 *      (the canonical, always-valid-CIDR subset — see the adversarial
 *      suite's >256 characterization for the out-of-domain case).
 *
 * FC_NUM_RUNS overrides the iteration count for the nightly soak
 * (`deno task test:soak`); small by default here.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./cozystack.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(150) };

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
        } (script queue exhausted)`,
      );
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

// ---------------------------------------------------------------------------
// (a1) createApp — builder injectivity over the canonical subset
//
// Excludes: specJson TEXT canonicalization (whitespace/dup-keys/1.0-vs-1) —
// every specJson here is generated as JSON.stringify(a fresh object), never
// a hand-alternate-formatted string, so no two distinct generated inputs can
// collapse via JSON.parse the way e.g. "{}"  and " {} " would. Excludes the
// "{}" default — specJson is always supplied explicitly, never omitted.
// ---------------------------------------------------------------------------

const arbIdent = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const arbKind = fc.stringMatching(/^[A-Z][a-zA-Z0-9]{0,15}$/);
const arbSpecObj = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,8}$/),
  fc.oneof(
    fc.string({ maxLength: 10 }),
    fc.integer({ min: 0, max: 100_000 }),
    fc.boolean(),
  ),
  { maxKeys: 5 },
);

const arbCreateAppInput = fc.record({
  namespace: arbIdent,
  kind: arbKind,
  name: arbIdent,
  specObj: arbSpecObj,
});

function createAppSignature(
  input: { namespace: string; kind: string; name: string; specObj: unknown },
): string {
  return JSON.stringify([
    input.namespace,
    input.kind,
    input.name,
    input.specObj,
  ]);
}

async function createAppManifestFor(
  input: { namespace: string; kind: string; name: string; specObj: unknown },
): Promise<string> {
  const { ctx } = makeCtx();
  let manifest = "";
  await withCommandStub([{ stdout: "created" }], async (calls) => {
    await run(
      "createApp",
      {
        namespace: input.namespace,
        kind: input.kind,
        name: input.name,
        specJson: JSON.stringify(input.specObj),
      },
      ctx,
    );
    manifest = calls[0].stdin!;
  });
  return manifest;
}

Deno.test("property: createApp's manifest is deterministic — same canonical input -> same stdin manifest", async () => {
  await fc.assert(
    fc.asyncProperty(arbCreateAppInput, async (input) => {
      const a = await createAppManifestFor(input);
      const b = await createAppManifestFor(input);
      return a === b;
    }),
    { numRuns: NIGHT(80) },
  );
});

Deno.test("property: createApp's manifest builder is INJECTIVE over the canonical (non-collapsing) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(arbCreateAppInput, arbCreateAppInput, async (a, b) => {
      const sigA = createAppSignature(a);
      const sigB = createAppSignature(b);
      const manifestA = await createAppManifestFor(a);
      const manifestB = await createAppManifestFor(b);
      return sigA === sigB ? manifestA === manifestB : manifestA !== manifestB;
    }),
    { numRuns: NIGHT(200) },
  );
});

// ---------------------------------------------------------------------------
// (a2) createTenant — builder injectivity (host optional; both undefined and
// a non-empty host are canonical — no collapsing case exists here since the
// manifest either omits `host` entirely or sets it, with no default value).
// ---------------------------------------------------------------------------

const arbCreateTenantInput = fc.record({
  namespace: arbIdent,
  name: arbIdent,
  host: fc.option(fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/), {
    nil: undefined,
  }),
});

function createTenantSignature(
  input: { namespace: string; name: string; host: string | undefined },
): string {
  return JSON.stringify([input.namespace, input.name, input.host]);
}

async function createTenantManifestFor(
  input: { namespace: string; name: string; host: string | undefined },
): Promise<string> {
  const { ctx } = makeCtx();
  let manifest = "";
  await withCommandStub([{ stdout: "created" }], async (calls) => {
    await run(
      "createTenant",
      {
        namespace: input.namespace,
        name: input.name,
        ...(input.host !== undefined ? { host: input.host } : {}),
      },
      ctx,
    );
    manifest = calls[0].stdin!;
  });
  return manifest;
}

Deno.test("property: createTenant's manifest builder is INJECTIVE over (namespace, name, host?)", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCreateTenantInput,
      arbCreateTenantInput,
      async (a, b) => {
        const sigA = createTenantSignature(a);
        const sigB = createTenantSignature(b);
        const manifestA = await createTenantManifestFor(a);
        const manifestB = await createTenantManifestFor(b);
        return sigA === sigB
          ? manifestA === manifestB
          : manifestA !== manifestB;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

// ---------------------------------------------------------------------------
// (a3) applyPackage — builder injectivity over the SIX defaulted fields
// (variant, podCIDR, podGateway, serviceCIDR, joinCIDR, exposedServices),
// always supplied EXPLICITLY (never omitted, so no default-vs-omitted
// collapse is possible). host/apiServerEndpoint are held fixed (required,
// no default — no collapse risk) and externalIPs is deliberately excluded
// from this property's fuzzed domain, per the approved plan.
// ---------------------------------------------------------------------------

const FIXED_HOST = "cluster.example";
const FIXED_ENDPOINT = "https://192.0.2.10:6443";

const arbApplyPackageInput = fc.record({
  variant: fc.stringMatching(/^[a-z][a-z-]{0,15}$/),
  podCIDR: fc.stringMatching(/^10\.[0-9]{1,3}\.0\.0\/16$/),
  podGateway: fc.stringMatching(/^10\.[0-9]{1,3}\.0\.1$/),
  serviceCIDR: fc.stringMatching(/^10\.[0-9]{1,3}\.0\.0\/16$/),
  joinCIDR: fc.stringMatching(/^100\.[0-9]{1,3}\.0\.0\/16$/),
  exposedServices: fc.array(fc.stringMatching(/^[a-z]{1,10}$/), {
    maxLength: 4,
  }),
});

type ApplyPackageInput = {
  variant: string;
  podCIDR: string;
  podGateway: string;
  serviceCIDR: string;
  joinCIDR: string;
  exposedServices: string[];
};

function applyPackageSignature(input: ApplyPackageInput): string {
  return JSON.stringify([
    input.variant,
    input.podCIDR,
    input.podGateway,
    input.serviceCIDR,
    input.joinCIDR,
    input.exposedServices,
  ]);
}

async function applyPackageManifestFor(
  input: ApplyPackageInput,
): Promise<string> {
  const { ctx } = makeCtx();
  let manifest = "";
  await withCommandStub([{ stdout: "applied" }], async (calls) => {
    await run(
      "applyPackage",
      { host: FIXED_HOST, apiServerEndpoint: FIXED_ENDPOINT, ...input },
      ctx,
    );
    manifest = calls[0].stdin!;
  });
  return manifest;
}

Deno.test("property: applyPackage's manifest builder is INJECTIVE over the six always-explicit defaulted fields", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbApplyPackageInput,
      arbApplyPackageInput,
      async (a, b) => {
        const sigA = applyPackageSignature(a);
        const sigB = applyPackageSignature(b);
        const manifestA = await applyPackageManifestFor(a);
        const manifestB = await applyPackageManifestFor(b);
        return sigA === sigB
          ? manifestA === manifestB
          : manifestA !== manifestB;
      },
    ),
    { numRuns: NIGHT(150) },
  );
});

// ---------------------------------------------------------------------------
// (b) updateApp — DETERMINISM / merge-correctness, NOT injectivity, over a
// FIXED current-state fixture. A newField equal to the current value is
// indistinguishable from omission (both yield the same merged spec), so
// injectivity does not hold here even in principle — this property instead
// pins that the merge always equals the plain object-spread semantics.
// ---------------------------------------------------------------------------

const FIXED_CURRENT_SPEC = { replicas: 2, size: "10Gi", version: "16" };

const arbNewFields = fc.dictionary(
  fc.constantFrom("replicas", "size", "version", "storageClass"),
  fc.oneof(fc.integer({ min: 0, max: 100 }), fc.string({ maxLength: 8 })),
  { maxKeys: 4 },
);

Deno.test("property: updateApp's merged spec ALWAYS equals {...current.spec, ...newFields} (merge-correctness, not injectivity)", async () => {
  await fc.assert(
    fc.asyncProperty(arbNewFields, async (newFields) => {
      const { ctx } = makeCtx();
      let mergedSpec: unknown;
      await withCommandStub(
        [
          { stdout: JSON.stringify({ spec: FIXED_CURRENT_SPEC }) },
          { stdout: "configured" },
        ],
        async (calls) => {
          await run(
            "updateApp",
            {
              namespace: "tenant-root",
              kind: "Postgres",
              name: "db",
              specJson: JSON.stringify(newFields),
            },
            ctx,
          );
          mergedSpec = JSON.parse(calls[1].stdin!).spec;
        },
      );
      return (
        JSON.stringify(mergedSpec) ===
          JSON.stringify({ ...FIXED_CURRENT_SPEC, ...newFields })
      );
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) Parser round-trips — listTenants / listPackages / listWorkloads /
// listApps preserve every generated item, in order, count == items.length;
// absent/empty items both yield zero written resources.
// ---------------------------------------------------------------------------

const arbItemName = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);

Deno.test("property: listTenants preserves every generated item, in order, with matching count", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbItemName, { minLength: 0, maxLength: 15 }),
      async (names) => {
        const { ctx, written } = makeCtx();
        const items = names.map((name) => ({
          metadata: { name, namespace: "tenant-root" },
          spec: {},
        }));
        await withCommandStub(
          [{ stdout: JSON.stringify({ items }) }],
          async () => {
            await run("listTenants", {}, ctx);
          },
        );
        const tenants = written.filter((w) => w.spec === "tenant");
        return (
          tenants.length === names.length &&
          tenants.every((t, i) => t.payload.name === names[i])
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: listTenants — absent and empty items both yield zero written resources", async () => {
  for (const response of [{}, { items: [] }]) {
    const { ctx, written } = makeCtx();
    await withCommandStub([{ stdout: JSON.stringify(response) }], async () => {
      await run("listTenants", {}, ctx);
    });
    assertEquals(written.filter((w) => w.spec === "tenant").length, 0);
  }
});

Deno.test("property: listPackages preserves every generated item, in order, with matching count", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbItemName, { minLength: 0, maxLength: 15 }),
      async (names) => {
        const { ctx, written } = makeCtx();
        const items = names.map((name) => ({ metadata: { name }, spec: {} }));
        await withCommandStub(
          [{ stdout: JSON.stringify({ items }) }],
          async () => {
            await run("listPackages", {}, ctx);
          },
        );
        const packages = written.filter((w) => w.spec === "package");
        return (
          packages.length === names.length &&
          packages.every((p, i) => p.payload.name === names[i])
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: listWorkloads preserves every generated item, in order, with matching count", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbItemName, { minLength: 0, maxLength: 15 }),
      async (names) => {
        const { ctx, written } = makeCtx();
        const items = names.map((name) => ({
          metadata: { name, namespace: "tenant-root" },
          status: {},
        }));
        await withCommandStub(
          [{ stdout: JSON.stringify({ items }) }],
          async () => {
            await run("listWorkloads", {}, ctx);
          },
        );
        const workloads = written.filter((w) => w.spec === "workload");
        return (
          workloads.length === names.length &&
          workloads.every((w, i) => w.payload.name === names[i])
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: listApps preserves every generated item for a single discovered resource, in order, with matching count", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbItemName, { minLength: 0, maxLength: 12 }),
      async (names) => {
        const { ctx, written } = makeCtx();
        const items = names.map((name) => ({
          metadata: { name, namespace: "tenant-root" },
          spec: {},
        }));
        await withCommandStub(
          [
            { stdout: "postgreses.apps.cozystack.io\n" },
            { stdout: JSON.stringify({ items }) },
          ],
          async () => {
            await run("listApps", { namespace: "tenant-root" }, ctx);
          },
        );
        const apps = written.filter((w) => w.spec === "app");
        return (
          apps.length === names.length &&
          apps.every((a, i) => a.payload.name === names[i])
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) assignPodCIDRs — index-based /24 allocation + idempotence, via a
// STATEFUL fake whose second "get nodes" reflects the first run's patches.
// Node count bounded to the canonical <=256 subset (every allocated octet
// stays in the valid 0-255 range — see the adversarial suite for >256).
// ---------------------------------------------------------------------------

class StatefulNodesCommand {
  static nodeOrder: string[] = [];
  static podCIDRs = new Map<string, string | undefined>();
  static patchCalls: string[] = [];

  #command: string;
  #args: string[];

  constructor(command: string, options: { args?: string[] } = {}) {
    this.#command = command;
    this.#args = options.args ?? [];
  }

  output() {
    const encoder = new TextEncoder();
    if (
      this.#command === "kubectl" && this.#args[0] === "get" &&
      this.#args[1] === "nodes"
    ) {
      const items = StatefulNodesCommand.nodeOrder.map((name) => {
        const cidr = StatefulNodesCommand.podCIDRs.get(name);
        return {
          metadata: { name },
          spec: cidr ? { podCIDR: cidr, podCIDRs: [cidr] } : {},
        };
      });
      return Promise.resolve({
        success: true,
        stdout: encoder.encode(JSON.stringify({ items })),
        stderr: new Uint8Array(),
        code: 0,
      });
    }
    if (
      this.#command === "kubectl" && this.#args[0] === "patch" &&
      this.#args[1] === "node"
    ) {
      const name = this.#args[2];
      const pIdx = this.#args.indexOf("-p");
      const patch = JSON.parse(this.#args[pIdx + 1]);
      StatefulNodesCommand.podCIDRs.set(name, patch.spec.podCIDR);
      StatefulNodesCommand.patchCalls.push(name);
      return Promise.resolve({
        success: true,
        stdout: encoder.encode(`node/${name} patched`),
        stderr: new Uint8Array(),
        code: 0,
      });
    }
    return Promise.reject(
      new Error(
        `stateful fake: unrouted ${this.#command} ${this.#args.join(" ")}`,
      ),
    );
  }

  spawn(): never {
    throw new Error("StatefulNodesCommand does not support spawn()");
  }
}

function withStatefulNodesFake<T>(fn: () => Promise<T>): Promise<T> {
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = StatefulNodesCommand;
  return fn().finally(() => {
    Object.defineProperty(Deno, "Command", {
      value: original,
      configurable: true,
      writable: true,
    });
  });
}

Deno.test("property: assignPodCIDRs allocates 10.244.<index>.0/24 by node array position, and a second run is idempotent (zero patches)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 256 }), async (n) => {
      const names = Array.from({ length: n }, (_, i) => `node-${i}`);
      StatefulNodesCommand.nodeOrder = names;
      StatefulNodesCommand.podCIDRs = new Map(
        names.map((nm) => [nm, undefined]),
      );
      StatefulNodesCommand.patchCalls = [];

      return await withStatefulNodesFake(async () => {
        const { ctx: ctx1 } = makeCtx();
        await run("assignPodCIDRs", {}, ctx1);

        for (let i = 0; i < n; i++) {
          if (
            StatefulNodesCommand.podCIDRs.get(names[i]) !== `10.244.${i}.0/24`
          ) {
            return false;
          }
        }
        if (StatefulNodesCommand.patchCalls.length !== n) return false;

        // Second run against the now-fully-assigned state must be a no-op.
        StatefulNodesCommand.patchCalls = [];
        const { ctx: ctx2 } = makeCtx();
        await run("assignPodCIDRs", {}, ctx2);
        return StatefulNodesCommand.patchCalls.length === 0;
      });
    }),
    { numRuns: NIGHT(30) }, // node-array construction cost scales with n; kept modest by default
  );
});
