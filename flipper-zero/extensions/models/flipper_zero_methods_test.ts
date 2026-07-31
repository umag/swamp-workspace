/**
 * Method-level tests for @magistr/flipper-zero — every one of the 16 methods
 * (detect, info, exec, storage-list, storage-read, apps, installed-apps,
 * launch, close, running, screenshot, show-image, play-snake, listen,
 * transmit, reboot) happy path + a primary failure path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a fake ctx.
 *
 * (The plan text said "15 methods" — the model actually exports 16; every
 * one is covered here.)
 *
 * flipper_zero.ts, lib/serial.ts, lib/protocol.ts, lib/rpc.ts and lib/image.ts
 * are all BYTE-FROZEN — every test here is a characterization test that PINS
 * the model's current, already-shipped behavior (not red-green TDD).
 *
 * ONE seam: `Deno.Command`, which lib/serial.ts uses in a DUAL shape —
 * `.spawn()` -> `{stdin.getWriter(), output(), kill()}` for exchange,
 * captureRpc, listenCapture, sequenceCapture and (in flipper_zero.ts)
 * play-snake's child bot process — AND a direct `.output()` call (no spawn)
 * for listDevNames, sendRpcHold and resolveDenoPath. The stub below installs
 * ONE FakeCommand class exposing both shapes and classifies each call by
 * binary/args/env so a single router can answer every seam a test drives.
 *
 * Toolchain rule (deno 2.8.3 in CI): the seam is installed via
 * `(globalThis as any).Deno.Command = FakeCommand`, never a
 * `as typeof Deno.Command` cast; restored in `finally`
 * (music-library/observability-agent convention).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./flipper_zero.ts";

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

// ---------------------------------------------------------------------------
// Deno.Command dual-shape stub
// ---------------------------------------------------------------------------

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
  /** When true, the spawned child's output() never resolves until kill() is
   * called (simulating a real subprocess that only exits on SIGKILL). */
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

/** Drive a FakeTime-gated call to completion: repeatedly tick virtual time
 * until the result promise settles (headphones-suite convention). */
