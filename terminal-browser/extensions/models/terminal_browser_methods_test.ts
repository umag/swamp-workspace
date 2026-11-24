/**
 * Method-level tests for @magistr/terminal-browser — every method's success
 * and failure paths through model.methods.<m>.execute() against a fake
 * context and a stubbed Deno.Command (no terminal-browser binary needed).
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { model, normalizeUrl } from "./terminal_browser.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per suite, per this repo's convention). ONE seam:
// `new Deno.Command(...).output()`. `emulate()` is a small in-memory
// terminal-browser: ls / --version / open / new-tab / action / config /
// shutdown / upgrade, mutating a `World` so idempotency logic runs for real.
// ---------------------------------------------------------------------------

type Call = { cmd: string; args: string[] };
type Reply = { stdout?: string; stderr?: string; code?: number } | "notfound";

interface FakeTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
}
interface FakeBrowser {
  key: string;
  pid: number;
  cdpPort: number;
  pane: { tab: string; pane: string };
  splitDir: string;
  inCurrentTab: boolean;
  tabs: FakeTab[];
}
interface World {
  version: string;
  upgradeTo?: string;
  self: { tab: string; pane: string } | null;
  browsers: FakeBrowser[];
  config: Record<string, string>;
  nextPid: number;
  action?: (args: string[]) => Reply;
  fail?: Record<string, Reply>;
}

function fakeBrowser(
  key: string,
  urls: string[],
  inCurrentTab = true,
): FakeBrowser {
  return {
    key,
    pid: Number(key.split("-")[0]) || 1,
    cdpPort: 50000,
    pane: { tab: inCurrentTab ? "w8:t15" : "w9:t1", pane: "w8:p1A" },
    splitDir: "right",
    inCurrentTab,
    tabs: urls.map((url, i) => ({
      id: i + 1,
      url,
      title: "",
      active: i === 0,
    })),
  };
}

function world(browsers: FakeBrowser[] = []): World {
  return {
    version: "0.16.1",
    self: { tab: "w8:t15", pane: "w8:p19" },
    browsers,
    config: {
      "search.engine": "https://www.google.com/search?q=%s",
      "updates.check": "on",
    },
    nextPid: 20000,
  };
}

function emulate(w: World, c: Call): Reply {
  const [sub, ...rest] = c.args;
  if (w.fail?.[sub]) return w.fail[sub];
  switch (sub) {
    case "--version":
      return { stdout: `terminal-browser v${w.version}\n` };
    case "ls": {
      const all = rest.includes("--all");
      return {
        stdout: JSON.stringify({
          self: w.self,
          browsers: w.browsers.filter((b) => all || b.inCurrentTab),
        }),
      };
    }
    case "open": {
      const url = rest[0] && !rest[0].startsWith("--")
        ? normalizeUrl(rest[0])
        : "about:blank";
      const key = `${w.nextPid++}-1`;
      w.browsers.push(fakeBrowser(key, [url], true));
      return { stdout: `opened ${key} (terminal-browser ls for details)\n` };
    }
    case "new-tab": {
      const key = rest[rest.indexOf("--browser") + 1];
      const url = rest[rest.length - 1];
      const b = w.browsers.find((x) => x.key === key);
      if (!b) {
        return { code: 1, stderr: `terminal-browser: no browser ${key}.` };
      }
      b.tabs.push({
        id: b.tabs.length + 1,
        url: normalizeUrl(url),
        title: "",
        active: false,
      });
      return { stdout: "" };
    }
    case "action":
      return w.action ? w.action(rest) : { stdout: "ok\n" };
    case "shutdown":
      w.browsers = [];
      return { stdout: "" };
    case "upgrade":
      if (w.upgradeTo) w.version = w.upgradeTo;
      return { stdout: `upgraded to v${w.version}\n` };
    case "config": {
      const [op, key, value] = rest;
      if (op === "list") {
        return {
          stdout: Object.entries(w.config).map(([k, v]) => `${k}=${v}`)
            .join("\n") + "\n",
        };
      }
      if (!(key in w.config)) {
        return { code: 1, stdout: `error: invalid key: ${key}\n` };
      }
      if (op === "get") return { stdout: `${w.config[key]}\n` };
      if (op === "set") w.config[key] = value;
      if (op === "unset") w.config[key] = "default";
      return { stdout: "" };
    }
  }
  return { code: 1, stderr: `Unknown command: ${sub}` };
}

function toOutput(r: { stdout?: string; stderr?: string; code?: number }) {
  const enc = new TextEncoder();
  return {
    success: (r.code ?? 0) === 0,
    code: r.code ?? 0,
    stdout: enc.encode(r.stdout ?? ""),
    stderr: enc.encode(r.stderr ?? ""),
  };
}

function installCommand(router: (c: Call) => Reply) {
  const calls: Call[] = [];
  const D = Deno as unknown as { Command: unknown };
  const original = D.Command;
  class FakeCommand {
    constructor(
      private cmd: string,
      private opts: { args?: string[] } = {},
    ) {}
    output() {
      const call = { cmd: this.cmd, args: this.opts.args ?? [] };
      calls.push(call);
      const r = router(call);
      if (r === "notfound") {
        return Promise.reject(new Deno.errors.NotFound("no such file"));
      }
      return Promise.resolve(toOutput(r));
    }
  }
  D.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      D.Command = original;
    },
  };
}

type Write = { spec: string; name: string; data: Record<string, unknown> };
type Ctx = {
  globalArgs: Record<string, unknown>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};
type Method = {
  execute: (a: Record<string, unknown>, c: Ctx) => Promise<unknown>;
};

/** Run one method against `w` (or a custom router); returns writes + calls. */
async function runMethod(
  name: string,
  args: Record<string, unknown>,
  w: World | ((c: Call) => Reply),
  globalArgs: Record<string, unknown> = {},
) {
  const router = typeof w === "function" ? w : (c: Call) => emulate(w, c);
  const h = installCommand(router);
  const writes: Write[] = [];
  const ctx: Ctx = {
    globalArgs,
    writeResource: (spec, n, data) => {
      writes.push({ spec, name: n, data });
      return Promise.resolve({});
    },
  };
  const methods = model.methods as unknown as Record<string, Method>;
  try {
    await methods[name].execute(args, ctx);
    return { writes, calls: h.calls, error: undefined as Error | undefined };
  } catch (e) {
    return { writes, calls: h.calls, error: e as Error };
  } finally {
    h.restore();
  }
}

