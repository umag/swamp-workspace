/**
 * @magistr/gtoolkit — drive a running Glamorous Toolkit from swamp.
 *
 * GT ships its own MCP server (GtLMcpServer) with the tools its LLM harness
 * uses: code and Lepiter search, code changes, example runs, Smalltalk
 * evaluation with an object storage, and object views. This model starts GT
 * with that server switched on and talks to it. It adds only what GT's tools
 * do not return directly: views rendered to rows (through Phlow's declarative
 * specifications, the Remote Phlow serialisation), drilling into an item,
 * opening inspector windows, and PNG screenshots of windows or single views.
 *
 * Large results travel through files in `exchangeDir` (GT runs on the same
 * machine), because GT's evaluation tool truncates print strings at 50 000
 * characters.
 */
import { z } from "npm:zod@4";
import {
  callTool,
  type Fetch,
  initialize,
  isObject,
  listTools,
  type McpEndpoint,
  McpUnreachable,
} from "./lib/mcp.ts";
import { parseLenientJson } from "./lib/json.ts";
import {
  assertIdentifier,
  assertObjectId,
  assertViewSelector,
  bootScript,
  INSPECT_CODE,
  renderViewCode,
  sentItemCode,
  viewPngCode,
  windowPngCode,
  WINDOWS_CODE,
} from "./lib/smalltalk.ts";

/** Model type version (CalVer), equal to `model.version`. */
export const VERSION = "2026.09.27.1";

// ---------------------------------------------------------------- arguments

/** Per-instance settings: where GT is installed and where its MCP server listens. */
export const GlobalArgsSchema = z.object({
  gtHome: z.string().default("").describe(
    "GT install directory: holds GlamorousToolkit.app (macOS) or bin/ (Linux) and the image. Needed only by `start`.",
  ),
  image: z.string().default("GlamorousToolkit.image").describe(
    "Image file inside gtHome",
  ),
  host: z.string().default("127.0.0.1").describe(
    "Host GT's MCP server listens on",
  ),
  port: z.number().int().min(1).max(65535).default(4747).describe(
    "Port for GT's MCP server",
  ),
  exchangeDir: z.string().default("").describe(
    "Directory GT writes large results and screenshots to; default $TMPDIR/swamp-gtoolkit",
  ),
  requestTimeoutMs: z.number().int().min(1000).max(600000).default(120000)
    .describe("Timeout for one request to GT"),
});
/** Parsed global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StatusArgs = z.object({});
const StartArgs = z.object({
  openWorld: z.boolean().default(true).describe(
    "Open GT's home window after start",
  ),
  timeoutMs: z.number().int().min(1000).max(600000).default(180000).describe(
    "How long to wait for GT to answer after launch",
  ),
});
const StopArgs = z.object({
  save: z.boolean().default(false).describe(
    "Save the image before quitting (keeps objects, pages and code changes)",
  ),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
});
/** CLI --input key=value delivers objects as JSON strings; accept both forms. */
export function jsonObjectArg(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v.trim() === "") return {};
  try {
    return JSON.parse(v);
  } catch {
    return v; // let the schema report the type error
  }
}

const Bindings = z.preprocess(
  jsonObjectArg,
  z.record(z.string(), z.string()).default({}),
).describe(
  "Temporary names bound to objects already in GT's object storage: { name: objectId }",
);
const EvalArgs = z.object({
  code: z.string().min(1).describe(
    "Smalltalk to evaluate in GT; the result is stored and gets an objectId",
  ),
  bindings: Bindings,
});
const ViewArgs = z.object({
  objectId: z.string().describe("Object to show, from an evaluation"),
  view: z.string().default("").describe(
    "View selector (gtItemsFor:) or tab title (Items); empty = the first tab",
  ),
  start: z.number().int().min(1).default(1).describe("First row, 1-based"),
  count: z.number().int().min(1).max(10000).default(50).describe(
    "Rows to fetch",
  ),
});
const OpenArgs = z.object({
  objectId: z.string(),
  view: z.string().default("").describe("View selector or tab title"),
  index: z.number().int().min(1).describe(
    "Row to open, 1-based, as listed by `view`",
  ),
});
const InspectArgs = z.object({
  objectId: z.string().default("").describe(
    "Stored object to open in a GT window",
  ),
  code: z.string().default("").describe("Or Smalltalk whose result to open"),
  bindings: Bindings,
});
const ScreenshotArgs = z.object({
  objectId: z.string().default("").describe(
    "With `view`: render that view of the object offscreen",
  ),
  view: z.string().default(""),
  window: z.string().default("").describe(
    "Without objectId: the open GT window whose title contains this (empty = newest)",
  ),
  width: z.number().int().min(100).max(4000).default(900),
  height: z.number().int().min(100).max(4000).default(700),
});
const ToolsArgs = z.object({});
const ToolArgs = z.object({
  name: z.string().min(1).describe("GT MCP tool name, as listed by `tools`"),
  arguments: z.preprocess(
    jsonObjectArg,
    z.record(z.string(), z.unknown()).default({}),
  ).describe("Tool arguments as an object (or a JSON string)"),
  maxTextBytes: z.number().int().min(1000).max(5_000_000).default(200_000),
});

