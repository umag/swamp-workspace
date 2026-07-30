/**
 * Contract-fixture suite for @magistr/observability/agent: pins the SSH
 * command contract (binary + exact argv array, script fed via stdin) and the
 * stdout wire shapes each method's parser depends on (`install`'s
 * `KEY=version` lines, `configure`'s `NODE=`/`BLACKBOX=`/`VECTOR=` is-active
 * lines in both the vector-configured and vector-skipped variants,
 * `status`'s `svc.*`/`lst.*` lines, `inventory`'s `===SECTION===` layout),
 * fed from `fixtures/*.json`. Every written resource is additionally
 * validated against its `model.resources.<spec>.schema`.
 *
 * observability_agent.ts is UNMODIFIED by this change — every assertion here
 * PINS already-shipped behavior. The `Deno.Command` boundary is stubbed
 * (talm-cluster dual-shape stub: `spawn()` -> `stdin.getWriter()` ->
 * `write`/`close` -> `output()`, AND a direct `output()`); no real `ssh`
 * binary or network call is exercised. All fixture content is pure
 * doc/source-derived synthetic data — see fixtures/PROVENANCE.md.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./observability_agent.ts";
import installFixture from "../../fixtures/install.json" with { type: "json" };
import configureFixture from "../../fixtures/configure.json" with {
  type: "json",
};
import configureNoVectorFixture from "../../fixtures/configure-novector.json" with {
  type: "json",
};
import statusFixture from "../../fixtures/status.json" with { type: "json" };
import inventoryFixture from "../../fixtures/inventory.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness: fake context (duplicated per this repo's suite convention — see
// talm_cluster_test.ts / victorialogs_test.ts for the sibling copies)
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

/** Build a realistic, schema-validated globalArgs object the way swamp
 * itself would (parsed through GlobalArgsSchema before `execute` sees it),
 * defaulting only `sshHost` and letting the schema's own `.default(...)`
 * fill in everything else unless overridden. */
function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    sshHost: "host.example",
    ...overrides,
  }) as Record<string, unknown>;
}

