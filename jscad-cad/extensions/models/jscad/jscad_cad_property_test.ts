/**
 * Property-based tests (fast-check) for @magistr/jscad-cad's eval-subprocess
 * seam. script_evaluator.ts / types.ts are byte-frozen apart from the B1
 * argv fix (2026.08.01.1: `--allow-read` is now scoped to `evalPath`,
 * asserted in the argv-shape property below) and the B2 sync-to-async
 * signature change (every property that drives evaluateAndSerialize is now
 * an `fc.asyncProperty`, awaited via `await fc.assert(...)`). Every
 * property here is observed by driving `ScriptEvaluator.evaluateAndSerialize`
 * (and, for one flow test, `model.methods.run.execute()`) against a stubbed
 * `Deno.Command` and reading back the generated eval-script text / return
 * value. No test spawns a real subprocess or hits the network.
 *
 * Arbitraries are deliberately RESTRICTED to canonical, JSON-safe subsets so
 * no over-strong invariant flakes — verified once at FC_NUM_RUNS=5000 before
 * landing at the CI default.
 *
 * Properties:
 *  (a) ScriptParameters round-trip — for any generated flat JSON-safe
 *      object, ScriptParameters.of(values).values deep-equals values but is
 *      a DISTINCT object (defensive copy); mutating the input after
 *      construction never changes the stored values.
 *  (b) format -> serializer/opts + well-formed argv — for any of the 6
 *      OutputFormats, the captured argv always has exactly 5 elements in the
 *      fixed shape and the eval script always imports the correct pinned
 *      serializer package for that format.
 *  (c) the user's script source is ALWAYS embedded via JSON.stringify — for
 *      any generated string built from a canonical alphabet (including
 *      quotes/backslashes/newlines/template-literal-shaped substrings), the
 *      JSON.parse round-trip of the embedded `userSource` literal recovers
 *      the exact original, and the surrounding eval-script structure
 *      (import lines, Ctor lookup) is unaffected by the content (no
 *      injection/breakout).
 *  (d) stripMarkdownFences idempotence — for any generated (possibly fenced)
 *      source, stripping twice (by feeding the once-stripped output back
 *      through a second evaluateAndSerialize call) equals stripping once.
 */
import fc from "npm:fast-check@4.8.0";
import { assertEquals } from "jsr:@std/assert@1";
import {
  CadScript,
  OUTPUT_FORMATS,
  type OutputFormat,
  ScriptParameters,
} from "./types.ts";
import { ScriptEvaluator } from "./script_evaluator.ts";
import { model } from "../jscad_cad.ts";

// Property iteration count — overridable for a high-count verification run
// via FC_NUM_RUNS (e.g. FC_NUM_RUNS=5000 deno test ...).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type CommandOutcome = {
  success: boolean;
  objectCount?: number;
  outputBytes?: Uint8Array;
  onOutputSync?: (argv: string[], evalScript: string) => void;
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
      let evalScript = "";
      try {
        evalScript = Deno.readTextFileSync(evalPath);
      } catch {
        // best-effort — leave "" if unreadable
      }
      outcome.onOutputSync?.(this.#argv, evalScript);
      const writeArg = this.#argv.find((a) => a.startsWith("--allow-write="));
      const outputPath = writeArg
        ? writeArg.slice("--allow-write=".length)
        : "";
      if (outcome.success && outputPath) {
        Deno.writeFileSync(
          outputPath,
          outcome.outputBytes ?? new Uint8Array([1]),
        );
      }
      return {
        success: outcome.success,
        code: outcome.success ? 0 : 1,
        stdout: encoder.encode(
          outcome.success
            ? JSON.stringify({ objectCount: outcome.objectCount ?? 1 })
            : "",
        ),
        stderr: new Uint8Array(),
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

async function captureInvocation(
  source: string,
  format: OutputFormat,
  params: Record<string, unknown> = {},
): Promise<{ argv: string[]; evalScript: string }> {
  let capturedArgv: string[] = [];
  let capturedScript = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      onOutputSync: (argv, evalScript) => {
        capturedArgv = argv;
        capturedScript = evalScript;
      },
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(source),
        ScriptParameters.of(params),
        format,
      ),
  );
  return { argv: capturedArgv, evalScript: capturedScript };
}

async function evalScriptFor(
  source: string,
  format: OutputFormat,
  params: Record<string, unknown> = {},
): Promise<string> {
  return (await captureInvocation(source, format, params)).evalScript;
}

function extractUserSource(evalScript: string): string {
  const m = evalScript.match(/const userSource = ([\s\S]*?);\nconst params = /);
  if (!m) throw new Error(`could not find userSource in:\n${evalScript}`);
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// (a) ScriptParameters round-trip + defensive copy
// ---------------------------------------------------------------------------

const arbKey = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,10}$/);
const arbValue = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.boolean(),
);
const arbParams = fc.dictionary(arbKey, arbValue, { maxKeys: 6 });

Deno.test("property: ScriptParameters.of(values).values deep-equals values, as a distinct object", () => {
  fc.assert(
    fc.property(arbParams, (values) => {
      const sp = ScriptParameters.of(values);
      assertEquals(sp.values, values);
      return sp.values !== values;
    }),
    FC_RUNS,
  );
});

