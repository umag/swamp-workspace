// Method-level tests across all FIVE @magistr/swamp-go-brr models: gobrr,
// source-integration, docker-verify, and preflight (otlp-export's export_run
// method is already exercised at this level by the kept otlp_export.test.ts,
// which stays in the "methods" role — see quality.yaml).
//
// gobrr.ts / docker_verify.ts / source_integration.ts / preflight.ts / lib/*
// are UNMODIFIED — every test here drives `model.methods.<m>.execute(...)`
// (through `arguments.parse()`, pinning the zod arg schema too) against a
// real fake ctx or a stubbed `Deno.Command`, characterizing already-shipped
// behavior (test-only backfill, ext-quality-bf-swamp-go-brr).
//
// This suite specifically closes the gap left by the pre-existing 12 tests:
// gobrr's start/seed_tasks/next/report/complete/emit_otlp/hydrate/abort were
// only exercised as PURE helpers (deriveGate, applyReport, nextDecision, ...)
// or, for heartbeat/add_followup, at the method level for lease-expiry only.
// source-integration's build_workorder/apply execute() wrappers (the
// realpath-anchored FS + jj I/O) were never driven at all — only their pure
// cores (parseEnvelope/planApply/summarizeEnvelope). docker-verify's verify()
// and preflight's pin_image/scaffold/config execute() wrappers were likewise
// untested at this level (preflight.test.ts drives the pure builders with an
// INJECTED CommandRunner, never the model methods that hardcode
// defaultRunner/defaultWriter).
//
// Two DISTINCT Deno.Command shapes are stubbed, matching production exactly:
//  - "direct output": `new Deno.Command(cmd, {args}).output()` — used by
//    lib/ssh.ts (sshExec/sshExecRaw, for docker-verify) and source_integration's
//    local jjRun.
//  - "spawn+stdin": `new Deno.Command(cmd, {args, stdin}).spawn()` then
//    `child.stdin.getWriter()` (only when stdin is piped) then
//    `child.output()` — used by preflight's defaultRunner (docker/jj via
//    pin_image/scaffold), which is NOT injectable at the method level.
// No test here runs a real ssh/docker/jj process or hangs.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as gobrrModel, type Run } from "./gobrr.ts";
import { model as siModel } from "./source_integration.ts";
import { model as dvModel } from "./docker_verify.ts";
import { model as preflightModel } from "./preflight.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function callMethod(
  m: { methods: unknown },
  name: string,
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<unknown> {
  const method = (m.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Stub matching the "direct output" seam: `new Deno.Command(cmd,{args}).output()`. */
function stubDirectOutput(
  responder: (cmd: string, args: string[]) => CommandResult,
): () => void {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    output() {
      const r = responder(this.#cmd, this.#args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = orig;
  };
}

/** Stub matching the "spawn+stdin" seam: preflight's `defaultRunner`. */
function stubSpawnCommand(
  responder: (cmd: string, args: string[]) => CommandResult,
): () => void {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  class FakeChild {
    stdin = {
      getWriter: () => ({
        write: (_chunk: Uint8Array) => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    };
    constructor(private cmd: string, private args: string[]) {}
    output() {
      const r = responder(this.cmd, this.args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    spawn() {
      return new FakeChild(this.#cmd, this.#args);
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = orig;
  };
}

type Written = { spec: string; name: string; data: Record<string, unknown> };

function collector(): {
  written: Written[];
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
} {
  const written: Written[] = [];
  return {
    written,
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve(data);
    },
  };
}

// ===========================================================================
// gobrr — full lifecycle: start -> seed_tasks -> next -> report -> complete
// -> emit_otlp -> hydrate, plus abort on a separate in-flight run.
// ===========================================================================

function makeGobrrCtx() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    ctx: {
      logger: { info: () => {} },
      readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        store.set(name, data);
        return Promise.resolve({ name });
      },
      definition: { name: "gobrr-methods-test" },
    },
  };
}

const BASE_CONFIG = {
  verifyCommand: "deno test",
  verifyInputs: ["tests/"],
  repoScope: "/repo",
  toolchainImage: "img@sha256:" + "a".repeat(64),
};

Deno.test("gobrr lifecycle: start -> seed_tasks -> next -> report(done) -> complete -> emit_otlp -> hydrate", async () => {
  const { store, ctx } = makeGobrrCtx();

  await callMethod(gobrrModel, "start", {
    intake: "build a widget",
    config: BASE_CONFIG,
  }, ctx);
  assert(store.has("current"), "start persists the run");

  await callMethod(gobrrModel, "seed_tasks", {
    tasks: [{
      id: "t1",
      spec: "implement widget",
      writeAllowlist: [
        "src/widget.ts",
      ],
    }],
  }, ctx);
  const afterSeed = store.get("current") as unknown as Run;
  assertEquals(afterSeed.tasks.length, 1);
  assert(afterSeed.tasks[0].spanId, "seed_tasks assigns a root-fact spanId");

  const nextOut = await callMethod(
    gobrrModel,
    "next",
    { owner: "driver-1" },
    ctx,
  ) as {
    dataHandles: unknown[];
  };
  assertEquals(nextOut.dataHandles.length, 2, "persists run + writes decision");
  const decision = store.get("decision")!;
  assertEquals(decision.outcome, "leased");
  assertEquals(decision.taskId, "t1");

  await callMethod(gobrrModel, "report", {
    taskId: "t1",
    owner: "driver-1",
    workResult: { diff: "d", changedPaths: ["src/widget.ts"], followups: [] },
    verifyExitCode: 0,
  }, ctx);
  const afterReport = store.get("current") as unknown as Run;
  assertEquals(afterReport.tasks[0].status, "done");
  assertEquals(afterReport.tasks[0].outcome, "done");
  assert(
    store.has("stepOutputs"),
    "report best-effort appends an audit record",
  );

  await callMethod(gobrrModel, "complete", {}, ctx);
  const completed = store.get("current") as unknown as Run;
  assertEquals(completed.status, "complete");
  assertEquals(
    (store.get("summary") as Record<string, unknown>).status,
    "complete",
    "complete() writes the final report as `summary`",
  );

  await callMethod(gobrrModel, "emit_otlp", {}, ctx);
  assert(store.has("traceOtlp"));
  assert(store.has("metricsOtlp"));
  const trace = store.get("traceOtlp") as Record<string, unknown>;
  assertEquals(trace.status, "ok");

  await callMethod(gobrrModel, "hydrate", {}, ctx);
  const summary = store.get("summary") as Record<string, unknown>;
  assertEquals(summary.status, "complete");
  assert(
    "stepOutputs" in summary,
    "hydrate augments the summary with the derived stepOutputs projection",
  );
});

Deno.test("gobrr lifecycle: heartbeat records a vmId, abort halts the run and reports leased VMs to destroy", async () => {
  const { store, ctx } = makeGobrrCtx();
  await callMethod(gobrrModel, "start", {
    intake: "long-running task",
    config: BASE_CONFIG,
  }, ctx);
  await callMethod(gobrrModel, "seed_tasks", {
    tasks: [{ id: "t1", spec: "x", writeAllowlist: ["src/a.ts"] }],
  }, ctx);
  await callMethod(gobrrModel, "next", { owner: "drv" }, ctx);
  await callMethod(gobrrModel, "heartbeat", {
    taskId: "t1",
    owner: "drv",
    vmId: "vm-123",
  }, ctx);
  const beforeAbort = store.get("current") as unknown as Run;
  assertEquals(beforeAbort.tasks[0].lease?.vmId, "vm-123");

  await callMethod(
    gobrrModel,
    "abort",
    { reason: "operator requested stop" },
    ctx,
  );
  const run = store.get("current") as unknown as Run;
  assertEquals(run.status, "halted");
  assert((run.haltReason as string).includes("operator requested stop"));
  const decision = store.get("decision") as Record<string, unknown>;
  assertEquals(decision.outcome, "aborted");
  const leasedVms = decision.leasedVms as Array<
    { id: string; vmId: string | null }
  >;
  assertEquals(leasedVms, [{ id: "t1", vmId: "vm-123" }]);
});

// ===========================================================================
// source-integration — build_workorder + apply execute(), real temp repo.
// ===========================================================================

Deno.test("source_integration.build_workorder: reads allowlisted files from a real temp repo, scrubs secrets, writes the workorder prompt", async () => {
  const repoRoot = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoRoot}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${repoRoot}/src/a.ts`,
      'const token = "sk-ant-LEAKEDsecret1234567";\nexport const x = 1;\n',
    );
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { jjPath: "jj" },
      writeResource,
    };
    await callMethod(siModel, "build_workorder", {
      taskId: "t1",
      spec: "add a helper",
      writeAllowlist: ["src/a.ts"],
      repoScope: repoRoot,
      nonce: "n0nce",
    }, ctx);
    const wo = written.find((w) => w.spec === "workorder")!;
    const prompt = wo.data.prompt as string;
    assert(
      !prompt.includes("sk-ant-LEAKEDsecret1234567"),
      "secret must be scrubbed before inlining into the leaf prompt",
    );
    assert(prompt.includes("export const x = 1;"), "non-secret content kept");
    assert(prompt.includes("<<<GOBRR:n0nce"));
    assertEquals(wo.data.taskId, "t1");
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("source_integration.apply: applies a @@NEWFILE envelope as a per-task jj change over a real temp repo (stubbed jj)", async () => {
  const repoRoot = await Deno.makeTempDir();
  try {
    // pass apply()'s `Deno.lstatSync(\`${repoRoot}/.jj\`).isDirectory` guard —
    // jj itself is entirely stubbed below, so this need not be a real jj repo.
    await Deno.mkdir(`${repoRoot}/.jj`, { recursive: true });
    const nonce = "abc123nonce";
    const rawStdout =
      `<<<GOBRR:${nonce}\n@@NEWFILE done/marker.txt\nhello\n@@ENDFILE\nGOBRR:${nonce}>>>`;
    const restore = stubDirectOutput((cmd, args) => {
      assertEquals(cmd, "jj", "apply() must shell to `jj` only");
      if (args.includes("new")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("diff")) {
        return {
          code: 0,
          stdout: [
            "diff --git a/done/marker.txt b/done/marker.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/done/marker.txt",
            "@@ -0,0 +1 @@",
            "+hello",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args.includes("log")) {
        return { code: 0, stdout: "abcxyz123\n", stderr: "" };
      }
      throw new Error(`unexpected jj args ${args.join(" ")}`);
    });
    try {
      const { written, writeResource } = collector();
      const ctx = {
        logger: { info: () => {} },
        globalArgs: { jjPath: "jj" },
        writeResource,
      };
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "basechange",
        tasks: [{
          taskId: "t1",
          rawStdout,
          nonce,
          writeAllowlist: ["done/marker.txt"],
        }],
      }, ctx);
      const applied = written.find((w) => w.spec === "applied")!;
      const results = applied.data.results as Record<string, unknown>;
      const t1 = results.t1 as Record<string, unknown>;
      assertEquals(t1.changeId, "abcxyz123");
      assertEquals(t1.changedPaths, ["done/marker.txt"]);
      assert(!("failureKind" in t1), "the task must succeed");
      // the write is REAL — defaultWriter is not injectable at this level.
      const onDisk = await Deno.readTextFile(`${repoRoot}/done/marker.txt`);
      assertEquals(onDisk, "hello");
    } finally {
      restore();
    }
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
  }
});

// ===========================================================================
// docker-verify — verify() execute(), stubbed ssh sentinel.
// ===========================================================================

Deno.test("docker_verify.verify: runs the hardened docker command over the stubbed ssh transport and records the sentinel exit code", async () => {
  const restore = stubDirectOutput((cmd, args) => {
    assertEquals(cmd, "ssh");
    assert(
      args.some((a) => a.includes("'docker' 'run'")),
      "the shell-quoted docker invocation must ride as the ssh command arg",
    );
    return {
      code: 0,
      stdout: "test output ok\n__GOBRR_EXIT__:0\n",
      stderr: "",
    };
  });
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { sshHost: "dv.example.com", sshUser: "root" },
      writeResource,
    };
    await callMethod(dvModel, "verify", {
      image: "reg/toolchain@sha256:" + "a".repeat(64),
      treePath: "/srv/runs/run1/tree",
      verifyCommand: "deno test",
    }, ctx);
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.data.exitCode, 0);
    assert((res.data.stdout as string).includes("test output ok"));
  } finally {
    restore();
  }
});

// ===========================================================================
// preflight — pin_image / scaffold (real spawn-shape stub) / config.
// ===========================================================================

Deno.test("preflight.pin_image: pins a prebuilt sourceImage end-to-end via the spawn-shape Deno.Command stub", async () => {
  const DIGEST = "127.0.0.1:5000/proj@sha256:" + "a".repeat(64);
  const restore = stubSpawnCommand((cmd, args) => {
    assertEquals(cmd, "docker");
    const joined = args.join(" ");
    if (joined === "info") return { code: 0, stdout: "", stderr: "" };
    if (joined.includes("inspect gobrr-registry")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("image inspect")) {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("tag ")) return { code: 0, stdout: "", stderr: "" };
    if (joined.includes("--format {{.RepoDigests}}")) {
      return { code: 0, stdout: `[${DIGEST}]`, stderr: "" };
    }
    if (joined.startsWith("pull ")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  try {
    const { written, writeResource } = collector();
    const ctx = {
      globalArgs: preflightModel.globalArguments.parse({}),
      writeResource,
    };
    await callMethod(preflightModel, "pin_image", {
      name: "proj",
      tag: "gate",
      sourceImage: "denoland/deno:2.8.3",
    }, ctx);
    const pinned = written.find((w) => w.spec === "pinned")!;
    assertEquals(pinned.data.image, DIGEST);
    assertEquals(pinned.data.built, false);
  } finally {
    restore();
  }
});

Deno.test("preflight.scaffold: writes real baseline files to disk and returns the jj base change id (spawn-shape stub)", async () => {
  const repoPath = await Deno.makeTempDir();
  const restore = stubSpawnCommand((cmd, args) => {
    assertEquals(cmd, "jj");
    if (args.includes("init")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("describe")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("log")) {
      return { code: 0, stdout: "zzzbase123\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  try {
    const { written, writeResource } = collector();
    const ctx = {
      globalArgs: preflightModel.globalArguments.parse({}),
      writeResource,
    };
    await callMethod(preflightModel, "scaffold", {
      repoPath,
      files: [{ path: "deno.json", content: "{}" }],
    }, ctx);
    const scaffold = written.find((w) => w.spec === "scaffold")!;
    assertEquals(scaffold.data.base, "zzzbase123");
    assertEquals(scaffold.data.repoScope, repoPath);
    const onDisk = await Deno.readTextFile(`${repoPath}/deno.json`);
    assertEquals(onDisk, "{}");
  } finally {
    restore();
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("preflight.config: emits the run config wrapping buildConfig with the globalArgs substrate", async () => {
  const { written, writeResource } = collector();
  const ctx = {
    globalArgs: preflightModel.globalArguments.parse({}),
    writeResource,
  };
  await callMethod(preflightModel, "config", {
    image: "img@sha256:" + "a".repeat(64),
    verifyCommand: "deno test -A",
  }, ctx);
  const cfg = written.find((w) => w.spec === "config")!;
  assertEquals(cfg.data.image, "img@sha256:" + "a".repeat(64));
  assertEquals(cfg.data.verifyCommand, "deno test -A");
  assertEquals(
    (cfg.data.instances as Record<string, string>).fab,
    "fab",
  );
  assertEquals((cfg.data.instanceCommands as unknown[]).length, 3);
  assert(
    (cfg.data.fabricUp as Record<string, unknown>).oauthToken as string,
  );
});
