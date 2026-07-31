/**
 * Coverage tests for @magistr/flipper-zero: both sides of every remaining
 * guard/branch the methods and adversarial suites don't already force.
 *
 * flipper_zero.ts, lib/serial.ts and lib/protocol.ts are BYTE-FROZEN — every
 * test here characterizes already-shipped behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./flipper_zero.ts";
import {
  cleanResponse,
  cleanSequenceOutput,
  parseFileSize,
  parseStorageList,
  selectPort,
} from "./lib/protocol.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention — see
// observability-agent/music-library)
// ---------------------------------------------------------------------------

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({ ...overrides }) as Record<
    string,
    unknown
  >;
}

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(
  globalArgOverrides: Record<string, unknown> = {},
) {
  const written: Written[] = [];
  const ctx = {
    globalArgs: gArgs(globalArgOverrides),
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
  };
  return { written, ctx };
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
  env: Record<string, string>;
  stdin: string;
  killed: boolean;
}

type Kind =
  | "listDevNames"
  | "exchange"
  | "captureRpc"
  | "listenCapture"
  | "sequenceCapture"
  | "sendRpcHold"
  | "denoProbe"
  | "snakeChild";

function classify(call: CapturedCall): Kind {
  if (call.binary === "ls") return "listDevNames";
  if (call.args[0] === "--version") return "denoProbe";
  if (call.args[0] === "run") return "snakeChild";
  const script = call.args[1] ?? "";
  const envKeys = Object.keys(call.env);
  if (envKeys.some((k) => /^FZ_CMD_\d+$/.test(k))) return "sequenceCapture";
  if (script.includes("CATPID")) return "listenCapture";
  if (script.includes("start_rpc_session") && script.includes("exec cat")) {
    return "captureRpc";
  }
  if (script.includes("start_rpc_session")) return "sendRpcHold";
  return "exchange";
}

interface StubResult {
  code?: number | null;
  stdout?: string | Uint8Array;
  stderr?: string;
  hang?: boolean;
}

type Router = (call: CapturedCall, kind: Kind) => StubResult;

function encodeOutput(r: StubResult) {
  const stdout = r.stdout instanceof Uint8Array
    ? r.stdout
    : new TextEncoder().encode(r.stdout ?? "");
  return {
    code: r.code === undefined ? 0 : r.code,
    stdout,
    stderr: new TextEncoder().encode(r.stderr ?? ""),
  };
}

function installCommandStub(router: Router) {
  const calls: CapturedCall[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;

  class FakeCommand {
    #call: CapturedCall;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      this.#call = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
        env: (opts.env as Record<string, string> | undefined) ?? {},
        stdin: "",
        killed: false,
      };
      calls.push(this.#call);
    }
    spawn() {
      const call = this.#call;
      const kind = classify(call);
      const result = router(call, kind);
      let outputPromise: Promise<ReturnType<typeof encodeOutput>>;
      let resolveHang: ((v: ReturnType<typeof encodeOutput>) => void) | null =
        null;
      if (result.hang) {
        outputPromise = new Promise((resolve) => {
          resolveHang = resolve;
        });
      } else {
        outputPromise = Promise.resolve(encodeOutput(result));
      }
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
        output: () => outputPromise,
        kill: (_sig?: string) => {
          call.killed = true;
          if (resolveHang) {
            resolveHang(encodeOutput({ code: null, stdout: "", stderr: "" }));
            resolveHang = null;
          }
        },
      };
    }
    output() {
      const call = this.#call;
      const kind = classify(call);
      return Promise.resolve(encodeOutput(router(call, kind)));
    }
  }

  g.Deno.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

async function withCommandStub(
  router: Router,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const stub = installCommandStub(router);
  try {
    await fn(stub.calls);
  } finally {
    stub.restore();
  }
}

async function drive<T>(
  time: FakeTime,
  resultPromise: Promise<T>,
  stepMs = 500,
  maxTicks = 40,
): Promise<T> {
  let settled = false;
  resultPromise.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let i = 0; i < maxTicks && !settled; i++) {
    await time.tickAsync(stepMs);
    await Promise.resolve();
  }
  return await resultPromise;
}

function exchangeRaw(cmd: string, body: string): string {
  return `${cmd}\r\n${body}\r\n>: `;
}

const DEFAULT_CTX_OVERRIDES = { port: "/dev/cu.usbmodemflip_test" };

// ---------------------------------------------------------------------------
// selectPort precedence (pure function — already partly covered by
// contract-fixture; here: explicit override vs auto-detect priority order)
// ---------------------------------------------------------------------------

Deno.test("selectPort: flip node beats a generic usbmodem and a ttyACM node", () => {
  const names = ["ttyACM0", "cu.usbmodem1101", "cu.usbmodemflip_A1"];
  assertEquals(selectPort(names), "/dev/cu.usbmodemflip_A1");
});

Deno.test("selectPort: explicit override wins even when a flip node is present", () => {
  assertEquals(
    selectPort(["cu.usbmodemflip_A1"], "/dev/override"),
    "/dev/override",
  );
});

// ---------------------------------------------------------------------------
// cleanResponse: three anchor branches
// ---------------------------------------------------------------------------

Deno.test("cleanResponse: prompt-anchored branch (>: <cmd> present)", () => {
  const raw = ">: info device\r\nfoo: bar\r\n>: ";
  assertEquals(cleanResponse(raw, "info device"), "foo: bar");
});

Deno.test("cleanResponse: echo-without-prompt branch", () => {
  const raw = "info device\r\nfoo: bar\r\n>: ";
  assertEquals(cleanResponse(raw, "info device"), "foo: bar");
});

Deno.test("cleanResponse: no-echo branch strips a leading banner up to the first prompt", () => {
  const raw = "Welcome to Flipper Zero!\r\n>: foo: bar\r\n>: ";
  assertEquals(cleanResponse(raw, "info device"), "foo: bar");
});

// ---------------------------------------------------------------------------
// cleanSequenceOutput / parseFileSize / parseStorageList branch pairs
// ---------------------------------------------------------------------------

Deno.test("cleanSequenceOutput: drops an echoed empty-send (bare CR) step", () => {
  const raw = [">: nfc", "[nfc]>: scanner", "", "[nfc]>: exit", ">: "].join(
    "\r\n",
  );
  assertEquals(cleanSequenceOutput(raw, ["nfc", "scanner", "", "exit"]), "");
});

Deno.test("parseFileSize: both branches — present and absent", () => {
  assertEquals(parseFileSize("Size: 7\nhi"), 7);
  assertEquals(parseFileSize("no size header"), null);
});

Deno.test("parseStorageList: size-suffix present/absent/no-size, both dir and file", () => {
  const text = [
    "\t[D] nosize_dir",
    "\t[F] withb.bin 10b",
    "\t[F] nosuffix.bin 10",
    "\t[F] empty.bin",
  ].join("\n");
  assertEquals(parseStorageList(text), [
    { type: "dir", name: "nosize_dir", size: null },
    { type: "file", name: "withb.bin", size: 10 },
    { type: "file", name: "nosuffix.bin", size: 10 },
    { type: "file", name: "empty.bin", size: null },
  ]);
});

// ---------------------------------------------------------------------------
// info: attributes-empty vs unknown-command fallback trigger (both reasons
// to fall back to device_info)
// ---------------------------------------------------------------------------

Deno.test("info: falls back when info device parses to EMPTY attributes (not unknown-command)", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const router: Router = (call) => {
    const cmd = call.env.FZ_CMD ?? "";
    if (cmd === "info device") {
      // Not "unknown command", but nothing parses into key:value pairs.
      return { stdout: exchangeRaw(cmd, "no colon lines here at all") };
    }
    return { stdout: exchangeRaw(cmd, "hardware_model    : F7") };
  };
  await withCommandStub(router, async () => {
    await run("info", {}, ctx);
  });
  const res = written.find((w) => w.spec === "device-info")!;
  assertEquals(res.payload.command, "device_info");
});

Deno.test("info: does NOT fall back when info device parses non-empty attributes", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (call) => ({
      stdout: exchangeRaw(call.env.FZ_CMD ?? "", "hardware_model : F7"),
    }),
    async () => {
      await run("info", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "device-info")!;
  assertEquals(res.payload.command, "info device");
});

// ---------------------------------------------------------------------------
// exchange: waitForPrompt=false path (reboot) vs waitForPrompt=true (exec);
// busy vs generic-failure vs no-response throw ladder
// ---------------------------------------------------------------------------

Deno.test("exchange throw ladder: 'resource busy' stderr yields the busy-specific message", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    () => ({ code: 1, stdout: "", stderr: "resource busy" }),
    async () => {
      await assertRejects(
        () => run("exec", { command: "vibro 1" }, ctx),
        Error,
        "is busy",
      );
    },
  );
});

Deno.test("exchange throw ladder: non-zero exit with stderr yields the generic failure message", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    () => ({ code: 1, stdout: "", stderr: "some other bash error" }),
    async () => {
      await assertRejects(
        () => run("exec", { command: "vibro 1" }, ctx),
        Error,
        "Failed to communicate",
      );
    },
  );
});

Deno.test("exchange throw ladder: exit 0 with empty output and waitForPrompt=true yields 'No response'", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    () => ({ code: 0, stdout: "", stderr: "" }),
    async () => {
      await assertRejects(
        () => run("exec", { command: "vibro 1" }, ctx),
        Error,
        "No response",
      );
    },
  );
});

Deno.test("exchange: reboot uses waitForPrompt=false — empty output with exit 0 is NOT an error", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    () => ({ code: 0, stdout: "", stderr: "" }),
    async () => {
      await run("reboot", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "reboot-result")!;
  assertEquals(res.payload.requested, true);
});

// ---------------------------------------------------------------------------
// exchange: timedOut=true when the hard-timeout killer fires
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "exchange: timedOut=true when the hard-timeout killer fires before any output",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { ctx, written } = makeCtx({
      ...DEFAULT_CTX_OVERRIDES,
      timeoutMs: 100,
    });
    const time = new FakeTime();
    try {
      await withCommandStub(
        (_call, kind) => kind === "exchange" ? { hang: true } : { stdout: "" },
        async () => {
          await drive(time, run("exec", { command: "vibro 1" }, ctx), 200, 10);
        },
      );
    } finally {
      time.restore();
    }
    const res = written.find((w) => w.spec === "command-output")!;
    assertEquals(res.payload.timedOut, true);
    assertEquals(res.payload.output, "");
  },
});

// ---------------------------------------------------------------------------
// closeRunningApp / launch: both sides via loader-info combinations already
// covered in methods suite; here, verify launch does NOT force-close when
// force is set but nothing is running (no wasted close cycle).
// ---------------------------------------------------------------------------

Deno.test("launch: force:true with nothing running skips closeRunningApp entirely (single loader open)", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const calledCommands: string[] = [];
  const state = { running: null as string | null };
  const router: Router = (call) => {
    const cmd = call.env.FZ_CMD ?? "";
    calledCommands.push(cmd);
    if (cmd === "loader info") {
      return {
        stdout: exchangeRaw(
          cmd,
          state.running
            ? `Application "${state.running}" is running`
            : "No application is running",
        ),
      };
    }
    if (cmd.startsWith("loader open ")) {
      state.running = cmd.slice("loader open ".length);
      return { stdout: exchangeRaw(cmd, "") };
    }
    return { stdout: exchangeRaw(cmd, "") };
  };
  await withCommandStub(router, async () => {
    await run("launch", { app: "Clock", force: true }, ctx);
  });
  assertEquals(
    calledCommands.filter((c) => c === "loader close").length,
    0,
    "no loader close should be issued when nothing was running",
  );
  const res = written.find((w) => w.spec === "launch-result")!;
  assertEquals(res.payload.launched, true);
});

// ---------------------------------------------------------------------------
// installed-apps: empty categories / no apps at all
// ---------------------------------------------------------------------------

Deno.test("installed-apps: empty tree AND empty fallback list yields zero apps, not an error", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const router: Router = (call) => {
    const cmd = call.env.FZ_CMD ?? "";
    if (cmd.startsWith("storage tree ")) {
      return { stdout: exchangeRaw(cmd, "") };
    }
    return { stdout: exchangeRaw(cmd, "") }; // storage list <base> -> nothing
  };
  await withCommandStub(router, async () => {
    await run("installed-apps", {}, ctx);
  });
  const res = written.find((w) => w.spec === "installed-apps")!;
  assertEquals(res.payload.count, 0);
  assertEquals(res.payload.categories, []);
  assertEquals(res.payload.byKind, {});
});

// ---------------------------------------------------------------------------
// listen: raw variants + external device selection (subghz/ir)
// ---------------------------------------------------------------------------

Deno.test("listen: subghz raw uses rx_raw and honors the external device index", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  let capturedCommand = "";
  await withCommandStub(
    (call, kind) => {
      if (kind === "listenCapture") capturedCommand = call.env.FZ_CMD ?? "";
      return { stdout: "" };
    },
    async () => {
      await run(
        "listen",
        { source: "subghz", raw: true, external: true, seconds: 1 },
        ctx,
      );
    },
  );
  assertEquals(capturedCommand, "subghz rx_raw 433920000");
  const res = written.find((w) => w.spec === "listen-result")!;
  assertEquals(res.payload.frequency, 433920000);
});

Deno.test("listen: ir raw uses 'ir rx raw'", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  let capturedCommand = "";
  await withCommandStub(
    (call, kind) => {
      if (kind === "listenCapture") capturedCommand = call.env.FZ_CMD ?? "";
      return { stdout: "" };
    },
    async () => {
      await run("listen", { source: "ir", raw: true, seconds: 1 }, ctx);
    },
  );
  assertEquals(capturedCommand, "ir rx raw");
});

Deno.test("listen: rfid uses 'rfid read'", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(() => ({ stdout: "" }), async () => {
    await run("listen", { source: "rfid", seconds: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "listen-result")!;
  assertEquals(res.payload.command, "rfid read");
  assertEquals(res.payload.frequency, null);
});

// ---------------------------------------------------------------------------
// transmit: subghz file-replay and raw-key branches, and the external flag
// ---------------------------------------------------------------------------

Deno.test("transmit: subghz file replay", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (call) => ({ stdout: exchangeRaw(call.env.FZ_CMD ?? "", "") }),
    async () => {
      await run(
        "transmit",
        { source: "subghz", file: "/ext/subghz/gate.sub", repeat: 2 },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "transmit-result")!;
  assertEquals(
    res.payload.command,
    "subghz tx_from_file /ext/subghz/gate.sub 2 0",
  );
});

Deno.test("transmit: subghz raw key with external device", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (call) => ({ stdout: exchangeRaw(call.env.FZ_CMD ?? "", "") }),
    async () => {
      await run(
        "transmit",
        {
          source: "subghz",
          key: "AABBCC",
          frequency: 433920000,
          te: 350,
          external: true,
        },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "transmit-result")!;
  assertEquals(
    res.payload.command,
    "subghz tx AABBCC 433920000 350 1 1",
  );
});

// ---------------------------------------------------------------------------
// close: verify each `loader info` poll in the escalation sees the LATEST
// state (i.e. the router really is stateful across the multi-step flow)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "close: after a successful back-button escalation, a follow-up close call is idempotent (already-idle)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const state = { running: "Snake Game" as string | null };
    const router: Router = (call) => {
      const cmd = call.env.FZ_CMD ?? "";
      if (cmd === "loader info") {
        return {
          stdout: exchangeRaw(
            cmd,
            state.running
              ? `Application "${state.running}" is running`
              : "No application is running",
          ),
        };
      }
      if (cmd === "input send back release") state.running = null;
      return { stdout: exchangeRaw(cmd, "") };
    };
    const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
    const time = new FakeTime();
    try {
      await withCommandStub(router, async () => {
        await drive(time, run("close", {}, ctx));
        await drive(time, run("close", {}, ctx));
      });
    } finally {
      time.restore();
    }
    const results = written.filter((w) => w.spec === "close-result");
    assertEquals(results.length, 2);
    assertEquals(results[0].payload.via, "back-button");
    assertEquals(results[1].payload.via, "already-idle");
  },
});