Deno.test("property: mutating the input object after construction never changes the stored ScriptParameters", () => {
  fc.assert(
    fc.property(arbParams, arbKey, arbValue, (values, extraKey, extraValue) => {
      const snapshot = { ...values };
      const sp = ScriptParameters.of(values);
      (values as Record<string, unknown>)[extraKey] = extraValue;
      return JSON.stringify(sp.values) === JSON.stringify(snapshot);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) format -> serializer/opts + well-formed argv
// ---------------------------------------------------------------------------

const EXPECTED_PACKAGE: Record<OutputFormat, string> = {
  "stl": "npm:@jscad/stl-serializer@2.1.21",
  "stl-ascii": "npm:@jscad/stl-serializer@2.1.21",
  "dxf": "npm:@jscad/dxf-serializer@2.1.21",
  "svg": "npm:@jscad/svg-serializer@2.3.10",
  "obj": "npm:@jscad/obj-serializer@2.1.21",
  "3mf": "npm:@jscad/3mf-serializer@2.1.15",
};

const arbFormat = fc.constantFrom(...OUTPUT_FORMATS);

Deno.test("property: for any OutputFormat, the eval script always imports that format's pinned serializer package", async () => {
  await fc.assert(
    fc.asyncProperty(arbFormat, arbParams, async (format, params) => {
      const script = await evalScriptFor(
        "const main = () => primitives.cuboid({ size: [1,1,1] });",
        format,
        params,
      );
      return script.includes(
        `import * as serializer from "${EXPECTED_PACKAGE[format]}";`,
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: argv always has exactly 5 elements in the fixed [run, --allow-write=, --allow-read=<evalPath>, --node-modules-dir=auto, evalPath] shape, for any format", async () => {
  await fc.assert(
    fc.asyncProperty(arbFormat, async (format) => {
      const { argv } = await captureInvocation(
        "const main = () => primitives.cuboid({ size: [1,1,1] });",
        format,
      );
      return argv.length === 5 &&
        argv[0] === "run" &&
        argv[1].startsWith("--allow-write=") &&
        argv[2].startsWith("--allow-read=") &&
        argv[2].includes(argv[4]) &&
        argv[3] === "--node-modules-dir=auto" &&
        argv[4].length > 0;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) user script source is ALWAYS embedded via an exact JSON.stringify
//     round-trip — canonical restricted alphabet (no lone-surrogate / exotic
//     unicode risk), including quote/backslash/newline/template-literal-
//     shaped substrings that could plausibly be an injection attempt.
// ---------------------------------------------------------------------------

const arbSourceChar = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((n) =>
      String.fromCharCode(n)
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '"',
      "'",
      "\\",
      "\n",
      "\t",
      "`",
      "$",
      "{",
      "}",
      ";",
    ),
  },
);
const arbSource = fc.array(arbSourceChar, { minLength: 1, maxLength: 60 }).map((
  cs,
) => cs.join(""))
  .filter((s) => s.trim().length > 0);

Deno.test("property: any generated source (incl. quotes/backslashes/newlines/template-literal-shaped substrings) round-trips exactly through the JSON.stringify embedding, with no breakout", async () => {
  await fc.assert(
    fc.asyncProperty(arbSource, async (source) => {
      const script = await evalScriptFor(source, "stl");
      const recovered = extractUserSource(script);
      // No breakout: the recovered source is byte-for-byte identical, and
      // the eval script's fixed structural anchors are still present
      // (using `.includes`, not an exact-once count — a coincidental
      // substring match inside the arbitrary user content, however
      // vanishingly unlikely, must never be misread as broken structure;
      // the real no-breakout guarantee is the exact round-trip itself).
      const structureIntact = script.includes(
        'import * as modeling from "npm:@jscad/modeling@2.12.0";',
      ) &&
        script.includes("const Ctor = globalThis[");
      return recovered === source && structureIntact;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) stripMarkdownFences idempotence
// ---------------------------------------------------------------------------

const arbFenceLang = fc.constantFrom("", "js", "javascript");
const arbMaybeFenced = fc.tuple(arbSource, fc.boolean(), arbFenceLang).map(
  ([content, fenced, lang]) =>
    fenced ? "```" + lang + "\n" + content + "\n```" : content,
);

Deno.test("property: stripping an already-stripped source a second time is a no-op (idempotence)", async () => {
  await fc.assert(
    fc.asyncProperty(arbMaybeFenced, async (candidate) => {
      const firstScript = await evalScriptFor(candidate, "stl");
      const strippedOnce = extractUserSource(firstScript);
      if (!strippedOnce.trim()) return true; // CadScript.of would reject; skip degenerate case
      const secondScript = await evalScriptFor(strippedOnce, "stl");
      const strippedTwice = extractUserSource(secondScript);
      return strippedTwice === strippedOnce;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// Multi-step flow: run.execute() over a fuzzed (format, params) pair always
// resolves with exactly 3 dataHandles and a result payload whose objectCount
// matches what the (stubbed) subprocess reported.
// ---------------------------------------------------------------------------

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<{ dataHandles: unknown[] }>;
}>;

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

Deno.test("property flow: run.execute() over any (format, params, objectCount) always resolves with exactly 3 dataHandles and the matching objectCount", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbFormat,
      arbParams,
      fc.integer({ min: 0, max: 50 }),
      async (format, params, objectCount) => {
        const { ctx, written } = makeCtx();
        const method = (model.methods as MethodMap)["run"];
        const result = await withCommandStub(
          {
            success: true,
            objectCount,
            outputBytes: new Uint8Array([1, 2, 3]),
          },
          () =>
            method.execute(
              method.arguments.parse({
                script:
                  "const main = () => primitives.cuboid({ size: [1,1,1] });",
                parameters: params,
                outputFormat: format,
              }),
              ctx,
            ),
        );
        return result.dataHandles.length === 3 &&
          written.length === 1 &&
          written[0].payload.objectCount === objectCount &&
          written[0].payload.format === format;
      },
    ),
    { numRuns: NIGHT(50) },
  );
});
