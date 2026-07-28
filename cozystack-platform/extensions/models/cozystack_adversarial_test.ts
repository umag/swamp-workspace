/**
 * Adversarial suite: hostile/boundary inputs, injection vectors that survive
 * argv-array safety, destructive-lifecycle characterization (no confirmation
 * or existence checks), assignPodCIDRs boundary gaps, and a decode-aware,
 * cozystack-shaped fixtures-secret-scan with a matching sanity self-check.
 *
 * cozystack.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so
 * explicitly.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

const GLOBAL_ARGS = {};

// ---------------------------------------------------------------------------
// (a) argv-array inertness — hostile shell metacharacters land as ONE argv
// element; there is no shell to interpret them.
// ---------------------------------------------------------------------------

Deno.test("pin: shell metacharacters in namespace land as a single, unexpanded argv element (argv-array is inert)", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const hostileNs = "tenant-root; rm -rf / #";
  await withCommandStub(
    [{ stdout: JSON.stringify({ items: [] }) }],
    async (calls) => {
      await run("listTenants", { namespace: hostileNs }, ctx);
      assertEquals(
        calls[0].args.filter((a) => a === hostileNs).length,
        1,
        "the hostile string must appear as exactly one argv element",
      );
      assert(
        !calls[0].args.some((a) => a === "rm" || a === "-rf"),
        "no shell split occurred — 'rm -rf' never became separate argv elements",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (b) ${kind}.apps.cozystack.io raw interpolation
// ---------------------------------------------------------------------------

Deno.test("pin: getApp/deleteApp/updateApp interpolate `kind` RAW into the resource-type string — no validation", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const hostileKind = "postgres.other-group.io/v2,secrets";
  await withCommandStub(
    [{ stdout: JSON.stringify({ metadata: {}, spec: {} }) }],
    async (calls) => {
      await run(
        "getApp",
        { namespace: "tenant-root", kind: hostileKind, name: "db" },
        ctx,
      );
      assert(
        calls[0].args.includes(`${hostileKind}.apps.cozystack.io`),
        "the hostile kind is interpolated verbatim ahead of '.apps.cozystack.io'",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (c) Helm --set comma-injection; platformConfigPath url/-/arbitrary file
// ---------------------------------------------------------------------------

Deno.test("pin: install's variant reaches --set as ONE argv element — a comma injects an extra Helm assignment (argv safety does not stop this)", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const hostileVariant = "talos,cozystackOperator.debugMode=true";
  await withCommandStub(
    [
      { stdout: "helm ok" },
      { stdout: "kubectl ok" },
    ],
    async (calls) => {
      await run(
        "install",
        {
          version: "0.31.0",
          platformConfigPath: "./cfg.yaml",
          variant: hostileVariant,
        },
        ctx,
      );
      const setIdx = calls[0].args.indexOf("--set");
      const setValue = calls[0].args[setIdx + 1];
      assertEquals(
        setValue,
        `cozystackOperator.variant=${hostileVariant}`,
        "the comma-containing variant is a single argv element; Helm itself " +
          "would parse the comma as a delimiter between two --set assignments",
      );
    },
  );
});

Deno.test("pin: platformConfigPath accepts '-' (stdin), a bare URL, or any path — no validation before `kubectl apply -f`", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  for (
    const path of [
      "-",
      "https://evil.example/manifest.yaml",
      "/etc/passwd",
    ]
  ) {
    await withCommandStub(
      [{ stdout: "helm ok" }, { stdout: "kubectl ok" }],
      async (calls) => {
        await run(
          "install",
          { version: "0.31.0", platformConfigPath: path },
          ctx,
        );
        assert(
          calls[1].args.includes(path),
          `platformConfigPath "${path}" is passed to kubectl apply -f unvalidated`,
        );
      },
    );
  }
});

// ---------------------------------------------------------------------------
// (d) manifest-STDIN fields are JSON.stringify'd — hostile chars survive
// JSON-escaped, safe from the injection concerns that afflict argv/URL paths.
// ---------------------------------------------------------------------------

Deno.test("createApp/createTenant/applyPackage: hostile characters in stdin manifest fields are JSON-escaped, not shell/argv-injected", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const hostileHost = 'cluster.example"; DROP TABLE tenants; --\n\t';
  await withCommandStub([{ stdout: "applied" }], async (calls) => {
    await run(
      "applyPackage",
      { host: hostileHost, apiServerEndpoint: "https://192.0.2.10:6443" },
      ctx,
    );
    const manifest = JSON.parse(calls[0].stdin!);
    assertEquals(
      manifest.spec.components.platform.values.publishing.host,
      hostileHost,
      "JSON.stringify/JSON.parse round-trips the hostile string exactly",
    );
  });
});

// ---------------------------------------------------------------------------
// (e) leading-dash argv values — flag injection risk (LOW trust boundary)
// ---------------------------------------------------------------------------

Deno.test("pin: a name starting with '-' is passed as a literal argv value with no guard against flag injection", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "deleted" }], async (calls) => {
    await run(
      "deleteApp",
      { namespace: "tenant-root", kind: "Postgres", name: "--all" },
      ctx,
    );
    assert(
      calls[0].args.includes("--all"),
      "no guard strips or quotes a leading-dash value before argv",
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency — create* methods have no dedup/existence-check layer; a
// repeated call re-applies unconditionally (mirrors the porkbun precedent's
// "create is NOT idempotent" pin, adapted to the apply-based mutation style).
// ---------------------------------------------------------------------------

Deno.test("pin: createApp is NOT idempotent — repeating identical args applies twice, no dedup/existence check", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "created" }, { stdout: "created" }],
    async (calls) => {
      await run(
        "createApp",
        { namespace: "tenant-root", kind: "Postgres", name: "db" },
        ctx,
      );
      await run(
        "createApp",
        { namespace: "tenant-root", kind: "Postgres", name: "db" },
        ctx,
      );
      assertEquals(
        calls.length,
        2,
        "no dedup — two independent applies for the identical create call",
      );
    },
  );
});

Deno.test("pin: createTenant is NOT idempotent — repeating identical args applies twice", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "created" }, { stdout: "created" }],
    async (calls) => {
      await run("createTenant", { name: "myteam" }, ctx);
      await run("createTenant", { name: "myteam" }, ctx);
      assertEquals(calls.length, 2, "no dedup — two independent applies");
    },
  );
});

Deno.test("pin: applyPackage's writeResource uses a FIXED resource name ('apply-package') on every call — repeated calls clobber the same resource, no per-call audit trail", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "applied" }, { stdout: "applied" }],
    async () => {
      await run(
        "applyPackage",
        {
          host: "cluster.example",
          apiServerEndpoint: "https://192.0.2.10:6443",
        },
        ctx,
      );
      await run(
        "applyPackage",
        {
          host: "other.example",
          apiServerEndpoint: "https://192.0.2.11:6443",
        },
        ctx,
      );
    },
  );
  const names = written.filter((w) => w.spec === "result").map((w) => w.name);
  assertEquals(
    names,
    ["apply-package", "apply-package"],
    "both calls write the identical resource name — the second clobbers the first in a real instance",
  );
});

// ---------------------------------------------------------------------------
// (f) JSON.parse(specJson) / atob(non-base64) unmapped errors
// ---------------------------------------------------------------------------

Deno.test("pin: createApp with malformed specJson throws an unmapped SyntaxError before any subprocess runs", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([], async (calls) => {
    await assertRejects(
      () =>
        run(
          "createApp",
          {
            namespace: "tenant-root",
            kind: "Postgres",
            name: "db",
            specJson: "{not valid json",
          },
          ctx,
        ),
      SyntaxError,
    );
    assertEquals(
      calls.length,
      0,
      "the JSON.parse throw happens before kubectl is invoked",
    );
  });
});

Deno.test("pin: updateApp with malformed specJson throws an unmapped SyntaxError", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([], async () => {
    await assertRejects(
      () =>
        run(
          "updateApp",
          {
            namespace: "tenant-root",
            kind: "Postgres",
            name: "db",
            specJson: "not json at all",
          },
          ctx,
        ),
      SyntaxError,
    );
  });
});

Deno.test("pin: getAppSecret with non-base64 secret data throws an unmapped atob error", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({
        metadata: { name: "db", namespace: "tenant-root" },
        data: { password: "not-valid-base64!!!" },
      }),
    }],
    async () => {
      await assertRejects(
        () =>
          run("getAppSecret", { namespace: "tenant-root", name: "db" }, ctx),
      );
    },
  );
});

Deno.test("pin: getTenantKubeconfig with non-base64 token throws an unmapped atob error", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "https://192.0.2.10:6443" },
      {
        stdout: JSON.stringify({
          data: {
            token: "%%%not-base64%%%",
            namespace: "dGVuYW50",
            "ca.crt": "x",
          },
        }),
      },
    ],
    async () => {
      await assertRejects(
        () =>
          run(
            "getTenantKubeconfig",
            { tenantNamespace: "tenant-myteam", tenantName: "myteam" },
            ctx,
          ),
      );
    },
  );
});

Deno.test("pin: ca.crt is passed through UNDECODED even when it is not itself valid base64 (no atob is ever called on it)", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      { stdout: "https://192.0.2.10:6443" },
      {
        stdout: JSON.stringify({
          data: {
            token: "ZmFrZXRva2VuMQ==",
            namespace: "dGVuYW50LW15dGVhbQ==",
            "ca.crt": "not-valid-base64-but-never-decoded!!",
          },
        }),
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
  const outer = JSON.parse(res.payload.dataJson as string);
  const kubeconfig = JSON.parse(outer.kubeconfig as string);
  assertEquals(
    kubeconfig.clusters[0].cluster["certificate-authority-data"],
    "not-valid-base64-but-never-decoded!!",
    "ca.crt passthrough proves it is never atob-decoded, regardless of validity",
  );
});

// ---------------------------------------------------------------------------
// (g) assignPodCIDRs — malformed podSubnet -> NaN octets
// ---------------------------------------------------------------------------

Deno.test("pin: assignPodCIDRs with a malformed podSubnet produces NaN-octet CIDRs (no validation of the subnet arg)", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [
      {
        stdout: JSON.stringify({
          items: [{ metadata: { name: "n1" }, spec: {} }],
        }),
      },
      { stdout: "patched" },
    ],
    async (calls) => {
      await run("assignPodCIDRs", { podSubnet: "not-an-ip-at-all" }, ctx);
      const patchArg = calls[1].args[calls[1].args.indexOf("-p") + 1];
      const patch = JSON.parse(patchArg);
      assert(
        (patch.spec.podCIDR as string).includes("NaN"),
        `expected a NaN-octet CIDR, got ${patch.spec.podCIDR}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// assignPodCIDRs — >256 nodes -> invalid CIDR (index escapes the /8 octet)
// ---------------------------------------------------------------------------

Deno.test("pin: assignPodCIDRs allocates an INVALID CIDR once the node index reaches 256 (10.244.256.0/24)", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const items = Array.from({ length: 257 }, (_, i) => ({
    metadata: { name: `n${i}` },
    spec: {},
  }));
  const patchResponses: ScriptedCall[] = items.map(() => ({
    stdout: "patched",
  }));
  await withCommandStub(
    [{ stdout: JSON.stringify({ items }) }, ...patchResponses],
    async (calls) => {
      await run("assignPodCIDRs", {}, ctx);
      const lastPatchArgs = calls[calls.length - 1].args;
      const patch = JSON.parse(lastPatchArgs[lastPatchArgs.indexOf("-p") + 1]);
      assertEquals(
        patch.spec.podCIDR,
        "10.244.256.0/24",
        "index 256 produces a syntactically-invalid CIDR (octet > 255) — not fixed here",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// assignPodCIDRs — spec-less node -> TypeError (no optional chaining at the
// `node.spec.podCIDR` read, unlike getNodePodCIDRs' `node.spec?.podCIDR`)
// ---------------------------------------------------------------------------

Deno.test("pin: assignPodCIDRs throws a TypeError on a node with no .spec at all (missing optional chaining)", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{
      stdout: JSON.stringify({ items: [{ metadata: { name: "bare-node" } }] }),
    }],
    async () => {
      await assertRejects(
        () => run("assignPodCIDRs", {}, ctx),
        TypeError,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (h) deleteApp / configurePlatform-on-root — no confirmation, no existence
// check, no way to target a different tenant than the hardcoded root
// ---------------------------------------------------------------------------

Deno.test("pin: deleteApp issues the delete immediately — no existence check, no confirmation, no dry-run", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "deleted" }], async (calls) => {
    await run(
      "deleteApp",
      { namespace: "tenant-root", kind: "Postgres", name: "prod-db" },
      ctx,
    );
    assertEquals(
      calls.length,
      1,
      "exactly one subprocess — no prior 'does it exist' read, no confirmation gate",
    );
    assertEquals(calls[0].args[0], "delete");
  });
});

Deno.test("pin: configurePlatform ALWAYS targets the hardcoded 'root' tenant in 'tenant-root' — no argument can redirect it", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub([{ stdout: "patched" }], async (calls) => {
    await run("configurePlatform", { ingress: false }, ctx);
    assert(calls[0].args.includes("root"));
    assert(calls[0].args.includes("tenant-root"));
  });
});

// ---------------------------------------------------------------------------
// (i) non-JSON stdout -> unmapped SyntaxError
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON stdout (e.g. an HTML error page from a misconfigured proxy) surfaces as an unmapped SyntaxError", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withCommandStub(
    [{ stdout: "<html><body>502 Bad Gateway</body></html>" }],
    async () => {
      await assertRejects(() => run("listPackages", {}, ctx), SyntaxError);
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — decode-aware, cozystack-shaped mechanical backstop
// ---------------------------------------------------------------------------

/** A string looks like base64 iff it is non-empty, its length is a multiple
 * of 4, and every character is in the base64 alphabet (with up to two `=`
 * padding characters at the end). Gates atob() behind this check (FOLD-IN
 * 3): an ordinary non-base64 fixture leaf like "cluster.example" or
 * "10.244.0.0/16" must never reach atob() and must never throw. */
function isLikelyBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "PEM block (-----BEGIN ...-----)", re: /-----BEGIN [A-Z ]+-----/ },
  { name: "JWT-shaped token (eyJ prefix)", re: /^eyJ[A-Za-z0-9_-]{10,}/ },
  {
    name: "kubeconfig/certificate-authority-data/client-key-data keyword",
    re: /\b(kubeconfig|client-key-data|certificate-authority-data)\b/i,
  },
];

// Applied to RAW leaf strings only (not decoded plaintext): a long
// contiguous base64/alnum blob with no separators. Real Cozystack secret
// material (Postgres-generated passwords, ServiceAccount tokens, TLS keys)
// is long enough to trip this; our own fixture placeholders are deliberately
// short (see fixtures/PROVENANCE.md) and stay under it — a documented,
// intentional backstop weakness, not a test bug.
const HIGH_ENTROPY_RAW = /^[A-Za-z0-9+/_=-]{32,}$/;

/** Scan one string leaf: direct pattern match on the raw value, PLUS (if the
 * raw value is base64-shaped) a decode-then-pattern-match pass on the
 * plaintext. Never throws — atob is gated by isLikelyBase64 AND wrapped in
 * try/catch (belt and suspenders per the round-2 security review). */
function scanLeaf(label: string, value: string, violations: string[]): void {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(value)) violations.push(`${label}: raw value matched ${name}`);
  }
  if (HIGH_ENTROPY_RAW.test(value)) {
    violations.push(
      `${label}: raw value matched high-entropy base64/alnum blob (>=32 chars, no separators)`,
    );
  }
  if (isLikelyBase64(value)) {
    try {
      const decoded = atob(value);
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(decoded)) {
          violations.push(`${label}: DECODED value matched ${name}`);
        }
      }
    } catch {
      // Not actually valid base64 despite looking shape-like (e.g. non-Latin1
      // bytes) — nothing further to scan, and critically: do not throw.
    }
  }
}

