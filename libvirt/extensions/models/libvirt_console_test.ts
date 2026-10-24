// Contract tests for lib/console.ts — the bounded, read-only serial console
// capture behind vm.consoleCapture (issue #262).
// Run: deno test extensions/models/libvirt_console_test.ts
//
// Pinned here:
//  - argument validation (domain/device names, bounded timeoutSeconds) runs
//    BEFORE any process exists;
//  - the exact argv per transport. SSH mode wraps `virsh console` remotely in
//    `timeout -k <grace> <n> script -qec '<cmd>' /dev/null` with SHELL=/bin/sh,
//    and the inner command is shell-quoted TWICE (remote login shell, then
//    script's `sh -c`), so a hostile name stays one literal argv element;
//    local Linux uses the same `script -qec` form, BSD/macOS `script -q
//    /dev/null <argv>` (no inner shell at all);
//  - stripTerminalControl removes CSI/OSC/other escape sequences and control
//    characters but keeps text, newlines and tabs;
//  - runBounded never writes to (or closes) the child's stdin while it runs,
//    kills it at the deadline (SIGTERM, then SIGKILL after a grace period),
//    and keeps only the last `maxBytes` of output.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as vmModel } from "./libvirt_vm.ts";
import {
  buildConsoleInvocation,
  CONSOLE_MAX_TIMEOUT_SECONDS,
  ConsoleCaptureArgs,
  consoleDeadlineMs,
  runBounded,
  stripTerminalControl,
  validateConsoleTarget,
} from "./lib/console.ts";

/** Parse a space-joined sequence of POSIX single-quoted tokens (the inverse
 * of shellQuote) — used to peel each quoting layer in the SSH command. */
function unquoteTokens(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    if (s[i] !== "'") throw new Error(`unquoted token at ${i}: ${s}`);
    i++;
    let tok = "";
    while (i < s.length) {
      if (s[i] === "'") {
        if (s.slice(i, i + 4) === "'\\''") {
          tok += "'";
          i += 4;
          continue;
        }
        i++;
        break;
      }
      tok += s[i++];
    }
    tokens.push(tok);
  }
  return tokens;
}

// --- validation ---------------------------------------------------------------

Deno.test("ConsoleCaptureArgs: timeoutSeconds is required and bounded to [1, CONSOLE_MAX_TIMEOUT_SECONDS]", () => {
  assertEquals(CONSOLE_MAX_TIMEOUT_SECONDS, 300);
  assert(!ConsoleCaptureArgs.safeParse({ name: "web" }).success);
  for (const t of [0, -1, 1.5, 301, 86400]) {
    assert(
      !ConsoleCaptureArgs.safeParse({ name: "web", timeoutSeconds: t })
        .success,
      `timeoutSeconds=${t} must be rejected`,
    );
  }
  const ok = ConsoleCaptureArgs.parse({ name: "web", timeoutSeconds: 30 });
  assertEquals(ok.force, true);
  assertEquals(ok.device, undefined);
});

Deno.test("validateConsoleTarget accepts ordinary domain and device names", () => {
  validateConsoleTarget("web-01", undefined);
  validateConsoleTarget("my vm (test)", "serial0");
  validateConsoleTarget("8b2c-uuid", "console1");
  validateConsoleTarget("web", "ua-serial.1");
});

Deno.test("validateConsoleTarget rejects flag-shaped or control-character domain names", () => {
  for (const name of ["", "-x", "--devname", "a\nb", "a\rb", "a\u0000b"]) {
    assertThrows(
      () => validateConsoleTarget(name, undefined),
      Error,
      "name",
      `name ${JSON.stringify(name)}`,
    );
  }
});

Deno.test("validateConsoleTarget rejects device names outside [A-Za-z0-9][A-Za-z0-9_.-]*", () => {
  for (
    const device of ["", "-x", "serial0; reboot", "$(id)", "a b", "x'y", "a\n"]
  ) {
    assertThrows(
      () => validateConsoleTarget("web", device),
      Error,
      "device",
      `device ${JSON.stringify(device)}`,
    );
  }
});

// --- argv per transport -------------------------------------------------------

