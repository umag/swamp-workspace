/**
 * Method-level tests for @magistr/talm-cluster — every one of the 8 methods
 * (getClusterState, init, configure, templateNode, apply, bootstrap,
 * kubeconfig, health) happy path + failure path, both `model.checks`
 * (cluster-dir-exists, talm-available, all branches), and the retry
 * behavior of the four retrying methods (templateNode/apply/bootstrap/
 * health): transient-then-success AND retry-exhaustion, each with its own
 * method-specific transient-error vocabulary.
 *
 * talm_cluster.ts is UNMODIFIED — every test here is a characterization test
 * pinning current, already-shipped behavior (not red-green TDD). The
 * `Deno.Command` boundary is stubbed (dual shape: spawn()->stdin/output()
 * AND a direct output()); `setTimeout` is stubbed fire-immediately for every
 * retry assertion — a no-op stub would deadlock the retry loop's
 * `await new Promise(r => setTimeout(r, 15000))`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./talm_cluster.ts";

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
type CheckMap = Record<string, {
  execute: (
    ctx?: unknown,
  ) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

function runCheck(name: string, ctx: unknown) {
  const check = (model.checks as CheckMap)[name];
  assert(check, `check ${name} must exist on the model`);
  return check.execute(ctx);
}

// ---------------------------------------------------------------------------
// Harness: Deno.Command dual-shape stub (see talm_cluster_test.ts for the
// fuller doc comment; duplicated per-file per this repo's suite convention).
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

/** Constructing `new Deno.Command(...)` throws — simulates "binary not found
 * in PATH" for the talm-available check's catch branch. */
function withThrowingCommand(fn: () => Promise<void>): Promise<void> {
  const original = Deno.Command;
  class ThrowingCommand {
    constructor() {
      throw new Deno.errors.NotFound("talm: command not found");
    }
  }
  (Deno as unknown as { Command: unknown }).Command = ThrowingCommand;
  return fn().finally(() => {
    (Deno as unknown as { Command: unknown }).Command = original;
  });
}

/** Fire-immediately setTimeout stub — MANDATORY for every retry assertion. A
 * no-op stub never resolves the retry loop's `await new Promise(r =>
 * setTimeout(r, 15000))` and hangs the test forever. Restores in finally. */
function withFireImmediateTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  const fake = ((cb: (...args: unknown[]) => void) => {
    cb();
    return 0;
  }) as typeof globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = fake;
  return fn().finally(() => {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = original;
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
// getClusterState
// ---------------------------------------------------------------------------

Deno.test("getClusterState: happy path — reports found/missing files and node config count", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await Deno.writeTextFile(`${dir}/secrets.yaml`, "");
    await run("getClusterState", {}, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assert(String(res.payload.stdout).includes("Found: secrets.yaml"));
    assert(String(res.payload.stdout).includes("Node configs: 0"));
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

Deno.test("init: happy path — writes a result resource combining both spawns' output", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      [
        { success: true, stdout: "init ok", stderr: "" },
        { success: true, stdout: "talosconfig ok", stderr: "" },
      ],
      async () => {
        await run(
          "init",
          { name: "demo-cluster", preset: "cozystack" },
          ctx,
        );
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "init");
    assert(String(res.payload.stdout).includes("init ok"));
    assert(String(res.payload.stdout).includes("talosconfig ok"));
  });
});

Deno.test("init: error path — the first spawn (talm init) failing rejects before a second spawn is attempted", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: false, stdout: "", stderr: "disk full" },
      async (calls) => {
        await assertRejects(
          () => run("init", { name: "demo-cluster" }, ctx),
          Error,
          "disk full",
        );
        assertEquals(calls.length, 1, "no talosconfig regen after a failure");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

Deno.test("configure: happy path — writes values.yaml with the applied defaults", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await run("configure", {
      endpoint: "https://192.0.2.17:6443",
      floatingIP: "192.0.2.20",
      image: "ghcr.io/cozystack/cozystack/talos:v1.10.5",
    }, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "configure");
    const onDisk = await Deno.readTextFile(`${dir}/values.yaml`);
    assertEquals(onDisk, res.payload.stdout);
  });
});

