// Method-level tests for @bad-at-naming/libvirt — drives every vm/network/
// storage/host method's success + failure/idempotent path against a stubbed
// subprocess boundary (globalThis.Deno.Command). No real virsh, ssh, or
// hypervisor is ever contacted.
//
// Transport right-sizing: FULL method coverage runs in LOCAL mode (raw argv,
// no shell); the SSH quoted-remote transport is exercised through a
// representative subset (one destructive call, one define-from-XML streaming
// to /dev/stdin, one metachar-name) because libvirt_connection_test.ts
// already pins the exhaustive SSH quoting/argv contract. `define` is
// exercised in BOTH transports because only there does the transport change
// the code path (temp-file+define locally vs. an XML stream over SSH's
// stdin). host.addRoute's success path exists ONLY in SSH mode (runSshRaw
// throws in local mode — the local-mode throw itself is pinned in
// libvirt_coverage_test.ts).
//
// The subprocess fake implements BOTH `.output()` (the stdin:"null" path used
// by every virsh/ssh call except one) AND `.spawn()` returning a child with a
// writable `stdin.getWriter()`/`.close()`/`.output()` (the stdin:"piped" path
// used ONLY by defineXml streaming XML to /dev/stdin over SSH). Local-mode
// `define` additionally stubs Deno.makeTempFile/writeTextFile/remove (no real
// filesystem I/O). Every patched global is restored in a `finally` so nothing
// leaks across tests.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as vmModel } from "./libvirt_vm.ts";
import { model as networkModel } from "./libvirt_network.ts";
import { model as storageModel } from "./libvirt_storage.ts";
import { model as hostModel } from "./libvirt_host.ts";

// ===========================================================================
// Shared test harness
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

/** Drive a model method the way the swamp runtime does: parse the args
 * through the method's zod schema, then execute. */
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

// --- Deno.Command stub -------------------------------------------------------

export interface CommandCall {
  command: string;
  args: string[];
  stdinMode: "null" | "piped";
  stdinText?: string;
}

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRoute = (
  argv: string[],
  call: CommandCall,
) => CmdResult | undefined;

/** Reverse of lib/connection.ts's shellQuote: parse a space-joined sequence
 * of POSIX single-quoted tokens back into an array. Test-only — the source
 * never needs to unquote; only these fakes matching on logical argv do. */
export function unquoteTokens(s: string): string[] {
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

/** The logical virsh (or raw-ssh) argv for a recorded call, independent of
 * transport encoding: local mode strips the `-c <uri>` prefix; SSH mode
 * unquotes the remote command string and strips a leading `virsh [-c <uri>]`
 * prefix (buildSshRaw's raw remote commands, e.g. `ip route`, have none). */
export function logicalArgv(call: CommandCall): string[] {
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

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function withCommandStub(
  routes: CommandRoute[],
  fn: (calls: CommandCall[]) => Promise<void>,
) {
  const original = Deno.Command;
  const calls: CommandCall[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();

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
    #chunks: Uint8Array[] = [];
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
      const chunks = this.#chunks;
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              chunks.push(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          call.stdinText = dec.decode(concatChunks(chunks));
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

export function ok(stdout = ""): CmdResult {
  return { code: 0, stdout, stderr: "" };
}

export function fail(stderr: string, code = 1): CmdResult {
  return { code, stdout: "", stderr };
}

/** Route matching the argv whose first tokens equal `prefix` exactly. */
export function on(
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

// --- Deno.makeTempFile/writeTextFile/remove stub (local-mode define/net-define) --

export interface TempFileCalls {
  made: string[];
  written: { path: string; content: string }[];
  removed: string[];
}

export async function withTempFileStub(
  fn: (calls: TempFileCalls) => Promise<void>,
) {
  const originalMake = Deno.makeTempFile;
  const originalWrite = Deno.writeTextFile;
  const originalRemove = Deno.remove;
  const calls: TempFileCalls = { made: [], written: [], removed: [] };
  let n = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).makeTempFile = (_opts?: unknown) => {
    const path = `/tmp/fake-swamp-libvirt-${++n}.xml`;
    calls.made.push(path);
    return Promise.resolve(path);
  };
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = (path: string, content: string) => {
    calls.written.push({ path, content });
    return Promise.resolve();
  };
  // deno-lint-ignore no-explicit-any
  (Deno as any).remove = (path: string) => {
    calls.removed.push(path);
    return Promise.resolve();
  };
  try {
    await fn(calls);
  } finally {
    Deno.makeTempFile = originalMake;
    Deno.writeTextFile = originalWrite;
    Deno.remove = originalRemove;
  }
}

export const LOCAL: Record<string, unknown> = {}; // no host => local/URI mode
export const SSH: Record<string, unknown> = { host: "10.0.0.5" }; // SSH mode

// ===========================================================================
// vm model
// ===========================================================================

Deno.test("vm.list: lists VMs with autostart/uuid/vcpus/memory merged in", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["list", "--all", "--autostart", "--name"], ok("web\n")),
    on(
      ["list", "--all"],
      ok(` Id   Name   State
------------------------------
 1    web    running`),
    ),
    on(
      ["dominfo", "web"],
      ok(`UUID:           uuid-web
State:          running
CPU(s):         2
Max memory:     2097152`),
    ),
  ], async (calls) => {
    await run(vmModel, "list", {}, ctx);
    assertEquals(calls.length, 3);
  });
  const rec = written.find((w) => w.spec === "vm" && w.name === "list");
  assert(rec);
  assertEquals(rec.payload.count, 1);
  assertEquals((rec.payload.vms as unknown[])[0], {
    name: "web",
    state: "running",
    autostart: "enabled",
    vcpus: 2,
    memoryMB: 2048,
    uuid: "uuid-web",
  });
});

Deno.test("vm.get: merges dominfo + dumpxml disks/interfaces/graphics", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  const xml = `<domain>
    <devices>
      <disk type='file' device='disk'>
        <source file='/images/web.qcow2'/>
        <target dev='vda' bus='virtio'/>
      </disk>
    </devices>
  </domain>`;
  await withCommandStub([
    on(["dominfo", "web"], ok(`UUID:  uuid-web\nState: running\nCPU(s): 2`)),
    on(["dumpxml", "web"], ok(xml)),
  ], async () => {
    await run(vmModel, "get", { name: "web" }, ctx);
  });
  const rec = written.find((w) => w.spec === "vm" && w.name === "web");
  assert(rec);
  assertEquals(rec.payload.disks, [
    { source: "/images/web.qcow2", target: "vda", bus: "virtio" },
  ]);
});