async function drive<T>(
  time: FakeTime,
  resultPromise: Promise<T>,
  stepMs = 500,
  maxTicks = 20,
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

/** A simple raw exchange fixture: `<cmd>\r\n<body>\r\n>: ` (no banner), the
 * same shape the existing contract-fixture tests use. */
function exchangeRaw(cmd: string, body: string): string {
  return `${cmd}\r\n${body}\r\n>: `;
}

/** Router for a single canned `exchange` response, ignoring the command. */
function singleExchange(body: string): Router {
  return (call, kind) => {
    assertEquals(kind, "exchange");
    return { stdout: exchangeRaw(call.env.FZ_CMD ?? "", body) };
  };
}

// Stateful "loader" fake device, shared by launch/close tests.
function makeLoaderRouter(opts: {
  initialRunning: string | null;
  closeClears?: boolean;
  backClears?: boolean;
  openFails?: string;
}) {
  const state = { running: opts.initialRunning };
  const router: Router = (call, kind) => {
    assertEquals(kind, "exchange");
    const cmd = call.env.FZ_CMD ?? "";
    let body = "";
    if (cmd === "loader info") {
      body = state.running
        ? `Application "${state.running}" is running`
        : "No application is running";
    } else if (cmd === "loader close") {
      if (opts.closeClears) state.running = null;
    } else if (cmd === "input send back release") {
      if (opts.backClears) state.running = null;
    } else if (cmd.startsWith("loader open ")) {
      if (opts.openFails) {
        body = opts.openFails;
      } else {
        state.running = cmd.slice("loader open ".length);
      }
    }
    return { stdout: exchangeRaw(cmd, body) };
  };
  return { state, router };
}

const DEFAULT_CTX_OVERRIDES = { port: "/dev/cu.usbmodemflip_test" };

// ---------------------------------------------------------------------------
// model shape
// ---------------------------------------------------------------------------

Deno.test("model exposes exactly 16 methods", () => {
  const names = Object.keys(model.methods as MethodMap).sort();
  assertEquals(names, [
    "apps",
    "close",
    "detect",
    "exec",
    "info",
    "installed-apps",
    "launch",
    "listen",
    "play-snake",
    "reboot",
    "running",
    "screenshot",
    "show-image",
    "storage-list",
    "storage-read",
    "transmit",
  ]);
});

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

Deno.test("detect: found — auto-detects a flipper node and writes candidates", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => ({ stdout: "cu.usbmodemflip_Zilxi1\nttyS0\n" }),
    async () => {
      await run("detect", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "device-port")!;
  assertEquals(res.payload.port, "/dev/cu.usbmodemflip_Zilxi1");
  assertEquals(res.payload.detected, true);
  assertEquals(res.payload.candidates, ["/dev/cu.usbmodemflip_Zilxi1"]);
});

Deno.test("detect: explicit port override always resolves, regardless of /dev contents", async () => {
  const { ctx, written } = makeCtx({ port: "/dev/cu.custom" });
  await withCommandStub(
    () => ({ stdout: "" }),
    async () => {
      await run("detect", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "device-port")!;
  assertEquals(res.payload.port, "/dev/cu.custom");
  assertEquals(res.payload.detected, true);
  assertEquals(res.payload.candidates, []);
});

Deno.test("detect: throws when nothing looks like a Flipper and no override is given", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    () => ({ stdout: "cu.Bluetooth-Incoming-Port\n" }),
    async () => {
      await assertRejects(
        () => run("detect", {}, ctx),
        Error,
        "No Flipper serial device found",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

Deno.test("info: happy path — parses info device into attributes", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    singleExchange("hardware_model    : F7\nfirmware_version  : 1.3.4"),
    async () => {
      await run("info", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "device-info")!;
  assertEquals(res.payload.command, "info device");
  assertEquals(res.payload.attributes, {
    hardware_model: "F7",
    firmware_version: "1.3.4",
  });
});

Deno.test("info: falls back to device_info when info device is empty/unknown", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const router: Router = (call) => {
    const cmd = call.env.FZ_CMD ?? "";
    if (cmd === "info device") {
      return { stdout: exchangeRaw(cmd, "`info` command not found") };
    }
    return { stdout: exchangeRaw(cmd, "hardware_model    : F7") };
  };
  await withCommandStub(router, async () => {
    await run("info", {}, ctx);
  });
  const res = written.find((w) => w.spec === "device-info")!;
  assertEquals(res.payload.command, "device_info");
  assertEquals(res.payload.attributes, { hardware_model: "F7" });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

Deno.test("exec: happy path — runs a single CLI command", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(singleExchange("1"), async () => {
    await run("exec", { command: "vibro 1" }, ctx);
  });
  const res = written.find((w) => w.spec === "command-output")!;
  assertEquals(res.payload.command, "vibro 1");
  assertEquals(res.payload.output, "1");
});

Deno.test("exec: rejects a multi-line command before any serial exchange", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await assertRejects(
    () => run("exec", { command: "vibro 1\nreboot" }, ctx),
    Error,
    "single line",
  );
});

// ---------------------------------------------------------------------------
// storage-list
// ---------------------------------------------------------------------------

Deno.test("storage-list: happy path — parses dirs and files", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    singleExchange("\t[D] subghz\n\t[F] Manifest 85176b"),
    async () => {
      await run("storage-list", { path: "/ext" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "storage-listing")!;
  assertEquals(res.payload.path, "/ext");
  assertEquals(res.payload.entries, [
    { type: "dir", name: "subghz", size: null },
    { type: "file", name: "Manifest", size: 85176 },
  ]);
});

Deno.test("storage-list: defaults path to /ext", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(singleExchange(""), async () => {
    await run("storage-list", {}, ctx);
  });
  const res = written.find((w) => w.spec === "storage-listing")!;
  assertEquals(res.payload.path, "/ext");
});

// ---------------------------------------------------------------------------
// storage-read
// ---------------------------------------------------------------------------

Deno.test("storage-read: happy path — strips the Size header from content", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    singleExchange("Size: 11\nhello world"),
    async () => {
      await run("storage-read", { path: "/ext/notes.txt" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "file-content")!;
  assertEquals(res.payload.size, 11);
  assertEquals(res.payload.content, "hello world");
});

// ---------------------------------------------------------------------------
// apps
// ---------------------------------------------------------------------------

Deno.test("apps: happy path — lists built-in loader apps", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    singleExchange("Applications:\n\nSnake\nClock"),
    async () => {
      await run("apps", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "app-list")!;
  assertEquals(res.payload.apps, ["Snake", "Clock"]);
});

// ---------------------------------------------------------------------------
// installed-apps
// ---------------------------------------------------------------------------

function makeTreeRouter(opts: {
  treeBody: string;
  subLists?: Record<string, string>;
}): Router {
  return (call, kind) => {
    assertEquals(kind, "exchange");
    const cmd = call.env.FZ_CMD ?? "";
    if (cmd.startsWith("storage tree ")) {
      return { stdout: exchangeRaw(cmd, opts.treeBody) };
    }
    if (cmd.startsWith("storage list ")) {
      const path = cmd.slice("storage list ".length);
      return { stdout: exchangeRaw(cmd, opts.subLists?.[path] ?? "") };
    }
    return { stdout: exchangeRaw(cmd, "") };
  };
}

Deno.test("installed-apps: storage tree happy path", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const treeBody = [
    "\t[D] /ext/apps/Games",
    "\t[F] /ext/apps/Games/snake_game.fap 5840b",
    "\t[D] /ext/apps/Scripts",
    "\t[F] /ext/apps/Scripts/console.js 121b",
  ].join("\n");
  await withCommandStub(makeTreeRouter({ treeBody }), async () => {
    await run("installed-apps", {}, ctx);
  });
  const res = written.find((w) => w.spec === "installed-apps")!;
  assertEquals(res.payload.count, 2);
  assertEquals(res.payload.categories, ["Games", "Scripts"]);
  assertEquals(res.payload.byKind, { fap: 1, js: 1 });
});

Deno.test("installed-apps: falls back to a storage-list walk when storage tree is unknown", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const router = makeTreeRouter({
    treeBody: "`storage` command not found",
    subLists: {
      "/ext/apps": "\t[D] Games\n\t[F] top.js 5b",
      "/ext/apps/Games": "\t[F] snake_game.fap 5840b",
    },
  });
  await withCommandStub(router, async () => {
    await run("installed-apps", {}, ctx);
  });
  const res = written.find((w) => w.spec === "installed-apps")!;
  assertEquals(res.payload.count, 2);
  const apps = res.payload.apps as Array<{ path: string }>;
  assert(apps.some((a) => a.path === "/ext/apps/Games/snake_game.fap"));
  assert(apps.some((a) => a.path === "/ext/apps/top.js"));
});

Deno.test("installed-apps: falls back on an empty tree response too", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const router = makeTreeRouter({
    treeBody: "",
    subLists: { "/ext/apps": "\t[F] only.fap 1b" },
  });
  await withCommandStub(router, async () => {
    await run("installed-apps", {}, ctx);
  });
  const res = written.find((w) => w.spec === "installed-apps")!;
  assertEquals(res.payload.count, 1);
});

Deno.test("installed-apps: falls back on a 'Storage error' tree response", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const router = makeTreeRouter({
    treeBody: "Storage error 5",
    subLists: { "/ext/apps": "\t[F] only.fap 1b" },
  });
  await withCommandStub(router, async () => {
    await run("installed-apps", {}, ctx);
  });
  const res = written.find((w) => w.spec === "installed-apps")!;
  assertEquals(res.payload.count, 1);
});

Deno.test("installed-apps: kind filter narrows the result", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const treeBody = [
    "\t[F] /ext/apps/Games/snake_game.fap 5840b",
    "\t[F] /ext/apps/Scripts/console.js 121b",
  ].join("\n");
  await withCommandStub(makeTreeRouter({ treeBody }), async () => {
    await run("installed-apps", { kind: "js" }, ctx);
  });
  const res = written.find((w) => w.spec === "installed-apps")!;
  assertEquals(res.payload.count, 1);
  assertEquals(res.payload.byKind, { js: 1 });
});

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

Deno.test("launch: idle launch — no app running, loader open succeeds", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({ initialRunning: null });
  await withCommandStub(router, async () => {
    await run("launch", { app: "/ext/apps/Games/snake_game.fap" }, ctx);
  });
  const res = written.find((w) => w.spec === "launch-result")!;
  assertEquals(res.payload.launched, true);
  assertEquals(res.payload.wasRunning, null);
});

