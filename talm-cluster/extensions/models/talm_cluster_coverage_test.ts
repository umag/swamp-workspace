/**
 * Coverage suite for @magistr/talm-cluster: regression guards for behavior
 * NOT already pinned by the contract-fixture, methods, or adversarial
 * suites — a reviewer-surfaced guard with no test protecting it (STANDARD.md's
 * coverage role: "if someone deletes this guard, does a test go red?").
 *
 * Specifically owns (not duplicated elsewhere):
 *  - runCmd's `${stderr || stdout}` error-message fallback, both branches.
 *  - templateNode's OUTPUT-PARENT recursive mkdir across MULTIPLE missing
 *    directory levels (contract/methods only exercise a single-level dir).
 *  - getClusterState's nodes/ .yaml-count guard: the missing-`nodes/`-dir
 *    catch branch, non-`.yaml` files excluded, and a `*.yaml`-NAMED
 *    SUBDIRECTORY excluded (the `entry.isFile` half of the guard).
 *  - the `outputFile`/`nodeFile` -> resource-name sanitizer
 *    (`replace(/[/.]/g, "-")`) across multi-slash/multi-dot shapes.
 *
 * talm_cluster.ts is UNMODIFIED — every test here PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./talm_cluster.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
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
  result: CommandResult,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  const original = Deno.Command;

  class FakeCommand {
    #call: CapturedCall;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      this.#call = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
        cwd: opts.cwd as string | undefined,
        stdin: "",
      };
      calls.push(this.#call);
    }
    spawn() {
      const call = this.#call;
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
      return Promise.resolve(encodeOutput(result));
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

// ---------------------------------------------------------------------------
// Guard: runCmd's `${stderr || stdout}` error-message fallback
// ---------------------------------------------------------------------------

Deno.test("runCmd error message: stderr present -> stderr wins over stdout", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: false, stdout: "some stdout noise", stderr: "the real error" },
      async () => {
        let threw: unknown;
        try {
          await run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx);
        } catch (e) {
          threw = e;
        }
        assert(threw instanceof Error);
        assertEquals(threw.message, "talm apply failed: the real error");
      },
    );
  });
});

Deno.test("runCmd error message: stderr EMPTY -> falls back to stdout", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: false, stdout: "diagnostic on stdout only", stderr: "" },
      async () => {
        let threw: unknown;
        try {
          await run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx);
        } catch (e) {
          threw = e;
        }
        assert(threw instanceof Error);
        assertEquals(
          threw.message,
          "talm apply failed: diagnostic on stdout only",
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: templateNode's output-parent recursive mkdir across MULTIPLE
// missing directory levels
// ---------------------------------------------------------------------------

Deno.test("templateNode: creates a MULTI-LEVEL missing output-parent directory chain (recursive mkdir)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      {
        success: true,
        stdout: "machine:\n  install:\n    disk: /dev/vda\n",
        stderr: "",
      },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "clusters/demo/nodes/cp1.yaml",
        }, ctx);
      },
    );
    for (
      const level of [
        "clusters",
        "clusters/demo",
        "clusters/demo/nodes",
      ]
    ) {
      const stat = await Deno.stat(`${dir}/${level}`);
      assert(stat.isDirectory, `${level} must have been created`);
    }
    const content = await Deno.readTextFile(
      `${dir}/clusters/demo/nodes/cp1.yaml`,
    );
    assert(content.includes("disk: /dev/vda"));
  });
});

// ---------------------------------------------------------------------------
// Guard: getClusterState's nodes/ .yaml-count — missing dir, non-.yaml
// files, and a *.yaml-NAMED SUBDIRECTORY are all excluded
// ---------------------------------------------------------------------------

Deno.test("getClusterState: nodes/ directory absent entirely -> nodeConfigs 0 via the catch branch (not a thrown error)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await run("getClusterState", {}, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assert(String(res.payload.stdout).includes("Node configs: 0"));
  });
});

Deno.test("getClusterState: nodes/ present but empty -> nodeConfigs 0 (readDir succeeds, zero matching entries)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await Deno.mkdir(`${dir}/nodes`);
    await run("getClusterState", {}, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assert(String(res.payload.stdout).includes("Node configs: 0"));
  });
});

Deno.test("getClusterState: only FILES ending in .yaml count — a non-.yaml file and a *.yaml-named SUBDIRECTORY are both excluded", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await Deno.mkdir(`${dir}/nodes`);
    await Deno.writeTextFile(`${dir}/nodes/cp1.yaml`, "");
    await Deno.writeTextFile(`${dir}/nodes/cp2.yaml`, "");
    await Deno.writeTextFile(`${dir}/nodes/README.txt`, "not a node config");
    // A directory whose NAME ends in .yaml must not be counted — the guard
    // is `entry.isFile && entry.name.endsWith(".yaml")`, both halves matter.
    await Deno.mkdir(`${dir}/nodes/looks-like-a-file.yaml`);
    await run("getClusterState", {}, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assert(
      String(res.payload.stdout).includes("Node configs: 2"),
      "exactly the 2 real .yaml FILES are counted, not the .txt file or the " +
        "*.yaml-named directory",
    );
  });
});

Deno.test("getClusterState: all four tracked files found -> 'Missing: none'; none found -> 'Found: none'", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx: ctxA, written: writtenA } = makeCtx(dir);
    await run("getClusterState", {}, ctxA);
    const resMissing = writtenA.find((w) => w.spec === "result")!;
    assertEquals(
      resMissing.payload.stdout,
      "Found: none | Missing: secrets.yaml, values.yaml, talosconfig, kubeconfig | Node configs: 0",
    );
  });
  await withTempClusterDir(async (dir) => {
    for (
      const f of ["secrets.yaml", "values.yaml", "talosconfig", "kubeconfig"]
    ) {
      await Deno.writeTextFile(`${dir}/${f}`, "");
    }
    const { ctx, written } = makeCtx(dir);
    await run("getClusterState", {}, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(
      res.payload.stdout,
      "Found: secrets.yaml, values.yaml, talosconfig, kubeconfig | Missing: none | Node configs: 0",
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: outputFile/nodeFile -> resource-name sanitizer, multi-slash/dot
// shapes (methods suite only exercises the single-level "nodes/cp1.yaml"
// shape)
// ---------------------------------------------------------------------------

Deno.test("templateNode: resource-name sanitizer collapses EVERY '/' and '.' in a deep, multi-dot outputFile", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      {
        success: true,
        stdout: "machine:\n  install:\n    disk: /dev/vda\n",
        stderr: "",
      },
      async () => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "a/b.c/d.node-1.yaml",
        }, ctx);
      },
    );
    const res = written.find((w) => w.spec === "nodeConfig")!;
    assertEquals(res.name, "a-b-c-d-node-1-yaml");
  });
});

Deno.test("apply: resource-name sanitizer collapses EVERY '/' and '.' in a deep, multi-dot nodeFile", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "applied", stderr: "" },
      async () => {
        await run("apply", { nodeFile: "a/b.c/d.node-1.yaml" }, ctx);
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "apply-a-b-c-d-node-1-yaml");
  });
});

Deno.test("templateNode: a flat outputFile with no '/' or '.' passes through the sanitizer unchanged", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      {
        success: true,
        stdout: "machine:\n  install:\n    disk: /dev/vda\n",
        stderr: "",
      },
      async () => {
        await run(
          "templateNode",
          { nodeIP: "192.0.2.10", outputFile: "plain" },
          ctx,
        );
      },
    );
    const res = written.find((w) => w.spec === "nodeConfig")!;
    assertEquals(res.name, "plain");
  });
});
