/**
 * Property-based tests (fast-check) for @magistr/fc-task-server.
 *
 * fc_task_server.ts / lib/ssh.ts are UNMODIFIED — every property here is
 * observed either by calling the exported `controlPlanePaths()` helper
 * directly, or by driving `model.methods.<m>.execute()` against a stubbed
 * `globalThis.Deno.Command` and reading back the captured argv / written
 * resource. Named invariants:
 *
 *  (a) controlPlanePaths key INJECTIVITY (POSITIVE property) — distinct
 *      (tapPort, netns) pairs (after normalizing "" and undefined netns to
 *      the same "no netns" case) always produce distinct path sets, and
 *      identical inputs are deterministic. This is the property that makes
 *      the 2026.06.11.3 netns-keying fix (CHANGELOG.md) sound: two
 *      concurrent VMs never collide on one host's /tmp control-plane files.
 *  (b) inject_task's task-JSON round-trip — for arbitrary safe `prompt` /
 *      `gitRepoUrl` / `model` / `effort` combinations, the shell-escaped
 *      JSON blob captured in the generated ssh command decodes back to
 *      EXACTLY the input fields (prompt/effort always present; gitRepoUrl/
 *      model present iff truthy).
 *
 * Property iteration count is overridable via FC_NUM_RUNS (small by default
 * here, large in `deno task test:soak`).
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { controlPlanePaths, model } from "./fc_task_server.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

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
  result: CommandResult,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  // deno-lint-ignore no-explicit-any
  const original = (globalThis as any).Deno.Command;

  class FakeCommand {
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      calls.push({
        binary,
        args: (opts.args as string[] | undefined) ?? [],
      });
    }
    output() {
      return Promise.resolve(encodeOutput(result));
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

/** Inverse of fc_task_server.ts's private `shellEsc`: a value shell-escaped
 * as `'<content with every internal ' replaced by '\''>'`. Assumes the
 * standard POSIX single-quote-escaping technique fc_task_server.ts uses
 * (verified by reading lib/ssh.ts's caller — see fc_task_server.ts's
 * `shellEsc`). */