Deno.test("vm.dumpxml: writes the raw XML to actionResult", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["dumpxml", "web"], ok("<domain><name>web</name></domain>")),
  ], async () => {
    await run(vmModel, "dumpxml", { name: "web" }, ctx);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.message, "<domain><name>web</name></domain>");
  assertEquals(rec.payload.action, "dumpxml");
});

Deno.test("vm.start: success issues `virsh start` then reports state", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["start", "web"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "start", { name: "web" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["start", "web"]);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.action, "start");
});

Deno.test("vm.start: already-running is idempotent (no throw)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["start", "web"], fail("error: Domain is already active")),
    on(["dominfo", "web"], ok("State: running")),
  ], async () => {
    await run(vmModel, "start", { name: "web" }, ctx);
  });
});

Deno.test("vm.start: a genuine failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["start", "web"], fail("error: internal error: process exited")),
  ], async () => {
    await assertRejects(
      () => run(vmModel, "start", { name: "web" }, ctx),
      Error,
      "virsh start failed",
    );
  });
});

Deno.test("vm.stop: issues `virsh shutdown` (graceful)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["shutdown", "web"], ok()),
    on(["dominfo", "web"], ok("State: in shutdown")),
  ], async (calls) => {
    await run(vmModel, "stop", { name: "web" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["shutdown", "web"]);
  });
});

Deno.test("vm.stop: already-stopped is idempotent", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["shutdown", "web"], fail("error: domain is not running")),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async () => {
    await run(vmModel, "stop", { name: "web" }, ctx);
  });
});

Deno.test("vm.stop: a genuine failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["shutdown", "web"], fail("error: something else broke")),
  ], async () => {
    await assertRejects(() => run(vmModel, "stop", { name: "web" }, ctx));
  });
});

Deno.test("vm.forceStop: issues `virsh destroy`", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["destroy", "web"], ok()),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async (calls) => {
    await run(vmModel, "forceStop", { name: "web" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["destroy", "web"]);
  });
});

Deno.test("vm.forceStop: domain exists but already stopped is idempotent (destroy no-op, dominfo still succeeds)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["destroy", "web"], fail("error: domain is not running")),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async () => {
    await run(vmModel, "forceStop", { name: "web" }, ctx);
  });
});

Deno.test("vm.forceStop: a fully-undefined domain's destroy is idempotent, but reportState's dominfo lookup still throws (reportState always re-queries the domain — a real gap, pinned as-is, source unchanged)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["destroy", "web"], fail("error: Domain not found: no domain 'web'")),
    on(["dominfo", "web"], fail("error: failed to get domain")),
  ], async () => {
    await assertRejects(
      () => run(vmModel, "forceStop", { name: "web" }, ctx),
      Error,
      "virsh dominfo failed",
    );
  });
});

Deno.test("vm.forceStop SSH mode: the representative destructive call over SSH issues the same `destroy` verb, quoted-remote", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["destroy", "web"], ok()),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async (calls) => {
    await run(vmModel, "forceStop", { name: "web" }, ctx);
    assertEquals(calls[0].command, "ssh");
    assertEquals(logicalArgv(calls[0]), ["destroy", "web"]);
  });
});

Deno.test("vm.simple lifecycle actions issue the right virsh verb and report state", async () => {
  // The action label written to actionResult is the VIRSH VERB passed to
  // reportState, not the method name — restart is the one case where they
  // differ (method "restart" issues `reboot` and reports action "reboot").
  const cases: { method: string; verb: string; action: string }[] = [
    { method: "restart", verb: "reboot", action: "reboot" },
    { method: "reset", verb: "reset", action: "reset" },
    { method: "suspend", verb: "suspend", action: "suspend" },
    { method: "resume", verb: "resume", action: "resume" },
  ];
  for (const { method, verb, action } of cases) {
    const { ctx, written } = makeCtx(LOCAL);
    await withCommandStub([
      on([verb, "web"], ok()),
      on(["dominfo", "web"], ok("State: running")),
    ], async (calls) => {
      await run(vmModel, method, { name: "web" }, ctx);
      assertEquals(logicalArgv(calls[0]), [verb, "web"], `method ${method}`);
    });
    const rec = written.find((w) => w.spec === "actionResult");
    assert(rec, `${method} writes actionResult`);
    assertEquals(rec.payload.action, action);
  }
});

Deno.test("vm.autostart: enabled/disabled toggle the right flag", async () => {
  for (
    const [enabled, expected] of [
      [true, ["autostart", "web"]],
      [false, ["autostart", "--disable", "web"]],
    ] as const
  ) {
    const { ctx } = makeCtx(LOCAL);
    await withCommandStub([
      on(expected as unknown as string[], ok()),
      on(["dominfo", "web"], ok("State: running")),
    ], async (calls) => {
      await run(vmModel, "autostart", { name: "web", enabled }, ctx);
      assertEquals(logicalArgv(calls[0]), expected as unknown as string[]);
    });
  }
});

// --- vm.define (functional + transport; destructive gating lives in
// libvirt_coverage_test.ts) ---------------------------------------------------

