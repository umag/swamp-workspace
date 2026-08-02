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
 * SYNTHETIC live cases close out the B1–B5 fix verification that can only be
 * proven against a real subprocess (no test here ever allocates an
 * oversized fixture):
 *   - B1: a malicious CadScript that attempts to read a sibling
 *     synthetic-secret temp file must now be DENIED (PermissionDenied),
 *     with the token never appearing in the error message.
 *   - B2: an infinite-looping CadScript run with a short timeoutMs must now
 *     be TIMED OUT (bounded, clear error) instead of hanging forever.
 *   - B3: a CadScript that itself calls console.log() before returning
 *     geometry must still render successfully (the parent now parses only
 *     the last stdout line for object-count metadata).
 *   - B4: a CadScript whose main() returns [] must be rejected with a clear
 *     "at least one shape" error, never a silent objectCount 0.
 *   - B5: a real (small) render whose output exceeds a tiny maxOutputBytes
 *     cap must be rejected by the subprocess's size-cap guard.
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

// ---------------------------------------------------------------------------
// B3 live positive: a script that itself calls console.log no longer
// corrupts the trailing object-count metadata parse.
// ---------------------------------------------------------------------------

Deno.test("B3 live positive: a CadScript that console.log()s before returning geometry still renders successfully with the correct objectCount", async () => {
  const script = CadScript.of(`
    const main = () => {
      console.log("debug: about to build a cuboid");
      console.log("debug: still going");
      return primitives.cuboid({ size: [5, 5, 5] });
    };
  `);
  const { objectCount, serialized } = await ScriptEvaluator
    .evaluateAndSerialize(
      script,
      ScriptParameters.empty(),
      "stl",
    );
  assertEquals(objectCount, 1);
  assertEquals(serialized.format, "stl");
  assertEquals(serialized.bytes.byteLength > 84, true);
});

// ---------------------------------------------------------------------------
// B4 live negative: an explicit empty-array main() result is rejected with a
// clear error instead of silently succeeding with objectCount 0.
// ---------------------------------------------------------------------------

Deno.test("B4 live negative: a CadScript whose main() returns [] is rejected with 'at least one shape', never a silent objectCount 0", async () => {
  const script = CadScript.of("const main = () => [];");
  await assertRejects(
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        script,
        ScriptParameters.empty(),
        "stl",
      ),
    Error,
    "at least one shape",
  );
});

// ---------------------------------------------------------------------------
// B5 live negative: a real (small, non-oversized) render whose output
// exceeds a tiny maxOutputBytes cap is rejected by the subprocess guard.
// ---------------------------------------------------------------------------

Deno.test("B5 live negative: a real CadScript render exceeding a tiny maxOutputBytes cap is rejected by the subprocess's size-cap guard — no oversized fixture needed", async () => {
  const script = CadScript.of(`
    const main = () => primitives.cuboid({ size: [10, 10, 10] });
  `);
  await assertRejects(
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        script,
        ScriptParameters.empty(),
        "stl",
        undefined,
        16,
      ),
    Error,
    "exceeds",
  );
});
