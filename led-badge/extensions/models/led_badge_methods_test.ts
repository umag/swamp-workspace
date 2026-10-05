/**
 * Method-level tests for @magistr/led-badge — detect, preview and send, each
 * happy path + primary failure, over both transports, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a fake context
 * and a stubbed `Deno.Command`.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./led_badge.ts";

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

Deno.test("detect (usb): probes the HID helper and records the device", async () => {
  await withHelper(
    () => ok({ devices: [{ transport: "usb", product: "CH583" }] }),
    async (calls) => {
      const { written, context } = fakeContext();
      await model.methods.detect.execute({}, context);
      assertEquals(calls[0].args, ["usb", "1046", "20512", "probe"]);
      assertEquals(written[0].spec, "device");
      assertEquals(written[0].data.found, true);
      assertEquals(written[0].data.transport, "usb");
    },
  );
});

Deno.test("detect (ble): scans by name and records the result", async () => {
  await withHelper(
    () => ok({ devices: [{ name: "LSLED" }] }),
    async (calls) => {
      const { written, context } = fakeContext({ transport: "ble" });
      await model.methods.detect.execute({}, context);
      assertEquals(calls[0].args, ["ble", "LSLED", "20", "probe", ""]);
      assertEquals(written[0].data.transport, "ble");
    },
  );
});

Deno.test("detect: no badge -> throws and records found=false", async () => {
  await withHelper(
    () => ({ stdout: JSON.stringify({ ok: false, devices: [] }), code: 1 }),
    async () => {
      const { written, context } = fakeContext();
      await assertRejects(
        () => model.methods.detect.execute({}, context),
        Error,
        "no badge 1046:20512 connected",
      );
      assertEquals(written[0].data.found, false);
    },
  );
});

Deno.test("preview: renders frames without touching the device", async () => {
  await withHelper(() => ok(), async (calls) => {
    const { written, context } = fakeContext();
    const args = model.methods.preview.arguments.parse({
      messages: [{ text: "Hi", mode: "fixed" }],
    });
    await model.methods.preview.execute(args, context);
    assertEquals(calls.length, 0);
    const msgs = written[0].data.messages as { frame: string[] }[];
    assertEquals(msgs[0].frame.length, 11);
    assertEquals(msgs[0].frame[0].length, 44);
  });
});

Deno.test("preview: invalid arguments are rejected by the schema", () => {
  assertThrows(() => model.methods.preview.arguments.parse({ messages: [] }));
});

Deno.test("send (usb): uploads a 64-byte-aligned wang payload", async () => {
  await withHelper(() => ok({ reportsSent: 2 }), async (calls) => {
    const { written, context } = fakeContext();
    const args = model.methods.send.arguments.parse({
      messages: [{ text: "Hi" }],
      brightness: 50,
    });
    await model.methods.send.execute(args, context);
    assertEquals(calls[0].args, ["usb", "1046", "20512"]);
    const p = calls[0].stdin;
    assertEquals(new TextDecoder().decode(p.slice(0, 4)), "wang");
    assertEquals(p.length % 64, 0);
    assertEquals(written[0].spec, "upload");
    assertEquals(written[0].data.reportsSent, 2);
    assertEquals(written[0].data.payloadBytes, p.length);
  });
});

Deno.test("send (ble): 16-byte-aligned payload, pin passed through", async () => {
  await withHelper(() => ok({ chunksSent: 6 }), async (calls) => {
    const { written, context } = fakeContext({
      transport: "ble",
      blePin: "1234",
    });
    const args = model.methods.send.arguments.parse({
      messages: [{ text: "Hi" }],
    });
    await model.methods.send.execute(args, context);
    assertEquals(calls[0].args, ["ble", "LSLED", "20", "send", "1234"]);
    assertEquals(calls[0].stdin.length % 16, 0);
    assert(calls[0].stdin.length % 64 !== 0);
    assertEquals(written[0].data.reportsSent, 6);
    assertEquals(written[0].data.transport, "ble");
  });
});

Deno.test("send: helper failure throws and writes nothing", async () => {
  await withHelper(
    () => ({
      stdout: JSON.stringify({ ok: false, error: "open: busy" }),
      code: 1,
    }),
    async () => {
      const { written, context } = fakeContext();
      const args = model.methods.send.arguments.parse({
        messages: [{ text: "Hi" }],
      });
      await assertRejects(
        () => model.methods.send.execute(args, context),
        Error,
        "open: busy",
      );
      assertEquals(written.length, 0);
    },
  );
});
