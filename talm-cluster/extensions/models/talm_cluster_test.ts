/**
 * Contract-fixture suite for @magistr/talm-cluster: pins the CLI wire
 * contract (binary + exact argv array + stdin) for the 6 methods that issue
 * a `talm`/`talosctl` command, the FS-effect contract for the 2 methods that
 * issue no command at all (`getClusterState`, `configure`), and
 * `templateNode`'s install-disk / dhcp-injection post-processing across the
 * doc-derived fixture variants — including the shipped first-only-disk-
 * rewrite gap and the post-processing idempotence property.
 *
 * talm_cluster.ts is UNMODIFIED by this change — every assertion here PINS
 * already-shipped behavior. The CLI boundary (`Deno.Command`) is stubbed; no
 * real `talm`/`talosctl` binary or network call is exercised. All fixture
 * content is pure doc-derived synthetic data — see fixtures/PROVENANCE.md.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./talm_cluster.ts";
import transientErrors from "../../fixtures/transient-errors.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness: fake context
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(clusterDir: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { clusterDir },
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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// Harness: Deno.Command dual-shape stub
//
// talm_cluster.ts's runCmd drives cmd.spawn() -> child.stdin.getWriter()
// .write()/.close() -> child.output(); the talm-available check (exercised
// in the methods suite, not here) calls cmd.output() directly. This fake
// supports BOTH shapes so either call site works unmodified.
// ---------------------------------------------------------------------------

interface CapturedCall {
  binary: string;
  args: string[];
  cwd?: string;
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

/** Swap `Deno.Command` for a fake capturing every (binary,args,cwd,stdin)
 * call; restores the original in `finally`. Never touches `setTimeout` —
 * suites that drive a retry loop layer `withFireImmediateTimeout` (methods /
 * adversarial / property suites) around this. */
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
        cwd: opts.cwd as string | undefined,
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

async function withTempClusterDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

// ---------------------------------------------------------------------------
// init — TWO spawns (talm init, then talm talosconfig), 5x "y\n" stdin on
// the first only
// ---------------------------------------------------------------------------

Deno.test("contract: init issues TWO commands — talm init (with 5x y stdin) then talm talosconfig (no stdin)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const initStdout = await fixture("init.stdout.txt");
    await withCommandStub(
      { success: true, stdout: initStdout, stderr: "" },
      async (calls) => {
        await run("init", { name: "demo-cluster", preset: "cozystack" }, ctx);
        assertEquals(calls.length, 2, "init must issue exactly two commands");

        assertEquals(calls[0].binary, "talm");
        assertEquals(calls[0].args, [
          "init",
          "--preset",
          "cozystack",
          "--name",
          "demo-cluster",
          "--force",
          "--update",
        ]);
        assertEquals(calls[0].cwd, dir);
        assertEquals(
          calls[0].stdin,
          "y\ny\ny\ny\ny\n",
          "init must feed exactly 5x 'y\\n', not 1x",
        );

        assertEquals(calls[1].binary, "talm");
        assertEquals(calls[1].args, ["talosconfig"]);
        assertEquals(calls[1].cwd, dir);
        assertEquals(
          calls[1].stdin,
          "",
          "the talosconfig regen spawn receives no stdin",
        );
      },
    );
  });
});

Deno.test("contract: init applies its preset default when preset is omitted", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "", stderr: "" },
      async (calls) => {
        await run("init", { name: "demo-cluster" }, ctx);
        assertEquals(calls[0].args[2], "cozystack");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// templateNode — argv + install-disk / dhcp post-processing across fixtures
// ---------------------------------------------------------------------------

Deno.test("contract: templateNode argv is talm template -e <ip> -n <ip> -t <template> -i", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.controlplane.yaml");
    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async (calls) => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/cp1.yaml",
        }, ctx);
        assertEquals(calls.length, 1);
        assertEquals(calls[0].binary, "talm");
        assertEquals(calls[0].args, [
          "template",
          "-e",
          "192.0.2.10",
          "-n",
          "192.0.2.10",
          "-t",
          "templates/controlplane.yaml",
          "-i",
        ]);
        assertEquals(calls[0].cwd, dir);
      },
    );
  });
});

Deno.test("contract: no-shell-injection — a nodeIP/endpoint with shell metacharacters is exactly ONE unmodified argv element", async () => {
  const HOSTILE = "192.0.2.10; rm -rf /";
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.controlplane.yaml");
    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async (calls) => {
        await run("templateNode", {
          nodeIP: HOSTILE,
          outputFile: "nodes/pin.yaml",
        }, ctx);
        assertEquals(calls[0].args.length, 8);
        assertEquals(calls[0].args[2], HOSTILE);
        assertEquals(calls[0].args[4], HOSTILE);
        // Array-form argv: Deno.Command never spawns a shell, so a payload
        // like "; rm -rf /" travels as inert data in one element, never
        // concatenated into an interpretable command line.
        assert(
          calls[0].args.every((a) => typeof a === "string"),
          "every argv element stays an opaque string",
        );
      },
    );
  });
});

