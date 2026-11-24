/**
 * Coverage tests for @magistr/terminal-browser — one test per guard a
 * reviewer could delete without another suite going red.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertPositional,
  browsersInCurrentTab,
  findTab,
  model,
  normalizeUrl,
  parseLs,
  parseVersion,
  truncateBytes,
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
// assertPositional — each guard
// ---------------------------------------------------------------------------

Deno.test("assertPositional: empty, dash, NUL, CR, LF each throw", () => {
  assertThrows(() => assertPositional("url", ""), Error, "must not be empty");
  assertThrows(() => assertPositional("url", "-x"), Error, "must not start");
  for (const bad of ["a\0", "a\r", "a\n"]) {
    assertThrows(() => assertPositional("url", bad), Error, "NUL or newline");
  }
  assertEquals(assertPositional("url", "a-b"), "a-b");
});

// ---------------------------------------------------------------------------
// pickBrowser (through new-tab)
// ---------------------------------------------------------------------------

Deno.test("pickBrowser: unknown key error lists the running keys", async () => {
  const w = world([
    fakeBrowser("17683-1", ["https://terminal-browser.com/"]),
    fakeBrowser("200-1", ["https://b.test/"], false),
  ]);
  const r = await runMethod("new-tab", { url: "a.test", browser: "nope-9" }, w);
  assertStringIncludes(r.error!.message, "no browser nope-9");
  assertStringIncludes(r.error!.message, "17683-1, 200-1");
});

Deno.test("pickBrowser: unknown key with nothing running says none", async () => {
  const r = await runMethod(
    "new-tab",
    { url: "a.test", browser: "1-1" },
    world(),
  );
  assertStringIncludes(r.error!.message, "running: none");
});

// ---------------------------------------------------------------------------
// truncateBytes — multi-byte boundaries
// ---------------------------------------------------------------------------

Deno.test("truncateBytes: never splits a multi-byte character", () => {
  assertEquals(truncateBytes("aé", 2), { text: "a", truncated: true });
  assertEquals(truncateBytes("😀", 3), { text: "", truncated: true });
  assertEquals(truncateBytes("a😀b", 5), { text: "a😀", truncated: true });
  assertEquals(truncateBytes("abc", 3), { text: "abc", truncated: false });
});

Deno.test("truncateBytes: a genuine U+FFFD before the cut point is kept", () => {
  assertEquals(truncateBytes("�ab", 4), { text: "�a", truncated: true });
});

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

const cases: Array<[string, string]> = [
  ["3000", "http://localhost:3000/"],
  [":8080", "http://localhost:8080/"],
  ["localhost:3000/x", "http://localhost:3000/x"],
  ["127.0.0.1:5173", "http://127.0.0.1:5173/"],
  ["[::1]:8000", "http://[::1]:8000/"],
  ["example.com", "https://example.com/"],
  ["  Example.COM/Path  ", "https://example.com/Path"],
  ["https://x.com", "https://x.com/"],
  ["http://x.com/a?b=1", "http://x.com/a?b=1"],
  ["file:///tmp/a.html", "file:///tmp/a.html"],
  ["./plan.html", "./plan.html"],
  ["../r.md", "../r.md"],
  ["~/notes.md", "~/notes.md"],
  ["/abs/report.html", "/abs/report.html"],
];
for (const [input, want] of cases) {
  Deno.test(`normalizeUrl(${JSON.stringify(input)})`, () => {
    assertEquals(normalizeUrl(input), want);
  });
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

Deno.test("parseVersion: unknown text is returned trimmed", () => {
  assertEquals(parseVersion("  dev build \n"), "dev build");
  assertEquals(parseVersion("terminal-browser 1.2.3-beta.1"), "1.2.3-beta.1");
});

Deno.test("findTab / browsersInCurrentTab", () => {
  const ls = parseLs(JSON.stringify({
    browsers: [
      fakeBrowser("1-1", ["https://a.test/"]),
      fakeBrowser("2-1", ["https://b.test/"], false),
    ],
  }));
  assertEquals(browsersInCurrentTab(ls).map((b) => b.key), ["1-1"]);
  assertEquals(findTab(ls.browsers[0], "a.test")?.id, 1);
  assertEquals(findTab(ls.browsers[0], "b.test"), undefined);
});

// ---------------------------------------------------------------------------
// open — which browser gets recorded
// ---------------------------------------------------------------------------

Deno.test("open: picks the browser named in 'opened <key>'", async () => {
  const w = world([fakeBrowser("5-1", ["https://other.test/"], false)]);
  const r = await runMethod("open", { url: "a.test" }, w);
  assertEquals(subs(r.calls), ["ls", "open", "ls"]);
  const d = r.writes[0].data as { browser: { key: string } };
  assertEquals(d.browser.key, "20000-1");
});

Deno.test("open: without 'opened <key>' falls back to the new browser by diff", async () => {
  const w = world([fakeBrowser("5-1", ["https://other.test/"], false)]);
  const r = await runMethod("open", { url: "a.test" }, (c) => {
    const reply = emulate(w, c);
    return c.args[0] === "open" ? { stdout: "" } : reply;
  });
  const d = r.writes[0].data as { browser: { key: string } };
  assertEquals(d.browser.key, "20000-1");
});

Deno.test("open: no new browser visible records browser null", async () => {
  const w = world();
  const r = await runMethod(
    "open",
    { url: "a.test" },
    (c) => c.args[0] === "open" ? { stdout: "" } : emulate(w, c),
  );
  assertEquals(r.writes[0].data.outcome, "opened");
  assertEquals(r.writes[0].data.browser, null);
});

// ---------------------------------------------------------------------------
// action argv ordering, status without a caller
// ---------------------------------------------------------------------------

Deno.test("action: selectors precede -- in a fixed order", async () => {
  const r = await runMethod("action", {
    command: ["snapshot"],
    browser: "100-1",
    tab: 2,
    target: "F9B2A496",
    follow: true,
  }, world());
  assertEquals(r.calls[0].args, [
    "action",
    "--browser",
    "100-1",
    "--tab",
    "2",
    "--target",
    "F9B2A496",
    "--follow",
    "--",
    "snapshot",
  ]);
  assertEquals(r.writes[0].data.browser, "100-1");
  assertEquals(r.writes[0].data.tab, 2);
});

Deno.test("status: outside a supported terminal caller ids are null", async () => {
  const w = world();
  w.self = null;
  const r = await runMethod("status", {}, w);
  assertEquals(r.writes[0].data.callerTab, null);
  assertEquals(r.writes[0].data.callerPane, null);
});

Deno.test("CLI error falls back to stdout when stderr is empty", async () => {
  const w = world();
  w.fail = { "--version": { code: 1, stdout: "only on stdout" } };
  const r = await runMethod("status", {}, w);
  assertStringIncludes(r.error!.message, "only on stdout");
});

Deno.test("non-NotFound spawn errors are rethrown unchanged", async () => {
  const h = installCommand(() => ({ stdout: "" }));
  h.restore();
  const D = Deno as unknown as { Command: unknown };
  const original = D.Command;
  D.Command = class {
    output() {
      return Promise.reject(new Deno.errors.PermissionDenied("run denied"));
    }
  };
  try {
    const methods = model.methods as unknown as Record<string, Method>;
    await assertRejects(
      () =>
        methods.status.execute({}, {
          globalArgs: {},
          writeResource: () => Promise.resolve({}),
        }),
      Deno.errors.PermissionDenied,
    );
  } finally {
    D.Command = original;
  }
});
