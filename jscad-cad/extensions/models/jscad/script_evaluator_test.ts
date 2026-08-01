/**
 * LIVE e2e suite — the SOLE test file allowed to spawn a real `deno`
 * subprocess and touch the network (npm specifier resolution for
 * @jscad/modeling and the per-format serializer packages). Every other
 * suite in this directory stubs `globalThis.Deno.Command`.
 *
 * As of 2026.08.01.1, `ScriptEvaluator.evaluateAndSerialize` is async (the
 * B2 fix switched `cmd.outputSync()` to `await cmd.output()` so a real
 * AbortSignal.timeout can actually bound execution), so every call site
 * below is awaited.
 *
 * Two SYNTHETIC live negatives close out the B1/B2 fix verification that
 * can only be proven against a real subprocess:
 *   - B1: a malicious CadScript that attempts to read a sibling
 *     synthetic-secret temp file must now be DENIED (PermissionDenied),
 *     with the token never appearing in the error message.
 *   - B2: an infinite-looping CadScript run with a short timeoutMs must now
 *     be TIMED OUT (bounded, clear error) instead of hanging forever.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { CadScript, ScriptParameters } from "./types.ts";
import { ScriptEvaluator } from "./script_evaluator.ts";

Deno.test("evaluateAndSerialize renders a simple cuboid to STL", async () => {
  const script = CadScript.of(`
    const main = (params = {}) => {
      return primitives.cuboid({ size: [10, 10, 10] });
    };
  `);
  const params = ScriptParameters.empty();
  const { serialized, objectCount } = await ScriptEvaluator
    .evaluateAndSerialize(
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

Deno.test("evaluateAndSerialize passes parameters to main()", async () => {
  const script = CadScript.of(`
    const main = (params = {}) => {
      const s = params.size || 5;
      return primitives.cuboid({ size: [s, s, s] });
    };
  `);
  const params = ScriptParameters.of({ size: 20 });
  const { serialized, objectCount } = await ScriptEvaluator
    .evaluateAndSerialize(
      script,
      params,
      "stl",
    );

  assertEquals(objectCount, 1);
  assertEquals(serialized.format, "stl");
  assertEquals(serialized.bytes.byteLength > 84, true);
});

Deno.test("evaluateAndSerialize handles function declaration syntax", async () => {
  const script = CadScript.of(`
    function main(params) {
      return primitives.sphere({ radius: 5, segments: 16 });
    }
  `);
  const { objectCount } = await ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl",
  );
  assertEquals(objectCount, 1);
});

Deno.test("evaluateAndSerialize strips markdown fences", async () => {
  const script = CadScript.of(
    "```javascript\nconst main = () => primitives.cuboid({ size: [5, 5, 5] });\n```",
  );
  const { objectCount } = await ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl",
  );
  assertEquals(objectCount, 1);
});

Deno.test("evaluateAndSerialize throws on missing main()", async () => {
  const script = CadScript.of("const foo = 42;");
  await assertRejects(
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

Deno.test("evaluateAndSerialize throws on runtime error in script", async () => {
  const script = CadScript.of(`
    const main = () => {
      throw new Error("intentional test error");
    };
  `);
  await assertRejects(
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

Deno.test("evaluateAndSerialize renders to ASCII STL", async () => {
  const script = CadScript.of(`
    const main = () => primitives.cuboid({ size: [5, 5, 5] });
  `);
  const { serialized } = await ScriptEvaluator.evaluateAndSerialize(
    script,
    ScriptParameters.empty(),
    "stl-ascii",
  );
  assertEquals(serialized.format, "stl-ascii");
  const text = new TextDecoder().decode(serialized.bytes);
  assertEquals(text.startsWith("solid"), true);
  assertEquals(text.includes("endsolid"), true);
});

Deno.test("evaluateAndSerialize renders union of multiple shapes", async () => {
  const script = CadScript.of(`
    const main = () => {
      const a = primitives.cuboid({ size: [10, 10, 10] });
      const b = primitives.sphere({ radius: 3, segments: 16 });
      return booleans.union(a, b);
    };
  `);
  const { objectCount, serialized } = await ScriptEvaluator
    .evaluateAndSerialize(
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

// ---------------------------------------------------------------------------
// B1 live negative: scoped --allow-read denies a sibling synthetic-secret
// read, and the token never leaks into the error message.
// ---------------------------------------------------------------------------

Deno.test("B1 live negative: a malicious CadScript reading a sibling synthetic-secret file is DENIED (PermissionDenied), and the token never reaches the error message", async () => {
  const secretToken = `SYNTHETIC-SECRET-${crypto.randomUUID()}`;
  const secretPath = Deno.makeTempFileSync({
    prefix: "jscad-cad-live-e2e-secret-",
    suffix: ".txt",
  });
  try {
    Deno.writeTextFileSync(secretPath, secretToken);
    const malicious = CadScript.of(`
      const main = () => {
        const stolen = Deno.readTextFileSync(${JSON.stringify(secretPath)});
        return primitives.cuboid({ size: [stolen.length || 1, 1, 1] });
      };
    `);

    const err = await assertRejects(
      () =>
        ScriptEvaluator.evaluateAndSerialize(
          malicious,
          ScriptParameters.empty(),
          "stl",
        ),
      Error,
    );

    const message = err.message;
    assert(
      /PermissionDenied|NotCapable|requires read access/i.test(message),
      `expected a permission-denied-shaped error, got: ${message}`,
    );
    assert(
      !message.includes(secretToken),
      "the synthetic secret token must never appear in the error message",
    );
  } finally {
    try {
      Deno.removeSync(secretPath);
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// B2 live negative: AbortSignal.timeout genuinely bounds a hostile
// infinite-looping script — no hang.
// ---------------------------------------------------------------------------

Deno.test("B2 live negative: an infinite-looping CadScript is TIMED OUT (bounded, clear error) instead of hanging forever", async () => {
  const infinite = CadScript.of(`
    const main = () => {
      while (true) { /* spin forever */ }
    };
  `);
  const startedAt = Date.now();
  await assertRejects(
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        infinite,
        ScriptParameters.empty(),
        "stl",
        2000,
      ),
    Error,
    "timed out after 2000ms",
  );
  const elapsedMs = Date.now() - startedAt;
  assert(
    elapsedMs < 15_000,
    `expected the timeout to bound execution well under 15s, took ${elapsedMs}ms`,
  );
});