function makeCtx(globalArgOverrides: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: gArgs(globalArgOverrides),
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
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

type ResourceMap = Record<string, {
  schema: { parse: (x: unknown) => unknown };
}>;

/** Validate a written payload against the model's own resource schema — no
 * `any`, per the repo's no-explicit-any lint rule. */
function parseAgainstResourceSchema(spec: string, payload: unknown): unknown {
  return (model.resources as ResourceMap)[spec].schema.parse(payload);
}

// ---------------------------------------------------------------------------
// Harness: Deno.Command dual-shape stub (talm-cluster precedent). obs-agent's
// sshScript() only ever calls spawn()->stdin->output(), but the stub
// supports the direct output() shape too, matching this repo's cross-suite
// convention. CAPTURES the stdin script — the attack/behavior surface here
// is the generated REMOTE bash script, not the local argv.
// ---------------------------------------------------------------------------

interface CapturedCall {
  binary: string;
  args: string[];
  stdin: string;
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

type ResultPicker =
  | CommandResult
  | CommandResult[]
  | ((call: CapturedCall, callIndex: number) => CommandResult);

function encodeOutput(r: CommandResult) {
  return {
    success: r.success,
    code: r.success ? 0 : 1,
    signal: null,
    stdout: new TextEncoder().encode(r.stdout),
    stderr: new TextEncoder().encode(r.stderr),
  };
}

function withCommandStub(
  results: ResultPicker,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  let callIndex = 0;
  const original = Deno.Command;

  function pickResult(call: CapturedCall): CommandResult {
    const idx = callIndex++;
    if (typeof results === "function") return results(call, idx);
    if (Array.isArray(results)) {
      return results[idx] ?? results[results.length - 1];
    }
    return results;
  }

  class FakeCommand {
    #call: CapturedCall;
    #result: CommandResult;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      this.#call = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
        stdin: "",
      };
      calls.push(this.#call);
      this.#result = pickResult(this.#call);
    }
    spawn() {
      const call = this.#call;
      const result = this.#result;
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              call.stdin += new TextDecoder().decode(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => Promise.resolve(encodeOutput(result)),
      };
    }
    output() {
      return Promise.resolve(encodeOutput(this.#result));
    }
  }

  (Deno as unknown as { Command: unknown }).Command = FakeCommand;
  return fn(calls).finally(() => {
    (Deno as unknown as { Command: unknown }).Command = original;
  });
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

Deno.test("contract: install — ssh argv pinned, script fed over stdin, fixture stdout parses to InstallSchema", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(installFixture, async (calls) => {
    await run("install", {}, ctx);
    assertEquals(calls.length, 1, "install issues exactly one ssh command");
    assertEquals(calls[0].binary, "ssh");
    assertEquals(calls[0].args, [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-p",
      "22",
      "root@host.example",
      "bash -s",
    ]);
    assert(
      calls[0].stdin.includes("apt-get install"),
      "the install script is fed over stdin, not argv",
    );
    assert(
      calls[0].stdin.includes(
        "https://packages.timber.io/vector/0.46.1/vector_0.46.1-1_amd64.deb",
      ),
      "the default vectorVersion (0.46.1) is baked into the curl URL",
    );
  });
  const res = written.find((w) => w.spec === "install")!;
  assertEquals(res.name, "install");
  const parsed = parseAgainstResourceSchema("install", res.payload) as {
    nodeExporter: string;
    blackbox: string;
    vector: string;
    timestamp: string;
  };
  assertEquals(parsed.nodeExporter, "1.7.0");
  assertEquals(parsed.blackbox, "0.25.0");
  assertEquals(parsed.vector, "0.46.1");
  assertEquals(typeof parsed.timestamp, "string");
});

Deno.test("contract: install — sshUser/sshPort/vectorVersion overrides land in argv and the generated .deb URL", async () => {
  const { ctx } = makeCtx({
    sshUser: "ops",
    sshPort: 2222,
    vectorVersion: "0.47.0",
  });
  await withCommandStub(installFixture, async (calls) => {
    await run("install", {}, ctx);
    assertEquals(calls[0].args[7], "2222");
    assertEquals(calls[0].args[8], "ops@host.example");
    assert(
      calls[0].stdin.includes(
        "https://packages.timber.io/vector/0.47.0/vector_0.47.0-1_amd64.deb",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

Deno.test("contract: configure — vector configured (logsEndpoint set), fixture stdout parses to ConfigSchema", async () => {
  const { ctx, written } = makeCtx({
    bindAddress: "192.0.2.10",
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
  });
  await withCommandStub(configureFixture, async (calls) => {
    await run("configure", {}, ctx);
    assertEquals(calls.length, 1, "configure issues exactly one ssh command");
    assert(calls[0].stdin.includes("systemctl daemon-reload"));
    assert(calls[0].stdin.includes("systemctl restart vector"));
    assert(calls[0].stdin.includes('echo "VECTOR=$(systemctl is-active'));
  });
  const res = written.find((w) => w.spec === "config")!;
  const parsed = parseAgainstResourceSchema("config", res.payload) as {
    bindAddress: string;
    vectorConfigured: boolean;
    logFiles: string[];
  };
  assertEquals(parsed.bindAddress, "192.0.2.10");
  assertEquals(parsed.vectorConfigured, true);
  assertEquals(parsed.logFiles, [
    "/var/log/nginx/access.log",
    "/var/log/nginx/error.log",
    "/var/log/syslog",
  ]);
});

Deno.test("contract: configure — vector NOT configured (logsEndpoint unset), configure-novector fixture parses cleanly", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(configureNoVectorFixture, async (calls) => {
    await run("configure", {}, ctx);
    assert(
      calls[0].stdin.includes('echo "VECTOR=skipped"'),
      "vectorConfigured=false emits the hardcoded skipped echo, not a systemctl check",
    );
    assert(
      !calls[0].stdin.includes("/etc/vector/vector.yaml"),
      "no vector.yaml write when logsEndpoint is unset",
    );
  });
  const res = written.find((w) => w.spec === "config")!;
  const parsed = parseAgainstResourceSchema("config", res.payload) as {
    vectorConfigured: boolean;
    logsEndpoint: string | undefined;
  };
  assertEquals(parsed.vectorConfigured, false);
  assertEquals(parsed.logsEndpoint, undefined);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

Deno.test("contract: status — fixture stdout (svc.*/lst.*) parses to StatusSchema", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(statusFixture, async (calls) => {
    await run("status", {}, ctx);
    assertEquals(calls.length, 1);
    assert(
      calls[0].stdin.includes("systemctl is-active prometheus-node-exporter"),
    );
    assert(calls[0].stdin.includes("curl -sf --max-time 5"));
  });
  const res = written.find((w) => w.spec === "status")!;
  const parsed = parseAgainstResourceSchema("status", res.payload) as {
    services: Record<string, string>;
    listeners: Record<string, boolean>;
  };
  assertEquals(parsed.services, {
    nodeExporter: "active",
    blackbox: "active",
    vector: "active",
  });
  assertEquals(parsed.listeners, { nodeExporter: true, blackbox: true });
});

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

Deno.test("contract: inventory — ===SECTION=== layout parses to InventorySchema", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(inventoryFixture, async (calls) => {
    await run("inventory", {}, ctx);
    assertEquals(calls.length, 1);
    assert(calls[0].stdin.includes("===SERVICES==="));
    assert(calls[0].stdin.includes("ss -tulnpH"));
  });
  const res = written.find((w) => w.spec === "inventory")!;
  const parsed = parseAgainstResourceSchema("inventory", res.payload) as {
    runningServices: string[];
    listeners: { proto: string; local: string; process: string }[];
    processes: { name: string; count: number }[];
    serviceCount: number;
    listenerCount: number;
  };
  assertEquals(parsed.runningServices, [
    "prometheus-node-exporter.service",
    "prometheus-blackbox-exporter.service",
    "vector.service",
    "ssh.service",
  ]);
  assertEquals(parsed.serviceCount, 4);
  assertEquals(parsed.listenerCount, 4);
  assertEquals(parsed.listeners[0], {
    proto: "tcp",
    local: "192.0.2.10:9100",
    process: "node_exporter",
  });
  assertEquals(parsed.listeners[3], {
    proto: "udp",
    local: "0.0.0.0:68",
    process: "dhclient",
  });
  assertEquals(parsed.processes[0], { name: "sshd", count: 5 });
  assertEquals(parsed.processes[3], { name: "vector", count: 1 });
});
