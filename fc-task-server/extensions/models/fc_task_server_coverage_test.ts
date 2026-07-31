/**
 * Coverage suite for @magistr/fc-task-server: regression guards for behavior
 * NOT already pinned by the contract-fixture, methods, or adversarial suites
 * — both sides of every guard (STANDARD.md's coverage role: "if someone
 * deletes this guard, does a test go red?").
 *
 * Specifically owns (not duplicated elsewhere):
 *  - `netns` set/unset branch sweep across ALL 4 methods — the `ip netns
 *    exec` prefix and the netns-KEYED control-plane paths actually land in
 *    the generated ssh commands (the unit-level `controlPlanePaths()` tests
 *    in fc_task_server_test.ts only exercise the helper directly, never
 *    that the 4 methods actually route through it).
 *  - `inject_task`'s gitRepoUrl-only-set / model-only-set truth-table cells
 *    (gitRepoUrl+model together is pinned in the contract suite; both
 *    omitted is pinned in the methods suite — this suite closes the two
 *    remaining one-set/one-unset combinations).
 *  - `inject_task`'s full `effort` enum sweep (low/medium/high/xhigh/max)
 *    round-trips into the task JSON.
 *  - B3 (LOW, fc-task-server-latent-bugs) — `deploy`'s
 *    `parseInt(result.stdout.trim(), 10)` yields `NaN` when the first ssh
 *    call's stdout is noisy (a leading non-digit character defeats
 *    `parseInt`), and `deploy` still writes that `NaN` into `serverState`
 *    rather than failing loudly.
 *  - `host-reachable`'s stdout-MISMATCH failure branch (exit 0 but the
 *    trimmed stdout isn't exactly "ready") — distinct from the non-zero-exit
 *    failure branch already pinned in the methods suite.
 *  - Every method's written resource re-validated against its OWN
 *    `model.resources.<spec>.schema` (schema-drift regression guard).
 *  - `GlobalArgsSchema` rejects a missing `host` — the one truly required
 *    field (every other field is `.default(...)` or `.optional()`).
 *
 * fc_task_server.ts / lib/ssh.ts are UNMODIFIED — every test here PINS
 * existing behavior.
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { model } from "./fc_task_server.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
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

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    host: "fc.example.com",
    oauthToken: "sk-ant-test-token",
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
// netns branch sweep — all 4 methods, set vs unset
// ---------------------------------------------------------------------------

Deno.test("deploy: netns SET — the start cmd and probe cmd are both prefixed with `ip netns exec <netns>`, and paths are netns-keyed", async () => {
  const { ctx } = makeCtx({ netns: "fc-agent-1" });
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const startCmd = calls[0].args[7];
      const probeCmd = calls[1].args[7];
      assert(startCmd.includes("ip netns exec 'fc-agent-1' python3"));
      assert(probeCmd.includes("ip netns exec 'fc-agent-1' python3"));
      assert(startCmd.includes("/tmp/fc-tap-server-fc-agent-1-8080.py"));
    },
  );
});

Deno.test("deploy: netns UNSET — no `ip netns exec` prefix, and paths stay port-only", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const startCmd = calls[0].args[7];
      assert(!startCmd.includes("ip netns exec"));
      assert(startCmd.includes("/tmp/fc-tap-server-8080.py"));
    },
  );
});

Deno.test("inject_task: netns SET — the inject command references the netns-keyed task/result paths", async () => {
  const { ctx } = makeCtx({ netns: "fc-agent-2" });
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", { prompt: "x" }, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes("/tmp/fc-task-fc-agent-2-8080.json"));
      assert(cmd.includes("/tmp/fc-result-fc-agent-2-8080.txt"));
      assert(cmd.includes("/tmp/fc-tap-server-fc-agent-2-8080.py"));
    },
  );
});

Deno.test("collect_result: netns SET — the collect command references the netns-keyed result path", async () => {
  const { ctx } = makeCtx({ netns: "fc-agent-3" });
  await withCommandStub(
    { code: 0, stdout: "out\n", stderr: "" },
    async (calls) => {
      await run("collect_result", {}, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes("/tmp/fc-result-fc-agent-3-8080.txt"));
    },
  );
});

Deno.test("stop: netns SET — the stop command targets the netns-keyed pidFile/serverPath", async () => {
  const { ctx } = makeCtx({ netns: "fc-agent-4" });
  await withCommandStub(
    { code: 0, stdout: "stopped\n", stderr: "" },
    async (calls) => {
      await run("stop", {}, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes("/tmp/fc-tap-server-fc-agent-4-8080.pid"));
      assert(cmd.includes("/tmp/fc-tap-server-fc-agent-4-8080.py"));
    },
  );
});

// ---------------------------------------------------------------------------
// inject_task — gitRepoUrl-only / model-only truth-table cells
// ---------------------------------------------------------------------------

Deno.test("inject_task: gitRepoUrl set, model UNSET — gitRepoUrl lands, model key absent", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", {
        prompt: "x",
        gitRepoUrl: "https://github.com/example/repo",
      }, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes('"gitRepoUrl":"https://github.com/example/repo"'));
      assert(!cmd.includes('"model"'));
    },
  );
});

Deno.test("inject_task: model set, gitRepoUrl UNSET — model lands, gitRepoUrl key absent", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", { prompt: "x", model: "claude-haiku-4-5" }, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes('"model":"claude-haiku-4-5"'));
      assert(!cmd.includes("gitRepoUrl"));
    },
  );
});

Deno.test('inject_task: an empty-string gitRepoUrl is treated as UNSET (falsy) — key excluded, not written as ""', async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", { prompt: "x", gitRepoUrl: "" }, ctx);
      const cmd = calls[0].args[7];
      assert(!cmd.includes("gitRepoUrl"));
    },
  );
});

// ---------------------------------------------------------------------------
// inject_task — full effort enum sweep
// ---------------------------------------------------------------------------

Deno.test("inject_task: every effort enum value (low/medium/high/xhigh/max) round-trips into the task JSON", async () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const { ctx } = makeCtx();
    await withCommandStub(
      { code: 0, stdout: "injected\n", stderr: "" },
      async (calls) => {
        await run("inject_task", { prompt: "x", effort }, ctx);
        assert(calls[0].args[7].includes(`"effort":"${effort}"`));
      },
    );
  }
});

// ---------------------------------------------------------------------------
// B3 (LOW) — NaN pid on noisy first-call stdout
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN BUG (LOW, fc-task-server-latent-bugs B3) — a leading non-digit line in the start command's stdout defeats parseInt and writes NaN as the pid", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "Warning: locale not set\n54321", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async () => {
      await run("deploy", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "serverState")!;
  assert(
    Number.isNaN(res.payload.pid),
    "parseInt('Warning: locale not set\\n54321', 10) is NaN — deploy still " +
      "writes it into serverState.pid with no validation. pin: KNOWN BUG, " +
      "not fixed here; see fc-task-server-latent-bugs B3.",
  );
});

Deno.test("pin: KNOWN BUG (LOW, fc-task-server-latent-bugs B3) — completely empty stdout also yields NaN", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async () => {
      await run("deploy", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "serverState")!;
  assert(Number.isNaN(res.payload.pid));
});

// ---------------------------------------------------------------------------
// host-reachable — stdout-MISMATCH branch (exit 0, but not exactly "ready")
// ---------------------------------------------------------------------------

Deno.test("host-reachable check: exit 0 but stdout trims to something other than 'ready' still fails (distinct branch from a non-zero exit)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "ready-ish\n", stderr: "" },
    async () => {
      const res = await runCheck("host-reachable", ctx);
      assertEquals(res.pass, false);
      assert(res.errors?.[0].includes("exit 0"));
    },
  );
});

Deno.test("host-reachable check: an invalid (empty) host short-circuits before any ssh call is made", async () => {
  const { ctx } = makeCtx({ host: "" });
  const res = await runCheck("host-reachable", ctx);
  assertEquals(res.pass, false);
  assertEquals(res.errors, ["globalArgs.host is not set"]);
});

// ---------------------------------------------------------------------------
// Resource schema conformance — every method's happy-path payload validates
// against its OWN declared zod schema
// ---------------------------------------------------------------------------

Deno.test("every method's written resource re-validates against model.resources.<spec>.schema", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
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
  assertEquals(written.length, 4);
  for (const w of written) {
    parseAgainstResourceSchema(w.spec, w.payload);
  }
});

// ---------------------------------------------------------------------------
// GlobalArgsSchema — host is the one truly REQUIRED field
// ---------------------------------------------------------------------------

Deno.test("GlobalArgsSchema: omitting host entirely is rejected — the only field with neither a default nor .optional()", () => {
  assertFalse(
    model.globalArguments.safeParse({ oauthToken: "sk-ant-x" }).success,
  );
  assertFalse(
    model.globalArguments.safeParse({ user: "root", oauthToken: "sk-ant-x" })
      .success,
  );
});

Deno.test("GlobalArgsSchema: omitting oauthToken entirely is rejected — the other truly required field", () => {
  assertFalse(
    model.globalArguments.safeParse({ host: "fc.example.com" }).success,
  );
});
