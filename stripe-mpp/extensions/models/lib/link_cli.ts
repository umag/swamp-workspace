/**
 * Anti-corruption layer over the Stripe `link-cli` binary, spoken as an MCP
 * server over STDIO (`link-cli --mcp`), NOT its HTTP `serve` mode.
 *
 * WHY STDIO, NOT `serve`: the spike (stripe-mpp/SPIKE-link-cli.md) observed that
 * `link-cli serve` binds `*:54321` (all interfaces), sends
 * `Access-Control-Allow-Origin: *`, and requires NO authentication on `/mcp` —
 * so any local process, LAN host, or visited web page could drive the
 * consumer's authenticated wallet. Stdio opens no socket: the model spawns a
 * private parent<->child pipe, one tool call per method execution.
 *
 * WHY BY REFERENCE: link-cli never hands back a raw `spt_` for the SPT flow; the
 * granted credential is referenced by its spend-request id (`lsrq_`) and spent
 * via the `mpp_pay` tool. So this model holds no bearer credential — only the
 * `lsrq_` identifier — and never holds Link session tokens (link-cli owns its
 * device-flow session on disk).
 *
 * TRUST: `binPath` MUST be an absolute path installed to a non-writable
 * location (the caller enforces this) — spawning by absolute path means a
 * PATH-shadowing binary cannot hijack which executable runs. The
 * `serverInfo.version` check in the default transport is DRIFT DETECTION, not an
 * integrity guarantee (a shadow binary can spoof it). The subprocess is spawned
 * with `clearEnv` so it never inherits STRIPE_SECRET_KEY / SERVER_SECRET.
 *
 * @module
 */

/** A JSON-RPC 2.0 response envelope from the MCP server. */
export interface McpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [k: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

/** One MCP `tools/call` on the wire. `args` are passed as JSON — never as argv —
 * so a value can never be re-parsed as a flag at this boundary. Since the
 * progressive-discovery protocol (see {@link LINK_TOOLS}), `tool` is always one
 * of the wrapper tools and `args` is `{ name, arguments }`. */
export interface McpRequest {
  tool: string;
  args: Record<string, unknown>;
}

/** The link-cli wrapper tools that execute an inner tool. */
export type McpWrapperTool = "call_read_tool" | "call_write_tool";

/**
 * How link-cli 0.28.0 exposes the operations this model uses.
 *
 * link-cli is built on `incur`, whose stdio MCP server defaults to
 * PROGRESSIVE DISCOVERY (incur/dist/Mcp.js `registerTools`, `discovery ??
 * 'progressive'`; link-cli sets no `mcp.tools` override). `tools/list` returns
 * only four wrapper tools — `search_tools`, `get_tool_details`,
 * `call_read_tool`, `call_write_tool` — and a direct `tools/call` of an inner
 * name fails with JSON-RPC -32602 "Tool spend-request_create not found".
 *
 * An inner tool is executed as `tools/call { name: <wrapper>, arguments: { name:
 * <inner>, arguments: {...} } }`. The wrapper is chosen by the inner tool's
 * `readOnlyHint` annotation: `call_read_tool` refuses any tool without
 * `readOnlyHint: true` ("Tool is not read-only: X") and `call_write_tool`
 * refuses any tool with it ("Tool is read-only: X"). link-cli 0.28.0 annotates
 * NONE of its commands (get_tool_details returns no `annotations` for any of
 * them), so even the reads (`payment-methods_list`, `spend-request_retrieve`)
 * are only callable through `call_write_tool`. The strict serverInfo.version
 * check is what keeps this table honest: a link-cli that starts annotating
 * reads must be re-pinned here, not silently mis-routed.
 *
 * `streaming`: the command is an async generator in link-cli. incur buffers its
 * yielded chunks and returns them as a JSON ARRAY (`[chunk, ...]`), so the
 * result is the LAST chunk. A generator that ends with `return c.error(...)`
 * (e.g. NOT_FOUND, POLLING_TIMEOUT, a duplicate spend request) yields nothing,
 * and incur reports that as a SUCCESSFUL `[]` — so an empty stream is a
 * failure, never an empty success.
 */
export const LINK_TOOLS = {
  "payment-methods_list": { wrapper: "call_write_tool", streaming: false },
  "spend-request_create": { wrapper: "call_write_tool", streaming: true },
  "spend-request_retrieve": { wrapper: "call_write_tool", streaming: true },
  "spend-request_cancel": { wrapper: "call_write_tool", streaming: false },
  "mpp_pay": { wrapper: "call_write_tool", streaming: true },
  "report": { wrapper: "call_write_tool", streaming: false },
} as const satisfies Record<
  string,
  { wrapper: McpWrapperTool; streaming: boolean }
>;

/** A link-cli inner tool this model invokes. */
export type LinkTool = keyof typeof LINK_TOOLS;

/** One link-cli operation: the inner tool and its own arguments. */
export interface LinkToolRequest {
  tool: LinkTool;
  args: Record<string, unknown>;
}

export interface LinkCliConfig {
  /** Absolute path to the link-cli binary (caller-validated, non-PATH). */
  binPath: string;
  /** Pinned version the default transport asserts against serverInfo.version. */
  version: string;
  /** Testmode flag (derived from allowLiveGrants; never from caller args). */
  test: boolean;
  /** Per-call subprocess timeout; defaults to 60s. */
  timeoutMs?: number;
}

/** Performs ONE MCP tool call and returns the raw JSON-RPC response. The default
 * spawns the subprocess; tests inject a fake via {@link _setMcpTransport}. */
export type McpTransport = (
  req: McpRequest,
  cfg: LinkCliConfig,
) => Promise<McpResponse>;

let _transport: McpTransport = defaultStdioTransport;

/** Test seam: swap the transport (ESM-valid — a module-local reassignment, not
 * an imported-binding write). Tests restore via {@link _resetMcpTransport}. This
 * is process-global mutable state; do not run these tests with `--parallel`. */
export function _setMcpTransport(t: McpTransport): void {
  _transport = t;
}
export function _resetMcpTransport(): void {
  _transport = defaultStdioTransport;
}

/** Extract the concatenated text of an MCP tool result's content blocks. */
function contentText(resp: McpResponse): string {
  return (resp.result?.content ?? []).map((c) => c.text ?? "").join("");
}

/** Parse a tool result's text as JSON. incur appends a rendered call-to-action
 * after a blank line (`<json>\n\nSuggested command: ...`) when a command
 * returns one; its JSON is compact (no raw newlines), so the JSON is the part
 * before the first blank line. `undefined` when neither parses. */
function parseResultText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch { /* fall through: maybe a CTA suffix */ }
  const cut = text.indexOf("\n\n");
  if (cut > 0) {
    try {
      return JSON.parse(text.slice(0, cut));
    } catch { /* not JSON */ }
  }
  return undefined;
}