Deno.test("vm.define local: fresh define (no existing domain) skips destroy/undefine", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  const xml = "<domain><name>fresh</name></domain>";
  await withTempFileStub(async (tmp) => {
    await withCommandStub([
      on(["domstate", "fresh"], fail("error: failed to get domain")),
      on(["define"], (argv) => {
        assertEquals(argv[1], tmp.made[0]);
        return ok("Domain fresh defined from /tmp/x");
      }),
    ], async (calls) => {
      await run(vmModel, "define", { xml }, ctx);
      assertEquals(
        calls.some((c) => logicalArgv(c)[0] === "destroy"),
        false,
        "no destroy for a domain that doesn't exist yet",
      );
      assertEquals(
        calls.some((c) => logicalArgv(c)[0] === "undefine"),
        false,
      );
    });
    assertEquals(tmp.written[0].content, xml);
    assertEquals(tmp.removed, tmp.made, "temp file removed after define");
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.domain, "fresh");
  assertEquals(rec.payload.state, "shut off");
});

Deno.test("vm.define local: redefining a RUNNING domain destroys then undefines --nvram before redefining", async () => {
  const { ctx } = makeCtx(LOCAL);
  const xml = "<domain><name>web</name></domain>";
  await withTempFileStub(async () => {
    await withCommandStub([
      on(["domstate", "web"], ok("running")),
      on(["destroy", "web"], ok()),
      on(["undefine", "web", "--nvram"], ok()),
      on(["define"], ok("Domain web defined")),
    ], async (calls) => {
      await run(vmModel, "define", { xml }, ctx);
      const verbs = calls.map((c) => logicalArgv(c)[0]);
      assertEquals(verbs, ["domstate", "destroy", "undefine", "define"]);
    });
  });
});

Deno.test("vm.define ssh: streams XML to /dev/stdin (stdin piped) instead of a temp file", async () => {
  const { ctx } = makeCtx(SSH);
  const xml = "<domain><name>fresh</name></domain>";
  await withCommandStub([
    on(["domstate", "fresh"], fail("error: failed to get domain")),
    on(["define", "/dev/stdin"], ok("Domain fresh defined")),
  ], async (calls) => {
    await run(vmModel, "define", { xml }, ctx);
    const defineCall = calls.find((c) => logicalArgv(c)[0] === "define");
    assert(defineCall);
    assertEquals(defineCall.stdinMode, "piped");
    assertEquals(defineCall.stdinText, xml);
  });
});

Deno.test("vm.undefine: default flags issue plain undefine and succeed", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web"], ok("Domain web has been undefined")),
  ], async (calls) => {
    await run(vmModel, "undefine", { name: "web" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["undefine", "web"]);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.state, "undefined");
});

Deno.test("vm.undefine: already-undefined (domain not found) is idempotent", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web"], fail("error: Domain not found")),
  ], async () => {
    await run(vmModel, "undefine", { name: "web" }, ctx);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "already undefined");
});

Deno.test("vm.undefine: a genuine failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web"], fail("error: permission denied")),
  ], async () => {
    await assertRejects(() => run(vmModel, "undefine", { name: "web" }, ctx));
  });
});

Deno.test("vm.rename: issues domrename with old and new names", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domrename", "web", "web2"], ok("Domain successfully renamed")),
  ], async (calls) => {
    await run(vmModel, "rename", { name: "web", newName: "web2" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["domrename", "web", "web2"]);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.name, "web2");
});

Deno.test("vm.save: issues save with name + file path", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["save", "web", "/var/state/web.save"], ok()),
  ], async (calls) => {
    await run(
      vmModel,
      "save",
      { name: "web", file: "/var/state/web.save" },
      ctx,
    );
    assertEquals(logicalArgv(calls[0]), ["save", "web", "/var/state/web.save"]);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.action, "save");
});

Deno.test("vm.restore: issues restore with the file path only", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["restore", "/var/state/web.save"], ok()),
  ], async (calls) => {
    await run(vmModel, "restore", { file: "/var/state/web.save" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["restore", "/var/state/web.save"]);
  });
});

Deno.test("vm.setVcpus: default (no flags) applies --live", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["setvcpus", "web", "4", "--live"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "setVcpus", { name: "web", count: 4 }, ctx);
    assertEquals(logicalArgv(calls[0]), ["setvcpus", "web", "4", "--live"]);
  });
});

Deno.test("vm.setVcpus: live=false with no config forces --config (virsh needs one of --live/--config/--current)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["setvcpus", "web", "4", "--config"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(
      vmModel,
      "setVcpus",
      { name: "web", count: 4, live: false },
      ctx,
    );
    assertEquals(logicalArgv(calls[0]), ["setvcpus", "web", "4", "--config"]);
  });
});

Deno.test("vm.setVcpus: maximum=true uses --maximum instead of --live", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["setvcpus", "web", "8", "--maximum"], ok()),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async (calls) => {
    await run(
      vmModel,
      "setVcpus",
      { name: "web", count: 8, maximum: true },
      ctx,
    );
    assertEquals(logicalArgv(calls[0]), ["setvcpus", "web", "8", "--maximum"]);
  });
});

Deno.test("vm.setMemory: default sets live memory in KiB", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["setmem", "web", "2097152", "--live"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "setMemory", { name: "web", sizeMB: 2048 }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["setmem", "web", "2097152", "--live"],
    );
  });
});

Deno.test("vm.setMemory: maximum=true switches the command to setmaxmem — unlike setVcpus, there is no --maximum FLAG, and the length-3 fallback still forces --config", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["setmaxmem", "web", "4194304", "--config"], ok()),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async (calls) => {
    await run(
      vmModel,
      "setMemory",
      { name: "web", sizeMB: 4096, maximum: true },
      ctx,
    );
    assertEquals(
      logicalArgv(calls[0]),
      ["setmaxmem", "web", "4194304", "--config"],
    );
  });
});