Deno.test("launch: throws when another app is running and force is not set", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({ initialRunning: "Snake Game" });
  await withCommandStub(router, async () => {
    await assertRejects(
      () => run("launch", { app: "Clock" }, ctx),
      Error,
      "already running",
    );
  });
});

Deno.test("launch: force closes the running app first, then launches", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({
    initialRunning: "Snake Game",
    closeClears: true,
  });
  const time = new FakeTime();
  try {
    await withCommandStub(router, async () => {
      await drive(time, run("launch", { app: "Clock", force: true }, ctx));
    });
  } finally {
    time.restore();
  }
  const res = written.find((w) => w.spec === "launch-result")!;
  assertEquals(res.payload.launched, true);
  assertEquals(res.payload.wasRunning, "Snake Game");
});

Deno.test({
  name: "launch: throws when the forced close cannot dislodge the running app",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
    const { router } = makeLoaderRouter({
      initialRunning: "Snake Game",
      closeClears: false,
      backClears: false,
    });
    const time = new FakeTime();
    try {
      await withCommandStub(router, async () => {
        await assertRejects(
          () => drive(time, run("launch", { app: "Clock", force: true }, ctx)),
          Error,
          "Could not close",
        );
      });
    } finally {
      time.restore();
    }
  },
});

Deno.test("launch: open-failed throws when loader open prints an error", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({
    initialRunning: null,
    openFails: "Error: application not found",
  });
  await withCommandStub(router, async () => {
    await assertRejects(
      () => run("launch", { app: "Nope" }, ctx),
      Error,
      "Failed to launch",
    );
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

Deno.test("close: already-idle — nothing running, returns immediately", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({ initialRunning: null });
  await withCommandStub(router, async () => {
    await run("close", {}, ctx);
  });
  const res = written.find((w) => w.spec === "close-result")!;
  assertEquals(res.payload.via, "already-idle");
  assertEquals(res.payload.closed, true);
});

Deno.test("close: soft loader-close succeeds", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({
    initialRunning: "Snake Game",
    closeClears: true,
  });
  const time = new FakeTime();
  try {
    await withCommandStub(router, async () => {
      await drive(time, run("close", {}, ctx));
    });
  } finally {
    time.restore();
  }
  const res = written.find((w) => w.spec === "close-result")!;
  assertEquals(res.payload.via, "loader-close");
  assertEquals(res.payload.closed, true);
});

Deno.test("close: escalates to a long Back press when loader close is ignored", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const { router } = makeLoaderRouter({
    initialRunning: "Snake Game",
    closeClears: false,
    backClears: true,
  });
  const time = new FakeTime();
  try {
    await withCommandStub(router, async () => {
      await drive(time, run("close", {}, ctx));
    });
  } finally {
    time.restore();
  }
  const res = written.find((w) => w.spec === "close-result")!;
  assertEquals(res.payload.via, "back-button");
  assertEquals(res.payload.closed, true);
});

