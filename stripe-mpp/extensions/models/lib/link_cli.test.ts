/**
 * Unit tests for the link-cli stdio MCP anti-corruption layer.
 *
 * These exercise callTool()'s envelope handling, boundary redaction, and the
 * leading-dash argument guard against an INJECTED transport — no subprocess is
 * spawned, so the suite stays offline. The default Deno.Command stdio transport
 * (initialize handshake, serverInfo.version preflight, id correlation, clearEnv
 * spawn) is covered by the opt-in live e2e (blocked: US-only Link).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  _resetMcpTransport,
  _setMcpTransport,
  buildChildEnv,
  callTool,
  LINK_TOOLS,
  type LinkCliConfig,
  type LinkTool,
  type McpResponse,
} from "./link_cli.ts";
import {
  fakeLinkCli,
  innerError,
  innerStream,
  LINK_CLI_0_28_0_TOOLS,
} from "./link_cli_test_helpers.ts";

const CFG: LinkCliConfig = {
  binPath: "/opt/link-cli/link-cli",
  version: "0.28.0",
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
      // spend-request_retrieve is a generator command: incur returns its
      // chunks as a JSON array and the result is the last chunk.
      content: [{ type: "text", text: JSON.stringify([{ id: "lsrq_abc" }]) }],
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

// ---------------------------------------------------------------------------
// link-cli 0.28.0 progressive-discovery protocol: inner tools are reached only
// through call_read_tool / call_write_tool, against a fake server that exposes
// just the four wrapper tools (see link_cli_test_helpers.ts).
// ---------------------------------------------------------------------------

async function withFake<T>(
  fake: ReturnType<typeof fakeLinkCli>,
  fn: () => Promise<T>,
): Promise<T> {
  _setMcpTransport(fake.transport);
  try {
    return await fn();
  } finally {
    _resetMcpTransport();
  }
}

Deno.test("fake server mirrors link-cli 0.28.0: a direct inner call is 'not found'", async () => {
  const fake = fakeLinkCli();
  const resp = await fake.transport(
    { tool: "spend-request_create", args: {} },
    CFG,
  );
  assertEquals(resp.error?.code, -32602);
  assertEquals(resp.error?.message, "Tool spend-request_create not found");
});

Deno.test("every pinned inner tool exists in link-cli 0.28.0", () => {
  for (const name of Object.keys(LINK_TOOLS)) {
    assert(
      (LINK_CLI_0_28_0_TOOLS as readonly string[]).includes(name),
      `${name} is not a link-cli 0.28.0 tool`,
    );
  }
});

Deno.test("callTool routes every inner tool through call_write_tool with { name, arguments }", async () => {
  for (const tool of Object.keys(LINK_TOOLS) as LinkTool[]) {
    const fake = fakeLinkCli();
    const args = { id: "lsrq_abc" };
    await withFake(fake, () => callTool({ tool, args }, CFG, redact));
    assertEquals(fake.wire.length, 1, tool);
    assertEquals(fake.wire[0].tool, "call_write_tool", tool);
    assertEquals(fake.wire[0].args, { name: tool, arguments: args }, tool);
    assertEquals(fake.calls, [{ wrapper: "call_write_tool", tool, args }]);
  }
});

Deno.test("call_read_tool is refused for the reads: link-cli 0.28.0 marks none read-only", async () => {
  // Guards the routing table: if a read were sent via call_read_tool, the
  // real server answers isError "Tool is not read-only".
  const fake = fakeLinkCli();
  for (const name of ["payment-methods_list", "spend-request_retrieve"]) {
    const resp = await fake.transport(
      { tool: "call_read_tool", args: { name, arguments: {} } },
      CFG,
    );
    assertEquals(resp.result?.isError, true);
    assertEquals(
      resp.result?.content?.[0].text,
      JSON.stringify({ error: `Tool is not read-only: ${name}` }),
    );
  }
  assertEquals(fake.calls.length, 0);
});

Deno.test("callTool unwraps a streamed result to its LAST chunk", async () => {
  const fake = fakeLinkCli({
    "spend-request_retrieve": innerStream(
      { id: "lsrq_abc", status: "pending_approval" },
      { id: "lsrq_abc", status: "approved" },
    ),
  });
  const out = await withFake(fake, () =>
    callTool(
      { tool: "spend-request_retrieve", args: { id: "lsrq_abc" } },
      CFG,
      redact,
    ));
  assertEquals(out, { id: "lsrq_abc", status: "approved" });
});

Deno.test("callTool returns a non-streamed result as-is (payment-methods_list array)", async () => {
  const list = [{ id: "csmrpd_1" }, { id: "csmrpd_2" }];
  const fake = fakeLinkCli({ "payment-methods_list": list });
  const out = await withFake(
    fake,
    () => callTool({ tool: "payment-methods_list", args: {} }, CFG, redact),
  );
  assertEquals(out, list);
});

Deno.test("callTool fails closed on an EMPTY stream (a dropped c.error)", async () => {
  const fake = fakeLinkCli({ "spend-request_create": innerStream() });
  await withFake(fake, () =>
    assertRejects(
      () => callTool({ tool: "spend-request_create", args: {} }, CFG, redact),
      Error,
      "returned no result",
    ));
});

Deno.test("callTool fails closed when a streaming tool returns a non-array", async () => {
  stub({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ status: "approved" }) }],
    },
  });
  try {
    await assertRejects(
      () =>
        callTool(
          { tool: "spend-request_retrieve", args: { id: "lsrq_abc" } },
          CFG,
          redact,
        ),
      Error,
      "unexpected result envelope",
    );
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("callTool surfaces the wrapper's {error} message (Unknown tool)", async () => {
  stub({
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ error: "Unknown tool: spend-request_create" }),
      }],
    },
  });
  try {
    await assertRejects(
      () => callTool({ tool: "spend-request_create", args: {} }, CFG, redact),
      Error,
      "link-cli spend-request_create error: Unknown tool: spend-request_create",
    );
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("callTool surfaces an inner validation error's code and message", async () => {
  const fake = fakeLinkCli({
    "spend-request_cancel": innerError(JSON.stringify({
      code: "VALIDATION_ERROR",
      message: "Invalid input: expected string, received undefined",
      fieldErrors: [{ path: "id" }],
    })),
  });
  await withFake(fake, () =>
    assertRejects(
      () => callTool({ tool: "spend-request_cancel", args: {} }, CFG, redact),
      Error,
      "VALIDATION_ERROR: Invalid input",
    ));
});

Deno.test("callTool treats an inner 'Not authenticated' (with CTA) as failure", async () => {
  const fake = fakeLinkCli({
    "spend-request_retrieve": innerError(
      'Not authenticated. Run "link-cli auth login" first.\n\n' +
        "Suggested command:\n  link-cli auth login - Log in to Link",
    ),
  });
  await withFake(fake, () =>
    assertRejects(
      () =>
        callTool(
          { tool: "spend-request_retrieve", args: { id: "lsrq_abc" } },
          CFG,
          redact,
        ),
      Error,
      "Not authenticated",
    ));
});

Deno.test("callTool strips incur's rendered CTA suffix from a success result", async () => {
  stub({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ id: "lsrq_abc", status: "canceled" }) +
          "\n\nSuggested command:\n  link-cli spend-request list",
      }],
    },
  });
  try {
    const out = await callTool(
      { tool: "spend-request_cancel", args: { id: "lsrq_abc" } },
      CFG,
      redact,
    );
    assertEquals(out, { id: "lsrq_abc", status: "canceled" });
  } finally {
    _resetMcpTransport();
  }
});

Deno.test("callTool refuses an inner tool outside the pinned table", async () => {
  const fake = fakeLinkCli();
  await withFake(fake, () =>
    assertRejects(
      () =>
        callTool(
          { tool: "auth_logout" as LinkTool, args: {} },
          CFG,
          redact,
        ),
      Error,
      "not in the pinned tool table",
    ));
  assertEquals(fake.wire.length, 0);
});