Deno.test("vm.attachDisk: builds driver/subdriver/cache/persistent flags", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on([
      "attach-disk",
      "web",
      "/images/data.qcow2",
      "vdb",
      "--driver",
      "qemu",
      "--subdriver",
      "qcow2",
      "--cache",
      "writeback",
      "--persistent",
    ], ok("Disk attached successfully")),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "attachDisk", {
      name: "web",
      source: "/images/data.qcow2",
      target: "vdb",
      cache: "writeback",
      persistent: true,
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "attach-disk");
  });
});

Deno.test("vm.detachDisk: success issues detach-disk", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["detach-disk", "web", "vdb"], ok("Disk detached successfully")),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "detachDisk", { name: "web", target: "vdb" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["detach-disk", "web", "vdb"]);
  });
});

Deno.test("vm.detachDisk: disk-not-found is idempotent (no throw)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["detach-disk", "web", "vdz"], fail("error: No disk found")),
    on(["dominfo", "web"], ok("State: running")),
  ], async () => {
    await run(vmModel, "detachDisk", { name: "web", target: "vdz" }, ctx);
  });
});

Deno.test("vm.detachDisk: an unrelated failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["detach-disk", "web", "vdb"], fail("error: permission denied")),
  ], async () => {
    await assertRejects(
      () => run(vmModel, "detachDisk", { name: "web", target: "vdb" }, ctx),
    );
  });
});

Deno.test("vm.attachInterface: builds type/source/model/persistent argv", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on([
      "attach-interface",
      "web",
      "bridge",
      "br0",
      "--model",
      "virtio",
      "--persistent",
    ], ok("Interface attached successfully")),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "attachInterface", {
      name: "web",
      type: "bridge",
      source: "br0",
      persistent: true,
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "attach-interface");
  });
});

Deno.test("vm.detachInterface: builds type/--mac argv", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["detach-interface", "web", "bridge", "--mac", "52:54:00:aa:bb:cc"],
      ok(),
    ),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "detachInterface", {
      name: "web",
      type: "bridge",
      mac: "52:54:00:aa:bb:cc",
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "detach-interface");
  });
});

Deno.test("vm.changeMedia: insert passes source + --insert", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["change-media", "web", "hda", "/iso/live.iso", "--insert"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "changeMedia", {
      name: "web",
      target: "hda",
      source: "/iso/live.iso",
    }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["change-media", "web", "hda", "/iso/live.iso", "--insert"],
    );
  });
});

Deno.test("vm.changeMedia: omitted source ejects", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["change-media", "web", "hda", "--eject"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "changeMedia", { name: "web", target: "hda" }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["change-media", "web", "hda", "--eject"],
    );
  });
});

Deno.test("vm.blockList: writes stats with domblklist output", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domblklist", "web", "--details"], ok("vda  disk  /images/web.qcow2")),
  ], async () => {
    await run(vmModel, "blockList", { name: "web" }, ctx);
  });
  const rec = written.find((w) => w.name === "web-blklist");
  assert(rec);
});

Deno.test("vm.interfaceList: writes stats with domiflist output", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domiflist", "web"], ok("vnet0 bridge br0 virtio")),
  ], async () => {
    await run(vmModel, "interfaceList", { name: "web" }, ctx);
  });
  assert(written.find((w) => w.name === "web-iflist"));
});

Deno.test("vm.interfaceAddresses: defaults to source=lease", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domifaddr", "web", "--source", "lease"], ok("vnet0  ...  10.0.0.5")),
  ], async (calls) => {
    await run(vmModel, "interfaceAddresses", { name: "web" }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["domifaddr", "web", "--source", "lease"],
    );
  });
  const rec = written.find((w) => w.name === "web-ifaddr");
  assert(rec);
  assertEquals((rec.payload.stats as Record<string, string>).source, "lease");
});

Deno.test("vm.blockStats: without device omits the device arg", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domblkstat", "web"], ok("vda rd_req 10")),
  ], async (calls) => {
    await run(vmModel, "blockStats", { name: "web" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["domblkstat", "web"]);
  });
  assert(written.find((w) => w.name === "web-blkstat"));
});

Deno.test("vm.blockStats: with device appends it", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domblkstat", "web", "vda"], ok("rd_req 10")),
  ], async (calls) => {
    await run(vmModel, "blockStats", { name: "web", device: "vda" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["domblkstat", "web", "vda"]);
  });
});

Deno.test("vm.interfaceStats: issues domifstat with interface name", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domifstat", "web", "vnet0"], ok("rx_bytes: 100")),
  ], async () => {
    await run(
      vmModel,
      "interfaceStats",
      { name: "web", interface: "vnet0" },
      ctx,
    );
  });
  assert(written.find((w) => w.name === "web-ifstat"));
});

Deno.test("vm.memoryStats: parses whitespace-separated stat lines", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["dommemstat", "web"], ok("actual 2097152\nrss 1048576")),
  ], async () => {
    await run(vmModel, "memoryStats", { name: "web" }, ctx);
  });
  const rec = written.find((w) => w.name === "web-memstat");
  assert(rec);
  assertEquals((rec.payload.stats as Record<string, string>).actual, "2097152");
});

Deno.test("vm.cpuStats: issues cpu-stats --total", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["cpu-stats", "web", "--total"], ok("cpu_time: 123.4s")),
  ], async (calls) => {
    await run(vmModel, "cpuStats", { name: "web" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["cpu-stats", "web", "--total"]);
  });
  assert(written.find((w) => w.name === "web-cpustat"));
});

Deno.test("vm.domstats: parses key=value stat lines", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["domstats", "web"], ok("Domain: 'web'\nstate.state=1\nstate.reason=1")),
  ], async () => {
    await run(vmModel, "domstats", { name: "web" }, ctx);
  });
  const rec = written.find((w) => w.name === "web-domstats");
  assert(rec);
  assertEquals(
    (rec.payload.stats as Record<string, string>)["state.state"],
    "1",
  );
});