/** The human message of an `isError` result: the wrapper's `{"error": ...}`,
 * an inner validation error's `{"message": ...}`, or the raw text. */
function errorMessage(text: string): string {
  const parsed = parseResultText(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (typeof o.error === "string") return o.error;
    if (typeof o.message === "string") {
      return typeof o.code === "string" ? `${o.code}: ${o.message}` : o.message;
    }
  }
  return text;
}

/**
 * Invoke a link-cli inner tool THROUGH its wrapper (see {@link LINK_TOOLS}) and
 * return the inner tool's parsed JSON payload, or throw a REDACTED error.
 * Envelope handling happens BEFORE any domain parse: a top-level JSON-RPC
 * `error`, a tool-level `isError: true` (a 2xx-shaped failure — e.g. "Not
 * authenticated", or the wrapper's "Unknown tool" / "Tool is not read-only"),
 * or an empty stream is a failure, never a success. That matters because the
 * tool result is the source of truth for whether a human approved a payment.
 */
export async function callTool(
  req: LinkToolRequest,
  cfg: LinkCliConfig,
  redactFn: (s: string) => string,
): Promise<unknown> {
  const spec = Object.hasOwn(LINK_TOOLS, req.tool)
    ? LINK_TOOLS[req.tool]
    : undefined;
  if (!spec) {
    throw new Error(
      redactFn(`link-cli tool "${req.tool}" is not in the pinned tool table.`),
    );
  }

  // Flag-smuggling defense-in-depth: refuse any string value that begins with
  // '-' so it can never be re-tokenized as a flag if link-cli re-expands params
  // server-side (an unverifiable internal — US-only Link). Anchored id patterns
  // are enforced separately at the model boundary.
  for (const [k, v] of Object.entries(req.args)) {
    if (typeof v === "string" && v.startsWith("-")) {
      throw new Error(
        redactFn(
          `link-cli arg "${k}" has a leading '-' — refusing a value that ` +
            "could be parsed as a flag.",
        ),
      );
    }
  }

  const resp = await _transport(
    { tool: spec.wrapper, args: { name: req.tool, arguments: req.args } },
    cfg,
  );

  if (resp.error) {
    throw new Error(
      redactFn(`link-cli ${req.tool} failed: ${resp.error.message}`),
    );
  }

  const text = contentText(resp);
  if (resp.result?.isError) {
    throw new Error(
      redactFn(`link-cli ${req.tool} error: ${errorMessage(text)}`),
    );
  }

  const parsed = text ? parseResultText(text) : undefined;

  if (spec.streaming) {
    // A generator command's chunks come back as a JSON array; its result is
    // the last chunk. `[]` means it ended via c.error, which incur drops.
    if (!Array.isArray(parsed)) {
      throw new Error(
        redactFn(
          `link-cli ${req.tool} returned an unexpected result envelope ` +
            "(expected a JSON array of streamed chunks).",
        ),
      );
    }
    if (parsed.length === 0) {
      throw new Error(
        `link-cli ${req.tool} returned no result — the command ended with an ` +
          "error that the MCP server does not report (e.g. not found, polling " +
          "timeout, or a duplicate spend request).",
      );
    }
    return parsed[parsed.length - 1];
  }

  if (!text) return {};
  // Some tools emit plain text rather than JSON; hand it back redacted.
  return parsed === undefined ? redactFn(text) : parsed;
}

