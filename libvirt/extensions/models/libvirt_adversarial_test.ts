// Adversarial tests for @bad-at-naming/libvirt — attacker's-perspective /
// hostile-environment focus, driven THROUGH the model methods (not the
// pure functions already exhaustively pinned in libvirt_connection_test.ts).
// The subprocess boundary (Deno.Command) is stubbed exactly as in
// libvirt_methods_test.ts; every patched global is restored in `finally`.
//
// Invariants under test:
//  - a metachar VM name stays one quoted argv token through vm.forceStop —
//    pinned in SSH mode (shellQuote is the defense under test) plus a
//    separate local-mode verbatim-argv case (no shell involved at all)
//  - guestInfo's type allowlist rejects an injected type BEFORE any spawn
//    (zero Deno.Command invocations before the throw)
//  - setUserPassword: a synthetic SENTINEL password is ABSENT from BOTH the
//    joined logger output AND every recorded writeResource payload, in SSH
//    mode (the shell-quoted argv token is documented ps-visibility, not a
//    log/store leak)
//  - vm.dumpxml AND vm.snapshotDumpxml: the fixture's real-looking passwd
//    value is absent from the log capture, while the STORED payload still
//    carries the raw XML (store-raw is intentional) — both directions pinned
//  - an unrelated non-zero exit on a destructive method (undefine) THROWS
//    rather than being silently swallowed as idempotent
//  - a define whose XML has no <name> never triggers the pre-emptive
//    destroy/undefine (falls through to "unknown", no domstate probe)
//  - malformed/empty virsh table output yields no phantom domain

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as vmModel } from "./libvirt_vm.ts";

// ===========================================================================
// Shared test harness (duplicated per-file by repo convention — see
// pihole_adversarial_test.ts)
// ===========================================================================

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const info: string[] = [];
  const warn: string[] = [];
  return {
    written,
    info,
    warn,
    ctx: {
      globalArgs,
      logger: {
        info: (m: string) => {
          info.push(m);
        },
        warn: (m: string) => {
          warn.push(m);
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

function run(
  model: { methods: unknown },
  name: string,
  args: Record<string, unknown>,
  ctx: unknown,
) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

interface CommandCall {
  command: string;
  args: string[];
  stdinMode: "null" | "piped";
  stdinText?: string;
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

type CommandRoute = (
  argv: string[],
  call: CommandCall,
) => CmdResult | undefined;

function unquoteTokens(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    if (s[i] !== "'") {
      throw new Error(
        `expected a quoted token at index ${i}: ${JSON.stringify(s)}`,
      );
    }
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
      tok += s[i];
      i++;
    }
    tokens.push(tok);
  }
  return tokens;
}

function logicalArgv(call: CommandCall): string[] {
  if (call.command === "virsh") {
    return call.args[0] === "-c" ? call.args.slice(2) : call.args;
  }
  if (call.command === "ssh") {
    const remote = call.args[call.args.length - 1];
    const tokens = unquoteTokens(remote);
    if (tokens[0] === "virsh") {
      return tokens[1] === "-c" ? tokens.slice(3) : tokens.slice(1);
    }
    return tokens;
  }
  throw new Error(`unrecognized fake command ${call.command}`);
}

async function withCommandStub(
  routes: CommandRoute[],
  fn: (calls: CommandCall[]) => Promise<void>,
) {
  const original = Deno.Command;
  const calls: CommandCall[] = [];
  const enc = new TextEncoder();

  function respond(call: CommandCall): CmdResult {
    const argv = logicalArgv(call);
    for (const route of routes) {
      const res = route(argv, call);
      if (res) return res;
    }
    throw new Error(
      `command stub: unrouted ${call.command} argv=${JSON.stringify(argv)}`,
    );
  }

  class FakeCommand {
    #call: CommandCall;
    constructor(
      command: string,
      options: { args: string[]; stdin?: string },
    ) {
      this.#call = {
        command,
        args: options.args,
        stdinMode: options.stdin === "piped" ? "piped" : "null",
      };
    }
    output() {
      calls.push(this.#call);
      const res = respond(this.#call);
      return Promise.resolve({
        code: res.code,
        success: res.code === 0,
        stdout: enc.encode(res.stdout),
        stderr: enc.encode(res.stderr),
      });
    }
    spawn() {
      const call = this.#call;
      return {
        stdin: {
          getWriter: () => ({
            write: (_chunk: Uint8Array) => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          calls.push(call);
          const res = respond(call);
          return Promise.resolve({
            code: res.code,
            success: res.code === 0,
            stdout: enc.encode(res.stdout),
            stderr: enc.encode(res.stderr),
          });
        },
      };
    }
  }

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = FakeCommand;
  try {
    await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}

function ok(stdout = ""): CmdResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr: string, code = 1): CmdResult {
  return { code, stdout: "", stderr };
}

function on(
  prefix: string[],
  result: CmdResult | ((argv: string[]) => CmdResult),
): CommandRoute {
  return (argv) => {
    if (prefix.length > argv.length) return undefined;
    for (let i = 0; i < prefix.length; i++) {
      if (argv[i] !== prefix[i]) return undefined;
    }
    return typeof result === "function" ? result(argv) : result;
  };
}

const LOCAL: Record<string, unknown> = {};
const SSH: Record<string, unknown> = { host: "10.0.0.5" };

// ===========================================================================
// 1. A metachar VM name stays one quoted/verbatim argv token, never a shell
//    injection, through vm.forceStop.
// ===========================================================================

const METACHAR_NAME = "victim; rm -rf /tmp/pwn";

Deno.test("[injection] forceStop SSH mode: a metachar VM name stays one quoted token (shellQuote is the defense under test)", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["destroy", METACHAR_NAME], ok()),
    on(["dominfo", METACHAR_NAME], ok("State: shut off")),
  ], async (calls) => {
    await run(vmModel, "forceStop", { name: METACHAR_NAME }, ctx);
    const destroyCall = calls.find((c) => logicalArgv(c)[0] === "destroy");
    assert(destroyCall);
    const remote = destroyCall.args[destroyCall.args.length - 1];
    assertStringIncludes(remote, `'${METACHAR_NAME}'`);
    // No bare, unquoted semicolon that would start a new remote command.
    assert(
      !/[^']; /.test(remote.replace(`'${METACHAR_NAME}'`, "")),
      `unquoted semicolon escaped the quoted token: ${remote}`,
    );
  });
});

Deno.test("[injection] forceStop LOCAL mode: a metachar VM name is a single verbatim argv element (no shell involved at all)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["destroy", METACHAR_NAME], ok()),
    on(["dominfo", METACHAR_NAME], ok("State: shut off")),
  ], async (calls) => {
    await run(vmModel, "forceStop", { name: METACHAR_NAME }, ctx);
    const destroyCall = calls.find((c) => logicalArgv(c)[0] === "destroy");
    assert(destroyCall);
    // Local mode passes argv straight to Deno.Command: the raw args array
    // must contain the metachar string as ONE element, untouched.
    assert(
      destroyCall.args.includes(METACHAR_NAME),
      "the metachar name must survive as a single argv element",
    );
  });
});

