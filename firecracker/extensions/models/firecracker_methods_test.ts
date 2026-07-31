/**
 * Method-level tests for @magistr/firecracker — every one of the 27 methods'
 * happy path, plus both pre-flight checks (`valid-ssh-host`, `host-reachable`).
 *
 * firecracker.ts / lib/ssh.ts are UNMODIFIED — every test here is a
 * characterization test pinning current, already-shipped behavior (not
 * red-green TDD; this is a test-only backfill, per ext-quality-bf-firecracker).
 *
 * Failure-path / non-zero-exit sweeps, the FC-4xx (fault_message) throw path,
 * hostile-schema rejection, and the mechanical OAuth-token secret-scan live in
 * firecracker_adversarial_test.ts — this suite is happy-path-only so it stays
 * readable at 27-methods scale. Regression-only edge cases (netns↔root sweep,
 * stop idempotency, /vm pre-boot fallback, restore overrides, fabric_up
 * degraded, build force↔already-built) live in firecracker_coverage_test.ts.
 *
 * Every sshCurl-backed method (FC Unix-socket REST API) makes exactly ONE ssh
 * call whose argv[7] is `curl -sS --unix-socket '<socket>' http://localhost<path>
 * -X '<METHOD>' ... --max-time 30 -w '...'`; a PUT/PATCH body appears as
 * ` -d '<json>'`. Every direct-sshExec method (host bootstrap, kill_vmm,
 * setup_tap, start_vmm, wait_serial, submit, poll, fabric_*) makes ONE or more
 * ssh calls whose argv[7] is the raw shell script. `status`/`stop`/`fabric_up`/
 * `fabric_down`/`fabric_recycle` make MULTIPLE ssh calls — each test scripts an
 * ordered stub QUEUE (concurrency=1 for fabric methods) so every call in
 * sequence is exercised distinctly, never a single shared stub answering all.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./firecracker.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention — see the sibling
// _adversarial_test.ts / _coverage_test.ts / _property_test.ts files)
// ---------------------------------------------------------------------------

interface CapturedCall {
  binary: string;
  args: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ResultPicker =
  | CommandResult
  | CommandResult[]
  | ((call: CapturedCall, callIndex: number) => CommandResult);

function encodeOutput(r: CommandResult) {
  return {
    success: r.code === 0,
    code: r.code,
    signal: null,
    stdout: new TextEncoder().encode(r.stdout),
    stderr: new TextEncoder().encode(r.stderr),
  };
}

function withCommandStub(
  results: ResultPicker,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  let callIndex = 0;
  // deno-lint-ignore no-explicit-any
  const original = (globalThis as any).Deno.Command;

  function pickResult(call: CapturedCall): CommandResult {
    const idx = callIndex++;
    if (typeof results === "function") return results(call, idx);
    if (Array.isArray(results)) {
      return results[idx] ?? results[results.length - 1];
    }
    return results;
  }

  class FakeCommand {
    #result: CommandResult;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      const call: CapturedCall = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
      };
      calls.push(call);
      this.#result = pickResult(call);
    }
    output() {
      return Promise.resolve(encodeOutput(this.#result));
    }
  }

  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return fn(calls).finally(() => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = original;
  });
}

// Simulates the FC HTTP API over the ssh+curl transport: JSON body + the
// `\n__HTTP_STATUS__NNN` trailer sshCurl parses out.
function fcOk(body: unknown = {}): CommandResult {
  return {
    code: 0,
    stdout: `${JSON.stringify(body)}\n__HTTP_STATUS__200`,
    stderr: "",
  };
}

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    host: "fc.example.com",
    socketPath: "/run/firecracker.socket",
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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type ResourceMap = Record<
  string,
  { schema: { parse: (x: unknown) => unknown } }
>;

function parseAgainstResourceSchema(spec: string, payload: unknown): unknown {
  return (model.resources as ResourceMap)[spec].schema.parse(payload);
}

type CheckResult = { pass: boolean; errors?: string[] };
type CheckMap = Record<string, {
  execute: (ctx: unknown) => CheckResult | Promise<CheckResult>;
}>;

async function runCheck(name: string, ctx: unknown): Promise<CheckResult> {
  const check = (model.checks as CheckMap)[name];
  assert(check, `check ${name} must exist on the model`);
  return await check.execute(ctx);
}

function extractCurlBody(cmd: string): Record<string, unknown> {
  const idx = cmd.indexOf(" -d '");
  assert(idx !== -1, `expected a -d body in: ${cmd}`);
  const start = idx + 5;
  const end = cmd.indexOf("'", start);
  return JSON.parse(cmd.slice(start, end));
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

Deno.test("status: happy path — 2 ssh calls (GET / then GET /vm), writes instanceInfo+vmState", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [fcOk({ app_name: "Firecracker" }), fcOk({ state: "Running" })],
    async (calls) => {
      await run("status", {}, ctx);
      assertEquals(calls.length, 2);
      assert(calls[0].args[7].includes("http://localhost/ ".trim()));
      assert(calls[1].args[7].includes("http://localhost/vm"));
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.instanceInfo, { app_name: "Firecracker" });
  assertEquals(res.payload.vmState, { state: "Running" });
  parseAgainstResourceSchema("status", res.payload);
});

// ---------------------------------------------------------------------------
// Pre-boot configuration
// ---------------------------------------------------------------------------

Deno.test("configure: happy path — PUT /machine-config, writes machineConfig", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("configure", { vcpuCount: 2, memSizeMib: 512 }, ctx);
    assertEquals(calls.length, 1);
    assert(calls[0].args[7].includes("http://localhost/machine-config"));
    assert(calls[0].args[7].includes("-X 'PUT'"));
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, {
      vcpu_count: 2,
      mem_size_mib: 512,
      smt: false,
      track_dirty_pages: false,
    });
  });
  const res = written.find((w) => w.spec === "machineConfig")!;
  assertEquals(res.payload.vcpu_count, 2);
  parseAgainstResourceSchema("machineConfig", res.payload);
});

Deno.test("set_boot: happy path — PUT /boot-source (initrd omitted when unset)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_boot", {
      kernelImagePath: "/opt/firecracker/vmlinux",
      bootArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    }, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body.kernel_image_path, "/opt/firecracker/vmlinux");
    assert(!("initrd_path" in body));
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "set_boot"
  )!;
  assertEquals(res.payload.success, true);
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("set_boot: initrdPath, when given, is included", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_boot", {
      kernelImagePath: "/opt/firecracker/vmlinux",
      bootArgs: "console=ttyS0",
      initrdPath: "/opt/firecracker/initrd",
    }, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body.initrd_path, "/opt/firecracker/initrd");
  });
});

Deno.test("set_drive: happy path — PUT /drives/{driveId}, writes action keyed by driveId", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_drive", {
      driveId: "rootfs",
      pathOnHost: "/opt/firecracker/rootfs.ext4",
      isRootDevice: true,
    }, ctx);
    assert(calls[0].args[7].includes("http://localhost/drives/rootfs"));
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, {
      drive_id: "rootfs",
      path_on_host: "/opt/firecracker/rootfs.ext4",
      is_root_device: true,
      is_read_only: false,
    });
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "set_drive_rootfs"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("set_network: happy path — PUT /network-interfaces/{ifaceId} (guestMac optional)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_network", { ifaceId: "eth0", hostDevName: "tap0" }, ctx);
    assert(
      calls[0].args[7].includes("http://localhost/network-interfaces/eth0"),
    );
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, { iface_id: "eth0", host_dev_name: "tap0" });
    assert(!("guest_mac" in body));
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "set_network_eth0"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("set_network: guestMac, when given, is included", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_network", {
      ifaceId: "eth0",
      hostDevName: "tap0",
      guestMac: "AA:BB:CC:DD:EE:FF",
    }, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body.guest_mac, "AA:BB:CC:DD:EE:FF");
  });
});

// ---------------------------------------------------------------------------
// vsock + agent rootfs
// ---------------------------------------------------------------------------

Deno.test("set_vsock: happy path — PUT /vsock", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_vsock", { guestCid: 3, udsPath: "/tmp/fc.vsock" }, ctx);
    assert(calls[0].args[7].includes("http://localhost/vsock"));
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, { guest_cid: 3, uds_path: "/tmp/fc.vsock" });
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "set_vsock"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

// build_ubuntu_rootfs / update_agent_script have NO reachable happy path: both
// call plain `btoa(AGENT_SCRIPT)` as their FIRST statement, and AGENT_SCRIPT's
// source contains a non-Latin1 em-dash ("captures stdout ONLY — NO 2>&1",
// firecracker.ts line ~833) in a comment inside the baked shell script. btoa
// only handles Latin1, so BOTH methods throw unconditionally, before any ssh
// call is ever attempted — a previously-undocumented finding (BUG-6,
// CRITICAL: total, unconditional loss of function), pinned here rather than
// in the adversarial suite since there IS no happy path to separate it from.
// See firecracker-latent-bugs BUG-6.

Deno.test("pin: KNOWN BUG (CRITICAL, firecracker-latent-bugs BUG-6) — build_ubuntu_rootfs ALWAYS throws before any ssh call (btoa() on AGENT_SCRIPT's embedded em-dash)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "unreachable", stderr: "" },
    async (calls) => {
      let threw: Error | undefined;
      try {
        await run("build_ubuntu_rootfs", {}, ctx);
      } catch (e) {
        threw = e as Error;
      }
      assert(
        threw,
        "build_ubuntu_rootfs must currently throw — no happy path exists",
      );
      assert(threw!.message.includes("Latin1"));
      assertEquals(
        calls.length,
        0,
        "the throw happens before any ssh call is attempted",
      );
    },
  );
  assertEquals(written.length, 0, "no action resource is ever written");
});

Deno.test("pin: KNOWN BUG (CRITICAL, firecracker-latent-bugs BUG-6) — update_agent_script ALWAYS throws before any ssh call (btoa() on AGENT_SCRIPT's embedded em-dash)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "unreachable", stderr: "" },
    async (calls) => {
      let threw: Error | undefined;
      try {
        await run("update_agent_script", {}, ctx);
      } catch (e) {
        threw = e as Error;
      }
      assert(
        threw,
        "update_agent_script must currently throw — no happy path exists",
      );
      assert(threw!.message.includes("Latin1"));
      assertEquals(
        calls.length,
        0,
        "the throw happens before any ssh call is attempted",
      );
    },
  );
  assertEquals(written.length, 0, "no action resource is ever written");
});

Deno.test("wait_serial: happy path — 1 ssh call, polls the log for the target string", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "found", stderr: "" },
    async (calls) => {
      await run("wait_serial", { target: "polling for tasks" }, ctx);
      assertEquals(calls.length, 1);
      assert(calls[0].args[7].includes("polling for tasks"));
      assert(calls[0].args[7].includes("/var/log/firecracker.socket.log"));
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "wait_serial"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("snapshot: happy path — PUT /snapshot/create", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("snapshot", {
      snapshotPath: "/opt/firecracker/agent.snap",
      memFilePath: "/opt/firecracker/agent.mem",
    }, ctx);
    assert(calls[0].args[7].includes("http://localhost/snapshot/create"));
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body.snapshot_type, "Full");
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "snapshot"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("restore: happy path (no overrides) — PUT /snapshot/load, resume_vm true", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("restore", {
      snapshotPath: "/opt/firecracker/agent.snap",
      memFilePath: "/opt/firecracker/agent.mem",
    }, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, {
      snapshot_path: "/opt/firecracker/agent.snap",
      mem_file_path: "/opt/firecracker/agent.mem",
      resume_vm: true,
    });
  });
  const res = written.find((w) => w.spec === "action" && w.name === "restore")!;
  parseAgainstResourceSchema("action", res.payload);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

Deno.test("start: happy path — PUT /actions InstanceStart", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("start", {}, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, { action_type: "InstanceStart" });
  });
  const res = written.find((w) => w.spec === "action" && w.name === "start")!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("stop: happy path (VM Running) — GET /vm then PUT /actions InstanceHalt (2 calls)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [fcOk({ state: "Running" }), fcOk()],
    async (calls) => {
      await run("stop", {}, ctx);
      assertEquals(calls.length, 2);
      const body = extractCurlBody(calls[1].args[7]);
      assertEquals(body, { action_type: "InstanceHalt" });
    },
  );
  const res = written.find((w) => w.spec === "action" && w.name === "stop")!;
  assertEquals(res.payload.message, "InstanceHalt action sent");
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("send_ctrl_alt_del: happy path — PUT /actions SendCtrlAltDel", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("send_ctrl_alt_del", {}, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, { action_type: "SendCtrlAltDel" });
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "send_ctrl_alt_del"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("pause: happy path — PATCH /vm Paused", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("pause", {}, ctx);
    assert(calls[0].args[7].includes("-X 'PATCH'"));
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, { state: "Paused" });
  });
  const res = written.find((w) => w.spec === "action" && w.name === "pause")!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("resume: happy path — PATCH /vm Resumed", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("resume", {}, ctx);
    const body = extractCurlBody(calls[0].args[7]);
    assertEquals(body, { state: "Resumed" });
  });
  const res = written.find((w) => w.spec === "action" && w.name === "resume")!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("kill_vmm: happy path — 1 ssh call, PID+socket teardown", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "ok", stderr: "" },
    async (calls) => {
      await run("kill_vmm", {}, ctx);
      assertEquals(calls.length, 1);
      assert(calls[0].args[7].includes("/run/firecracker.socket"));
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "kill_vmm"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("set_entropy_device: happy path — PUT /entropy", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("set_entropy_device", {}, ctx);
    assert(calls[0].args[7].includes("http://localhost/entropy"));
  });
  const res = written.find((w) =>
    w.spec === "action" && w.name === "set_entropy_device"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("install_firecracker: happy path — 1 ssh call, resolves version + downloads binary", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      code: 0,
      stdout: "Resolved version: v1.12.0 arch: x86_64\nok",
      stderr: "",
    },
    async (calls) => {
      await run("install_firecracker", {}, ctx);
      assertEquals(calls.length, 1);
      assert(
        calls[0].args[7].includes("firecracker-microvm/firecracker/releases"),
      );
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "install_firecracker"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("install_guest_kernel: happy path — 1 ssh call, downloads vmlinux", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "installed 6.1.128", stderr: "" },
    async (calls) => {
      await run("install_guest_kernel", {}, ctx);
      assertEquals(calls.length, 1);
      assert(calls[0].args[7].includes("firecracker-ci"));
      assert(calls[0].args[7].includes("6.1.128"));
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "install_guest_kernel"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("setup_tap: happy path (root namespace) — 1 ssh call, tap+NAT recipe", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "ok", stderr: "" },
    async (calls) => {
      await run("setup_tap", {}, ctx);
      assertEquals(calls.length, 1);
      assert(calls[0].args[7].includes("ip tuntap add dev 'tap0' mode tap"));
      assert(!calls[0].args[7].includes("ip netns"));
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "setup_tap"
  )!;
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("start_vmm: happy path (fresh start) — 1 ssh call", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "started:4242", stderr: "" },
    async (calls) => {
      await run("start_vmm", {}, ctx);
      assertEquals(calls.length, 1);
      assert(calls[0].args[7].includes("firecracker --api-sock"));
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "start_vmm"
  )!;
  assert((res.payload.message as string).includes("Started"));
  parseAgainstResourceSchema("action", res.payload);
});

// ---------------------------------------------------------------------------
// Fast task fabric (factory + queue) — multi-call methods, ordered stub queues
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "sk-ant-oat01-do-not-leak-firecracker";

// fabric_up makes a leading `mkdir -p` ssh call for the queue dirs BEFORE
// fanning out to bringUpWorker — 7 ordered calls total at concurrency=1, not 6.
const FABRIC_UP_HAPPY_STUBS = [
  { code: 0, stdout: "", stderr: "" }, // mkdir -p (queue/claimed/results/failed dirs)
  { code: 0, stdout: "ok", stderr: "" }, // kill_vmm (pre-attempt cleanup)
  { code: 0, stdout: "ok", stderr: "" }, // setup_tap
  { code: 0, stdout: "verified", stderr: "" }, // verify_netns (sshExecRaw)
  { code: 0, stdout: "started:111", stderr: "" }, // start_vmm
  { code: 0, stdout: "deployed", stderr: "" }, // deploy_fabric
  fcOk(), // sshCurl snapshot/load (restore)
];

Deno.test("fabric_up: happy path (concurrency=1, wired first attempt) — 7 ordered ssh calls (mkdir + 6-call bringUpWorker), writes fabric status=up", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    FABRIC_UP_HAPPY_STUBS,
    async (calls) => {
      await run("fabric_up", { concurrency: 1, oauthToken: FAKE_TOKEN }, ctx);
      assertEquals(calls.length, 7);
      assert(calls[0].args[7].includes("mkdir -p"));
    },
  );
  const res = written.find((w) => w.spec === "fabric")!;
  assertEquals(res.payload.status, "up");
  assertEquals(res.payload.workers, ["fcw-1"]);
  assertEquals(res.payload.failures, []);
  parseAgainstResourceSchema("fabric", res.payload);
});

Deno.test("submit: happy path — 1 ssh call writing N task files, returns generated ids", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub({ code: 0, stdout: "", stderr: "" }, async (calls) => {
    await run(
      "submit",
      { tasks: [{ prompt: "task A" }, { prompt: "task B" }] },
      ctx,
    );
    assertEquals(calls.length, 1);
    assert(calls[0].args[7].includes("mkdir -p"));
  });
  const res = written.find((w) => w.spec === "submitted")!;
  assertEquals(res.payload.count, 2);
  assertEquals((res.payload.ids as string[]).length, 2);
  parseAgainstResourceSchema("submitted", res.payload);
});

Deno.test("poll: happy path — 1 ssh call, decodes completed results + pending count", async () => {
  const { ctx, written } = makeCtx();
  const stdout = `===task1===\n${btoa("the result")}\nPENDING=2\n`;
  await withCommandStub({ code: 0, stdout, stderr: "" }, async (calls) => {
    await run("poll", {}, ctx);
    assertEquals(calls.length, 1);
  });
  const res = written.find((w) => w.spec === "results")!;
  assertEquals(res.payload.completed, { task1: "the result" });
  assertEquals(res.payload.pending, 2);
  parseAgainstResourceSchema("results", res.payload);
});

Deno.test("fabric_down: happy path (no discovered workers, concurrency=1 fallback) — discover + reap(2) + rm = 4 calls", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 0, stdout: "", stderr: "" }, // discover (empty)
      { code: 0, stdout: "", stderr: "" }, // srvPid kill for worker 1
      { code: 0, stdout: "ok", stderr: "" }, // kill_vmm for worker 1
      { code: 0, stdout: "", stderr: "" }, // rm -rf queueRoot
    ],
    async (calls) => {
      await run("fabric_down", { concurrency: 1 }, ctx);
      assertEquals(calls.length, 4);
    },
  );
  const res = written.find((w) => w.spec === "fabric")!;
  assertEquals(res.payload.status, "down");
  assertEquals(res.payload.reaped, [1]);
  parseAgainstResourceSchema("fabric", res.payload);
});

Deno.test("fabric_recycle: happy path (no stalled claims) — 1 scan call, writes fabric status=recycled with nothing restarted", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub({ code: 0, stdout: "", stderr: "" }, async (calls) => {
    await run("fabric_recycle", { oauthToken: FAKE_TOKEN }, ctx);
    assertEquals(
      calls.length,
      1,
      "no stalled claims -> no restart, no requeue mv",
    );
  });
  const res = written.find((w) => w.spec === "fabric")!;
  assertEquals(res.payload.status, "recycled");
  assertEquals(res.payload.restarted, []);
  parseAgainstResourceSchema("fabric", res.payload);
});

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

Deno.test("host-reachable check: pass branch — ssh returns exit 0, stdout trims to 'ready'", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "ready\n", stderr: "" },
    async () => {
      const res = await runCheck("host-reachable", ctx);
      assertEquals(res.pass, true);
    },
  );
});

Deno.test("host-reachable check: fail branch — non-zero ssh exit fails with exit code + stderr", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host port 22: Connection refused",
    },
    async () => {
      const res = await runCheck("host-reachable", ctx);
      assertEquals(res.pass, false);
      assert(res.errors?.[0].includes("exit 255"));
      assert(res.errors?.[0].includes("Connection refused"));
    },
  );
});

Deno.test("valid-ssh-host check: pass branch — no ssh call needed (synchronous)", async () => {
  const { ctx } = makeCtx();
  const res = await runCheck("valid-ssh-host", ctx);
  assertEquals(res.pass, true);
});

// ---------------------------------------------------------------------------
// OAuth token non-leak — spot check across the two methods that ever see a
// token (fabric_up, fabric_recycle). The mechanical secret-scan over every
// written resource + rejected error, and the pinned BUG-2 argv leak, live in
// firecracker_adversarial_test.ts.
// ---------------------------------------------------------------------------

Deno.test("OAuth token never appears in the fabric_up/fabric_recycle WRITTEN RESOURCE payloads", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    FABRIC_UP_HAPPY_STUBS,
    async () => {
      await run("fabric_up", { concurrency: 1, oauthToken: FAKE_TOKEN }, ctx);
    },
  );
  await withCommandStub({ code: 0, stdout: "", stderr: "" }, async () => {
    await run("fabric_recycle", { oauthToken: FAKE_TOKEN }, ctx);
  });
  for (const w of written) {
    assert(
      !JSON.stringify(w.payload).includes(FAKE_TOKEN),
      `${w.spec}/${w.name} must never carry the oauth token in its written resource`,
    );
  }
});
