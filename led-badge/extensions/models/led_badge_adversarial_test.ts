/**
 * Adversarial tests for @magistr/led-badge: hostile or broken helper output,
 * oversize uploads, argv injection attempts, malformed arguments and
 * mid-upload BLE disconnects.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./led_badge.ts";
import { framesToBitmap, renderText } from "./lib/protocol.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per suite, per this repo's convention). ONE seam:
// `Deno.Command`, used as `.spawn()` for the helper (payload on stdin) and as
// `.output()` for the cargo build. LED_BADGE_HELPER skips the build.
// ---------------------------------------------------------------------------

type Call = { cmd: string; args: string[]; stdin: Uint8Array };
type Reply = { stdout?: string; stderr?: string; code?: number };

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function toOutput(r: Reply) {
  const enc = new TextEncoder();
  return {
    success: (r.code ?? 0) === 0,
    code: r.code ?? 0,
    stdout: enc.encode(r.stdout ?? ""),
    stderr: enc.encode(r.stderr ?? ""),
  };
}

function installCommand(router: (c: Call) => Reply) {
  const calls: Call[] = [];
  const D = Deno as unknown as { Command: unknown };
  const original = D.Command;
  class FakeCommand {
    constructor(
      private cmd: string,
      private opts: { args?: string[] } = {},
    ) {}
    spawn() {
      const call: Call = {
        cmd: this.cmd,
        args: this.opts.args ?? [],
        stdin: new Uint8Array(),
      };
      const chunks: Uint8Array[] = [];
      return {
        stdin: new WritableStream<Uint8Array>({
          write(c) {
            chunks.push(c);
          },
        }),
        output: () => {
          call.stdin = concat(chunks);
          calls.push(call);
          return Promise.resolve(toOutput(router(call)));
        },
      };
    }
    output() {
      const call: Call = {
        cmd: this.cmd,
        args: this.opts.args ?? [],
        stdin: new Uint8Array(),
      };
      calls.push(call);
      return Promise.resolve(toOutput(router(call)));
    }
  }
  D.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      D.Command = original;
    },
  };
}

type Written = { spec: string; name: string; data: Record<string, unknown> };

function fakeContext(globals: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({});
    },
    logger: { info: () => {} },
  };
  return { written, context };
}

async function withHelper<T>(
  router: (c: Call) => Reply,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const prev = Deno.env.get("LED_BADGE_HELPER");
  Deno.env.set("LED_BADGE_HELPER", "/fake/hid-send");
  const { calls, restore } = installCommand(router);
  try {
    return await fn(calls);
  } finally {
    restore();
    if (prev === undefined) Deno.env.delete("LED_BADGE_HELPER");
    else Deno.env.set("LED_BADGE_HELPER", prev);
  }
}

const ok = (o: Record<string, unknown> = {}): Reply => ({
  stdout: JSON.stringify({ ok: true, ...o }),
});

const send = (messages: unknown[], globals: Record<string, unknown> = {}) => {
  const { written, context } = fakeContext(globals);
  const args = model.methods.send.arguments.parse({ messages });
  return { written, run: () => model.methods.send.execute(args, context) };
};

Deno.test("non-JSON helper output surfaces stdout, stderr and exit code", async () => {
  await withHelper(
    () => ({ stdout: "Segmentation fault", stderr: "dyld: boom", code: 139 }),
    async () => {
      const { run } = send([{ text: "x" }]);
      const err = await assertRejects(run);
      assertStringIncludes((err as Error).message, "helper produced no JSON");
      assertStringIncludes((err as Error).message, "exit 139");
      assertStringIncludes((err as Error).message, "dyld: boom");
    },
  );
});

Deno.test("empty helper output is a failure, not a success", async () => {
  await withHelper(() => ({ stdout: "", code: 1 }), async () => {
    const { written, run } = send([{ text: "x" }]);
    await assertRejects(run);
    assertEquals(written.length, 0);
  });
});

Deno.test("oversize upload is refused before the helper is spawned", async () => {
  await withHelper(() => ok(), async (calls) => {
    const frames = Array.from({ length: 32 }, () => ["#"]);
    const { run } = send([{ frames }, { frames }]);
    await assertRejects(run, Error, "silently ignores");
    assertEquals(calls.length, 0);
  });
});

Deno.test("bleName with shell metacharacters stays one argv element", async () => {
  await withHelper(() => ok(), async (calls) => {
    const evil = "LSLED; rm -rf ~ $(id)";
    const { run } = send([{ text: "x" }], { transport: "ble", bleName: evil });
    await run();
    assertEquals(calls[0].args[1], evil);
    assertEquals(calls[0].cmd, "/fake/hid-send");
  });
});

Deno.test("blePin must be exactly 4 digits", () => {
  for (const pin of ["123", "12345", "12a4", "1234\n", "; ls"]) {
    assertThrows(() => model.globalArguments.parse({ blePin: pin }));
  }
});

Deno.test("out-of-range message fields are rejected", () => {
  const p = (m: Record<string, unknown>) =>
    model.methods.send.arguments.parse({ messages: [m] });
  assertThrows(() => p({ text: "x", speed: 0 }));
  assertThrows(() => p({ text: "x", speed: 9 }));
  assertThrows(() => p({ text: "x", mode: "explode" }));
  assertThrows(() => p({ art: Array(12).fill("#") }));
  assertThrows(() => p({ frames: Array.from({ length: 33 }, () => ["#"]) }));
  assertThrows(() =>
    model.methods.send.arguments.parse({
      messages: Array(9).fill({ text: "x" }),
    })
  );
  assertThrows(() =>
    model.methods.send.arguments.parse({
      messages: [{ text: "x" }],
      brightness: 60,
    })
  );
});

Deno.test("a frame wider than the display throws", () => {
  assertThrows(() => framesToBitmap([["#".repeat(45)]]), Error, "max is 44");
});

Deno.test("non-ASCII text renders as '?' instead of throwing", () => {
  const bm = renderText("Привет ☃");
  assertEquals(bm.length, 11);
  assert(bm[0].length > 0);
});

Deno.test("BLE disconnect mid-upload is reported, nothing recorded", async () => {
  await withHelper(
    () => ({
      stdout: JSON.stringify({
        ok: false,
        error: "ble write chunk 15: Device disconnected",
        chunksSent: 15,
      }),
      code: 1,
    }),
    async () => {
      const { written, run } = send([{ text: "x" }], { transport: "ble" });
      await assertRejects(run, Error, "Device disconnected");
      assertEquals(written.length, 0);
    },
  );
});
