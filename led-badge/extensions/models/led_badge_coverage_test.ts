/**
 * Coverage tests for @magistr/led-badge: the branches the method suite does
 * not reach — the cargo build/cache path of the helper, HOME handling,
 * static-mode centring, frame labelling and protocol helpers.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model } from "./led_badge.ts";
import {
  brightnessByte,
  centre,
  parseArt,
  renderText,
  SYMBOL_NAMES,
  WIDTH,
} from "./lib/protocol.ts";

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

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await Deno.makeTempDir();
  const prevHome = Deno.env.get("HOME");
  const prevHelper = Deno.env.get("LED_BADGE_HELPER");
  Deno.env.set("HOME", home);
  Deno.env.delete("LED_BADGE_HELPER");
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    if (prevHelper !== undefined) Deno.env.set("LED_BADGE_HELPER", prevHelper);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("helper is built once with cargo --locked, then cached", async () => {
  await withHome(async (home) => {
    const { calls, restore } = installCommand((c) => {
      if (c.args[0] === "build") {
        const dir = c.args[c.args.indexOf("--target-dir") + 1];
        Deno.mkdirSync(`${dir}/release`, { recursive: true });
        Deno.writeTextFileSync(`${dir}/release/hid-send`, "#!/bin/sh\n");
        return {};
      }
      return ok({ devices: [] });
    });
    try {
      const { context } = fakeContext();
      await model.methods.detect.execute({}, context);
      await model.methods.detect.execute({}, context);
      const builds = calls.filter((c) => c.args[0] === "build");
      assertEquals(builds.length, 1);
      assertEquals(builds[0].cmd, "cargo");
      assert(builds[0].args.includes("--locked"));
      assertStringIncludes(
        builds[0].args[builds[0].args.indexOf("--manifest-path") + 1],
        "bin/hid-send/Cargo.toml",
      );
      const helper = calls.find((c) => c.args[0] === "usb")!;
      assert(helper.cmd.startsWith(`${home}/.cache/swamp-led-badge/hid-send-`));
    } finally {
      restore();
    }
  });
});

Deno.test("prefers ~/.cargo/bin/cargo when it exists", async () => {
  await withHome(async (home) => {
    Deno.mkdirSync(`${home}/.cargo/bin`, { recursive: true });
    Deno.writeTextFileSync(`${home}/.cargo/bin/cargo`, "");
    const { calls, restore } = installCommand((c) => {
      if (c.args[0] === "build") {
        const dir = c.args[c.args.indexOf("--target-dir") + 1];
        Deno.mkdirSync(`${dir}/release`, { recursive: true });
        Deno.writeTextFileSync(`${dir}/release/hid-send`, "");
        return {};
      }
      return ok();
    });
    try {
      await model.methods.detect.execute({}, fakeContext().context);
      assertEquals(calls[0].cmd, `${home}/.cargo/bin/cargo`);
    } finally {
      restore();
    }
  });
});

Deno.test("cargo failure surfaces the compiler error", async () => {
  await withHome(async () => {
    const { restore } = installCommand(() => ({
      stderr: "error[E0425]: cannot find value",
      code: 101,
    }));
    try {
      await assertRejects(
        () => model.methods.detect.execute({}, fakeContext().context),
        Error,
        "E0425",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("missing HOME is a clear error", async () => {
  await withHome(async () => {
    Deno.env.delete("HOME");
    await assertRejects(
      () => model.methods.detect.execute({}, fakeContext().context),
      Error,
      "HOME is not set",
    );
  });
});

Deno.test("static modes are centred, scrolling modes are not", async () => {
  await withHelper(() => ok(), async () => {
    const { written, context } = fakeContext();
    const args = model.methods.preview.arguments.parse({
      messages: [
        { text: "Hi", mode: "fixed" },
        { text: "Hi", mode: "up" },
        { text: "Hi", mode: "down" },
        { text: "Hi", mode: "left" },
      ],
    });
    await model.methods.preview.execute(args, context);
    const widths = (written[0].data.messages as { widthPx: number }[]).map(
      (m) => m.widthPx,
    );
    assertEquals(widths.slice(0, 3), [WIDTH, WIDTH, WIDTH]);
    assert(widths[3] < WIDTH);
  });
});

Deno.test("frames force animation mode and are labelled", async () => {
  await withHelper(() => ok(), async () => {
    const { written, context } = fakeContext();
    const args = model.methods.preview.arguments.parse({
      messages: [{ frames: [["#"], ["##"]], mode: "left" }, { art: ["#"] }],
    });
    await model.methods.preview.execute(args, context);
    const m = written[0].data.messages as { mode: string; source: string }[];
    assertEquals(m[0].mode, "animation");
    assertEquals(m[0].source, "(animation, 2 frames)");
    assertEquals(m[1].source, "(pixel art)");
  });
});

Deno.test("brightness maps to the four protocol levels", () => {
  assertEquals([25, 50, 75, 100].map(brightnessByte), [0x40, 0x20, 0x10, 0]);
});

Deno.test("every named symbol renders, unknown :names: render as text", () => {
  for (const s of SYMBOL_NAMES) {
    assert(renderText(`:${s}:`)[5].some(Boolean), s);
  }
  assert(renderText(":nope:")[0].length > 20);
});

Deno.test("centre leaves full-width bitmaps alone; art accepts X and 1", () => {
  const wide = parseArt(["#".repeat(50)]);
  assertEquals(centre(wide), wide);
  assertEquals(parseArt(["X1#."])[5], [true, true, true, false]);
});
