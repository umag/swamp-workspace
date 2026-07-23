/**
 * `@magistr/flipper-zero` — control a Flipper Zero over its USB serial CLI.
 *
 * One model instance = one Flipper (identified by its serial port, or
 * auto-detected). Methods talk to the device's text CLI (`>: ` prompt) and
 * persist structured results as swamp data:
 *
 * - `detect`         — find the serial port without talking to the device.
 * - `info`           — read device/firmware/power info (`info device`).
 * - `exec`           — run any single CLI command and capture its output.
 * - `storage-list`   — list an SD-card directory (`storage list <path>`).
 * - `storage-read`   — read a file's contents (`storage read <path>`).
 * - `apps`           — list the built-in loader apps (`loader list`).
 * - `installed-apps` — list SD-card apps/scripts under /ext/apps (storage tree).
 * - `launch`         — launch an app by path/name (`loader open`).
 * - `close`          — close the running app (soft close → long Back press).
 * - `running`        — report the running app (`loader info`).
 * - `screenshot`     — capture the screen over RPC, render ASCII/braille.
 * - `show-image`     — draw an image on the screen (RPC virtual display).
 * - `play-snake`     — play Snake autonomously with a survival bot.
 * - `listen`         — receive on sub-GHz / IR / RFID for a window.
 * - `reboot`         — reboot the device (`power reboot`).
 *
 * Serial framing lives in ./lib/serial.ts; text parsing in ./lib/protocol.ts.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  captureRpc,
  exchange,
  listDevNames,
  listenCapture,
  sendRpcHold,
  sequenceCapture,
} from "./lib/serial.ts";
import {
  startScreenStream,
  startVirtualDisplay,
  stopVirtualDisplay,
} from "./lib/rpc.ts";
import {
  framebufferFromAscii,
  framebufferFromBase64,
  invertFramebuffer,
} from "./lib/image.ts";
import {
  candidatePorts,
  cleanResponse,
  cleanSequenceOutput,
  findScreenFrame,
  framebufferBase64,
  installedAppsFromTree,
  looksLikeUnknownCommand,
  parseAppList,
  parseDeviceInfo,
  parseFileSize,
  parseListenEvents,
  parseLoaderInfo,
  parseStorageList,
  parseStorageTree,
  renderAscii,
  renderBraille,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  selectPort,
  type TreeEntry,
} from "./lib/protocol.ts";

const START_SCREEN_STREAM = startScreenStream();

const InputSchema = z.object({
  port: z.string().optional().describe(
    "Serial device path, e.g. /dev/cu.usbmodemflip_Zilxi1 (macOS) or " +
      "/dev/ttyACM0 (Linux). Omit to auto-detect.",
  ),
  baud: z.string().default("230400").describe(
    "Baud rate for stty. The Flipper is USB-CDC so this is cosmetic, but must " +
      "be a valid speed.",
  ),
  timeoutMs: z.number().int().positive().default(8000).describe(
    "Per-command read timeout in milliseconds.",
  ),
});

type GlobalArgs = z.infer<typeof InputSchema>;

/** Minimal shape of the execution context this model relies on. */
interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Resolves a path shipped with the extension (manifest-relative). */
  extensionFile?: (path: string) => string;
}

const ExchangeMeta = {
  timedOut: z.boolean(),
  truncated: z.boolean(),
  timestamp: z.string(),
};

async function resolvePort(globalArgs: GlobalArgs): Promise<string> {
  return selectPort(await listDevNames(), globalArgs.port);
}

function exchangeOpts(
  globalArgs: GlobalArgs,
  overrides: { waitForPrompt?: boolean } = {},
): { baud: string; timeoutMs: number; waitForPrompt?: boolean } {
  return {
    baud: globalArgs.baud,
    timeoutMs: globalArgs.timeoutMs,
    ...overrides,
  };
}

function assertSingleLineCommand(command: string): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("command must be a non-empty string.");
  }
  if (/[\r\n]/.test(command)) {
    throw new Error(
      "command must be a single line — newlines would inject extra CLI input.",
    );
  }
}

/** Run one CLI command and return both raw and cleaned output. */
async function runCommand(
  globalArgs: GlobalArgs,
  command: string,
  overrides: { waitForPrompt?: boolean } = {},
): Promise<{
  port: string;
  raw: string;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  const port = await resolvePort(globalArgs);
  const res = await exchange(
    port,
    command,
    exchangeOpts(globalArgs, overrides),
  );
  return {
    port,
    raw: res.raw,
    output: cleanResponse(res.raw, command),
    timedOut: res.timedOut,
    truncated: res.truncated,
  };
}

