/**
 * Methods suite: every method's success and failure paths against a fake GT
 * (lib/test_support.ts). Writes are validated against the model's schemas.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  model,
  runEval,
  runInspect,
  runOpen,
  runScreenshot,
  runStart,
  runStatus,
  runStop,
  runTool,
  runTools,
  runView,
} from "./gtoolkit.ts";
import {
  evalAnswer,
  evalError,
  fakeContext,
  fakeDeps,
  fakeGt,
  fixture,
  only,
  pathIn,
} from "./lib/test_support.ts";

const HOME = "/opt/gt";
const G = { gtHome: HOME };
const OBJ = "abcdefgh12345678";

Deno.test("model: every method has a description and arguments schema", () => {
  for (const [name, m] of Object.entries(model.methods)) {
    assert(m.description.length > 20, name);
    assert(typeof m.arguments.parse === "function", name);
  }
});

// ---- status

Deno.test("status: reachable GT → tool count, windows and GT processes", async () => {
  const gt = fakeGt({
    onEval: () => evalAnswer("Array", "#('Glamorous Toolkit' 'a LePage')"),
  });
  const deps = fakeDeps(gt, {
    ps:
      "  80310 /opt/gt/GlamorousToolkit.app/Contents/MacOS/GlamorousToolkit-cli --interactive x\n  11 /usr/bin/swamp model method run gt status\n",
  });
  const ctx = fakeContext(G);
  await runStatus(ctx, deps);
  const s = only(ctx.written, "status");
  assertEquals(s.reachable, true);
  assertEquals(s.toolCount, 2);
  assertEquals(s.windows, ["Glamorous Toolkit", "a LePage"]);
  assertEquals((s.gtProcesses as { pid: number }[]).map((p) => p.pid), [80310]);
});

Deno.test("status: GT down → recorded as unreachable, never throws", async () => {
  const gt = fakeGt({ up: false });
  const ctx = fakeContext(G);
  await runStatus(ctx, fakeDeps(gt));
  const s = only(ctx.written, "status");
  assertEquals(s.reachable, false);
  assertStringIncludes(String(s.error), "not reachable");
});

// ---- start

Deno.test("start: already answering → no spawn, changed false", async () => {
  const gt = fakeGt();
  const deps = fakeDeps(gt);
  const ctx = fakeContext(G);
  await runStart(ctx, {}, deps);
  assertEquals(deps.spawned, []);
  assertEquals(only(ctx.written, "action").changed, false);
});

Deno.test("start: launches the cli with the boot script, then waits until GT answers", async () => {
  const gt = fakeGt({ up: false });
  const deps = fakeDeps(gt, {
    existing: new Set([
      `${HOME}/GlamorousToolkit.image`,
      `${HOME}/GlamorousToolkit.app/Contents/MacOS/GlamorousToolkit-cli`,
    ]),
  });
  let sleeps = 0;
  deps.sleep = (ms) => {
    deps.clock += ms;
    if (++sleeps === 3) gt.up = true; // GT comes up after 3 s
    return Promise.resolve();
  };
  const ctx = fakeContext(G);
  await runStart(ctx, { openWorld: true }, deps);
  assertEquals(deps.spawned.length, 1);
  const { cmd, args, cwd } = deps.spawned[0];
  assertEquals(
    cmd,
    `${HOME}/GlamorousToolkit.app/Contents/MacOS/GlamorousToolkit-cli`,
  );
  assertEquals(args.slice(0, 4), [
    "--interactive",
    `${HOME}/GlamorousToolkit.image`,
    "st",
    "--no-quit",
  ]);
  assertEquals(cwd, HOME);
  const boot = deps.files.get(args[4])!;
  assertStringIncludes(boot, "GtLMcpServer new port: 4747");
  assertStringIncludes(boot, "addTools: GtLTools gt");
  assertStringIncludes(boot, "GtWorld openDefault");
  const a = only(ctx.written, "action");
  assertEquals([a.changed, a.pid], [true, 4242]);
});

Deno.test("start: Linux layout (bin/GlamorousToolkit-cli) is found too", async () => {
  const gt = fakeGt({ up: false });
  const deps = fakeDeps(gt, {
    existing: new Set([
      `${HOME}/GlamorousToolkit.image`,
      `${HOME}/bin/GlamorousToolkit-cli`,
    ]),
  });
  deps.sleep = () => ((gt.up = true), Promise.resolve());
  await runStart(fakeContext(G), {}, deps);
  assertEquals(deps.spawned[0].cmd, `${HOME}/bin/GlamorousToolkit-cli`);
});

Deno.test("start: GT never answers → timeout error naming the pid", async () => {
  const gt = fakeGt({ up: false });
  const deps = fakeDeps(gt, {
    existing: new Set([
      `${HOME}/GlamorousToolkit.image`,
      `${HOME}/bin/GlamorousToolkit-cli`,
    ]),
  });
  const err = await assertRejects(() =>
    runStart(fakeContext(G), { timeoutMs: 5000 }, deps)
  );
  assertStringIncludes((err as Error).message, "pid 4242");
});

Deno.test("start: missing gtHome, image or cli are named errors", async () => {
  const gt = fakeGt({ up: false });
  await assertRejects(
    () => runStart(fakeContext({}), {}, fakeDeps(gt)),
    Error,
    "gtHome is not set",
  );
  await assertRejects(
    () => runStart(fakeContext(G), {}, fakeDeps(gt)),
    Error,
    "no GT image",
  );
  const deps = fakeDeps(gt, {
    existing: new Set([`${HOME}/GlamorousToolkit.image`]),
  });
  await assertRejects(
    () => runStart(fakeContext(G), {}, deps),
    Error,
    "no GlamorousToolkit-cli",
  );
});

Deno.test("start: the image already runs without MCP → refuse, hand over the boot snippet", async () => {
  const gt = fakeGt({ up: false });
  const deps = fakeDeps(gt, {
    existing: new Set([`${HOME}/GlamorousToolkit.image`]),
    ps:
      `  900 ${HOME}/GlamorousToolkit.app/Contents/MacOS/GlamorousToolkit ${HOME}/GlamorousToolkit.image\n`,
  });
  const err = await assertRejects(() => runStart(fakeContext(G), {}, deps));
  assertStringIncludes((err as Error).message, "pid 900");
  assertStringIncludes((err as Error).message, "GtLMcpServer new port: 4747");
  assertEquals(deps.spawned, []);
});

// ---- stop

Deno.test("stop: GT down → recorded no-op", async () => {
  const ctx = fakeContext(G);
  await runStop(ctx, {}, fakeDeps(fakeGt({ up: false })));
  assertEquals(only(ctx.written, "action").changed, false);
});

Deno.test("stop: forks a quit with the save flag, waits until GT stops answering", async () => {
  const gt = fakeGt();
  gt.onEval = () => ((gt.up = false), evalAnswer("ByteString", "'quitting'"));
  const ctx = fakeContext(G);
  await runStop(ctx, { save: true }, fakeDeps(gt));
  assertStringIncludes(
    gt.evals[0].code,
    "Smalltalk snapshot: true andQuit: true",
  );
  assertStringIncludes(gt.evals[0].code, "] fork");
  const a = only(ctx.written, "action");
  assertEquals(a.changed, true);
  assertStringIncludes(String(a.detail), "after saving");
});

Deno.test("stop: GT keeps answering → error", async () => {
  const gt = fakeGt({ onEval: () => evalAnswer("ByteString", "'quitting'") });
  await assertRejects(
    () => runStop(fakeContext(G), { timeoutMs: 2000 }, fakeDeps(gt)),
    Error,
    "still answering",
  );
});

// ---- eval

Deno.test("eval: code and bindings reach GT; result written as evaluation", async () => {
  const gt = fakeGt({
    onEval: () => evalAnswer("SmallInteger", "7", [["gtPrintFor:", "Print"]]),
  });
  const ctx = fakeContext(G);
  await runEval(ctx, { code: "a + 4", bindings: { a: OBJ } }, fakeDeps(gt));
  assertEquals(gt.evals[0], {
    code: "a + 4",
    bindings: [{ name: "a", objectId: OBJ }],
  });
  const e = only(ctx.written, "evaluation");
  assertEquals([e.ok, e.className, e.printString, e.string], [
    true,
    "SmallInteger",
    "7",
    null,
  ]);
});

Deno.test("eval: bindings may arrive as a JSON string (CLI --input)", async () => {
  const gt = fakeGt();
  await runEval(
    fakeContext(G),
    { code: "a", bindings: `{"a":"${OBJ}"}` },
    fakeDeps(gt),
  );
  assertEquals(gt.evals[0].bindings, [{ name: "a", objectId: OBJ }]);
});

Deno.test("eval: a GT error is recorded (ok false), not thrown", async () => {
  const gt = fakeGt({ onEval: () => evalError("ZeroDivide") });
  const ctx = fakeContext(G);
  await runEval(ctx, { code: "1/0" }, fakeDeps(gt));
  const e = only(ctx.written, "evaluation");
  assertEquals(e.ok, false);
  assertEquals((e.error as { message: string }).message, "ZeroDivide");
});

// ---- view / open

async function renderingGt(viewFixture: string) {
  const body = await fixture(viewFixture);
  const gt = fakeGt();
  const deps = fakeDeps(gt);
  gt.onEval = (call) => {
    if (call.code === "obj") {
      return evalAnswer("FileReference", "File @ /", [["gtTreeFor:", "Tree"], [
        "gtItemsFor:",
        "Items",
      ], ["gtPrintFor:", "Print"]]);
    }
    if (
      call.code.includes("asGtDeclarativeView") && call.code.includes(".json")
    ) {
      deps.files.set(pathIn(call.code, "json"), body);
    }
    return evalAnswer("ByteString", "'ok'");
  };
  return { gt, deps };
}

Deno.test("view: title resolves to its selector; rows come from the rendered file, which is removed", async () => {
  const { gt, deps } = await renderingGt("view-items.json");
  const ctx = fakeContext(G);
  await runView(
    ctx,
    { objectId: OBJ, view: "items", start: 1, count: 3 },
    deps,
  );
  const render = gt.evals[1].code;
  assertStringIncludes(render, "obj perform: #gtItemsFor:");
  assertStringIncludes(
    render,
    "retrieveItems: (3 min: n - 1 + 1) fromIndex: 1",
  );
  const v = only(ctx.written, "view");
  assertEquals([v.selector, v.title, (v.rows as unknown[]).length], [
    "gtItemsFor:",
    "Items",
    3,
  ]);
  assertEquals(deps.files.size, 0);
});

Deno.test("view: empty view argument takes the first tab; a selector skips the lookup", async () => {
  const { gt, deps } = await renderingGt("view-tree.json");
  await runView(fakeContext(G), { objectId: OBJ }, deps);
  assertStringIncludes(gt.evals[1].code, "#gtTreeFor:");
  const direct = await renderingGt("view-print.json");
  const ctx = fakeContext(G);
  await runView(ctx, { objectId: OBJ, view: "gtPrintFor:" }, direct.deps);
  assertEquals(direct.gt.evals.length, 1);
  assertEquals(only(ctx.written, "view").text, "File @ /");
});

Deno.test("view: unknown title lists the available views", async () => {
  const { deps } = await renderingGt("view-items.json");
  await assertRejects(
    () => runView(fakeContext(G), { objectId: OBJ, view: "Nope" }, deps),
    Error,
    "Tree, Items, Print",
  );
});

Deno.test("view: rendering fails in GT → error, not an empty view", async () => {
  const gt = fakeGt({
    onEval: (c) =>
      c.code === "obj"
        ? evalAnswer("X", "x", [["gtAFor:", "A"]])
        : evalError("boom"),
  });
  await assertRejects(
    () => runView(fakeContext(G), { objectId: OBJ }, fakeDeps(gt)),
    Error,
    "rendering failed",
  );
});

Deno.test("open: sends retrieveSentItemAt: with the row index; the new object is the evaluation", async () => {
  const gt = fakeGt({
    onEval: () => evalAnswer("FileReference", "File @ /Applications"),
  });
  const ctx = fakeContext(G);
  await runOpen(
    ctx,
    { objectId: OBJ, view: "gtItemsFor:", index: 5 },
    fakeDeps(gt),
  );
  assertStringIncludes(gt.evals[0].code, "retrieveSentItemAt: 5");
  assertEquals(
    only(ctx.written, "evaluation").printString,
    "File @ /Applications",
  );
});

// ---- inspect

Deno.test("inspect: by objectId sends `obj inspect`", async () => {
  const gt = fakeGt({ onEval: () => evalAnswer("LePage", "a LePage") });
  const ctx = fakeContext(G);
  await runInspect(ctx, { objectId: OBJ }, fakeDeps(gt));
  assertEquals(gt.evals[0].code, "obj inspect. obj");
  assertStringIncludes(String(only(ctx.written, "action").detail), "a LePage");
});

Deno.test("inspect: by code evaluates first, then inspects the stored result", async () => {
  const gt = fakeGt();
  await runInspect(fakeContext(G), { code: "42" }, fakeDeps(gt));
  assertEquals(gt.evals.map((e) => e.code), ["42", "obj inspect. obj"]);
});

Deno.test("inspect: needs exactly one of objectId or code", async () => {
  const deps = fakeDeps(fakeGt());
  await assertRejects(
    () => runInspect(fakeContext(G), {}, deps),
    Error,
    "exactly one",
  );
  await assertRejects(
    () => runInspect(fakeContext(G), { objectId: OBJ, code: "1" }, deps),
    Error,
    "exactly one",
  );
});

// ---- screenshot

Deno.test("screenshot: a window by title substring", async () => {
  const gt = fakeGt();
  const deps = fakeDeps(gt);
  gt.onEval = (
    c,
  ) => (deps.files.set(pathIn(c.code, "png"), "PNG"),
    evalAnswer("ByteString", "'Glamorous Toolkit'"));
  const ctx = fakeContext(G);
  await runScreenshot(ctx, { window: "Glamorous" }, deps);
  assertStringIncludes(gt.evals[0].code, "includesSubstring: 'Glamorous'");
  const s = only(ctx.written, "screenshot");
  assertEquals([s.source, s.bytes], ["window Glamorous Toolkit", 3]);
});

Deno.test("screenshot: a view offscreen at the requested size", async () => {
  const gt = fakeGt();
  const deps = fakeDeps(gt);
  gt.onEval = (c) => {
    if (c.code.includes(".png")) {
      deps.files.set(pathIn(c.code, "png"), "PNGDATA");
    }
    return evalAnswer("ByteString", "'ok'");
  };
  const ctx = fakeContext(G);
  await runScreenshot(ctx, {
    objectId: OBJ,
    view: "gtTreeFor:",
    width: 640,
    height: 480,
  }, deps);
  assertStringIncludes(gt.evals[0].code, "element size: 640 @ 480");
  assertEquals(
    only(ctx.written, "screenshot").source,
    `view gtTreeFor: of ${OBJ}`,
  );
});

Deno.test("screenshot: GT says ok but no file → error", async () => {
  await assertRejects(
    () => runScreenshot(fakeContext(G), {}, fakeDeps(fakeGt())),
    Error,
    "wrote no file",
  );
});

// ---- tools / tool

Deno.test("tools: lists name, description and argument names", async () => {
  const ctx = fakeContext(G);
  await runTools(ctx, {}, fakeDeps(fakeGt()));
  const t = only(ctx.written, "tools").tools as {
    name: string;
    description: string;
    arguments: string[];
  }[];
  assertEquals(t[0], {
    name: "smalltalkCodeEvaluation",
    description: "Executes Smalltalk",
    arguments: ["code", "bindings"],
  });
});

Deno.test("tool: passes arguments through; JSON answers are parsed", async () => {
  const gt = fakeGt({
    onTool: () => ({ text: '{"foundClassNames":["GtLMcpServer"]}' }),
  });
  const ctx = fakeContext(G);
  await runTool(ctx, {
    name: "searchForClasses",
    arguments: '{"query":"GtLMcp"}',
  }, fakeDeps(gt));
  assertEquals(gt.toolCalls[0], {
    name: "searchForClasses",
    arguments: { query: "GtLMcp" },
  });
  const r = only(ctx.written, "tool-result");
  assertEquals(r.json, { foundClassNames: ["GtLMcpServer"] });
  assertEquals(r.isError, false);
});

Deno.test("tool: isError from GT is recorded", async () => {
  const gt = fakeGt({ onTool: () => ({ text: "bad", isError: true }) });
  const ctx = fakeContext(G);
  await runTool(ctx, { name: "x" }, fakeDeps(gt));
  assertEquals(only(ctx.written, "tool-result").isError, true);
});