Deno.test("buildConsoleInvocation SSH: timeout+script wrapper with SHELL=/bin/sh, pinned option set from the host-key policy", () => {
  const inv = buildConsoleInvocation(
    { host: "10.0.0.5" },
    { name: "web", device: "serial0", timeoutSeconds: 30, force: true },
    { os: "linux" },
  );
  assertEquals(inv.command, "ssh");
  assertEquals(inv.args.at(-2), "root@10.0.0.5");
  assert(inv.args.join(" ").includes("StrictHostKeyChecking=accept-new"));
  const remote = unquoteTokens(inv.args.at(-1)!);
  assertEquals(remote.slice(0, 7), [
    "env",
    "SHELL=/bin/sh",
    "timeout",
    "-k",
    "5",
    "30",
    "script",
  ]);
  assertEquals(remote[7], "-qec");
  assertEquals(remote[9], "/dev/null");
  assertEquals(unquoteTokens(remote[8]), [
    "virsh",
    "console",
    "web",
    "--devname",
    "serial0",
    "--force",
  ]);
});

Deno.test("buildConsoleInvocation SSH: uri, no device, force=false", () => {
  const inv = buildConsoleInvocation(
    { host: "h", uri: "qemu:///system" },
    { name: "web", timeoutSeconds: 5, force: false },
    { os: "linux" },
  );
  const remote = unquoteTokens(inv.args.at(-1)!);
  assertEquals(unquoteTokens(remote[8]), [
    "virsh",
    "-c",
    "qemu:///system",
    "console",
    "web",
  ]);
});

Deno.test("buildConsoleInvocation SSH: a hostile domain name survives BOTH shell layers as one literal argument", () => {
  const evil = "x'; touch /tmp/pwned; echo '$(id)`id`";
  const inv = buildConsoleInvocation(
    { host: "h" },
    { name: evil, timeoutSeconds: 5, force: true },
    { os: "linux" },
  );
  const remote = unquoteTokens(inv.args.at(-1)!); // layer 1: login shell
  const inner = unquoteTokens(remote[8]); // layer 2: script's sh -c
  assertEquals(inner, ["virsh", "console", evil, "--force"]);
});

