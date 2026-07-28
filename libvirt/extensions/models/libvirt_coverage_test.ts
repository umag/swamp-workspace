// Coverage tests for @bad-at-naming/libvirt — reviewer-GUARD regressions on
// the DESTRUCTIVE lifecycle paths, distinct from libvirt_methods_test.ts
// (success/failure/idempotent matrix) and libvirt_adversarial_test.ts
// (hostile input). Every guard here is paired with a POSITIVE control so an
// absence-assertion cannot pass for the wrong reason (a guard-removal must
// genuinely flip the test red, not just happen to agree with a vacuous
// default).
//
// CROSS-MODEL TRAP (pinned explicitly below): "stop" means graceful ACPI
// `shutdown` for the VM model, but means `destroy` (net-destroy/pool-destroy)
// for the network and storage models. A future refactor must NOT
// cross-generalize the VM's stop-never-destroys guard onto network/pool,
// where destroy IS the stop verb.
//
// Guards pinned:
//  - vm.stop issues `shutdown` and NEVER `destroy`; vm.forceStop issues
//    `destroy` (the two verbs must never swap)
//  - vm.define destroys ONLY when domstate is running|paused, and undefines
//    --nvram (falling back to a plain undefine) BEFORE redefining
//  - vm.undefine's three default-false destructive flags (--remove-all-
//    storage, --nvram, --snapshots-metadata) are each opt-in only
//  - vm.snapshotDelete's --children (irreversible child-snapshot deletion)
//    is opt-in only, same class as volResize --shrink
//  - vm.snapshotRevert's argv carries exactly the requested flags, no more
//  - storage.volResize's --shrink is opt-in only; storage.volDelete is
//    NON-idempotent (throws on a missing volume, no silent success)
//  - the cross-model destroy verbs: storage.poolStop -> pool-destroy,
//    storage.poolUndefine -> pool-undefine, network.stop -> net-destroy,
//    network.undefine -> net-undefine
//  - host.addRoute defaults to `ip route replace` (idempotent) and throws
//    outright in local mode (no remote shell to target)
//  - defineXml (local mode): the temp path handed to writeTextFile AND the
//    virsh argv is sourced from Deno.makeTempFile (never a predictable path),
//    and the temp file is removed in `finally` even on a non-zero exit

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model as vmModel } from "./libvirt_vm.ts";
import { model as networkModel } from "./libvirt_network.ts";
import { model as storageModel } from "./libvirt_storage.ts";
import { model as hostModel } from "./libvirt_host.ts";

// ===========================================================================
// Shared test harness (duplicated per-file by repo convention)
// ===========================================================================

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      logger: { info: (_m: string) => {}, warn: (_m: string) => {} },
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

async function withCommandStub(
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

interface TempFileCalls {
  made: string[];
  written: { path: string; content: string }[];
  removed: string[];
}

async function withTempFileStub(
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

const LOCAL: Record<string, unknown> = {};
const SSH: Record<string, unknown> = { host: "10.0.0.5" };

// ===========================================================================
// CROSS-MODEL TRAP, pinned explicitly: stop=shutdown(VM) vs stop=destroy
// (network/pool). Never cross-generalize one onto the other.
// ===========================================================================

Deno.test("[cross-model trap] vm.stop issues `shutdown` (graceful) and NEVER `destroy`; vm.forceStop issues `destroy`", async () => {
  const { ctx: stopCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["shutdown", "web"], ok()),
    on(["dominfo", "web"], ok("State: in shutdown")),
  ], async (calls) => {
    await run(vmModel, "stop", { name: "web" }, stopCtx);
    assertEquals(
      calls.some((c) => logicalArgv(c)[0] === "destroy"),
      false,
      "vm.stop must never call destroy",
    );
  });

  const { ctx: forceCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["destroy", "web"], ok()),
    on(["dominfo", "web"], ok("State: shut off")),
  ], async (calls) => {
    await run(vmModel, "forceStop", { name: "web" }, forceCtx);
    assertEquals(logicalArgv(calls[0]), ["destroy", "web"]);
  });
});

Deno.test("[cross-model trap] unlike vm.stop, network.stop and storage.poolStop BOTH issue a destroy verb — this is correct for those models, not a regression", async () => {
  const { ctx: netCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-destroy", "default"], ok("Network default destroyed")),
  ], async (calls) => {
    await run(networkModel, "stop", { name: "default" }, netCtx);
    assertEquals(logicalArgv(calls[0]), ["net-destroy", "default"]);
  });

  const { ctx: poolCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-destroy", "default"], ok("Pool default destroyed")),
  ], async (calls) => {
    await run(storageModel, "poolStop", { name: "default" }, poolCtx);
    assertEquals(logicalArgv(calls[0]), ["pool-destroy", "default"]);
  });
});