// ===========================================================================
// 2. guestInfo's allowlist rejects an injected type before any spawn.
// ===========================================================================

Deno.test('[injection] guestInfo rejects an injected "--flag"-shaped type before any Deno.Command spawn', async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([], async (calls) => {
    await assertRejects(
      () =>
        run(vmModel, "guestInfo", {
          name: "web",
          types: "hostname,--config",
        }, ctx),
      Error,
      "Invalid guestinfo type",
    );
    assertEquals(calls.length, 0, "zero spawns before the throw");
  });
});

Deno.test('[injection] guestInfo rejects a "; rm" shell-metacharacter type before any Deno.Command spawn', async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([], async (calls) => {
    await assertRejects(
      () =>
        run(vmModel, "guestInfo", {
          name: "web",
          types: "os,; rm -rf /",
        }, ctx),
      Error,
      "Invalid guestinfo type",
    );
    assertEquals(calls.length, 0);
  });
});

// ===========================================================================
// 3. setUserPassword: sentinel absent from BOTH logger output AND every
//    writeResource payload.
// ===========================================================================

const SENTINEL_PASSWORD = "sw4mp-s3ntinel-do-not-log-Zx9Q";

Deno.test("[secret] setUserPassword: the sentinel password never appears in logger output or any writeResource payload (SSH mode)", async () => {
  const { ctx, info, warn, written } = makeCtx(SSH);
  await withCommandStub([
    on(["set-user-password", "web", "alice", SENTINEL_PASSWORD], ok()),
  ], async () => {
    await run(vmModel, "setUserPassword", {
      name: "web",
      username: "alice",
      password: SENTINEL_PASSWORD,
    }, ctx);
  });
  const loggedText = [...info, ...warn].join("\n");
  assertEquals(
    loggedText.includes(SENTINEL_PASSWORD),
    false,
    "password must never appear in logger output",
  );
  const storedText = JSON.stringify(written);
  assertEquals(
    storedText.includes(SENTINEL_PASSWORD),
    false,
    "password must never appear in a written resource payload",
  );
});

// ===========================================================================
// 4. vm.dumpxml / vm.snapshotDumpxml: redact-in-log, raw-in-store — both
//    directions pinned.
// ===========================================================================

