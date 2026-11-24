/**
 * `@magistr/terminal-browser` — manage terminal-browser
 * (https://terminal-browser.com), a real Chromium browser that renders inside
 * a terminal pane, from swamp.
 *
 * - `status`   — installed version plus every running browser and its tabs.
 * - `open`     — open a browser as a side panel (split) of the caller's
 *                terminal tab; reuses a browser already open there.
 * - `new-tab`  — open a tab in a running browser (no duplicate tabs).
 * - `action`   — drive a browser through its agent-browser compatible CLI
 *                (snapshot, click, fill, eval, get …).
 * - `config`   — list / get / set / unset settings and shortcuts.
 * - `shutdown` — stop the shared browser daemon (no-op when none runs).
 * - `upgrade`  — upgrade terminal-browser and record before/after versions.
 *
 * Transport is the terminal-browser CLI through `Deno.Command` — never a
 * shell — so urls, selectors and action arguments travel as literal argv
 * elements. Positional values that the CLI would read as a flag are refused
 * before anything runs.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Directions accepted by `terminal-browser open --split`. */
export const SPLIT_DIRECTIONS = ["right", "left", "down", "up"] as const;

const GlobalArgsSchema = z.object({
  binary: z.string().default("terminal-browser").describe(
    "terminal-browser executable (name on PATH or absolute path); when the " +
      "name is not on PATH, $HOME/.local/bin/terminal-browser is tried",
  ),
  timeoutMs: z.number().int().positive().default(60_000).describe(
    "Timeout for one CLI call (a first `open` starts the browser daemon)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

// ---------------------------------------------------------------------------
// Wire format of `terminal-browser ls --json`
// ---------------------------------------------------------------------------

const PaneRefSchema = z.object({
  tab: z.string().nullable().optional(),
  pane: z.string().nullable().optional(),
}).passthrough();

const TabSchema = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string().default(""),
  active: z.boolean().default(false),
  targetId: z.string().optional(),
  agentControlled: z.boolean().optional(),
}).passthrough();

const BrowserSchema = z.object({
  key: z.string(),
  pid: z.number().optional(),
  cdpPort: z.number().optional(),
  pane: PaneRefSchema.nullable().optional(),
  splitDir: z.string().nullable().optional(),
  inCurrentTab: z.boolean().default(false),
  tabs: z.array(TabSchema).default([]),
}).passthrough();

/** Shape of `terminal-browser ls --json`. */
export const LsSchema = z.object({
  self: PaneRefSchema.nullable().optional(),
  browsers: z.array(BrowserSchema).default([]),
}).passthrough();

/** Parsed `ls --json` output. */
export type Ls = z.infer<typeof LsSchema>;
/** One running browser from `ls --json`. */
export type Browser = z.infer<typeof BrowserSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse `ls --json` stdout; throws with a snippet on malformed output. */
export function parseLs(stdout: string): Ls {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(
      `terminal-browser ls returned non-JSON: ${stdout.slice(0, 200)}`,
    );
  }
  return LsSchema.parse(raw);
}

/** `terminal-browser v0.16.1` → `0.16.1`; unknown text is returned trimmed. */
export function parseVersion(stdout: string): string {
  const m = stdout.match(/v?(\d+\.\d+\.\d+[\w.+-]*)/);
  return m ? m[1] : stdout.trim();
}

/**
 * Normalise a url the way terminal-browser reports it, for duplicate-tab
 * checks: bare hosts get `https://`, `localhost:N` / `:N` get `http://`, and
 * an origin with no path gets a trailing `/`. File paths are returned as is.
 */
export function normalizeUrl(url: string): string {
  let u = url.trim();
  if (/^\d+$/.test(u)) u = `localhost:${u}`;
  if (/^:\d+$/.test(u)) u = `localhost${u}`;
  if (/^(\.{0,2}\/|~\/)/.test(u)) return u;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u);
    u = `${local ? "http" : "https"}://${u}`;
  }
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
}