Deno.test("configure: error path — writing into a non-existent cluster directory rejects", async () => {
  const { ctx } = makeCtx("/nonexistent/does-not-exist-talm-cluster-dir");
  await assertRejects(
    () =>
      run("configure", {
        endpoint: "https://192.0.2.17:6443",
        floatingIP: "192.0.2.20",
        image: "ghcr.io/x:v1",
      }, ctx),
  );
});

// ---------------------------------------------------------------------------
// templateNode — happy / immediate-throw / retry
// ---------------------------------------------------------------------------

const NODE_CONFIG = "machine:\n  install:\n    disk: /dev/sr0\n";

Deno.test("templateNode: happy path — one spawn, writes nodeConfig resource named from outputFile", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: NODE_CONFIG, stderr: "" },
      async (calls) => {
        await run("templateNode", {
          nodeIP: "192.0.2.10",
          outputFile: "nodes/cp1.yaml",
        }, ctx);
        assertEquals(calls.length, 1);
      },
    );
    const res = written.find((w) => w.spec === "nodeConfig")!;
    assertEquals(res.name, "nodes-cp1-yaml");
    assertEquals(res.payload.nodeIP, "192.0.2.10");
  });
});

Deno.test("templateNode: immediate throw — a NON-transient stderr rejects after exactly one spawn (no retry)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "template: unknown flag -x" },
        async (calls) => {
          await assertRejects(
            () =>
              run("templateNode", {
                nodeIP: "192.0.2.10",
                outputFile: "nodes/cp1.yaml",
              }, ctx),
            Error,
            "unknown flag",
          );
          assertEquals(calls.length, 1, "non-transient errors do not retry");
        },
      )
    );
  });
});

Deno.test("templateNode: transient-then-success — one 'connection refused' attempt, then success on the second spawn", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        [
          { success: false, stdout: "", stderr: "connection refused" },
          { success: true, stdout: NODE_CONFIG, stderr: "" },
        ],
        async (calls) => {
          await run("templateNode", {
            nodeIP: "192.0.2.10",
            outputFile: "nodes/cp1.yaml",
          }, ctx);
          assertEquals(calls.length, 2);
        },
      )
    );
    const res = written.find((w) => w.spec === "nodeConfig");
    assert(res, "resource is written once the retry succeeds");
  });
});

Deno.test("templateNode: retry-exhaustion — 20 straight 'connection refused' attempts, then rejects with the last error", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "connection refused" },
        async (calls) => {
          await assertRejects(
            () =>
              run("templateNode", {
                nodeIP: "192.0.2.10",
                outputFile: "nodes/cp1.yaml",
              }, ctx),
            Error,
            "connection refused",
          );
          assertEquals(calls.length, 20, "exactly 20 attempts, then give up");
        },
      )
    );
  });
});

// ---------------------------------------------------------------------------
// apply — happy / immediate-throw / retry (its own vocabulary: "connection
// reset", NOT shared with templateNode's "connection error")
// ---------------------------------------------------------------------------

Deno.test("apply: happy path — writes a result resource named apply-<sanitized nodeFile>", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "applied", stderr: "" },
      async () => {
        await run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx);
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "apply-nodes-cp1-yaml");
  });
});

Deno.test("apply: immediate throw — a non-transient stderr rejects after one spawn", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "invalid config: bad yaml" },
        async (calls) => {
          await assertRejects(
            () => run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx),
            Error,
            "bad yaml",
          );
          assertEquals(calls.length, 1);
        },
      )
    );
  });
});

Deno.test("apply: transient-then-success — 'connection reset' then success", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        [
          { success: false, stdout: "", stderr: "connection reset" },
          { success: true, stdout: "applied", stderr: "" },
        ],
        async (calls) => {
          await run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx);
          assertEquals(calls.length, 2);
        },
      )
    );
    assert(written.some((w) => w.spec === "result"));
  });
});

