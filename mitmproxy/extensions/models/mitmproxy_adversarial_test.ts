/**
 * Adversarial tests for @magistr/mitmproxy: injection attempts through
 * options/mode/install arguments, garbage pid files, pid reuse by an
 * unrelated process, mitmdump failing or emitting junk while reading flows,
 * and a proxy that dies during startup.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model, resolvePaths, startArgs } from "./mitmproxy.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per suite, per this repo's convention). Seams:
// `Deno.Command(...).output()`, `Deno.connect` and `Deno.kill`.
// ---------------------------------------------------------------------------

type Call = { cmd: string; args: string[]; env?: Record<string, string> };
type Reply = { code?: number; stdout?: string; stderr?: string };

interface Sim {
  calls: Call[];
  kills: { pid: number; signal: string }[];
  /** pids that `ps` reports as a mitmdump process */
  alive: Set<number>;
  /** whether the proxy port accepts connections */
  listening: boolean;
}

function install(
  router: (c: Call, sim: Sim) => Reply | undefined,
  init: Partial<Sim> = {},
) {
  const sim: Sim = {
    calls: [],
    kills: [],
    alive: new Set(),
    listening: false,
    ...init,
  };
  const D = Deno as unknown as Record<string, unknown>;
  const saved = {
    Command: D.Command,
    connect: D.connect,
    kill: D.kill,
  };
  D.Command = class {
    constructor(
      private cmd: string,
      private opts: { args?: string[]; env?: Record<string, string> } = {},
    ) {}
    output() {
      const call = {
        cmd: this.cmd,
        args: this.opts.args ?? [],
        env: this.opts.env,
      };
      sim.calls.push(call);
      const r = router(call, sim) ?? defaultReply(call, sim);
      const enc = new TextEncoder();
      return Promise.resolve({
        code: r.code ?? 0,
        success: (r.code ?? 0) === 0,
        stdout: enc.encode(r.stdout ?? ""),
        stderr: enc.encode(r.stderr ?? ""),
      });
    }
  };
  D.connect = () =>
    sim.listening
      ? Promise.resolve({ close() {} })
      : Promise.reject(new Error("ECONNREFUSED"));
  D.kill = (pid: number, signal: string) => {
    sim.kills.push({ pid, signal });
    sim.alive.delete(pid);
    sim.listening = false;
  };
  return {
    sim,
    restore() {
      Object.assign(D, saved);
    },
  };
}

/** Sensible defaults: installed mitmproxy 12.2.3, `ps` honours sim.alive. */
function defaultReply(c: Call, sim: Sim): Reply {
  if (c.cmd.endsWith("mitmdump") && c.args[0] === "--version") {
    return { stdout: "Mitmproxy: 12.2.3\nPython:    3.13.5" };
  }
  if (c.cmd === "ps") {
    const pid = Number(c.args[1]);
    return sim.alive.has(pid)
      ? { stdout: `/x/mitmdump --listen-port 8080` }
      : { code: 1 };
  }
  if (c.cmd === "openssl") {
    return {
      stdout: "sha256 Fingerprint=AA:BB\nnotAfter=Oct 16 21:24:48 2036 GMT",
    };
  }
  if (c.cmd === "security") return { code: 1 };
  return { code: 1, stderr: `unexpected ${c.cmd}` };
}

async function fixture() {
  const dir = await Deno.makeTempDir();
  const writes: { spec: string; data: Record<string, unknown> }[] = [];
  const ctx = (extra: Record<string, unknown> = {}) => ({
    globalArgs: model.globalArguments.parse({
      binDir: "/x",
      confdir: dir,
      ...extra,
    }),
    writeResource: (
      spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, data: structuredClone(data) });
      return Promise.resolve({});
    },
  });
  return {
    dir,
    writes,
    ctx,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

const m = model.methods;
type MethodName = keyof typeof m;
const exec = (
  name: MethodName,
  args: Record<string, unknown>,
  ctx: Parameters<typeof m.status.execute>[1],
) => m[name].execute(m[name].arguments.parse(args), ctx);

// ---------------------------------------------------------------------------

const G = model.globalArguments;

Deno.test("options: keys that could smuggle flags are rejected", () => {
  for (const key of ["a=b", "x --mode", "-k", "Upper", "a.b", ""]) {
    assert(!G.safeParse({ options: { [key]: 1 } }).success, key);
  }
});

Deno.test("options: hostile values stay one argv element (no shell)", () => {
  const v = "x; rm -rf / && echo `id` $(id)\n--mode socks5";
  const g = G.parse({ confdir: "/c", options: { ignore_hosts: v } });
  const a = startArgs(g, resolvePaths(g));
  assertEquals(a.filter((x) => x === `ignore_hosts=${v}`).length, 1);
  assertEquals(a.filter((x) => x === "--mode").length, 1);
});

Deno.test("mode: shell metacharacters and flag-like values are rejected", () => {
  for (const mode of ["regular; id", "--set", "", " regular", "Regular"]) {
    assert(!G.safeParse({ mode }).success, mode);
  }
  assert(G.safeParse({ mode: "reverse:https://a.test:8443" }).success);
});

Deno.test("install: version and python arguments reject injection", () => {
  const a = model.methods.install.arguments;
  assert(!a.safeParse({ version: "12.0; id" }).success);
  assert(!a.safeParse({ version: "--index-url=evil" }).success);
  assert(!a.safeParse({ python: "3.13 --with evil" }).success);
});

for (const garbage of ["abc", "-5", "0", "1.5", "", "99999999999999999999x"]) {
  Deno.test(`start: garbage pid file ${JSON.stringify(garbage)} is ignored`, async () => {
    const f = await fixture();
    await Deno.mkdir(`${f.dir}/swamp`);
    await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, garbage);
    const h = install((c, sim) => {
      if (c.cmd === "/bin/sh") {
        sim.alive.add(321);
        sim.listening = true;
        return { stdout: "321" };
      }
    });
    try {
      await exec("start", {}, f.ctx());
      assertEquals(
        (await Deno.readTextFile(`${f.dir}/swamp/mitmproxy.pid`)).trim(),
        "321",
      );
    } finally {
      h.restore();
      await f.cleanup();
    }
  });
}