Deno.test("vm.snapshotList: merges snapshot-list rows with snapshot-info", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["snapshot-list", "web", "--tree"], ok("snap1")),
    on(
      ["snapshot-list", "web"],
      ok(` Name    Creation Time              State
------------------------------------------------
 snap1   2026-01-01 00:00:00 +0000  running`),
    ),
    on(
      ["snapshot-info", "web", "snap1"],
      ok("Parent: -\nDescription: a snap"),
    ),
  ], async () => {
    await run(vmModel, "snapshotList", { name: "web" }, ctx);
  });
  const rec = written.find((w) =>
    w.name === "web-list" && w.spec === "snapshot"
  );
  assert(rec);
  assertEquals(rec.payload.count, 1);
  assertEquals(
    (rec.payload.snapshots as { description: string }[])[0].description,
    "a snap",
  );
});

Deno.test("vm.snapshotCreate: builds --name/--description/--quiesce/--disk-only", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on([
      "snapshot-create-as",
      "web",
      "--name",
      "snap1",
      "--description",
      "before upgrade",
      "--quiesce",
      "--disk-only",
    ], ok("Domain snapshot snap1 created")),
  ], async (calls) => {
    await run(vmModel, "snapshotCreate", {
      name: "web",
      snapshotName: "snap1",
      description: "before upgrade",
      quiesce: true,
      diskOnly: true,
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "snapshot-create-as");
  });
});

Deno.test("vm.snapshotInfo: issues snapshot-info", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["snapshot-info", "web", "snap1"],
      ok("Name: snap1\nState: running\nParent: -"),
    ),
  ], async () => {
    await run(
      vmModel,
      "snapshotInfo",
      { name: "web", snapshotName: "snap1" },
      ctx,
    );
  });
  const rec = written.find((w) => w.name === "web-snap1");
  assert(rec);
  assertEquals(rec.payload.state, "running");
});

Deno.test("vm.snapshotRevert: builds --running/--paused flags", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["snapshot-revert", "web", "snap1", "--running"],
      ok(),
    ),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(vmModel, "snapshotRevert", {
      name: "web",
      snapshotName: "snap1",
      running: true,
    }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["snapshot-revert", "web", "snap1", "--running"],
    );
  });
});

Deno.test("vm.snapshotDumpxml: writes raw XML to actionResult", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["snapshot-dumpxml", "web", "snap1"],
      ok("<domainsnapshot><name>snap1</name></domainsnapshot>"),
    ),
  ], async () => {
    await run(vmModel, "snapshotDumpxml", {
      name: "web",
      snapshotName: "snap1",
    }, ctx);
  });
  const rec = written.find((w) => w.name === "web-snapxml");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "domainsnapshot");
});

Deno.test("vm.guestInfo: valid comma-separated types become --<type> flags", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["guestinfo", "web", "--hostname", "--os"],
      ok("hostname: web-guest\nos.name: Linux"),
    ),
  ], async (calls) => {
    await run(vmModel, "guestInfo", { name: "web", types: "hostname,os" }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["guestinfo", "web", "--hostname", "--os"],
    );
  });
  const rec = written.find((w) => w.name === "web-guestinfo");
  assert(rec);
  assertEquals(
    (rec.payload.stats as Record<string, string>).hostname,
    "web-guest",
  );
});

Deno.test("vm.guestInfo: an invalid type is rejected before any spawn", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([], async (calls) => {
    await assertRejects(
      () =>
        run(vmModel, "guestInfo", { name: "web", types: "hostname,evil" }, ctx),
      Error,
      "Invalid guestinfo type",
    );
    assertEquals(calls.length, 0, "no Deno.Command call before the throw");
  });
});

Deno.test("vm.guestInfo: guest agent unavailable warns instead of throwing", async () => {
  const { ctx, warn } = makeCtx(LOCAL);
  await withCommandStub([
    on(["guestinfo", "web"], fail("error: Guest agent is not responding")),
  ], async () => {
    await run(vmModel, "guestInfo", { name: "web" }, ctx);
  });
  assert(warn.some((w) => w.includes("Guest agent not available")));
});

Deno.test("vm.setUserPassword: builds set-user-password with --encrypted flag", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["set-user-password", "web", "alice", "hunter2-example", "--encrypted"],
      ok(),
    ),
  ], async (calls) => {
    await run(vmModel, "setUserPassword", {
      name: "web",
      username: "alice",
      password: "hunter2-example",
      encrypted: true,
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "set-user-password");
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.message, "Password set for alice");
});

// ===========================================================================
// network model
// ===========================================================================

Deno.test("network.list: merges net-list rows with net-info", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["net-list", "--all"],
      ok(` Name      State      Autostart   Persistent
----------------------------------------------
 default   active     yes         yes`),
    ),
    on(
      ["net-info", "default"],
      ok("UUID: uuid-net\nActive: yes\nBridge: virbr0"),
    ),
  ], async () => {
    await run(networkModel, "list", {}, ctx);
  });
  const rec = written.find((w) => w.spec === "network" && w.name === "list");
  assert(rec);
  assertEquals((rec.payload.networks as unknown[])[0], {
    name: "default",
    uuid: "uuid-net",
    state: "active",
    autostart: "yes",
    persistent: "yes",
    bridge: "virbr0",
  });
});

Deno.test("network.get: merges net-info + net-dumpxml", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-info", "default"], ok("Active: yes\nBridge: virbr0")),
    on(
      ["net-dumpxml", "default"],
      ok("<network><name>default</name></network>"),
    ),
  ], async () => {
    await run(networkModel, "get", { name: "default" }, ctx);
  });
  const rec = written.find((w) => w.name === "default");
  assert(rec);
  assertStringIncludes(rec.payload.xml as string, "default");
});

Deno.test("network.dumpxml: writes raw XML to actionResult", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-dumpxml", "default"], ok("<network/>")),
  ], async () => {
    await run(networkModel, "dumpxml", { name: "default" }, ctx);
  });
  assert(written.find((w) => w.spec === "actionResult"));
});

