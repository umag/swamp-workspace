/**
 * Method-level tests for @magistr/fc-task-server — every one of the 4
 * methods (deploy, inject_task, collect_result, stop) happy path + failure
 * path, plus the `host-reachable` pre-flight check's both branches, plus a
 * spot-check that the sk-ant OAuth token never leaks into a written
 * resource (the full mechanical secret-scan lives in the adversarial suite).
 *
 * fc_task_server.ts / lib/ssh.ts are UNMODIFIED — every test here is a
 * characterization test pinning current, already-shipped behavior (not
 * red-green TDD; this is a test-only backfill).
 *
 * `deploy` makes TWO sequential ssh calls (pid echo, then port-probe) — every
 * test scripts a result QUEUE so the SECOND command is exercised distinctly
 * (a single shared stub would make the "the probe ran" assertion pass
 * vacuously even if `deploy` only ever issued one call).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./fc_task_server.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention — see
// fc_task_server_test.ts / fc_task_server_adversarial_test.ts /
// fc_task_server_coverage_test.ts for the sibling copies)
// ---------------------------------------------------------------------------

interface CapturedCall {
  binary: string;
  args: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ResultPicker =
  | CommandResult
  | CommandResult[]
  | ((call: CapturedCall, callIndex: number) => CommandResult);

function encodeOutput(r: CommandResult) {
  return {
    success: r.code === 0,
    code: r.code,
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
  // deno-lint-ignore no-explicit-any
  const original = (globalThis as any).Deno.Command;

  function pickResult(call: CapturedCall): CommandResult {
    const idx = callIndex++;
    if (typeof results === "function") return results(call, idx);
    if (Array.isArray(results)) {
      return results[idx] ?? results[results.length - 1];
    }
    return results;
  }

  class FakeCommand {
    #result: CommandResult;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      const call: CapturedCall = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
      };
      calls.push(call);
      this.#result = pickResult(call);
    }
    output() {
      return Promise.resolve(encodeOutput(this.#result));
    }
  }

  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return fn(calls).finally(() => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = original;
  });
}

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

const OAUTH_TOKEN = "sk-ant-oat01-do-not-leak-this-value";

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    host: "fc.example.com",
    oauthToken: OAUTH_TOKEN,
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

type ResourceMap = Record<
  string,
  { schema: { parse: (x: unknown) => unknown } }
>;

function parseAgainstResourceSchema(spec: string, payload: unknown): unknown {
  return (model.resources as ResourceMap)[spec].schema.parse(payload);
}

type CheckResult = { pass: boolean; errors?: string[] };
type CheckMap = Record<string, {
  execute: (ctx: unknown) => CheckResult | Promise<CheckResult>;
}>;

async function runCheck(name: string, ctx: unknown): Promise<CheckResult> {
  const check = (model.checks as CheckMap)[name];
  assert(check, `check ${name} must exist on the model`);
  return await check.execute(ctx);
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

Deno.test("deploy: happy path — 2 ssh calls, parses the pid from the first call's stdout", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "12345\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      assertEquals(calls.length, 2);
    },
  );
  const res = written.find((w) => w.spec === "serverState")!;
  assertEquals(res.payload.pid, 12345);
  assertEquals(res.payload.status, "running");
  assertEquals(typeof res.payload.timestamp, "string");
  parseAgainstResourceSchema("serverState", res.payload);
});

Deno.test("deploy: the SECOND ssh call is genuinely the port-probe — scripting distinct results per call catches a vacuous single-call stub", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    (_call, idx) =>
      idx === 0
        ? { code: 0, stdout: "999\n", stderr: "" }
        : { code: 0, stdout: "THIS-IS-THE-PROBE-RESULT", stderr: "" },
    async (calls) => {
      await run("deploy", {}, ctx);
      assertEquals(calls.length, 2, "exactly 2 calls, no more no less");
      assert(
        calls[1].args[7].includes("python3 -c"),
        "the 2nd call must be the port-probe script, not a repeat of the start command",
      );
      assert(!calls[0].args[7].includes('python3 -c "import socket'));
    },
  );
});

Deno.test("deploy: failure — the start command failing rejects before the probe ever runs (only 1 call made)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 1, stdout: "", stderr: "permission denied" },
    async (calls) => {
      await assertRejects(
        () => run("deploy", {}, ctx),
        Error,
        "SSH command failed",
      );
      assertEquals(
        calls.length,
        1,
        "the probe never runs once the start cmd fails",
      );
    },
  );
  assertEquals(
    written.length,
    0,
    "no serverState written on start-cmd failure",
  );
});

Deno.test("deploy: failure — the port-probe timing out (non-zero exit) rejects; serverState is NOT written", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "777\n", stderr: "" },
      { code: 1, stdout: "", stderr: "tap-server not ready after 3s" },
    ],
    async (calls) => {
      await assertRejects(() => run("deploy", {}, ctx), Error);
      assertEquals(calls.length, 2);
    },
  );
  assertEquals(
    written.length,
    0,
    "no serverState written when the probe fails",
  );
});

// ---------------------------------------------------------------------------
// inject_task
// ---------------------------------------------------------------------------

Deno.test("inject_task: happy path — full args (gitRepoUrl, model, custom effort) all land; writes an action resource", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", {
        prompt: "summarize the repo",
        gitRepoUrl: "https://github.com/example/repo",
        model: "claude-opus-4-8",
        effort: "medium",
      }, ctx);
      assertEquals(calls.length, 1);
    },
  );
  const res = written.find((w) => w.spec === "action")!;
  assertEquals(res.payload.action, "inject_task");
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, "Task injected: summarize the repo");
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("inject_task: omitted gitRepoUrl/model are excluded from the task JSON entirely (not written as empty/null)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", { prompt: "bare task" }, ctx);
      const cmd = calls[0].args[7];
      assert(!cmd.includes("gitRepoUrl"));
      assert(!cmd.includes('"model"'));
      assert(cmd.includes('"effort":"low"'), "effort still defaults to low");
    },
  );
});

Deno.test("inject_task: failure — ssh failure rejects; no action resource written", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host port 22: Connection refused",
    },
    async () => {
      await assertRejects(
        () => run("inject_task", { prompt: "x" }, ctx),
        Error,
        "SSH command failed",
      );
    },
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// collect_result
// ---------------------------------------------------------------------------

Deno.test("collect_result: happy path — default 300s timeout; writes taskResult with the raw stdout", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "the agent's raw stdout\n", stderr: "" },
    async (calls) => {
      await run("collect_result", {}, ctx);
      assert(calls[0].args[7].includes("collect 300"));
    },
  );
  const res = written.find((w) => w.spec === "taskResult")!;
  assertEquals(res.payload.stdout, "the agent's raw stdout\n");
  parseAgainstResourceSchema("taskResult", res.payload);
});

Deno.test("collect_result: custom timeoutSeconds is passed through to the collect command", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "done\n", stderr: "" },
    async (calls) => {
      await run("collect_result", { timeoutSeconds: 900 }, ctx);
      assert(calls[0].args[7].includes("collect 900"));
    },
  );
});

Deno.test("collect_result: failure — a guest-side collect timeout (non-zero exit) rejects; no taskResult written", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 1, stdout: "", stderr: "TimeoutError: no result within 300s" },
    async () => {
      await assertRejects(
        () => run("collect_result", {}, ctx),
        Error,
        "SSH command failed",
      );
    },
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

Deno.test("stop: happy path — writes serverState with status stopped and NO pid field", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "stopped\n", stderr: "" },
    async () => {
      await run("stop", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "serverState")!;
  assertEquals(res.payload.status, "stopped");
  assert(!("pid" in res.payload), "stop's serverState carries no pid field");
  parseAgainstResourceSchema("serverState", res.payload);
});

Deno.test("stop: failure — ssh failure rejects; no serverState written", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 127, stdout: "", stderr: "command not found" },
    async () => {
      await assertRejects(
        () => run("stop", {}, ctx),
        Error,
        "SSH command failed",
      );
    },
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// host-reachable check — both branches
// ---------------------------------------------------------------------------

Deno.test("host-reachable check: pass branch — ssh returns exit 0 and stdout trims to exactly 'ready'", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "ready\n", stderr: "" },
    async () => {
      const res = await runCheck("host-reachable", ctx);
      assertEquals(res.pass, true);
    },
  );
});

Deno.test("host-reachable check: fail branch — a non-zero ssh exit fails with the exit code and stderr in the error message", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host port 22: Connection refused",
    },
    async () => {
      const res = await runCheck("host-reachable", ctx);
      assertEquals(res.pass, false);
      assert(res.errors?.[0].includes("exit 255"));
      assert(res.errors?.[0].includes("Connection refused"));
    },
  );
});

// ---------------------------------------------------------------------------
// OAuth token non-leak — spot check across all 4 methods (the mechanical
// secret-scan over every written resource + every rejected error message
// lives in fc_task_server_adversarial_test.ts)
// ---------------------------------------------------------------------------

Deno.test("OAuth token never appears in any written resource across deploy/inject_task/collect_result/stop", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "42\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async () => {
      await run("deploy", {}, ctx);
    },
  );
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async () => {
      await run("inject_task", { prompt: "x" }, ctx);
    },
  );
  await withCommandStub(
    { code: 0, stdout: "out\n", stderr: "" },
    async () => {
      await run("collect_result", {}, ctx);
    },
  );
  await withCommandStub(
    { code: 0, stdout: "stopped\n", stderr: "" },
    async () => {
      await run("stop", {}, ctx);
    },
  );
  for (const w of written) {
    assert(
      !JSON.stringify(w.payload).includes(OAUTH_TOKEN),
      `${w.spec}/${w.name} must never carry the oauth token`,
    );
  }
});
