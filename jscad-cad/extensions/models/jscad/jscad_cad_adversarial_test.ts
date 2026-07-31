/**
 * Adversarial suite: attacker's-perspective tests for @magistr/jscad-cad's
 * eval-subprocess seam. Pins the latent bug catalog tracked in the LOCAL
 * `jscad-cad-latent-bugs` issue-lifecycle model (never the Lab):
 *
 *   B1 (HIGH)   unrestricted `--allow-read` (no path scope) on the nested
 *               `deno run` subprocess -> arbitrary host-file read,
 *               exfiltratable via the `output` artifact. Pinned via argv
 *               inspection ONLY — no test here ever reads a real secret.
 *   B2 (HIGH)   no subprocess timeout/signal -> an infinite-looping user
 *               script hangs the method forever. Pinned STRUCTURALLY by
 *               inspecting the captured Deno.Command constructor options —
 *               no test ever spawns or simulates a real hang.
 *   B3 (MEDIUM) the subprocess's single stdout stream carries both its own
 *               final `console.log(JSON.stringify({objectCount}))` and
 *               anything the user's CadScript itself logs, so a script that
 *               calls console.log corrupts the trailing JSON.parse.
 *   B4 (LOW)    a main() returning [] yields objectCount 0 silently.
 *   B5 (LOW)    unbounded in-memory output — pinned structurally (no
 *               truncation/chunking logic exists in the generated script;
 *               no large fixture is ever allocated here).
 *
 * Covered negatives (verified to currently hold, pinned as holding):
 *   N1  no shell/argv command-injection surface — the user's script content
 *       never appears as an argv token, only JSON.stringify-escaped inside
 *       the eval-script FILE.
 *   N2  no output/eval path traversal — outputPath/evalPath come
 *       exclusively from Deno.makeTempFileSync, never from user input.
 *   N3  the eval script obtains the Function constructor via
 *       `globalThis["Func"+"tion"]` specifically to evade static scanners
 *       that grep the literal "new Function" — this is the ROOT CAUSE of
 *       B1's arbitrary-code-execution surface, and the same class of
 *       naive-scanner evasion that produces the quality-scorer's own
 *       bare-import false positive on the template-literal
 *       `import * as serializer from "${pkg}";`.
 *
 * script_evaluator.ts is BYTE-FROZEN — every test here PINS current
 * behavior (including behavior that is arguably risky), it does not fix
 * anything. No test in this file spawns a real subprocess, hits the
 * network, hangs, or allocates an oversized fixture.
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
  }
  g.Deno.Command = FakeCommand;
  return {
    capturedOptions,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

function withCommandStub<T>(
  outcome: CommandOutcome,
  fn: (opts: CapturedOptions[]) => T,
): T {
  const stub = installCommandStub(outcome);
  try {
    return fn(stub.capturedOptions);
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

Deno.test("B1 pin: --allow-read carries NO path scope (full host filesystem read), while --allow-write IS scoped to outputPath", () => {
  withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, (opts) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    const argv = opts[0].args!;
    const readArg = argv.find((a) =>
      a === "--allow-read" || a.startsWith("--allow-read=")
    );
    assert(readArg !== undefined, "expected an --allow-read flag");
    assertEquals(
      readArg,
      "--allow-read",
      "must have NO =path scope — full filesystem read",
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

Deno.test("B2 pin: Deno.Command options carry no signal/timeout — structural inspection only, no real hang simulated", () => {
  withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, (opts) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    assertEquals(opts[0].signal, undefined);
  });
});

// ---------------------------------------------------------------------------
// B3 (MEDIUM): user stdout corrupts the trailing JSON.parse
// ---------------------------------------------------------------------------

Deno.test("B3 pin: user console.log output ahead of the JSON line corrupts JSON.parse, even though the subprocess 'succeeded' and wrote valid output bytes", () => {
  withCommandStub(
    {
      success: true,
      stdoutOverride: 'debug output from user script\n{"objectCount":1}',
      outputBytes: new Uint8Array([1, 2, 3]),
    },
    () => {
      assertThrows(
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

// ---------------------------------------------------------------------------
// B4 (LOW): empty-array geometry -> silent objectCount 0
// ---------------------------------------------------------------------------

Deno.test("B4 pin: an empty-array result from main() yields a clean success with objectCount 0 (no error anywhere)", () => {
  withCommandStub(
    { success: true, objectCount: 0, outputBytes: new Uint8Array([0]) },
    () => {
      const out = ScriptEvaluator.evaluateAndSerialize(
        CadScript.of("const main = () => [];"),
        ScriptParameters.empty(),
        "stl",
      );
      assertEquals(out.objectCount, 0);
    },
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

Deno.test("B5 pin: the generated eval script contains no size cap / truncation / chunking logic for serializer output", () => {
  const capturedScripts: string[] = [];
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
      const evalPath = this.#argv[this.#argv.length - 1];
      capturedScripts.push(Deno.readTextFileSync(evalPath));
      const writeArg = this.#argv.find((a) => a.startsWith("--allow-write="));
      const outputPath = writeArg
        ? writeArg.slice("--allow-write=".length)
        : "";
      if (outputPath) Deno.writeFileSync(outputPath, new Uint8Array([1]));
      return {
        success: true,
        code: 0,
        stdout: encoder.encode(JSON.stringify({ objectCount: 1 })),
        stderr: new Uint8Array(),
      };
    }
  }
  g.Deno.Command = FakeCommand;
  try {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
  } finally {
    g.Deno.Command = original;
  }
  const script = capturedScripts[0];
  assert(
    !/\.slice\(\s*0\s*,/.test(script),
    "expected no truncating .slice(0, N) call",
  );
  assert(!/MAX_(BYTES|SIZE|LEN)/.test(script), "expected no size-cap constant");
});

// ---------------------------------------------------------------------------
// N1 (negative, covered): no shell/argv command-injection surface
// ---------------------------------------------------------------------------

Deno.test("N1 covered: hostile shell metacharacters in the script NEVER appear as an argv token — argv shape is unchanged", () => {
  const hostile =
    'const main = () => { /* "; rm -rf / ; echo $(whoami) ` */ return primitives.cuboid({size:[1,1,1]}); };';
  withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, (opts) => {
    ScriptEvaluator.evaluateAndSerialize(
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

Deno.test("N2 covered: outputPath/evalPath stay inside the OS temp dir regardless of script/parameters/outputFormat content", () => {
  const traversalAttempt = "../../../../etc/passwd";
  withCommandStub({
    success: true,
    objectCount: 1,
    outputBytes: new Uint8Array([1]),
  }, (opts) => {
    ScriptEvaluator.evaluateAndSerialize(
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

Deno.test('N3 pin (part 2 — generated output): the EVAL SCRIPT that gets written to a (never-committed) temp file at runtime contains the already-resolved globalThis["Function"] bracket lookup', () => {
  let captured = "";
  withCommandStub(
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

Deno.test("adversarial: non-JSON stdout on an otherwise-successful run throws a JSON parse error, never silently returns garbage", () => {
  withCommandStub(
    {
      success: true,
      stdoutOverride: "not json at all",
      outputBytes: new Uint8Array([1]),
    },
    () => {
      assertThrows(
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

Deno.test("adversarial: a modestly large (64KiB) but bounded output round-trips without truncation", () => {
  const big = new Uint8Array(64 * 1024).fill(7);
  withCommandStub({ success: true, objectCount: 1, outputBytes: big }, () => {
    const out = ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    assertEquals(out.serialized.bytes.byteLength, big.byteLength);
    assertEquals(out.serialized.bytes, big);
  });
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
