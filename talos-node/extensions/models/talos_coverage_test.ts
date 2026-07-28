/**
 * Coverage suite: both sides of every guard in talos.ts that the contract,
 * methods, and adversarial suites don't already exercise on both sides — the
 * two `checks` (talosctl-available, talosconfig-exists), `isTransientError`
 * (private — observed indirectly through the retry behavior it gates),
 * version's parse fallbacks, health's stdout fallback, the apply/patch
 * stderr-warnings branch, and the reboot/reset/shutdown/upgrade/applyConfig
 * flag conditionals' DEFAULT (false) side. Deleting any one of these guards
 * must turn a test red (STANDARD.md's coverage role).
 *
 * talos.ts is UNMODIFIED; every test PINS existing behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./talos.ts";

const ENDPOINT = "192.0.2.10";
const GLOBAL_ARGS = { endpoint: ENDPOINT, insecure: false };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
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
  return method.execute(method.arguments.parse(args), ctx);
}

type CheckMap = Record<string, {
  execute: (c?: unknown) => Promise<{ pass: boolean; errors?: string[] }>;
}>;

function runCheck(name: string, ctx?: unknown) {
  const check = (model.checks as CheckMap)[name];
  return check.execute(ctx);
}

type CommandEnvelope = { success: boolean; stdout: string; stderr: string };
type CommandRecording = { cmd: string; args: string[] };

function withCommandStub(
  handler: (
    call: CommandRecording,
    callIndex: number,
  ) => CommandEnvelope | Promise<CommandEnvelope>,
  fn: (calls: CommandRecording[]) => Promise<void>,
) {
  const denoRecord = Deno as unknown as Record<string, unknown>;
  const original = denoRecord.Command;
  const calls: CommandRecording[] = [];
  let index = 0;
  class FakeCommand {
    #recording: CommandRecording;
    constructor(cmd: string, options: { args?: string[] }) {
      this.#recording = { cmd, args: options.args ?? [] };
    }
    output(): Promise<
      { success: boolean; stdout: Uint8Array; stderr: Uint8Array }
    > {
      calls.push(this.#recording);
      const i = index++;
      return Promise.resolve(handler(this.#recording, i)).then((r) => ({
        success: r.success,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      }));
    }
  }
  denoRecord.Command = FakeCommand;
  return fn(calls).finally(() => {
    denoRecord.Command = original;
  });
}

function withOneCommand(
  envelope: CommandEnvelope,
  fn: (calls: CommandRecording[]) => Promise<void>,
) {
  return withCommandStub(() => envelope, fn);
}

/** Simulate the Deno.Command CONSTRUCTOR/spawn itself throwing (binary not
 * found), as opposed to the command running and exiting non-zero. */
function withThrowingCommand(fn: () => Promise<void>) {
  const denoRecord = Deno as unknown as Record<string, unknown>;
  const original = denoRecord.Command;
  class ThrowingCommand {
    constructor() {
      throw new Error("No such file or directory (os error 2)");
    }
  }
  denoRecord.Command = ThrowingCommand;
  return fn().finally(() => {
    denoRecord.Command = original;
  });
}

function withStatStub(
  impl: (path: string | URL) => Promise<unknown>,
  fn: () => Promise<void>,
) {
  const denoRecord = Deno as unknown as Record<string, unknown>;
  const original = denoRecord.stat;
  denoRecord.stat = impl;
  return fn().finally(() => {
    denoRecord.stat = original;
  });
}

function withSyncSetTimeout(fn: () => Promise<void>) {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const original = globalRecord.setTimeout;
  globalRecord.setTimeout = (
    (cb: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      cb(...args);
      return 0 as unknown as number;
    }
  ) as unknown as typeof globalThis.setTimeout;
  return fn().finally(() => {
    globalRecord.setTimeout = original;
  });
}

const OK = (stdout = ""): CommandEnvelope => ({
  success: true,
  stdout,
  stderr: "",
});
const FAIL = (stderr: string): CommandEnvelope => ({
  success: false,
  stdout: "",
  stderr,
});
const ENDPOINT_SUFFIX = ["--endpoints", ENDPOINT, "--nodes", ENDPOINT];

// ---------------------------------------------------------------------------
// Guard: talosctl-available check — both sides + the throw path
// ---------------------------------------------------------------------------

Deno.test("check talosctl-available: binary present and exits 0 -> pass:true", async () => {
  await withOneCommand(OK("Client:\n\tTag: v1.9.5\n"), async () => {
    const result = await runCheck("talosctl-available");
    assertEquals(result, { pass: true });
  });
});

Deno.test("check talosctl-available: binary present but exits non-zero -> pass:false with a generic error", async () => {
  await withOneCommand(FAIL("some client error"), async () => {
    const result = await runCheck("talosctl-available");
    assertEquals(result.pass, false);
    assertEquals(result.errors, ["talosctl binary found but returned error"]);
  });
});