Deno.test("network.start: success issues net-start", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-start", "default"], ok("Network default started")),
  ], async (calls) => {
    await run(networkModel, "start", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["net-start", "default"]);
  });
});

Deno.test("network.start: already-active is idempotent", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["net-start", "default"],
      fail(
        "error: Failed to start network default\nerror: Requested operation is not valid: network is already active",
      ),
    ),
  ], async () => {
    await run(networkModel, "start", { name: "default" }, ctx);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "already active");
});

Deno.test("network.start: a genuine failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-start", "default"], fail("error: network 'default' not found")),
  ], async () => {
    await assertRejects(
      () => run(networkModel, "start", { name: "default" }, ctx),
    );
  });
});

Deno.test("network.stop: issues net-destroy (NOT a graceful shutdown)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-destroy", "default"], ok("Network default destroyed")),
  ], async (calls) => {
    await run(networkModel, "stop", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["net-destroy", "default"]);
  });
});

Deno.test("network.stop: already-inactive is idempotent", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["net-destroy", "default"],
      fail(
        "error: Requested operation is not valid: network 'default' is not active",
      ),
    ),
  ], async () => {
    await run(networkModel, "stop", { name: "default" }, ctx);
  });
});

Deno.test("network.define local: writes XML to a temp file and calls net-define", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  const xml = "<network><name>isolated</name></network>";
  await withTempFileStub(async (tmp) => {
    await withCommandStub([
      on(["net-define"], (argv) => {
        assertEquals(argv[1], tmp.made[0]);
        return ok("Network isolated defined from /tmp/x");
      }),
    ], async () => {
      await run(networkModel, "define", { xml }, ctx);
    });
    assertEquals(tmp.written[0].content, xml);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertEquals(rec.payload.network, "isolated");
});

Deno.test("network.define ssh: streams XML over stdin to /dev/stdin", async () => {
  const { ctx } = makeCtx(SSH);
  const xml = "<network><name>isolated</name></network>";
  await withCommandStub([
    on(["net-define", "/dev/stdin"], ok("Network isolated defined")),
  ], async (calls) => {
    await run(networkModel, "define", { xml }, ctx);
    assertEquals(calls[0].stdinMode, "piped");
    assertEquals(calls[0].stdinText, xml);
  });
});

Deno.test("network.undefine: issues net-undefine", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-undefine", "default"], ok("Network default undefined")),
  ], async (calls) => {
    await run(networkModel, "undefine", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["net-undefine", "default"]);
  });
  assert(written.find((w) => w.spec === "actionResult"));
});

Deno.test("network.autostart: enabled/disabled toggle the right flag", async () => {
  for (
    const [enabled, expected] of [
      [true, ["net-autostart", "default"]],
      [false, ["net-autostart", "--disable", "default"]],
    ] as const
  ) {
    const { ctx } = makeCtx(LOCAL);
    await withCommandStub([
      on(expected as unknown as string[], ok()),
    ], async (calls) => {
      await run(networkModel, "autostart", { name: "default", enabled }, ctx);
      assertEquals(logicalArgv(calls[0]), expected as unknown as string[]);
    });
  }
});

Deno.test("network.dhcpLeases: parses lease rows", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["net-dhcp-leases", "default"],
      ok(
        ` Expiry Time           MAC address         Protocol  IP address                Hostname        Client ID or DUID
-------------------------------------------------------------------------------------------------------
 2026-07-28 12:00:00   52:54:00:aa:bb:cc   ipv4      10.0.0.5/24               web             -`,
      ),
    ),
  ], async () => {
    await run(networkModel, "dhcpLeases", { name: "default" }, ctx);
  });
  const rec = written.find((w) => w.spec === "dhcpLeases");
  assert(rec);
  assertEquals(rec.payload.count, 1);
  assertEquals(
    (rec.payload.leases as { hostname: string }[])[0].hostname,
    "web",
  );
});

Deno.test("network.dhcpLeases: an inactive network's failure is treated as zero leases", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["net-dhcp-leases", "default"],
      fail("error: Requested operation is not valid: network is not active"),
    ),
  ], async () => {
    await run(networkModel, "dhcpLeases", { name: "default" }, ctx);
  });
  const rec = written.find((w) => w.spec === "dhcpLeases");
  assert(rec);
  assertEquals(rec.payload.count, 0);
});

// ===========================================================================
// storage model
// ===========================================================================

Deno.test("storage.poolList: merges pool-list rows with pool-info", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["pool-list", "--all", "--details"],
      ok(` Name     State    Autostart
-----------------------------
 default  running  yes`),
    ),
    on(
      ["pool-info", "default"],
      ok(
        "UUID: uuid-pool\nState: running\nCapacity: 100 GiB\nAllocation: 10 GiB\nAvailable: 90 GiB",
      ),
    ),
  ], async () => {
    await run(storageModel, "poolList", {}, ctx);
  });
  const rec = written.find((w) => w.spec === "pool" && w.name === "list");
  assert(rec);
  assertEquals((rec.payload.pools as { name: string }[])[0].name, "default");
});

Deno.test("storage.poolGet: merges pool-info + pool-dumpxml", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-info", "default"], ok("State: running")),
    on(["pool-dumpxml", "default"], ok("<pool><name>default</name></pool>")),
  ], async () => {
    await run(storageModel, "poolGet", { name: "default" }, ctx);
  });
  assert(written.find((w) => w.name === "default"));
});

Deno.test("storage.poolStart: success issues pool-start", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-start", "default"], ok("Pool default started")),
  ], async (calls) => {
    await run(storageModel, "poolStart", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["pool-start", "default"]);
  });
});

Deno.test("storage.poolStart: already-active is idempotent", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-start", "default"], fail("error: pool default already active")),
  ], async () => {
    await run(storageModel, "poolStart", { name: "default" }, ctx);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "idempotent");
});