Deno.test("[cross-model] storage.poolUndefine -> pool-undefine, network.undefine -> net-undefine", async () => {
  const { ctx: poolCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["pool-undefine", "default"], ok("Pool default undefined")),
  ], async (calls) => {
    await run(storageModel, "poolUndefine", { name: "default" }, poolCtx);
    assertEquals(logicalArgv(calls[0]), ["pool-undefine", "default"]);
  });

  const { ctx: netCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["net-undefine", "default"], ok("Network default undefined")),
  ], async (calls) => {
    await run(networkModel, "undefine", { name: "default" }, netCtx);
    assertEquals(logicalArgv(calls[0]), ["net-undefine", "default"]);
  });
});

// ===========================================================================
// vm.define: destroys ONLY when domstate is running|paused (paired positive
// controls), and falls back to a plain undefine when `--nvram` fails.
// ===========================================================================

Deno.test("[guard+control] vm.define: domstate=running -> destroy IS recorded (positive control)", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["domstate", "web"], ok("running")),
    on(["destroy", "web"], ok()),
    on(["undefine", "web", "--nvram"], ok()),
    on(["define", "/dev/stdin"], ok("Domain web defined")),
  ], async (calls) => {
    await run(
      vmModel,
      "define",
      { xml: "<domain><name>web</name></domain>" },
      ctx,
    );
    assert(
      calls.some((c) => logicalArgv(c)[0] === "destroy"),
      "domstate=running must trigger a destroy before redefining",
    );
  });
});

Deno.test("[guard+control] vm.define: domstate=paused -> destroy IS ALSO recorded (positive control)", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["domstate", "web"], ok("paused")),
    on(["destroy", "web"], ok()),
    on(["undefine", "web", "--nvram"], ok()),
    on(["define", "/dev/stdin"], ok("Domain web defined")),
  ], async (calls) => {
    await run(
      vmModel,
      "define",
      { xml: "<domain><name>web</name></domain>" },
      ctx,
    );
    assert(calls.some((c) => logicalArgv(c)[0] === "destroy"));
  });
});

Deno.test("[guard] vm.define: domstate=shut off -> NO destroy is recorded (negative control)", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["domstate", "web"], ok("shut off")),
    on(["undefine", "web", "--nvram"], ok()),
    on(["define", "/dev/stdin"], ok("Domain web defined")),
  ], async (calls) => {
    await run(
      vmModel,
      "define",
      { xml: "<domain><name>web</name></domain>" },
      ctx,
    );
    assertEquals(
      calls.some((c) => logicalArgv(c)[0] === "destroy"),
      false,
      "domstate=shut off must never trigger a destroy",
    );
  });
});

Deno.test("[guard] vm.define: undefine --nvram succeeding does NOT fall back to a plain undefine (positive control on the fallback branch)", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["domstate", "web"], ok("shut off")),
    on(["undefine", "web", "--nvram"], ok()),
    on(["define", "/dev/stdin"], ok("Domain web defined")),
  ], async (calls) => {
    await run(
      vmModel,
      "define",
      { xml: "<domain><name>web</name></domain>" },
      ctx,
    );
    const undefineCalls = calls.filter((c) => logicalArgv(c)[0] === "undefine");
    assertEquals(
      undefineCalls.length,
      1,
      "no fallback undefine when --nvram succeeded",
    );
  });
});

Deno.test("[guard] vm.define: undefine --nvram FAILING falls back to a plain undefine before redefining", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["domstate", "web"], ok("shut off")),
    on(["undefine", "web", "--nvram"], fail("error: nvram file not found")),
    on(["undefine", "web"], ok()),
    on(["define", "/dev/stdin"], ok("Domain web defined")),
  ], async (calls) => {
    await run(
      vmModel,
      "define",
      { xml: "<domain><name>web</name></domain>" },
      ctx,
    );
    const undefineArgvs = calls
      .filter((c) => logicalArgv(c)[0] === "undefine")
      .map(logicalArgv);
    assertEquals(undefineArgvs, [
      ["undefine", "web", "--nvram"],
      ["undefine", "web"],
    ]);
  });
});

// ===========================================================================
// vm.undefine: three default-false destructive flags, each opt-in only.
// ===========================================================================

Deno.test("[guard+control] vm.undefine: --remove-all-storage appears ONLY when removeStorage=true", async () => {
  const { ctx: offCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web"], ok()),
  ], async (calls) => {
    await run(vmModel, "undefine", { name: "web" }, offCtx);
    assertEquals(logicalArgv(calls[0]), ["undefine", "web"]);
  });

  const { ctx: onCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web", "--remove-all-storage"], ok()),
  ], async (calls) => {
    await run(vmModel, "undefine", { name: "web", removeStorage: true }, onCtx);
    assertEquals(
      logicalArgv(calls[0]),
      ["undefine", "web", "--remove-all-storage"],
    );
  });
});

