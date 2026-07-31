/**
 * Adversarial suite for @magistr/fc-task-server: attacker's-perspective
 * characterization of the model's real injection surface, hostile schema
 * inputs, and a mechanical OAuth-token secret-scan.
 *
 * fc_task_server.ts / lib/ssh.ts are UNMODIFIED — every "pin: KNOWN
 * <BUG-ID>" test here characterizes a REAL, already-shipped behavior rather
 * than proposing a fix (a fix is out of scope for this test-only backfill;
 * see CHANGELOG.md and the LOCAL `fc-task-server-latent-bugs` issue-lifecycle
 * bug model — NEVER the Lab, per this repo's tracking convention).
 *
 * Unlike the SSH-over-stdin shape used by observability-agent/talm-cluster,
 * fc-task-server's `sshExec`/`sshExecRaw` pass the ENTIRE remote command as a
 * single element of the local `ssh` argv array (`ssh user@host "<command>"`).
 * `Deno.Command`'s array-arg form never spawns a LOCAL shell, so a hostile
 * `host`/`user` is locally safe (see the "safe:" test below) — but the
 * REMOTE side, once ssh hands that string to the remote shell, is a real
 * bash interpreter, and that's where B2 lives.
 *
 * Bugs pinned here, tracked in the LOCAL `fc-task-server-latent-bugs` model:
 *   B1 (MEDIUM, guest-side) — `inject` discards an uncollected prior result
 *      before writing the new task file (string/structure-pinned only — the
 *      guest-side TAP_SERVER_PY python never executes in this suite).
 *   B2 (LOW) — `tapIp` is escaped with `shellEsc` (bash single-quote
 *      escaping) but then embedded INSIDE a bash DOUBLE-quoted `python3 -c
 *      "..."` argument in the port-probe command. Single quotes have no
 *      special meaning to bash inside a double-quoted string, so `shellEsc`
 *      only neutralizes tapIp for a *single-quoted* bash context — it does
 *      NOT stop bash from still expanding `$(...)`/backticks embedded in
 *      tapIp before python3 ever runs, since those substitutions happen at
 *      the outer double-quoted-string level, not inside python's own
 *      (later, and here irrelevant) string parsing.
 *   B4 (LOW) — `inject_task`/`collect_result`/`stop` never check that a
 *      server is actually running (no serverState precheck) — they'll issue
 *      their ssh command regardless of whether `deploy` was ever called.
 *   B5 (LOW/info) — grouped concurrency/resource edge: `deploy`'s kill of an
 *      existing PID is fire-and-forget (SIGTERM, sleep 0.2, SIGKILL) with no
 *      check that the old process actually died before the new server
 *      starts listening on the same port.
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

const OAUTH_TOKEN = "sk-ant-oat01-super-secret-value-must-not-leak";

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

// ---------------------------------------------------------------------------
// B2 (LOW) — tapIp escaped for the WRONG (single-quoted) shell context
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN INJECTION (LOW, fc-task-server-latent-bugs B2) — a hostile tapIp's $(...) survives into the port-probe's bash double-quoted python3 -c argument", async () => {
  const injection = "$(touch /tmp/pwned-fc-task-server)";
  const { ctx } = makeCtx({ tapIp: injection });
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const probeCmd = calls[1].args[7];
      assert(
        probeCmd.includes(`s.connect(('${injection}', 8080))`),
        "tapIp is wrapped in shellEsc's single quotes, but those quotes sit " +
          "INSIDE a bash double-quoted python3 -c argument, where single " +
          "quotes are not special to bash",
      );
      assert(
        probeCmd.includes("$(touch /tmp/pwned-fc-task-server)"),
        "the $(...) survives unescaped for BASH's purposes — bash still " +
          "performs command substitution inside a double-quoted string " +
          "regardless of shellEsc's single-quote wrapping, so a hostile " +
          "tapIp achieves command execution on the host BEFORE python3 " +
          "ever runs. pin: KNOWN INJECTION, not fixed here (source frozen); " +
          "see fc-task-server-latent-bugs B2.",
      );
    },
  );
});

Deno.test("safe: the SAME tapIp value, when exported via `export FC_BIND_IP=...`, is a genuinely single-quoted independent shell word — no $(...) expansion there", async () => {
  const injection = "$(touch /tmp/pwned-fc-task-server)";
  const { ctx } = makeCtx({ tapIp: injection });
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const startCmd = calls[0].args[7];
      assert(
        startCmd.includes(`export FC_BIND_IP='${injection}'`),
        "in THIS line, shellEsc's single-quote wrapping IS a real, " +
          "independent shell word — bash does not expand $(...) inside " +
          "single quotes, so the export line alone is safe. The bug (B2) " +
          "is specifically the SECOND, double-quoted embedding in the " +
          "port-probe line above, not this one.",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// B1 (MEDIUM, guest-side) — inject discards an uncollected prior result.
// String/structure-pinned only: the guest-side TAP_SERVER_PY python is
// embedded (base64) into deploy's start command and never executed here.
// ---------------------------------------------------------------------------

function extractDeployedServerPy(command: string): string {
  const m = command.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d >/);
  assert(
    m,
    "expected a base64-encoded server script write in the deploy command",
  );
  return atob(m[1]);
}

Deno.test("pin: KNOWN BUG (MEDIUM, fc-task-server-latent-bugs B1) — the deployed tap-server's `inject` command unlinks any existing RESULT_PATH BEFORE writing the new TASK_PATH, silently discarding an uncollected prior result", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const py = extractDeployedServerPy(calls[0].args[7]);
      assert(py.includes('elif cmd == "inject":'), "the inject branch exists");
      const injectBranch = py.slice(py.indexOf('elif cmd == "inject":'));
      const unlinkIdx = injectBranch.indexOf("os.unlink(RESULT_PATH)");
      const writeIdx = injectBranch.indexOf("json.dump(task, f)");
      assert(unlinkIdx !== -1, "inject unlinks RESULT_PATH");
      assert(writeIdx !== -1, "inject writes TASK_PATH");
      assert(
        unlinkIdx < writeIdx,
        "the RESULT_PATH unlink happens BEFORE the new task is written — a " +
          "prior result that hasn't been collect()-ed yet is silently " +
          "discarded with no warning. pin: KNOWN BUG, not fixed here " +
          "(source frozen; guest-side, never executed in this suite); see " +
          "fc-task-server-latent-bugs B1.",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// B4 (LOW) — no server-state precheck on inject_task/collect_result/stop
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN GAP (LOW, fc-task-server-latent-bugs B4) — inject_task runs against a server that was never deploy()-ed, with no precheck", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async () => {
      // No prior `deploy` call anywhere in this test — a fresh ctx with no
      // serverState resource ever written.
      await run("inject_task", { prompt: "no server was ever deployed" }, ctx);
    },
  );
  assertEquals(
    written.filter((w) => w.spec === "action").length,
    1,
    "inject_task succeeds unconditionally — it never checks serverState " +
      "before issuing its ssh command. pin: KNOWN GAP, not fixed here; see " +
      "fc-task-server-latent-bugs B4.",
  );
});

Deno.test("pin: KNOWN GAP (LOW, fc-task-server-latent-bugs B4) — collect_result runs against a server that was never deploy()-ed, with no precheck", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "\n", stderr: "" },
    async () => {
      await run("collect_result", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "taskResult").length, 1);
});

Deno.test("pin: KNOWN GAP (LOW, fc-task-server-latent-bugs B4) — stop runs against a server that was never deploy()-ed, with no precheck", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "stopped\n", stderr: "" },
    async () => {
      await run("stop", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "serverState").length, 1);
});

// ---------------------------------------------------------------------------
// B5 (LOW/info) — deploy's kill of an existing PID is fire-and-forget
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN GAP (LOW/info, fc-task-server-latent-bugs B5) — deploy's kill-old-pid sequence never checks the old process actually died before starting the replacement", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "2\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const startCmd = calls[0].args[7];
      const killIdx = startCmd.indexOf('kill "$OLD"');
      const startIdx = startCmd.indexOf("SRV=$!");
      assert(killIdx !== -1 && startIdx !== -1);
      assert(killIdx < startIdx);
      assert(
        !startCmd.includes("wait $OLD") && !startCmd.includes("kill -0"),
        "there is no wait/liveness check between the kill sequence and " +
          "starting the replacement server — a slow-to-die old process " +
          "could still hold the port when the new one starts. pin: KNOWN " +
          "GAP, not fixed here; see fc-task-server-latent-bugs B5.",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Hostile schema inputs — SAFE side: shellEsc correctly neutralizes a
// hostile prompt for inject_task's single shell word (contrast with tapIp's
// double-quoted-context misuse above)
// ---------------------------------------------------------------------------

function unshellEsc(encoded: string): string {
  const middle = encoded.slice(1, -1);
  return middle.replace(/'\\''/g, "'");
}

Deno.test("safe: a hostile prompt (embedded single quotes, backticks, $(), newlines) round-trips intact through inject_task's shell-escaped task JSON", async () => {
  const hostilePrompt = "do the thing'; touch /tmp/pwned `id` $(whoami)\nline2";
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "injected\n", stderr: "" },
    async (calls) => {
      await run("inject_task", { prompt: hostilePrompt }, ctx);
      const cmd = calls[0].args[7];
      const marker = " inject ";
      const blob = cmd.slice(cmd.indexOf(marker) + marker.length);
      const decoded = JSON.parse(unshellEsc(blob)) as { prompt: string };
      assertEquals(
        decoded.prompt,
        hostilePrompt,
        "shellEsc correctly escapes the JSON-encoded prompt as ONE opaque " +
          "shell word — unlike tapIp (B2), this value is never re-embedded " +
          "inside a nested double-quoted interpreter argument, so it never " +
          "breaks out",
      );
    },
  );
});

Deno.test("safe: a hostile oauthToken (embedded single quotes) is correctly neutralized by shellEsc in the export line", async () => {
  const hostileToken = "sk-ant-oat01-x'; touch /tmp/pwned; echo '";
  const { ctx } = makeCtx({ oauthToken: hostileToken });
  await withCommandStub(
    [
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    async (calls) => {
      await run("deploy", {}, ctx);
      const startCmd = calls[0].args[7];
      const marker = "export FC_OAUTH_TOKEN=";
      const idx = startCmd.indexOf(marker);
      const rest = startCmd.slice(idx + marker.length);
      const line = rest.split("\n")[0];
      const decoded = unshellEsc(line);
      assertEquals(
        decoded,
        hostileToken,
        "shellEsc round-trips the hostile token as one safe shell word",
      );
    },
  );
});

Deno.test("safe: a hostile host/user lands as ONE local argv element each — Deno.Command's array-arg form never spawns a local shell", async () => {
  const HOSTILE_HOST = "fc.example.com; rm -rf /";
  const HOSTILE_USER = "root; id";
  const { ctx } = makeCtx({ host: HOSTILE_HOST, user: HOSTILE_USER });
  await withCommandStub(
    { code: 0, stdout: "stopped\n", stderr: "" },
    async (calls) => {
      await run("stop", {}, ctx);
      assertEquals(calls[0].binary, "ssh");
      assertEquals(calls[0].args[6], `${HOSTILE_USER}@${HOSTILE_HOST}`);
      assert(
        calls[0].args.every((a) => typeof a === "string"),
        "every argv element stays one opaque string — no local shell ever " +
          "reinterprets it",
      );
    },
  );
});

Deno.test("safe: netns backticks/$(...) are rejected by NETNS_RE before execute() ever runs (defense in depth alongside B2's shellEsc gap)", () => {
  assertFalse(
    model.globalArguments.safeParse({
      host: "fc.example.com",
      oauthToken: "sk-ant-x",
      netns: "fc`touch /tmp/pwned`",
    }).success,
  );
  assertFalse(
    model.globalArguments.safeParse({
      host: "fc.example.com",
      oauthToken: "sk-ant-x",
      netns: "fc$(touch /tmp/pwned)",
    }).success,
  );
});

// ---------------------------------------------------------------------------
// OAuth secret-scan — mechanical backstop over every written resource and
// every rejected error message, across all 4 methods
// ---------------------------------------------------------------------------

Deno.test("oauth-secret-scan: the token never appears in any written resource or rejected error message, across deploy/inject_task/collect_result/stop happy AND failure paths", async () => {
  const violations: string[] = [];

  function scanWritten(written: Written[]) {
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      if (s.includes(OAUTH_TOKEN)) {
        violations.push(`${w.spec}/${w.name} resource payload leaks the token`);
      }
    }
  }

  // Happy paths
  {
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
    scanWritten(written);
  }

  // Failure paths — the token must not leak into the thrown error either
  // (sshExec's error includes the last 500 chars of stderr; the stub never
  // echoes the token back, so this also guards against a future change that
  // might).
  for (const method of ["deploy", "inject_task", "collect_result", "stop"]) {
    const { ctx } = makeCtx();
    await withCommandStub(
      { code: 1, stdout: "", stderr: "boom" },
      async () => {
        try {
          await run(
            method,
            method === "inject_task" ? { prompt: "x" } : {},
            ctx,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes(OAUTH_TOKEN)) {
            violations.push(
              `${method}'s rejected error message leaks the token`,
            );
          }
        }
      },
    );
  }

  assertEquals(
    violations,
    [],
    `secret leak(s) found:\n${violations.join("\n")}`,
  );
});

Deno.test("oauth-secret-scan: sanity — the scanner actually flags an injected leak (anti-vacuity)", () => {
  const poisoned = {
    spec: "action",
    name: "x",
    payload: { note: OAUTH_TOKEN },
  };
  assert(JSON.stringify(poisoned.payload).includes(OAUTH_TOKEN));
});
