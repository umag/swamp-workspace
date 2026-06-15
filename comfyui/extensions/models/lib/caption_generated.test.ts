import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseGeneratedCaption } from "./caption.ts";

const VALID = JSON.stringify({
  aspect_ratio: "9:16",
  high_level_description: "a neon cat on a rooftop",
  compositional_deconstruction: {
    background: "a rainy cyberpunk skyline",
    elements: [
      { type: "obj", bbox: [200, 100, 800, 500], desc: "a neon cat" },
      { type: "text", bbox: [50, 50, 150, 950], text: "MEOW", desc: "title" },
    ],
  },
});

Deno.test("parseGeneratedCaption accepts a valid minified caption", () => {
  const c = parseGeneratedCaption(VALID);
  assertEquals(c.aspect_ratio, "9:16");
  assertEquals(c.compositional_deconstruction?.elements.length, 2);
  assertEquals(c.compositional_deconstruction?.elements[1].text, "MEOW");
});

Deno.test("parseGeneratedCaption strips a ```json fence", () => {
  const c = parseGeneratedCaption("```json\n" + VALID + "\n```");
  assertEquals(c.high_level_description, "a neon cat on a rooftop");
});

Deno.test("parseGeneratedCaption accepts elements without a bbox", () => {
  const c = parseGeneratedCaption(
    JSON.stringify({
      aspect_ratio: "1:1",
      high_level_description: "x",
      compositional_deconstruction: { elements: [{ type: "obj", desc: "a dense crowd" }] },
    }),
  );
  assertEquals(c.compositional_deconstruction?.elements[0].bbox, undefined);
});

Deno.test("parseGeneratedCaption rejects a non-integer bbox", () => {
  const bad = JSON.stringify({
    aspect_ratio: "1:1",
    high_level_description: "x",
    compositional_deconstruction: {
      elements: [{ type: "obj", bbox: [0, 0, 0.5, 0.5], desc: "y" }],
    },
  });
  assertThrows(() => parseGeneratedCaption(bad), Error, "integers");
});

Deno.test("parseGeneratedCaption rejects bad JSON and missing required keys", () => {
  assertThrows(() => parseGeneratedCaption("not json"), Error);
  assertThrows(
    () => parseGeneratedCaption(JSON.stringify({ high_level_description: "x" })),
    Error,
    "aspect_ratio",
  );
});

Deno.test("parseGeneratedCaption repairs a reversed bbox and drops a degenerate one", () => {
  const c = parseGeneratedCaption(
    JSON.stringify({
      aspect_ratio: "3:2",
      high_level_description: "x",
      compositional_deconstruction: {
        elements: [
          { type: "obj", bbox: [600, 100, 300, 800], desc: "reversed y axis" },
          { type: "obj", bbox: [400, 500, 400, 900], desc: "zero height" },
        ],
      },
    }),
  );
  const els = c.compositional_deconstruction?.elements ?? [];
  assertEquals(els[0].bbox, [300, 100, 600, 800]);
  assertEquals(els[1].bbox, undefined);
});