Deno.test("buildConsoleInvocation SSH strict: uses the pinned known_hosts file", () => {
  const inv = buildConsoleInvocation(
    {
      host: "h",
      hostKeyPolicy: "strict",
      knownHosts: [
        "h ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      ],
    },
    { name: "web", timeoutSeconds: 5, force: true },
    { os: "linux", knownHostsFile: "/tmp/kh1.known_hosts" },
  );
  assertStringIncludes(
    inv.args.join(" "),
    "UserKnownHostsFile=/tmp/kh1.known_hosts",
  );
  assertStringIncludes(inv.args.join(" "), "StrictHostKeyChecking=yes");
});

Deno.test("buildConsoleInvocation local Linux: env SHELL=/bin/sh script -qec '<quoted virsh console>' /dev/null — no remote timeout", () => {
  const inv = buildConsoleInvocation(
    {},
    { name: "web", device: "serial0", timeoutSeconds: 5, force: true },
    { os: "linux" },
  );
  assertEquals(inv.command, "env");
  assertEquals(inv.args.slice(0, 3), ["SHELL=/bin/sh", "script", "-qec"]);
  assertEquals(inv.args[4], "/dev/null");
  assertEquals(unquoteTokens(inv.args[3]), [
    "virsh",
    "-c",
    "qemu:///system",
    "console",
    "web",
    "--devname",
    "serial0",
    "--force",
  ]);
});

Deno.test("buildConsoleInvocation local macOS/BSD: script -q /dev/null <argv> (argv passed directly, no inner shell)", () => {
  const evil = "a'b; rm -rf /";
  const inv = buildConsoleInvocation(
    { uri: "qemu:///session" },
    { name: evil, timeoutSeconds: 5, force: false },
    { os: "darwin" },
  );
  assertEquals(inv, {
    command: "script",
    args: [
      "-q",
      "/dev/null",
      "virsh",
      "-c",
      "qemu:///session",
      "console",
      evil,
    ],
  });
});

Deno.test("buildConsoleInvocation local Windows is refused", () => {
  assertThrows(
    () =>
      buildConsoleInvocation(
        {},
        { name: "web", timeoutSeconds: 5, force: true },
        { os: "windows" },
      ),
    Error,
    "not supported",
  );
});

Deno.test("consoleDeadlineMs: local = timeout; SSH adds the remote kill grace + connect slack (Deno-side backstop)", () => {
  assertEquals(consoleDeadlineMs({}, 30), 30_000);
  assertEquals(consoleDeadlineMs({ host: "h" }, 30), 50_000);
});

// --- stripTerminalControl -------------------------------------------------------

Deno.test("stripTerminalControl removes CSI/OSC/charset escapes and normalizes CR", () => {
  const raw = "\x1b[2J\x1b[H\x1b[1;32mOK\x1b[0m boot\r\n" +
    "\x1b]0;title\x07Linux version 6.1\r\n" +
    "\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\r\n" +
    "\x1b(B\x1b=progress 10%\rprogress 100%\r\n" +
    "tab\there\x07\x08\x00\x7f\u009b end";
  assertEquals(
    stripTerminalControl(raw),
    "OK boot\nLinux version 6.1\nlink\nprogress 10%\nprogress 100%\n" +
      "tab\there end",
  );
});

Deno.test("stripTerminalControl collapses script's CR CR LF (pty ONLCR on top of a guest CRLF) into one LF", () => {
  assertEquals(stripTerminalControl("a\r\r\nb\r\nc\n"), "a\nb\nc\n");
});

Deno.test("stripTerminalControl keeps plain UTF-8 text untouched", () => {
  const s = "cloud-init: ошибка — ✓ done\nline 2\n";
  assertEquals(stripTerminalControl(s), s);
});

// --- runBounded (stubbed Deno.Command) ------------------------------------------

interface FakeChild {
  spawned: { command: string; args: string[] }[];
  stdinWrites: number;
  stdinClosedBeforeExit: boolean;
  kills: string[];
}

/** A fake process that emits `chunks` immediately, then either exits on its
 * own (`exitCode`) or hangs until killed. `ignoreTerm` makes it survive
 * SIGTERM so the SIGKILL escalation is exercised. */
async function withFakeProcess(
  opts: {
    chunks: string[];
    exitCode?: number;
    ignoreTerm?: boolean;
    stderr?: string;
  },
  fn: (child: FakeChild) => Promise<void>,
) {
  const original = Deno.Command;
  const enc = new TextEncoder();
  const state: FakeChild = {
    spawned: [],
    stdinWrites: 0,
    stdinClosedBeforeExit: false,
    kills: [],
  };
  class FakeCommand {
    #command: string;
    #args: string[];
    constructor(cmd: string, o: { args: string[] }) {
      this.#command = cmd;
      this.#args = o.args;
    }
    spawn() {
      state.spawned.push({ command: this.#command, args: this.#args });
      let exited = false;
      let resolveStatus!: (s: unknown) => void;
      const status = new Promise((r) => (resolveStatus = r));
      let outCtl!: ReadableStreamDefaultController<Uint8Array>;
      let errCtl!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          outCtl = c;
          for (const ch of opts.chunks) c.enqueue(enc.encode(ch));
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(c) {
          errCtl = c;
          if (opts.stderr) c.enqueue(enc.encode(opts.stderr));
        },
      });
      const exit = (code: number, signal: string | null) => {
        if (exited) return;
        exited = true;
        try {
          outCtl.close();
        } catch { /* already closed */ }
        try {
          errCtl.close();
        } catch { /* already closed */ }
        resolveStatus({ success: code === 0, code, signal });
      };
      const stdin = new WritableStream<Uint8Array>({
        write() {
          state.stdinWrites++;
        },
        close() {
          if (!exited) state.stdinClosedBeforeExit = true;
        },
      });
      if (opts.exitCode !== undefined) {
        queueMicrotask(() => exit(opts.exitCode!, null));
      }
      return {
        stdin,
        stdout,
        stderr,
        status,
        kill(sig: string = "SIGTERM") {
          state.kills.push(sig);
          if (sig === "SIGTERM" && opts.ignoreTerm) return;
          exit(sig === "SIGKILL" ? 137 : 143, sig);
        },
      };
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = FakeCommand;
  try {
    await fn(state);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}

Deno.test("runBounded: a process that never exits is SIGTERMed at the deadline; output so far is returned; stdin untouched", async () => {
  await withFakeProcess(
    { chunks: ["boot line 1\n", "boot line 2\n"] },
    async (child) => {
      const res = await runBounded("ssh", [], {
        deadlineMs: 30,
        killGraceMs: 30,
        maxBytes: 1024,
      });
      assertEquals(res.timedOut, true);
      assertEquals(res.stdout, "boot line 1\nboot line 2\n");
      assertEquals(res.truncated, false);
      assertEquals(child.kills, ["SIGTERM"]);
      assertEquals(child.stdinWrites, 0);
      assertEquals(child.stdinClosedBeforeExit, false);
    },
  );
});

Deno.test("runBounded: a process that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  await withFakeProcess({ chunks: ["x"], ignoreTerm: true }, async (child) => {
    const res = await runBounded("ssh", [], {
      deadlineMs: 20,
      killGraceMs: 20,
      maxBytes: 1024,
    });
    assertEquals(res.timedOut, true);
    assertEquals(child.kills, ["SIGTERM", "SIGKILL"]);
    assertEquals(res.code, 137);
  });
});

Deno.test("runBounded: a process that exits on its own is not killed and reports its code + stderr", async () => {
  await withFakeProcess(
    { chunks: ["bye\n"], exitCode: 124, stderr: "warn\n" },
    async (child) => {
      const res = await runBounded("ssh", [], {
        deadlineMs: 5_000,
        killGraceMs: 1_000,
        maxBytes: 1024,
      });
      assertEquals(res.timedOut, false);
      assertEquals(res.code, 124);
      assertEquals(res.stdout, "bye\n");
      assertEquals(res.stderr, "warn\n");
      assertEquals(child.kills, []);
      assertEquals(child.stdinWrites, 0);
    },
  );
});

Deno.test("runBounded: output beyond maxBytes keeps the LAST maxBytes and flags truncation", async () => {
  await withFakeProcess(
    { chunks: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], exitCode: 0 },
    async () => {
      const res = await runBounded("ssh", [], {
        deadlineMs: 5_000,
        killGraceMs: 1_000,
        maxBytes: 15,
      });
      assertEquals(res.stdout, "bbbbbcccccccccc");
      assertEquals(res.truncated, true);
    },
  );
});