Deno.test("[guard+control] vm.undefine: --snapshots-metadata appears ONLY when snapshotsMetadata=true", async () => {
  const { ctx: offCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web"], ok()),
  ], async (calls) => {
    await run(vmModel, "undefine", { name: "web" }, offCtx);
    assertEquals(logicalArgv(calls[0]), ["undefine", "web"]);
  });

  const { ctx: onCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web", "--snapshots-metadata"], ok()),
  ], async (calls) => {
    await run(
      vmModel,
      "undefine",
      { name: "web", snapshotsMetadata: true },
      onCtx,
    );
    assertEquals(
      logicalArgv(calls[0]),
      ["undefine", "web", "--snapshots-metadata"],
    );
  });
});

Deno.test("[guard+control] vm.undefine: --nvram appears ONLY when nvram=true", async () => {
  const { ctx: offCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web"], ok()),
  ], async (calls) => {
    await run(vmModel, "undefine", { name: "web" }, offCtx);
    assertEquals(logicalArgv(calls[0]), ["undefine", "web"]);
  });

  const { ctx: onCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["undefine", "web", "--nvram"], ok()),
  ], async (calls) => {
    await run(vmModel, "undefine", { name: "web", nvram: true }, onCtx);
    assertEquals(logicalArgv(calls[0]), ["undefine", "web", "--nvram"]);
  });
});

Deno.test("[guard+control] vm.undefine: all three flags combine in argv order when all are true", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on([
      "undefine",
      "web",
      "--remove-all-storage",
      "--snapshots-metadata",
      "--nvram",
    ], ok()),
  ], async (calls) => {
    await run(vmModel, "undefine", {
      name: "web",
      removeStorage: true,
      snapshotsMetadata: true,
      nvram: true,
    }, ctx);
    assertEquals(logicalArgv(calls[0]), [
      "undefine",
      "web",
      "--remove-all-storage",
      "--snapshots-metadata",
      "--nvram",
    ]);
  });
});

// ===========================================================================
// vm.snapshotDelete --children: same default-false irreversible-data-loss
// class as volResize --shrink.
// ===========================================================================

Deno.test("[guard+control] vm.snapshotDelete: --children appears ONLY when children=true (irreversible child-snapshot deletion)", async () => {
  const { ctx: offCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["snapshot-delete", "web", "snap1"],
      ok("Domain snapshot snap1 deleted"),
    ),
  ], async (calls) => {
    await run(
      vmModel,
      "snapshotDelete",
      { name: "web", snapshotName: "snap1" },
      offCtx,
    );
    assertEquals(logicalArgv(calls[0]), ["snapshot-delete", "web", "snap1"]);
  });

  const { ctx: onCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["snapshot-delete", "web", "snap1", "--children"],
      ok("Domain snapshot snap1 and children deleted"),
    ),
  ], async (calls) => {
    await run(
      vmModel,
      "snapshotDelete",
      { name: "web", snapshotName: "snap1", children: true },
      onCtx,
    );
    assertEquals(
      logicalArgv(calls[0]),
      ["snapshot-delete", "web", "snap1", "--children"],
    );
  });
});

// ===========================================================================
// vm.snapshotRevert: argv carries exactly the requested flags.
// ===========================================================================

Deno.test("[guard] vm.snapshotRevert: no accidental extra flags beyond what was requested", async () => {
  const { ctx: bareCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["snapshot-revert", "web", "snap1"], ok()),
    on(["dominfo", "web"], ok("State: running")),
  ], async (calls) => {
    await run(
      vmModel,
      "snapshotRevert",
      { name: "web", snapshotName: "snap1" },
      bareCtx,
    );
    assertEquals(logicalArgv(calls[0]), ["snapshot-revert", "web", "snap1"]);
  });

  const { ctx: pausedCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(["snapshot-revert", "web", "snap1", "--paused"], ok()),
    on(["dominfo", "web"], ok("State: paused")),
  ], async (calls) => {
    await run(
      vmModel,
      "snapshotRevert",
      { name: "web", snapshotName: "snap1", paused: true },
      pausedCtx,
    );
    assertEquals(
      logicalArgv(calls[0]),
      ["snapshot-revert", "web", "snap1", "--paused"],
    );
  });
});

// ===========================================================================
// storage.volResize --shrink: opt-in only, same class as snapshotDelete
// --children.
// ===========================================================================