Deno.test({
  name: "close: throws when neither loader-close nor Back can dislodge the app",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
    const { router } = makeLoaderRouter({
      initialRunning: "Snake Game",
      closeClears: false,
      backClears: false,
    });
    const time = new FakeTime();
    try {
      await withCommandStub(router, async () => {
        await assertRejects(
          () => drive(time, run("close", {}, ctx)),
          Error,
          "Could not close",
        );
      });
    } finally {
      time.restore();
    }
  },
});

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

Deno.test("running: reports the currently-running app", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    singleExchange('Application "Snake Game" is running'),
    async () => {
      await run("running", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "loader-info")!;
  assertEquals(res.payload.running, true);
  assertEquals(res.payload.app, "Snake Game");
});

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

function screenFrameBytes(fill = 0): Uint8Array {
  const fb = new Uint8Array(1024).fill(fill);
  return new Uint8Array([0x99, 0x0a, 0x80, 0x08, ...fb]);
}

Deno.test("screenshot: happy path — captures and renders the screen", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (_, kind) => {
      assertEquals(kind, "captureRpc");
      return { stdout: screenFrameBytes(0xff) };
    },
    async () => {
      await run("screenshot", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "screenshot")!;
  assertEquals(res.payload.width, 128);
  assertEquals(res.payload.height, 64);
  assert((res.payload.ascii as string).length > 0);
});

Deno.test("screenshot: throws when no frame is captured", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    () => ({ stdout: new Uint8Array([1, 2, 3]) }),
    async () => {
      await assertRejects(
        () => run("screenshot", {}, ctx),
        Error,
        "No screen frame captured",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// show-image
// ---------------------------------------------------------------------------

Deno.test("show-image: draws ASCII art", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (_, kind) => {
      assertEquals(kind, "sendRpcHold");
      return { code: 0 };
    },
    async () => {
      await run("show-image", { ascii: "#" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "image-shown")!;
  assertEquals(res.payload.source, "ascii");
});

Deno.test("show-image: draws a raw framebuffer, honoring invert", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(1024)));
  await withCommandStub(() => ({ code: 0 }), async () => {
    await run(
      "show-image",
      { framebufferBase64: b64, invert: true },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "image-shown")!;
  assertEquals(res.payload.source, "framebuffer");
});

Deno.test("show-image: throws when neither ascii nor framebufferBase64 is given", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await assertRejects(
    () => run("show-image", {}, ctx),
    Error,
    "Provide either",
  );
});

// ---------------------------------------------------------------------------
// play-snake
// ---------------------------------------------------------------------------

function snakeRouter(log: string): Router {
  return (_call, kind) => {
    if (kind === "denoProbe") return { code: 0 };
    if (kind === "snakeChild") return { stdout: log };
    throw new Error(`unexpected call kind ${kind} in play-snake test`);
  };
}

Deno.test("play-snake: happy path — parses the bot's done summary", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES, {
    extensionFile: (p) => p,
  });
  const log =
    'done. 60.0s ticks=120 moves=45 maxLen=12 resyncs=0 decisions={"food":10,"tail":5}\n';
  await withCommandStub(snakeRouter(log), async () => {
    await run("play-snake", { seconds: 60 }, ctx);
  });
  const res = written.find((w) => w.spec === "snake-game")!;
  assertEquals(res.payload.ticks, 120);
  assertEquals(res.payload.moves, 45);
  assertEquals(res.payload.maxLength, 12);
  assertEquals(res.payload.died, false);
  assertEquals(res.payload.decisions, { food: 10, tail: 5 });
});