/** Sub-commands issued, in order (args[0] of each call). */
function subs(calls: Call[]): string[] {
  return calls.map((c) => c.args[0]);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

Deno.test("status: records version, caller and every browser", async () => {
  const w = world([
    fakeBrowser("100-1", ["https://a.test/"]),
    fakeBrowser("200-1", ["https://b.test/", "https://c.test/"], false),
  ]);
  const r = await runMethod("status", {}, w);
  assertEquals(r.error, undefined);
  assertEquals(subs(r.calls), ["--version", "ls"]);
  assert(r.calls[1].args.includes("--all"));
  const d = r.writes[0].data;
  assertEquals(r.writes[0].spec, "status");
  assertEquals(d.version, "0.16.1");
  assertEquals(d.callerTab, "w8:t15");
  assertEquals(d.callerPane, "w8:p19");
  assertEquals(d.browserCount, 2);
  assertEquals(d.tabCount, 3);
});

Deno.test("status: CLI failure throws with exit code and text", async () => {
  const w = world();
  w.fail = { "--version": { code: 2, stderr: "boom" } };
  const r = await runMethod("status", {}, w);
  assertStringIncludes(r.error!.message, "exit 2");
  assertStringIncludes(r.error!.message, "boom");
  assertEquals(r.writes.length, 0);
});

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

Deno.test("open: reuse with no url keeps the existing browser", async () => {
  const w = world([fakeBrowser("100-1", ["https://x.com/"])]);
  const r = await runMethod("open", {}, w);
  assertEquals(r.error, undefined);
  assertEquals(subs(r.calls), ["ls"]);
  assertEquals(r.writes[0].data.outcome, "reused");
  assertEquals(r.writes[0].data.url, null);
});

Deno.test("open: reuse when the url already has a tab", async () => {
  const w = world([fakeBrowser("100-1", ["https://terminal-browser.com/"])]);
  const r = await runMethod("open", { url: "terminal-browser.com" }, w);
  assertEquals(subs(r.calls), ["ls"]);
  assertEquals(r.writes[0].data.outcome, "reused");
});

Deno.test("open: reuse adds a tab for a new url", async () => {
  const w = world([fakeBrowser("100-1", ["https://x.com/"])]);
  const r = await runMethod("open", { url: "github.com" }, w);
  assertEquals(r.error, undefined);
  assertEquals(subs(r.calls), ["ls", "new-tab", "ls"]);
  assertEquals(r.calls[1].args, [
    "new-tab",
    "--browser",
    "100-1",
    "github.com",
  ]);
  const d = r.writes[0].data as {
    outcome: string;
    browser: { tabs: unknown[] };
  };
  assertEquals(d.outcome, "tab-opened");
  assertEquals(d.browser.tabs.length, 2);
});

Deno.test("open: fresh open passes split/size/ssh/no-merge", async () => {
  const w = world();
  const r = await runMethod("open", {
    url: "localhost:3000",
    split: "left",
    size: 0.3,
    ssh: "dev@box",
    noMerge: true,
  }, w);
  assertEquals(r.error, undefined);
  assertEquals(r.calls[1].args, [
    "open",
    "localhost:3000",
    "--split",
    "left",
    "--size",
    "0.3",
    "--ssh",
    "dev@box",
    "--no-merge",
  ]);
  const d = r.writes[0].data as { outcome: string; browser: { key: string } };
  assertEquals(d.outcome, "opened");
  assertEquals(d.browser.key, "20000-1");
});

Deno.test("open: empty url opens the start page with default split", async () => {
  const w = world();
  const r = await runMethod("open", { url: "" }, w);
  assertEquals(r.calls[1].args, ["open", "--split", "right"]);
  assertEquals(r.writes[0].data.url, null);
});

Deno.test("open: reuse=false opens a second panel", async () => {
  const w = world([fakeBrowser("100-1", ["https://x.com/"])]);
  const r = await runMethod("open", { reuse: false, url: "x.com" }, w);
  assertEquals(subs(r.calls), ["ls", "open", "ls"]);
  assertEquals(w.browsers.length, 2);
});

Deno.test("open: CLI failure throws and writes nothing", async () => {
  const w = world();
  w.fail = { open: { code: 1, stderr: "no supported terminal" } };
  const r = await runMethod("open", { url: "x.com" }, w);
  assertStringIncludes(r.error!.message, "no supported terminal");
  assertEquals(r.writes.length, 0);
});

// ---------------------------------------------------------------------------
// new-tab
// ---------------------------------------------------------------------------

Deno.test("new-tab: opens a tab in the browser of this terminal tab", async () => {
  const w = world([fakeBrowser("100-1", ["https://x.com/"])]);
  const r = await runMethod("new-tab", { url: "github.com" }, w);
  assertEquals(r.error, undefined);
  assertEquals(r.writes[0].data.outcome, "tab-opened");
  assertEquals(w.browsers[0].tabs.length, 2);
});

Deno.test("new-tab: dedupe skips an existing tab", async () => {
  const w = world([fakeBrowser("100-1", ["https://github.com/"])]);
  const r = await runMethod("new-tab", { url: "github.com" }, w);
  assertEquals(subs(r.calls), ["ls"]);
  assertEquals(r.writes[0].data.outcome, "tab-exists");
});

Deno.test("new-tab: dedupe=false opens a duplicate", async () => {
  const w = world([fakeBrowser("100-1", ["https://github.com/"])]);
  const r = await runMethod("new-tab", {
    url: "github.com",
    dedupe: false,
  }, w);
  assertEquals(r.writes[0].data.outcome, "tab-opened");
  assertEquals(w.browsers[0].tabs.length, 2);
});

Deno.test("new-tab: no browser in this tab fails with a hint", async () => {
  const r = await runMethod("new-tab", { url: "github.com" }, world());
  assertStringIncludes(r.error!.message, "run `open` first");
});

Deno.test("new-tab: several browsers in this tab need a key", async () => {
  const w = world([
    fakeBrowser("100-1", ["https://a.test/"]),
    fakeBrowser("200-1", ["https://b.test/"]),
  ]);
  const r = await runMethod("new-tab", { url: "github.com" }, w);
  assertStringIncludes(r.error!.message, "2 browsers");
  assertStringIncludes(r.error!.message, "pass browser");
});

Deno.test("new-tab: explicit key looks across all terminal tabs", async () => {
  const w = world([fakeBrowser("200-1", ["https://b.test/"], false)]);
  const r = await runMethod("new-tab", {
    url: "github.com",
    browser: "200-1",
  }, w);
  assertEquals(r.error, undefined);
  assert(r.calls[0].args.includes("--all"));
  assertEquals(w.browsers[0].tabs.length, 2);
});

// ---------------------------------------------------------------------------
// action
// ---------------------------------------------------------------------------

Deno.test("action: records output under the given name", async () => {
  const w = world([fakeBrowser("100-1", ["https://x.com/"])]);
  w.action = () => ({ stdout: "X. It's what's happening\n" });
  const r = await runMethod("action", {
    command: ["get", "title"],
    name: "title",
  }, w);
  assertEquals(r.error, undefined);
  assertEquals(r.calls[0].args, ["action", "--", "get", "title"]);
  assertEquals(r.writes[0].spec, "action");
  assertEquals(r.writes[0].name, "title");
  assertEquals(r.writes[0].data.ok, true);
  assertEquals(r.writes[0].data.output, "X. It's what's happening\n");
});

Deno.test("action: non-zero exit is recorded, then thrown", async () => {
  const w = world();
  w.action = () => ({ code: 1, stderr: "Unknown command: bogus" });
  const r = await runMethod("action", { command: ["bogus"] }, w);
  assertEquals(r.writes.length, 1);
  assertEquals(r.writes[0].data.ok, false);
  assertEquals(r.writes[0].data.exitCode, 1);
  assertStringIncludes(String(r.writes[0].data.output), "Unknown command");
  assertStringIncludes(r.error!.message, "action bogus failed (exit 1)");
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

Deno.test("config list: parses key=value lines", async () => {
  const r = await runMethod("config", {}, world());
  assertEquals(r.writes[0].data.settings, {
    "search.engine": "https://www.google.com/search?q=%s",
    "updates.check": "on",
  });
  assertEquals(r.writes[0].data.changed, false);
});

Deno.test("config get: records one key", async () => {
  const r = await runMethod(
    "config",
    { op: "get", key: "updates.check" },
    world(),
  );
  assertEquals(r.writes[0].data.settings, { "updates.check": "on" });
});

Deno.test("config set: unchanged value skips the write", async () => {
  const r = await runMethod("config", {
    op: "set",
    key: "updates.check",
    value: "on",
  }, world());
  assertEquals(r.calls.some((c) => c.args[1] === "set"), false);
  assertEquals(r.writes[0].data.changed, false);
});

Deno.test("config set: new value is written and reported", async () => {
  const w = world();
  const r = await runMethod("config", {
    op: "set",
    key: "updates.check",
    value: "off",
  }, w);
  assertEquals(w.config["updates.check"], "off");
  assertEquals(r.writes[0].data.changed, true);
  assertEquals(r.writes[0].data.settings, { "updates.check": "off" });
});

Deno.test("config unset: changed reflects the before/after value", async () => {
  const w = world();
  const r = await runMethod("config", { op: "unset", key: "updates.check" }, w);
  assertEquals(r.writes[0].data.changed, true);
});

Deno.test("config get: unknown key fails with the CLI error", async () => {
  const r = await runMethod(
    "config",
    { op: "get", key: "no.such.key" },
    world(),
  );
  assertStringIncludes(r.error!.message, "invalid key: no.such.key");
});

Deno.test("config: missing key / value are refused before running", async () => {
  const a = await runMethod("config", { op: "get" }, world());
  assertStringIncludes(a.error!.message, "needs key");
  const b = await runMethod(
    "config",
    { op: "set", key: "updates.check" },
    world(),
  );
  assertStringIncludes(b.error!.message, "needs value");
  assertEquals(a.calls.length + b.calls.length, 0);
});

// ---------------------------------------------------------------------------
// shutdown / upgrade
// ---------------------------------------------------------------------------

Deno.test("shutdown: no browser running is a recorded no-op", async () => {
  const r = await runMethod("shutdown", {}, world());
  assertEquals(subs(r.calls), ["ls"]);
  assertEquals(r.writes[0].data.changed, false);
  assertEquals(r.writes[0].data.before, "none");
});

Deno.test("shutdown: closes running browsers", async () => {
  const w = world([
    fakeBrowser("100-1", ["https://a.test/"]),
    fakeBrowser("200-1", ["https://b.test/"], false),
  ]);
  const r = await runMethod("shutdown", {}, w);
  assertEquals(subs(r.calls), ["ls", "shutdown"]);
  assertEquals(r.writes[0].data.changed, true);
  assertEquals(r.writes[0].data.before, "100-1,200-1");
  assertEquals(r.writes[0].data.detail, "closed 2 browser(s)");
  assertEquals(w.browsers.length, 0);
});

Deno.test("upgrade: records before and after versions", async () => {
  const w = world();
  w.upgradeTo = "0.17.0";
  const r = await runMethod("upgrade", {}, w);
  assertEquals(r.writes[0].data.before, "0.16.1");
  assertEquals(r.writes[0].data.after, "0.17.0");
  assertEquals(r.writes[0].data.changed, true);
});

Deno.test("upgrade: already latest is unchanged; failure throws", async () => {
  const same = await runMethod("upgrade", {}, world());
  assertEquals(same.writes[0].data.changed, false);
  const w = world();
  w.fail = { upgrade: { code: 1, stderr: "network down" } };
  const bad = await runMethod("upgrade", {}, w);
  assertStringIncludes(bad.error!.message, "network down");
});

// ---------------------------------------------------------------------------
// binary resolution
// ---------------------------------------------------------------------------

Deno.test("binary: NotFound on PATH falls back to ~/.local/bin", async () => {
  const home = Deno.env.get("HOME");
  Deno.env.set("HOME", "/home/tester");
  try {
    const w = world();
    const r = await runMethod(
      "status",
      {},
      (c) => c.cmd === "terminal-browser" ? "notfound" : emulate(w, c),
    );
    assertEquals(r.error, undefined);
    assertEquals(r.calls[1].cmd, "/home/tester/.local/bin/terminal-browser");
  } finally {
    if (home) Deno.env.set("HOME", home);
  }
});

Deno.test("binary: missing everywhere fails with the install hint", async () => {
  const r = await runMethod("status", {}, () => "notfound");
  assertStringIncludes(
    r.error!.message,
    "curl -fsSL https://terminal-browser.sh/install",
  );
});

Deno.test("binary: an absolute path is not retried elsewhere", async () => {
  const r = await runMethod("status", {}, () => "notfound", {
    binary: "/opt/tb/terminal-browser",
  });
  assertEquals(r.calls.length, 1);
  assertStringIncludes(r.error!.message, "/opt/tb/terminal-browser not found");
});