Deno.test("contract: templateNode post-processing — happy-path fixture rewrites install disk and injects dhcp: true", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.controlplane.yaml");
    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/cp1.yaml",
        }, ctx);
      },
    );
    const written = await Deno.readTextFile(`${dir}/nodes/cp1.yaml`);
    assert(
      written.includes("disk: /dev/vda"),
      "install disk rewritten to the installDisk default",
    );
    assert(!written.includes("disk: /dev/sr0"), "sr0 line no longer present");
    assert(
      written.includes("dhcp: true"),
      "dhcp: true injected before the vip: block",
    );
    assertEquals(
      written.indexOf("dhcp: true") < written.indexOf("vip:"),
      true,
      "dhcp: true is injected BEFORE the vip: line it precedes",
    );
  });
});

Deno.test("contract: templateNode post-processing — multi-disk fixture rewrites ONLY the first disk: /dev/srN occurrence (no g flag)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.multi-disk.yaml");
    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/cp1.yaml",
        }, ctx);
      },
    );
    const written = await Deno.readTextFile(`${dir}/nodes/cp1.yaml`);
    assert(
      written.includes("disk: /dev/vda"),
      "the first sr occurrence IS rewritten",
    );
    assert(
      written.includes("disk: /dev/sr1"),
      "the SECOND sr occurrence survives unrewritten — a real, pinned gap " +
        "from the disk-rewrite regex having no g flag",
    );
  });
});

Deno.test("contract: templateNode post-processing — no-sr fixture leaves install.disk unchanged (disk regex is a no-op; the unrelated dhcp injection still applies)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.no-sr.yaml");
    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/cp1.yaml",
        }, ctx);
      },
    );
    const written = await Deno.readTextFile(`${dir}/nodes/cp1.yaml`);
    assert(
      written.includes("disk: /dev/vda"),
      "install.disk was already /dev/vda and stays untouched",
    );
    assert(
      !written.includes("/dev/sr"),
      "no sr-device pattern existed, so none can appear post-processing",
    );
    // This fixture's interface block IS immediately followed by vip: (same
    // adjacency as the base fixture) — the dhcp regex is INDEPENDENT of the
    // disk regex and still fires here. That is expected, not a bug: this
    // fixture isolates "the disk regex has nothing to match", not "no
    // post-processing occurs at all".
    assert(written.includes("dhcp: true"));
  });
});

Deno.test("contract: templateNode post-processing — an interface not immediately followed by routes:/vip: gets NO dhcp: true injected", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.iface-no-routes.yaml");
    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/cp1.yaml",
        }, ctx);
      },
    );
    const written = await Deno.readTextFile(`${dir}/nodes/cp1.yaml`);
    assert(
      !written.includes("dhcp: true"),
      "interface followed by addresses:, not routes:/vip: -> no injection",
    );
    // Unrelated disk rewrite still applies — the two regexes are independent.
    assert(written.includes("disk: /dev/vda"));
  });
});

Deno.test("contract: templateNode post-processing is an idempotent fixed point — reprocessing the output changes nothing further", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const raw = await fixture("templateNode.controlplane.yaml");

    await withCommandStub(
      { success: true, stdout: raw, stderr: "" },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/pass1.yaml",
        }, ctx);
      },
    );
    const pass1 = await Deno.readTextFile(`${dir}/nodes/pass1.yaml`);

    // Feed pass1's own (already post-processed) content back through as if
    // talm had re-emitted it verbatim; the second pass must be a no-op.
    await withCommandStub(
      { success: true, stdout: pass1, stderr: "" },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/pass2.yaml",
        }, ctx);
      },
    );
    const pass2 = await Deno.readTextFile(`${dir}/nodes/pass2.yaml`);

    assertEquals(pass2, pass1, "second pass is byte-identical to the first");
  });
});

// ---------------------------------------------------------------------------
// apply — argv contract (CLI-arg passthrough, nodeFile is NOT FS-joined)
// ---------------------------------------------------------------------------

