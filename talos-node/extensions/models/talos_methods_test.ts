/**
 * Method-level tests for @magistr/talos-node — every one of the 12 methods
 * (version, services, etcdMembers, kubeconfig, applyConfig, bootstrap,
 * reboot, shutdown, reset, upgrade, patchConfig, health), happy path + error
 * path, driven through `model.methods.<m>.arguments.parse()` + `.execute()`
 * against a stubbed `Deno.Command` and a fake context.
 *
 * talos.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Each happy-path test asserts the exact argv `talosctl()` builds (so a
 * future argv-shape regression turns a test red) and the written resource.
 * A final sweep asserts kubeconfig content and the talosconfig path never
 * leak into an unrelated method's written resources or thrown errors.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./talos.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENDPOINT = "192.0.2.10";
const GLOBAL_ARGS = { endpoint: ENDPOINT, insecure: false };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
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
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied,
 * enums enforced) before execute is invoked — never call execute() with raw,
 * unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
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

/** Standard argv suffix `talosctl()` appends after the command-specific
 * positional args, given GLOBAL_ARGS (insecure=false, no talosconfig). */
const ENDPOINT_SUFFIX = ["--endpoints", ENDPOINT, "--nodes", ENDPOINT];

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

Deno.test("version: happy path — argv is [version, --json, ...endpoint suffix], writes version/main", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK('{"version":{"tag":"v1.9.5","sha":"8f61e6dd","arch":"amd64"}}'),
    async (calls) => {
      await run("version", {}, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args, ["version", "--json", ...ENDPOINT_SUFFIX]);
    },
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.tag, "v1.9.5");
});

Deno.test("version: error path — non-zero exit throws 'talosctl version failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("version", {}, ctx),
      Error,
      "talosctl version failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------

Deno.test("services: happy path — argv is [services, ...endpoint suffix], writes one service resource per row", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK("NODE   SERVICE   STATE     HEALTH\n192.0.2.10   apid   Running   OK\n"),
    async (calls) => {
      await run("services", {}, ctx);
      assertEquals(calls[0].args, ["services", ...ENDPOINT_SUFFIX]);
    },
  );
  const res = written.find((w) => w.spec === "service")!;
  assertEquals(res.name, "apid");
  assertEquals(res.payload.state, "Running");
  assertEquals(res.payload.health, "OK");
});

Deno.test("services: error path — non-zero exit throws 'talosctl services failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("services", {}, ctx),
      Error,
      "talosctl services failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// etcdMembers
// ---------------------------------------------------------------------------

Deno.test("etcdMembers: happy path — argv is [etcd, members, ...endpoint suffix], writes one etcdMember per row", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    OK(
      "NODE   ID   HOSTNAME   PEER   CLIENT   LEARNER\n192.0.2.10   abc123   cp1   https://192.0.2.10:2380   https://192.0.2.10:2379   false\n",
    ),
    async (calls) => {
      await run("etcdMembers", {}, ctx);
      assertEquals(calls[0].args, ["etcd", "members", ...ENDPOINT_SUFFIX]);
    },
  );
  const res = written.find((w) => w.spec === "etcdMember")!;
  assertEquals(res.name, "cp1");
  assertEquals(res.payload.id, "abc123");
  assertEquals(res.payload.isLearner, false);
});

Deno.test("etcdMembers: error path — throws 'talosctl etcd failed: <stderr>' (args[0] is 'etcd', not 'etcd members')", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("etcdMembers", {}, ctx),
      Error,
      "talosctl etcd failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// kubeconfig
// ---------------------------------------------------------------------------

Deno.test("kubeconfig: happy path — argv is [kubeconfig, -, ...endpoint suffix], writes the raw stdout verbatim", async () => {
  const { ctx, written } = makeCtx();
  const KUBECONFIG_TEXT = "apiVersion: v1\nkind: Config\n";
  await withOneCommand(OK(KUBECONFIG_TEXT), async (calls) => {
    await run("kubeconfig", {}, ctx);
    assertEquals(calls[0].args, ["kubeconfig", "-", ...ENDPOINT_SUFFIX]);
  });
  const res = written.find((w) => w.spec === "kubeconfig")!;
  assertEquals(res.name, "main");
  assertEquals(res.payload.kubeconfig, KUBECONFIG_TEXT);
});

Deno.test("kubeconfig: error path — throws 'talosctl kubeconfig failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("kubeconfig", {}, ctx),
      Error,
      "talosctl kubeconfig failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// applyConfig
// ---------------------------------------------------------------------------

Deno.test("applyConfig: happy path with insecure override — argv includes --insecure even though the global default is false", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("applyConfig", {
      configFile: "/fake/controlplane.yaml",
      mode: "auto",
      insecure: true,
    }, ctx);
    assertEquals(calls[0].args, [
      "apply-config",
      "--file",
      "/fake/controlplane.yaml",
      "--mode",
      "auto",
      "--insecure",
      ...ENDPOINT_SUFFIX,
    ]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "applyConfig");
  assertEquals(res.payload.success, true);
  assertEquals(
    res.payload.message,
    `Config applied to ${ENDPOINT} (mode=auto)`,
  );
  assertEquals(res.payload.warnings, []);
});

Deno.test("applyConfig: error path — throws 'talosctl apply-config failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: invalid config"), async () => {
    await assertRejects(
      () =>
        run("applyConfig", {
          configFile: "/fake/controlplane.yaml",
          mode: "auto",
        }, ctx),
      Error,
      "talosctl apply-config failed: rpc error: invalid config",
    );
  });
});

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