Deno.test("apply: retry-exhaustion — 20 straight 'connection reset' attempts, then rejects", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "connection reset" },
        async (calls) => {
          await assertRejects(
            () => run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx),
            Error,
            "connection reset",
          );
          assertEquals(calls.length, 20);
        },
      )
    );
  });
});

Deno.test("apply: 'connection error' (templateNode's token) is NOT in apply's transient vocabulary — rejects immediately", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "connection error" },
        async (calls) => {
          await assertRejects(
            () => run("apply", { nodeFile: "nodes/cp1.yaml" }, ctx),
            Error,
            "connection error",
          );
          assertEquals(
            calls.length,
            1,
            "apply's classifier does not include 'connection error' — no retry",
          );
        },
      )
    );
  });
});

// ---------------------------------------------------------------------------
// bootstrap — happy / immediate-throw / retry (its own vocabulary includes
// "etcd", NOT present in templateNode/apply/health's lists)
// ---------------------------------------------------------------------------

Deno.test("bootstrap: happy path — writes a result resource", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "bootstrapped", stderr: "" },
      async () => {
        await run("bootstrap", { endpoint: "192.0.2.10" }, ctx);
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "bootstrap");
  });
});

Deno.test("bootstrap: immediate throw — a non-transient stderr rejects after one spawn", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        {
          success: false,
          stdout: "",
          stderr: "certificate signed by unknown authority",
        },
        async (calls) => {
          await assertRejects(
            () => run("bootstrap", { endpoint: "192.0.2.10" }, ctx),
            Error,
            "unknown authority",
          );
          assertEquals(calls.length, 1);
        },
      )
    );
  });
});

Deno.test("bootstrap: transient-then-success — 'etcd' (bootstrap-only token) then success", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        [
          { success: false, stdout: "", stderr: "etcd not ready yet" },
          { success: true, stdout: "bootstrapped", stderr: "" },
        ],
        async (calls) => {
          await run("bootstrap", { endpoint: "192.0.2.10" }, ctx);
          assertEquals(calls.length, 2);
        },
      )
    );
    assert(written.some((w) => w.spec === "result"));
  });
});

Deno.test("bootstrap: retry-exhaustion — 30 straight transient attempts, then rejects", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "transport is closing" },
        async (calls) => {
          await assertRejects(
            () => run("bootstrap", { endpoint: "192.0.2.10" }, ctx),
            Error,
            "transport is closing",
          );
          assertEquals(calls.length, 30, "bootstrap retries exactly 30 times");
        },
      )
    );
  });
});

Deno.test("bootstrap: 'healthcheck error' (health-only token) is NOT in bootstrap's transient vocabulary — rejects immediately", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "healthcheck error" },
        async (calls) => {
          await assertRejects(
            () => run("bootstrap", { endpoint: "192.0.2.10" }, ctx),
          );
          assertEquals(calls.length, 1);
        },
      )
    );
  });
});

// ---------------------------------------------------------------------------
// kubeconfig — happy / error (no retry loop on this method)
// ---------------------------------------------------------------------------

Deno.test("kubeconfig: happy path — writes a result resource naming the outPath", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "", stderr: "" },
      async () => {
        await run("kubeconfig", { endpoint: "192.0.2.10" }, ctx);
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "kubeconfig");
    assert(String(res.payload.stdout).includes(`${dir}/kubeconfig`));
  });
});

Deno.test("kubeconfig: error path — a failing talosctl invocation rejects (no retry loop on this method)", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withCommandStub(
      { success: false, stdout: "", stderr: "connection refused" },
      async (calls) => {
        await assertRejects(
          () => run("kubeconfig", { endpoint: "192.0.2.10" }, ctx),
          Error,
          "connection refused",
        );
        assertEquals(
          calls.length,
          1,
          "kubeconfig has no retry loop, unlike bootstrap/health",
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// health — happy / immediate-throw / retry (its own vocabulary includes
// "healthcheck error", NOT present in the other three retrying methods)
// ---------------------------------------------------------------------------

Deno.test("health: happy path — writes a result resource", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withCommandStub(
      { success: true, stdout: "cluster is healthy", stderr: "" },
      async () => {
        await run(
          "health",
          { endpoint: "192.0.2.10", waitTimeout: "30s" },
          ctx,
        );
      },
    );
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.name, "health");
  });
});