// --- vm.consoleCapture (method level) -------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      logger: {
        info: (m: string) => {
          logs.push(m);
        },
        warn: (m: string) => {
          logs.push(m);
        },
      },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ name });
      },
    },
  };
}

function capture(args: Record<string, unknown>, ctx: unknown) {
  const m = vmModel.methods.consoleCapture;
  return m.execute(m.arguments.parse(args) as never, ctx as never);
}

const SECRET_LINE = "cloud-init: password=hunter2-SENTINEL";

Deno.test("vm.consoleCapture SSH: deadline reached (timeout exit 124) stores stripped text in a sensitive console resource, never logs it", async () => {
  const { ctx, written, logs } = makeCtx({ host: "10.0.0.5" });
  await withFakeProcess({
    chunks: [
      "Connected to domain 'web'\r\nEscape character is ^] (Ctrl + ])\r\n",
      `\x1b[0;1m[  OK  ]\x1b[0m Started\r\n${SECRET_LINE}\r\n`,
    ],
    exitCode: 124,
  }, async (child) => {
    await capture({ name: "web", timeoutSeconds: 30 }, ctx);
    assertEquals(child.spawned.length, 1);
    assertEquals(child.spawned[0].command, "ssh");
    const remote = unquoteTokens(child.spawned[0].args.at(-1)!);
    assertEquals(remote.slice(2, 6), ["timeout", "-k", "5", "30"]);
    assertEquals(child.stdinWrites, 0);
    assertEquals(child.stdinClosedBeforeExit, false);
  });
  assertEquals(written.length, 1);
  const rec = written[0];
  assertEquals(rec.spec, "console");
  assertEquals(rec.name, "web");
  assertEquals(rec.payload.name, "web");
  assertEquals(rec.payload.device, "");
  assertEquals(rec.payload.host, "10.0.0.5");
  assertEquals(rec.payload.timeoutSeconds, 30);
  assertEquals(rec.payload.ended, "deadline");
  assertEquals(rec.payload.truncated, false);
  const text = rec.payload.text as string;
  assertStringIncludes(text, "[  OK  ] Started\n");
  assertStringIncludes(text, SECRET_LINE);
  assert(!text.includes("\x1b") && !text.includes("\r"));
  assertEquals(rec.payload.bytes, new TextEncoder().encode(text).length);
  assert(
    !logs.join("\n").includes("SENTINEL"),
    "captured console text must never reach the logger",
  );
});

Deno.test("vm.consoleCapture: the console resource's text field is marked sensitive", () => {
  const schema = vmModel.resources.console.schema;
  const text = schema.shape.text;
  assertEquals(text.meta()?.sensitive, true);
});

