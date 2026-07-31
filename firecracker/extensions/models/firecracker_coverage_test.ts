/**
 * Coverage suite for @magistr/firecracker: regression guards for behavior NOT
 * already pinned by the contract-fixture, methods, or adversarial suites —
 * both sides of every guard (STANDARD.md's coverage role: "if someone deletes
 * this guard, does a test go red?").
 *
 * Specifically owns (not duplicated elsewhere):
 *  - netns↔root sweep across a GLOBAL-arg-driven method (start_vmm) and a
 *    METHOD-arg-driven method (setup_tap) — firecracker's netns plumbing is
 *    NOT uniform: start_vmm/kill_vmm read `context.globalArgs.netns`, while
 *    setup_tap reads its OWN `args.netns` — a real seam worth pinning
 *    distinctly so a future refactor that unifies (or breaks) this can't slip
 *    through unnoticed.
 *  - `start_vmm`'s warm-process-reuse branch ("alive:" vs "started:").
 *  - `stop`'s idempotent-if-already-stopped branch (1 ssh call, no
 *    InstanceHalt PUT) — contrasted with BUG-5's asymmetry below.
 *  - `status`'s pre-boot `GET /vm` fallback (vmState defaults to `{}` when the
 *    second call fails, without failing the whole method).
 *  - `restore`'s vsock_override / network_overrides truth-table cells (the
 *    contract/methods suites only exercise the no-override case).
 *  - `poll`'s `ids` filter narrowing the WRITTEN completed map without
 *    affecting the `pending` count (parsePollOutput's own decode edge cases
 *    are pinned directly in the kept firecracker.test.ts).
 *  - `fabric_up`'s degraded path: every setup attempt fails -> the fabric
 *    resource is still WRITTEN (workers=[], failures=[...], status=degraded)
 *    and THEN the method throws — Promise.allSettled must never silently
 *    discard a partially-up pool.
 *  - BUG-4 (LOW, firecracker-latent-bugs) — install_guest_kernel's
 *    `sed "s|@@ARCH@@|$ARCH|g"` corrupts (or errors on) a hostile `arch`
 *    value containing a literal pipe character (no pipe-escaping applied to
 *    ARCH before using it as a sed REPLACEMENT inside a pipe-delimited
 *    s/// command).
 *  - BUG-5 (LOW/info, firecracker-latent-bugs) — asymmetric state-transition
 *    idempotency: only `stop` prechecks VM state before acting; `start`,
 *    `pause`, `resume`, `send_ctrl_alt_del` issue their action unconditionally
 *    regardless of current VM state.
 *  - BUG-6 (CRITICAL, firecracker-latent-bugs, FIXED) — `build_ubuntu_rootfs`'s
 *    `force=true` vs marker-already-present branches: now that AGENT_SCRIPT is
 *    routed through utf8ToBase64 instead of the raw btoa primitive, the
 *    marker-check/force branch is reachable again — the real truth-table is
 *    pinned here (see firecracker_methods_test.ts for the primary BUG-6 fix
 *    pin, the happy path itself).
 *
 * firecracker.ts / lib/ssh.ts are UNMODIFIED — every test here PINS existing
 * behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./firecracker.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
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

function fcOk(body: unknown = {}): CommandResult {
  return {
    code: 0,
    stdout: `${JSON.stringify(body)}\n__HTTP_STATUS__200`,
    stderr: "",
  };
}

function fcErr(status: number, body: unknown): CommandResult {
  return {
    code: 0,
    stdout: `${JSON.stringify(body)}\n__HTTP_STATUS__${status}`,
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

async function bashRunnable(): Promise<boolean> {
  try {
    const st = await Deno.permissions.query({ name: "run", command: "bash" });
    if (st.state !== "granted") return false;
    return (await new Deno.Command("bash", { args: ["-c", ":"] }).output())
      .success;
  } catch {
    return false;
  }
}
const BASH_OK = await bashRunnable();

// ---------------------------------------------------------------------------
// netns↔root sweep — start_vmm (globalArgs.netns) vs setup_tap (args.netns)
// ---------------------------------------------------------------------------

Deno.test("start_vmm: netns SET (globalArgs) — ip netns exec prefixes the firecracker launch", async () => {
  const { ctx } = makeCtx({ netns: "fcw-1" });
  await withCommandStub(
    { code: 0, stdout: "started:1", stderr: "" },
    async (calls) => {
      await run("start_vmm", {}, ctx);
      assert(
        calls[0].args[7].includes(
          "ip netns exec 'fcw-1' firecracker --api-sock",
        ),
      );
    },
  );
});

Deno.test("start_vmm: netns UNSET (globalArgs) — no ip netns exec prefix (root namespace)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "started:1", stderr: "" },
    async (calls) => {
      await run("start_vmm", {}, ctx);
      assert(!calls[0].args[7].includes("ip netns exec"));
    },
  );
});

Deno.test("kill_vmm: netns SET (globalArgs) — teardown removes the namespace + flushes its tagged NAT rules", async () => {
  const { ctx } = makeCtx({ netns: "fcw-2" });
  await withCommandStub(
    { code: 0, stdout: "ok", stderr: "" },
    async (calls) => {
      await run("kill_vmm", {}, ctx);
      assert(calls[0].args[7].includes("ip netns del 'fcw-2'"));
      assert(calls[0].args[7].includes("fc-netns:fcw-2"));
    },
  );
});

Deno.test("setup_tap: netns SET (its OWN args.netns, NOT globalArgs) — builds the namespace + veth + scoped NAT", async () => {
  const { ctx } = makeCtx({ netns: "should-be-ignored" }); // globalArgs.netns must NOT drive setup_tap
  await withCommandStub(
    { code: 0, stdout: "ok", stderr: "" },
    async (calls) => {
      await run(
        "setup_tap",
        { netns: "sip-1", vethSubnet: "10.0.1.0/30" },
        ctx,
      );
      assert(calls[0].args[7].includes("ip netns add 'sip-1'"));
      assert(!calls[0].args[7].includes("should-be-ignored"));
    },
  );
});

Deno.test("setup_tap: netns UNSET in args — root-namespace recipe even when globalArgs.netns IS set (proves the two netns knobs are independent)", async () => {
  const { ctx } = makeCtx({ netns: "fcw-3" });
  await withCommandStub(
    { code: 0, stdout: "ok", stderr: "" },
    async (calls) => {
      await run("setup_tap", {}, ctx);
      assert(!calls[0].args[7].includes("ip netns"));
      assert(!calls[0].args[7].includes("fcw-3"));
    },
  );
});

// ---------------------------------------------------------------------------
// start_vmm warm-process reuse
// ---------------------------------------------------------------------------

Deno.test("start_vmm: warm process reused — 'alive:PID' stdout produces a reuse message", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "alive:555", stderr: "" },
    async () => {
      await run("start_vmm", {}, ctx);
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "start_vmm"
  )!;
  assert((res.payload.message as string).includes("Reused warm VMM"));
});

// ---------------------------------------------------------------------------
// stop idempotency + BUG-5 asymmetry contrast
// ---------------------------------------------------------------------------

Deno.test("stop: idempotent — VM already 'Not started' short-circuits after 1 ssh call, no InstanceHalt PUT issued", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk({ state: "Not started" }), async (calls) => {
    await run("stop", {}, ctx);
    assertEquals(calls.length, 1, "only the state-check GET, no PUT /actions");
  });
  const res = written.find((w) => w.spec === "action" && w.name === "stop")!;
  assert((res.payload.message as string).includes("already stopped"));
  parseAgainstResourceSchema("action", res.payload);
});

Deno.test("stop: the socket being gone (GET /vm ssh call itself fails) is tolerated — currentState falls back to 'unknown' and InstanceHalt still fires", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      { code: 255, stdout: "", stderr: "connection refused" }, // GET /vm fails outright
      fcOk(), // PUT /actions InstanceHalt still attempted
    ],
    async (calls) => {
      await run("stop", {}, ctx);
      assertEquals(calls.length, 2);
    },
  );
  const res = written.find((w) => w.spec === "action" && w.name === "stop")!;
  assertEquals(res.payload.message, "InstanceHalt action sent");
});

Deno.test("pin: KNOWN GAP (LOW/info, firecracker-latent-bugs BUG-5) — start/pause/resume/send_ctrl_alt_del issue their action UNCONDITIONALLY, unlike stop's state precheck", async () => {
  for (const name of ["start", "pause", "resume", "send_ctrl_alt_del"]) {
    const { ctx } = makeCtx();
    await withCommandStub(fcOk(), async (calls) => {
      await run(name, {}, ctx);
      assertEquals(
        calls.length,
        1,
        `${name} makes exactly 1 ssh call — no precondition GET /vm before acting, ` +
          `unlike stop's conditional 1-or-2-call idempotency check. pin: KNOWN GAP, ` +
          `not fixed here; see firecracker-latent-bugs BUG-5.`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// status: pre-boot GET /vm fallback
// ---------------------------------------------------------------------------

Deno.test("status: pre-boot fallback — GET /vm returning FC 4xx is swallowed; vmState defaults to {} without failing the method", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    [
      fcOk({ app_name: "Firecracker", state: "Not started" }),
      fcErr(400, { fault_message: "not started" }),
    ],
    async (calls) => {
      await run("status", {}, ctx);
      assertEquals(calls.length, 2, "both calls are still attempted");
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.vmState, {});
  assertEquals(
    (res.payload.instanceInfo as Record<string, unknown>).state,
    "Not started",
  );
});

// ---------------------------------------------------------------------------
// restore overrides truth table (contract/methods suites cover the no-override
// case only)
// ---------------------------------------------------------------------------

Deno.test("restore: vsockUdsPath only — vsock_override present, network_overrides absent", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("restore", {
      snapshotPath: "/a.snap",
      memFilePath: "/a.mem",
      vsockUdsPath: "/tmp/fc-1.vsock",
    }, ctx);
    const cmd = calls[0].args[7];
    assert(cmd.includes('"vsock_override":{"uds_path":"/tmp/fc-1.vsock"}'));
    assert(!cmd.includes("network_overrides"));
  });
});

Deno.test("restore: ifaceId+hostDevName only — network_overrides present, vsock_override absent", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("restore", {
      snapshotPath: "/a.snap",
      memFilePath: "/a.mem",
      ifaceId: "eth0",
      hostDevName: "tap7",
    }, ctx);
    const cmd = calls[0].args[7];
    assert(
      cmd.includes(
        '"network_overrides":[{"iface_id":"eth0","host_dev_name":"tap7"}]',
      ),
    );
    assert(!cmd.includes("vsock_override"));
  });
});

Deno.test("restore: BOTH vsockUdsPath and ifaceId+hostDevName set — both overrides present together", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("restore", {
      snapshotPath: "/a.snap",
      memFilePath: "/a.mem",
      vsockUdsPath: "/tmp/fc-1.vsock",
      ifaceId: "eth0",
      hostDevName: "tap7",
    }, ctx);
    const cmd = calls[0].args[7];
    assert(cmd.includes("vsock_override"));
    assert(cmd.includes("network_overrides"));
  });
  const res = written.find((w) => w.spec === "action")!;
  assert((res.payload.message as string).includes("vsock:"));
  assert((res.payload.message as string).includes("tap:"));
});

Deno.test("restore: hostDevName WITHOUT ifaceId never emits network_overrides (both fields required together)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("restore", {
      snapshotPath: "/a.snap",
      memFilePath: "/a.mem",
      hostDevName: "tap7",
    }, ctx);
    assert(!calls[0].args[7].includes("network_overrides"));
  });
});

// ---------------------------------------------------------------------------
// poll: ids filter narrows the WRITTEN map without affecting `pending`
// ---------------------------------------------------------------------------

Deno.test("poll: an `ids` filter narrows the written completed map to just the requested ids, but `pending` reflects the full queue regardless", async () => {
  const { ctx, written } = makeCtx();
  const stdout = `===alpha===\n${btoa("A")}\n===beta===\n${
    btoa("B")
  }\nPENDING=5\n`;
  await withCommandStub({ code: 0, stdout, stderr: "" }, async () => {
    await run("poll", { ids: ["alpha"] }, ctx);
  });
  const res = written.find((w) => w.spec === "results")!;
  assertEquals(res.payload.completed, { alpha: "A" });
  assertEquals(res.payload.completedCount, 1);
  assertEquals(
    res.payload.pending,
    5,
    "pending is queue-wide, unaffected by the ids filter",
  );
});

Deno.test("poll: no results yet — completed is empty, pending reflects the queue depth", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "PENDING=3\n", stderr: "" },
    async () => {
      await run("poll", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "results")!;
  assertEquals(res.payload.completed, {});
  assertEquals(res.payload.pending, 3);
});

// ---------------------------------------------------------------------------
// fabric_up degraded path — every setup attempt fails for the sole worker
// ---------------------------------------------------------------------------

Deno.test("fabric_up: degraded — a worker that never wires (3 failed verify attempts) is recorded as a failure, the resource is WRITTEN, then the method throws", async () => {
  const { ctx, written } = makeCtx();
  // fabric_up issues a leading `mkdir -p` for the queue dirs before fanning
  // out to bringUpWorker — 1 + 3*(kill_vmm + setup_tap + verify) = 10 calls.
  const failingVerify: CommandResult[] = [
    { code: 0, stdout: "", stderr: "" }, // mkdir -p
  ];
  for (let i = 0; i < 3; i++) {
    failingVerify.push({ code: 0, stdout: "ok", stderr: "" }); // kill_vmm
    failingVerify.push({ code: 0, stdout: "ok", stderr: "" }); // setup_tap
    failingVerify.push({
      code: 1,
      stdout: "",
      stderr: "verify_netns: fcveth0 missing addr",
    }); // verify fails
  }
  let threw: Error | undefined;
  await withCommandStub(failingVerify, async (calls) => {
    try {
      await run("fabric_up", { concurrency: 1, oauthToken: "sk-ant-x" }, ctx);
    } catch (e) {
      threw = e as Error;
    }
    assertEquals(
      calls.length,
      10,
      "mkdir + 3 attempts x (kill_vmm + setup_tap + verify), no start_vmm/deploy/restore ever reached",
    );
  });
  assert(threw, "fabric_up must reject when a worker never wires");
  assert(threw!.message.includes("1 worker(s) failed"));
  const res = written.find((w) => w.spec === "fabric")!;
  assertEquals(res.payload.status, "degraded");
  assertEquals(res.payload.workers, []);
  assertEquals(res.payload.failures, ["fcw-1"]);
  parseAgainstResourceSchema("fabric", res.payload);
});

// ---------------------------------------------------------------------------
// build_ubuntu_rootfs: force=true vs marker-already-present real truth-table
// (BUG-6 fixed — the marker-check/force branch is reachable now that
// AGENT_SCRIPT no longer throws on encode).
// ---------------------------------------------------------------------------

Deno.test("build_ubuntu_rootfs: force=false emits the marker-check skip guard; a stubbed already-built stdout is reported as an idempotent skip (BUG-6 fixed, force branch reachable)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "already-built", stderr: "" },
    async (calls) => {
      await run("build_ubuntu_rootfs", { force: false }, ctx);
      assertEquals(calls.length, 1);
      assert(
        calls[0].args[7].includes(
          "if test -f /opt/firecracker/.ubuntu-rootfs-ready; then echo already-built; exit 0; fi",
        ),
      );
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "build_ubuntu_rootfs"
  )!;
  assertEquals(res.payload.success, true);
  assert(
    (res.payload.message as string).includes("already built"),
    "force=false + already-built stdout: message reports the idempotent skip",
  );
});

Deno.test("build_ubuntu_rootfs: force=true emits an unconditional marker removal, never the skip guard, and reports the build as started (BUG-6 fixed, force branch reachable)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "build started ver=v1.12.0 pid=99", stderr: "" },
    async (calls) => {
      await run("build_ubuntu_rootfs", { force: true }, ctx);
      assertEquals(calls.length, 1);
      assert(
        calls[0].args[7].includes(
          "rm -f /opt/firecracker/.ubuntu-rootfs-ready",
        ),
      );
      assert(
        !calls[0].args[7].includes("if test -f"),
        "force=true must not emit the marker-check guard",
      );
    },
  );
  const res = written.find((w) =>
    w.spec === "action" && w.name === "build_ubuntu_rootfs"
  )!;
  assertEquals(res.payload.success, true);
  assert(
    (res.payload.message as string).includes("background"),
    "force=true: message reports the build started in background",
  );
});

// ---------------------------------------------------------------------------
// BUG-4 (LOW) — sed delimiter corruption in install_guest_kernel via a
// pipe-containing arch. Extracted from the REAL generated command (not a
// hand-written stand-in), then the vulnerable ARCH= + sed line is run in
// isolation via real bash (safe — no network, no full script execution).
// ---------------------------------------------------------------------------

Deno.test({
  name:
    'pin: KNOWN BUG (LOW, firecracker-latent-bugs BUG-4) — install_guest_kernel\'s sed "s|@@ARCH@@|$ARCH|g" corrupts the URL when arch contains a literal pipe',
  ignore: !BASH_OK,
  fn: async () => {
    const { ctx } = makeCtx();
    let capturedCmd = "";
    await withCommandStub(
      { code: 0, stdout: "installed", stderr: "" },
      async (calls) => {
        await run("install_guest_kernel", { arch: "x86_64|evil" }, ctx);
        capturedCmd = calls[0].args[7];
      },
    );
    assert(
      capturedCmd.includes('sed "s|@@ARCH@@|$ARCH|g"'),
      "uses a pipe-delimited sed substitution with no pipe-escaping applied to ARCH",
    );
    const archLine = capturedCmd.match(/^ARCH=.*$/m)?.[0];
    assert(
      archLine,
      "expected an ARCH= assignment line in the generated command",
    );

    const proof = [
      archLine!,
      `URL=$(printf '%s' 'https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/@@ARCH@@/vmlinux-6.1.128' | sed "s|@@ARCH@@|$ARCH|g")`,
      `echo "$URL"`,
    ].join("\n");
    const out = await new Deno.Command("bash", { args: ["-c", proof] })
      .output();
    const stdout = new TextDecoder().decode(out.stdout).trim();
    const cleanlySubstituted =
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/x86_64|evil/vmlinux-6.1.128";
    assert(
      !out.success || stdout !== cleanlySubstituted,
      "a pipe character in ARCH either errors sed (extra delimiter, non-zero exit) " +
        "or silently corrupts the substitution — either way the URL is not the " +
        "clean substitution a well-formed sed pattern would produce. pin: KNOWN " +
        "BUG, not fixed here; see firecracker-latent-bugs BUG-4.",
    );
  },
});

Deno.test({
  name:
    "safe: CONTRAST — the same sed pattern with a clean (no-pipe) arch value substitutes correctly",
  ignore: !BASH_OK,
  fn: async () => {
    const { ctx } = makeCtx();
    let capturedCmd = "";
    await withCommandStub(
      { code: 0, stdout: "installed", stderr: "" },
      async (calls) => {
        await run("install_guest_kernel", { arch: "x86_64" }, ctx);
        capturedCmd = calls[0].args[7];
      },
    );
    const archLine = capturedCmd.match(/^ARCH=.*$/m)?.[0]!;
    const proof = [
      archLine,
      `URL=$(printf '%s' 'https://example.com/@@ARCH@@/vmlinux' | sed "s|@@ARCH@@|$ARCH|g")`,
      `echo "$URL"`,
    ].join("\n");
    const out = await new Deno.Command("bash", { args: ["-c", proof] })
      .output();
    assertEquals(out.success, true);
    assertEquals(
      new TextDecoder().decode(out.stdout).trim(),
      "https://example.com/x86_64/vmlinux",
      "a clean arch value (no shell/sed metacharacters) substitutes correctly — " +
        "BUG-4 is specifically triggered by a pipe character in arch, not by " +
        "well-formed values",
    );
  },
});