Deno.test("health: immediate throw — a non-transient stderr rejects after one spawn", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "invalid talosconfig context" },
        async (calls) => {
          await assertRejects(
            () =>
              run(
                "health",
                { endpoint: "192.0.2.10", waitTimeout: "30s" },
                ctx,
              ),
            Error,
            "invalid talosconfig",
          );
          assertEquals(calls.length, 1);
        },
      )
    );
  });
});

Deno.test("health: transient-then-success — 'healthcheck error' then success", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx, written } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        [
          { success: false, stdout: "", stderr: "healthcheck error: etcd" },
          { success: true, stdout: "cluster is healthy", stderr: "" },
        ],
        async (calls) => {
          await run(
            "health",
            { endpoint: "192.0.2.10", waitTimeout: "30s" },
            ctx,
          );
          assertEquals(calls.length, 2);
        },
      )
    );
    assert(written.some((w) => w.spec === "result"));
  });
});

Deno.test("health: retry-exhaustion — 40 straight transient attempts, then rejects", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    await withFireImmediateTimeout(() =>
      withCommandStub(
        { success: false, stdout: "", stderr: "i/o timeout" },
        async (calls) => {
          await assertRejects(
            () =>
              run(
                "health",
                { endpoint: "192.0.2.10", waitTimeout: "30s" },
                ctx,
              ),
            Error,
            "i/o timeout",
          );
          assertEquals(calls.length, 40, "health retries exactly 40 times");
        },
      )
    );
  });
});

// ---------------------------------------------------------------------------
// model.checks["cluster-dir-exists"] — all 3 branches
// ---------------------------------------------------------------------------

Deno.test("check cluster-dir-exists: pass — a real directory", async () => {
  await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    const result = await runCheck("cluster-dir-exists", ctx);
    assertEquals(result, { pass: true });
  });
});

Deno.test("check cluster-dir-exists: fail — path does not exist", async () => {
  const { ctx } = makeCtx("/nonexistent/definitely-not-there-talm");
  const result = await runCheck("cluster-dir-exists", ctx);
  assertEquals(result.pass, false);
  assert(result.errors![0].includes("does not exist"));
});

Deno.test("check cluster-dir-exists: fail — path exists but is a FILE, not a directory", async () => {
  const file = await Deno.makeTempFile();
  try {
    const { ctx } = makeCtx(file);
    const result = await runCheck("cluster-dir-exists", ctx);
    assertEquals(result.pass, false);
    assert(result.errors![0].includes("is not a directory"));
  } finally {
    await Deno.remove(file);
  }
});

// ---------------------------------------------------------------------------
// model.checks["talm-available"] — all 3 branches
// ---------------------------------------------------------------------------

Deno.test("check talm-available: pass — talm --version succeeds", async () => {
  await withCommandStub(
    { success: true, stdout: "talm v1.0.0", stderr: "" },
    async () => {
      const result = await runCheck("talm-available", undefined);
      assertEquals(result, { pass: true });
    },
  );
});

Deno.test("check talm-available: fail — talm --version returns a non-zero exit", async () => {
  await withCommandStub(
    { success: false, stdout: "", stderr: "panic" },
    async () => {
      const result = await runCheck("talm-available", undefined);
      assertEquals(result.pass, false);
      assertEquals(result.errors, ["talm binary found but returned error"]);
    },
  );
});

Deno.test("check talm-available: fail — the binary is not on PATH at all (Deno.Command throws)", async () => {
  await withThrowingCommand(async () => {
    const result = await runCheck("talm-available", undefined);
    assertEquals(result.pass, false);
    assertEquals(result.errors, ["talm binary not found in PATH"]);
  });
});