// ---------------------------------------------------------------- resources

const ViewRef = z.object({ selector: z.string(), title: z.string() });

/** Shape of the `status` resource. */
export const StatusSchema = z.object({
  reachable: z.boolean(),
  url: z.string(),
  server: z.string(),
  protocolVersion: z.string(),
  toolCount: z.number(),
  windows: z.array(z.string()),
  gtProcesses: z.array(z.object({ pid: z.number(), command: z.string() })),
  error: z.string(),
  checkedAt: z.string(),
});

/** Shape of the `evaluation` resource: one Smalltalk evaluation and the object it produced. */
export const EvaluationSchema = z.object({
  code: z.string(),
  ok: z.boolean(),
  objectId: z.string(),
  className: z.string(),
  printString: z.string(),
  /** For String results: the value without Smalltalk quoting. */
  string: z.string().nullable(),
  views: z.array(ViewRef),
  error: z.object({
    reason: z.string(),
    message: z.string(),
    stackTrace: z.string(),
  })
    .nullable(),
  evaluatedAt: z.string(),
});
/** A parsed evaluation. */
export type Evaluation = z.infer<typeof EvaluationSchema>;

/** Shape of the `view` resource: one Phlow view rendered to columns and rows, or text. */
export const ViewSchema = z.object({
  objectId: z.string(),
  selector: z.string(),
  title: z.string(),
  kind: z.string(),
  columns: z.array(z.string()),
  total: z.number().nullable(),
  start: z.number(),
  rows: z.array(z.object({ index: z.number(), cells: z.array(z.string()) })),
  text: z.string().nullable(),
  error: z.string().nullable(),
  renderedAt: z.string(),
});
/** A rendered view. */
export type ViewData = z.infer<typeof ViewSchema>;

/** Shape of the `tools` resource. */
export const ToolsSchema = z.object({
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    arguments: z.array(z.string()),
  })),
  listedAt: z.string(),
});

/** Shape of the `tool-result` resource. */
export const ToolResultSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  isError: z.boolean(),
  text: z.string(),
  truncated: z.boolean(),
  json: z.unknown(),
  calledAt: z.string(),
});

/** Shape of the `screenshot` resource. */
export const ScreenshotSchema = z.object({
  path: z.string(),
  source: z.string(),
  bytes: z.number(),
  takenAt: z.string(),
});

/** Shape of the `action` resource written by start, stop and inspect. */
export const ActionSchema = z.object({
  method: z.string(),
  changed: z.boolean(),
  detail: z.string(),
  pid: z.number().nullable(),
  at: z.string(),
});

// ---------------------------------------------------------------- dependencies

/** Everything the methods touch outside the process: HTTP, subprocesses, files, time. Injected in tests. */
export interface Deps {
  fetch: Fetch;
  /** Starts a detached process; returns its pid. */
  spawnDetached(cmd: string, args: string[], cwd: string): number;
  /** `ps -axo pid=,command=` output. */
  processList(): Promise<string>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  fileSize(path: string): Promise<number | null>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  uuid(): string;
  tmpDir(): string;
}

const denoDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  spawnDetached(cmd, args, cwd) {
    const child = new Deno.Command(cmd, {
      args,
      cwd,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    child.unref();
    return child.pid;
  },
  async processList() {
    const out = await new Deno.Command("ps", {
      args: ["-axo", "pid=,command="],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout);
  },
  readTextFile: (p) => Deno.readTextFile(p),
  writeTextFile: (p, t) => Deno.writeTextFile(p, t),
  async remove(p) {
    await Deno.remove(p).catch(() => {});
  },
  async fileSize(p) {
    try {
      return (await Deno.stat(p)).size;
    } catch {
      return null;
    }
  },
  mkdir: (p) => Deno.mkdir(p, { recursive: true }),
  async exists(p) {
    try {
      await Deno.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
  tmpDir: () => Deno.env.get("TMPDIR") ?? "/tmp",
};

/** The part of swamp's method context this model uses. */
export interface GtContext {
  globalArgs: Record<string, unknown>;
  writeResource(spec: string, name: string, data: unknown): Promise<unknown>;
}

interface Env {
  g: GlobalArgs;
  ep: McpEndpoint;
  exchangeDir: string;
  deps: Deps;
}

function envOf(context: GtContext, deps: Deps): Env {
  const g = GlobalArgsSchema.parse(context.globalArgs ?? {});
  return {
    g,
    ep: {
      url: `http://${g.host}:${g.port}/`,
      timeoutMs: g.requestTimeoutMs,
      fetch: deps.fetch,
    },
    exchangeDir: g.exchangeDir ||
      `${deps.tmpDir().replace(/\/$/, "")}/swamp-gtoolkit`,
    deps,
  };
}

// ---------------------------------------------------------------- core helpers

/** Evaluates Smalltalk through GT's smalltalkCodeEvaluation tool. */
export async function evaluate(
  env: Env,
  code: string,
  bindings: Record<string, string> = {},
): Promise<Evaluation> {
  const binds = Object.entries(bindings).map(([name, objectId]) => ({
    name: assertIdentifier(name, "binding name"),
    objectId: assertObjectId(objectId),
  }));
  const r = await callTool(env.ep, "smalltalkCodeEvaluation", {
    code,
    bindings: binds,
  });
  return toEvaluation(code, r.json, r.text, env.deps.now());
}

/** Builds an Evaluation from the JSON GT's smalltalkCodeEvaluation tool answers. */
export function toEvaluation(
  code: string,
  json: unknown,
  text: string,
  now: Date,
): Evaluation {
  const j = isObject(json) ? json : {};
  const value = isObject(j.objectValue) ? j.objectValue : {};
  const views = Array.isArray(value.phlowViews) ? value.phlowViews : [];
  const errorDetails = isObject(j.errorDetails) ? j.errorDetails : null;
  const failed = typeof j.errorReason === "string" || errorDetails !== null ||
    !isObject(json);
  const className = String(value.objectClassName ?? "");
  // GT doubles every quote of the print string ('ok' arrives as ''ok''); undo that once.
  const printString = String(value.objectPrintString ?? "").replaceAll(
    "''",
    "'",
  );
  return {
    code,
    ok: !failed,
    objectId: typeof j.objectId === "string" ? j.objectId : "",
    className,
    printString,
    string: /String$|Symbol$/.test(className)
      ? unquoteSmalltalk(printString)
      : null,
    views: views.filter(isObject).map((v) => ({
      selector: String(v.methodName ?? ""),
      title: String(v.title ?? ""),
    })),
    error: failed
      ? {
        reason: String(
          j.errorReason ?? (isObject(json) ? "error" : "unparseable response"),
        ),
        message: String(
          errorDetails?.errorMessage ??
            (isObject(json) ? "" : text.slice(0, 500)),
        ),
        stackTrace: String(errorDetails?.stackTrace ?? "").slice(0, 4000),
      }
      : null,
    evaluatedAt: now.toISOString(),
  };
}

/** 'it''s' -> it's; #sym -> sym. Leaves anything else untouched. */
export function unquoteSmalltalk(printString: string): string {
  if (
    printString.length >= 2 && printString.startsWith("'") &&
    printString.endsWith("'")
  ) {
    return printString.slice(1, -1).replaceAll("''", "'");
  }
  if (printString.startsWith("#")) return printString.slice(1);
  return printString;
}

function requireOk(e: Evaluation, what: string): Evaluation {
  if (!e.ok) {
    throw new Error(
      `${what} failed in GT: ${e.error?.reason} ${e.error?.message}`.trim(),
    );
  }
  return e;
}

/** Resolves a view argument (selector, title or empty) against an object's views. */
export async function resolveView(
  env: Env,
  objectId: string,
  view: string,
): Promise<{ selector: string; title: string }> {
  assertObjectId(objectId);
  if (view.endsWith(":")) {
    return { selector: assertViewSelector(view), title: "" };
  }
  const self = requireOk(
    await evaluate(env, "obj", { obj: objectId }),
    "looking up views",
  );
  if (self.views.length === 0) {
    throw new Error(`object ${objectId} has no views`);
  }
  if (view === "") return self.views[0];
  const hit = self.views.find((v) =>
    v.title.toLowerCase() === view.toLowerCase()
  );
  if (!hit) {
    throw new Error(
      `no view titled ${JSON.stringify(view)}; views: ${
        self.views.map((v) => v.title).join(", ")
      }`,
    );
  }
  return hit;
}

/** Evaluates code that writes `path`, then reads and removes it. */
async function viaFile(
  env: Env,
  code: (path: string) => string,
  bindings: Record<string, string>,
  ext: string,
): Promise<string> {
  await env.deps.mkdir(env.exchangeDir);
  const path = `${env.exchangeDir}/${env.deps.uuid()}.${ext}`;
  requireOk(await evaluate(env, code(path), bindings), "rendering");
  try {
    return await env.deps.readTextFile(path);
  } finally {
    await env.deps.remove(path);
  }
}

/** Text of one Remote Phlow cell value, whatever its shape. */
export function cellText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (!isObject(v)) return "";
  if (typeof v.sourceString === "string") return v.sourceString;
  if ("itemText" in v) return cellText(v.itemText);
  if ("text" in v) return cellText(v.text);
  if ("string" in v) return cellText(v.string);
  return "";
}

/** Flattens a rendered declarative view (see renderViewCode) into rows. */
export function flattenView(
  raw: unknown,
  objectId: string,
  selector: string,
  start: number,
  now: Date,
): ViewData {
  const r = isObject(raw) ? raw : {};
  const spec = isObject(r.spec) ? r.spec : {};
  const colSpecs = Array.isArray(spec.columnSpecifications)
    ? spec.columnSpecifications.filter(isObject)
    : [];
  // Icon columns (type "unknown") render as stencil names, not text: drop them.
  const keep = colSpecs.map((c) => c.type !== "unknown");
  const items = Array.isArray(r.items) ? r.items : [];
  const rows = items.map((item, i) => {
    const node = isObject(item) && isObject(item.nodeValue)
      ? item.nodeValue
      : item;
    let cells: string[];
    if (isObject(node) && Array.isArray(node.columnValues)) {
      cells = node.columnValues.map(cellText).filter((_, c) => keep[c] ?? true);
    } else {
      cells = [cellText(node)];
    }
    return { index: start + i, cells };
  });
  return {
    objectId,
    selector,
    title: String(spec.title ?? ""),
    kind: String(spec.viewName ?? spec.__typeName ?? ""),
    columns: colSpecs.filter((_, c) => keep[c]).map((c) =>
      String(c.title ?? "")
    ),
    total: typeof r.total === "number" ? r.total : null,
    start,
    rows,
    text: typeof r.text === "string" ? r.text : null,
    error: typeof r.error === "string" ? r.error : null,
    renderedAt: now.toISOString(),
  };
}

/** GT processes in `ps -axo pid=,command=` output: those whose executable is GT's. */
export function parseGtProcesses(
  ps: string,
): { pid: number; command: string }[] {
  return ps.split("\n")
    .map((l) => l.trim())
    .map((l) => {
      const m = l.match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), command: m[2] } : null;
    })
    .filter((x): x is { pid: number; command: string } =>
      // The executable itself is GT's, not a command that merely mentions a path.
      x !== null && /GlamorousToolkit[^/\s]*$/.test(x.command.split(/\s+/)[0])
    );
}

async function probe(
  env: Env,
): Promise<{ ok: boolean; server: string; protocol: string; error: string }> {
  try {
    const info = await initialize(env.ep);
    return {
      ok: true,
      server: info.title || info.name,
      protocol: info.protocolVersion,
      error: "",
    };
  } catch (err) {
    return {
      ok: false,
      server: "",
      protocol: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function cliPaths(g: GlobalArgs): string[] {
  const home = g.gtHome.replace(/\/$/, "");
  return [
    `${home}/GlamorousToolkit.app/Contents/MacOS/GlamorousToolkit-cli`,
    `${home}/bin/GlamorousToolkit-cli`,
  ];
}

// ---------------------------------------------------------------- methods

/** `status` method: reachability, tool count, open windows, GT processes. */
export async function runStatus(context: GtContext, deps: Deps = denoDeps) {
  const env = envOf(context, deps);
  const p = await probe(env);
  let toolCount = 0;
  let windows: string[] = [];
  if (p.ok) {
    toolCount = (await listTools(env.ep)).length;
    const w = await evaluate(env, WINDOWS_CODE);
    windows = w.ok ? parseStringArray(w.printString) : [];
  }
  const gtProcesses = parseGtProcesses(
    await deps.processList().catch(() => ""),
  );
  return [
    await context.writeResource("status", "status", {
      reachable: p.ok,
      url: env.ep.url,
      server: p.server,
      protocolVersion: p.protocol,
      toolCount,
      windows,
      gtProcesses,
      error: p.error,
      checkedAt: deps.now().toISOString(),
    }),
  ];
}

/** Parses a Smalltalk literal array of strings: #('a' 'b''c'). */
export function parseStringArray(printString: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  for (const m of printString.matchAll(re)) {
    out.push(m[1].replaceAll("''", "'"));
  }
  return out;
}

/** `start` method: launch GT with its MCP server unless it already answers. */
export async function runStart(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = StartArgs.parse(rawArgs ?? {});
  const env = envOf(context, deps);
  const action = (changed: boolean, detail: string, pid: number | null) =>
    context.writeResource("action", "action-start", {
      method: "start",
      changed,
      detail,
      pid,
      at: deps.now().toISOString(),
    });

  // Read state first: an answering server means there is nothing to do.
  const before = await probe(env);
  if (before.ok) {
    return [await action(false, `GT already answering at ${env.ep.url}`, null)];
  }

  if (!env.g.gtHome) {
    throw new Error("gtHome is not set: point it at the GT install directory");
  }
  const imagePath = `${env.g.gtHome.replace(/\/$/, "")}/${env.g.image}`;
  if (!(await deps.exists(imagePath))) {
    throw new Error(`no GT image at ${imagePath}`);
  }
  const running = parseGtProcesses(await deps.processList().catch(() => ""))
    .filter((p) => p.command.includes(imagePath));
  if (running.length > 0) {
    throw new Error(
      `GT is already running this image (pid ${
        running[0].pid
      }) without the MCP server on port ${env.g.port}. ` +
        `Either quit it, or evaluate this in a GT playground:\n${
          bootScript(env.g.port, false)
        }`,
    );
  }
  let cli = "";
  for (const c of cliPaths(env.g)) if (await deps.exists(c)) cli = c;
  if (!cli) throw new Error(`no GlamorousToolkit-cli under ${env.g.gtHome}`);

  await deps.mkdir(env.exchangeDir);
  const bootPath = `${env.exchangeDir}/boot-${env.g.port}.st`;
  await deps.writeTextFile(bootPath, bootScript(env.g.port, args.openWorld));
  const pid = deps.spawnDetached(
    cli,
    ["--interactive", imagePath, "st", "--no-quit", bootPath],
    env.g.gtHome,
  );

  const deadline = deps.now().getTime() + args.timeoutMs;
  while (deps.now().getTime() < deadline) {
    await deps.sleep(1000);
    if ((await probe(env)).ok) {
      return [
        await action(
          true,
          `started GT (pid ${pid}); MCP at ${env.ep.url}`,
          pid,
        ),
      ];
    }
  }
  throw new Error(
    `GT (pid ${pid}) did not answer at ${env.ep.url} within ${args.timeoutMs} ms`,
  );
}

/** `stop` method: quit GT, optionally saving the image. */
export async function runStop(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = StopArgs.parse(rawArgs ?? {});
  const env = envOf(context, deps);
  const action = (changed: boolean, detail: string) =>
    context.writeResource("action", "action-stop", {
      method: "stop",
      changed,
      detail,
      pid: null,
      at: deps.now().toISOString(),
    });
  const before = await probe(env);
  if (!before.ok) {
    return [
      await action(false, `GT not answering at ${env.ep.url}; nothing to stop`),
    ];
  }

  // Fork so the reply is sent before the image quits.
  const quit = await evaluate(
    env,
    `[ (Delay forMilliseconds: 300) wait. Smalltalk snapshot: ${args.save} andQuit: true ] fork. 'quitting'`,
  );
  requireOk(quit, "quit");
  const deadline = deps.now().getTime() + args.timeoutMs;
  while (deps.now().getTime() < deadline) {
    await deps.sleep(500);
    if (!(await probe(env)).ok) {
      return [
        await action(
          true,
          `GT quit${args.save ? " after saving the image" : " without saving"}`,
        ),
      ];
    }
  }
  throw new Error(`GT still answering ${args.timeoutMs} ms after quit`);
}

/** `eval` method: evaluate Smalltalk, write the evaluation. */
export async function runEval(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = EvalArgs.parse(rawArgs);
  const env = envOf(context, deps);
  const e = await evaluate(env, args.code, args.bindings);
  return [await context.writeResource("evaluation", "evaluation", e)];
}

/** `view` method: render one view of a stored object to rows or text. */
export async function runView(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = ViewArgs.parse(rawArgs);
  const env = envOf(context, deps);
  const v = await resolveView(env, args.objectId, args.view);
  const text = await viaFile(
    env,
    (path) => renderViewCode(v.selector, args.start, args.count, path),
    { obj: args.objectId },
    "json",
  );
  const data = flattenView(
    parseLenientJson(text),
    args.objectId,
    v.selector,
    args.start,
    deps.now(),
  );
  if (!data.title) data.title = v.title;
  return [await context.writeResource("view", "view", data)];
}

/** `open` method: open row `index` of a view as a new stored object. */
export async function runOpen(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = OpenArgs.parse(rawArgs);
  const env = envOf(context, deps);
  const v = await resolveView(env, args.objectId, args.view);
  const e = await evaluate(env, sentItemCode(v.selector, args.index), {
    obj: args.objectId,
  });
  return [await context.writeResource("evaluation", "evaluation", e)];
}

/** `inspect` method: open a GT inspector window on an object. */
export async function runInspect(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = InspectArgs.parse(rawArgs ?? {});
  const env = envOf(context, deps);
  if (!args.objectId === !args.code) {
    throw new Error("give exactly one of objectId or code");
  }
  const target = args.objectId
    ? assertObjectId(args.objectId)
    : requireOk(await evaluate(env, args.code, args.bindings), "evaluating")
      .objectId;
  const e = requireOk(
    await evaluate(env, INSPECT_CODE, { obj: target }),
    "inspect",
  );
  return [
    await context.writeResource("action", "action-inspect", {
      method: "inspect",
      changed: true,
      detail:
        `queued a GT inspector window on ${e.printString} (object ${target})`,
      pid: null,
      at: deps.now().toISOString(),
    }),
  ];
}

/** `screenshot` method: PNG of a GT window or of one view rendered offscreen. */
export async function runScreenshot(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = ScreenshotArgs.parse(rawArgs ?? {});
  const env = envOf(context, deps);
  await deps.mkdir(env.exchangeDir);
  const path = `${env.exchangeDir}/shot-${deps.uuid()}.png`;
  let source: string;
  if (args.objectId) {
    const v = await resolveView(env, args.objectId, args.view);
    requireOk(
      await evaluate(
        env,
        viewPngCode(v.selector, args.width, args.height, path),
        { obj: args.objectId },
      ),
      "rendering the view",
    );
    source = `view ${v.selector} of ${args.objectId}`;
  } else {
    const e = requireOk(
      await evaluate(env, windowPngCode(args.window, path)),
      "capturing the window",
    );
    source = `window ${e.string ?? e.printString}`;
  }
  const bytes = await deps.fileSize(path);
  if (bytes === null) {
    throw new Error(`GT reported success but wrote no file at ${path}`);
  }
  return [
    await context.writeResource("screenshot", "screenshot", {
      path,
      source,
      bytes,
      takenAt: deps.now().toISOString(),
    }),
  ];
}

/** `tools` method: list GT's MCP tools. */
export async function runTools(
  context: GtContext,
  _rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const env = envOf(context, deps);
  const tools = await listTools(env.ep);
  return [
    await context.writeResource("tools", "tools", {
      tools,
      listedAt: deps.now().toISOString(),
    }),
  ];
}

/** `tool` method: call one GT MCP tool. */
export async function runTool(
  context: GtContext,
  rawArgs: unknown,
  deps: Deps = denoDeps,
) {
  const args = ToolArgs.parse(rawArgs);
  const env = envOf(context, deps);
  const r = await callTool(env.ep, args.name, args.arguments);
  const truncated = r.text.length > args.maxTextBytes;
  return [
    await context.writeResource("tool-result", "tool-result", {
      tool: args.name,
      arguments: args.arguments,
      isError: r.isError,
      text: truncated ? r.text.slice(0, args.maxTextBytes) : r.text,
      truncated,
      json: truncated ? null : (r.json ?? null),
      calledAt: deps.now().toISOString(),
    }),
  ];
}

// ---------------------------------------------------------------- model

type Exec = (
  args: Record<string, unknown>,
  context: GtContext,
) => Promise<unknown[]>;
const method = (description: string, args: z.ZodType, run: Exec) => ({
  description,
  arguments: args,
  execute: async (rawArgs: Record<string, unknown>, context: GtContext) => ({
    dataHandles: await run(rawArgs, context),
  }),
});

/** The `@magistr/gtoolkit` model type definition. */
export const model = {
  type: "@magistr/gtoolkit",
  version: "2026.09.28.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      fromVersion: "2026.09.27.1",
      toVersion: "2026.09.28.1",
      description: "Skill and references only; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    status: {
      description:
        "Whether GT's MCP server answers, its tool count, open windows and GT processes",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    evaluation: {
      description:
        "Result of Smalltalk evaluated in GT: object id, class, print string, available views, or the error",
      schema: EvaluationSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    view: {
      description:
        "One Phlow view of a GT object rendered to columns and rows (or text)",
      schema: ViewSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    tools: {
      description: "Tools GT's MCP server exposes",
      schema: ToolsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "tool-result": {
      description: "Result of one GT MCP tool call",
      schema: ToolResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    screenshot: {
      description: "PNG of a GT window or of one view of an object",
      schema: ScreenshotSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    action: {
      description: "Outcome of start, stop or inspect",
      schema: ActionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    status: method(
      "Is GT's MCP server answering? Tool count, open windows and running GT processes. Never fails when GT is down.",
      StatusArgs,
      (_a, c) => runStatus(c),
    ),
    start: method(
      "Launch GT with its MCP server (all GtLTools gt tools). Idempotent: does nothing if GT already answers.",
      StartArgs,
      (a, c) => runStart(c, a),
    ),
    stop: method(
      "Quit GT, optionally saving the image. Does nothing if GT is not answering.",
      StopArgs,
      (a, c) => runStop(c, a),
    ),
    eval: method(
      "Evaluate Smalltalk in GT. The result is stored in GT's object storage; returns its objectId, class, print string and views.",
      EvalArgs,
      (a, c) => runEval(c, a),
    ),
    view: method(
      "Render one view of a stored object (by selector or tab title) to columns and rows, or text — what the GT inspector tab shows.",
      ViewArgs,
      (a, c) => runView(c, a),
    ),
    open: method(
      "Open row `index` of a view — what clicking it in GT opens. Returns a new evaluation with its own objectId.",
      OpenArgs,
      (a, c) => runOpen(c, a),
    ),
    inspect: method(
      "Open a GT inspector window on a stored object or on the result of code, so a human sees it in GT.",
      InspectArgs,
      (a, c) => runInspect(c, a),
    ),
    screenshot: method(
      "PNG of an open GT window, or of one view of an object rendered offscreen. Returns the file path.",
      ScreenshotArgs,
      (a, c) => runScreenshot(c, a),
    ),
    tools: method(
      "List the tools GT's MCP server exposes.",
      ToolsArgs,
      (a, c) => runTools(c, a),
    ),
    tool: method(
      "Call any GT MCP tool by name (code search, Lepiter pages, compile methods, run examples, …).",
      ToolArgs,
      (a, c) => runTool(c, a),
    ),
  },
};

/** Raised when GT's MCP server does not answer; re-exported for callers and tests. */
export { McpUnreachable };