Deno.test("vm.consoleCapture SSH: a console that closes on its own (exit 0) is ended=exited; device is passed and named in the instance", async () => {
  const { ctx, written } = makeCtx({ host: "h" });
  await withFakeProcess({ chunks: ["login: "], exitCode: 0 }, async (child) => {
    await capture({
      name: "web",
      device: "serial1",
      timeoutSeconds: 5,
      force: false,
    }, ctx);
    const remote = unquoteTokens(child.spawned[0].args.at(-1)!);
    assertEquals(unquoteTokens(remote[8]), [
      "virsh",
      "console",
      "web",
      "--devname",
      "serial1",
    ]);
  });
  assertEquals(written[0].name, "web-serial1");
  assertEquals(written[0].payload.device, "serial1");
  assertEquals(written[0].payload.ended, "exited");
  assertEquals(written[0].payload.text, "login: ");
});

Deno.test("vm.consoleCapture SSH: a virsh error (domain not running) throws with ONLY the error line, writes nothing", async () => {
  const { ctx, written } = makeCtx({ host: "h" });
  await withFakeProcess({
    chunks: [
      `${SECRET_LINE}\r\nerror: The domain is not running\r\n`,
    ],
    exitCode: 1,
  }, async () => {
    const err = await assertRejects(
      () => capture({ name: "web", timeoutSeconds: 5 }, ctx),
      Error,
      "error: The domain is not running",
    );
    assert(!err.message.includes("SENTINEL"));
  });
  assertEquals(written.length, 0);
});

Deno.test("vm.consoleCapture SSH: an ssh failure (255) or missing remote tool (127) throws", async () => {
  for (
    const [code, stderr] of [
      [255, "ssh: connect to host h port 22: Connection refused\n"],
      [127, "timeout: failed to run command 'script': No such file\n"],
    ] as const
  ) {
    const { ctx, written } = makeCtx({ host: "h" });
    await withFakeProcess({ chunks: [], exitCode: code, stderr }, async () => {
      await assertRejects(
        () => capture({ name: "web", timeoutSeconds: 5 }, ctx),
        Error,
        `exit ${code}`,
      );
    });
    assertEquals(written.length, 0);
  }
});

Deno.test("vm.consoleCapture local: runs virsh console under script on this host (no remote timeout) and records the capture", async () => {
  const { ctx, written } = makeCtx({});
  await withFakeProcess(
    { chunks: ["Booting\r\n"], exitCode: 0 },
    async (child) => {
      await capture({ name: "web", timeoutSeconds: 5 }, ctx);
      const { command, args } = child.spawned[0];
      assert(command === "env" || command === "script", command);
      assert(!args.includes("timeout"));
      assert(args.join(" ").includes("console"));
    },
  );
  assertEquals(written[0].payload.host, "qemu:///system");
  assertEquals(written[0].payload.text, "Booting\n");
});

Deno.test("vm.consoleCapture rejects a flag-shaped name, a hostile device and an out-of-range timeout before any process", async () => {
  for (
    const args of [
      { name: "--help", timeoutSeconds: 5 },
      { name: "web", device: "serial0; reboot", timeoutSeconds: 5 },
    ]
  ) {
    const { ctx } = makeCtx({ host: "h" });
    await withFakeProcess({ chunks: [] }, async (child) => {
      await assertRejects(() => capture(args, ctx));
      assertEquals(child.spawned.length, 0);
    });
  }
  assertThrows(() =>
    vmModel.methods.consoleCapture.arguments.parse({
      name: "web",
      timeoutSeconds: 3600,
    })
  );
});

Deno.test("vm.consoleCapture strict host keys: the pinned known_hosts file is created, used and removed", async () => {
  const { ctx } = makeCtx({
    host: "h",
    hostKeyPolicy: "strict",
    knownHosts: [
      "h ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    ],
  });
  const log: string[] = [];
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  const saved = [D.makeTempFile, D.chmod, D.writeTextFile, D.remove];
  D.makeTempFile = () => (log.push("make"), Promise.resolve("/tmp/kh9.kh"));
  D.chmod = () => (log.push("chmod"), Promise.resolve());
  D.writeTextFile = () => (log.push("write"), Promise.resolve());
  D.remove = () => (log.push("remove"), Promise.resolve());
  try {
    await withFakeProcess({ chunks: ["x"], exitCode: 124 }, async (child) => {
      await capture({ name: "web", timeoutSeconds: 5 }, ctx);
      assertStringIncludes(
        child.spawned[0].args.join(" "),
        "UserKnownHostsFile=/tmp/kh9.kh",
      );
    });
  } finally {
    [D.makeTempFile, D.chmod, D.writeTextFile, D.remove] = saved;
  }
  assertEquals(log, ["make", "chmod", "write", "remove"]);
});