/** Throw when a positional value would be parsed as a CLI flag. */
export function assertPositional(name: string, value: string): string {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  if (value.startsWith("-")) {
    throw new Error(`${name} must not start with "-" (got ${value})`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${name} must not contain NUL or newline characters`);
  }
  return value;
}

/** Browsers living in the caller's terminal tab. */
export function browsersInCurrentTab(ls: Ls): Browser[] {
  return ls.browsers.filter((b) => b.inCurrentTab);
}

/** Find the tab of `browser` whose url matches `url` after normalising. */
export function findTab(browser: Browser, url: string) {
  const want = normalizeUrl(url);
  return browser.tabs.find((t) => normalizeUrl(t.url) === want);
}

/** Cut `text` to at most `max` UTF-8 bytes, flagging truncation. */
export function truncateBytes(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, truncated: false };
  const cut = new TextDecoder().decode(bytes.slice(0, max)).replace(
    /�$/,
    "",
  );
  return { text: cut, truncated: true };
}

// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawn(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  const out = await new Deno.Command(cmd, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(timeoutMs),
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr).trim(),
  };
}

/** Run the CLI; falls back to ~/.local/bin when `binary` is not on PATH. */
async function run(g: GlobalArgs, args: string[]): Promise<RunResult> {
  try {
    return await spawn(g.binary, args, g.timeoutMs);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    const home = Deno.env.get("HOME");
    if (g.binary.includes("/") || !home) {
      throw new Error(`${g.binary} not found; install terminal-browser`);
    }
    try {
      return await spawn(
        `${home}/.local/bin/${g.binary}`,
        args,
        g.timeoutMs,
      );
    } catch (e2) {
      if (e2 instanceof Deno.errors.NotFound) {
        throw new Error(
          `${g.binary} not found on PATH or in ~/.local/bin; install it ` +
            "with: curl -fsSL https://terminal-browser.sh/install | bash",
        );
      }
      throw e2;
    }
  }
}

async function tb(g: GlobalArgs, args: string[]): Promise<string> {
  const r = await run(g, args);
  if (r.code !== 0) {
    throw new Error(
      `terminal-browser ${args[0]} failed (exit ${r.code}): ${
        (r.stderr || r.stdout).trim().slice(-2000)
      }`,
    );
  }
  return r.stdout;
}

async function list(g: GlobalArgs, all: boolean): Promise<Ls> {
  return parseLs(await tb(g, ["ls", "--json", ...(all ? ["--all"] : [])]));
}

const now = () => new Date().toISOString();

/** Pick the target browser: explicit key, else the single one in this tab. */
function pickBrowser(ls: Ls, key: string | undefined): Browser | undefined {
  if (key) {
    const b = ls.browsers.find((x) => x.key === key);
    if (!b) {
      throw new Error(
        `no browser ${key}; running: ${
          ls.browsers.map((x) => x.key).join(", ") || "none"
        }`,
      );
    }
    return b;
  }
  const here = browsersInCurrentTab(ls);
  if (here.length > 1) {
    throw new Error(
      `${here.length} browsers in this terminal tab (${
        here.map((b) => b.key).join(", ")
      }); pass browser`,
    );
  }
  return here[0];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StoredTabSchema = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});

const StoredBrowserSchema = z.object({
  key: z.string(),
  pid: z.number().nullable(),
  cdpPort: z.number().nullable(),
  terminalTab: z.string().nullable(),
  terminalPane: z.string().nullable(),
  splitDir: z.string().nullable(),
  inCurrentTab: z.boolean(),
  tabs: z.array(StoredTabSchema),
});

function store(b: Browser): z.infer<typeof StoredBrowserSchema> {
  return {
    key: b.key,
    pid: b.pid ?? null,
    cdpPort: b.cdpPort ?? null,
    terminalTab: b.pane?.tab ?? null,
    terminalPane: b.pane?.pane ?? null,
    splitDir: b.splitDir ?? null,
    inCurrentTab: b.inCurrentTab,
    tabs: b.tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
    })),
  };
}

const UrlArg = z.string().min(1).describe(
  "URL, localhost port, or path to an HTML/Markdown file",
);
const BrowserKeyArg = z.string().regex(/^[\w.:][\w.:-]*$/).optional().describe(
  "Browser key from `status` (default: the one browser in this terminal tab)",
);

const OpenArgsSchema = z.object({
  url: z.string().optional().transform((u) => u ? u : undefined).describe(
    "URL, localhost port, or HTML/Markdown file path (empty: start page)",
  ),
  split: z.enum(SPLIT_DIRECTIONS).default("right").describe(
    "Side of the caller's pane to open the panel on",
  ),
  size: z.number().min(0.2).max(0.95).optional().describe(
    "Fraction of the space the split takes (0.2–0.95)",
  ),
  ssh: z.string().regex(/^[\w.@][\w.@-]*$/).optional().describe(
    "user@host — proxy all network requests through this machine",
  ),
  reuse: z.boolean().default(true).describe(
    "Reuse a browser already open in this terminal tab instead of " +
      "opening a second panel",
  ),
  noMerge: z.boolean().default(false).describe(
    "Do not merge into a neighbouring terminal-browser as a tab",
  ),
});

const NewTabArgsSchema = z.object({
  url: UrlArg,
  browser: BrowserKeyArg,
  dedupe: z.boolean().default(true).describe(
    "Skip when the browser already has a tab on this url",
  ),
});

const ActionArgsSchema = z.object({
  command: z.array(z.string()).min(1).describe(
    'agent-browser command and its arguments, e.g. ["snapshot"], ' +
      '["click", "@e3"], ["eval", "document.title"]',
  ),
  browser: BrowserKeyArg,
  tab: z.number().int().positive().optional().describe(
    "Tab id from `status`",
  ),
  target: z.string().regex(/^[A-Za-z0-9]+$/).optional().describe(
    "CDP target id",
  ),
  follow: z.boolean().default(false).describe(
    "Bring the tab to the front before running the command",
  ),
  maxOutputBytes: z.number().int().positive().default(200_000),
  name: z.string().regex(/^[\w.-]+$/).default("last").describe(
    "Data name of the recorded action output",
  ),
});

const ConfigArgsSchema = z.object({
  op: z.enum(["list", "get", "set", "unset"]).default("list"),
  key: z.string().regex(/^[\w.][\w.-]*$/).optional().describe(
    "settings.json key or shortcuts.<command>",
  ),
  value: z.string().optional().describe("Value for op=set"),
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Swamp model definition for `@magistr/terminal-browser`. */
export const model = {
  type: "@magistr/terminal-browser",
  version: "2026.11.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Installed version and every running browser with tabs",
      schema: z.object({
        binary: z.string(),
        version: z.string(),
        callerTab: z.string().nullable(),
        callerPane: z.string().nullable(),
        browserCount: z.number(),
        tabCount: z.number(),
        browsers: z.array(StoredBrowserSchema),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    browser: {
      description: "The browser an open / new-tab run targeted",
      schema: z.object({
        outcome: z.enum(["opened", "reused", "tab-opened", "tab-exists"]),
        url: z.string().nullable(),
        browser: StoredBrowserSchema.nullable(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    action: {
      description: "Output of one agent-browser command",
      schema: z.object({
        command: z.array(z.string()),
        browser: z.string().nullable(),
        tab: z.number().nullable(),
        exitCode: z.number(),
        ok: z.boolean(),
        output: z.string(),
        truncated: z.boolean(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    config: {
      description: "Settings read or written",
      schema: z.object({
        op: z.string(),
        key: z.string().nullable(),
        changed: z.boolean(),
        settings: z.record(z.string(), z.string()),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    lifecycle: {
      description: "Result of a shutdown or upgrade",
      schema: z.object({
        op: z.enum(["shutdown", "upgrade"]),
        changed: z.boolean(),
        before: z.string(),
        after: z.string(),
        detail: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description: "Record the installed version and every running browser " +
        "(all terminal tabs) with its tabs.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const version = parseVersion(await tb(g, ["--version"]));
        const ls = await list(g, true);
        await context.writeResource("status", "status", {
          binary: g.binary,
          version,
          callerTab: ls.self?.tab ?? null,
          callerPane: ls.self?.pane ?? null,
          browserCount: ls.browsers.length,
          tabCount: ls.browsers.reduce((n, b) => n + b.tabs.length, 0),
          browsers: ls.browsers.map(store),
          timestamp: now(),
        });
        return {};
      },
    },
    open: {
      description: "Open a browser as a side panel of the caller's terminal " +
        "tab. Idempotent: with reuse (default) an existing browser in this " +
        "tab is kept and the url is opened as a tab only if not already open.",
      arguments: OpenArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = OpenArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        if (args.url) assertPositional("url", args.url);
        const before = await list(g, false);
        const here = browsersInCurrentTab(before);
        if (args.reuse && here.length > 0) {
          const b = here[0];
          if (!args.url || findTab(b, args.url)) {
            await context.writeResource("browser", "browser", {
              outcome: "reused",
              url: args.url ?? null,
              browser: store(b),
              timestamp: now(),
            });
            return {};
          }
          await tb(g, ["new-tab", "--browser", b.key, args.url]);
          const after = pickBrowser(await list(g, false), b.key);
          await context.writeResource("browser", "browser", {
            outcome: "tab-opened",
            url: args.url,
            browser: after ? store(after) : null,
            timestamp: now(),
          });
          return {};
        }
        const argv = ["open"];
        if (args.url) argv.push(args.url);
        argv.push("--split", args.split);
        if (args.size !== undefined) argv.push("--size", String(args.size));
        if (args.ssh) argv.push("--ssh", args.ssh);
        if (args.noMerge) argv.push("--no-merge");
        const out = await tb(g, argv);
        const key = out.match(/opened\s+([\w.:-]+)/)?.[1];
        const after = await list(g, true);
        const known = new Set(before.browsers.map((b) => b.key));
        const b = (key && after.browsers.find((x) => x.key === key)) ||
          after.browsers.find((x) => x.inCurrentTab && !known.has(x.key)) ||
          null;
        await context.writeResource("browser", "browser", {
          outcome: "opened",
          url: args.url ?? null,
          browser: b ? store(b) : null,
          timestamp: now(),
        });
        return {};
      },
    },
    "new-tab": {
      description: "Open a url as a tab in a running browser (default: the " +
        "one in this terminal tab). Skips urls that already have a tab.",
      arguments: NewTabArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = NewTabArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        assertPositional("url", args.url);
        const ls = await list(g, args.browser !== undefined);
        const b = pickBrowser(ls, args.browser);
        if (!b) {
          throw new Error(
            "no browser in this terminal tab; run `open` first or pass browser",
          );
        }
        if (args.dedupe && findTab(b, args.url)) {
          await context.writeResource("browser", "browser", {
            outcome: "tab-exists",
            url: args.url,
            browser: store(b),
            timestamp: now(),
          });
          return {};
        }
        await tb(g, ["new-tab", "--browser", b.key, args.url]);
        const after = pickBrowser(await list(g, true), b.key);
        await context.writeResource("browser", "browser", {
          outcome: "tab-opened",
          url: args.url,
          browser: after ? store(after) : null,
          timestamp: now(),
        });
        return {};
      },
    },
    action: {
      description: "Run one agent-browser command (snapshot, click, fill, " +
        "eval, get …) against a browser tab and record its output. A " +
        "non-zero exit is recorded, then the run fails.",
      arguments: ActionArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = ActionArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        assertPositional("command", args.command[0]);
        for (const a of args.command) {
          if (a.includes("\0")) throw new Error("command contains NUL");
        }
        const argv = ["action"];
        if (args.browser) argv.push("--browser", args.browser);
        if (args.tab !== undefined) argv.push("--tab", String(args.tab));
        if (args.target) argv.push("--target", args.target);
        if (args.follow) argv.push("--follow");
        argv.push("--", ...args.command);
        const r = await run(g, argv);
        const combined = r.code === 0
          ? r.stdout
          : [r.stdout.trim(), r.stderr].filter(Boolean).join("\n");
        const { text, truncated } = truncateBytes(
          combined,
          args.maxOutputBytes,
        );
        await context.writeResource("action", args.name, {
          command: args.command,
          browser: args.browser ?? null,
          tab: args.tab ?? null,
          exitCode: r.code,
          ok: r.code === 0,
          output: text,
          truncated,
          timestamp: now(),
        });
        if (r.code !== 0) {
          throw new Error(
            `action ${args.command[0]} failed (exit ${r.code}): ${
              text.slice(-1000)
            }`,
          );
        }
        return {};
      },
    },
    config: {
      description: "List, get, set or unset a terminal-browser setting or " +
        "shortcut. set/unset read first and skip when already in place.",
      arguments: ConfigArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = ConfigArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        if (args.op !== "list" && !args.key) {
          throw new Error(`config ${args.op} needs key`);
        }
        if (args.op === "set" && args.value === undefined) {
          throw new Error("config set needs value");
        }
        if (args.value !== undefined) assertPositional("value", args.value);
        const parseList = (out: string) => {
          const s: Record<string, string> = {};
          for (const line of out.split("\n")) {
            const i = line.indexOf("=");
            if (i > 0) s[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          }
          return s;
        };
        let changed = false;
        if (args.op === "set" || args.op === "unset") {
          const current = (await tb(g, ["config", "get", args.key!])).trim();
          if (args.op === "set" && current !== args.value) {
            await tb(g, ["config", "set", args.key!, args.value!]);
            changed = true;
          }
          if (args.op === "unset") {
            await tb(g, ["config", "unset", args.key!]);
            const after = (await tb(g, ["config", "get", args.key!])).trim();
            changed = after !== current;
          }
        }
        let settings: Record<string, string>;
        if (args.op === "list") {
          settings = parseList(await tb(g, ["config", "list"]));
        } else {
          settings = {
            [args.key!]: (await tb(g, ["config", "get", args.key!])).trim(),
          };
        }
        await context.writeResource("config", "config", {
          op: args.op,
          key: args.key ?? null,
          changed,
          settings,
          timestamp: now(),
        });
        return {};
      },
    },
    shutdown: {
      description: "Stop the shared browser daemon, closing every browser. " +
        "A recorded no-op when no browser is running.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const ls = await list(g, true);
        const keys = ls.browsers.map((b) => b.key);
        if (keys.length > 0) await tb(g, ["shutdown"]);
        await context.writeResource("lifecycle", "shutdown", {
          op: "shutdown",
          changed: keys.length > 0,
          before: keys.join(",") || "none",
          after: "none",
          detail: keys.length
            ? `closed ${keys.length} browser(s)`
            : "no browser running",
          timestamp: now(),
        });
        return {};
      },
    },
    upgrade: {
      description: "Upgrade terminal-browser to the latest release and " +
        "record the version before and after.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const before = parseVersion(await tb(g, ["--version"]));
        const out = await tb(g, ["upgrade"]);
        const after = parseVersion(await tb(g, ["--version"]));
        await context.writeResource("lifecycle", "upgrade", {
          op: "upgrade",
          changed: before !== after,
          before,
          after,
          detail: out.trim().slice(-2000),
          timestamp: now(),
        });
        return {};
      },
    },
  },
};
