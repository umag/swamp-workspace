/**
 * Coverage tests for @magistr/mitmproxy: the branches the method suite does
 * not reach — mitmweb URL discovery, port-in-use and startup timeout, the
 * SIGKILL fallback in stop, trust_ca edge cases, install upgrade / pin /
 * broken-install paths, binary resolution and log-tail truncation.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { binary, model, resolvePaths } from "./mitmproxy.ts";

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

Deno.test("start ui=web: runs mitmweb and records the tokenised URL", async () => {
  const f = await fixture();
  const h = install((c, sim) => {
    if (c.cmd === "/bin/sh") {
      Deno.writeTextFileSync(
        c.env!.MITM_LOG,
        "[21:00] HTTP(S) proxy listening at *:8080.\n" +
          "[21:00] Web server listening at http://127.0.0.1:8081/?token=t0k\n",
      );
      sim.alive.add(11);
      sim.listening = true;
      return { stdout: "11" };
    }
  });
  try {
    await exec("start", {}, f.ctx({ ui: "web" }));
    const sh = h.sim.calls.find((c) => c.cmd === "/bin/sh")!;
    assertEquals(sh.args[3], "/x/mitmweb");
    assert(sh.args.includes("web_open_browser=false"));
    assertEquals(f.writes[0].data.webUrl, "http://127.0.0.1:8081/?token=t0k");
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: refuses when another process owns the port", async () => {
  const f = await fixture();
  const h = install(() => undefined, { listening: true });
  try {
    await assertRejects(
      () => exec("start", {}, f.ctx()),
      Error,
      "already in use by another process",
    );
    assert(!h.sim.calls.some((c) => c.cmd === "/bin/sh"));
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: times out when the proxy never binds", async () => {
  const f = await fixture();
  const h = install((c, sim) => {
    if (c.cmd === "/bin/sh") {
      sim.alive.add(12);
      return { stdout: "12" };
    }
  });
  try {
    await assertRejects(
      () => exec("start", { timeoutSeconds: 1 }, f.ctx()),
      Error,
      "did not listen",
    );
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("stop: escalates to SIGKILL when SIGTERM is ignored", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, "13");
  const h = install(() => undefined, { alive: new Set([13]) });
  const D = Deno as unknown as Record<string, unknown>;
  D.kill = (pid: number, signal: string) => {
    h.sim.kills.push({ pid, signal });
    if (signal === "SIGKILL") h.sim.alive.delete(pid);
  };
  try {
    await exec("stop", { timeoutSeconds: 1 }, f.ctx());
    assertEquals(h.sim.kills.map((k) => k.signal), ["SIGTERM", "SIGKILL"]);
    assertEquals(f.writes[0].data.running, false);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("trust_ca: platform and missing-certificate guards", async () => {
  const f = await fixture();
  const h = install(() => undefined);
  try {
    const err = await assertRejects(() => exec("trust_ca", {}, f.ctx()));
    assertStringIncludes(
      (err as Error).message,
      Deno.build.os === "darwin" ? "does not exist" : "macOS only",
    );
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test({
  name: "trust_ca: add-trusted-cert failure is surfaced",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const f = await fixture();
    await Deno.writeTextFile(`${f.dir}/mitmproxy-ca-cert.pem`, "pem");
    const h = install((c) =>
      c.cmd === "security" && c.args[0] === "add-trusted-cert"
        ? { code: 1, stderr: "User canceled the operation." }
        : undefined
    );
    try {
      await assertRejects(
        () => exec("trust_ca", {}, f.ctx()),
        Error,
        "User canceled",
      );
    } finally {
      h.restore();
      await f.cleanup();
    }
  },
});

Deno.test("install upgrade=true reinstalls an existing version", async () => {
  const f = await fixture();
  let version = "12.2.2";
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump")) return { stdout: `Mitmproxy: ${version}` };
    if (c.cmd.endsWith("uv")) {
      version = "12.2.3";
      return { code: 0 };
    }
  });
  try {
    await exec("install", { upgrade: true }, f.ctx());
    assertEquals(f.writes[0].data.version, "12.2.3");
    assertEquals(f.writes[0].data.changed, true);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("install: a different pinned version installs mitmproxy==X", async () => {
  const f = await fixture();
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump")) return { stdout: "Mitmproxy: 12.2.3" };
    if (c.cmd.endsWith("uv")) return { code: 0 };
  });
  try {
    await exec("install", { version: "11.0.0" }, f.ctx());
    const uv = h.sim.calls.find((c) => c.cmd.endsWith("uv"))!;
    assertEquals(uv.args.at(-1), "mitmproxy==11.0.0");
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("install: matching pinned version is a no-op", async () => {
  const f = await fixture();
  const h = install(() => undefined);
  try {
    await exec("install", { version: "12.2.3" }, f.ctx());
    assert(!h.sim.calls.some((c) => c.cmd.endsWith("uv")));
    assertEquals(f.writes[0].data.changed, false);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("install: uv succeeds but mitmdump stays unrunnable", async () => {
  const f = await fixture();
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump")) return { code: 127 };
    if (c.cmd.endsWith("uv")) return { code: 0 };
  });
  try {
    await assertRejects(
      () => exec("install", {}, f.ctx()),
      Error,
      "set binDir",
    );
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("binary: prefers ~/.local/bin, falls back to PATH", async () => {
  const home = await Deno.makeTempDir();
  const saved = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    const g = model.globalArguments.parse({});
    assertEquals(await binary(g, "mitmdump"), "mitmdump");
    await Deno.mkdir(`${home}/.local/bin`, { recursive: true });
    await Deno.writeTextFile(`${home}/.local/bin/mitmdump`, "");
    assertEquals(
      await binary(g, "mitmdump"),
      `${home}/.local/bin/mitmdump`,
    );
    assertEquals(
      resolvePaths(model.globalArguments.parse({ stateDir: "~/s" })).pidFile,
      `${home}/s/mitmproxy.pid`,
    );
  } finally {
    if (saved) Deno.env.set("HOME", saved);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("status: logTail keeps only the last 20 lines", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(
    `${f.dir}/swamp/mitmproxy.log`,
    Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n",
  );
  const h = install(() => undefined);
  try {
    await exec("status", {}, f.ctx());
    const tail = f.writes[0].data.logTail as string[];
    assertEquals(tail.length, 20);
    assertEquals(tail[19], "line 49");
  } finally {
    h.restore();
    await f.cleanup();
  }
});