Deno.test("[guard+control] storage.volResize: --shrink appears ONLY when shrink=true (data-loss risk)", async () => {
  const { ctx: offCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-resize", "disk.qcow2", "5G", "--pool", "default"],
      ok("Size of volume changed"),
    ),
  ], async (calls) => {
    await run(storageModel, "volResize", {
      name: "disk.qcow2",
      pool: "default",
      capacity: "5G",
    }, offCtx);
    assertEquals(
      logicalArgv(calls[0]),
      ["vol-resize", "disk.qcow2", "5G", "--pool", "default"],
    );
  });

  const { ctx: onCtx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-resize", "disk.qcow2", "5G", "--pool", "default", "--shrink"],
      ok("Size of volume changed"),
    ),
  ], async (calls) => {
    await run(storageModel, "volResize", {
      name: "disk.qcow2",
      pool: "default",
      capacity: "5G",
      shrink: true,
    }, onCtx);
    assertEquals(
      logicalArgv(calls[0]),
      ["vol-resize", "disk.qcow2", "5G", "--pool", "default", "--shrink"],
    );
  });
});

// ===========================================================================
// storage.volDelete: NON-idempotent — throws on a missing volume (uses
// plain `virsh`, no virshTry/idempotency check at all).
// ===========================================================================

Deno.test("[guard] storage.volDelete: a missing volume THROWS rather than being swallowed as idempotent success", async () => {
  const { ctx } = makeCtx(LOCAL);
  await withCommandStub([
    on(
      ["vol-delete", "ghost.qcow2", "--pool", "default"],
      fail(
        "error: Storage volume not found: no storage vol with matching name",
      ),
    ),
  ], async () => {
    await assertRejects(
      () =>
        run(storageModel, "volDelete", {
          name: "ghost.qcow2",
          pool: "default",
        }, ctx),
      Error,
      "virsh vol-delete failed",
    );
  });
});

// ===========================================================================
// host.addRoute: default replace (idempotent), and throws outright in local
// mode.
// ===========================================================================

Deno.test("[guard+control] host.addRoute: default replace=true issues `ip route replace`", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["ip", "route", "replace", "10.244.0.0/16", "via", "10.0.0.1"], ok()),
  ], async (calls) => {
    await run(hostModel, "addRoute", {
      destination: "10.244.0.0/16",
      gateway: "10.0.0.1",
    }, ctx);
    assertEquals(logicalArgv(calls[0])[2], "replace");
  });
});

Deno.test("[guard+control] host.addRoute: replace=false issues `ip route add` instead (positive control on the flag)", async () => {
  const { ctx } = makeCtx(SSH);
  await withCommandStub([
    on(["ip", "route", "add", "10.244.0.0/16", "via", "10.0.0.1"], ok()),
  ], async (calls) => {
    await run(hostModel, "addRoute", {
      destination: "10.244.0.0/16",
      gateway: "10.0.0.1",
      replace: false,
    }, ctx);
    assertEquals(logicalArgv(calls[0])[2], "add");
  });
});

Deno.test("[guard] host.addRoute: local mode throws outright (no remote shell to target)", async () => {
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

// ===========================================================================
// defineXml (local mode): the temp path is SOURCED from Deno.makeTempFile
// (never synthesized as a predictable path), and is removed in `finally`
// even when virsh exits non-zero.
// ===========================================================================

Deno.test("[guard] vm.define local: the temp path handed to writeTextFile AND the virsh argv is makeTempFile's output, not a predictable path", async () => {
  const { ctx } = makeCtx(LOCAL);
  const xml = "<domain><name>fresh</name></domain>";
  await withTempFileStub(async (tmp) => {
    await withCommandStub([
      on(["domstate", "fresh"], fail("error: failed to get domain")),
      on(["define"], (argv) => {
        // The path virsh is called with must be EXACTLY what makeTempFile
        // produced — a refactor to a predictable /tmp path would desync
        // these and turn this assertion red.
        assertEquals(argv[1], tmp.made[0]);
        return ok("Domain fresh defined");
      }),
    ], async () => {
      await run(vmModel, "define", { xml }, ctx);
    });
    assertEquals(tmp.written.length, 1);
    assertEquals(tmp.written[0].path, tmp.made[0]);
    assertEquals(tmp.written[0].content, xml);
  });
});

Deno.test("[guard] vm.define local: the temp file is removed in `finally` even when virsh exits non-zero", async () => {
  const { ctx } = makeCtx(LOCAL);
  const xml = "<domain><name>fresh</name></domain>";
  await withTempFileStub(async (tmp) => {
    await withCommandStub([
      on(["domstate", "fresh"], fail("error: failed to get domain")),
      on(["define"], fail("error: XML error: unterminated element")),
    ], async () => {
      await assertRejects(() => run(vmModel, "define", { xml }, ctx));
    });
    assertEquals(
      tmp.removed,
      tmp.made,
      "the temp file must be removed even though virsh failed",
    );
  });
});
