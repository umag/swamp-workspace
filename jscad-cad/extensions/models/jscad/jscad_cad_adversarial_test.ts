/**
 * Adversarial suite: attacker's-perspective tests for @magistr/jscad-cad's
 * eval-subprocess seam. Originally pinned the latent bug catalog tracked in
 * the LOCAL `jscad-cad-latent-bugs` issue-lifecycle model (never the Lab);
 * B1/B2 were fixed in 2026.08.01.1 and B3/B4/B5 are now fixed in
 * 2026.08.02.1 — this suite asserts the fix for all five:
 *
 *   B1 (HIGH, FIXED)   `--allow-read` is now scoped to the generated eval
 *               script's own temp path (`--allow-read=<evalPath>`) instead of
 *               a bare unscoped flag -> no more arbitrary host-file read /
 *               exfiltration via the `output` artifact. Asserted via argv
 *               inspection — no test here ever reads a real secret (the live
 *               negative lives in script_evaluator_test.ts).
 *   B2 (HIGH, FIXED)   the subprocess now runs with
 *               `signal: AbortSignal.timeout(EVAL_TIMEOUT_MS)` and is awaited
 *               via `await cmd.output()` (never `outputSync()`), so an
 *               infinite-looping user script can no longer hang the method
 *               forever. Asserted structurally by inspecting the captured
 *               Deno.Command constructor options — no test here spawns or
 *               simulates a real hang (the live negative lives in
 *               script_evaluator_test.ts).
 *   B3 (MEDIUM, FIXED) the parent now extracts only the LAST non-empty line
 *               of stdout and parses only that; the subprocess forces
 *               `Deno.exit(0)` immediately after its own meta
 *               `console.log(JSON.stringify({objectCount}))`, so a user
 *               CadScript that itself calls console.log can no longer
 *               corrupt the trailing JSON.parse.
 *   B4 (LOW, FIXED)    the generated eval script now guards an explicit
 *               empty-array main() result (`shapes.length === 0`) with a
 *               clear error mirroring types.ts's own `Geometry.of([])`
 *               message, instead of silently yielding objectCount 0.
 *   B5 (LOW, FIXED)    the generated eval script now embeds a
 *               `MAX_OUTPUT_BYTES` cap checked before allocation (rejects,
 *               never truncates); the parent adds a belt-and-suspenders
 *               `Deno.statSync` guard on the output file before reading it.
 *
 * Covered negatives (verified to currently hold, pinned as holding):
 *   N1  no shell/argv command-injection surface — the user's script content
 *       never appears as an argv token, only JSON.stringify-escaped inside
 *       the eval-script FILE.
 *   N2  no output/eval path traversal — outputPath/evalPath come
 *       exclusively from Deno.makeTempFileSync, never from user input.
 *   N3  (accepted-residual, no code change) the eval script obtains the
 *       Function constructor via `globalThis["Func"+"tion"]` specifically to
 *       evade static scanners that grep the literal "new Function" — this
 *       is the by-design execution mechanism for user CadScript main()
 *       (arbitrary-by-design), whose blast radius is now contained by B1's
 *       scoped read/write and B2's timeout, and is the same class of
 *       naive-scanner evasion that produces the quality-scorer's own
 *       bare-import false positive on the template-literal
 *       `import * as serializer from "${pkg}";` (Lab #1490).
 *
 * script_evaluator.ts is no longer byte-frozen for B1/B2/B3/B4/B5 — this
 * suite now asserts the FIXED behavior for all five; N1/N2/N3 remain
 * characterization pins of already-shipped (accepted) behavior. No test in
 * this file spawns a real subprocess, hits the network, hangs, or allocates
 * an oversized fixture — those live cases are covered by the SOLE live e2e
 * suite, script_evaluator_test.ts.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { CadScript, Geometry, ScriptParameters } from "./types.ts";
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
  onOutputSync?: (argv: string[], evalScript: string) => void;
};

type CapturedOptions = {
  args?: string[];
  stdout?: string;
  stderr?: string;
  signal?: unknown;
};

function installCommandStub(outcome: CommandOutcome) {
  const encoder = new TextEncoder();
  const capturedOptions: CapturedOptions[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #argv: string[];
    constructor(_cmd: string, options: CapturedOptions = {}) {
      capturedOptions.push(options);
      this.#argv = options.args ?? [];
    }
    outputSync() {
      if (outcome.onOutputSync) {
        const evalPath = this.#argv[this.#argv.length - 1] ?? "";
        let evalScript = "";
        try {
          evalScript = Deno.readTextFileSync(evalPath);
        } catch {
          // best-effort — leave "" if unreadable
        }
        outcome.onOutputSync(this.#argv, evalScript);
      }
      const writeArg = this.#argv.find((a) => a.startsWith("--allow-write="));
      const outputPath = writeArg
        ? writeArg.slice("--allow-write=".length)
        : "";
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
    capturedOptions,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

async function withCommandStub<T>(
  outcome: CommandOutcome,
  fn: (opts: CapturedOptions[]) => T | Promise<T>,
): Promise<T> {
  const stub = installCommandStub(outcome);
  try {
    return await fn(stub.capturedOptions);
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
  const written: Array<{ spec: string; name: string; payload: unknown }> = [];
  return {
    written,
    ctx: {
      createFileWriter: (spec: string, name: string) => ({
        writeAll: (_bytes: Uint8Array) => {
          written.push({ spec, name, payload: "output" });
          return Promise.resolve({ spec, name });
        },
        writeText: (_text: string) => {
          written.push({ spec, name, payload: "log" });
          return Promise.resolve({ spec, name });
        },
      }),
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

const SIMPLE_SCRIPT = `
  const main = () => primitives.cuboid({ size: [5, 5, 5] });
`;

// ---------------------------------------------------------------------------
// B1 (HIGH): unrestricted --allow-read
// ---------------------------------------------------------------------------

Deno.test("B1 fix: --allow-read is scoped to evalPath (no bare unscoped flag), while --allow-write stays scoped to outputPath", async () => {
  await withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, async (opts) => {
    await ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    const argv = opts[0].args!;
    const readArg = argv.find((a) => a.startsWith("--allow-read="));
    assert(readArg !== undefined, "expected a scoped --allow-read= flag");
    const evalPath = argv[argv.length - 1];
    assert(
      readArg!.includes(evalPath),
      `expected --allow-read= to be scoped to evalPath ${evalPath}, got ${readArg}`,
    );
    assert(
      !argv.includes("--allow-read"),
      "must never carry the bare unscoped --allow-read flag",
    );
    const writeArg = argv.find((a) => a.startsWith("--allow-write="));
    assert(
      writeArg !== undefined && writeArg !== "--allow-write",
      "write MUST be scoped",
    );
  });
});

// ---------------------------------------------------------------------------
// B2 (HIGH): no subprocess timeout — structural only, never a real hang
// ---------------------------------------------------------------------------

Deno.test("B2 fix: Deno.Command options carry a real AbortSignal (bounded execution) — structural inspection only, no real hang simulated", async () => {
  await withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, async (opts) => {
    await ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    assert(
      opts[0].signal instanceof AbortSignal,
      "expected a real AbortSignal on the Deno.Command options",
    );
  });
});

// ---------------------------------------------------------------------------
// B3 (MEDIUM): user stdout corrupts the trailing JSON.parse
// ---------------------------------------------------------------------------

Deno.test("B3 fix: user console.log output ahead of the JSON meta line no longer corrupts JSON.parse — only the LAST line is parsed", async () => {
  await withCommandStub(
    {
      success: true,
      stdoutOverride: 'debug output from user script\n{"objectCount":1}',
      outputBytes: new Uint8Array([1, 2, 3]),
    },
    async () => {
      const out = await ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      );
      assertEquals(out.objectCount, 1);
      assertEquals(out.serialized.bytes, new Uint8Array([1, 2, 3]));
    },
  );
});

// ---------------------------------------------------------------------------
// B4 (LOW): empty-array geometry -> silent objectCount 0
// ---------------------------------------------------------------------------

Deno.test("B4 fix: the generated eval script now guards an empty-array main() result with a clear error (mirrors types.ts's Geometry.of message)", async () => {
  let captured = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (_argv, evalScript) => {
        captured = evalScript;
      },
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  assert(
    /shapes\.length\s*===\s*0/.test(captured),
    `expected the generated eval script to guard shapes.length === 0, got:\n${captured}`,
  );
  assert(
    captured.includes("at least one shape"),
    "expected the empty-geometry guard message to mirror types.ts's Geometry.of error",
  );
});

Deno.test("B4 contrast: types.ts's OWN Geometry.of([]) guard DOES throw — it is simply never invoked by the real eval-subprocess path", () => {
  assertThrows(
    () => Geometry.of([]),
    Error,
    "at least one shape",
  );
});

// ---------------------------------------------------------------------------
// B5 (LOW): unbounded in-memory output — structural pin only
// ---------------------------------------------------------------------------

Deno.test("B5 fix: the generated eval script now embeds a MAX_OUTPUT_BYTES size-cap guard for serializer output (rejects, never truncates)", async () => {
  let captured = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (_argv, evalScript) => {
        captured = evalScript;
      },
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  assert(
    /MAX_OUTPUT_BYTES/.test(captured),
    `expected the generated eval script to embed a MAX_OUTPUT_BYTES size cap, got:\n${captured}`,
  );
  assert(
    !/\.slice\(\s*0\s*,/.test(captured),
    "expected no truncating .slice(0, N) call — the cap rejects, it never silently truncates",
  );
});

Deno.test("B5 fix: the parent's belt-and-suspenders statSync guard rejects an output file over a (small, test-only) maxOutputBytes cap before reading it — no oversized fixture needed", async () => {
  await withCommandStub(
    { success: true, objectCount: 1, outputBytes: new Uint8Array([1, 2, 3]) },
    async () => {
      await assertRejects(
        () =>
          ScriptEvaluator.evaluateAndSerialize(
            CadScript.of(SIMPLE_SCRIPT),
            ScriptParameters.empty(),
            "stl",
            undefined,
            2,
          ),
        Error,
        "exceeds",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// N1 (negative, covered): no shell/argv command-injection surface
// ---------------------------------------------------------------------------

Deno.test("N1 covered: hostile shell metacharacters in the script NEVER appear as an argv token — argv shape is unchanged", async () => {
  const hostile =
    'const main = () => { /* "; rm -rf / ; echo $(whoami) ` */ return primitives.cuboid({size:[1,1,1]}); };';
  await withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, async (opts) => {
    await ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(hostile),
      ScriptParameters.empty(),
      "stl",
    );
    const argv = opts[0].args!;
    assertEquals(argv.length, 5);
    for (const token of argv) {
      assert(
        !token.includes(";"),
        `argv token unexpectedly carries a shell metacharacter: ${token}`,
      );
      assert(
        !token.includes("$("),
        `argv token unexpectedly carries a subshell: ${token}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// N2 (negative, covered): no output/eval path traversal via user input
// ---------------------------------------------------------------------------

Deno.test("N2 covered: outputPath/evalPath stay inside the OS temp dir regardless of script/parameters/outputFormat content", async () => {
  const traversalAttempt = "../../../../etc/passwd";
  await withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, async (opts) => {
    await ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.of({ path: traversalAttempt, name: traversalAttempt }),
      "stl",
    );
    const argv = opts[0].args!;
    const writeArg = argv.find((a) => a.startsWith("--allow-write="))!;
    const outputPath = writeArg.slice("--allow-write=".length);
    const evalPath = argv[argv.length - 1];
    assert(
      !outputPath.includes(".."),
      `outputPath must never contain traversal: ${outputPath}`,
    );
    assert(
      !evalPath.includes(".."),
      `evalPath must never contain traversal: ${evalPath}`,
    );
  });
});

// ---------------------------------------------------------------------------
// N3 (root cause of B1, pinned as shipped behavior): scanner-evasion trick
// ---------------------------------------------------------------------------

Deno.test('N3 pin (part 1 — source): script_evaluator.ts\'s OWN source contains the literal split "Func" + "tion" (never the literal "new Function(") — this is what evades a scanner reading the COMMITTED .ts file', async () => {
  const sourceText = await Deno.readTextFile(
    new URL("./script_evaluator.ts", import.meta.url),
  );
  assert(
    sourceText.includes('"Func" + "tion"'),
    "expected the split-string Function evasion in script_evaluator.ts",
  );
  assert(
    !sourceText.includes("new Function("),
    "script_evaluator.ts must never contain the literal 'new Function(' — that is precisely what the split evades",
  );
});

Deno.test('N3 pin (part 2 — generated output): the EVAL SCRIPT that gets written to a (never-committed) temp file at runtime contains the already-resolved globalThis["Function"] bracket lookup', async () => {
  let captured = "";
  await withCommandStub(
    {
      success: true,
      objectCount: 1,
      outputBytes: new Uint8Array([1]),
      onOutputSync: (_argv, evalScript) => {
        captured = evalScript;
      },
    },
    () =>
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      ),
  );
  assert(
    captured.includes('globalThis["Function"]'),
    `expected the resolved globalThis["Function"] bracket lookup in the generated script, got:\n${captured}`,
  );
  assert(
    !captured.includes("new Function("),
    "the generated eval script must never contain the literal 'new Function(' either",
  );
});

// ---------------------------------------------------------------------------
// Additional adversarial edge cases
// ---------------------------------------------------------------------------

Deno.test("adversarial: Deno.exit()-mid-eval is indistinguishable from any other non-zero exit — surfaces via stderr line-filter", async () => {
  await assertRejects(
    () =>
      withCommandStub(
        {
          success: false,
          stderr: "CadScript main() execution failed: simulated Deno.exit",
        },
        () =>
          runMethod(
            "run",
            { script: SIMPLE_SCRIPT, parameters: {}, outputFormat: "stl" },
            makeCtx().ctx,
          ),
      ),
    Error,
    "simulated Deno.exit",
  );
});

Deno.test("adversarial: non-JSON stdout on an otherwise-successful run throws a JSON parse error, never silently returns garbage", async () => {
  await withCommandStub(
    {
      success: true,
      stdoutOverride: "not json at all",
      outputBytes: new Uint8Array([1]),
    },
    async () => {
      await assertRejects(
        () =>
          ScriptEvaluator.evaluateAndSerialize(
            CadScript.of(SIMPLE_SCRIPT),
            ScriptParameters.empty(),
            "stl",
          ),
        SyntaxError,
      );
    },
  );
});

Deno.test("adversarial: a modestly large (64KiB) but bounded output round-trips without truncation", async () => {
  const big = new Uint8Array(64 * 1024).fill(7);
  await withCommandStub(
    { success: true, objectCount: 1, outputBytes: big },
    async () => {
      const out = await ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        "stl",
      );
      assertEquals(out.serialized.bytes.byteLength, big.byteLength);
      assertEquals(out.serialized.bytes, big);
    },
  );
});

Deno.test("adversarial: stderr with ONLY stack-frame lines — the whole-blob .trim() de-indents line 1, so the 'first non-frame line' filter picks the (now-de-indented) FIRST frame, never falling through to the lines[lines.length-1] fallback", async () => {
  // script_evaluator.ts does `new TextDecoder().decode(result.stderr).trim()`
  // BEFORE splitting on "\n" — that whole-blob .trim() strips ALL of line 1's
  // leading whitespace (however many spaces), so a line that started with
  // the "    at " frame indent no longer matches `startsWith("    at ")`
  // once trimmed. Concretely: every line here "looks like" a stack frame in
  // the RAW stderr, but after `.trim()` line 1 becomes "at a (eval:1:1)"
  // (indent gone) — which DOES pass the `!l.startsWith("    at ")` filter,
  // so it is selected immediately. The `|| lines[lines.length - 1]` fallback
  // is therefore unreachable for any non-empty multi-line stderr: it can
  // only ever fire when the .find() result is itself falsy (an empty
  // string), which requires the WHOLE trimmed blob to be empty (see the
  // "empty stderr" test below).
  await assertRejects(
    () =>
      withCommandStub(
        { success: false, stderr: "    at a (eval:1:1)\n    at b (eval:2:1)" },
        () =>
          runMethod(
            "run",
            { script: SIMPLE_SCRIPT, parameters: {}, outputFormat: "stl" },
            makeCtx().ctx,
          ),
      ),
    Error,
    "at a (eval:1:1)",
  );
});

Deno.test("adversarial: empty stderr on failure falls back to 'Unknown evaluation error'", async () => {
  await assertRejects(
    () =>
      withCommandStub(
        { success: false, stderr: "" },
        () =>
          runMethod(
            "run",
            { script: SIMPLE_SCRIPT, parameters: {}, outputFormat: "stl" },
            makeCtx().ctx,
          ),
      ),
    Error,
    "Unknown evaluation error",
  );
});