Deno.test("bootstrap: happy path — argv is [bootstrap, ...endpoint suffix], writes result/bootstrap", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("bootstrap", {}, ctx);
    assertEquals(calls[0].args, ["bootstrap", ...ENDPOINT_SUFFIX]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "bootstrap");
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, `Bootstrap initiated on ${ENDPOINT}`);
});

Deno.test("bootstrap: error path — throws 'talosctl bootstrap failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: already bootstrapped"), async () => {
    await assertRejects(
      () => run("bootstrap", {}, ctx),
      Error,
      "talosctl bootstrap failed: rpc error: already bootstrapped",
    );
  });
});

// ---------------------------------------------------------------------------
// reboot
// ---------------------------------------------------------------------------

Deno.test("reboot: happy path with mode=powercycle — argv includes --mode powercycle", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("reboot", { mode: "powercycle" }, ctx);
    assertEquals(calls[0].args, [
      "reboot",
      "--mode",
      "powercycle",
      ...ENDPOINT_SUFFIX,
    ]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "reboot");
  assertEquals(
    res.payload.message,
    `Reboot (powercycle) initiated on ${ENDPOINT}`,
  );
});

Deno.test("reboot: error path — throws 'talosctl reboot failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("reboot", {}, ctx),
      Error,
      "talosctl reboot failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

Deno.test("shutdown: happy path with force=true — argv includes --force", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("shutdown", { force: true }, ctx);
    assertEquals(calls[0].args, ["shutdown", "--force", ...ENDPOINT_SUFFIX]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "shutdown");
  assertEquals(res.payload.message, `Shutdown initiated on ${ENDPOINT}`);
});

Deno.test("shutdown: error path — throws 'talosctl shutdown failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("shutdown", {}, ctx),
      Error,
      "talosctl shutdown failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

Deno.test("reset: happy path with graceful=false — argv includes --graceful=false", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("reset", { graceful: false }, ctx);
    assertEquals(calls[0].args, [
      "reset",
      "--graceful=false",
      ...ENDPOINT_SUFFIX,
    ]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "reset");
  assertEquals(
    res.payload.message,
    `Reset initiated on ${ENDPOINT} (graceful=false)`,
  );
});

