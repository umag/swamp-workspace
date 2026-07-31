/**
 * Adversarial suite for @magistr/firecracker: attacker's-perspective
 * characterization of the model's real injection surface, hostile schema
 * inputs, the FC Unix-socket API's 4xx fault-message throw path, a
 * representative non-zero-exit sweep, and a mechanical OAuth-token
 * secret-scan.
 *
 * firecracker.ts / lib/ssh.ts are otherwise UNMODIFIED except for the two
 * BUG-1/BUG-6 fixes (see the local `firecracker-realfix` issue-lifecycle
 * model) — every remaining "pin: KNOWN <BUG-ID>" test here characterizes a
 * REAL, already-shipped behavior rather than proposing a fix (a fix for
 * those is out of scope for this backfill; see CHANGELOG.md and the LOCAL
 * `firecracker-latent-bugs` issue-lifecycle bug model — NEVER the Lab, per
 * this repo's tracking convention).
 *
 * Bugs pinned here (BUG-4/BUG-5 live in firecracker_coverage_test.ts):
 *   BUG-1 (HIGH, FIXED) — `install_firecracker`'s `arch` argument was
 *      raw-interpolated TWICE: once safely via `shellEsc` into a bash
 *      variable assignment, and once UNESCAPED directly into a Python
 *      single-quoted string literal itself embedded inside a bash
 *      DOUBLE-quoted `python3 -c "..."` argument spanning a `$(...)` command
 *      substitution — full remote command injection, not merely a
 *      python-string break-out. Fixed by adding a strict allowlist regex
 *      (ARCH_RE) to the zod schema, rejecting a hostile `arch` at parse()
 *      before it can reach either interpolation site.
 *   BUG-2 (MED) — `buildDeployFabricCmd` embeds the OAuth token in cleartext
 *      (shellEsc'd for bash-safety, but NOT redacted) directly in the
 *      generated ssh command string, which becomes a literal element of the
 *      LOCAL `Deno.Command("ssh", {args:[...]})` argv — visible to any local
 *      process-listing tool (`ps`) for the lifetime of the ssh subprocess.
 *   BUG-3 (MED) — the two internet-facing binary downloads
 *      (`install_firecracker`'s `curl -fsSL -L -o ... "$URL"` and
 *      `install_guest_kernel`'s `curl -fsSL -o "$TMP" "$URL"`) carry no
 *      `--max-time`/`--connect-timeout`, unlike every FC-socket call via
 *      `sshCurl` (`--max-time 30`) — a stalled GitHub/S3 connection can hang
 *      the remote shell (and thus the ssh subprocess) indefinitely; only
 *      `ssh`'s own `ConnectTimeout=10` bounds the SSH handshake, not the
 *      remote command's runtime.
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { buildDeployFabricCmd, fabricPaths, model } from "./firecracker.ts";

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
  arguments: {
    parse: (a: unknown) => unknown;
    safeParse: (a: unknown) => { success: boolean };
  };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// BUG-1 (HIGH, FIXED) — install_firecracker's `arch` now carries a strict
// allowlist regex (ARCH_RE) on its zod schema, so a hostile value is rejected
// at the parse() boundary before it can ever reach the raw-interpolated
// python3 -c block. See local model firecracker-realfix.
// ---------------------------------------------------------------------------

Deno.test("install_firecracker: a hostile `arch` (shell/python metacharacters) is REJECTED at the parse() boundary — never reaches execute() or any ssh call (BUG-1 fixed)", async () => {
  const injection = "$(touch /tmp/pwned-firecracker-BUG1)";
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "Resolved version: v1.12.0 arch: x\nok", stderr: "" },
    async (calls) => {
      let threw: Error | undefined;
      try {
        await run("install_firecracker", { arch: injection }, ctx);
      } catch (e) {
        threw = e as Error;
      }
      assert(
        threw,
        "the ARCH_RE regex on the zod schema must reject this arch at " +
          "parse() — run() calls arguments.parse() before execute(), so the " +
          "hostile value never reaches the raw-interpolated python3 -c block. " +
          "see local model firecracker-realfix.",
      );
      assertEquals(
        calls.length,
        0,
        "rejection happens at the schema boundary, before any ssh call",
      );
    },
  );
});

Deno.test("install_firecracker: arch schema — hostile arch rejected by safeParse; a legit arch (x86_64) parses OK and flows through to the generated command (BUG-1 fixed)", async () => {
  const injection = "$(touch /tmp/pwned-firecracker-BUG1)";
  const rejected = model.methods.install_firecracker.arguments.safeParse({
    arch: injection,
  });
  assert(
    !rejected.success,
    "install_firecracker.arch now has ARCH_RE regex validation — a " +
      "shell-metacharacter value must fail schema validation before it can " +
      "reach BUG-1's former raw-interpolation site",
  );

  const accepted = model.methods.install_firecracker.arguments.safeParse({
    arch: "x86_64",
  });
  assert(accepted.success, "a legit arch value must still parse OK");

  const { ctx } = makeCtx();
  await withCommandStub(
    {
      code: 0,
      stdout: "Resolved version: v1.12.0 arch: x86_64\nok",
      stderr: "",
    },
    async (calls) => {
      await run("install_firecracker", { arch: "x86_64" }, ctx);
      const cmd = calls[0].args[7];
      assert(
        cmd.includes(`ARCH='x86_64'`),
        "the legit arch value flows through to the shellEsc'd ARCH= assignment",
      );
      assert(
        cmd.includes(`arch = 'x86_64' or __import__`),
        "the legit arch value also flows through to the python3 -c block",
      );
    },
  );
});

Deno.test("install_firecracker: arch schema — a hostile value is rejected by safeParse (BUG-1 fixed)", () => {
  const r = model.methods.install_firecracker.arguments.safeParse({
    arch: "$(touch /tmp/pwned)",
  });
  assert(
    !r.success,
    "install_firecracker.arch now has ARCH_RE regex validation — a " +
      "shell-metacharacter value must fail schema validation, closing BUG-1's " +
      "raw-interpolation injection path",
  );
});

// ---------------------------------------------------------------------------
// BUG-2 (MED) — OAuth token embedded in cleartext in buildDeployFabricCmd's
// output, which becomes a literal LOCAL ssh argv element.
// ---------------------------------------------------------------------------

const LEAK_TOKEN = "sk-ant-SECRET";

Deno.test("pin: KNOWN LEAK (MED, firecracker-latent-bugs BUG-2) — buildDeployFabricCmd embeds the OAuth token in cleartext in its returned command string", () => {
  const paths = fabricPaths("/tmp/fc-fabric");
  const cmd = buildDeployFabricCmd(
    "fcw-1",
    "172.16.0.1",
    8080,
    paths,
    LEAK_TOKEN,
    "/tmp/fcw-1.server.pid",
  );
  assert(
    cmd.includes(LEAK_TOKEN),
    "the token appears in cleartext (shellEsc'd for bash-safety, but not " +
      "redacted) — this string becomes ONE element of the LOCAL " +
      "Deno.Command('ssh', {args}) argv, visible to local process-listing " +
      "tools for the ssh subprocess's lifetime. pin: KNOWN LEAK, not fixed " +
      "here (source frozen); see firecracker-latent-bugs BUG-2.",
  );
  assert(
    cmd.includes(`FC_OAUTH_TOKEN='${LEAK_TOKEN}'`),
    "specifically the FC_OAUTH_TOKEN export line carries the plaintext value",
  );
});

Deno.test("pin: KNOWN LEAK (MED, firecracker-latent-bugs BUG-2) — end-to-end via fabric_up: the deploy_fabric ssh call's argv carries the plaintext token", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    // fabric_up issues a leading `mkdir -p` before fanning out to
    // bringUpWorker, so deploy_fabric is the 6th call (index 5), not the 5th.
    [
      { code: 0, stdout: "", stderr: "" }, // mkdir -p
      { code: 0, stdout: "ok", stderr: "" }, // kill_vmm
      { code: 0, stdout: "ok", stderr: "" }, // setup_tap
      { code: 0, stdout: "verified", stderr: "" }, // verify_netns
      { code: 0, stdout: "started:1", stderr: "" }, // start_vmm
      { code: 0, stdout: "deployed", stderr: "" }, // deploy_fabric
      fcOk(), // restore (snapshot/load)
    ],
    async (calls) => {
      await run("fabric_up", { concurrency: 1, oauthToken: LEAK_TOKEN }, ctx);
      const deployCall = calls[5].args[7]; // 6th call: buildDeployFabricCmd
      assert(
        deployCall.includes(LEAK_TOKEN),
        "the deploy_fabric ssh call is the concrete argv where BUG-2 manifests " +
          "at the method level, not just the pure builder",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// BUG-3 (MED) — internet-facing binary downloads carry no timeout, unlike
// every FC-socket call.
// ---------------------------------------------------------------------------

Deno.test("pin: KNOWN GAP (MED, firecracker-latent-bugs BUG-3) — install_firecracker's binary download has no --max-time/--connect-timeout", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      code: 0,
      stdout: "Resolved version: v1.12.0 arch: x86_64\nok",
      stderr: "",
    },
    async (calls) => {
      await run("install_firecracker", {}, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes('curl -fsSL -L -o "$TMPDIR/fc.tgz" "$URL"'));
      assert(
        !cmd.includes("--max-time") && !cmd.includes("--connect-timeout"),
        "a stalled GitHub download can hang the remote shell indefinitely — " +
          "ssh's ConnectTimeout=10 bounds only the SSH handshake, not the " +
          "remote command's runtime. pin: KNOWN GAP, not fixed here; see " +
          "firecracker-latent-bugs BUG-3.",
      );
    },
  );
});

Deno.test("pin: KNOWN GAP (MED, firecracker-latent-bugs BUG-3) — install_guest_kernel's vmlinux download has no --max-time/--connect-timeout", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    { code: 0, stdout: "installed 6.1.128", stderr: "" },
    async (calls) => {
      await run("install_guest_kernel", {}, ctx);
      const cmd = calls[0].args[7];
      assert(cmd.includes('curl -fsSL -o "$TMP" "$URL"'));
      assert(!cmd.includes("--max-time") && !cmd.includes("--connect-timeout"));
    },
  );
});

Deno.test("safe: CONTRAST — every FC-socket call via sshCurl DOES carry --max-time 30 (configure, used here as the representative)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(fcOk(), async (calls) => {
    await run("configure", { vcpuCount: 1, memSizeMib: 128 }, ctx);
    assert(
      calls[0].args[7].includes("--max-time 30"),
      "the FC Unix-socket API calls are properly bounded — BUG-3 is " +
        "specifically the two internet-facing download commands, not the " +
        "socket API surface",
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile schema inputs — NEW cases not already pinned in the kept
// contract-fixture suite (firecracker_test.ts already covers set_drive's
// pathOnHost, set_network's hostDevName length, configure's vcpuCount max,
// setup_tap's netns/vethSubnet, and globalArguments' netns).
// ---------------------------------------------------------------------------

Deno.test("set_vsock: rejects a guestCid below the minimum (3)", () => {
  assertFalse(
    model.methods.set_vsock.arguments.safeParse({
      guestCid: 2,
      udsPath: "/tmp/fc.vsock",
    }).success,
  );
});

Deno.test("set_drive: rejects a driveId containing shell metacharacters", () => {
  assertFalse(
    model.methods.set_drive.arguments.safeParse({
      driveId: "rootfs; rm -rf /",
      pathOnHost: "/opt/firecracker/rootfs.ext4",
      isRootDevice: true,
    }).success,
  );
});

Deno.test("set_network: rejects an ifaceId containing a path separator", () => {
  assertFalse(
    model.methods.set_network.arguments.safeParse({
      ifaceId: "eth0/../etc",
      hostDevName: "tap0",
    }).success,
  );
});

Deno.test("restore: rejects a vsockUdsPath containing an embedded space", () => {
  assertFalse(
    model.methods.restore.arguments.safeParse({
      snapshotPath: "/opt/firecracker/agent.snap",
      memFilePath: "/opt/firecracker/agent.mem",
      vsockUdsPath: "/tmp/my vsock",
    }).success,
  );
});

Deno.test("fabric_up: rejects a netnsPrefix containing shell metacharacters", () => {
  assertFalse(
    model.methods.fabric_up.arguments.safeParse({
      oauthToken: "sk-ant-x",
      netnsPrefix: "fcw`id`",
    }).success,
  );
});

Deno.test("setup_tap: rejects an over-length tapName (>15 chars, Linux iface limit)", () => {
  assertFalse(
    model.methods.setup_tap.arguments.safeParse({
      tapName: "tap0123456789012",
    }).success,
  );
});

// ---------------------------------------------------------------------------
// Non-zero-exit sweep — a representative sample across the sshCurl-backed,
// direct-sshExec, and single-call lifecycle method shapes.
// ---------------------------------------------------------------------------

const NONZERO_EXIT_CASES: Array<[string, Record<string, unknown>]> = [
  ["configure", { vcpuCount: 1, memSizeMib: 128 }],
  ["start", {}],
  ["kill_vmm", {}],
  ["install_firecracker", {}],
  ["submit", { tasks: [{ prompt: "x" }] }],
  ["poll", {}],
];

for (const [name, args] of NONZERO_EXIT_CASES) {
  Deno.test(`${name}: failure — a non-zero ssh exit rejects; no resource written`, async () => {
    const { ctx, written } = makeCtx();
    await withCommandStub(
      {
        code: 255,
        stdout: "",
        stderr: "ssh: connect to host port 22: Connection refused",
      },
      async () => {
        await assertRejects(
          () => run(name, args, ctx),
          Error,
          "SSH command failed",
        );
      },
    );
    assertEquals(
      written.length,
      0,
      `${name} must write nothing on ssh failure`,
    );
  });
}

async function assertRejects(
  fn: () => Promise<unknown>,
  ErrorClass: typeof Error,
  msgIncludes: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert(
      e instanceof ErrorClass,
      `expected ${ErrorClass.name}, got ${String(e)}`,
    );
    assert(
      (e as Error).message.includes(msgIncludes),
      `expected error message to include "${msgIncludes}", got: ${
        (e as Error).message
      }`,
    );
    return;
  }
  throw new Error("expected the call to reject, but it resolved");
}

// ---------------------------------------------------------------------------
// FC-4xx throw path — sshCurl throws when the Firecracker API answers >= 400,
// surfacing the parsed fault_message (distinct failure mode from a non-zero
// SSH exit — here ssh itself succeeds, but the FC socket API rejects).
// ---------------------------------------------------------------------------

Deno.test("configure: FC 400 fault_message — sshCurl throws 'Firecracker HTTP 400 ...' with the parsed fault_message", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    fcErr(400, { fault_message: "The vCPU number is invalid!" }),
    async () => {
      await assertRejects(
        () => run("configure", { vcpuCount: 2, memSizeMib: 256 }, ctx),
        Error,
        "Firecracker HTTP 400",
      );
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("start: FC 400 fault_message includes the actual fault text (not just the status)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    fcErr(400, { fault_message: "Machine already started" }),
    async () => {
      await assertRejects(
        () => run("start", {}, ctx),
        Error,
        "Machine already started",
      );
    },
  );
});

Deno.test("set_boot: a non-JSON FC error body falls back to the raw trimmed body as the fault message", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    {
      code: 0,
      stdout: "Internal Server Error\n__HTTP_STATUS__500",
      stderr: "",
    },
    async () => {
      await assertRejects(
        () =>
          run("set_boot", {
            kernelImagePath: "/vmlinux",
            bootArgs: "console=ttyS0",
          }, ctx),
        Error,
        "Internal Server Error",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// OAuth secret-scan — mechanical backstop over every written resource and
// every rejected error message, across fabric_up + fabric_recycle (the only
// two methods that ever see a token), happy AND failure paths.
// ---------------------------------------------------------------------------

const SCAN_TOKEN = "sk-ant-oat01-mechanical-scan-do-not-leak";

Deno.test("oauth-secret-scan: the token never appears in any written resource or rejected error message, fabric_up/fabric_recycle happy AND failure paths", async () => {
  const violations: string[] = [];

  function scanWritten(written: Written[]) {
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      if (s.includes(SCAN_TOKEN)) {
        violations.push(`${w.spec}/${w.name} resource payload leaks the token`);
      }
    }
  }

  // Happy paths
  {
    const { ctx, written } = makeCtx();
    await withCommandStub(
      [
        { code: 0, stdout: "", stderr: "" }, // mkdir -p
        { code: 0, stdout: "ok", stderr: "" }, // kill_vmm
        { code: 0, stdout: "ok", stderr: "" }, // setup_tap
        { code: 0, stdout: "verified", stderr: "" }, // verify_netns
        { code: 0, stdout: "started:1", stderr: "" }, // start_vmm
        { code: 0, stdout: "deployed", stderr: "" }, // deploy_fabric
        fcOk(), // restore
      ],
      async () => {
        await run("fabric_up", { concurrency: 1, oauthToken: SCAN_TOKEN }, ctx);
      },
    );
    await withCommandStub({ code: 0, stdout: "", stderr: "" }, async () => {
      await run("fabric_recycle", { oauthToken: SCAN_TOKEN }, ctx);
    });
    scanWritten(written);
  }

  // Failure paths — the token must not leak into the thrown error either.
  for (const method of ["fabric_recycle"]) {
    const { ctx } = makeCtx();
    await withCommandStub({ code: 1, stdout: "", stderr: "boom" }, async () => {
      try {
        await run(method, { oauthToken: SCAN_TOKEN }, ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes(SCAN_TOKEN)) {
          violations.push(`${method}'s rejected error message leaks the token`);
        }
      }
    });
  }

  assertEquals(
    violations,
    [],
    `secret leak(s) found:\n${violations.join("\n")}`,
  );
});

Deno.test("oauth-secret-scan: sanity — the scanner actually flags an injected leak (anti-vacuity)", () => {
  const poisoned = { spec: "action", name: "x", payload: { note: SCAN_TOKEN } };
  assert(JSON.stringify(poisoned.payload).includes(SCAN_TOKEN));
});