Deno.test("play-snake: throws when the bot produces no parseable summary", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES, { extensionFile: (p) => p });
  await withCommandStub(snakeRouter("garbage, no summary here"), async () => {
    await assertRejects(
      () => run("play-snake", { seconds: 5 }, ctx),
      Error,
      "produced no result",
    );
  });
});

Deno.test("play-snake: throws when this swamp version exposes no extensionFile", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await assertRejects(
    () => run("play-snake", {}, ctx),
    Error,
    "extensionFile",
  );
});

// ---------------------------------------------------------------------------
// listen
// ---------------------------------------------------------------------------

Deno.test("listen: subghz — captures decoded packets", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const body = [
    "Load_keystore keeloq_mfcodes OK",
    "Listening at frequency: 433920000 device: 0. Press CTRL+C to stop",
    "",
    "Princeton 24bit",
    "Key:0x00ABCDEF",
  ].join("\n");
  await withCommandStub(
    (_, kind) => {
      assertEquals(kind, "listenCapture");
      return { stdout: body };
    },
    async () => {
      await run("listen", { source: "subghz", seconds: 1 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "listen-result")!;
  assertEquals(res.payload.eventCount, 1);
});

Deno.test("listen: nfc — runs the sub-shell sequence and strips splash art", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  const raw = [
    "Welcome to Flipper Zero Command Line Interface!",
    ">: nfc",
    "   0000      0000   ",
    "Welcome to NFC Command Line Interface!",
    "[nfc]>: scanner",
    "Found card: 04A2B3C4",
    "[nfc]>: exit",
    ">: ",
  ].join("\r\n");
  await withCommandStub(
    (_, kind) => {
      assertEquals(kind, "sequenceCapture");
      return { stdout: raw };
    },
    async () => {
      await run("listen", { source: "nfc", seconds: 1 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "listen-result")!;
  assert(
    (res.payload.output as string).includes("Found card: 04A2B3C4"),
  );
});

// ---------------------------------------------------------------------------
// transmit
// ---------------------------------------------------------------------------

Deno.test("transmit: ir tx — one-shot exchange", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(singleExchange(""), async () => {
    await run(
      "transmit",
      { source: "ir", protocol: "NEC", address: "04", command: "08" },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "transmit-result")!;
  assertEquals(res.payload.command, "ir tx NEC 04 08");
  assertEquals(res.payload.mode, "tx");
});

Deno.test("transmit: rfid emulate — time-boxed listenCapture", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (_, kind) => {
      assertEquals(kind, "listenCapture");
      return { stdout: "" };
    },
    async () => {
      await run(
        "transmit",
        { source: "rfid", keyType: "EM4100", keyData: "1234567890" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "transmit-result")!;
  assertEquals(res.payload.mode, "emulate");
});

Deno.test("transmit: throws when the device rejects the command", async () => {
  const { ctx } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(singleExchange("Error: invalid protocol"), async () => {
    await assertRejects(
      () =>
        run(
          "transmit",
          { source: "ir", protocol: "NEC", address: "04", command: "08" },
          ctx,
        ),
      Error,
      "Transmit rejected",
    );
  });
});

// ---------------------------------------------------------------------------
// reboot
// ---------------------------------------------------------------------------

Deno.test("reboot: requests a reboot without waiting for a prompt", async () => {
  const { ctx, written } = makeCtx(DEFAULT_CTX_OVERRIDES);
  await withCommandStub(
    (_, kind) => {
      assertEquals(kind, "exchange");
      return { stdout: "" };
    },
    async () => {
      await run("reboot", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "reboot-result")!;
  assertEquals(res.payload.requested, true);
});
