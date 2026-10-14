// =============================================================================
// A stdio MCP server serving the agent's two memory tools, zoom and date, over
// one chat directory. It reads the log without the lock (the log is
// append-only) and reloads it on each call, so it sees what the running turn
// has logged.
//
//   deno run --allow-read=<chatDir> mcp_server.ts <chatDir>
// =============================================================================

import { ChatStore } from "./store.ts";

/** The tools/list payload. */
export const TOOLS = [
  {
    name: "zoom",
    description:
      "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "First message id of the line" },
        n: { type: "integer", description: "Messages the line covers" },
      },
      required: ["id", "n"],
    },
  },
  {
    name: "date",
    description: "The date and time of message id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
];

type Rpc = { id?: number | string; method: string; params?: unknown };

/** Answer one JSON-RPC request, or undefined for a notification. */
export async function handle(
  dir: string,
  req: Rpc,
): Promise<Record<string, unknown> | undefined> {
  if (req.id === undefined) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize":
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "optchat", version: "1" },
      });
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const p = req.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      try {
        const store = await ChatStore.open(dir, { readOnly: true });
        const a = p.arguments ?? {};
        const text = p.name === "zoom"
          ? store.zoom(Number(a.id), Number(a.n))
          : p.name === "date"
          ? store.date(Number(a.id))
          : (() => {
            throw new Error(`unknown tool ${p.name}`);
          })();
        return ok({ content: [{ type: "text", text }] });
      } catch (err) {
        return ok({
          content: [{
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          }],
          isError: true,
        });
      }
    }
    case "ping":
      return ok({});
    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `no method ${req.method}` },
      };
  }
}

async function main(dir: string): Promise<void> {
  const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
    .getReader();
  const enc = new TextEncoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: Rpc;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const res = await handle(dir, req);
      if (res) await Deno.stdout.write(enc.encode(JSON.stringify(res) + "\n"));
    }
  }
}

if (import.meta.main) {
  const dir = Deno.args[0];
  if (!dir) {
    console.error("usage: mcp_server.ts <chatDir>");
    Deno.exit(2);
  }
  await main(dir);
}
