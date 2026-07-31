/**
 * Adversarial tests for @magistr/flipper-zero. Assume broken: pin the
 * injection defenses AND the seven latent bugs found while characterizing
 * the frozen source (tracked in the LOCAL @magistr/issue-lifecycle model
 * `flipper-zero-latent-bugs`, never the Lab — the source is byte-frozen, so
 * these are PINNED as accepted current behavior, not fixed here):
 *
 *  BUG-1 (MED)  findScreenFrame locks onto the FIRST 0x0A 0x80 0x08 triple
 *               with no message-boundary validation — a false lock.
 *  BUG-2 (MED)  cleanResponse anchors on the LAST ">: <cmd>" occurrence, so
 *               device output that itself contains that string truncates
 *               legitimate earlier output.
 *  BUG-3 (MED)  captureRpc/listenCapture/sequenceCapture/sendRpcHold apply no
 *               maxBytes cap (only exchange caps at 1 MiB).
 *  BUG-4 (LOW)  the HEX pattern admits space-separated extra tokens, so a
 *               single-value ir/subghz field can inject an extra positional
 *               token into the device CLI line.
 *  BUG-5 (LOW)  assertSingleLineCommand blocks only CR/LF; other C0 control
 *               bytes reach the device CLI line via FZ_CMD.
 *  BUG-6 (LOW)  play-snake resolves the port and hands it straight to the
 *               child bot WITHOUT the assertPortPath guard every other
 *               device call applies.
 *  BUG-7 (LOW)  sendRpcHold has no setTimeout(kill) backstop, unlike every
 *               other serial.ts seam.
 *
 * PLUS the security POSITIVE (review-security PASS, wave-4 batch-4c plan
 * review): no exploitable command injection. The device path and command
 * travel via the FZ_PORT/FZ_CMD environment (never interpolated into the
 * bash script); only the validated numeric baud/idle and \xHH hex escapes
 * are interpolated; assertPortPath/assertBaud/buildTransmitCommand's
 * ALNUM/IDENT/HEX/DEV_PATH allowlists reject shell metacharacters;
 * assertSingleLineCommand rejects CR/LF CLI injection.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./flipper_zero.ts";
import {
  buildTransmitCommand,
  cleanResponse,
  findScreenFrame,
  parseListenEvents,
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
  opts: { extensionFile?: (path: string) => string } = {},
) {
  const written: Written[] = [];
  const ctx: {
    globalArgs: Record<string, unknown>;
    writeResource: (
      spec: string,
      name: string,
      payload: unknown,
    ) => Promise<unknown>;
    extensionFile?: (path: string) => string;
  } = {
    globalArgs: gArgs(globalArgOverrides),
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
  };
  if (opts.extensionFile) ctx.extensionFile = opts.extensionFile;
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
        kill: (_sig?: string) => {
          call.killed = true;
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

function exchangeRaw(cmd: string, body: string): string {
  return `${cmd}\r\n${body}\r\n>: `;
}

const DEFAULT_CTX_OVERRIDES = { port: "/dev/cu.usbmodemflip_test" };

// ---------------------------------------------------------------------------
// BUG-1 (MED): findScreenFrame false-lock — the FIRST 0x0A 0x80 0x08 triple
// wins even when it is not the real ScreenFrame.
// ---------------------------------------------------------------------------

Deno.test("BUG-1 (accepted, frozen): findScreenFrame locks onto the FIRST header triple, even when it is spurious noise ahead of the real frame", () => {
  const real = new Uint8Array(1024).fill(0xaa);
  const spurious = new Uint8Array(1024).fill(0x11);
  // Spurious header appears first (in some non-framebuffer noise byte run),
  // then the REAL ScreenFrame header + payload follows.
  const stream = new Uint8Array([
    0x0a,
    0x80,
    0x08,
    ...spurious,
    0x0a,
    0x80,
    0x08,
    ...real,
  ]);
  const found = findScreenFrame(stream);
  // Pin the bug: the function returns the WRONG (spurious) slice, not the
  // real frame that follows it.
  assertEquals(found?.[0], 0x11);
  assert(found?.every((b) => b === 0x11));
});

Deno.test("findScreenFrame: garbled/truncated bytes with no full header return null rather than mis-slicing", () => {
  // A header-looking prefix with fewer than 1024 trailing bytes must not
  // mis-slice off the end of the buffer.
  const short = new Uint8Array([0x0a, 0x80, 0x08, 1, 2, 3]);
  assertEquals(findScreenFrame(short), null);
  assertEquals(findScreenFrame(new Uint8Array(0)), null);
});

// ---------------------------------------------------------------------------
// BUG-2 (MED): cleanResponse anchors on the LAST ">: <cmd>" occurrence.
// ---------------------------------------------------------------------------

Deno.test("BUG-2 (accepted, frozen): cleanResponse truncates legitimate output that itself echoes the prompt-prefixed command", () => {
  // Real earlier output followed by device-printed text that happens to
  // reproduce the exact ">: <cmd>" anchor (e.g. a help/history echo or file
  // content), then the real trailing prompt.
  const raw = ">: storage read /ext/log.txt\r\n" +
    "line one of the real file\r\n" +
    ">: storage read /ext/log.txt\r\n" + // embedded in the file content itself
    "this is the only part cleanResponse keeps\r\n" +
    ">: ";
  const out = cleanResponse(raw, "storage read /ext/log.txt");
  // Pin the bug: "line one of the real file" is silently dropped because
  // lastIndexOf anchors on the SECOND occurrence.
  assertEquals(out, "this is the only part cleanResponse keeps");
  assert(!out.includes("line one of the real file"));
});

// ---------------------------------------------------------------------------
// BUG-3 (MED): streaming reads (captureRpc/listenCapture/sequenceCapture/
// sendRpcHold) apply no maxBytes cap, unlike exchange's 1 MiB cap.
// ---------------------------------------------------------------------------

Deno.test("BUG-3 (accepted, frozen): screenshot (captureRpc) is not truncated even far past exchange's 1 MiB cap", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const oversized = new Uint8Array(2 * 1024 * 1024); // 2 MiB, > 1 MiB DEFAULT_MAX_BYTES
  oversized.set([0x0a, 0x80, 0x08], oversized.length - 1027);
  oversized.fill(0x42, oversized.length - 1024);
  await withCommandStub(
    (_call, kind) => {
      assertEquals(kind, "captureRpc");
      return { stdout: oversized };
    },
    async () => {
      await run("screenshot", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "screenshot")!;
  // The frame is still found at the tail of an un-capped 2 MiB capture;
  // captureRpc never truncated it (there is no maxBytes option on this seam).
  assertEquals(res.payload.capturedBytes, oversized.length);
});

Deno.test("BUG-3 (accepted, frozen): exchange DOES cap at 1 MiB — the asymmetry that makes the streaming seams notable", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const big = "x".repeat(1024 * 1024 + 500);
  await withCommandStub(
    (call) => ({ stdout: exchangeRaw(call.env.FZ_CMD ?? "", big) }),
    async () => {
      await run("exec", { command: "storage read /ext/huge.bin" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "command-output")!;
  assertEquals(res.payload.truncated, true);
});

// ---------------------------------------------------------------------------
// BUG-4 (LOW): HEX admits space-separated extra tokens.
// ---------------------------------------------------------------------------

Deno.test("BUG-4 (accepted, frozen): a single hex field with an embedded space injects an extra positional token", () => {
  const { command } = buildTransmitCommand({
    source: "ir",
    protocol: "NEC",
    address: "04 41", // meant to be ONE address value
    command: "08",
  });
  // Pin the bug: HEX = /^[0-9A-Fa-f]+(?: [0-9A-Fa-f]+)*$/ accepts this, so the
  // device CLI line gains an extra token instead of rejecting the input.
  assertEquals(command, "ir tx NEC 04 41 08");
});

// ---------------------------------------------------------------------------
// BUG-5 (LOW): assertSingleLineCommand blocks only CR/LF.
// ---------------------------------------------------------------------------

Deno.test("BUG-5 (accepted, frozen): non-CRLF C0 control bytes reach the device CLI line unfiltered", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const withTab = "vibro\t1"; // TAB (0x09) is not CR/LF
  await withCommandStub(
    (call) => ({ stdout: exchangeRaw(call.env.FZ_CMD ?? "", "") }),
    async (calls) => {
      await run("exec", { command: withTab }, ctx);
      const exchangeCall = calls.find((c) => classify(c) === "exchange")!;
      assertEquals(exchangeCall.env.FZ_CMD, withTab);
    },
  );
  const res = written.find((w) => w.spec === "command-output")!;
  assertEquals(res.payload.command, withTab);
});

Deno.test("assertSingleLineCommand (via exec) still rejects CR/LF", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await assertRejects(
    () => run("exec", { command: "vibro 1\r\nreboot" }, ctx),
    Error,
    "single line",
  );
});

// ---------------------------------------------------------------------------
// BUG-6 (LOW): play-snake bypasses assertPortPath (defense-in-depth gap).
// ---------------------------------------------------------------------------

Deno.test("BUG-6 (accepted, frozen): play-snake hands an unvalidated port straight to the child bot, unlike every exchange-based method", async () => {
  const weirdPort = "not-a-dev-path"; // would fail assertPortPath's /dev/ + no-metachar check
  const { ctx: snakeCtx } = makeCtx({ port: weirdPort }, {
    extensionFile: (p) => p,
  });
  const log = 'done. 5.0s ticks=1 moves=0 maxLen=1 decisions={"tail":1}\n';
  let capturedPort = "";
  await withCommandStub(
    (call, kind) => {
      if (kind === "denoProbe") return { code: 0 };
      if (kind === "snakeChild") {
        capturedPort = call.args[4] ?? ""; // args: run --allow-all - seconds port appPath
        return { stdout: log };
      }
      throw new Error(`unexpected kind ${kind}`);
    },
    async () => {
      // Does NOT throw — assertPortPath is never consulted on this path.
      await run("play-snake", { seconds: 5 }, snakeCtx);
    },
  );
  assertEquals(capturedPort, weirdPort);

  // Contrast: the SAME weird port DOES throw through any exchange-based
  // method, because exchange() calls assertPortPath() first thing.
  const { ctx: execCtx } = makeCtx({ port: weirdPort });
  await assertRejects(
    () => run("exec", { command: "vibro 1" }, execCtx),
    Error,
    "Invalid serial port path",
  );
});

// ---------------------------------------------------------------------------
// BUG-7 (LOW): sendRpcHold has no setTimeout(kill) backstop.
// ---------------------------------------------------------------------------

Deno.test("BUG-7 (accepted, frozen): sendRpcHold (show-image) schedules no timer, unlike exchange (exec)", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let timerCalls = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (
    ...args: Parameters<typeof setTimeout>
  ) => {
    timerCalls++;
    return originalSetTimeout(...args);
  };
  try {
    const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
    await withCommandStub(() => ({ code: 0 }), async () => {
      await run("show-image", { ascii: "#" }, ctx);
    });
    assertEquals(
      timerCalls,
      0,
      "sendRpcHold must not schedule any timer — pinning the missing backstop",
    );

    timerCalls = 0;
    await withCommandStub(
      (call) => ({ stdout: exchangeRaw(call.env.FZ_CMD ?? "", "1") }),
      async () => {
        await run("exec", { command: "vibro 1" }, ctx);
      },
    );
    assert(
      timerCalls >= 1,
      "exchange DOES schedule a hard-timeout kill timer, unlike sendRpcHold",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

// ---------------------------------------------------------------------------
// Security POSITIVE: no exploitable command injection.
// ---------------------------------------------------------------------------

Deno.test("security: FZ_PORT/FZ_CMD travel via env, never interpolated into the bash script", async () => {
  const evilCmd = 'vibro 1"; touch /tmp/pwned; echo "';
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (call, kind) => {
      if (kind !== "exchange") return { stdout: "" };
      // The script text must reference the env var by name, never the
      // literal command/port value.
      const script = call.args[1] ?? "";
      assert(script.includes("$FZ_CMD"));
      assert(!script.includes(evilCmd));
      assert(!script.includes(DEFAULT_CTX_OVERRIDES.port));
      return { stdout: exchangeRaw(call.env.FZ_CMD ?? "", "") };
    },
    async (calls) => {
      await run("exec", { command: evilCmd }, ctx);
      const exchangeCall = calls.find((c) => classify(c) === "exchange")!;
      assertEquals(exchangeCall.env.FZ_CMD, evilCmd);
      assertEquals(exchangeCall.env.FZ_PORT, DEFAULT_CTX_OVERRIDES.port);
    },
  );
});

Deno.test("security: assertPortPath (via exchange) rejects shell metacharacters in the port", async () => {
  for (
    const bad of ["/dev/x;y", "/dev/x|y", "/dev/x$y", "/dev/x`y`", "notdev"]
  ) {
    const { ctx } = makeCtx({ port: bad });
    await assertRejects(
      () => run("exec", { command: "vibro 1" }, ctx),
      Error,
      "Invalid serial port path",
    );
  }
});

Deno.test("security: assertBaud (via exchange) rejects a non-numeric baud", async () => {
  const { ctx } = makeCtx({
    ...DEFAULT_CTX_OVERRIDES,
    baud: "230400; touch /tmp/pwn",
  });
  await assertRejects(
    () => run("exec", { command: "vibro 1" }, ctx),
    Error,
    "Invalid baud rate",
  );
});

Deno.test("security: buildTransmitCommand's ALNUM/IDENT/HEX allowlists reject shell metacharacters", () => {
  try {
    buildTransmitCommand({
      source: "ir",
      protocol: "NEC; reboot",
      address: "04",
      command: "08",
    });
    throw new Error("expected buildTransmitCommand to throw");
  } catch (e) {
    assert(e instanceof Error);
    assert(e.message.includes("protocol"));
  }
  try {
    buildTransmitCommand({
      source: "ir",
      universalRemote: "tv`id`",
      signal: "Power",
    });
    throw new Error("expected buildTransmitCommand to throw");
  } catch (e) {
    assert(e instanceof Error);
    assert(e.message.includes("universalRemote"));
  }
  try {
    buildTransmitCommand({
      source: "rfid",
      keyType: "EM4100",
      keyData: "12$(id)",
    });
    throw new Error("expected buildTransmitCommand to throw");
  } catch (e) {
    assert(e instanceof Error);
    assert(e.message.includes("keyData"));
  }
});

Deno.test("security note: DEV_PATH (file) allows non-whitespace punctuation like ';' — safe only because the command still travels via FZ_CMD env, never shell-interpolated", () => {
  // DEV_PATH = /^\/[^\s]+$/ rejects whitespace but not every metacharacter.
  // This is NOT host-shell-exploitable (buildScript never interpolates the
  // command string itself — only $FZ_CMD, passed as an env var to printf
  // "%s"), so it is a device-CLI-only surface, not a new BUG-1..7 entry.
  const { command } = buildTransmitCommand({
    source: "subghz",
    file: "/ext/a;id",
  });
  assertEquals(command, "subghz tx_from_file /ext/a;id 1 0");
});

Deno.test("parseListenEvents never throws on arbitrary/garbled control-byte text", () => {
  const garbled = "\x00\x01\x02NEC\x1b[31m garbled \x07\n\n\x00more\x00";
  const events = parseListenEvents(garbled);
  assert(Array.isArray(events));
});
