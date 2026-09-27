/**
 * A minimal MCP (JSON-RPC over HTTP POST) client for Glamorous Toolkit's
 * built-in server (GtLMcpServer). Transport is an injectable `fetch`, so tests
 * never open a socket.
 */
import { parseLenientJson } from "./json.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface McpEndpoint {
  url: string;
  timeoutMs: number;
  fetch: Fetch;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** GT is not listening (connection refused, reset, timeout). */
export class McpUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUnreachable";
  }
}

let nextId = 1;

export async function rpc(
  ep: McpEndpoint,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const id = nextId++;
  let res: Response;
  try {
    res = await ep.fetch(ep.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(ep.timeoutMs),
    });
  } catch (err) {
    throw new McpUnreachable(
      `GT MCP server at ${ep.url} is not reachable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const body = await res.text();
  if (!res.ok) {
    throw new McpError(`HTTP ${res.status} from GT: ${body.slice(0, 300)}`);
  }
  const message = parseMessage(body, res.headers.get("content-type") ?? "");
  if (!isObject(message)) {
    throw new McpError(`GT answered with a non-object: ${body.slice(0, 200)}`);
  }
  if (isObject(message.error)) {
    const e = message.error;
    throw new McpError(
      `GT MCP error ${e.code}: ${e.message}`,
      typeof e.code === "number" ? e.code : undefined,
      e.data,
    );
  }
  if (!("result" in message)) {
    throw new McpError(`GT answered without a result: ${body.slice(0, 200)}`);
  }
  return message.result;
}

/** A JSON body, or the last `data:` event of an SSE body. */
function parseMessage(body: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const events = body.split("\n").filter((l) => l.startsWith("data:"));
    const last = events.at(-1);
    if (!last) throw new McpError("GT sent an event stream with no data");
    return parseLenientJson(last.slice(5).trim());
  }
  try {
    return parseLenientJson(body);
  } catch {
    throw new McpError(`GT answered with invalid JSON: ${body.slice(0, 200)}`);
  }
}

export interface ToolInfo {
  name: string;
  description: string;
  arguments: string[];
}

export async function listTools(ep: McpEndpoint): Promise<ToolInfo[]> {
  const result = await rpc(ep, "tools/list");
  const tools = isObject(result) && Array.isArray(result.tools)
    ? result.tools
    : [];
  return tools.filter(isObject).map((t) => ({
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    arguments: isObject(t.inputSchema) && isObject(t.inputSchema.properties)
      ? Object.keys(t.inputSchema.properties)
      : [],
  }));
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  /** The text parsed as JSON, when it is JSON (GT tools answer JSON). */
  json?: unknown;
}

export async function callTool(
  ep: McpEndpoint,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await rpc(ep, "tools/call", { name, arguments: args });
  const content = isObject(result) && Array.isArray(result.content)
    ? result.content
    : [];
  const text = content
    .filter(isObject)
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n");
  let json: unknown;
  try {
    json = parseLenientJson(text);
  } catch {
    json = undefined;
  }
  return { isError: isObject(result) && result.isError === true, text, json };
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  protocolVersion: string;
}

export async function initialize(ep: McpEndpoint): Promise<ServerInfo> {
  const result = await rpc(ep, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "swamp-gtoolkit", version: "1" },
  });
  const r = isObject(result) ? result : {};
  const info = isObject(r.serverInfo) ? r.serverInfo : {};
  return {
    name: String(info.name ?? ""),
    title: String(info.title ?? ""),
    version: String(info.version ?? ""),
    protocolVersion: String(r.protocolVersion ?? ""),
  };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
