/**
 * Test doubles: a fake GT MCP server (a `fetch` that answers JSON-RPC), fake
 * process/file dependencies, and a context that validates every write
 * against the model's real Zod schema. No test opens a socket or spawns GT.
 */
import { model } from "../gtoolkit.ts";
import type { Deps, GtContext } from "../gtoolkit.ts";
import type { Fetch } from "./mcp.ts";

export interface EvalCall {
  code: string;
  bindings: { name: string; objectId: string }[];
}

export interface FakeGt {
  up: boolean;
  evals: EvalCall[];
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  requests: { method: string; params: unknown }[];
  /** Answer for smalltalkCodeEvaluation; default echoes a String result. */
  onEval: (call: EvalCall) => unknown;
  /** Answer for any other tools/call. */
  onTool: (
    name: string,
    args: Record<string, unknown>,
  ) => { text: string; isError?: boolean };
  tools: { name: string; description: string; inputSchema: unknown }[];
  /** Raw body override for the next response (malformed-response tests). */
  rawNext?: { status: number; body: string; contentType?: string };
  fetch: Fetch;
}

let objectCounter = 0;

/** A GT eval answer the way GtLMagritteToolForSmalltalkCodeEvaluation shapes it. */
export function evalAnswer(
  className: string,
  printString: string,
  views: [string, string][] = [["gtPrintFor:", "Print"]],
): Record<string, unknown> {
  objectCounter++;
  return {
    code: "",
    objectId: `obj${String(objectCounter).padStart(8, "0")}`,
    objectValue: {
      objectClassName: className,
      // GT doubles every quote of the print string.
      objectPrintString: printString.replaceAll("'", "''"),
      phlowViews: views.map(([methodName, title]) => ({ methodName, title })),
    },
  };
}

export function evalError(message: string): Record<string, unknown> {
  return {
    objectId: "errobj00000001",
    errorReason: "Error while evaluating smalltalk code",
    errorDetails: { errorMessage: message, stackTrace: "a\tstack\rtrace" },
  };
}

export function fakeGt(init: Partial<FakeGt> = {}): FakeGt {
  const gt: FakeGt = {
    up: true,
    evals: [],
    toolCalls: [],
    requests: [],
    onEval: () => evalAnswer("ByteString", "'ok'"),
    onTool: (name) => ({ text: JSON.stringify({ tool: name }) }),
    tools: [
      {
        name: "smalltalkCodeEvaluation",
        description: "Executes Smalltalk",
        inputSchema: { properties: { code: {}, bindings: {} } },
      },
      {
        name: "searchForClasses",
        description: "Search",
        inputSchema: { properties: { query: {} } },
      },
    ],
    ...init,
    fetch: () => Promise.resolve(new Response("")),
  };
  gt.fetch = (_url, req) => {
    if (!gt.up) {
      return Promise.reject(
        new TypeError("error sending request: Connection refused"),
      );
    }
    if (gt.rawNext) {
      const r = gt.rawNext;
      gt.rawNext = undefined;
      return Promise.resolve(
        new Response(r.body, {
          status: r.status,
          headers: { "content-type": r.contentType ?? "application/json" },
        }),
      );
    }
    const msg = JSON.parse(String(req.body));
    gt.requests.push({ method: msg.method, params: msg.params });
    const reply = (result: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          headers: { "content-type": "application/json" },
        }),
      );
    switch (msg.method) {
      case "initialize":
        return reply({
          serverInfo: {
            name: "Glamorous Toolkit",
            title: "Glamorous Toolkit MCP Server",
            version: "1.0.0",
          },
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        });
      case "tools/list":
        return reply({ tools: gt.tools });
      case "tools/call": {
        const { name, arguments: args } = msg.params;
        gt.toolCalls.push({ name, arguments: args });
        if (name === "smalltalkCodeEvaluation") {
          const call = { code: args.code, bindings: args.bindings ?? [] };
          gt.evals.push(call);
          // GT's inner JSON is tab-indented and may carry raw \r in strings.
          const text = JSON.stringify(gt.onEval(call), null, "\t").replaceAll(
            "\\r",
            "\r",
          );
          return reply({ content: [{ type: "text", text }], isError: false });
        }
        const t = gt.onTool(name, args);
        return reply({
          content: [{ type: "text", text: t.text }],
          isError: t.isError ?? false,
        });
      }
      default:
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32601,
                message: `Method not found: ${msg.method}`,
              },
            }),
          ),
        );
    }
  };
  return gt;
}

export interface FakeDeps extends Deps {
  files: Map<string, string>;
  spawned: { cmd: string; args: string[]; cwd: string }[];
  ps: string;
  existing: Set<string>;
  clock: number;
}

/** Deps whose files live in memory and whose clock advances on sleep. */
export function fakeDeps(gt: FakeGt, init: Partial<FakeDeps> = {}): FakeDeps {
  const d: FakeDeps = {
    files: new Map(),
    spawned: [],
    ps: "",
    existing: new Set(),
    clock: Date.parse("2026-09-27T12:00:00Z"),
    fetch: gt.fetch,
    spawnDetached(cmd, args, cwd) {
      d.spawned.push({ cmd, args, cwd });
      return 4242;
    },
    processList: () => Promise.resolve(d.ps),
    readTextFile(p) {
      const t = d.files.get(p);
      return t === undefined
        ? Promise.reject(new Deno.errors.NotFound(p))
        : Promise.resolve(t);
    },
    writeTextFile(p, t) {
      d.files.set(p, t);
      return Promise.resolve();
    },
    remove(p) {
      d.files.delete(p);
      return Promise.resolve();
    },
    fileSize: (p) =>
      Promise.resolve(d.files.has(p) ? d.files.get(p)!.length : null),
    mkdir: () => Promise.resolve(),
    exists: (p) => Promise.resolve(d.existing.has(p) || d.files.has(p)),
    sleep(ms) {
      d.clock += ms;
      return Promise.resolve();
    },
    now: () => new Date(d.clock),
    uuid: () => "00000000-0000-4000-8000-000000000001",
    tmpDir: () => "/tmp",
    ...init,
  };
  return d;
}

export interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** A context whose writeResource validates against the model's own schemas. */
export function fakeContext(
  globalArgs: Record<string, unknown> = {},
): GtContext & { written: Written[] } {
  const written: Written[] = [];
  return {
    globalArgs,
    written,
    writeResource(spec, name, data) {
      const resource = (model.resources as Record<
        string,
        { schema: { parse(v: unknown): unknown } }
      >)[spec];
      if (!resource) throw new Error(`unknown resource spec ${spec}`);
      resource.schema.parse(data);
      written.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
  };
}

export function only(
  written: Written[],
  spec: string,
): Record<string, unknown> {
  const hits = written.filter((w) => w.spec === spec);
  if (hits.length !== 1) {
    throw new Error(`expected one ${spec} write, got ${hits.length}`);
  }
  return hits[0].data;
}

/** Extracts the path a render/screenshot eval writes to. */
export function pathIn(code: string, ext: string): string {
  const m = code.match(new RegExp(`'([^']+\\.${ext})'`));
  if (!m) throw new Error(`no .${ext} path in code:\n${code}`);
  return m[1];
}

export async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../../fixtures/${name}`, import.meta.url),
  );
}