/**
 * Enumerate every file under an apps base directory. Uses one `storage tree`
 * command (a single serial exchange — the fan-out primitive), falling back to a
 * one-level `storage list` walk on firmware that lacks `storage tree`.
 */
async function collectAppTree(
  globalArgs: GlobalArgs,
  base: string,
): Promise<{
  port: string;
  raw: string;
  entries: TreeEntry[];
  timedOut: boolean;
  truncated: boolean;
}> {
  const tree = await runCommand(globalArgs, `storage tree ${base}`);
  if (
    !looksLikeUnknownCommand(tree.output) && tree.output.trim().length > 0 &&
    !/Storage error/i.test(tree.output)
  ) {
    return {
      port: tree.port,
      raw: tree.raw,
      entries: parseStorageTree(tree.output),
      timedOut: tree.timedOut,
      truncated: tree.truncated,
    };
  }

  // Fallback: list the base, then list each sub-directory one level deep.
  const rootList = await runCommand(globalArgs, `storage list ${base}`);
  const entries: TreeEntry[] = [];
  const rawParts = [rootList.raw];
  let timedOut = rootList.timedOut;
  let truncated = rootList.truncated;
  for (const entry of parseStorageList(rootList.output)) {
    const full = `${base}/${entry.name}`;
    if (entry.type === "dir") {
      entries.push({ type: "dir", path: full, size: null });
      const sub = await runCommand(globalArgs, `storage list ${full}`);
      rawParts.push(sub.raw);
      timedOut = timedOut || sub.timedOut;
      truncated = truncated || sub.truncated;
      for (const f of parseStorageList(sub.output)) {
        entries.push({ type: f.type, path: `${full}/${f.name}`, size: f.size });
      }
    } else {
      entries.push({ type: "file", path: full, size: entry.size });
    }
  }
  return {
    port: rootList.port,
    raw: rawParts.join("\n---\n"),
    entries,
    timedOut,
    truncated,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find a real `deno` binary. NOT `Deno.execPath()`: swamp is itself a compiled
 * Deno application, so inside a model that returns the swamp binary (which then
 * rejects `run --allow-all`). swamp ships deno at ~/.swamp/deno/deno, which is
 * deliberately not on PATH.
 */
async function resolveDenoPath(): Promise<string> {
  const home = Deno.env.get("HOME");
  const candidates = [
    Deno.env.get("SWAMP_DENO_PATH"),
    home ? `${home}/.swamp/deno/deno` : undefined,
    "deno",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    try {
      const { code } = await new Deno.Command(candidate, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (code === 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "No deno binary found to run the Snake bot (looked for ~/.swamp/deno/deno " +
      "and `deno` on PATH). Set SWAMP_DENO_PATH to override.",
  );
}

/** Read the currently-running app (loader info). */
async function loaderInfo(
  globalArgs: GlobalArgs,
): Promise<
  { running: boolean; app: string | null; port: string; raw: string }
> {
  const r = await runCommand(globalArgs, "loader info");
  const info = parseLoaderInfo(r.output);
  return { running: info.running, app: info.app, port: r.port, raw: r.raw };
}

/**
 * Close the running app, escalating from a soft `loader close` (which blocking
 * GUI apps like games ignore) to a simulated long Back press — the universal
 * Flipper "exit app" gesture. Verifies at each step.
 */
async function closeRunningApp(globalArgs: GlobalArgs): Promise<{
  port: string;
  wasRunning: string | null;
  closed: boolean;
  via: "already-idle" | "loader-close" | "back-button" | "failed";
  output: string;
  raw: string;
}> {
  const before = await loaderInfo(globalArgs);
  if (!before.running) {
    return {
      port: before.port,
      wasRunning: null,
      closed: true,
      via: "already-idle",
      output: "",
      raw: before.raw,
    };
  }

  const soft = await runCommand(globalArgs, "loader close");
  await delay(400);
  if (!(await loaderInfo(globalArgs)).running) {
    return {
      port: soft.port,
      wasRunning: before.app,
      closed: true,
      via: "loader-close",
      output: soft.output,
      raw: soft.raw,
    };
  }

  // Escalate: a long Back press (press, hold, release) exits most apps.
  await runCommand(globalArgs, "input send back press");
  await delay(600);
  const rel = await runCommand(globalArgs, "input send back release");
  await delay(400);
  const still = (await loaderInfo(globalArgs)).running;
  return {
    port: rel.port,
    wasRunning: before.app,
    closed: !still,
    via: still ? "failed" : "back-button",
    output: soft.output,
    raw: [soft.raw, rel.raw].join("\n---\n"),
  };
}

/** The @magistr/flipper-zero model. */
export const model = {
  type: "@magistr/flipper-zero",
  version: "2026.07.23.6",
  globalArguments: InputSchema,
  resources: {
    "device-port": {
      description: "Resolved serial port and detection candidates",
      schema: z.object({
        port: z.string(),
        detected: z.boolean(),
        candidates: z.array(z.string()),
        os: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "device-info": {
      description: "Parsed device/firmware/power information",
      schema: z.object({
        port: z.string(),
        command: z.string(),
        attributes: z.record(z.string(), z.string()),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "command-output": {
      description: "Output of an arbitrary CLI command",
      schema: z.object({
        port: z.string(),
        command: z.string(),
        output: z.string(),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "storage-listing": {
      description: "Directory listing from the SD card",
      schema: z.object({
        port: z.string(),
        path: z.string(),
        entries: z.array(z.object({
          type: z.enum(["dir", "file"]),
          name: z.string(),
          size: z.number().nullable(),
        })),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "file-content": {
      description: "Contents of a file read from the SD card",
      schema: z.object({
        port: z.string(),
        path: z.string(),
        size: z.number().nullable(),
        content: z.string(),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "app-list": {
      description: "Installed applications from loader list",
      schema: z.object({
        port: z.string(),
        apps: z.array(z.string()),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "reboot-result": {
      description: "Outcome of a reboot request",
      schema: z.object({
        port: z.string(),
        requested: z.boolean(),
        raw: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "installed-apps": {
      description: "Installed apps/scripts found on the SD card",
      schema: z.object({
        port: z.string(),
        base: z.string(),
        apps: z.array(z.object({
          name: z.string(),
          id: z.string(),
          category: z.string(),
          kind: z.enum(["fap", "js", "other"]),
          path: z.string(),
          size: z.number().nullable(),
        })),
        categories: z.array(z.string()),
        count: z.number(),
        byKind: z.record(z.string(), z.number()),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "launch-result": {
      description: "Outcome of launching an app via loader open",
      schema: z.object({
        port: z.string(),
        app: z.string(),
        launched: z.boolean(),
        wasRunning: z.string().nullable(),
        nowRunning: z.string().nullable(),
        output: z.string(),
        raw: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "close-result": {
      description: "Outcome of closing the running app",
      schema: z.object({
        port: z.string(),
        wasRunning: z.string().nullable(),
        closed: z.boolean(),
        via: z.enum(["already-idle", "loader-close", "back-button", "failed"]),
        output: z.string(),
        raw: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "loader-info": {
      description: "Currently-running application, per loader info",
      schema: z.object({
        port: z.string(),
        running: z.boolean(),
        app: z.string().nullable(),
        output: z.string(),
        raw: z.string(),
        ...ExchangeMeta,
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "image-shown": {
      description: "An image pushed to the device's virtual display",
      schema: z.object({
        port: z.string(),
        width: z.number(),
        height: z.number(),
        seconds: z.number(),
        source: z.enum(["ascii", "framebuffer"]),
        preview: z.string(),
        framebufferBase64: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "snake-game": {
      description: "Result of an autonomous Snake session",
      schema: z.object({
        port: z.string(),
        seconds: z.number(),
        ticks: z.number(),
        moves: z.number(),
        maxLength: z.number(),
        died: z.boolean(),
        decisions: z.record(z.string(), z.number()),
        log: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "listen-result": {
      description: "What a receiver picked up during a listen window",
      schema: z.object({
        port: z.string(),
        source: z.enum(["subghz", "ir", "rfid", "nfc"]),
        command: z.string(),
        frequency: z.number().nullable(),
        seconds: z.number(),
        eventCount: z.number(),
        events: z.array(z.object({
          summary: z.string(),
          lines: z.array(z.string()),
        })),
        output: z.string(),
        raw: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "screenshot": {
      description: "Rendered capture of the 128x64 device screen",
      schema: z.object({
        port: z.string(),
        width: z.number(),
        height: z.number(),
        ascii: z.string(),
        braille: z.string(),
        framebufferBase64: z.string(),
        capturedBytes: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    detect: {
      description:
        "Find the Flipper's serial port (no device communication). Writes the " +
        "resolved port and all candidate ports.",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        const names = await listDevNames();
        const candidates = candidatePorts(names);
        let port = "";
        let detected = false;
        try {
          port = selectPort(names, context.globalArgs.port);
          detected = true;
        } catch (e) {
          port = context.globalArgs.port ?? "";
          if (candidates.length === 0 && !context.globalArgs.port) {
            throw e;
          }
        }
        await context.writeResource("device-port", "device-port", {
          port,
          detected,
          candidates,
          os: Deno.build.os,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    info: {
      description:
        "Read device, firmware and power information (info device, with a " +
        "device_info fallback) and parse it into attributes.",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        let command = "info device";
        let result = await runCommand(context.globalArgs, command);
        let attributes = parseDeviceInfo(result.output);
        if (
          Object.keys(attributes).length === 0 ||
          looksLikeUnknownCommand(result.output)
        ) {
          command = "device_info";
          result = await runCommand(context.globalArgs, command);
          attributes = parseDeviceInfo(result.output);
        }
        await context.writeResource("device-info", "device-info", {
          port: result.port,
          command,
          attributes,
          raw: result.raw,
          timedOut: result.timedOut,
          truncated: result.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    exec: {
      description:
        'Run a single Flipper CLI command (e.g. "storage info /ext", ' +
        '"gpio mode pc0 0", "vibro 1") and capture its output.',
      arguments: z.object({
        command: z.string().describe(
          'A single CLI command line. Run "help" to list commands.',
        ),
      }),
      execute: async (args: { command: string }, context: ExecContext) => {
        assertSingleLineCommand(args.command);
        const command = args.command.trim();
        const result = await runCommand(context.globalArgs, command);
        await context.writeResource("command-output", "command-output", {
          port: result.port,
          command,
          output: result.output,
          raw: result.raw,
          timedOut: result.timedOut,
          truncated: result.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "storage-list": {
      description: "List a directory on the SD card (storage list <path>).",
      arguments: z.object({
        path: z.string().default("/ext").describe(
          "Storage path to list (default /ext, the SD-card root).",
        ),
      }),
      execute: async (args: { path: string }, context: ExecContext) => {
        const path = (args.path ?? "/ext").trim();
        assertSingleLineCommand(path);
        const result = await runCommand(
          context.globalArgs,
          `storage list ${path}`,
        );
        await context.writeResource("storage-listing", "storage-listing", {
          port: result.port,
          path,
          entries: parseStorageList(result.output),
          raw: result.raw,
          timedOut: result.timedOut,
          truncated: result.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "storage-read": {
      description:
        "Read a file's contents from the SD card (storage read <path>).",
      arguments: z.object({
        path: z.string().describe(
          "Storage path of the file to read, e.g. /ext/subghz/foo.sub.",
        ),
      }),
      execute: async (args: { path: string }, context: ExecContext) => {
        const path = (args.path ?? "").trim();
        assertSingleLineCommand(path);
        const result = await runCommand(
          context.globalArgs,
          `storage read ${path}`,
        );
        const size = parseFileSize(result.output);
        // Strip the "Size: <n>" header line from the returned content.
        const content = result.output.replace(/^\s*Size:\s*\d+\s*\n?/, "");
        await context.writeResource("file-content", "file-content", {
          port: result.port,
          path,
          size,
          content,
          raw: result.raw,
          timedOut: result.timedOut,
          truncated: result.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    apps: {
      description:
        "List the built-in loader applications (loader list). For apps you " +
        "installed on the SD card, use installed-apps.",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        const result = await runCommand(context.globalArgs, "loader list");
        await context.writeResource("app-list", "app-list", {
          port: result.port,
          apps: parseAppList(result.output),
          raw: result.raw,
          timedOut: result.timedOut,
          truncated: result.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "installed-apps": {
      description:
        "List every app/script installed on the SD card by walking an apps " +
        "directory (default /ext/apps): native .fap apps and .js scripts, " +
        "grouped by category, each with a launchable path.",
      arguments: z.object({
        path: z.string().default("/ext/apps").describe(
          "SD-card apps directory to scan (default /ext/apps).",
        ),
        kind: z.enum(["fap", "js", "other"]).optional().describe(
          "Optional filter: only return apps of this kind.",
        ),
      }),
      execute: async (
        args: { path?: string; kind?: "fap" | "js" | "other" },
        context: ExecContext,
      ) => {
        const base = (args.path ?? "/ext/apps").trim();
        assertSingleLineCommand(base);
        const tree = await collectAppTree(context.globalArgs, base);
        let apps = installedAppsFromTree(tree.entries, base);
        if (args.kind) apps = apps.filter((a) => a.kind === args.kind);
        const categories = [...new Set(apps.map((a) => a.category))]
          .filter((c) => c.length > 0).sort();
        const byKind: Record<string, number> = {};
        for (const a of apps) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
        await context.writeResource("installed-apps", "installed-apps", {
          port: tree.port,
          base,
          apps,
          categories,
          count: apps.length,
          byKind,
          raw: tree.raw,
          timedOut: tree.timedOut,
          truncated: tree.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    launch: {
      description:
        "Launch an app (loader open). Pass a full .fap path from installed-apps " +
        "(e.g. /ext/apps/Games/snake_game.fap) or a built-in app name. Refuses " +
        "if another app is already running unless force is set.",
      arguments: z.object({
        app: z.string().describe(
          "App path (e.g. /ext/apps/Games/snake_game.fap) or built-in name.",
        ),
        force: z.boolean().optional().describe(
          "Close any already-running app first (default false).",
        ),
      }),
      execute: async (
        args: { app: string; force?: boolean },
        context: ExecContext,
      ) => {
        const app = (args.app ?? "").trim();
        assertSingleLineCommand(app);

        // Read state first: is an app already running?
        const before = await loaderInfo(context.globalArgs);
        if (before.running && !args.force) {
          throw new Error(
            `An app ("${before.app}") is already running. Pass force:true, ` +
              `or use the close method first.`,
          );
        }
        if (before.running && args.force) {
          const closed = await closeRunningApp(context.globalArgs);
          if (!closed.closed) {
            throw new Error(
              `Could not close the running app ("${before.app}") to make way ` +
                `for ${app}; it may only exit via the physical Back button.`,
            );
          }
        }

        const result = await runCommand(
          context.globalArgs,
          `loader open ${app}`,
        );
        // loader open prints nothing on success, an error/lock line on failure.
        const openFailed = result.output.trim().length > 0;
        await delay(400);
        const after = await loaderInfo(context.globalArgs);
        const launched = !openFailed && after.running;

        await context.writeResource("launch-result", "launch-result", {
          port: result.port,
          app,
          launched,
          wasRunning: before.app,
          nowRunning: after.app,
          output: result.output,
          raw: result.raw,
          timestamp: new Date().toISOString(),
        });
        if (!launched) {
          throw new Error(
            `Failed to launch ${app}: ${
              result.output || "no app is running afterwards"
            }`,
          );
        }
        return {};
      },
    },

    close: {
      description:
        "Close the currently-running app. Tries a soft loader close, then " +
        "escalates to a long Back press for apps that ignore it (e.g. games). " +
        "Idempotent: succeeds when nothing is running.",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        const outcome = await closeRunningApp(context.globalArgs);
        await context.writeResource("close-result", "close-result", {
          port: outcome.port,
          wasRunning: outcome.wasRunning,
          closed: outcome.closed,
          via: outcome.via,
          output: outcome.output,
          raw: outcome.raw,
          timestamp: new Date().toISOString(),
        });
        if (!outcome.closed) {
          throw new Error(
            `Could not close "${outcome.wasRunning}" from the CLI; it may only ` +
              `exit via the physical Back button.`,
          );
        }
        return {};
      },
    },

    running: {
      description:
        "Report which app is currently running, if any (loader info).",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        const result = await runCommand(context.globalArgs, "loader info");
        const info = parseLoaderInfo(result.output);
        await context.writeResource("loader-info", "loader-info", {
          port: result.port,
          running: info.running,
          app: info.app,
          output: result.output,
          raw: result.raw,
          timedOut: result.timedOut,
          truncated: result.truncated,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    screenshot: {
      description:
        "Capture the 128x64 device screen over RPC and render it as ASCII and " +
        "braille (works for any app, menu, or game).",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        const port = await resolvePort(context.globalArgs);
        const bytes = await captureRpc(port, START_SCREEN_STREAM, {
          baud: context.globalArgs.baud,
          // A frame arrives within ~1s of starting the stream; 2.5s is ample.
          timeoutMs: 2500,
          settleMs: 500,
        });
        const fb = findScreenFrame(bytes);
        if (!fb) {
          throw new Error(
            "No screen frame captured over RPC. Ensure the Flipper is " +
              "unlocked and no other RPC client (e.g. qFlipper) is connected.",
          );
        }
        await context.writeResource("screenshot", "screenshot", {
          port,
          width: SCREEN_WIDTH,
          height: SCREEN_HEIGHT,
          ascii: renderAscii(fb),
          braille: renderBraille(fb),
          framebufferBase64: framebufferBase64(fb),
          capturedBytes: bytes.length,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "show-image": {
      description:
        "Draw an image on the Flipper's screen via an RPC virtual display. " +
        "Give ASCII art (any non-blank char lights a pixel, auto-scaled and " +
        "centred) or a raw 1024-byte framebuffer as base64. The image shows " +
        "for `seconds`, then the device returns to its own UI.",
      arguments: z.object({
        ascii: z.string().optional().describe(
          "ASCII art to draw; blank chars are ' ', '.', '·', '_' and '0'.",
        ),
        framebufferBase64: z.string().optional().describe(
          "Raw 1024-byte 128x64 framebuffer, base64 (e.g. from screenshot).",
        ),
        seconds: z.number().positive().default(5).describe(
          "How long to hold the image on screen (default 5).",
        ),
        scale: z.number().int().positive().optional().describe(
          "Pixels per ASCII character (default: auto-fit).",
        ),
        invert: z.boolean().optional().describe("Invert the image."),
      }),
      execute: async (
        args: {
          ascii?: string;
          framebufferBase64?: string;
          seconds?: number;
          scale?: number;
          invert?: boolean;
        },
        context: ExecContext,
      ) => {
        const seconds = args.seconds ?? 5;
        let fb: Uint8Array;
        let source: "ascii" | "framebuffer";
        if (
          args.framebufferBase64 && args.framebufferBase64.trim().length > 0
        ) {
          fb = framebufferFromBase64(args.framebufferBase64);
          if (args.invert) invertFramebuffer(fb);
          source = "framebuffer";
        } else if (args.ascii && args.ascii.trim().length > 0) {
          fb = framebufferFromAscii(args.ascii, {
            scale: args.scale,
            invert: args.invert,
          });
          source = "ascii";
        } else {
          throw new Error("Provide either `ascii` or `framebufferBase64`.");
        }

        const port = await resolvePort(context.globalArgs);
        await sendRpcHold(
          port,
          startVirtualDisplay(fb),
          stopVirtualDisplay(),
          { baud: context.globalArgs.baud, holdMs: seconds * 1000 },
        );

        await context.writeResource("image-shown", "image-shown", {
          port,
          width: SCREEN_WIDTH,
          height: SCREEN_HEIGHT,
          seconds,
          source,
          preview: renderAscii(fb),
          framebufferBase64: framebufferBase64(fb),
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "play-snake": {
      description:
        "Play the bundled Snake game autonomously. Runs a survival bot that " +
        "streams the screen over RPC, plans a path to the food, and only takes " +
        "it if it can still reach its own tail afterwards (otherwise it chases " +
        "its tail). Returns the game log and score.",
      arguments: z.object({
        seconds: z.number().int().positive().default(60).describe(
          "How long to play, in seconds (default 60).",
        ),
        appPath: z.string().default("/ext/apps/Games/snake_game.fap").describe(
          "Path to the Snake .fap on the device.",
        ),
      }),
      execute: async (
        args: { seconds?: number; appPath?: string },
        context: ExecContext,
      ) => {
        const seconds = args.seconds ?? 60;
        const appPath = (args.appPath ?? "/ext/apps/Games/snake_game.fap")
          .trim();
        assertSingleLineCommand(appPath);
        if (!context.extensionFile) {
          throw new Error(
            "This swamp version does not expose extensionFile(); the Snake bot " +
              "script cannot be located.",
          );
        }
        const port = await resolvePort(context.globalArgs);
        const botSource = await Deno.readTextFile(
          context.extensionFile("bots/snake_bot.ts"),
        );

        // The bot needs a long-lived, full-permission serial session (macOS
        // /dev needs --allow-all), so run it as a child deno fed via stdin.
        const denoPath = await resolveDenoPath();
        const child = new Deno.Command(denoPath, {
          args: ["run", "--allow-all", "-", String(seconds), port, appPath],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const w = child.stdin.getWriter();
        await w.write(new TextEncoder().encode(botSource));
        await w.close();

        const killer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch { /* already exited */ }
        }, (seconds + 45) * 1000);
        const { stdout, stderr } = await child.output();
        clearTimeout(killer);

        const log = new TextDecoder().decode(stdout);
        const err = new TextDecoder().decode(stderr).trim();
        const summary = log.match(
          /done\.\s+([\d.]+)s ticks=(\d+) moves=(\d+) maxLen=(\d+).*?decisions=(\{.*\})/,
        );
        if (!summary) {
          throw new Error(
            `Snake bot produced no result. ${err || log.slice(-400)}`,
          );
        }
        let decisions: Record<string, number> = {};
        try {
          decisions = JSON.parse(summary[5]);
        } catch { /* leave empty */ }

        await context.writeResource("snake-game", "snake-game", {
          port,
          seconds: Number(summary[1]),
          ticks: Number(summary[2]),
          moves: Number(summary[3]),
          maxLength: Number(summary[4]),
          died: /GAME OVER|STALLED/.test(log),
          decisions,
          log,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    listen: {
      description:
        "Listen on one of the device's receivers for a fixed window and capture " +
        "what it decodes: sub-GHz radio (default 433.92MHz), infrared, or a " +
        "125kHz RFID card. Receive-only — transmitting is not wrapped.",
      arguments: z.object({
        source: z.enum(["subghz", "ir", "rfid", "nfc"]).default("subghz")
          .describe("Which receiver to listen on."),
        seconds: z.number().positive().default(15).describe(
          "How long to listen (default 15).",
        ),
        frequency: z.number().int().positive().default(433920000).describe(
          "Sub-GHz frequency in Hz (default 433920000 = 433.92MHz).",
        ),
        raw: z.boolean().optional().describe(
          "Capture raw timings instead of decoded packets (subghz/ir).",
        ),
        external: z.boolean().optional().describe(
          "Use an external CC1101 module (device 1) instead of the internal.",
        ),
      }),
      execute: async (
        args: {
          source?: "subghz" | "ir" | "rfid" | "nfc";
          seconds?: number;
          frequency?: number;
          raw?: boolean;
          external?: boolean;
        },
        context: ExecContext,
      ) => {
        const source = args.source ?? "subghz";
        const seconds = args.seconds ?? 15;
        const frequency = args.frequency ?? 433_920_000;
        const device = args.external ? 1 : 0;

        const port = await resolvePort(context.globalArgs);
        let command: string;
        let raw: string;
        let output: string;

        if (source === "nfc") {
          // `nfc` opens a sub-shell ([nfc]>: ), so enter, scan, and exit inside
          // one session — otherwise the device is left stranded in the shell.
          command = "nfc scanner";
          const steps = [
            { send: "nfc", waitMs: 1200 },
            { send: "scanner", waitMs: seconds * 1000 },
            { send: "", waitMs: 800 }, // a keypress stops the scanner
            { send: "exit", waitMs: 700 },
          ];
          raw = await sequenceCapture(port, steps, {
            baud: context.globalArgs.baud,
          });
          output = cleanSequenceOutput(raw, steps.map((s) => s.send));
        } else {
          if (source === "subghz") {
            command = args.raw
              ? `subghz rx_raw ${frequency}`
              : `subghz rx ${frequency} ${device}`;
          } else if (source === "ir") {
            command = args.raw ? "ir rx raw" : "ir rx";
          } else {
            command = "rfid read";
          }
          assertSingleLineCommand(command);
          raw = await listenCapture(port, command, {
            baud: context.globalArgs.baud,
            listenMs: seconds * 1000,
          });
          output = cleanResponse(raw, command);
        }
        const events = parseListenEvents(output);

        await context.writeResource("listen-result", "listen-result", {
          port,
          source,
          command,
          frequency: source === "subghz" ? frequency : null,
          seconds,
          eventCount: events.length,
          events,
          output,
          raw,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    reboot: {
      description:
        "Reboot the device (power reboot). The port drops during reboot, so no " +
        "prompt is awaited.",
      arguments: z.object({}),
      execute: async (_args, context: ExecContext) => {
        const result = await runCommand(context.globalArgs, "power reboot", {
          waitForPrompt: false,
        });
        await context.writeResource("reboot-result", "reboot-result", {
          port: result.port,
          requested: true,
          raw: result.raw,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
  },
};
