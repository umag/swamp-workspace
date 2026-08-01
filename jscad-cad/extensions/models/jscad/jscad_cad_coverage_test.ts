/**
 * Coverage suite: regression tests closing branch gaps found while
 * characterizing @magistr/jscad-cad's eval-subprocess seam — every
 * serializerPackage case, every serializeOpts branch, stripMarkdownFences's
 * match/no-match/idempotence paths, the stderr `"    at "` line-filter's
 * remaining branches, the `finally` cleanup's own try/catch around
 * Deno.removeSync, the empty/whitespace-only CadScript.of guard,
 * ScriptParameters's defensive copy (driven through the model layer this
 * time), Geometry.of([]) throwing (documenting the guard that the real
 * eval-subprocess path never calls), and the deprecated evaluate() throw.
 *
 * script_evaluator.ts / types.ts are byte-frozen for everything covered in
 * this file (B1/B2 are asserted in the adversarial/contract/property suites
 * instead); every evaluateAndSerialize call site here is now awaited to
 * match the B2 sync-to-async signature change.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  CadScript,
  Geometry,
  OUTPUT_FORMATS,
  type OutputFormat,
  ScriptParameters,
  SerializedModel,
} from "./types.ts";
import { ScriptEvaluator } from "./script_evaluator.ts";
import { model } from "../jscad_cad.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type CommandOutcome = {
  success: boolean;
  objectCount?: number;
  stdoutOverride?: string;
  stderr?: string;
  outputBytes?: Uint8Array;
  outputText?: string;
  onOutputSync?: (evalPath: string, outputPath: string) => void;
};

function installCommandStub(outcome: CommandOutcome) {
  const encoder = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #argv: string[];
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      this.#argv = options.args ?? [];
    }
    outputSync() {
      const evalPath = this.#argv[this.#argv.length - 1] ?? "";
      const writeArg = this.#argv.find((a) => a.startsWith("--allow-write="));
      const outputPath = writeArg
        ? writeArg.slice("--allow-write=".length)
        : "";
      outcome.onOutputSync?.(evalPath, outputPath);
      if (outcome.success && outputPath) {
        if (outcome.outputBytes) {
          Deno.writeFileSync(outputPath, outcome.outputBytes);
        } else if (outcome.outputText !== undefined) {
          Deno.writeTextFileSync(outputPath, outcome.outputText);
        }
      }
      const stdoutStr = outcome.stdoutOverride ??
        JSON.stringify({ objectCount: outcome.objectCount ?? 1 });
      return {
        success: outcome.success,
        code: outcome.success ? 0 : 1,
        stdout: encoder.encode(outcome.success ? stdoutStr : ""),
        stderr: encoder.encode(outcome.stderr ?? ""),
      };
    }
    output() {
      return Promise.resolve(this.outputSync());
    }
  }
  g.Deno.Command = FakeCommand;
  return {
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

async function withCommandStub<T>(
  outcome: CommandOutcome,
  fn: () => T | Promise<T>,
): Promise<T> {
  const stub = installCommandStub(outcome);
  try {
    return await fn();
  } finally {
    stub.restore();
  }
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<{ dataHandles: unknown[] }>;
}>;

function runMethod(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

function makeCtx() {
  const written: Array<
    { spec: string; name: string; payload: Record<string, unknown> }
  > = [];
  return {
    written,
    ctx: {
      createFileWriter: (_spec: string, _name: string) => ({
        writeAll: (_bytes: Uint8Array) =>
          Promise.resolve({ spec: "output", name: "output" }),
        writeText: (_text: string) =>
          Promise.resolve({ spec: "log", name: "log" }),
      }),
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

const SIMPLE_SCRIPT = `
  const main = () => primitives.cuboid({ size: [5, 5, 5] });
`;

// ---------------------------------------------------------------------------
// serializerPackage — every case (mirrors the contract suite's loop, kept
// here too so this file's own coverage is self-contained per STANDARD.md)
// ---------------------------------------------------------------------------

const EXPECTED_PACKAGE: Record<OutputFormat, string> = {
  "stl": "npm:@jscad/stl-serializer@2.1.21",
  "stl-ascii": "npm:@jscad/stl-serializer@2.1.21",
  "dxf": "npm:@jscad/dxf-serializer@2.1.21",
  "svg": "npm:@jscad/svg-serializer@2.3.10",
  "obj": "npm:@jscad/obj-serializer@2.1.21",
  "3mf": "npm:@jscad/3mf-serializer@2.1.15",
};

for (const format of OUTPUT_FORMATS) {
  Deno.test(`coverage: serializerPackage("${format}") === ${EXPECTED_PACKAGE[format]}`, async () => {
    let script = "";
    await withCommandStub(
      {
        success: true,
        objectCount: 1,
        outputBytes: new Uint8Array([1]),
        onOutputSync: (evalPath) => {
          script = Deno.readTextFileSync(evalPath);
        },
      },
      () =>
        ScriptEvaluator.evaluateAndSerialize(
          CadScript.of(SIMPLE_SCRIPT),
          ScriptParameters.empty(),
          format,
        ),
    );
    assert(script.includes(`"${EXPECTED_PACKAGE[format]}"`));
  });
}

// ---------------------------------------------------------------------------
// serializeOpts — the three branches: stl / stl-ascii / catch-all "{}"
// ---------------------------------------------------------------------------

Deno.test('coverage: serializeOpts("stl") === "{ binary: true }"', async () => {
  let script = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (p) => (script = Deno.readTextFileSync(p)),
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  assert(script.includes("serializer.serialize({ binary: true }, "));
});

Deno.test('coverage: serializeOpts("stl-ascii") === "{ binary: false }"', async () => {
  let script = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputText: "solid\nendsolid\n",
      onOutputSync: (p) => (script = Deno.readTextFileSync(p)),
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl-ascii",
      ),
  );
  assert(script.includes("serializer.serialize({ binary: false }, "));
});

for (const format of ["dxf", "svg", "obj", "3mf"] as const) {
  Deno.test(`coverage: serializeOpts("${format}") falls into the catch-all "{}"`, async () => {
    let script = "";
    await withCommandStub(
      {
        success: true,
        objectCount: 1,
        outputBytes: new Uint8Array([1]),
        outputText: format === "3mf" ? undefined : "x",
        onOutputSync: (p) => (script = Deno.readTextFileSync(p)),
      },
      () =>
        ScriptEvaluator.evaluateAndSerialize(
          CadScript.of(SIMPLE_SCRIPT),
          ScriptParameters.empty(),
          format,
        ),
    );
    assert(script.includes("serializer.serialize({}, "));
  });
}

// ---------------------------------------------------------------------------
// stripMarkdownFences — match / no-match / idempotence
// ---------------------------------------------------------------------------

Deno.test("coverage: stripMarkdownFences matches a fenced block and strips it", async () => {
  const inner = "const main = () => primitives.cuboid({ size: [1,1,1] });\n";
  let script = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (p) => (script = Deno.readTextFileSync(p)),
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of("```js\n" + inner + "```"),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  const m = script.match(/const userSource = ([\s\S]*?);\nconst params = /)!;
  assertEquals(JSON.parse(m[1]), inner);
});

Deno.test("coverage: stripMarkdownFences does NOT match plain (non-fenced) source", async () => {
  let script = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (p) => (script = Deno.readTextFileSync(p)),
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  const m = script.match(/const userSource = ([\s\S]*?);\nconst params = /)!;
  assertEquals(JSON.parse(m[1]), SIMPLE_SCRIPT);
});

Deno.test("coverage: stripMarkdownFences does not match a fence that doesn't close at the very end", async () => {
  const notReallyFenced = "```js\nconst main = () => {};\n``` trailing text";
  let script = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (p) => (script = Deno.readTextFileSync(p)),
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(notReallyFenced),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  const m = script.match(/const userSource = ([\s\S]*?);\nconst params = /)!;
  assertEquals(JSON.parse(m[1]), notReallyFenced);
});

// ---------------------------------------------------------------------------
// stderr "    at " line-filter — remaining branches
// ---------------------------------------------------------------------------

Deno.test("coverage: stderr filter picks the FIRST line when it is already a non-frame message", async () => {
  await assertRejects(
    () =>
      withCommandStub(
        {
          success: false,
          stderr: "CadScript evaluation failed: boom\n    at f (eval:1:1)",
        },
        () =>
          ScriptEvaluator.evaluateAndSerialize(
            CadScript.of(SIMPLE_SCRIPT),
            ScriptParameters.empty(),
            "stl",
          ),
      ),
    Error,
    "CadScript evaluation failed: boom",
  );
});

Deno.test("coverage: a LEADING frame line is de-indented by the whole-blob .trim() BEFORE the split — so it is picked as the message, not skipped", async () => {
  // The whole-blob `.trim()` runs before `.split(\"\\n\")`, so it strips ALL
  // of line 1's leading whitespace regardless of how many spaces it had.
  // A stderr blob whose FIRST line starts with the "    at " frame indent
  // therefore never actually reaches the `startsWith(\"    at \")` check as
  // originally indented — it is de-indented first, so the filter treats it
  // as the real message rather than skipping past it to line 2.
  await assertRejects(
    () =>
      withCommandStub(
        {
          success: false,
          stderr:
            "    at wrapper (eval:0:0)\nCadScript main() execution failed: nested",
        },
        () =>
          ScriptEvaluator.evaluateAndSerialize(
            CadScript.of(SIMPLE_SCRIPT),
            ScriptParameters.empty(),
            "stl",
          ),
      ),
    Error,
    "at wrapper (eval:0:0)",
  );
});

// ---------------------------------------------------------------------------
// finally cleanup — try/catch around Deno.removeSync
// ---------------------------------------------------------------------------

Deno.test("coverage: finally's removeSync(evalPath) catch swallows a throw when the eval file is already gone, without masking a successful result", async () => {
  const out = await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([9, 9, 9]),
      // Delete evalPath ourselves, from inside the stubbed subprocess call
      // (still inside the real code's `try` block) — by the time the real
      // code's own `finally { try { Deno.removeSync(evalPath) } catch {} }`
      // runs, the file is already gone and that removeSync call throws,
      // proving the surrounding catch swallows it without masking the
      // already-computed success.
      onOutputSync: (evalPath) => {
        Deno.removeSync(evalPath);
      },
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  assertEquals(out.objectCount, 1);
  assertEquals(out.serialized.bytes, new Uint8Array([9, 9, 9]));
});

Deno.test("coverage: a normal successful run removes BOTH temp files (evalPath and outputPath) by the time it returns", async () => {
  let evalPathSeen = "";
  let outputPathSeen = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (evalPath, outputPath) => {
        evalPathSeen = evalPath;
        outputPathSeen = outputPath;
      },
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  assertThrows(() => Deno.statSync(evalPathSeen));
  assertThrows(() => Deno.statSync(outputPathSeen));
});

// ---------------------------------------------------------------------------
// CadScript — empty/whitespace-only guard, extended
// ---------------------------------------------------------------------------

Deno.test("coverage: CadScript.of accepts source that is merely whitespace-PADDED around real content", () => {
  const cs = CadScript.of("  \n  const main = () => {};\n  ");
  assertEquals(cs.source, "  \n  const main = () => {};\n  ");
});

Deno.test("coverage: CadScript.of rejects a tabs-and-newlines-only string", () => {
  assertThrows(() => CadScript.of("\t\n\t\n"), Error, "must not be empty");
});

// ---------------------------------------------------------------------------
// ScriptParameters — defensive copy driven through the model layer
// ---------------------------------------------------------------------------

Deno.test("coverage: mutating the caller's parameters object AFTER run() is called never affects the in-flight render", async () => {
  const params: Record<string, unknown> = { size: 10 };
  const { ctx } = makeCtx();
  let capturedParamsJson = "";
  const promise = withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (evalPath) => {
        const script = Deno.readTextFileSync(evalPath);
        capturedParamsJson =
          script.match(/const params = ([\s\S]*?);\nconst Ctor = /)![1];
      },
    },
    () =>
      runMethod("run", {
        script: SIMPLE_SCRIPT,
        parameters: params,
        outputFormat: "stl",
      }, ctx),
  );
  // Mutate the caller's object AFTER passing it in — ScriptParameters.of's
  // defensive copy means this must not be visible to the render that ran.
  params.size = 999;
  await promise;
  assertEquals(JSON.parse(capturedParamsJson), { size: 10 });
});

Deno.test("coverage: ScriptParameters.of defensive copy (direct)", () => {
  const original = { a: 1, nested: "x" };
  const sp = ScriptParameters.of(original);
  original.a = 42;
  assertEquals(sp.values.a, 1);
  assertEquals(sp.values.nested, "x");
});

// ---------------------------------------------------------------------------
// Geometry.of([]) — the guard the real eval-subprocess path never calls
// ---------------------------------------------------------------------------

Deno.test("coverage: Geometry.of([]) throws 'at least one shape'", () => {
  assertThrows(() => Geometry.of([]), Error, "at least one shape");
});

Deno.test("coverage: Geometry.of / Geometry.count round-trip for a non-empty array", () => {
  const g = Geometry.of([{ a: 1 }, { b: 2 }]);
  assertEquals(Geometry.count(g), 2);
});

// ---------------------------------------------------------------------------
// SerializedModel — plain value-object construction
// ---------------------------------------------------------------------------

Deno.test("coverage: SerializedModel.of stores bytes and format verbatim", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sm = SerializedModel.of(bytes, "obj");
  assertEquals(sm.bytes, bytes);
  assertEquals(sm.format, "obj");
});

// ---------------------------------------------------------------------------
// Deprecated evaluate() throw
// ---------------------------------------------------------------------------

Deno.test("coverage: the deprecated ScriptEvaluator.evaluate() always throws, directing callers to evaluateAndSerialize", () => {
  assertThrows(
    () =>
      ScriptEvaluator.evaluate(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
      ),
    Error,
    "evaluateAndSerialize",
  );
});