Deno.test("stop: never signals a reused pid that is not mitmproxy", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, "1234");
  const h = install((c) =>
    c.cmd === "ps" ? { stdout: "/usr/bin/vim notes.txt" } : undefined
  );
  try {
    await exec("stop", {}, f.ctx());
    assertEquals(h.sim.kills, []);
    await assertRejects(() => Deno.stat(`${f.dir}/swamp/mitmproxy.pid`));
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: a reused non-mitm pid does not count as running", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, "1234");
  const h = install((c, sim) => {
    if (c.cmd === "ps" && c.args[1] === "1234") {
      return { stdout: "/usr/sbin/sshd" };
    }
    if (c.cmd === "/bin/sh") {
      sim.alive.add(5678);
      sim.listening = true;
      return { stdout: "5678" };
    }
  });
  try {
    await exec("start", {}, f.ctx());
    assertEquals(f.writes[0].data.pid, 5678);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: a launcher that prints no pid fails loudly", async () => {
  const f = await fixture();
  const h = install((c) =>
    c.cmd === "/bin/sh" ? { stdout: "", stderr: "sh: fork failed" } : undefined
  );
  try {
    await assertRejects(
      () => exec("start", {}, f.ctx()),
      Error,
      "sh: fork failed",
    );
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: a proxy that dies during startup reports its log", async () => {
  const f = await fixture();
  const h = install((c) => {
    if (c.cmd === "/bin/sh") {
      Deno.writeTextFileSync(
        c.env!.MITM_LOG,
        "Error: Address already in use\n",
      );
      return { stdout: "4000" };
    }
  });
  try {
    await assertRejects(
      () => exec("start", {}, f.ctx()),
      Error,
      "Address already in use",
    );
    await assertRejects(() => Deno.stat(`${f.dir}/swamp/mitmproxy.pid`));
  } finally {
    h.restore();
    await f.cleanup();
  }
});

async function withCapture(
  reply: (har: string) => Reply,
  fn: (f: Awaited<ReturnType<typeof fixture>>, harPaths: string[]) => Promise<
    void
  >,
) {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/flows.mitm`, "capture");
  const harPaths: string[] = [];
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump") && c.args.includes("-r")) {
      const har = c.args.find((a) => a.startsWith("hardump="))!.slice(8);
      harPaths.push(har);
      return reply(har);
    }
  });
  try {
    await fn(f, harPaths);
  } finally {
    h.restore();
    await f.cleanup();
  }
}

Deno.test("flows: an invalid filter surfaces mitmproxy's error", () =>
  withCapture(
    () => ({ code: 1, stderr: "Invalid filter expression: '~zzz'" }),
    async (f, hars) => {
      await assertRejects(
        () => exec("flows", { filter: "~zzz" }, f.ctx()),
        Error,
        "Invalid filter expression",
      );
      assertEquals(f.writes.length, 0);
      await assertRejects(() => Deno.stat(hars[0]));
    },
  ));

Deno.test("flows: a crashing mitmdump (truncated capture) fails cleanly", () =>
  withCapture(
    () => ({ code: 1, stdout: "Traceback: tnetstring truncated" }),
    async (f) => {
      const err = await assertRejects(() => exec("flows", {}, f.ctx()));
      assertStringIncludes((err as Error).message, "exit 1");
      assertStringIncludes((err as Error).message, "truncated");
    },
  ));

Deno.test("flows: junk HAR output is rejected and the temp file removed", () =>
  withCapture(
    (har) => {
      Deno.writeTextFileSync(har, "<html>not json");
      return { code: 0 };
    },
    async (f, hars) => {
      await assertRejects(() => exec("flows", {}, f.ctx()), SyntaxError);
      await assertRejects(() => Deno.stat(hars[0]));
    },
  ));

Deno.test("flows: a HAR with no log section yields zero flows", () =>
  withCapture(
    (har) => {
      Deno.writeTextFileSync(har, '{"unexpected": true}');
      return { code: 0 };
    },
    async (f) => {
      await exec("flows", {}, f.ctx());
      assertEquals(f.writes[0].data.total, 0);
    },
  ));

Deno.test("flows: the filter is one argv element, never split", () =>
  withCapture(
    (har) => {
      Deno.writeTextFileSync(har, '{"log":{"entries":[]}}');
      return { code: 0 };
    },
    async (f) => {
      const filter = "~d a.test & !(~u '; id')";
      await exec("flows", { filter }, f.ctx());
      assertEquals(f.writes[0].data.filter, filter);
    },
  ));
