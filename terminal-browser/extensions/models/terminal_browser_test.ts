/**
 * Contract-fixture tests for @magistr/terminal-browser — pins the wire
 * format of terminal-browser v0.16.1 (ls --json, --version, open stdout and
 * the exit-1 error messages observed live) independent of a real browser.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  model,
  normalizeUrl,
  parseLs,
  parseVersion,
} from "./terminal_browser.ts";

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
// `ls --json` fixtures captured from terminal-browser v0.16.1 in herdr
// ---------------------------------------------------------------------------

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

Deno.test("contract: ls with one browser in the caller's herdr tab", async () => {
  const ls = parseLs(await fixture("ls-one-browser.json"));
  assertEquals(ls.self, { tab: "w8:t15", pane: "w8:p19" });
  assertEquals(ls.browsers.length, 1);
  const b = ls.browsers[0];
  assertEquals(b.key, "17683-1");
  assertEquals(b.pid, 17683);
  assertEquals(b.cdpPort, 50413);
  assertEquals(b.pane, { tab: "w8:t15", pane: "w8:p1A" });
  assertEquals(b.splitDir, "right");
  assertEquals(b.inCurrentTab, true);
  assertEquals(b.tabs.length, 1);
  assertEquals(b.tabs[0].id, 1);
  assertEquals(b.tabs[0].url, "https://terminal-browser.com/");
  assertEquals(b.tabs[0].active, true);
  assertEquals(b.tabs[0].targetId, "F9B2A496CD06681DD230C5850711C552");
  // unknown fields survive (passthrough), so new CLI fields never break parsing
  assertEquals((b as Record<string, unknown>).viewport, {
    width: 1463,
    height: 1504,
  });
});

Deno.test("contract: ls with no browsers", async () => {
  const ls = parseLs(await fixture("ls-empty.json"));
  assertEquals(ls.browsers, []);
  assertEquals(ls.self?.pane, "w8:p19");
});

Deno.test("contract: ls outside a supported terminal has no self", async () => {
  const ls = parseLs(await fixture("ls-no-self.json"));
  assertEquals(ls.self, undefined);
  assertEquals(ls.browsers, []);
});

Deno.test("contract: status stores the fixture browser", async () => {
  const stdout = await fixture("ls-one-browser.json");
  const r = await runMethod(
    "status",
    {},
    (c) =>
      c.args[0] === "ls"
        ? { stdout }
        : { stdout: "terminal-browser v0.16.1\n" },
  );
  assertEquals(r.error, undefined);
  assertEquals(subs(r.calls), ["--version", "ls"]);
  const d = r.writes[0].data as {
    version: string;
    browsers: Array<Record<string, unknown>>;
  };
  assertEquals(d.version, "0.16.1");
  assertEquals(d.browsers[0], {
    key: "17683-1",
    pid: 17683,
    cdpPort: 50413,
    terminalTab: "w8:t15",
    terminalPane: "w8:p1A",
    splitDir: "right",
    inCurrentTab: true,
    tabs: [{
      id: 1,
      url: "https://terminal-browser.com/",
      title: "terminal-browser",
      active: true,
    }],
  });
});

Deno.test("contract: --version output", () => {
  assertEquals(parseVersion("terminal-browser v0.16.1\n"), "0.16.1");
});

// ---------------------------------------------------------------------------
// Live-observed CLI messages (v0.16.1)
// ---------------------------------------------------------------------------

Deno.test("contract: open prints 'opened <key> (…)' and the key is used", async () => {
  const w = world();
  const after = await fixture("ls-one-browser.json");
  let opened = false;
  const r = await runMethod("open", { url: "terminal-browser.com" }, (c) => {
    if (c.args[0] === "open") {
      opened = true;
      return { stdout: "opened 17683-1 (terminal-browser ls for details)\n" };
    }
    if (c.args[0] === "ls" && opened) return { stdout: after };
    return emulate(w, c);
  });
  const d = r.writes[0].data as { browser: { key: string } };
  assertEquals(d.browser.key, "17683-1");
});

Deno.test("contract: action on an unknown browser (exit 1)", async () => {
  const msg = "terminal-browser: no browser nope-9\n\nrunning:\n" +
    "  17683-1 (w8:t15:w8:p1A) https://terminal-browser.com/\n";
  const r = await runMethod("action", {
    command: ["get", "title"],
    browser: "nope-9",
  }, () => ({ code: 1, stderr: msg }));
  assertEquals(r.writes[0].data.exitCode, 1);
  assertStringIncludes(String(r.writes[0].data.output), "no browser nope-9");
  assertStringIncludes(r.error!.message, "no browser nope-9");
});

Deno.test("contract: new-tab on an unknown browser (exit 1)", async () => {
  const w = world([fakeBrowser("17683-1", ["https://x.com/"])]);
  const r = await runMethod(
    "open",
    { url: "a.test" },
    (c) =>
      c.args[0] === "new-tab"
        ? {
          code: 1,
          stderr: "terminal-browser: no browser nope-9. Running:\n" +
            "  17683-1 (w8:t15:w8:p1A) https://terminal-browser.com/",
        }
        : emulate(w, c),
  );
  assertStringIncludes(r.error!.message, "new-tab failed (exit 1)");
  assertStringIncludes(r.error!.message, "no browser nope-9. Running:");
});

Deno.test("contract: config get of an invalid key (exit 1)", async () => {
  const r = await runMethod(
    "config",
    { op: "get", key: "no.such.key" },
    () => ({
      code: 1,
      stderr: "error: invalid key: no.such.key",
    }),
  );
  assertStringIncludes(r.error!.message, "error: invalid key: no.such.key");
});

Deno.test("contract: action with an unknown command (exit 1)", async () => {
  const r = await runMethod(
    "action",
    { command: ["bogus-cmd"] },
    () => ({ code: 1, stderr: "Unknown command: bogus-cmd" }),
  );
  assertEquals(r.writes[0].data.output, "Unknown command: bogus-cmd");
  assertStringIncludes(r.error!.message, "Unknown command: bogus-cmd");
});

Deno.test("contract: config list key=value format", async () => {
  const listing = [
    "search.engine=https://www.google.com/search?q=%s",
    "search.suggestions=https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
    "telemetry.usage=on",
    "render.fps=display",
  ].join("\n");
  const r = await runMethod("config", {}, () => ({ stdout: listing }));
  const s = r.writes[0].data.settings as Record<string, string>;
  assertEquals(
    s["search.suggestions"],
    "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
  );
  assertEquals(Object.keys(s).length, 4);
});