Deno.test("reset: error path — throws 'talosctl reset failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("reset", {}, ctx),
      Error,
      "talosctl reset failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

Deno.test("upgrade: happy path with preserve=true — argv includes --preserve", async () => {
  const { ctx, written } = makeCtx();
  const image = "ghcr.io/siderolabs/installer:v1.9.5";
  await withOneCommand(OK(), async (calls) => {
    await run("upgrade", { image, preserve: true }, ctx);
    assertEquals(calls[0].args, [
      "upgrade",
      "--image",
      image,
      "--preserve",
      ...ENDPOINT_SUFFIX,
    ]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "upgrade");
  assertEquals(
    res.payload.message,
    `Upgrade to ${image} initiated on ${ENDPOINT}`,
  );
});

Deno.test("upgrade: error path — throws 'talosctl upgrade failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () =>
        run("upgrade", { image: "ghcr.io/siderolabs/installer:v1.9.5" }, ctx),
      Error,
      "talosctl upgrade failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// patchConfig
// ---------------------------------------------------------------------------

Deno.test("patchConfig: happy path — argv is [patch, machineconfig, --patch-file, <file>, --mode, <mode>, ...endpoint suffix]", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK(), async (calls) => {
    await run("patchConfig", {
      patchFile: "/fake/patch.yaml",
      mode: "no-reboot",
    }, ctx);
    assertEquals(calls[0].args, [
      "patch",
      "machineconfig",
      "--patch-file",
      "/fake/patch.yaml",
      "--mode",
      "no-reboot",
      ...ENDPOINT_SUFFIX,
    ]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "patchConfig");
  assertEquals(
    res.payload.message,
    `Config patched on ${ENDPOINT} (mode=no-reboot)`,
  );
  assertEquals(res.payload.warnings, []);
});

Deno.test("patchConfig: error path — throws 'talosctl patch failed: <stderr>' (args[0] is 'patch', not 'patch machineconfig')", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () =>
        run(
          "patchConfig",
          { patchFile: "/fake/patch.yaml", mode: "auto" },
          ctx,
        ),
      Error,
      "talosctl patch failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

Deno.test("health: happy path — argv is [health, --wait-timeout, <timeout>, ...endpoint suffix]", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(OK("all systems healthy\n"), async (calls) => {
    await run("health", { waitTimeout: "2m" }, ctx);
    assertEquals(calls[0].args, [
      "health",
      "--wait-timeout",
      "2m",
      ...ENDPOINT_SUFFIX,
    ]);
  });
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "health");
  assertEquals(res.payload.message, "all systems healthy");
});

Deno.test("health: error path — throws 'talosctl health failed: <stderr>'", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(FAIL("rpc error: unavailable"), async () => {
    await assertRejects(
      () => run("health", {}, ctx),
      Error,
      "talosctl health failed: rpc error: unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-method sweep: kubeconfig content + talosconfig path never leak
// ---------------------------------------------------------------------------

const TALOSCONFIG_PATH = "/home/fixture-user/.talos/config-do-not-leak";
const KUBECONFIG_SENTINEL = "SENTINEL-KUBECONFIG-CONTENT-9f2c1a";

Deno.test("sweep: kubeconfig content and the talosconfig path never appear in any OTHER method's written resource or thrown error", async () => {
  const globalArgs = {
    endpoint: ENDPOINT,
    insecure: false,
    talosconfig: TALOSCONFIG_PATH,
  };
  const { ctx, written } = makeCtx(globalArgs);

  await withCommandStub(
    (call) => {
      switch (call.args[0]) {
        case "kubeconfig":
          return OK(KUBECONFIG_SENTINEL);
        case "version":
          return OK("{}");
        case "services":
          return OK("NODE SERVICE STATE HEALTH\n");
        case "etcd":
          return OK("NODE ID HOSTNAME PEER CLIENT LEARNER\n");
        default:
          return OK("");
      }
    },
    async () => {
      await run("kubeconfig", {}, ctx);
      await run("version", {}, ctx);
      await run("services", {}, ctx);
      await run("etcdMembers", {}, ctx);
      await run("applyConfig", {
        configFile: "/fake/controlplane.yaml",
        mode: "auto",
      }, ctx);
      await run("bootstrap", {}, ctx);
      await run("reboot", {}, ctx);
      await run("shutdown", {}, ctx);
      await run("reset", {}, ctx);
      await run(
        "upgrade",
        { image: "ghcr.io/siderolabs/installer:v1.9.5" },
        ctx,
      );
      await run(
        "patchConfig",
        { patchFile: "/fake/patch.yaml", mode: "auto" },
        ctx,
      );
      await run("health", {}, ctx);
    },
  );

  for (const w of written) {
    const s = JSON.stringify(w.payload);
    if (w.spec !== "kubeconfig") {
      assert(
        !s.includes(KUBECONFIG_SENTINEL),
        `${w.spec}/${w.name}: kubeconfig content leaked outside the kubeconfig resource`,
      );
    }
    assert(
      !s.includes(TALOSCONFIG_PATH),
      `${w.spec}/${w.name}: talosconfig path leaked into a written resource`,
    );
  }
});

Deno.test("pin: no method calls the logger at all today (a future change that starts logging must add its own leak test)", async () => {
  // Swept across a representative read method AND a representative
  // destructive method — talos.ts never references context.logger anywhere,
  // so this must hold regardless of which method runs, not just one.
  const { ctx, logs } = makeCtx();
  await withOneCommand(OK("{}"), async () => {
    await run("version", {}, ctx);
  });
  await withOneCommand(OK(), async () => {
    await run("bootstrap", {}, ctx);
  });
  await withOneCommand(OK(), async () => {
    await run("applyConfig", {
      configFile: "/fake/x.yaml",
      mode: "auto",
    }, ctx);
  });
  assertEquals(logs.length, 0);
});
