// Contract-fixture suite for @magistr/fc-task-server — global/method schema
// validation (incl. the sk-ant token guard and HTTPS-only git URL), the
// pre-flight checks, AND (added for the ext-quality-bf-fc-task-server
// backfill) FakeTime exact-output resource pins for all 4 methods against a
// stubbed `Deno.Command` SSH boundary. These import the REAL model, so a
// behaviour change breaks these tests.
//
// fc_task_server.ts / lib/ssh.ts are BYTE-FROZEN by this change — every test
// here characterizes already-shipped behavior, not new behavior driven out
// by red-green TDD. No real `ssh` binary or network call is ever exercised;
// the `Deno.Command` boundary is stubbed with a scripted result queue (single
// `output()` shape — fc_task_server's ssh helpers call `proc.output()`
// directly, with no `spawn()`/stdin step, unlike the SSH-over-stdin shape
// used by observability-agent/talm-cluster).
//
// Run: deno test extensions/models/fc_task_server_test.ts

import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "jsr:@std/testing@1/time";
import { controlPlanePaths, model } from "./fc_task_server.ts";
import { isValidSshHost } from "./lib/ssh.ts";

const baseArgs = {
  host: "fc.example.com",
  oauthToken: "sk-ant-test-token",
};

// --- globalArguments ---

Deno.test("globalArguments: accepts a host + sk-ant token", () => {
  assertEquals(model.globalArguments.safeParse(baseArgs).success, true);
});

Deno.test("globalArguments: applies user/tapIp/tapPort defaults", () => {
  const parsed = model.globalArguments.parse(baseArgs);
  assertEquals(parsed.user, "root");
  assertEquals(parsed.tapIp, "172.16.0.1");
  assertEquals(parsed.tapPort, 8080);
});

Deno.test("globalArguments: rejects a token without the sk-ant prefix", () => {
  const r = model.globalArguments.safeParse({
    ...baseArgs,
    oauthToken: "csk-ant-corrupted",
  });
  assertFalse(r.success);
});

Deno.test("globalArguments: rejects a tapPort below the privileged range", () => {
  const r = model.globalArguments.safeParse({ ...baseArgs, tapPort: 80 });
  assertFalse(r.success);
});

// --- method argument schemas ---

Deno.test("inject_task: accepts an https git repo URL", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    gitRepoUrl: "https://github.com/example/repo",
  });
  assertEquals(r.success, true);
});

Deno.test("inject_task: accepts an empty git repo URL", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    gitRepoUrl: "",
  });
  assertEquals(r.success, true);
});

Deno.test("inject_task: rejects a non-HTTPS (scp-style) git URL", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    gitRepoUrl: "git@github.com:example/repo.git",
  });
  assertFalse(r.success);
});

Deno.test("inject_task: defaults effort to low", () => {
  const parsed = model.methods.inject_task.arguments.parse({
    prompt: "do the thing",
  });
  assertEquals(parsed.effort, "low");
});

Deno.test("inject_task: accepts an explicit effort level", () => {
  const parsed = model.methods.inject_task.arguments.parse({
    prompt: "do the thing",
    effort: "xhigh",
  });
  assertEquals(parsed.effort, "xhigh");
});

Deno.test("inject_task: rejects an unknown effort level", () => {
  const r = model.methods.inject_task.arguments.safeParse({
    prompt: "do the thing",
    effort: "ultra",
  });
  assertFalse(r.success);
});

Deno.test("collect_result: rejects a timeout below the minimum", () => {
  const r = model.methods.collect_result.arguments.safeParse({
    timeoutSeconds: 5,
  });
  assertFalse(r.success);
});

Deno.test("collect_result: defaults the timeout to 300s", () => {
  const parsed = model.methods.collect_result.arguments.parse({});
  assertEquals(parsed.timeoutSeconds, 300);
});

// --- pre-flight checks ---

Deno.test("valid-ssh-host check: passes for a real host", async () => {
  const res = await model.checks["valid-ssh-host"].execute({
    globalArgs: { ...baseArgs, user: "root" },
  });
  assertEquals(res.pass, true);
});

Deno.test("valid-ssh-host check: fails with an error for an empty host", async () => {
  const res = await model.checks["valid-ssh-host"].execute({
    globalArgs: { ...baseArgs, host: "" },
  });
  assertFalse(res.pass);
  assertEquals(typeof res.errors?.[0], "string");
});