Deno.test("storage.poolStart: a genuine failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-start", "default"], fail("error: pool 'default' not found")),
  ], async () => {
    await assertRejects(
      () => run(storageModel, "poolStart", { name: "default" }, ctx),
    );
  });
});

Deno.test("storage.poolBuild: issues pool-build", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-build", "default"], ok("Pool default built")),
  ], async (calls) => {
    await run(storageModel, "poolBuild", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["pool-build", "default"]);
  });
});

Deno.test("storage.poolStop: issues pool-destroy (see coverage suite for the cross-model destroy mapping)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-destroy", "default"], ok("Pool default destroyed")),
  ], async (calls) => {
    await run(storageModel, "poolStop", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["pool-destroy", "default"]);
  });
});

Deno.test("storage.poolDefine: builds source-host/path/format/target flags", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on([
      "pool-define-as",
      "nfs-pool",
      "netfs",
      "--source-host",
      "nas.local",
      "--source-path",
      "/export/vms",
      "--source-format",
      "nfs",
      "--target",
      "/mnt/nfs-pool",
    ], ok("Pool nfs-pool defined")),
  ], async (calls) => {
    await run(storageModel, "poolDefine", {
      name: "nfs-pool",
      type: "netfs",
      sourceHost: "nas.local",
      sourcePath: "/export/vms",
      sourceFormat: "nfs",
      target: "/mnt/nfs-pool",
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "pool-define-as");
  });
});

Deno.test("storage.poolDefine: already-exists is idempotent", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["pool-define-as", "default", "dir"],
      fail("error: pool already exists"),
    ),
  ], async () => {
    await run(
      storageModel,
      "poolDefine",
      { name: "default", type: "dir" },
      ctx,
    );
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "idempotent");
});

Deno.test("storage.poolUndefine: issues pool-undefine", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-undefine", "default"], ok("Pool default undefined")),
  ], async (calls) => {
    await run(storageModel, "poolUndefine", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["pool-undefine", "default"]);
  });
});

Deno.test("storage.poolAutostart: enabled/disabled toggle the right flag", async () => {
  for (
    const [enabled, expected] of [
      [true, ["pool-autostart", "default"]],
      [false, ["pool-autostart", "--disable", "default"]],
    ] as const
  ) {
    const { ctx } = makeCtx(LOCAL);
    await withCommandStub([
      on(expected as unknown as string[], ok()),
    ], async (calls) => {
      await run(
        storageModel,
        "poolAutostart",
        { name: "default", enabled },
        ctx,
      );
      assertEquals(logicalArgv(calls[0]), expected as unknown as string[]);
    });
  }
});

Deno.test("storage.poolRefresh: issues pool-refresh", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-refresh", "default"], ok("Pool default refreshed")),
  ], async (calls) => {
    await run(storageModel, "poolRefresh", { name: "default" }, ctx);
    assertEquals(logicalArgv(calls[0]), ["pool-refresh", "default"]);
  });
});

Deno.test("storage.volList: merges vol-list rows with vol-info", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-list", "default", "--details"],
      ok(` Name        Path
------------------------------------
 disk.qcow2  /var/lib/libvirt/images/disk.qcow2`),
    ),
    on(
      ["vol-info", "disk.qcow2", "--pool", "default"],
      ok("Type: file\nCapacity: 20 GiB\nAllocation: 5 GiB"),
    ),
  ], async () => {
    await run(storageModel, "volList", { pool: "default" }, ctx);
  });
  const rec = written.find((w) => w.name === "default-list");
  assert(rec);
  assertEquals(
    (rec.payload.volumes as { name: string }[])[0].name,
    "disk.qcow2",
  );
});

Deno.test("storage.volGet: merges vol-info + vol-dumpxml + vol-path", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["vol-info", "disk.qcow2", "--pool", "default"], ok("Type: file")),
    on(
      ["vol-dumpxml", "disk.qcow2", "--pool", "default"],
      ok("<volume><name>disk.qcow2</name></volume>"),
    ),
    on(
      ["vol-path", "disk.qcow2", "--pool", "default"],
      ok("/var/lib/libvirt/images/disk.qcow2\n"),
    ),
  ], async () => {
    await run(
      storageModel,
      "volGet",
      { name: "disk.qcow2", pool: "default" },
      ctx,
    );
  });
  const rec = written.find((w) => w.name === "default-disk.qcow2");
  assert(rec);
  assertEquals(rec.payload.path, "/var/lib/libvirt/images/disk.qcow2");
});

Deno.test("storage.volCreate: builds capacity/format/allocation argv", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on([
      "vol-create-as",
      "default",
      "disk2.qcow2",
      "10G",
      "--format",
      "qcow2",
      "--allocation",
      "0",
    ], ok("Vol disk2.qcow2 created")),
  ], async (calls) => {
    await run(storageModel, "volCreate", {
      pool: "default",
      name: "disk2.qcow2",
      capacity: "10G",
      allocation: "0",
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "vol-create-as");
  });
});

Deno.test("storage.volCreate: already-exists is idempotent", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-create-as", "default", "disk.qcow2", "10G", "--format", "qcow2"],
      fail("error: storage volume already exists"),
    ),
  ], async () => {
    await run(storageModel, "volCreate", {
      pool: "default",
      name: "disk.qcow2",
      capacity: "10G",
    }, ctx);
  });
  const rec = written.find((w) => w.spec === "actionResult");
  assert(rec);
  assertStringIncludes(rec.payload.message as string, "idempotent");
});

Deno.test("storage.volCreate: a genuine failure throws", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-create-as", "default", "disk.qcow2", "10G", "--format", "qcow2"],
      fail("error: not enough space"),
    ),
  ], async () => {
    await assertRejects(
      () =>
        run(storageModel, "volCreate", {
          pool: "default",
          name: "disk.qcow2",
          capacity: "10G",
        }, ctx),
    );
  });
});

