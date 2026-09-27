/**
 * Coverage suite: one test per guard or decision a reviewer could delete
 * without another test noticing.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  cellText,
  flattenView,
  jsonObjectArg,
  parseStringArray,
  runTool,
  toEvaluation,
  unquoteSmalltalk,
} from "./gtoolkit.ts";
import {
  bootScript,
  renderViewCode,
  windowPngCode,
  WINDOWS_CODE,
} from "./lib/smalltalk.ts";
import { escapeControlCharsInStrings, parseLenientJson } from "./lib/json.ts";
import { fakeContext, fakeDeps, fakeGt } from "./lib/test_support.ts";

const NOW = new Date(0);

Deno.test("forward views are followed to the view they show", () => {
  assertStringIncludes(
    renderViewCode("gtItemsFor:", 1, 5, "/tmp/x.json"),
    "computeForwardedView",
  );
});

Deno.test("a start past the last row asks GT for no items instead of a negative count", () => {
  assertStringIncludes(
    renderViewCode("gtItemsFor:", 7, 5, "/tmp/x.json"),
    "7 > n\n\t\t\t\t\tifTrue: [ #() ]",
  );
});

Deno.test("windows include GtWorld: subclass instances are listed (allSubInstances)", () => {
  assertStringIncludes(WINDOWS_CODE, "allSubInstances");
  assertStringIncludes(windowPngCode("", "/tmp/a.png"), "allSubInstances");
});

Deno.test("boot script stops a previous server before starting a new one", () => {
  const b = bootScript(4747, false);
  assert(b.indexOf("old stop") < b.indexOf("server start"));
  assert(!b.includes("GtWorld"), "openWorld false must not open the world");
});

Deno.test("quotes GT doubles in print strings are undone exactly once", () => {
  const e = toEvaluation(
    "x",
    {
      objectId: "a",
      objectValue: {
        objectClassName: "ByteString",
        objectPrintString: "''a''''b''",
      },
    },
    "",
    NOW,
  );
  assertEquals([e.printString, e.string], ["'a''b'", "a'b"]);
});

Deno.test("Symbols unquote too; other objects have no string", () => {
  assertEquals(unquoteSmalltalk("#foo"), "foo");
  const e = toEvaluation(
    "x",
    {
      objectId: "a",
      objectValue: { objectClassName: "ByteSymbol", objectPrintString: "#foo" },
    },
    "",
    NOW,
  );
  assertEquals(e.string, "foo");
  assertEquals(
    toEvaluation(
      "x",
      {
        objectId: "a",
        objectValue: { objectClassName: "Point", objectPrintString: "1@2" },
      },
      "",
      NOW,
    ).string,
    null,
  );
});

Deno.test("icon columns (type unknown) are dropped from columns and cells alike", () => {
  const v = flattenView(
    {
      spec: {
        columnSpecifications: [{ title: "Icon", type: "unknown" }, {
          title: "Name",
          type: "text",
        }],
      },
      items: [{ nodeValue: { columnValues: ["a BrValuableStencil", "x"] } }],
    },
    "o",
    "s:",
    1,
    NOW,
  );
  assertEquals(v.columns, ["Name"]);
  assertEquals(v.rows[0].cells, ["x"]);
});

Deno.test("list views without columns still produce one cell per row", () => {
  const v = flattenView(
    { spec: {}, items: [{ nodeValue: { itemText: "a" } }, "b"] },
    "o",
    "s:",
    3,
    NOW,
  );
  assertEquals(v.rows, [{ index: 3, cells: ["a"] }, {
    index: 4,
    cells: ["b"],
  }]);
});

Deno.test("cellText reads every text shape GT uses", () => {
  assertEquals(cellText({ itemText: { sourceString: "s" } }), "s");
  assertEquals(cellText({ text: "t" }), "t");
  assertEquals(cellText(3), "3");
  assertEquals(cellText(null), "");
  assertEquals(cellText({ other: 1 }), "");
});

Deno.test("parseStringArray undoubles embedded quotes", () => {
  assertEquals(parseStringArray("#('a' 'it''s' '')"), ["a", "it's", ""]);
});

Deno.test("jsonObjectArg: empty string is {}, invalid JSON is left for the schema to reject", () => {
  assertEquals(jsonObjectArg(""), {});
  assertEquals(jsonObjectArg('{"a":1}'), { a: 1 });
  assertEquals(jsonObjectArg("{bad"), "{bad");
  assertEquals(jsonObjectArg({ a: 1 }), { a: 1 });
});

Deno.test("tool: a result over maxTextBytes is cut and its JSON is not kept", async () => {
  const gt = fakeGt({
    onTool: () => ({ text: JSON.stringify({ big: "x".repeat(5000) }) }),
  });
  const ctx = fakeContext({});
  await runTool(ctx, { name: "x", maxTextBytes: 1000 }, fakeDeps(gt));
  const r = ctx.written[0].data;
  assertEquals([r.truncated, r.json, String(r.text).length], [
    true,
    null,
    1000,
  ]);
});

Deno.test("control characters are escaped only inside strings", () => {
  assertEquals(
    escapeControlCharsInStrings('{\n\t"a" : "x\ty\rz"\n}'),
    '{\n\t"a" : "x\\ty\\rz"\n}',
  );
  assertEquals(parseLenientJson('{"a":"q\\"\t"}'), { a: 'q"\t' });
});
