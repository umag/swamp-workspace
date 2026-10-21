/**
 * Tests for @magistr/mitmproxy — pure helpers (argv, HAR summary, web URL)
 * plus method behaviour against a fake context and a stubbed `Deno.Command`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  model,
  resolvePaths,
  startArgs,
  summarizeHar,
  webUrlFromLog,
} from "./mitmproxy.ts";

const G = model.globalArguments;

Deno.test("resolvePaths derives stateDir from confdir", () => {
  const p = resolvePaths(G.parse({ confdir: "/c" }));
  assertEquals(p.stateDir, "/c/swamp");
  assertEquals(p.flowsFile, "/c/swamp/flows.mitm");
  assertEquals(p.caCert, "/c/mitmproxy-ca-cert.pem");
});

Deno.test("startArgs appends flows and passes options as --set", () => {
  const g = G.parse({
    confdir: "/c",
    listenPort: 9090,
    mode: "socks5",
    options: { ignore_hosts: "apple\\.com", ssl_insecure: true },
  });
  const a = startArgs(g, resolvePaths(g));
  assertEquals(a.slice(0, 6), [
    "--listen-host",
    "127.0.0.1",
    "--listen-port",
    "9090",
    "--mode",
    "socks5",
  ]);
  assert(a.includes("+/c/swamp/flows.mitm"));
  assert(a.includes("ignore_hosts=apple\\.com"));
  assert(a.includes("ssl_insecure=true"));
  assert(!a.some((x) => x.startsWith("web_port")));
});

Deno.test("startArgs adds web options for ui=web", () => {
  const g = G.parse({ confdir: "/c", ui: "web", webPort: 9999 });
  const a = startArgs(g, resolvePaths(g));
  assert(a.includes("web_port=9999"));
  assert(a.includes("web_open_browser=false"));
});

Deno.test("mode rejects shell-ish values", () => {
  assert(!G.safeParse({ mode: "regular; rm -rf /" }).success);
  assert(G.safeParse({ mode: "upstream:http://up:3128" }).success);
});

Deno.test("summarizeHar keeps newest entries and merges headers", () => {
  const entry = (url: string) => ({
    startedDateTime: "t",
    time: 12.6,
    request: {
      method: "GET",
      url,
      headers: [{ name: "Set-X", value: "a" }, { name: "set-x", value: "b" }],
    },
    response: { status: 200, content: { size: 5, mimeType: "text/html" } },
  });
  const s = summarizeHar(
    { log: { entries: [entry("u1"), entry("u2"), entry("u3")] } },
    2,
    true,
  );
  assertEquals(s.total, 3);
  assertEquals(s.flows.map((f) => f.url), ["u2", "u3"]);
  assertEquals(s.flows[0].timeMs, 13);
  assertEquals(s.flows[0].requestHeaders, { "set-x": "a, b" });
  assertEquals(summarizeHar({}, 10, false), { total: 0, flows: [] });
});

Deno.test("webUrlFromLog finds the latest tokenised URL", () => {
  assertEquals(
    webUrlFromLog([
      "[12:00] Web server listening at http://127.0.0.1:8081/?token=abc",
      "noise",
    ]),
    "http://127.0.0.1:8081/?token=abc",
  );
  assertEquals(webUrlFromLog(["nothing"]), null);
});

// ---------------------------------------------------------------------------
// Method tests: stub Deno.Command; every process is "not found / not running".
// ---------------------------------------------------------------------------

function withCommand(
  router: (cmd: string, args: string[]) => { code: number; stdout?: string },
  fn: () => Promise<void>,
) {
  return async () => {
    const D = Deno as unknown as { Command: unknown };
    const original = D.Command;
    D.Command = class {
      constructor(private cmd: string, private opts: { args?: string[] }) {}
      output() {
        const r = router(this.cmd, this.opts.args ?? []);
        const enc = new TextEncoder();
        return Promise.resolve({
          code: r.code,
          success: r.code === 0,
          stdout: enc.encode(r.stdout ?? ""),
          stderr: new Uint8Array(),
        });
      }
    };
    try {
      await fn();
    } finally {
      D.Command = original;
    }
  };
}

function fakeContext(globalArgs: Record<string, unknown>) {
  const writes: { spec: string; data: Record<string, unknown> }[] = [];
  return {
    writes,
    ctx: {
      globalArgs: G.parse(globalArgs),
      writeResource: (
        spec: string,
        _n: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, data });
        return Promise.resolve({});
      },
    },
  };
}

Deno.test(
  "install is a no-op when the version is already present",
  withCommand(
    (cmd) =>
      cmd.endsWith("mitmdump")
        ? { code: 0, stdout: "Mitmproxy: 12.2.3\nPython: 3.13.5" }
        : { code: 1 },
    async () => {
      const { ctx, writes } = fakeContext({ binDir: "/x" });
      await model.methods.install.execute({}, ctx);
      assertEquals(writes[0].data.version, "12.2.3");
      assertEquals(writes[0].data.changed, false);
    },
  ),
);

Deno.test(
  "start refuses when mitmproxy is not installed",
  withCommand(() => ({ code: 127 }), async () => {
    const dir = await Deno.makeTempDir();
    const { ctx } = fakeContext({
      binDir: "/x",
      confdir: dir,
      listenPort: 1,
    });
    await assertRejects(
      () => model.methods.start.execute({}, ctx),
      Error,
      "not installed",
    );
    await Deno.remove(dir, { recursive: true });
  }),
);

Deno.test(
  "clear_flows removes the capture and stop is idempotent",
  withCommand(() => ({ code: 1 }), async () => {
    const dir = await Deno.makeTempDir();
    const { ctx, writes } = fakeContext({
      binDir: "/x",
      confdir: dir,
      listenPort: 1,
    });
    await Deno.mkdir(`${dir}/swamp`);
    await Deno.writeTextFile(`${dir}/swamp/flows.mitm`, "x");
    await model.methods.clear_flows.execute({}, ctx);
    await model.methods.stop.execute({}, ctx);
    assertEquals(writes.map((w) => w.data.running), [false, false]);
    assertEquals(writes[0].data.flowsBytes, 0);
    await Deno.remove(dir, { recursive: true });
  }),
);
