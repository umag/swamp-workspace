/**
 * Adversarial suite: caller input that tries to become Smalltalk, and GT (or
 * whatever answers on its port) sending hostile or malformed responses.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  parseGtProcesses,
  runEval,
  runOpen,
  runScreenshot,
  runStart,
  runTool,
  runView,
} from "./gtoolkit.ts";
import {
  assertIdentifier,
  assertObjectId,
  assertViewSelector,
  bootScript,
  renderViewCode,
  stString,
  windowPngCode,
} from "./lib/smalltalk.ts";
import { McpError, McpUnreachable } from "./lib/mcp.ts";
import {
  evalAnswer,
  fakeContext,
  fakeDeps,
  fakeGt,
  pathIn,
} from "./lib/test_support.ts";

const G = { gtHome: "/opt/gt" };
const OBJ = "abcdefgh12345678";

// ---- injection through arguments

Deno.test("binding names that are not plain identifiers never reach GT", async () => {
  for (
    const name of [
      "a b",
      "x]. Smalltalk quit. [",
      "self",
      "thisContext",
      "1abc",
      "",
      "a'b",
    ]
  ) {
    const gt = fakeGt();
    await assertRejects(
      () =>
        runEval(
          fakeContext(G),
          { code: "1", bindings: { [name]: OBJ } },
          fakeDeps(gt),
        ),
      Error,
      "binding name",
    );
    assertEquals(gt.evals, [], name);
  }
});

Deno.test("object ids with quotes, spaces or code are refused before any request", async () => {
  for (
    const id of [
      "abc'def12",
      "abcdefgh ; x",
      "ABCDEFGH1234",
      "short",
      "a".repeat(65),
    ]
  ) {
    const gt = fakeGt();
    await assertRejects(() =>
      runView(
        fakeContext(G),
        { objectId: id, view: "gtItemsFor:" },
        fakeDeps(gt),
      )
    );
    assertEquals(gt.requests, [], id);
  }
});

Deno.test("view selectors that are not one-argument keywords are refused", () => {
  for (
    const sel of [
      "gtItemsFor: x",
      "gtItemsFor:foo:",
      "gtItems",
      "#gtItemsFor:",
      "gtItemsFor:]. Smalltalk quit",
    ]
  ) {
    assertThrows(() => assertViewSelector(sel), Error, "keyword selector", sel);
  }
  assertEquals(assertViewSelector("gtItemsFor:"), "gtItemsFor:");
});

Deno.test("a selector-looking view argument with a payload is refused, not looked up by title", async () => {
  const gt = fakeGt();
  await assertRejects(() =>
    runOpen(fakeContext(G), {
      objectId: OBJ,
      view: "x]. Smalltalk quit. [ #a:",
      index: 1,
    }, fakeDeps(gt))
  );
  assertEquals(gt.evals, []);
});

Deno.test("window titles and paths are quoted literals: a quote cannot close the string", () => {
  const code = windowPngCode("it' , (Smalltalk quit) , '", "/tmp/a'b.png");
  assertStringIncludes(
    code,
    "includesSubstring: 'it'' , (Smalltalk quit) , '''",
  );
  assertStringIncludes(code, "fileName: '/tmp/a''b.png'");
});

Deno.test("stString refuses NUL, doubles every quote", () => {
  assertThrows(() => stString("a\u0000b"), Error, "NUL");
  assertEquals(stString("''"), "''''''");
});

Deno.test("reserved words and oversized names are not identifiers", () => {
  for (const n of ["nil", "true", "false", "super", "a".repeat(65)]) {
    assertThrows(() => assertIdentifier(n));
  }
  assertThrows(() => assertObjectId("abc"));
});

Deno.test("numeric arguments are integers in range before they are spliced into code", () => {
  assertThrows(
    () => renderViewCode("gtItemsFor:", 0, 10, "/tmp/x"),
    Error,
    "start",
  );
  assertThrows(
    () => renderViewCode("gtItemsFor:", 1, 1.5, "/tmp/x"),
    Error,
    "count",
  );
  assertThrows(() => bootScript(0, false), Error, "port");
});

Deno.test("screenshot window title with a quote travels as a literal to GT", async () => {
  const gt = fakeGt();
  const deps = fakeDeps(gt);
  gt.onEval = (
    c,
  ) => (deps.files.set(pathIn(c.code, "png"), "P"),
    evalAnswer("ByteString", "'w'"));
  await runScreenshot(fakeContext(G), { window: "a'b" }, deps);
  assertStringIncludes(gt.evals[0].code, "includesSubstring: 'a''b'");
});

// ---- hostile / malformed responses

Deno.test("connection refused → McpUnreachable naming the URL", async () => {
  const gt = fakeGt({ up: false });
  const err = await assertRejects(
    () => runEval(fakeContext(G), { code: "1" }, fakeDeps(gt)),
    McpUnreachable,
  );
  assertStringIncludes(err.message, "http://127.0.0.1:4747/");
});

Deno.test("an HTML page on the port (not GT) → McpError, not a crash", async () => {
  const gt = fakeGt({
    rawNext: {
      status: 200,
      body: "<html>hello</html>",
      contentType: "text/html",
    },
  });
  await assertRejects(
    () => runTool(fakeContext(G), { name: "x" }, fakeDeps(gt)),
    McpError,
    "invalid JSON",
  );
});

Deno.test("HTTP 500 → McpError with status", async () => {
  const gt = fakeGt({ rawNext: { status: 500, body: "boom" } });
  await assertRejects(
    () => runTool(fakeContext(G), { name: "x" }, fakeDeps(gt)),
    McpError,
    "HTTP 500",
  );
});

Deno.test("JSON-RPC error and result-less replies are errors", async () => {
  const gt = fakeGt({
    rawNext: {
      status: 200,
      body:
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}',
    },
  });
  const err = await assertRejects(
    () => runTool(fakeContext(G), { name: "x" }, fakeDeps(gt)),
    McpError,
  );
  assertEquals(err.code, -32602);
  const gt2 = fakeGt({
    rawNext: { status: 200, body: '{"jsonrpc":"2.0","id":1}' },
  });
  await assertRejects(
    () => runTool(fakeContext(G), { name: "x" }, fakeDeps(gt2)),
    McpError,
    "without a result",
  );
  const gt3 = fakeGt({ rawNext: { status: 200, body: "[1,2]" } });
  await assertRejects(
    () => runTool(fakeContext(G), { name: "x" }, fakeDeps(gt3)),
    McpError,
    "non-object",
  );
});

Deno.test("an event-stream reply is read from its last data line", async () => {
  const body =
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n';
  const gt = fakeGt({
    rawNext: { status: 200, body, contentType: "text/event-stream" },
  });
  const ctx = fakeContext(G);
  await runTool(ctx, { name: "x" }, fakeDeps(gt));
  assertEquals(ctx.written[0].data.text, "hi");
});

Deno.test("an eval answer that is not JSON is recorded as a failed evaluation", async () => {
  const gt = fakeGt();
  gt.onEval = () => "not json at all";
  const ctx = fakeContext(G);
  await runEval(ctx, { code: "1" }, fakeDeps(gt));
  const e = ctx.written[0].data;
  assertEquals(e.ok, false);
  assertStringIncludes(
    String((e.error as { reason: string }).reason),
    "unparseable",
  );
});

Deno.test("a rendered view file that is garbage fails loudly and is still removed", async () => {
  const gt = fakeGt();
  const deps = fakeDeps(gt);
  gt.onEval = (c) => {
    if (c.code.includes(".json")) {
      deps.files.set(pathIn(c.code, "json"), "{{{not json");
    }
    return evalAnswer("ByteString", "'ok'");
  };
  await assertRejects(() =>
    runView(fakeContext(G), { objectId: OBJ, view: "gtItemsFor:" }, deps)
  );
  assertEquals(deps.files.size, 0);
});

Deno.test("process list: commands that merely mention GlamorousToolkit are not GT", () => {
  const ps = [
    "  10 /opt/gt/GlamorousToolkit.app/Contents/MacOS/GlamorousToolkit-cli --interactive img",
    "  11 grep GlamorousToolkit",
    "  12 /usr/bin/swamp model method run gt start --global-arg gtHome=/opt/GlamorousToolkit",
    "  13 /bin/zsh -c open /Applications/GlamorousToolkit.app",
    "garbage line without pid GlamorousToolkit",
  ].join("\n");
  assertEquals(parseGtProcesses(ps).map((p) => p.pid), [10]);
});

Deno.test("start: gtHome with a quote goes to the cli as one argv element, never through a shell", async () => {
  const home = "/opt/it's gt";
  const gt = fakeGt({ up: false });
  const deps = fakeDeps(gt, {
    existing: new Set([
      `${home}/GlamorousToolkit.image`,
      `${home}/bin/GlamorousToolkit-cli`,
    ]),
  });
  deps.sleep = () => ((gt.up = true), Promise.resolve());
  await runStart(fakeContext({ gtHome: home }), {}, deps);
  assertEquals(deps.spawned[0].args[1], `${home}/GlamorousToolkit.image`);
  assert(!deps.spawned[0].cmd.includes(" -c "));
});