function collectLeaves(
  value: unknown,
  path = "$",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectLeaves(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "deploy_operator.json": deployOperator,
  "deploy_flux_tenants.json": deployFluxTenants,
  "nodes.json": nodesFixture,
  "platform_package.json": platformPackage,
  "app_definitions.json": appDefinitions,
  "apps.json": appsFixture,
  "tenants.json": tenantsFixture,
  "packages.json": packagesFixture,
  "workloads.json": workloadsFixture,
  "helmreleases.json": helmReleasesFixture,
  "secret.json": secretFixture,
  "tenant_secret.json": tenantSecretFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string (decode-aware)", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const { path, value } of collectLeaves(data)) {
      scanLeaf(`${file}${path}`, value, violations);
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — a 44-char base64-shaped blob trips the raw high-entropy rule", () => {
  const violations: string[] = [];
  scanLeaf("poisoned", "a".repeat(44), violations);
  assert(
    violations.length > 0,
    "scanner must flag a long base64-alphabet blob",
  );
});

Deno.test("fixtures-secret-scan: sanity — a raw PEM '-----BEGIN CERTIFICATE-----' block trips directly (not via decode)", () => {
  const violations: string[] = [];
  const pem =
    "-----BEGIN CERTIFICATE-----\nMIIFAKE...==\n-----END CERTIFICATE-----";
  scanLeaf("poisoned", pem, violations);
  assert(violations.length > 0, "scanner must flag a raw PEM block");
});

Deno.test("fixtures-secret-scan: sanity — a JWT-shaped value HIDDEN behind valid base64 is caught via decode", () => {
  const violations: string[] = [];
  const jwtLike = "eyJhbGciOiJIUzI1NiJ9.fake.sig";
  const wrapped = btoa(jwtLike); // simulates a k8s Secret .data value
  scanLeaf("poisoned", wrapped, violations);
  assert(violations.length > 0, "scanner must decode and flag the JWT prefix");
});

Deno.test("fixtures-secret-scan: a non-base64 plaintext leaf (e.g. a bare hostname) is scanned WITHOUT throwing (FOLD-IN 3)", () => {
  const violations: string[] = [];
  scanLeaf("benign", "cluster.example", violations);
  scanLeaf("benign", "10.244.0.0/16", violations);
  scanLeaf("benign", "node.kubernetes.io/not-ready", violations);
  assertEquals(violations, []);
});
