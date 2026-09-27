/**
 * Contract suite: pins the model to responses recorded from a real
 * Glamorous Toolkit v1.1.601 MCP server (fixtures/, see PROVENANCE.md).
 * If one of these breaks, GT's wire format changed.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  callTool,
  initialize,
  listTools,
  type McpEndpoint,
  McpError,
} from "./lib/mcp.ts";
import { parseLenientJson } from "./lib/json.ts";
import { flattenView, toEvaluation } from "./gtoolkit.ts";
import { fixture } from "./lib/test_support.ts";

/** An endpoint that always answers with one recorded body. */
async function recorded(name: string): Promise<McpEndpoint> {
  const body = await fixture(name);
  return {
    url: "http://127.0.0.1:4747/",
    timeoutMs: 1000,
    fetch: () =>
      Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      ),
  };
}

const NOW = new Date("2026-09-27T12:00:00Z");

Deno.test("initialize: GT identifies itself and speaks MCP 2025-06-18", async () => {
  const info = await initialize(await recorded("initialize.json"));
  assertEquals(info.title, "Glamorous Toolkit MCP Server");
  assertEquals(info.protocolVersion, "2025-06-18");
});

Deno.test("tools/list: GtLTools gt exposes evaluation, views and object storage", async () => {
  const tools = await listTools(await recorded("tools-list.json"));
  assertEquals(tools.length, 30);
  const byName = new Map(tools.map((t) => [t.name, t]));
  assertEquals(byName.get("smalltalkCodeEvaluation")?.arguments.sort(), [
    "bindings",
    "code",
  ]);
  assertEquals(byName.get("getViewContent")?.arguments.sort(), [
    "objectId",
    "viewSelector",
  ]);
  assert(byName.has("searchForLepiterPages"));
  assert(byName.has("exampleMethodRun"));
});

Deno.test("evaluation of a String: quotes arrive doubled and decode back", async () => {
  const r = await callTool(
    await recorded("eval-string.json"),
    "smalltalkCodeEvaluation",
    {},
  );
  const e = toEvaluation("'it''s' , ' ok'", r.json, r.text, NOW);
  assert(e.ok);
  assertEquals(e.className, "ByteString");
  assertEquals(e.printString, "'it''s ok'");
  assertEquals(e.string, "it's ok");
  assert(/^[a-z0-9]{8,64}$/.test(e.objectId), e.objectId);
});

Deno.test("evaluation error: ZeroDivide reported as not ok, with a stack trace", async () => {
  const r = await callTool(
    await recorded("eval-error.json"),
    "smalltalkCodeEvaluation",
    {},
  );
  const e = toEvaluation("1/0", r.json, r.text, NOW);
  assertEquals(e.ok, false);
  assert(e.error?.message.includes("ZeroDivide"), e.error?.message);
  assert(e.error!.stackTrace.length > 0);
});

Deno.test("syntax error: stack trace with tabs/CRs parses and is reported as not ok", async () => {
  const r = await callTool(
    await recorded("eval-syntax-error.json"),
    "smalltalkCodeEvaluation",
    {},
  );
  const e = toEvaluation("bad", r.json, r.text, NOW);
  assertEquals(e.ok, false);
  assert(
    e.error?.message.includes("SyntaxError") ||
      e.error?.message.includes("CodeError"),
    e.error?.message,
  );
});

Deno.test("evaluation of an object: its Phlow views come back in tab order", async () => {
  const r = await callTool(
    await recorded("eval-object.json"),
    "smalltalkCodeEvaluation",
    {},
  );
  const e = toEvaluation("FileLocator root", r.json, r.text, NOW);
  assertEquals(e.className, "FileReference");
  assertEquals(e.string, null);
  assertEquals(e.views.map((v) => v.title).slice(0, 3), [
    "Tree",
    "Items",
    "Path",
  ]);
  assertEquals(e.views[1].selector, "gtItemsFor:");
});

Deno.test("unknown JSON-RPC method: -32601 surfaces as McpError", async () => {
  const err = await assertRejects(() =>
    callTool(
      {
        url: "x",
        timeoutMs: 1000,
        fetch: async () => new Response(await fixture("unknown-method.json")),
      },
      "x",
      {},
    ), McpError);
  assertEquals(err.code, -32601);
});

Deno.test("rendered columned list: icon column dropped, rows keep their 1-based index", async () => {
  const v = flattenView(
    parseLenientJson(await fixture("view-items.json")),
    "obj1",
    "gtItemsFor:",
    1,
    NOW,
  );
  assertEquals(v.kind, "GtPhlowColumnedListViewSpecification");
  assertEquals(v.title, "Items");
  assertEquals(v.columns, ["Name", "Size", "Creation"]);
  assertEquals(v.rows.length, 3);
  assertEquals(v.rows.map((r) => r.index), [1, 2, 3]);
  assert(v.rows.every((r) => r.cells.length === 3));
  assert(v.total !== null && v.total >= 3);
});

Deno.test("rendered columned tree: same row shape as a list", async () => {
  const v = flattenView(
    parseLenientJson(await fixture("view-tree.json")),
    "obj1",
    "gtTreeFor:",
    1,
    NOW,
  );
  assertEquals(v.kind, "GtPhlowColumnedTreeViewSpecification");
  assert(v.rows.length > 0 && v.rows[0].cells.length > 0);
});

Deno.test("rendered text view: text extracted from the remote text dictionary", async () => {
  const v = flattenView(
    parseLenientJson(await fixture("view-print.json")),
    "obj1",
    "gtPrintFor:",
    1,
    NOW,
  );
  assertEquals(v.kind, "GtPhlowTextEditorViewSpecification");
  assertEquals(v.text, "File @ /");
  assertEquals(v.rows, []);
});
