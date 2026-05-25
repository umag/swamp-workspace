import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { CadScript, ScriptParameters } from "./types.ts";
import { ScriptEvaluator } from "./script_evaluator.ts";

Deno.test("evaluateAndSerialize renders a simple cuboid to STL", () => {
  const script = CadScript.of(`
    const main = (params = {}) => {
      return primitives.cuboid({ size: [10, 10, 10] });
    };
  `);
  const params = ScriptParameters.empty();
  const { serialized, objectCount } = ScriptEvaluator.evaluateAndSerialize(
    script,
    params,
    "stl",
  );

  assertEquals(objectCount, 1);
  assertEquals(serialized.format, "stl");
  // Binary STL: 80-byte header + 4-byte count + N*50 bytes
  assertEquals(serialized.bytes.byteLength > 84, true);
  // Check STL header structure: triangle count at offset 80
  const view = new DataView(
    serialized.bytes.buffer,
    serialized.bytes.byteOffset,
    serialized.bytes.byteLength,
  );
  const triCount = view.getUint32(80, true);
  assertEquals(triCount > 0, true);
  assertEquals(serialized.bytes.byteLength, 84 + triCount * 50);
});

Deno.test("evaluateAndSerialize passes parameters to main()", () => {
  const script = CadScript.of(`
    const main = (params = {}) => {
      const s = params.size || 5;
      return primitives.cuboid({ size: [s, s, s] });
    };
  `);
  const params = ScriptParameters.of({ size: 20 });
  const { serialized, objectCount } = ScriptEvaluator.evaluateAndSerialize(
    script,
    params,
    "stl",
  );

  assertEquals(objectCount, 1);
  assertEquals(serialized.format, "stl");
  assertEquals(serialized.bytes.byteLength > 84, true);
});

Deno.test("evaluateAndSerialize handles function declaration syntax", () => {
  const script = CadScript.of(`
    function main(params) {
      return primitives.sphere({ radius: 5, segments: 16 });
    }
  `);
  const { objectCount } = ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl",
  );
  assertEquals(objectCount, 1);
});

Deno.test("evaluateAndSerialize strips markdown fences", () => {
  const script = CadScript.of(
    "```javascript\nconst main = () => primitives.cuboid({ size: [5, 5, 5] });\n```",
  );
  const { objectCount } = ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl",
  );
  assertEquals(objectCount, 1);
});

Deno.test("evaluateAndSerialize throws on missing main()", () => {
  const script = CadScript.of("const foo = 42;");
  assertThrows(
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        script,
        ScriptParameters.empty(),
        "stl",
      ),
    Error,
    "main()",
  );
});

Deno.test("evaluateAndSerialize throws on runtime error in script", () => {
  const script = CadScript.of(`
    const main = () => {
      throw new Error("intentional test error");
    };
  `);
  assertThrows(
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        script,
        ScriptParameters.empty(),
        "stl",
      ),
    Error,
    "intentional test error",
  );
});

Deno.test("evaluateAndSerialize renders to ASCII STL", () => {
  const script = CadScript.of(`
    const main = () => primitives.cuboid({ size: [5, 5, 5] });
  `);
  const { serialized } = ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl-ascii",
  );
  assertEquals(serialized.format, "stl-ascii");
  const text = new TextDecoder().decode(serialized.bytes);
  assertEquals(text.startsWith("solid"), true);
  assertEquals(text.includes("endsolid"), true);
});

Deno.test("evaluateAndSerialize renders union of multiple shapes", () => {
  const script = CadScript.of(`
    const main = () => {
      const a = primitives.cuboid({ size: [10, 10, 10] });
      const b = primitives.sphere({ radius: 3, segments: 16 });
      return booleans.union(a, b);
    };
  `);
  const { objectCount, serialized } = ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl",
  );
  assertEquals(objectCount, 1);
  assertEquals(serialized.bytes.byteLength > 84, true);
});

Deno.test("deprecated evaluate() throws", () => {
  const script = CadScript.of("const main = () => {};");
  assertThrows(
    () => ScriptEvaluator.evaluate(script, ScriptParameters.empty()),
    Error,
    "evaluateAndSerialize",
  );
});
