/**
 * Test-only fake of the `link-cli --mcp` stdio server (v0.28.0), injected as
 * the MCP transport. It mirrors the server's PROGRESSIVE-DISCOVERY surface as
 * read from incur 0.7.1 `dist/Mcp.js` (`registerDiscoveryTools`, `callTool`)
 * and observed live over stdio:
 *
 * - only `search_tools`, `get_tool_details`, `call_read_tool` and
 *   `call_write_tool` exist; any other `tools/call` name is a JSON-RPC -32602
 *   "Tool <name> not found" (so a direct `spend-request_create` fails exactly
 *   like the real server);
 * - `call_read_tool` runs only tools annotated `readOnlyHint: true` and
 *   `call_write_tool` only tools that are not — link-cli 0.28.0 annotates none;
 * - an unknown inner name is `isError` `{"error":"Unknown tool: X"}`;
 * - an async-generator command returns its chunks as a JSON array.
 *
 * Deliberately independent of `LINK_TOOLS` in link_cli.ts: it encodes what the
 * server does, so a wrong routing/streaming entry in the client fails a test.
 *
 * @module
 */
import type { McpRequest, McpResponse, McpTransport } from "./link_cli.ts";

/** Inner tools link-cli 0.28.0 reports from `search_tools` (empty query). */
export const LINK_CLI_0_28_0_TOOLS = [
  "approval-policy_retrieve",
  "auth_login",
  "auth_logout",
  "auth_status",
  "auth_upgrade",
  "balances_list",
  "demo",
  "insights_list",
  "insights_list-available-types",
  "mpp_decode",
  "mpp_pay",
  "onboard",
  "payment-methods_add",
  "payment-methods_list",
  "payment-methods_retrieve",
  "payment-methods_update",
  "report",
  "serve",
  "shipping-address_list",
  "sources_list",
  "spend-request_cancel",
  "spend-request_create",
  "spend-request_list",
  "spend-request_request-approval",
  "spend-request_retrieve",
  "spend-request_update",
  "transactions_list",
  "ucp_catalog_search",
  "ucp_checkout_complete",
  "ucp_checkout_create",
  "ucp_checkout_retrieve",
  "user-info_retrieve",
] as const;

/** Commands implemented as async generators (`async *run`) in link-cli 0.28.0
 * among those this model uses: their result is a JSON array of chunks. */
const STREAMING = new Set([
  "spend-request_create",
  "spend-request_retrieve",
  "mpp_pay",
]);

const WRAPPERS = new Set([
  "search_tools",
  "get_tool_details",
  "call_read_tool",
  "call_write_tool",
]);

/** A scripted inner-tool failure (`isError: true`, text as given). */
export interface InnerError {
  __innerError: string;
}
/** Explicit streamed chunks for a generator tool (e.g. `[]`). */
export interface InnerStream {
  __chunks: unknown[];
}
/** What an inner tool returns: a payload, a scripted error, or raw chunks. */
export type InnerRoute = unknown | InnerError | InnerStream;

export const innerError = (text: string): InnerError => ({
  __innerError: text,
});
export const innerStream = (...chunks: unknown[]): InnerStream => ({
  __chunks: chunks,
});

/** One inner-tool execution as the fake server saw it. */
export interface InnerCall {
  wrapper: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeLinkCli {
  transport: McpTransport;
  /** Every wire-level tools/call, including rejected ones. */
  wire: McpRequest[];
  /** Inner tools actually executed (reached through the right wrapper). */
  calls: InnerCall[];
}

function textResult(text: string, isError = false): McpResponse {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build a fake link-cli 0.28.0 server answering `routes` by inner tool name.
 * `readOnly` lists inner tools to treat as `readOnlyHint: true` (none in
 * 0.28.0). A missing route answers `{}`. */
export function fakeLinkCli(
  routes: Record<string, InnerRoute> = {},
  opts: { readOnly?: string[] } = {},
): FakeLinkCli {
  const wire: McpRequest[] = [];
  const calls: InnerCall[] = [];
  const known = new Set<string>(LINK_CLI_0_28_0_TOOLS);
  const readOnly = new Set(opts.readOnly ?? []);

  const transport: McpTransport = (req) => {
    wire.push(req);
    if (!WRAPPERS.has(req.tool)) {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: `Tool ${req.tool} not found` },
      });
    }
    const name = typeof req.args.name === "string" ? req.args.name : "";
    if (req.tool === "search_tools") {
      return Promise.resolve(textResult(JSON.stringify({
        tools: [...known].map((n) => ({ name: n })),
      })));
    }
    if (!known.has(name)) {
      return Promise.resolve(
        textResult(JSON.stringify({ error: `Unknown tool: ${name}` }), true),
      );
    }
    if (req.tool === "get_tool_details") {
      return Promise.resolve(textResult(JSON.stringify({ name })));
    }
    if (req.tool === "call_read_tool" && !readOnly.has(name)) {
      return Promise.resolve(textResult(
        JSON.stringify({ error: `Tool is not read-only: ${name}` }),
        true,
      ));
    }
    if (req.tool === "call_write_tool" && readOnly.has(name)) {
      return Promise.resolve(textResult(
        JSON.stringify({ error: `Tool is read-only: ${name}` }),
        true,
      ));
    }
    const args = isObj(req.args.arguments) ? req.args.arguments : {};
    calls.push({ wrapper: req.tool, tool: name, args });

    const route = routes[name] ?? {};
    if (isObj(route) && typeof route.__innerError === "string") {
      return Promise.resolve(textResult(route.__innerError, true));
    }
    if (isObj(route) && Array.isArray(route.__chunks)) {
      return Promise.resolve(textResult(JSON.stringify(route.__chunks)));
    }
    return Promise.resolve(textResult(
      JSON.stringify(STREAMING.has(name) ? [route] : route),
    ));
  };

  return { transport, wire, calls };
}
