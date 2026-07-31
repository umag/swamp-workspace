/**
 * Contract-fixture suite (role 3 of 3 for this role — the other two are the
 * kept extensions/models/jscad/script_evaluator_test.ts, a LIVE
 * deno-subprocess + npm-network integration suite and the SOLE e2e pin, and
 * extensions/models/jscad/types_test.ts). This file pins the WIRE SHAPE of
 * the eval script that ScriptEvaluator.evaluateAndSerialize generates and
 * hands to the nested `deno run` subprocess — the exact argv, the
 * per-format serializer package + serialize() options, the
 * JSON.stringify-escaped embedding of the user's script source and
 * parameters, and markdown-fence stripping — WITHOUT ever spawning a real
 * process or touching the network.
 *
 * script_evaluator.ts is BYTE-FROZEN — every test here characterizes
 * already-shipped behavior; it is not red-green TDD.
 *
 * Seam: only `globalThis.Deno.Command` is stubbed (installed via
 * `(globalThis as any).Deno.Command =`, restored in a `finally`). The real
 * `Deno.makeTempFileSync` / `writeTextFileSync` / `readFileSync` /
 * `removeSync` all run for real against the OS temp directory —
 * `ScriptEvaluator.evaluateAndSerialize` writes the real eval-script file
 * before the stub ever sees it, and the stub reads that real file back (via
 * the real `Deno.readTextFileSync`) purely so these tests can assert on its
 * contents.
 *
 * Toolchain rule (deno 2.8.3): no `as typeof Deno.Command` cast anywhere —
 * the single sanctioned `// deno-lint-ignore no-explicit-any` sits on the
 * line that installs the fake.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  CadScript,
  OUTPUT_FORMATS,
  type OutputFormat,
  ScriptParameters,
} from "./types.ts";
import { ScriptEvaluator } from "./script_evaluator.ts";

// ---------------------------------------------------------------------------
// Harness — see file header for the seam boundary this stub sits on.
// ---------------------------------------------------------------------------

type CommandOutcome = {
  success: boolean;
  objectCount?: number;
  stdoutOverride?: string;
  stderr?: string;
  outputBytes?: Uint8Array;
  outputText?: string;
  skipWrite?: boolean;
};

type CommandInvocation = {
  argv: string[];
  options: Record<string, unknown>;
  evalScript: string;
  outputPath: string;
};

function installCommandStub(
  outcome:
    | CommandOutcome
    | ((inv: { argv: string[]; evalScript: string }) => CommandOutcome),
) {
  const encoder = new TextEncoder();
  const invocations: CommandInvocation[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #argv: string[];
    #options: Record<string, unknown>;
    constructor(_cmd: string, options: Record<string, unknown> = {}) {
      this.#options = options;
      this.#argv = (options.args as string[] | undefined) ?? [];
    }
    outputSync() {
      const evalPath = this.#argv[this.#argv.length - 1] ?? "";
      let evalScript = "";
      try {
        evalScript = Deno.readTextFileSync(evalPath);
      } catch {
        // best-effort — an unreadable evalPath just yields "" for asserts
      }
      const writeArg = this.#argv.find((a) => a.startsWith("--allow-write="));
      const outputPath = writeArg
        ? writeArg.slice("--allow-write=".length)
        : "";
      invocations.push({
        argv: this.#argv,
        options: this.#options,
        evalScript,
        outputPath,
      });

      const o = typeof outcome === "function"
        ? outcome({ argv: this.#argv, evalScript })
        : outcome;

      if (o.success && !o.skipWrite && outputPath) {
        if (o.outputBytes) {
          Deno.writeFileSync(outputPath, o.outputBytes);
        } else if (o.outputText !== undefined) {
          Deno.writeTextFileSync(outputPath, o.outputText);
        } else {
          Deno.writeFileSync(outputPath, new Uint8Array([0, 1, 2, 3]));
        }
      }

      const stdoutStr = o.stdoutOverride ??
        JSON.stringify({ objectCount: o.objectCount ?? 1 });
      return {
        success: o.success,
        code: o.success ? 0 : 1,
        stdout: encoder.encode(o.success ? stdoutStr : ""),
        stderr: encoder.encode(o.stderr ?? ""),
      };
    }
  }
  g.Deno.Command = FakeCommand;
  return {
    invocations,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

function withCommandStub<T>(
  outcome:
    | CommandOutcome
    | ((inv: { argv: string[]; evalScript: string }) => CommandOutcome),
  fn: (stub: ReturnType<typeof installCommandStub>) => T,
): T {
  const stub = installCommandStub(outcome);
  try {
    return fn(stub);
  } finally {
    stub.restore();
  }
}

const SIMPLE_SCRIPT = `
  const main = () => primitives.cuboid({ size: [5, 5, 5] });
`;

// ---------------------------------------------------------------------------
// argv shape — identical across all 6 formats
// ---------------------------------------------------------------------------

Deno.test("contract: argv is exactly [run, --allow-write=<outputPath>, --allow-read, --node-modules-dir=auto, <evalPath>]", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    assertEquals(stub.invocations.length, 1);
    const { argv } = stub.invocations[0];
    assertEquals(argv.length, 5);
    assertEquals(argv[0], "run");
    assert(argv[1].startsWith("--allow-write="));
    assertEquals(argv[2], "--allow-read");
    assertEquals(argv[3], "--node-modules-dir=auto");
    assert(argv[4].length > 0);
  });
});

Deno.test("contract: outputPath carries a .bin suffix and evalPath a .mjs suffix (Deno.makeTempFileSync options)", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    const { argv, outputPath } = stub.invocations[0];
    assert(
      outputPath.endsWith(".bin"),
      `expected .bin suffix, got ${outputPath}`,
    );
    const evalPath = argv[argv.length - 1];
    assert(evalPath.endsWith(".mjs"), `expected .mjs suffix, got ${evalPath}`);
  });
});

Deno.test("contract: outputPath and evalPath are distinct temp files", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    const { argv, outputPath } = stub.invocations[0];
    assertNotEquals(outputPath, argv[argv.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Per-format serializer package + serialize() options pin
// ---------------------------------------------------------------------------

const EXPECTED_PACKAGE: Record<OutputFormat, string> = {
  "stl": "npm:@jscad/stl-serializer@2.1.21",
  "stl-ascii": "npm:@jscad/stl-serializer@2.1.21",
  "dxf": "npm:@jscad/dxf-serializer@2.1.21",
  "svg": "npm:@jscad/svg-serializer@2.3.10",
  "obj": "npm:@jscad/obj-serializer@2.1.21",
  "3mf": "npm:@jscad/3mf-serializer@2.1.15",
};

const EXPECTED_OPTS: Record<OutputFormat, string> = {
  "stl": "{ binary: true }",
  "stl-ascii": "{ binary: false }",
  "dxf": "{}",
  "svg": "{}",
  "obj": "{}",
  "3mf": "{}",
};

for (const format of OUTPUT_FORMATS) {
  Deno.test(`contract: format "${format}" imports ${EXPECTED_PACKAGE[format]} and serializes with ${EXPECTED_OPTS[format]}`, () => {
    withCommandStub({ success: true, objectCount: 1 }, (stub) => {
      ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.empty(),
        format,
      );
      const { evalScript } = stub.invocations[0];
      assert(
        evalScript.includes(
          `import * as serializer from "${EXPECTED_PACKAGE[format]}";`,
        ),
        `expected serializer import for ${format}, got:\n${evalScript}`,
      );
      assert(
        evalScript.includes(`serializer.serialize(${EXPECTED_OPTS[format]}, `),
        `expected serialize(${
          EXPECTED_OPTS[format]
        }, ...) for ${format}, got:\n${evalScript}`,
      );
    });
  });
}

Deno.test("contract: every eval script imports npm:@jscad/modeling@2.12.0 as modeling", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "svg",
    );
    assert(
      stub.invocations[0].evalScript.includes(
        'import * as modeling from "npm:@jscad/modeling@2.12.0";',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// User script source is ALWAYS embedded via an exact JSON.stringify round-trip
// ---------------------------------------------------------------------------

Deno.test("contract: hostile-looking source (quotes, backslashes, backticks, newlines) round-trips exactly through JSON.stringify embedding", () => {
  const hostile =
    'const main = () => { const s = "a\\"b\\\\c`d\ne"; return primitives.cuboid({ size: [1,1,1] }); };';
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(hostile),
      ScriptParameters.empty(),
      "stl",
    );
    const { evalScript } = stub.invocations[0];
    const m = evalScript.match(
      /const userSource = ([\s\S]*?);\nconst params = /,
    );
    assert(
      m !== null,
      `expected to find userSource literal in:\n${evalScript}`,
    );
    const recovered = JSON.parse(m![1]);
    assertEquals(recovered, hostile);
  });
});

Deno.test("contract: unicode source is embedded and recovered byte-for-byte", () => {
  const source =
    `const main = () => { const label = "éèê😀"; return primitives.cuboid({ size: [1,1,1] }); };`;
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(source),
      ScriptParameters.empty(),
      "stl",
    );
    const m = stub.invocations[0].evalScript.match(
      /const userSource = ([\s\S]*?);\nconst params = /,
    );
    assert(m !== null);
    assertEquals(JSON.parse(m![1]), source);
  });
});

Deno.test("contract: parameters are embedded as JSON.stringify(values), not re-escaped", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.of({ size: 20, label: 'quote"inside' }),
      "stl",
    );
    const { evalScript } = stub.invocations[0];
    const m = evalScript.match(/const params = ([\s\S]*?);\nconst Ctor = /);
    assert(m !== null, `expected params literal in:\n${evalScript}`);
    assertEquals(JSON.parse(m![1]), { size: 20, label: 'quote"inside' });
  });
});

Deno.test("contract: empty parameters embed as {}", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    const m = stub.invocations[0].evalScript.match(
      /const params = ([\s\S]*?);\nconst Ctor = /,
    );
    assert(m !== null);
    assertEquals(m![1], "{}");
  });
});

// ---------------------------------------------------------------------------
// Markdown fence stripping — pinned via the eval script's embedded userSource
// ---------------------------------------------------------------------------

Deno.test("contract: a fenced source (with language tag) is stripped to its inner content before embedding", () => {
  const inner = "const main = () => primitives.cuboid({ size: [5, 5, 5] });\n";
  const fenced = "```javascript\n" + inner + "```";
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(fenced),
      ScriptParameters.empty(),
      "stl",
    );
    const m = stub.invocations[0].evalScript.match(
      /const userSource = ([\s\S]*?);\nconst params = /,
    );
    assert(m !== null);
    assertEquals(JSON.parse(m![1]), inner);
  });
});

Deno.test("contract: a fenced source WITHOUT a language tag is also stripped", () => {
  const inner = "const main = () => primitives.cuboid({ size: [5, 5, 5] });\n";
  const fenced = "```\n" + inner + "```";
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(fenced),
      ScriptParameters.empty(),
      "stl",
    );
    const m = stub.invocations[0].evalScript.match(
      /const userSource = ([\s\S]*?);\nconst params = /,
    );
    assert(m !== null);
    assertEquals(JSON.parse(m![1]), inner);
  });
});

Deno.test("contract: a non-fenced source is embedded completely unchanged", () => {
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    const m = stub.invocations[0].evalScript.match(
      /const userSource = ([\s\S]*?);\nconst params = /,
    );
    assert(m !== null);
    assertEquals(JSON.parse(m![1]), SIMPLE_SCRIPT);
  });
});

Deno.test("contract: stripMarkdownFences is idempotent (fenced-once === fenced-twice's inner content)", () => {
  const inner = "const main = () => primitives.cuboid({ size: [5, 5, 5] });\n";
  const oneFence = "```js\n" + inner + "```";
  withCommandStub({ success: true, objectCount: 1 }, (stub) => {
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(oneFence),
      ScriptParameters.empty(),
      "stl",
    );
    const strippedOnce = JSON.parse(
      stub.invocations[0].evalScript.match(
        /const userSource = ([\s\S]*?);\nconst params = /,
      )![1],
    );
    assertEquals(strippedOnce, inner);

    // Feeding the already-stripped content back through produces no further
    // change (it no longer matches the fence pattern at all).
    ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(strippedOnce),
      ScriptParameters.empty(),
      "stl",
    );
    const strippedTwice = JSON.parse(
      stub.invocations[1].evalScript.match(
        /const userSource = ([\s\S]*?);\nconst params = /,
      )![1],
    );
    assertEquals(strippedTwice, strippedOnce);
  });
});
