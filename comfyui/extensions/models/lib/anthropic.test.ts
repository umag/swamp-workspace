import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { claudeComplete } from "./anthropic.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

Deno.test("claudeComplete posts to the Messages API and concatenates text blocks", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return Promise.resolve(
      jsonResponse({
        content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
      }),
    );
  };
  const out = await claudeComplete("hi", {
    apiKey: "sk-test",
    model: "claude-x",
    system: "sys",
    fetchImpl: fakeFetch as typeof fetch,
  });
  assertEquals(out, "hello world");
  assertStringIncludes(captured!.url, "api.anthropic.com/v1/messages");
  const headers = captured!.init.headers as Record<string, string>;
  assertEquals(headers["x-api-key"], "sk-test");
  assertEquals(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(captured!.init.body as string);
  assertEquals(body.model, "claude-x");
  assertEquals(body.system, "sys");
  assertEquals(body.messages[0].content, "hi");
});

Deno.test("claudeComplete throws on a non-2xx response", async () => {
  const fakeFetch = () => Promise.resolve(new Response("bad key", { status: 401 }));
  await assertRejects(
    () => claudeComplete("hi", { apiKey: "x", model: "m", fetchImpl: fakeFetch as typeof fetch }),
    Error,
    "401",
  );
});

Deno.test("claudeComplete uses OAuth Bearer auth for a sk-ant-oat token", async () => {
  let captured: RequestInit = {};
  const fakeFetch = (_url: string | URL | Request, init?: RequestInit) => {
    captured = init ?? {};
    return Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  };
  await claudeComplete("hi", {
    apiKey: "sk-ant-oat01-secret",
    model: "claude-x",
    system: "sys",
    fetchImpl: fakeFetch as typeof fetch,
  });
  const headers = captured.headers as Record<string, string>;
  assertEquals(headers["authorization"], "Bearer sk-ant-oat01-secret");
  assertEquals(headers["anthropic-beta"], "oauth-2025-04-20");
  assertEquals(headers["x-api-key"], undefined);
  const body = JSON.parse(captured.body as string);
  assertEquals(body.system[0].text.startsWith("You are Claude Code"), true);
  assertEquals(body.system[1].text, "sys");
});