const REALISTIC_XML_WITH_PASSWORD = `<domain type='kvm'>
  <name>web</name>
  <devices>
    <graphics type='vnc' port='5900' listen='0.0.0.0' passwd='hunter2-realistic'>
      <listen type='address' address='0.0.0.0'/>
    </graphics>
  </devices>
</domain>`;

Deno.test("[redaction] vm.dumpxml: the graphics password is absent from the log, but the STORED payload keeps the raw XML", async () => {
  const { ctx, info, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["dumpxml", "web"], ok(REALISTIC_XML_WITH_PASSWORD)),
  ], async () => {
    await run(vmModel, "dumpxml", { name: "web" }, ctx);
  });
  const loggedText = info.join("\n");
  assertEquals(
    loggedText.includes("hunter2-realistic"),
    false,
    "password must not reach the log",
  );
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(
    rec.payload.message as string,
    "hunter2-realistic",
    "the stored artifact intentionally keeps the raw XML",
  );
});

Deno.test("[redaction] vm.snapshotDumpxml: the graphics password is absent from the log, but the STORED payload keeps the raw XML", async () => {
  const { ctx, info, written } = makeCtx(LOCAL);
  const snapshotXml = REALISTIC_XML_WITH_PASSWORD.replace(
    "<domain type='kvm'>",
    "<domainsnapshot><domain type='kvm'>",
  ) + "</domainsnapshot>";
  await withCommandStub([
    on(["snapshot-dumpxml", "web", "snap1"], ok(snapshotXml)),
  ], async () => {
    await run(vmModel, "snapshotDumpxml", {
      name: "web",
      snapshotName: "snap1",
    }, ctx);
  });
  const loggedText = info.join("\n");
  assertEquals(loggedText.includes("hunter2-realistic"), false);
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "hunter2-realistic");
});

// ===========================================================================
// 5. An unrelated non-zero exit on a destructive method throws, is never
//    silently swallowed as idempotent.
// ===========================================================================

Deno.test("[destructive] vm.undefine: an unrelated failure (permission denied) throws rather than being treated as idempotent", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["undefine", "web"],
      fail("error: Cannot access storage file (permission denied)"),
    ),
  ], async () => {
    await assertRejects(
      () => run(vmModel, "undefine", { name: "web" }, ctx),
      Error,
      "virsh undefine failed",
    );
  });
});

// ===========================================================================
// 6. A define whose XML has no <name> never triggers the pre-emptive
//    destroy/undefine probe.
// ===========================================================================

Deno.test("[adversarial] vm.define: XML with no <name> never triggers a domstate probe or destroy/undefine — falls straight to define", async () => {
  // SSH mode: defineXml streams straight to /dev/stdin, so this needs no
  // filesystem stub (unlike local mode, which is covered for the same guard
  // in libvirt_coverage_test.ts alongside the temp-file-source assertion).
  const { ctx, written } = makeCtx(SSH);
  const nameless = "<domain type='kvm'><devices/></domain>";
  await withCommandStub([
    on(["define", "/dev/stdin"], ok("Domain unknown defined")),
  ], async (calls) => {
    await run(vmModel, "define", { xml: nameless }, ctx);
    assertEquals(
      calls.some((c) => logicalArgv(c)[0] === "domstate"),
      false,
      "no domstate probe without a parseable <name>",
    );
    assertEquals(
      calls.some((c) => logicalArgv(c)[0] === "destroy"),
      false,
    );
    assertEquals(
      calls.some((c) => logicalArgv(c)[0] === "undefine"),
      false,
    );
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.domain, "unknown");
});

// ===========================================================================
// 7. Malformed/empty virsh table output yields no phantom domain.
// ===========================================================================

Deno.test("[adversarial] vm.list: malformed/header-only virsh output yields zero VMs, not a phantom domain", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["list", "--all", "--autostart", "--name"], ok("")),
    on(
      ["list", "--all"],
      ok(` Id   Name   State
----------------------------------`),
    ),
  ], async () => {
    await run(vmModel, "list", {}, ctx);
  });
  const rec = written.find((w) => w.spec === "vm" && w.name === "list");
  assert(rec);
  assertEquals(rec.payload.count, 0);
  assertEquals(rec.payload.vms, []);
});

Deno.test("[adversarial] vm.list: a garbage/unparseable line (no id column) is skipped, not turned into a phantom domain", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["list", "--all", "--autostart", "--name"], ok("")),
    on(
      ["list", "--all"],
      ok(` Id   Name   State
----------------------------------
 garbage line with no id column`),
    ),
  ], async () => {
    await run(vmModel, "list", {}, ctx);
  });
  const rec = written.find((w) => w.spec === "vm" && w.name === "list");
  assert(rec);
  assertEquals(rec.payload.count, 0);
});
