import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  CadScript,
  Geometry,
  ScriptParameters,
  SerializedModel,
} from "./types.ts";

// ── CadScript ──

Deno.test("CadScript.of accepts valid source", () => {
  const cs = CadScript.of("const main = () => {};");
  assertEquals(cs.source, "const main = () => {};");
});

Deno.test("CadScript.of rejects empty string", () => {
  assertThrows(() => CadScript.of(""), Error, "must not be empty");
});

Deno.test("CadScript.of rejects whitespace-only string", () => {
  assertThrows(() => CadScript.of("   \n  "), Error, "must not be empty");
});

// ── ScriptParameters ──

Deno.test("ScriptParameters.of copies values", () => {
  const original = { a: 1 };
  const sp = ScriptParameters.of(original);
  original.a = 99;
  assertEquals(sp.values.a, 1); // defensive copy
});

Deno.test("ScriptParameters.empty returns empty values", () => {
  const sp = ScriptParameters.empty();
  assertEquals(Object.keys(sp.values).length, 0);
});

// ── Geometry ──

Deno.test("Geometry.of wraps single shape in array", () => {
  const g = Geometry.of({ type: "geom3" });
  assertEquals(g.shapes.length, 1);
});

Deno.test("Geometry.of accepts array of shapes", () => {
  const g = Geometry.of([{ type: "geom3" }, { type: "geom3" }]);
  assertEquals(g.shapes.length, 2);
});

Deno.test("Geometry.of rejects empty array", () => {
  assertThrows(() => Geometry.of([]), Error, "at least one shape");
});

Deno.test("Geometry.of wraps null as single-element array", () => {
  // null is not an array, so it's wrapped in [null] — 1 shape
  const g = Geometry.of(null);
  assertEquals(g.shapes.length, 1);
});

Deno.test("Geometry.count returns shape count", () => {
  const g = Geometry.of([{ a: 1 }, { b: 2 }, { c: 3 }]);
  assertEquals(Geometry.count(g), 3);
});

// ── SerializedModel ──

Deno.test("SerializedModel.of stores bytes and format", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sm = SerializedModel.of(bytes, "stl");
  assertEquals(sm.bytes, bytes);
  assertEquals(sm.format, "stl");
});