Deno.test("check talosctl-available: Deno.Command construction throws -> pass:false 'binary not found in PATH'", async () => {
  await withThrowingCommand(async () => {
    const result = await runCheck("talosctl-available");
    assertEquals(result.pass, false);
    assertEquals(result.errors, ["talosctl binary not found in PATH"]);
  });
});

// ---------------------------------------------------------------------------
// Guard: talosconfig-exists check — unset / present / missing
// ---------------------------------------------------------------------------

Deno.test("check talosconfig-exists: talosconfig unset -> pass:true without ever calling Deno.stat", async () => {
  let statCalled = false;
  await withStatStub(
    () => {
      statCalled = true;
      return Promise.resolve({});
    },
    async () => {
      const result = await runCheck("talosconfig-exists", {
        globalArgs: GLOBAL_ARGS,
      });
      assertEquals(result, { pass: true });
    },
  );
  assert(
    !statCalled,
    "the unset-talosconfig short-circuit must skip Deno.stat entirely",
  );
});

Deno.test("check talosconfig-exists: talosconfig set and Deno.stat resolves -> pass:true", async () => {
  await withStatStub(
    () => Promise.resolve({}),
    async () => {
      const result = await runCheck("talosconfig-exists", {
        globalArgs: { ...GLOBAL_ARGS, talosconfig: "/fake/.talos/config" },
      });
      assertEquals(result, { pass: true });
    },
  );
});

Deno.test("check talosconfig-exists: talosconfig set and Deno.stat rejects -> pass:false naming the path", async () => {
  await withStatStub(
    () => Promise.reject(new Error("ENOENT")),
    async () => {
      const result = await runCheck("talosconfig-exists", {
        globalArgs: { ...GLOBAL_ARGS, talosconfig: "/fake/.talos/config" },
      });
      assertEquals(result.pass, false);
      assertEquals(result.errors, [
        "talosconfig not found: /fake/.talos/config",
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// Guard: isTransientError (private — observed indirectly via retry behavior)
// ---------------------------------------------------------------------------

const TRANSIENT_SUBSTRINGS = [
  "connection refused",
  "connection reset",
  "connection error",
  "Unavailable",
  "deadline exceeded",
  "i/o timeout",
  "transport is closing",
];

for (const substring of TRANSIENT_SUBSTRINGS) {
  Deno.test(`isTransientError match: an error containing "${substring}" triggers a retry (bootstrap succeeds on attempt 2)`, async () => {
    const { ctx, written } = makeCtx();
    await withSyncSetTimeout(async () => {
      await withCommandStub(
        (_call, i) =>
          i === 0
            ? FAIL(`rpc error: code = X desc = ${substring} while dialing`)
            : OK(),
        async (calls) => {
          await run("bootstrap", {}, ctx);
          assertEquals(
            calls.length,
            2,
            `"${substring}" must be treated as transient`,
          );
        },
      );
    });
    const res = written.find((w) => w.spec === "result")!;
    assertEquals(res.payload.success, true);
  });
}

Deno.test("isTransientError no-match: an error with none of the known substrings does NOT retry", async () => {
  await withCommandStub(
    () => FAIL("rpc error: code = PermissionDenied desc = access denied"),
    async (calls) => {
      const { ctx } = makeCtx();
      // Assert the SPECIFIC expected error, not just "something threw" — a
      // bare try/catch would also pass if an unrelated bug threw a different
      // error, silently hiding a regression.
      await assertRejects(
        () => run("bootstrap", {}, ctx),
        Error,
        "talosctl bootstrap failed: rpc error: code = PermissionDenied desc = access denied",
      );
      assertEquals(
        calls.length,
        1,
        "an unrecognized error text must not trigger a retry",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Guard: version's `data.version || data.server?.version || {}` fallback
// ---------------------------------------------------------------------------

Deno.test("version fallback: data.version WINS when both data.version and data.server.version are present", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK(
      JSON.stringify({
        version: { tag: "v1.9.5" },
        server: { version: { tag: "v0.0.1-should-not-win" } },
      }),
    ),
    async () => {
      await run("version", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.tag, "v1.9.5");
});

Deno.test("version fallback: data.server.version is used when data.version is ABSENT", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK(JSON.stringify({ server: { version: { tag: "v1.8.0" } } })),
    async () => {
      await run("version", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.tag, "v1.8.0");
});

Deno.test("version fallback: ver.tag ABSENT (but version object present) falls back to 'unknown'", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(JSON.stringify({ version: {} })), async () => {
    await run("version", {}, ctx);
  });
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.tag, "unknown");
});

Deno.test("version fallback: platform ABSENT entirely -> payload.platform is undefined", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK(JSON.stringify({ version: { tag: "v1.9.5" } })),
    async () => {
      await run("version", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.platform, undefined);
});

Deno.test("version fallback: platform PRESENT with a name -> payload.platform is that name", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK(
      JSON.stringify({
        version: { tag: "v1.9.5" },
        platform: { name: "metal" },
      }),
    ),
    async () => {
      await run("version", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.platform, "metal");
});

// ---------------------------------------------------------------------------
// Guard: health's `stdout.trim() || "Cluster healthy"` fallback
// ---------------------------------------------------------------------------

Deno.test("health fallback: non-empty stdout is used verbatim (trimmed) as the message", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK("  all systems healthy  \n"), async () => {
    await run("health", {}, ctx);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.message, "all systems healthy");
});

Deno.test("health fallback: empty/whitespace-only stdout falls back to 'Cluster healthy'", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK("   \n"), async () => {
    await run("health", {}, ctx);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.message, "Cluster healthy");
});

// ---------------------------------------------------------------------------
// Guard: apply/patch `stderr ? split/filter : []` warnings branch
// ---------------------------------------------------------------------------

Deno.test('applyConfig warnings: empty stderr -> warnings: [] (not undefined, not [""])', async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async () => {
    await run(
      "applyConfig",
      { configFile: "/fake/x.yaml", mode: "auto" },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.warnings, []);
});

Deno.test("patchConfig warnings: empty stderr -> warnings: []", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async () => {
    await run(
      "patchConfig",
      { patchFile: "/fake/patch.yaml", mode: "auto" },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.warnings, []);
});

Deno.test("patchConfig warnings: non-empty stderr -> warnings is the trimmed, non-empty split lines", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    { success: true, stdout: "", stderr: "warning: one\nwarning: two\n" },
    async () => {
      await run(
        "patchConfig",
        { patchFile: "/fake/patch.yaml", mode: "auto" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.payload.warnings, ["warning: one", "warning: two"]);
});

// ---------------------------------------------------------------------------
// Guard: reboot/reset/shutdown/upgrade/applyConfig flag conditionals —
// the DEFAULT (false) side. The methods suite already exercises the
// non-default (true) side for each of these.
// ---------------------------------------------------------------------------

Deno.test("reboot: mode='default' (schema default) omits --mode from argv", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("reboot", {}, ctx);
    assertEquals(calls[0].args, ["reboot", ...ENDPOINT_SUFFIX]);
  });
});

Deno.test("shutdown: force=false (schema default) omits --force from argv", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("shutdown", {}, ctx);
    assertEquals(calls[0].args, ["shutdown", ...ENDPOINT_SUFFIX]);
  });
});

Deno.test("reset: graceful=true (schema default) omits --graceful=false from argv", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("reset", {}, ctx);
    assertEquals(calls[0].args, ["reset", ...ENDPOINT_SUFFIX]);
  });
});