Deno.test("host-reachable check: registered with the live label", () => {
  assertEquals(model.checks["host-reachable"].labels, ["live"]);
});

// --- shared ssh helper ---

Deno.test("isValidSshHost rejects empty and placeholder hosts", () => {
  assertEquals(isValidSshHost("fc.example.com"), true);
  assertFalse(isValidSshHost(""));
  assertFalse(isValidSshHost("null"));
});

// --- per-VM network namespace (netns) ---

Deno.test("globalArguments: accepts an optional netns", () => {
  const r = model.globalArguments.safeParse({
    ...baseArgs,
    netns: "fc-agent-1",
  });
  assertEquals(r.success, true);
});

Deno.test("globalArguments: rejects a netns name with shell metacharacters", () => {
  const r = model.globalArguments.safeParse({
    ...baseArgs,
    netns: "fc; rm -rf /",
  });
  assertFalse(r.success);
});

Deno.test("globalArguments: accepts an empty netns (root-namespace default)", () => {
  const r = model.globalArguments.safeParse({ ...baseArgs, netns: "" });
  assertEquals(r.success, true);
});

// --- control-plane path keying (concurrency safety) ---

Deno.test("controlPlanePaths: no netns keeps port-only keys (single-VM unchanged)", () => {
  const p = controlPlanePaths(8080);
  assertEquals(p.taskPath, "/tmp/fc-task-8080.json");
  assertEquals(p.resultPath, "/tmp/fc-result-8080.txt");
  assertEquals(p.pidFile, "/tmp/fc-tap-server-8080.pid");
  assertEquals(p.serverPath, "/tmp/fc-tap-server-8080.py");
  assertEquals(p.logPath, "/tmp/fc-tap-server-8080.log");
});

Deno.test("controlPlanePaths: netns keys the paths so concurrent VMs don't share /tmp", () => {
  const a = controlPlanePaths(8080, "fc-agent-1");
  const b = controlPlanePaths(8080, "fc-agent-2");
  assertEquals(a.taskPath, "/tmp/fc-task-fc-agent-1-8080.json");
  assertEquals(a.resultPath, "/tmp/fc-result-fc-agent-1-8080.txt");
  // distinct VMs (same guest port 8080) get distinct task/result files
  assertEquals(a.taskPath === b.taskPath, false);
  assertEquals(a.resultPath === b.resultPath, false);
});

Deno.test("controlPlanePaths: empty netns is treated as no-netns", () => {
  assertEquals(controlPlanePaths(8080, "").taskPath, "/tmp/fc-task-8080.json");
});

// ---------------------------------------------------------------------------
// Harness: Deno.Command stub + fake context (shared shape across the whole
// quality suite for this extension). fc-task-server's ssh helpers
// (sshExec/sshExecRaw in lib/ssh.ts) call `new Deno.Command("ssh", {
// args }).output()` directly — no `spawn()`/stdin step — so the stub only
// needs to support `output()`, driven off a per-call result QUEUE (`deploy`
// issues TWO sequential ssh calls: the start command, then the port-probe;
// scripting an array lets a test assert the SECOND call distinctly instead
// of vacuously reusing the first result for both).
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

/** Build a realistic, schema-validated globalArgs object the way swamp
 * itself would (parsed through GlobalArgsSchema before `execute` sees it). */
function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    host: "fc.example.com",
    oauthToken: "sk-ant-test-oauth-token-do-not-leak",
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

/** Validate a written payload against the model's own resource schema — no
 * `any`, per the repo's no-explicit-any lint rule. */
function parseAgainstResourceSchema(spec: string, payload: unknown): unknown {
  return (model.resources as ResourceMap)[spec].schema.parse(payload);
}

const FIXED_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

// ---------------------------------------------------------------------------
// contract: deploy — two sequential ssh calls, exact serverState pin
// ---------------------------------------------------------------------------

