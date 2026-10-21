/**
 * Method-level tests for @magistr/mitmproxy — every method's happy path and
 * primary failure, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()` against a fake context, a stubbed `Deno.Command`, a stubbed
 * `Deno.connect` (port probe) and a stubbed `Deno.kill`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./mitmproxy.ts";

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

Deno.test("install: runs uv with --no-build when mitmproxy is missing", async () => {
  const f = await fixture();
  let installed = false;
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump")) {
      return installed ? { stdout: "Mitmproxy: 12.2.3" } : { code: 127 };
    }
    if (c.cmd.endsWith("uv")) {
      installed = true;
      return { code: 0 };
    }
  });
  try {
    await exec("install", { python: "3.13" }, f.ctx());
    const uv = h.sim.calls.find((c) => c.cmd.endsWith("uv"))!;
    assertEquals(uv.args, [
      "tool",
      "install",
      "--force",
      "--python",
      "3.13",
      "--no-build",
      "mitmproxy",
    ]);
    assertEquals(f.writes[0].data.version, "12.2.3");
    assertEquals(f.writes[0].data.changed, true);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("install: uv failure surfaces its stderr", async () => {
  const f = await fixture();
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump")) return { code: 127 };
    if (c.cmd.endsWith("uv")) {
      return { code: 2, stderr: "no wheels for this platform" };
    }
  });
  try {
    await assertRejects(
      () => exec("install", {}, f.ctx()),
      Error,
      "no wheels for this platform",
    );
    assertEquals(f.writes.length, 0);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("status: reports a stopped proxy with CA facts", async () => {
  const f = await fixture();
  await Deno.writeTextFile(`${f.dir}/mitmproxy-ca-cert.pem`, "pem");
  const h = install(() => undefined);
  try {
    await exec("status", {}, f.ctx());
    const s = f.writes[0].data;
    assertEquals(s.running, false);
    assertEquals(s.pid, null);
    assertEquals(s.version, "12.2.3");
    assertEquals(s.proxyUrl, "http://127.0.0.1:8080");
    const ca = s.ca as Record<string, unknown>;
    assertEquals(ca.exists, true);
    assertEquals(ca.sha256, "AA:BB");
    if (Deno.build.os === "darwin") assertEquals(ca.trusted, false);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("status: a missing CA is reported, not thrown", async () => {
  const f = await fixture();
  const h = install(() => undefined);
  try {
    await exec("status", {}, f.ctx());
    assertEquals(
      (f.writes[0].data.ca as Record<string, unknown>).exists,
      false,
    );
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: launches detached, writes the pid file, waits for the port", async () => {
  const f = await fixture();
  const h = install((c, sim) => {
    if (c.cmd === "/bin/sh") {
      sim.alive.add(4242);
      sim.listening = true;
      return { stdout: "4242" };
    }
  });
  try {
    await exec("start", {}, f.ctx({ listenPort: 9090 }));
    const sh = h.sim.calls.find((c) => c.cmd === "/bin/sh")!;
    assertEquals(sh.args[3], "/x/mitmdump");
    assert(sh.args.includes("9090"));
    assertEquals(sh.env?.MITM_LOG, `${f.dir}/swamp/mitmproxy.log`);
    assertEquals(
      (await Deno.readTextFile(`${f.dir}/swamp/mitmproxy.pid`)).trim(),
      "4242",
    );
    assertEquals(f.writes[0].data.running, true);
    assertEquals(f.writes[0].data.pid, 4242);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: is a no-op when the recorded pid is a live mitmdump", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, "77\n");
  const h = install(() => undefined, { alive: new Set([77]), listening: true });
  try {
    await exec("start", {}, f.ctx());
    assert(!h.sim.calls.some((c) => c.cmd === "/bin/sh"));
    assertEquals(f.writes[0].data.pid, 77);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("start: refuses when mitmproxy is not installed", async () => {
  const f = await fixture();
  const h = install((c) =>
    c.cmd.endsWith("mitmdump") ? { code: 127 } : undefined
  );
  try {
    await assertRejects(
      () => exec("start", {}, f.ctx()),
      Error,
      "not installed",
    );
    assert(!h.sim.calls.some((c) => c.cmd === "/bin/sh"));
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("stop: SIGTERMs the running proxy and removes the pid file", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, "55");
  const h = install(() => undefined, { alive: new Set([55]), listening: true });
  try {
    await exec("stop", {}, f.ctx());
    assertEquals(h.sim.kills, [{ pid: 55, signal: "SIGTERM" }]);
    await assertRejects(() => Deno.stat(`${f.dir}/swamp/mitmproxy.pid`));
    assertEquals(f.writes[0].data.running, false);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("stop: is a no-op when nothing runs", async () => {
  const f = await fixture();
  const h = install(() => undefined);
  try {
    await exec("stop", {}, f.ctx());
    assertEquals(h.sim.kills, []);
    assertEquals(f.writes[0].data.running, false);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

const HAR = JSON.stringify({
  log: {
    entries: [
      {
        startedDateTime: "2026-10-21T00:00:00Z",
        time: 10.4,
        request: { method: "GET", url: "https://a.test/", headers: [] },
        response: {
          status: 200,
          headers: [],
          content: { size: 3, mimeType: "text/plain" },
        },
      },
    ],
  },
});

Deno.test("flows: converts the capture to HAR and summarises it", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/flows.mitm`, "capture");
  const h = install((c) => {
    if (c.cmd.endsWith("mitmdump") && c.args.includes("-r")) {
      const har = c.args.find((a) => a.startsWith("hardump="))!.slice(8);
      Deno.writeTextFileSync(har, HAR);
      return { code: 0 };
    }
  });
  try {
    await exec("flows", { filter: "~d a.test", limit: 5 }, f.ctx());
    const call = h.sim.calls.find((c) => c.args.includes("-r"))!;
    assertEquals(call.args.at(-1), "~d a.test");
    const d = f.writes[0].data;
    assertEquals(d.total, 1);
    assertEquals(d.filter, "~d a.test");
    assertEquals((d.flows as { url: string }[])[0].url, "https://a.test/");
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("flows: empty result when nothing was captured yet", async () => {
  const f = await fixture();
  const h = install(() => undefined);
  try {
    await exec("flows", {}, f.ctx());
    assertEquals(f.writes[0].data.total, 0);
    assert(!h.sim.calls.some((c) => c.args.includes("-r")));
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("clear_flows: deletes the capture when stopped", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/flows.mitm`, "capture");
  const h = install(() => undefined);
  try {
    await exec("clear_flows", {}, f.ctx());
    await assertRejects(() => Deno.stat(`${f.dir}/swamp/flows.mitm`));
    assertEquals(f.writes[0].data.flowsBytes, 0);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test("clear_flows: refuses while the proxy runs", async () => {
  const f = await fixture();
  await Deno.mkdir(`${f.dir}/swamp`);
  await Deno.writeTextFile(`${f.dir}/swamp/mitmproxy.pid`, "9");
  await Deno.writeTextFile(`${f.dir}/swamp/flows.mitm`, "capture");
  const h = install(() => undefined, { alive: new Set([9]) });
  try {
    await assertRejects(
      () => exec("clear_flows", {}, f.ctx()),
      Error,
      "stop it before clear_flows",
    );
    assertEquals((await Deno.stat(`${f.dir}/swamp/flows.mitm`)).size, 7);
  } finally {
    h.restore();
    await f.cleanup();
  }
});

Deno.test({
  name: "trust_ca: adds the CA to the login keychain when untrusted",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const f = await fixture();
    await Deno.writeTextFile(`${f.dir}/mitmproxy-ca-cert.pem`, "pem");
    let trusted = false;
    const h = install((c) => {
      if (c.cmd === "security" && c.args[0] === "verify-cert") {
        return { code: trusted ? 0 : 1 };
      }
      if (c.cmd === "security" && c.args[0] === "add-trusted-cert") {
        trusted = true;
        return { code: 0 };
      }
    });
    try {
      await exec("trust_ca", {}, f.ctx());
      const add = h.sim.calls.find((c) => c.args[0] === "add-trusted-cert")!;
      assertEquals(add.args.slice(0, 3), [
        "add-trusted-cert",
        "-r",
        "trustRoot",
      ]);
      assertEquals(add.args.at(-1), `${f.dir}/mitmproxy-ca-cert.pem`);
      assertEquals(
        (f.writes[0].data.ca as Record<string, unknown>).trusted,
        true,
      );
    } finally {
      h.restore();
      await f.cleanup();
    }
  },
});

Deno.test({
  name: "trust_ca: no-op when already trusted",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const f = await fixture();
    await Deno.writeTextFile(`${f.dir}/mitmproxy-ca-cert.pem`, "pem");
    const h = install((c) =>
      c.cmd === "security" && c.args[0] === "verify-cert"
        ? { code: 0 }
        : undefined
    );
    try {
      await exec("trust_ca", {}, f.ctx());
      assert(!h.sim.calls.some((c) => c.args[0] === "add-trusted-cert"));
    } finally {
      h.restore();
      await f.cleanup();
    }
  },
});