Deno.test("upgrade: preserve=false (schema default) omits --preserve from argv", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run(
      "upgrade",
      { image: "ghcr.io/siderolabs/installer:v1.9.5" },
      ctx,
    );
    assertEquals(calls[0].args, [
      "upgrade",
      "--image",
      "ghcr.io/siderolabs/installer:v1.9.5",
      ...ENDPOINT_SUFFIX,
    ]);
  });
});

Deno.test("applyConfig: insecure=false (schema default, no override) omits --insecure from argv", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run(
      "applyConfig",
      { configFile: "/fake/x.yaml", mode: "auto" },
      ctx,
    );
    assertEquals(calls[0].args, [
      "apply-config",
      "--file",
      "/fake/x.yaml",
      "--mode",
      "auto",
      ...ENDPOINT_SUFFIX,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Guard: every documented enum value is still accepted by its schema
// ---------------------------------------------------------------------------

Deno.test("every documented reboot mode value is still accepted by the schema", () => {
  const method = (model.methods as MethodMap).reboot;
  for (const mode of ["default", "powercycle"]) {
    const parsed = method.arguments.parse({ mode }) as { mode: string };
    assertEquals(parsed.mode, mode);
  }
});

Deno.test("every documented apply/patch mode value is still accepted by the schema", () => {
  const applyMethod = (model.methods as MethodMap).applyConfig;
  const patchMethod = (model.methods as MethodMap).patchConfig;
  for (const mode of ["auto", "reboot", "no-reboot", "staged"]) {
    const applyParsed = applyMethod.arguments.parse({
      configFile: "/fake/x.yaml",
      mode,
    }) as { mode: string };
    assertEquals(applyParsed.mode, mode);
    const patchParsed = patchMethod.arguments.parse({
      patchFile: "/fake/patch.yaml",
      mode,
    }) as { mode: string };
    assertEquals(patchParsed.mode, mode);
  }
});