Deno.test("storage.volDelete: issues vol-delete --pool (see coverage suite for the non-idempotent throw)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-delete", "disk.qcow2", "--pool", "default"],
      ok("Vol disk.qcow2 deleted"),
    ),
  ], async (calls) => {
    await run(storageModel, "volDelete", {
      name: "disk.qcow2",
      pool: "default",
    }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["vol-delete", "disk.qcow2", "--pool", "default"],
    );
  });
});

Deno.test("storage.volResize: default omits --shrink", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-resize", "disk.qcow2", "20G", "--pool", "default"],
      ok("Size of volume changed"),
    ),
  ], async (calls) => {
    await run(storageModel, "volResize", {
      name: "disk.qcow2",
      pool: "default",
      capacity: "20G",
    }, ctx);
    assertEquals(
      logicalArgv(calls[0]),
      ["vol-resize", "disk.qcow2", "20G", "--pool", "default"],
    );
  });
});

Deno.test("storage.volClone: builds newName/--pool argv", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-clone", "disk.qcow2", "disk-copy.qcow2", "--pool", "default"],
      ok("Vol disk-copy.qcow2 cloned"),
    ),
  ], async (calls) => {
    await run(storageModel, "volClone", {
      name: "disk.qcow2",
      newName: "disk-copy.qcow2",
      pool: "default",
    }, ctx);
    assertEquals(logicalArgv(calls[0])[0], "vol-clone");
  });
  assert(written.find((w) => w.name === "disk-copy.qcow2"));
});

// ===========================================================================
// host model
// ===========================================================================

Deno.test("host.info: merges nodeinfo/hostname/version/uri", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["nodeinfo"],
      ok(
        "CPU model:           x86_64\nCPU(s):              16\nMemory size:         33554432 KiB",
      ),
    ),
    on(["hostname"], ok("hv1.local\n")),
    on(["version"], ok("Using library: 8.7.0\nRunning hypervisor: QEMU 8.1.0")),
    on(["uri"], ok("qemu:///system\n")),
  ], async () => {
    await run(hostModel, "info", {}, ctx);
  });
  const rec = written.find((w) => w.spec === "info" && w.name === "main");
  assert(rec);
  assertEquals(rec.payload.hostname, "hv1.local");
  assertEquals(rec.payload.cpuCount, 16);
  assertEquals(rec.payload.memoryMB, 32768);
});

Deno.test("host.capabilities: writes capabilities XML", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["capabilities"], ok("<capabilities/>")),
  ], async () => {
    await run(hostModel, "capabilities", {}, ctx);
  });
  const rec = written.find((w) => w.name === "capabilities");
  assert(rec);
  assertEquals(
    (rec.payload.stats as Record<string, string>).xml,
    "<capabilities/>",
  );
});

Deno.test("host.sysinfo: writes sysinfo XML", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["sysinfo"], ok("<sysinfo/>")),
  ], async () => {
    await run(hostModel, "sysinfo", {}, ctx);
  });
  assert(written.find((w) => w.name === "sysinfo"));
});

Deno.test("host.cpuStats: issues nodecpustats --percent", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["nodecpustats", "--percent"], ok("usage 12.3%")),
  ], async (calls) => {
    await run(hostModel, "cpuStats", {}, ctx);
    assertEquals(logicalArgv(calls[0]), ["nodecpustats", "--percent"]);
  });
});

Deno.test("host.memStats: parses colon-separated stat lines", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["nodememstats"], ok("total  : 33554432 KiB\nfree   : 10485760 KiB")),
  ], async () => {
    await run(hostModel, "memStats", {}, ctx);
  });
  const rec = written.find((w) => w.name === "memstats");
  assert(rec);
  assertEquals(
    (rec.payload.stats as Record<string, string>).total,
    "33554432 KiB",
  );
});

Deno.test("host.deviceList: no cap filter lists all devices", async () => {
  const { ctx, written } = makeCtx(LOCAL);
  await withCommandStub([
    on(["nodedev-list", "--tree"], ok("pci_0000_00_00_0")),
    on(["nodedev-list"], ok("pci_0000_00_00_0\nusb_1_1")),
  ], async () => {
    await run(hostModel, "deviceList", {}, ctx);
  });
  const rec = written.find((w) => w.spec === "devices");
  assert(rec);
  assertEquals(rec.payload.count, 2);
});

Deno.test("host.deviceList: a cap filter is passed through to both list calls", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["nodedev-list", "--tree"], ok("pci_0000_00_00_0")),
    on(["nodedev-list", "--cap", "pci"], ok("pci_0000_00_00_0")),
  ], async (calls) => {
    await run(hostModel, "deviceList", { cap: "pci" }, ctx);
    const listCall = calls.find((c) => logicalArgv(c).includes("--cap"));
    assert(listCall);
    assertEquals(logicalArgv(listCall), ["nodedev-list", "--cap", "pci"]);
  });
});

Deno.test("host.addRoute: SSH mode success uses `ip route replace` by default", async () => {
  const { ctx, written } = makeCtx(SSH);
  await withCommandStub([
    on(["ip", "route", "replace", "10.244.0.0/16", "via", "10.0.0.1"], ok()),
  ], async (calls) => {
    await run(hostModel, "addRoute", {
      destination: "10.244.0.0/16",
      gateway: "10.0.0.1",
    }, ctx);
    assertEquals(calls[0].command, "ssh");
    assertEquals(
      logicalArgv(calls[0]),
      ["ip", "route", "replace", "10.244.0.0/16", "via", "10.0.0.1"],
    );
  });
  assert(written.find((w) => w.spec === "stats"));
});

Deno.test("host.addRoute: local mode throws (no remote shell to target — see libvirt_coverage_test.ts)", async () => {
  const { ctx } = makeCtx(LOCAL);
  await assertRejects(
    () =>
      run(hostModel, "addRoute", {
        destination: "10.244.0.0/16",
        gateway: "10.0.0.1",
      }, ctx),
    Error,
    "requires SSH host mode",
  );
});