// ============================================================================
// Default stdio transport (real subprocess).
//
// NOT exercised by the offline suite — tests inject a fake transport. Covered by
// the opt-in live e2e (blocked: US-only Link, EU maintainer). It performs the
// MCP handshake, asserts serverInfo.version (drift detection), issues one
// tools/call, correlates the response by id, and reaps the child.
// ============================================================================

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

/** Hard ceiling on link-cli stdout, so a runaway payload cannot exhaust memory
 * before the wall-clock timeout fires. */
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024; // 8 MB

/** Build the clearEnv allowlist for the link-cli subprocess. Exported + pure so
 * the secret-exclusion invariant is unit-testable: the child gets ONLY HOME and
 * PATH — never STRIPE_SECRET_KEY / SERVER_SECRET or any other parent var.
 *
 * HOME is required (link-cli reads its device-flow session from the config dir
 * under HOME). PATH is passed through so a node CLI can resolve its runtime;
 * this is a DELIBERATE, accepted deviation from the plan's "PATH out" note —
 * the top-level binary is spawned by absolute path so PATH cannot hijack WHICH
 * executable runs, and the residual (a poisoned entry reaching link-cli's own
 * sub-processes) is covered by the documented single-user-host deployment
 * boundary. */
export function buildChildEnv(
  get: (k: string) => string | undefined = (k) => Deno.env.get(k),
): Record<string, string> {
  const env: Record<string, string> = {};
  const home = get("HOME");
  const path = get("PATH");
  if (home) env.HOME = home;
  if (path) env.PATH = path;
  return env;
}

/** Read a stream up to `max` bytes; report overflow rather than truncating. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ data: Uint8Array; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > max) {
        overflow = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.byteLength;
  }
  return { data, overflow };
}

async function defaultStdioTransport(
  req: McpRequest,
  cfg: LinkCliConfig,
): Promise<McpResponse> {
  const command = new Deno.Command(cfg.binPath, {
    args: ["--mcp"],
    clearEnv: true,
    env: buildChildEnv(),
    stdin: "piped",
    stdout: "piped",
    // Dropped, not piped: an unread pipe could block the child, and raw stderr
    // is the most likely place a token would surface — never read it.
    stderr: "null",
  });

  const child = command.spawn();
  const timeout = cfg.timeoutMs ?? 60_000;
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeout);

  try {
    const writer = child.stdin.getWriter();
    // MCP stdio is newline-delimited JSON-RPC.
    await writer.write(encode({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "swamp-stripe-mpp", version: "1" },
      },
    }));
    await writer.write(encode({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));
    // Args are passed verbatim as JSON — never as argv. `req` is already the
    // wrapper call (`call_*_tool { name, arguments }`, built by callTool). The
    // `test` flag is NOT injected here; the caller adds it only to
    // spend-request creation, derived from allowLiveGrants.
    await writer.write(encode({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: req.tool, arguments: req.args },
    }));
    await writer.close();

    // Bounded read: cap stdout so a malfunctioning/hostile link-cli streaming a
    // runaway payload cannot exhaust the model process (the timeout bounds
    // wall-clock, not peak memory). Overflow is a hard failure, never a
    // truncate-and-parse.
    const { data, overflow } = await readCapped(child.stdout, MAX_STDOUT_BYTES);
    if (overflow) {
      child.kill("SIGKILL");
      throw new Error(
        `link-cli produced more than ${MAX_STDOUT_BYTES} bytes on stdout — ` +
          "refusing to parse a runaway/truncated response.",
      );
    }
    await child.status;
    const lines = new TextDecoder().decode(data)
      .split("\n")
      .filter((l) => l.trim().length > 0);

    let init: McpResponse | undefined;
    let call: McpResponse | undefined;
    for (const line of lines) {
      let msg: McpResponse;
      try {
        msg = JSON.parse(line) as McpResponse;
      } catch {
        continue;
      }
      if (msg.id === 0) init = msg;
      else if (msg.id === 1) call = msg;
    }

    const reportedVersion =
      (init?.result as { serverInfo?: { version?: string } } | undefined)
        ?.serverInfo?.version;
    if (reportedVersion && reportedVersion !== cfg.version) {
      throw new Error(
        `link-cli version drift: server reports ${reportedVersion}, ` +
          `pinned ${cfg.version}. Bump linkCliVersion after re-pinning ` +
          "the contract fixtures.",
      );
    }
    if (!call) {
      throw new Error(
        "link-cli produced no correlated tools/call response — the binary " +
          "may be absent, incompatible, or not the MCP server. Verify " +
          "linkCliPath points at an installed @stripe/link-cli.",
      );
    }
    return call;
  } finally {
    clearTimeout(timer);
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }
}
