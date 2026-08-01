/**
 * Methods suite — the single "run" method's success path (all 6
 * OutputFormats) and its eval-failure path, driven through
 * `model.methods.run.arguments.parse()` + `.execute()` against a fake swamp
 * context, plus a couple of direct calls to
 * `ScriptEvaluator.evaluateAndSerialize` to pin its return shape
 * independently of the model layer.
 *
 * jscad_cad.ts is byte-frozen apart from the B2 fix's `await` on the
 * now-async `ScriptEvaluator.evaluateAndSerialize` call and its version
 * bump (2026.08.01.1); the tests below characterize already-shipped
 * behavior otherwise. `execute()` has no try/catch of its own around
 * `ScriptEvaluator.evaluateAndSerialize`, so an evaluation failure
 * propagates as a REJECTED promise with zero dataHandles written — that
 * characteristic is pinned explicitly below, not assumed.
 *
 * Seam: only `globalThis.Deno.Command` is stubbed; the real
 * `Deno.makeTempFileSync` / `writeTextFileSync` / `readFileSync` /
 * `removeSync` run for real. No subprocess is ever spawned, no network call
 * is made.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "../jscad_cad.ts";
import { OUTPUT_FORMATS, type OutputFormat } from "./types.ts";
import { ScriptEvaluator } from "./script_evaluator.ts";
import { CadScript, ScriptParameters } from "./types.ts";

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

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type FileWrite = {
  spec: string;
  name: string;
  kind: "bytes" | "text";
  data: Uint8Array | string;
};

function makeCtx() {
  const written: Written[] = [];
  const files: FileWrite[] = [];
  return {
    written,
    files,
    ctx: {
      createFileWriter: (spec: string, name: string) => ({
        writeAll: (bytes: Uint8Array) => {
          files.push({ spec, name, kind: "bytes", data: bytes });
          return Promise.resolve({ spec, name });
        },
        writeText: (text: string) => {
          files.push({ spec, name, kind: "text", data: text });
          return Promise.resolve({ spec, name });
        },
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

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (
    a: unknown,
    c: unknown,
  ) => Promise<{ dataHandles: unknown[] }>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

const SIMPLE_SCRIPT = `
  const main = () => primitives.cuboid({ size: [5, 5, 5] });
`;

// ---------------------------------------------------------------------------
// arguments.parse() defaults
// ---------------------------------------------------------------------------

Deno.test("run.arguments.parse: parameters defaults to {} and outputFormat defaults to stl", () => {
  const parsed = model.methods.run.arguments.parse({
    script: SIMPLE_SCRIPT,
  }) as {
    script: string;
    parameters: Record<string, unknown>;
    outputFormat: string;
  };
  assertEquals(parsed.parameters, {});
  assertEquals(parsed.outputFormat, "stl");
});

Deno.test("run.arguments.parse: rejects when script is missing", () => {
  assert(
    (() => {
      try {
        model.methods.run.arguments.parse({});
        return false;
      } catch {
        return true;
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// Success path — all 6 OutputFormats
// ---------------------------------------------------------------------------

const FORMAT_FIXTURES: Record<
  OutputFormat,
  { outputBytes?: Uint8Array; outputText?: string }
> = {
  "stl": { outputBytes: new Uint8Array([1, 2, 3, 4, 5]) },
  "3mf": { outputBytes: new Uint8Array([9, 8, 7]) },
  "stl-ascii": { outputText: "solid mesh\nendsolid mesh\n" },
  "dxf": { outputText: "0\nSECTION\n0\nENDSEC\n" },
  "svg": { outputText: "<svg></svg>" },
  "obj": { outputText: "v 0 0 0\nf 1 2 3\n" },
};

for (const format of OUTPUT_FORMATS) {
  Deno.test(`run: success path for format "${format}" writes result + output + log, in that dataHandles order`, async () => {
    const fixture = FORMAT_FIXTURES[format];
    const { ctx, written, files } = makeCtx();
    const before = Date.now();
    const result = await withCommandStub(
      { success: true, objectCount: 2, ...fixture },
      () =>
        run(
          "run",
          { script: SIMPLE_SCRIPT, parameters: {}, outputFormat: format },
          ctx,
        ),
    );
    const after = Date.now();

    assertEquals((result as { dataHandles: unknown[] }).dataHandles.length, 3);

    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "result");
    assertEquals(written[0].name, "result");
    const payload = written[0].payload;
    assertEquals(payload.success, true);
    assertEquals(payload.format, format);
    assertEquals(payload.objectCount, 2);
    assert(
      typeof payload.durationMs === "number" &&
        (payload.durationMs as number) >= 0,
    );
    assert(typeof payload.executedAt === "string");
    assert(!isNaN(Date.parse(payload.executedAt as string)));
    const executedAtMs = Date.parse(payload.executedAt as string);
    assert(executedAtMs >= before && executedAtMs <= after + 1);

    assertEquals(files.length, 2);
    assertEquals(files[0].spec, "output");
    assertEquals(files[0].kind, "bytes");
    const expectedBytes = fixture.outputBytes ??
      new TextEncoder().encode(fixture.outputText!);
    assertEquals(files[0].data as Uint8Array, expectedBytes);

    assertEquals(files[1].spec, "log");
    assertEquals(files[1].kind, "text");
    assertEquals(files[1].data, "(no warnings)");
  });
}

// ---------------------------------------------------------------------------
// Eval-failure path — no try/catch in execute(), so it rejects with zero I/O
// ---------------------------------------------------------------------------

Deno.test("run: eval failure rejects with the extracted stderr message and performs NO writes", async () => {
  const { ctx, written, files } = makeCtx();
  await assertRejects(
    () =>
      withCommandStub(
        {
          success: false,
          stderr:
            "CadScript evaluation failed: Script must define a main() function",
        },
        () =>
          run(
            "run",
            { script: "const foo = 42;", parameters: {}, outputFormat: "stl" },
            ctx,
          ),
      ),
    Error,
    "CadScript evaluation failed: Script must define a main() function",
  );
  assertEquals(written.length, 0);
  assertEquals(files.length, 0);
});

Deno.test("run: eval failure with a multi-line stack trace picks the first non-frame line", async () => {
  const { ctx, written } = makeCtx();
  const stderr = [
    "CadScript main() execution failed: boom",
    "    at main (eval:3:11)",
    "    at factory (eval:10:3)",
  ].join("\n");
  await assertRejects(
    () =>
      withCommandStub(
        { success: false, stderr },
        () =>
          run(
            "run",
            { script: SIMPLE_SCRIPT, parameters: {}, outputFormat: "stl" },
            ctx,
          ),
      ),
    Error,
    "CadScript main() execution failed: boom",
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// Direct ScriptEvaluator.evaluateAndSerialize calls (return-shape pin,
// independent of the model layer)
// ---------------------------------------------------------------------------

Deno.test("evaluateAndSerialize (direct): returns {serialized:{bytes,format}, objectCount}", async () => {
  await withCommandStub({
    success: true,
    objectCount: 3,
    outputBytes: new Uint8Array([42]),
  }, async () => {
    const out = await ScriptEvaluator.evaluateAndSerialize(
      CadScript.of(SIMPLE_SCRIPT),
      ScriptParameters.empty(),
      "stl",
    );
    assertEquals(out.objectCount, 3);
    assertEquals(out.serialized.format, "stl");
    assertEquals(out.serialized.bytes, new Uint8Array([42]));
  });
});

Deno.test("evaluateAndSerialize (direct): text-format output round-trips through readFileSync as bytes", async () => {
  await withCommandStub(
    { success: true, objectCount: 1, outputText: "<svg/>" },
    async () => {
      const out = await ScriptEvaluator.evaluateAndSerialize(
        CadScript.of(SIMPLE_SCRIPT),
        ScriptParameters.of({ size: 3 }),
        "svg",
      );
      assertEquals(out.serialized.format, "svg");
      assertEquals(out.serialized.bytes, new TextEncoder().encode("<svg/>"));
    },
  );
});
