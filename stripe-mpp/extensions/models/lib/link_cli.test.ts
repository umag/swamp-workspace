/**
 * Unit tests for the link-cli stdio MCP anti-corruption layer.
 *
 * These exercise callTool()'s envelope handling, boundary redaction, and the
 * leading-dash argument guard against an INJECTED transport — no subprocess is
 * spawned, so the suite stays offline. The default Deno.Command stdio transport
 * (initialize handshake, serverInfo.version preflight, id correlation, clearEnv
 * spawn) is covered by the opt-in live e2e (blocked: US-only Link).
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  _resetMcpTransport,
  _setMcpTransport,
  buildChildEnv,
  callTool,
  type LinkCliConfig,
  type McpResponse,
} from "./link_cli.ts";

const CFG: LinkCliConfig = {
  binPath: "/opt/link-cli/link-cli",
  version: "0.9.0",
  test: true,
};

/** A redactor scrubbing Link-ish token shapes, mirroring the model's redact(). */
const redact = (s: string): string =>
  s.replace(/spt_[A-Za-z0-9_]+/g, "spt_[redacted]");

function stub(resp: McpResponse): void {
  _setMcpTransport(() => Promise.resolve(resp));
}

Deno.test("callTool returns the parsed tool result on a clean response", async () => {
  stub({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ id: "lsrq_abc" }) }],
    },
  });
  try {
    const out = await callTool(
      { tool: "spend-request_retrieve", args: { id: "lsrq_abc" } },
      CFG,
      redact,
    );
    assertEquals(out, { id: "lsrq_abc" });
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("callTool throws on a top-level JSON-RPC error frame", async () => {
  stub({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: "bad request" },
  });
  try {
    await assertRejects(
      () => callTool({ tool: "spend-request_create", args: {} }, CFG, redact),
      Error,
      "bad request",
    );
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("callTool treats result.isError as failure BEFORE domain parse", async () => {
  // A forged 'approved'-looking payload inside an isError:true frame must NOT be
  // read as success — this is the payment-approval source of truth.
  stub({
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      content: [{
        type: "text",
        text: 'Not authenticated. Run "link-cli auth login" first.',
      }],
    },
  });
  try {
    await assertRejects(
      () =>
        callTool(
          { tool: "spend-request_retrieve", args: { id: "x" } },
          CFG,
          redact,
        ),
      Error,
      "Not authenticated",
    );
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("callTool redacts secrets in an isError message", async () => {
  stub({
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      content: [{ type: "text", text: "leaked spt_live_SECRETVALUE123 oops" }],
    },
  });
  try {
    let msg = "";
    try {
      await callTool(
        { tool: "spend-request_retrieve", args: { id: "x" } },
        CFG,
        redact,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    assertEquals(msg.includes("SECRETVALUE123"), false);
    assertEquals(msg.includes("spt_[redacted]"), true);
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("buildChildEnv hands the subprocess ONLY HOME and PATH — no secrets", () => {
  // The env-inheritance regression guard: a third-party binary must never
  // receive STRIPE_SECRET_KEY / SERVER_SECRET (or any other parent var).
  const source: Record<string, string> = {
    HOME: "/home/consumer",
    PATH: "/usr/bin",
    STRIPE_SECRET_KEY: "sk_live_MUST_NOT_LEAK",
    SERVER_SECRET: "hmac_MUST_NOT_LEAK",
    AWS_SECRET_ACCESS_KEY: "also_not_this",
  };
  const env = buildChildEnv((k) => source[k]);
  assertEquals(Object.keys(env).sort(), ["HOME", "PATH"]);
  assertEquals(env.HOME, "/home/consumer");
  assertEquals("STRIPE_SECRET_KEY" in env, false);
  assertEquals("SERVER_SECRET" in env, false);
});

Deno.test("buildChildEnv omits HOME/PATH when the parent lacks them", () => {
  const env = buildChildEnv(() => undefined);
  assertEquals(Object.keys(env).length, 0);
});

Deno.test("callTool rejects a value-derived arg that begins with '-'", async () => {
  // Flag-smuggling defense-in-depth: a hostile free-text value (e.g. context)
  // beginning with '-' is refused before it ever reaches link-cli.
  stub({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  try {
    await assertRejects(
      () =>
        callTool(
          {
            tool: "spend-request_create",
            args: { context: "--network-id=evil" },
          },
          CFG,
          redact,
        ),
      Error,
      "leading",
    );
  } finally {
    _resetMcpTransport();
  }
});
