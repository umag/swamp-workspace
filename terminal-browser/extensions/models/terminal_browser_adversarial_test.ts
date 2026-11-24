/**
 * Adversarial tests for @magistr/terminal-browser — flag injection, control
 * characters, hostile selectors, hostile ls JSON, shell metacharacters and
 * oversized output.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { model, normalizeUrl, parseLs } from "./terminal_browser.ts";

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
// Flag injection: positional values that start with "-" never reach argv
// ---------------------------------------------------------------------------

for (const url of ["-h", "--help", "--ssh=evil@host", "-"]) {
  Deno.test(`open: url ${JSON.stringify(url)} is refused before any call`, async () => {
    const r = await runMethod("open", { url }, world());
    assertStringIncludes(r.error!.message, 'must not start with "-"');
    assertEquals(r.calls.length, 0);
  });
  Deno.test(`new-tab: url ${JSON.stringify(url)} is refused`, async () => {
    const w = world([fakeBrowser("100-1", ["https://x.com/"])]);
    const r = await runMethod("new-tab", { url }, w);
    assert(r.error);
    assertEquals(r.calls.length, 0);
  });
}

for (const url of ["a.test\nmore", "a.test\r", "a\0b"]) {
  Deno.test(`open: control characters in ${JSON.stringify(url)} are refused`, async () => {
    const r = await runMethod("open", { url }, world());
    assertStringIncludes(r.error!.message, "NUL or newline");
    assertEquals(r.calls.length, 0);
  });
}

Deno.test("config: a value starting with '-' is refused", async () => {
  const r = await runMethod("config", {
    op: "set",
    key: "render.fps",
    value: "--reset",
  }, world());
  assertStringIncludes(r.error!.message, 'must not start with "-"');
  assertEquals(r.calls.length, 0);
});

Deno.test("action: a command word starting with '-' is refused", async () => {
  const r = await runMethod("action", { command: ["--browser", "x"] }, world());
  assertStringIncludes(r.error!.message, 'must not start with "-"');
  assertEquals(r.calls.length, 0);
});

Deno.test("action: NUL in any argument is refused", async () => {
  const r = await runMethod(
    "action",
    { command: ["fill", "@e1", "a\0b"] },
    world(),
  );
  assertStringIncludes(r.error!.message, "NUL");
  assertEquals(r.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Schema-level rejection of hostile selectors
// ---------------------------------------------------------------------------

const methods = model.methods as unknown as Record<
  string,
  { arguments: { safeParse: (v: unknown) => { success: boolean } } }
>;

const rejected: Array<[string, Record<string, unknown>]> = [
  ["new-tab", { url: "a.test", browser: "a b" }],
  ["new-tab", { url: "a.test", browser: "x;rm -rf /" }],
  ["new-tab", { url: "a.test", browser: "--all" }],
  ["action", { command: ["snapshot"], browser: "$(id)" }],
  ["action", { command: ["snapshot"], target: "ABC-123" }],
  ["action", { command: ["snapshot"], tab: 0 }],
  ["action", { command: ["snapshot"], name: "../etc" }],
  ["action", { command: [] }],
  ["open", { ssh: "a;b" }],
  ["open", { ssh: "-oProxyCommand" }],
  ["open", { ssh: "-Elog" }],
  ["open", { split: "middle" }],
  ["open", { size: 0.1 }],
  ["open", { size: 1 }],
  ["config", { op: "get", key: "--help" }],
  ["config", { op: "drop" }],
];
for (const [m, args] of rejected) {
  Deno.test(`${m}: schema rejects ${JSON.stringify(args)}`, () => {
    assertEquals(methods[m].arguments.safeParse(args).success, false);
  });
}

// ---------------------------------------------------------------------------
// Hostile `ls --json` output
// ---------------------------------------------------------------------------

const hostileLs: Array<[string, string]> = [
  ["non-JSON", "<html>502 Bad Gateway</html>"],
  ["browsers not an array", '{"browsers":"nope"}'],
  ["key not a string", '{"browsers":[{"key":5,"tabs":[]}]}'],
  [
    "tab id not a number",
    '{"browsers":[{"key":"1-1","tabs":[{"id":"x","url":"a"}]}]}',
  ],
  ["top-level array", "[]"],
];
for (const [label, stdout] of hostileLs) {
  Deno.test(`status: hostile ls (${label}) fails closed`, async () => {
    const r = await runMethod(
      "status",
      {},
      (c) =>
        c.args[0] === "ls"
          ? { stdout }
          : { stdout: "terminal-browser v0.16.1" },
    );
    assert(r.error);
    assertEquals(r.writes.length, 0);
  });
}

Deno.test("parseLs: non-JSON error carries a bounded snippet", () => {
  const err = assertThrows(() => parseLs("x".repeat(5000)));
  assert((err as Error).message.length < 300);
});

// ---------------------------------------------------------------------------
// Shell metacharacters travel as literal argv elements
// ---------------------------------------------------------------------------

Deno.test("action: shell metacharacters pass through verbatim", async () => {
  const payload = "$(touch /tmp/pwned); `id` && echo ' \" | > x";
  const r = await runMethod("action", { command: ["eval", payload] }, world());
  assertEquals(r.error, undefined);
  assertEquals(r.calls[0].args, ["action", "--", "eval", payload]);
  assertEquals(r.calls[0].cmd, "terminal-browser");
});

Deno.test("open: url with shell metacharacters is one argv element", async () => {
  const url = "http://a.test/?q=$(id)&x=`whoami`;ls";
  const r = await runMethod("open", { url }, world());
  assertEquals(r.calls[1].args[1], url);
  assertEquals(subs(r.calls), ["ls", "open", "ls"]);
});

Deno.test("action: later arguments may start with '-' (after --)", async () => {
  const r = await runMethod(
    "action",
    { command: ["fill", "@e3", "-5"] },
    world(),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.calls[0].args, ["action", "--", "fill", "@e3", "-5"]);
});

// ---------------------------------------------------------------------------
// Oversized output
// ---------------------------------------------------------------------------

Deno.test("action: huge output is truncated to maxOutputBytes", async () => {
  const w = world();
  w.action = () => ({ stdout: "é".repeat(1_000_000) });
  const r = await runMethod("action", {
    command: ["snapshot"],
    maxOutputBytes: 1001,
  }, w);
  const out = String(r.writes[0].data.output);
  assertEquals(r.writes[0].data.truncated, true);
  assert(new TextEncoder().encode(out).length <= 1001);
  assertEquals(out, "é".repeat(500));
});

Deno.test("action: huge failure output is truncated in record and error", async () => {
  const w = world();
  w.action = () => ({ code: 3, stderr: "E".repeat(100_000) });
  const r = await runMethod("action", {
    command: ["snapshot"],
    maxOutputBytes: 500,
  }, w);
  assert(String(r.writes[0].data.output).length <= 500);
  assert(r.error!.message.length < 1200);
});
