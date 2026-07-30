/**
 * Method-level tests for @magistr/observability/agent — every one of the 4
 * methods (install, configure, status, inventory) happy path + failure path,
 * plus configure's two branch-specific behaviors: the vector-skipped branch
 * (logsEndpoint unset) and the fail-loud "service not active" throw.
 *
 * observability_agent.ts is UNMODIFIED — every test here is a
 * characterization test pinning current, already-shipped behavior (not
 * red-green TDD; this is a test-only backfill). Doc drift note (found-bug
 * #6, tracked in the LOCAL observability-agent-rce bug model): README.md and
 * manifest.yaml document only 3 methods (install/configure/status) — the
 * model actually has 4; `inventory` is undocumented. This suite deliberately
 * covers all 4, since the model source is the source of truth.
 *
 * The `Deno.Command` boundary is stubbed (talm-cluster dual-shape stub); no
 * `setTimeout`/`FakeTime` stub is needed anywhere in this model — the only
 * "sleep" (`sleep 2`) lives INSIDE the remote bash script string, never as a
 * local JS timer, and the only nondeterminism (`new Date().toISOString()`)
 * is asserted as `typeof === "string"`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

// ---------------------------------------------------------------------------
// Model shape — doc-drift note (found-bug #6): 4 methods exist, README/
// manifest document only 3.
// ---------------------------------------------------------------------------

Deno.test("model exposes exactly 4 methods: install, configure, status, inventory", () => {
  const names = Object.keys(model.methods as MethodMap).sort();
  assertEquals(names, ["configure", "install", "inventory", "status"]);
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

Deno.test("install: happy path — writes an install resource parsed from stdout", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=1.7.0\nBLACKBOX=0.25.0\nVECTOR=0.46.1\n",
      stderr: "",
    },
    async (calls) => {
      await run("install", {}, ctx);
      assertEquals(calls.length, 1);
    },
  );
  const res = written.find((w) => w.spec === "install")!;
  assertEquals(res.payload.nodeExporter, "1.7.0");
  assertEquals(res.payload.blackbox, "0.25.0");
  assertEquals(res.payload.vector, "0.46.1");
  assertEquals(typeof res.payload.timestamp, "string");
});

Deno.test("install: missing KEY=value lines fall back to 'unknown' per field", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { success: true, stdout: "NODE=1.7.0\n", stderr: "" },
    async () => {
      await run("install", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "install")!;
  assertEquals(res.payload.nodeExporter, "1.7.0");
  assertEquals(res.payload.blackbox, "unknown");
  assertEquals(res.payload.vector, "unknown");
});

Deno.test("install: failure path — a non-zero ssh exit rejects with 'SSH script failed on <host> (exit 1)'", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { success: false, stdout: "", stderr: "apt-get: package not found" },
    async () => {
      await assertRejects(
        () => run("install", {}, ctx),
        Error,
        "SSH script failed on host.example (exit 1)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

Deno.test("configure: happy path (vector configured) — writes a config resource, custom logFiles honored", async () => {
  const { ctx, written } = makeCtx({
    logsEndpoint: "http://198.51.100.20:9428/insert/elasticsearch/",
  });
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=active\n",
      stderr: "",
    },
    async () => {
      await run("configure", { logFiles: ["/var/log/custom.log"] }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "config")!;
  assertEquals(res.payload.vectorConfigured, true);
  assertEquals(res.payload.logFiles, ["/var/log/custom.log"]);
});

Deno.test("configure: logFiles defaults to the documented nginx/syslog trio when omitted", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async () => {
      await run("configure", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "config")!;
  assertEquals(res.payload.logFiles, [
    "/var/log/nginx/access.log",
    "/var/log/nginx/error.log",
    "/var/log/syslog",
  ]);
});

Deno.test("configure: vector-skipped branch — logsEndpoint unset, VECTOR=skipped accepted (not a failure)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async () => {
      await run("configure", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "config")!;
  assertEquals(res.payload.vectorConfigured, false);
});

Deno.test("configure: fail-loud — a non-active service after restart throws 'Service(s) not active after configure: ...'", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=failed\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async () => {
      await assertRejects(
        () => run("configure", {}, ctx),
        Error,
        "Service(s) not active after configure: NODE=failed",
      );
    },
  );
});

Deno.test("configure: pin — writeResource is called BEFORE the fail-loud guard, so a config resource IS written even though the call ultimately rejects (partial-success-then-throw)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=failed\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async () => {
      await assertRejects(() => run("configure", {}, ctx), Error);
    },
  );
  const res = written.find((w) => w.spec === "config");
  assert(
    res !== undefined,
    "a config resource is written despite the eventual throw — the fail-loud " +
      "guard runs strictly AFTER writeResource, characterizing a real " +
      "already-shipped write-before-validate ordering (not fixed here, " +
      "source frozen)",
  );
  assertEquals(res!.payload.bindAddress, "0.0.0.0");
});

Deno.test("configure: failure path — a non-zero ssh exit rejects before any resource is written", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { success: false, stdout: "", stderr: "systemctl: unit not found" },
    async () => {
      await assertRejects(() => run("configure", {}, ctx), Error);
    },
  );
  assertEquals(written.length, 0, "no config resource on ssh failure");
});

// ---------------------------------------------------------------------------
// status — no try/catch, an ssh-level failure propagates unmodified
// ---------------------------------------------------------------------------

Deno.test("status: happy path — writes a status resource with services + listeners", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout:
        "svc.node=active\nsvc.blackbox=active\nsvc.vector=inactive\nlst.node=ok\nlst.blackbox=fail\n",
      stderr: "",
    },
    async () => {
      await run("status", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.services, {
    nodeExporter: "active",
    blackbox: "active",
    vector: "inactive",
  });
  assertEquals(res.payload.listeners, { nodeExporter: true, blackbox: false });
});

Deno.test("status: failure path — ssh-level failure propagates (no try/catch in this method)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      success: false,
      stdout: "",
      stderr: "ssh: connect to host port 22: Connection refused",
    },
    async () => {
      await assertRejects(
        () => run("status", {}, ctx),
        Error,
        "SSH script failed on host.example (exit 1)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// inventory — no try/catch, an ssh-level failure propagates
// ---------------------------------------------------------------------------

Deno.test("inventory: happy path — writes an inventory resource with services/listeners/processes", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout:
        '===SERVICES===\nssh.service\n===LISTENERS===\ntcp   LISTEN 0      128        0.0.0.0:22             0.0.0.0:*    users:(("sshd",pid=1,fd=3))\n===PROCS===\n      1 sshd\n',
      stderr: "",
    },
    async () => {
      await run("inventory", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "inventory")!;
  assertEquals(res.payload.runningServices, ["ssh.service"]);
  assertEquals(res.payload.serviceCount, 1);
  assertEquals(res.payload.listenerCount, 1);
  assertEquals(
    (res.payload.listeners as { process: string }[])[0].process,
    "sshd",
  );
  assertEquals(res.payload.processes, [{ name: "sshd", count: 1 }]);
});

Deno.test("inventory: failure path — ssh-level failure propagates (no try/catch in this method)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      success: false,
      stdout: "",
      stderr: "ssh: Host key verification failed.",
    },
    async () => {
      await assertRejects(
        () => run("inventory", {}, ctx),
        Error,
        "SSH script failed on host.example (exit 1)",
      );
    },
  );
});
