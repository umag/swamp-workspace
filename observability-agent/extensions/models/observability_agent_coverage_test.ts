/**
 * Coverage suite for @magistr/observability/agent: regression guards for
 * behavior NOT already pinned by the contract-fixture, methods, or
 * adversarial suites — both sides of every guard (STANDARD.md's coverage
 * role: "if someone deletes this guard, does a test go red?").
 *
 * Specifically owns (not duplicated elsewhere):
 *  - `bindWaitUnit` set/unset -> `bootDropin`'s After=/Wants= lines present
 *    or absent.
 *  - `hostLabel` UNSET -> the VRL `.host = "..."` line defaults to sshHost
 *    (the SET side, plus its injection characterization, lives in the
 *    adversarial suite).
 *  - `sshScript`'s OWN `g.sshPort ?? 22` / `g.sshUser ?? "root"` fallback —
 *    exercised with a globalArgs object that genuinely omits the keys
 *    (bypassing `GlobalArgsSchema`'s own `.default(...)`, which every other
 *    suite goes through via `model.globalArguments.parse`), so THIS guard
 *    specifically has its own red/green signal.
 *  - `parseKv` edges: no `=` in a line, a LEADING `=` (empty key, ignored
 *    since the guard requires `i > 0`), and `a=b=c` keeping the later `=`
 *    in the value.
 *  - `install`'s "unknown" fallback, once per missing key (NODE/BLACKBOX/
 *    VECTOR each individually absent from stdout).
 *  - `status`'s `lst.*` listener booleans when the key is MISSING entirely
 *    from stdout (not just explicitly "fail") — `undefined === "ok"` is
 *    `false` via a different path than an explicit non-"ok" value.
 *  - `configure`'s fail-loud guard: a service value that is neither
 *    "active" nor "skipped" (e.g. a real systemd transitional state) still
 *    throws, and MULTIPLE bad services join into one message.
 *  - `inventory`'s listener-line regex (match vs no-match, short rows) and
 *    the `ps` line regex (well-formed vs malformed rows).
 *  - `GlobalArgsSchema` rejects a missing `sshHost` — the one truly
 *    required field in the whole schema (every other field is `.default(...)`
 *    or `.optional()`).
 *
 * observability_agent.ts is UNMODIFIED — every test here PINS existing
 * behavior. The `Deno.Command` boundary is stubbed (talm-cluster dual-shape
 * stub).
 *
 * NOTE on this file's `makeCtx` signature: unlike the other four suites
 * (which take raw globalArgs OVERRIDES and call `gArgs(overrides)`
 * internally), this file's `makeCtx` takes an ALREADY-BUILT globalArgs
 * object. This is deliberate, not an oversight: the `sshScript`
 * `?? 22`/`?? "root"` fallback test below needs to hand `execute()` a
 * globalArgs object that genuinely OMITS `sshPort`/`sshUser` — bypassing
 * `GlobalArgsSchema`'s own `.default(...)`, which every `gArgs()` call
 * already applies. A `makeCtx(overrides)`-shaped signature could never
 * express that case.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./observability_agent.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    sshHost: "host.example",
    ...overrides,
  }) as Record<string, unknown>;
}

function makeCtx(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
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

function extractRemoteFile(script: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `echo '([A-Za-z0-9+/=]+)' \\| base64 -d > '${escapedPath}'`,
  );
  const m = script.match(re);
  assert(m, `expected a base64 write to ${path} in the captured script`);
  return atob(m[1]);
}

// ---------------------------------------------------------------------------
// bindWaitUnit — both sides of bootDropin's After=/Wants= lines
// ---------------------------------------------------------------------------

Deno.test("configure: bindWaitUnit SET — bootDropin's 10-boot.conf carries After=/Wants= lines for the wait unit", async () => {
  const { ctx } = makeCtx(gArgs({ bindWaitUnit: "wg-quick@wg0.service" }));
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const unit = extractRemoteFile(
        calls[0].stdin,
        "/etc/systemd/system/prometheus-node-exporter.service.d/10-boot.conf",
      );
      assert(unit.includes("After=wg-quick@wg0.service network-online.target"));
      assert(
        unit.includes("Wants=wg-quick@wg0.service network-online.target"),
      );
      assert(unit.includes("StartLimitIntervalSec=0"));
    },
  );
});

Deno.test("configure: bindWaitUnit UNSET — bootDropin's 10-boot.conf has NO After=/Wants= lines", async () => {
  const { ctx } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const unit = extractRemoteFile(
        calls[0].stdin,
        "/etc/systemd/system/prometheus-node-exporter.service.d/10-boot.conf",
      );
      assert(!unit.includes("After="));
      assert(!unit.includes("Wants="));
      assertEquals(
        unit,
        "[Unit]\nStartLimitIntervalSec=0\n[Service]\nRestart=on-failure\nRestartSec=5\n",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// hostLabel UNSET — VRL .host defaults to sshHost
// ---------------------------------------------------------------------------

Deno.test("configure: hostLabel UNSET — vector.yaml's .host VRL line defaults to sshHost", async () => {
  const { ctx } = makeCtx(gArgs({
    sshHost: "target.example",
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
  }));
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      const yaml = extractRemoteFile(calls[0].stdin, "/etc/vector/vector.yaml");
      assert(yaml.includes('.host = "target.example"'));
    },
  );
});

// ---------------------------------------------------------------------------
// sshScript's OWN `?? 22` / `?? "root"` fallback — a globalArgs object that
// genuinely OMITS the keys (not merely relying on zod's schema default,
// which every other suite exercises via model.globalArguments.parse).
// ---------------------------------------------------------------------------

Deno.test("sshScript: sshPort/sshUser fall back to 22/root even when globalArgs omits the keys entirely (not just zod-defaulted)", async () => {
  const { ctx } = makeCtx({ sshHost: "host.example" });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=1.7.0\nBLACKBOX=0.25.0\nVECTOR=0.46.1\n",
      stderr: "",
    },
    async (calls) => {
      await run("install", {}, ctx);
      assertEquals(calls[0].args[7], "22");
      assertEquals(calls[0].args[8], "root@host.example");
    },
  );
});

// ---------------------------------------------------------------------------
// GlobalArgsSchema — sshHost is the one truly REQUIRED field (every other
// field has a `.default(...)` or is `.optional()`)
// ---------------------------------------------------------------------------

Deno.test("GlobalArgsSchema: omitting sshHost entirely is rejected — the only field with neither a default nor .optional()", () => {
  assertThrows(() => model.globalArguments.parse({}));
  assertThrows(() =>
    model.globalArguments.parse({ sshUser: "root", sshPort: 22 })
  );
});

// ---------------------------------------------------------------------------
// parseKv edges
// ---------------------------------------------------------------------------

Deno.test("parseKv: a leading '=' (empty key) is ignored, and 'a=b=c' keeps the LATER '=' in the value", async () => {
  const { ctx, written } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout:
        "=leading-equals-is-ignored\nNODE=1.7.0=extra\nno-equals-sign-here\nBLACKBOX=0.25.0\n",
      stderr: "",
    },
    async () => {
      await run("install", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "install")!;
  assertEquals(
    res.payload.nodeExporter,
    "1.7.0=extra",
    "a=b=c keeps everything after the FIRST '=' as the value, including the second '='",
  );
  assertEquals(res.payload.blackbox, "0.25.0");
  assertEquals(
    res.payload.vector,
    "unknown",
    "a line with no '=' at all, and one with only a leading '=', contribute no keys",
  );
});

// ---------------------------------------------------------------------------
// install — 'unknown' fallback, once per INDIVIDUALLY missing key
// ---------------------------------------------------------------------------

Deno.test("install: each field falls back to 'unknown' independently when only IT is missing from stdout", async () => {
  const cases: Array<[string, string]> = [
    ["BLACKBOX=0.25.0\nVECTOR=0.46.1\n", "nodeExporter"],
    ["NODE=1.7.0\nVECTOR=0.46.1\n", "blackbox"],
    ["NODE=1.7.0\nBLACKBOX=0.25.0\n", "vector"],
  ];
  for (const [stdout, missingField] of cases) {
    const { ctx, written } = makeCtx(gArgs());
    await withCommandStub(
      { success: true, stdout, stderr: "" },
      async () => {
        await run("install", {}, ctx);
      },
    );
    const res = written.find((w) => w.spec === "install")!;
    assertEquals(
      res.payload[missingField],
      "unknown",
      `${missingField} must fall back to 'unknown' when its line is absent`,
    );
  }
});

// ---------------------------------------------------------------------------
// status — lst.* MISSING entirely (not just explicit "fail")
// ---------------------------------------------------------------------------

Deno.test("status: a MISSING lst.node key (not just an explicit non-ok value) also yields listeners.nodeExporter === false", async () => {
  const { ctx, written } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout:
        "svc.node=active\nsvc.blackbox=active\nsvc.vector=active\nlst.blackbox=ok\n",
      stderr: "",
    },
    async () => {
      await run("status", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(
    (res.payload.listeners as Record<string, boolean>).nodeExporter,
    false,
    "undefined === 'ok' is false — same outcome as an explicit 'fail', different code path",
  );
  assertEquals(
    (res.payload.listeners as Record<string, boolean>).blackbox,
    true,
  );
});

// ---------------------------------------------------------------------------
// configure — fail-loud: non-active/non-skipped values, and MULTIPLE bad
// services join into one message
// ---------------------------------------------------------------------------

Deno.test("configure: a systemd TRANSITIONAL state (neither 'active' nor 'skipped') still throws", async () => {
  const { ctx } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=activating\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async () => {
      await assertRejects(
        () => run("configure", {}, ctx),
        Error,
        "Service(s) not active after configure: NODE=activating",
      );
    },
  );
});

Deno.test("configure: MULTIPLE non-active services join into ONE comma-separated message", async () => {
  const { ctx } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=failed\nBLACKBOX=failed\nVECTOR=skipped\n",
      stderr: "",
    },
    async () => {
      await assertRejects(
        () => run("configure", {}, ctx),
        Error,
        "Service(s) not active after configure: NODE=failed, BLACKBOX=failed",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// inventory — listener-line regex (match/no-match, short rows) and the ps
// line regex (well-formed vs malformed)
// ---------------------------------------------------------------------------

Deno.test("inventory: a listener line with NO users:((...)) segment yields process: '' (regex no-match branch)", async () => {
  const { ctx, written } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout:
        "===SERVICES===\n===LISTENERS===\ntcp   LISTEN 0      128        0.0.0.0:22             0.0.0.0:*\n===PROCS===\n",
      stderr: "",
    },
    async () => {
      await run("inventory", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "inventory")!;
  const listeners = res.payload.listeners as { process: string }[];
  assertEquals(listeners[0].process, "");
});

Deno.test("inventory: a SHORT listener row (fewer than 5 whitespace fields) falls back to local: ''", async () => {
  const { ctx, written } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout: "===SERVICES===\n===LISTENERS===\ntcp\n===PROCS===\n",
      stderr: "",
    },
    async () => {
      await run("inventory", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "inventory")!;
  const listeners = res.payload.listeners as {
    proto: string;
    local: string;
    process: string;
  }[];
  assertEquals(listeners[0], { proto: "tcp", local: "", process: "" });
});

Deno.test("inventory: a malformed PROCS line (no leading digit count) is silently SKIPPED, well-formed sibling lines still counted", async () => {
  const { ctx, written } = makeCtx(gArgs());
  await withCommandStub(
    {
      success: true,
      stdout:
        "===SERVICES===\n===LISTENERS===\n===PROCS===\nnot-a-count-line\n      3 sshd\n",
      stderr: "",
    },
    async () => {
      await run("inventory", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "inventory")!;
  assertEquals(res.payload.processes, [{ name: "sshd", count: 3 }]);
});