Deno.test("contract: apply argv is talm apply -f <nodeFile>, insecure appends -i", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "applied", stderr: "" },
      async (calls) => {
        await run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx);
        assertEquals(calls[0].binary, "talm");
        assertEquals(calls[0].args, ["apply", "-f", "nodes/cp1.yaml"]);
      },
    );
    await withCommandStub(
      { success: true, stdout: "applied", stderr: "" },
      async (calls) => {
        await run(
          "apply",
          { nodeFile: "nodes/cp1.yaml", insecure: true },
          ctx,
        );
        assertEquals(calls[0].args, [
          "apply",
          "-f",
          "nodes/cp1.yaml",
          "-i",
        ]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// bootstrap — argv contract
// ---------------------------------------------------------------------------

Deno.test("contract: bootstrap argv is talosctl bootstrap --talosconfig <dir>/talosconfig --endpoints <ep> --nodes <ep>", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const stdout = await fixture("bootstrap.stdout.txt");
    await withCommandStub(
      { success: true, stdout, stderr: "" },
      async (calls) => {
        await run("bootstrap", { endpoint: "192.0.2.10" }, ctx);
        assertEquals(calls[0].binary, "talosctl");
        assertEquals(calls[0].args, [
          "bootstrap",
          "--talosconfig",
          `${dir}/talosconfig`,
          "--endpoints",
          "192.0.2.10",
          "--nodes",
          "192.0.2.10",
        ]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// kubeconfig — the resolved outputFile path is an ARGV element, never a
// model-side FS write (talosctl itself performs the write; here it's
// stubbed, so no real write happens on either side)
// ---------------------------------------------------------------------------

Deno.test("contract: kubeconfig argv carries the resolved <dir>/<outputFile> as a talosctl argv element, not a model-side write", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "", stderr: "" },
      async (calls) => {
        await run("kubeconfig", { endpoint: "192.0.2.10" }, ctx);
        assertEquals(calls[0].binary, "talosctl");
        assertEquals(calls[0].args, [
          "kubeconfig",
          `${dir}/kubeconfig`,
          "--talosconfig",
          `${dir}/talosconfig`,
          "--endpoints",
          "192.0.2.10",
          "--nodes",
          "192.0.2.10",
          "--force",
        ]);
      },
    );
    let modelWroteFile = true;
    try {
      await Deno.stat(`${dir}/kubeconfig`);
    } catch {
      modelWroteFile = false;
    }
    assert(
      !modelWroteFile,
      "the model itself never writes kubeconfig — only a (stubbed) talosctl would",
    );
  });
});

// ---------------------------------------------------------------------------
// health — argv contract
// ---------------------------------------------------------------------------

Deno.test("contract: health argv is talosctl health --talosconfig ... --wait-timeout <t>", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const stdout = await fixture("health.stdout.txt");
    await withCommandStub(
      { success: true, stdout, stderr: "" },
      async (calls) => {
        await run(
          "health",
          { endpoint: "192.0.2.10", waitTimeout: "5m" },
          ctx,
        );
        assertEquals(calls[0].binary, "talosctl");
        assertEquals(calls[0].args, [
          "health",
          "--talosconfig",
          `${dir}/talosconfig`,
          "--endpoints",
          "192.0.2.10",
          "--nodes",
          "192.0.2.10",
          "--wait-timeout",
          "5m",
        ]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// getClusterState — FS-effect contract (no command issued)
// ---------------------------------------------------------------------------

Deno.test("contract: getClusterState — FS-only, writes the exact 'Found/Missing/Node configs' summary string", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await Deno.writeTextFile(`${dir}/secrets.yaml`, "");
    await Deno.writeTextFile(`${dir}/values.yaml`, "");
    await Deno.mkdir(`${dir}/nodes`);
    await Deno.writeTextFile(`${dir}/nodes/cp1.yaml`, "");
    await Deno.writeTextFile(`${dir}/nodes/cp2.yaml`, "");

    await withCommandStub(
      { success: true, stdout: "", stderr: "" },
      async (calls) => {
        await run("getClusterState", {}, ctx);
        assertEquals(calls.length, 0, "getClusterState issues no command");
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(
      res.payload.stdout,
      "Found: secrets.yaml, values.yaml | Missing: talosconfig, kubeconfig | Node configs: 2",
    );
  });
});

// ---------------------------------------------------------------------------
// configure — FS-effect contract (no command issued)
// ---------------------------------------------------------------------------

Deno.test("contract: configure — FS-only, writes the exact values.yaml body", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "", stderr: "" },
      async (calls) => {
        await run("configure", {
          endpoint: "https://192.0.2.17:6443",
          floatingIP: "192.0.2.20",
          image: "ghcr.io/cozystack/cozystack/talos:v1.10.5",
        }, ctx);
        assertEquals(calls.length, 0, "configure issues no command");
      },
    );
    const written = await Deno.readTextFile(`${dir}/values.yaml`);
    assertEquals(
      written,
      `endpoint: https://192.0.2.17:6443
floatingIP: 192.0.2.20
image: ghcr.io/cozystack/cozystack/talos:v1.10.5
podSubnets:
  - 10.244.0.0/16
serviceSubnets:
  - 10.96.0.0/16
advertisedSubnets:
  - 192.0.2.0/24
`,
    );
  });
});

Deno.test("sanity: fixture-derived transient-error vocabulary matches source per method (used by the adversarial/methods suites)", () => {
  const expected = {
    templateNode: [
      "connection refused",
      "connection error",
      "Unavailable",
      "i/o timeout",
      "deadline exceeded",
    ],
    apply: [
      "connection refused",
      "connection reset",
      "Unavailable",
      "deadline exceeded",
      "i/o timeout",
    ],
    bootstrap: [
      "connection refused",
      "connection error",
      "Unavailable",
      "deadline exceeded",
      "etcd",
      "i/o timeout",
      "transport is closing",
    ],
    health: [
      "connection refused",
      "connection error",
      "Unavailable",
      "i/o timeout",
      "deadline exceeded",
      "transport is closing",
      "healthcheck error",
    ],
  };
  assertEquals(transientErrors, expected);
});