Deno.test("contract: deploy — issues exactly 2 ssh calls (start, then port-probe); writes an EXACT serverState pin under FakeTime", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "54321\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      assertEquals(calls.length, 2, "deploy issues exactly 2 ssh calls");
      assertEquals(calls[0].binary, "ssh");
      assertEquals(calls[0].args.slice(0, 6), [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
      ]);
      assertEquals(calls[0].args[6], "root@fc.example.com");
      const startCmd = calls[0].args[7];
      assert(
        startCmd.includes("base64 -d >"),
        "start cmd writes the server via base64",
      );
      assert(
        startCmd.includes("export FC_OAUTH_TOKEN="),
        "start cmd exports the oauth token for the tap-server process",
      );
      assert(
        startCmd.includes("export FC_BIND_IP='172.16.0.1'"),
        "start cmd exports the default tapIp",
      );
      assert(startCmd.includes("export FC_BIND_PORT=8080"));
      // pin: the SECOND call is the port-probe, not a repeat of the first —
      // asserting distinct content here is what catches a vacuous-pass stub.
      const probeCmd = calls[1].args[7];
      assert(probeCmd.includes("python3 -c"), "second call is the port probe");
      assert(probeCmd.includes("s.connect("));
      assert(probeCmd.includes("tap-server not ready after 3s"));
    },
  );
  assertEquals(written.length, 1);
  const res = written[0];
  assertEquals(res.spec, "serverState");
  assertEquals(res.name, "current");
  assertEquals(res.payload, {
    pid: 54321,
    tapIp: "172.16.0.1",
    tapPort: 8080,
    status: "running",
    timestamp: new Date(FIXED_NOW_MS).toISOString(),
  });
  parseAgainstResourceSchema("serverState", res.payload);
});

// ---------------------------------------------------------------------------
// contract: inject_task — exact action pin
// ---------------------------------------------------------------------------

Deno.test("contract: inject_task — full args land in the task JSON; writes an EXACT action pin under FakeTime", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected: /tmp/fc-task-8080.json\n", stderr: "" },
    async (calls) => {
      await run("inject_task", {
        prompt: "do the thing",
        gitRepoUrl: "https://github.com/example/repo",
        model: "claude-opus-4-8",
        effort: "high",
      }, ctx);
      assertEquals(calls.length, 1);
      const cmd = calls[0].args[7];
      assert(cmd.includes(" inject "));
      assert(
        cmd.includes(
          '{"prompt":"do the thing","gitRepoUrl":"https://github.com/example/repo","model":"claude-opus-4-8","effort":"high"}',
        ),
        "the shell-escaped task JSON carries all 4 fields verbatim",
      );
    },
  );
  assertEquals(written.length, 1);
  const res = written[0];
  assertEquals(res.spec, "action");
  assertEquals(res.name, "inject_task");
  assertEquals(res.payload, {
    action: "inject_task",
    success: true,
    message: "Task injected: do the thing",
    timestamp: new Date(FIXED_NOW_MS).toISOString(),
  });
  parseAgainstResourceSchema("action", res.payload);
});

// ---------------------------------------------------------------------------
// contract: collect_result — exact taskResult pin
// ---------------------------------------------------------------------------

Deno.test("contract: collect_result — default 300s timeout; writes an EXACT taskResult pin under FakeTime", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "agent stdout output\n", stderr: "" },
    async (calls) => {
      await run("collect_result", {}, ctx);
      assertEquals(calls.length, 1);
      assert(calls[0].args[7].includes("collect 300"));
    },
  );
  assertEquals(written.length, 1);
  const res = written[0];
  assertEquals(res.spec, "taskResult");
  assertEquals(res.name, "output");
  assertEquals(res.payload, {
    stdout: "agent stdout output\n",
    timestamp: new Date(FIXED_NOW_MS).toISOString(),
  });
  parseAgainstResourceSchema("taskResult", res.payload);
});

// ---------------------------------------------------------------------------
// contract: stop — exact serverState pin (no pid field)
// ---------------------------------------------------------------------------

Deno.test("contract: stop — writes an EXACT serverState pin (status stopped, NO pid field) under FakeTime", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "stopped\n", stderr: "" },
    async (calls) => {
      await run("stop", {}, ctx);
      assertEquals(calls.length, 1);
    },
  );
  assertEquals(written.length, 1);
  const res = written[0];
  assertEquals(res.spec, "serverState");
  assertEquals(res.name, "current");
  assertEquals(Object.keys(res.payload).sort(), [
    "status",
    "tapIp",
    "tapPort",
    "timestamp",
  ]);
  assertEquals(res.payload, {
    tapIp: "172.16.0.1",
    tapPort: 8080,
    status: "stopped",
    timestamp: new Date(FIXED_NOW_MS).toISOString(),
  });
  parseAgainstResourceSchema("serverState", res.payload);
});
