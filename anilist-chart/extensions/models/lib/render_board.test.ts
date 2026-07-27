import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { type BoardData, renderBoard } from "./render_board.ts";
import { findUnpublishable } from "./publish_gate.ts";
import type { Award } from "./awards.ts";

function award(t: string): Award {
  return { n: "8,5", u: "unit", t, w: "someone", s: "note" };
}

function data(over: Partial<BoardData> = {}): BoardData {
  return {
    users: ["a", "b", "c"],
    nrows: 1234,
    top: [award("Защитник"), award("Археолог"), award("Архивариус")],
    rest: Array.from({ length: 12 }, (_, i) => award(`R${i}`)),
    keepers: [{ g: "Комедия", w: "a", p: 27.3 }],
    pairs: [],
    now: new Date("2026-07-21T12:00:00Z"),
    ...over,
  };
}

Deno.test("a full board renders 15 records, none skipped", () => {
  const r = renderBoard(data());
  assertEquals(r.recordCount, 15);
  assertEquals(r.skipped, []);
  assertEquals(r.recordCount + r.skipped.length, 15);
  assertEquals(findUnpublishable(r.html), []);
});

Deno.test("rendered + skipped == 15 exactly when awards are skipped", () => {
  const rest = data().rest.slice();
  const restM = rest.slice() as (Award | null)[];
  restM[4] = null; // one register award skipped
  const top = [award("A"), null, award("C")] as (Award | null)[]; // one top skipped
  const r = renderBoard(data({ top, rest: restM }));
  assertEquals(r.recordCount, 13);
  assertEquals(r.skipped.length, 2);
  assertEquals(r.recordCount + r.skipped.length, 15);
  // the mast advertises the actual count, not a constant 15
  assertStringIncludes(r.html, "записей — 13");
  // a skipped slot must NEVER leak a bad text node
  assertEquals(findUnpublishable(r.html), []);
});

Deno.test("a stubbed undefined award holder refuses publish", () => {
  const bad = {
    n: "1",
    u: "u",
    t: "T",
    w: undefined,
    s: "s",
  } as unknown as Award;
  const top = [bad, award("B"), award("C")];
  const r = renderBoard(data({ top }));
  // the holder collapses to the text node >undefined<
  assertStringIncludes(r.html, ">undefined<");
  assert(findUnpublishable(r.html).length > 0);
});

Deno.test("keeper track width goes into the style attribute, finite", () => {
  const r = renderBoard(data({ keepers: [{ g: "Экшен", w: "b", p: 42.1 }] }));
  assertStringIncludes(r.html, `style="--p:42.1%"`);
  assertStringIncludes(r.html, "42,1"); // the circle uses the comma decimal
});

Deno.test("board escapes an award holder with HTML metacharacters", () => {
  const evil = { n: "1", u: "u", t: "T", w: `<b>x</b>`, s: "s" } as Award;
  const r = renderBoard(data({ top: [evil, award("B"), award("C")] }));
  assert(!r.html.includes("<b>x</b>"));
  assertStringIncludes(r.html, "&lt;b&gt;x&lt;/b&gt;");
});

Deno.test("week and localized date render from the injected clock", () => {
  const r = renderBoard(data({ now: new Date("2026-07-21T12:00:00Z") }));
  assertStringIncludes(r.html, "21 июля 2026");
  assertStringIncludes(r.html, "неделя 30");
});