function unshellEsc(encoded: string): string {
  const middle = encoded.slice(1, -1);
  return middle.replace(/'\\''/g, "'");
}

function extractInjectedTaskJson(command: string): unknown {
  const marker = " inject ";
  const idx = command.indexOf(marker);
  assert(
    idx !== -1,
    "expected an ' inject ' invocation in the captured command",
  );
  const blob = command.slice(idx + marker.length);
  return JSON.parse(unshellEsc(blob));
}

// ---------------------------------------------------------------------------
// (a) controlPlanePaths key injectivity
// ---------------------------------------------------------------------------

const arbTapPort = fc.integer({ min: 1024, max: 65535 });
const arbNetns = fc.option(
  fc.stringMatching(/^[a-zA-Z0-9_.-]{1,32}$/),
  { nil: undefined },
);

function pathTuple(
  tapPort: number,
  netns: string | undefined,
): string[] {
  const p = controlPlanePaths(tapPort, netns);
  return [p.serverPath, p.pidFile, p.taskPath, p.resultPath, p.logPath];
}

/** Normalizes "" and undefined to the same "no netns" bucket, matching
 * controlPlanePaths' own `netns ? ... : ...` falsy check. */
function normalizedKey(tapPort: number, netns: string | undefined): string {
  return netns ? `${netns}-${tapPort}` : `${tapPort}`;
}

Deno.test("property: controlPlanePaths is deterministic — identical (tapPort, netns) always produce identical paths", () => {
  fc.assert(
    fc.property(arbTapPort, arbNetns, (tapPort, netns) => {
      const a = pathTuple(tapPort, netns);
      const b = pathTuple(tapPort, netns);
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    FC_RUNS,
  );
});

Deno.test("property: controlPlanePaths key is INJECTIVE — distinct (tapPort, netns) normalized keys never collide, identical keys always produce identical paths", () => {
  fc.assert(
    fc.property(
      arbTapPort,
      arbNetns,
      arbTapPort,
      arbNetns,
      (portA, netnsA, portB, netnsB) => {
        const keyA = normalizedKey(portA, netnsA);
        const keyB = normalizedKey(portB, netnsB);
        const pathsA = pathTuple(portA, netnsA);
        const pathsB = pathTuple(portB, netnsB);
        const pathsEqual = JSON.stringify(pathsA) === JSON.stringify(pathsB);
        return keyA === keyB ? pathsEqual : !pathsEqual;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: empty-string netns and undefined netns are the SAME key (both normalize to port-only)", () => {
  fc.assert(
    fc.property(arbTapPort, (tapPort) => {
      const withEmpty = pathTuple(tapPort, "");
      const withUndefined = pathTuple(tapPort, undefined);
      return JSON.stringify(withEmpty) === JSON.stringify(withUndefined);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) inject_task's task-JSON round-trip
// ---------------------------------------------------------------------------

const arbPrompt = fc.string({ minLength: 1, maxLength: 40 });
const arbEffort = fc.constantFrom(
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
) as fc.Arbitrary<"low" | "medium" | "high" | "xhigh" | "max">;
const arbGitRepoUrl = fc.option(
  fc.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/).map((s) =>
    `https://github.com/example/${s}`
  ),
  { nil: undefined },
);
const arbModel = fc.option(
  fc.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/),
  { nil: undefined },
);

async function injectAndCapture(
  args: {
    prompt: string;
    gitRepoUrl?: string;
    model?: string;
    effort: string;
  },
): Promise<Record<string, unknown>> {
  const { ctx } = makeCtx();
  let parsed: Record<string, unknown> = {};
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", args, ctx);
      parsed = extractInjectedTaskJson(calls[0].args[7]) as Record<
        string,
        unknown
      >;
    },
  );
  return parsed;
}

Deno.test("property: inject_task's task JSON round-trips prompt/effort exactly, and gitRepoUrl/model iff truthy", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbPrompt,
      arbGitRepoUrl,
      arbModel,
      arbEffort,
      async (prompt, gitRepoUrl, modelId, effort) => {
        const parsed = await injectAndCapture({
          prompt,
          ...(gitRepoUrl !== undefined ? { gitRepoUrl } : {}),
          ...(modelId !== undefined ? { model: modelId } : {}),
          effort,
        });
        const promptOk = parsed.prompt === prompt;
        const effortOk = parsed.effort === effort;
        const gitRepoOk = gitRepoUrl
          ? parsed.gitRepoUrl === gitRepoUrl
          : !("gitRepoUrl" in parsed);
        const modelOk = modelId
          ? parsed.model === modelId
          : !("model" in parsed);
        return promptOk && effortOk && gitRepoOk && modelOk;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: inject_task's task JSON extraction is injective in prompt — distinct prompts never decode to the same value (round-trip corollary)", async () => {
  await fc.assert(
    fc.asyncProperty(arbPrompt, arbPrompt, arbEffort, async (a, b, effort) => {
      const parsedA = await injectAndCapture({ prompt: a, effort });
      const parsedB = await injectAndCapture({ prompt: b, effort });
      return a === b
        ? parsedA.prompt === parsedB.prompt
        : parsedA.prompt !== parsedB.prompt;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// unshellEsc self-check — proves the test helper correctly inverts the
// production shellEsc algorithm before trusting it above (anti-vacuity)
// ---------------------------------------------------------------------------

Deno.test("sanity: unshellEsc correctly inverts shellEsc's single-quote escaping for arbitrary strings", () => {
  function shellEsc(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }), (s) => {
      return unshellEsc(shellEsc(s)) === s;
    }),
    FC_RUNS,
  );
});

Deno.test("sanity: unshellEsc round-trip works even when the value contains an embedded single quote", () => {
  function shellEsc(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  const tricky = "a'b'c";
  assertEquals(unshellEsc(shellEsc(tricky)), tricky);
});
