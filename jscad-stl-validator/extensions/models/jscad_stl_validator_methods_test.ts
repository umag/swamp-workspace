/**
 * Methods suite: happy-path + throw-path coverage of both
 * `@magistr/jscad-stl-validator` methods (`validate`, `validateFile`).
 *
 * `jscad_stl_validator.ts` / `jscad/stl_validator.ts` are BYTE-FROZEN; this
 * suite drives them unmodified via `model.methods.<m>.execute(args, ctx)`.
 *
 * Two distinct seams, per the approved plan:
 *  - `validate` reads via `context.definitionRepository.findByNameGlobal` +
 *    `context.dataRepository.getContent` — faked here with an in-memory map,
 *    serving SYNTHETIC bytes built by `fixtures/stl_builders.ts`.
 *  - `validateFile` reads via real `Deno.readFile` — exercised here against a
 *    real file written to a per-test `Deno.makeTempDir()` (no FS stubbing).
 *
 * All fixture content is synthetic — see fixtures/PROVENANCE.md.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./jscad_stl_validator.ts";
import {
  encodeAsciiStl,
  encodeBinaryStl,
  nTriangles,
  withTempStlFile,
} from "./fixtures/stl_builders.ts";

function buildBinaryStl(triangleCount: number): Uint8Array {
  return encodeBinaryStl({ triangles: nTriangles(triangleCount) });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type Found = { type: string; definition: { id: string } };

function makeCtx(
  opts: {
    definitions?: Map<string, Found>;
    content?: Map<string, Uint8Array | null>;
    allowedRoots?: string[];
  } = {},
) {
  const written: Written[] = [];
  const getContentCalls: Array<
    [string, string, string, number | undefined]
  > = [];
  return {
    written,
    getContentCalls,
    ctx: {
      definitionRepository: {
        findByNameGlobal: (name: string) =>
          Promise.resolve(opts.definitions?.get(name)),
      },
      dataRepository: {
        getContent: (
          type: string,
          id: string,
          kind: string,
          version?: number,
        ) => {
          getContentCalls.push([type, id, kind, version]);
          const key = `${type}:${id}:${kind}:${version ?? "latest"}`;
          return Promise.resolve(opts.content?.get(key) ?? null);
        },
      },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      globalArgs: { allowedRoots: opts.allowedRoots ?? [] },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// validate() — happy paths
// ---------------------------------------------------------------------------

Deno.test("validate: resolves the model, reads its 'output' content, and writes a binary report", async () => {
  const stl = buildBinaryStl(2);
  const definitions = new Map<string, Found>([
    ["my-part", { type: "@magistr/jscad-cad", definition: { id: "part-1" } }],
  ]);
  const content = new Map<string, Uint8Array | null>([
    ["@magistr/jscad-cad:part-1:output:latest", stl],
  ]);
  const { ctx, written, getContentCalls } = makeCtx({ definitions, content });

  await run("validate", { cadModelName: "my-part" }, ctx);

  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "report");
  assertEquals(written[0].name, "report");
  assertEquals(written[0].payload.format, "binary");
  assertEquals(written[0].payload.triangleCount, 2);
  assertEquals(written[0].payload.valid, true);
  assertEquals(getContentCalls[0], [
    "@magistr/jscad-cad",
    "part-1",
    "output",
    undefined,
  ]);
});

Deno.test("validate: reads ASCII output content correctly too", async () => {
  const ascii = encodeAsciiStl({
    facets: [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  const definitions = new Map<string, Found>([
    ["ascii-part", {
      type: "@magistr/jscad-cad",
      definition: { id: "part-2" },
    }],
  ]);
  const content = new Map<string, Uint8Array | null>([
    ["@magistr/jscad-cad:part-2:output:latest", ascii],
  ]);
  const { ctx, written } = makeCtx({ definitions, content });

  await run("validate", { cadModelName: "ascii-part" }, ctx);

  assertEquals(written[0].payload.format, "ascii");
  assertEquals(written[0].payload.triangleCount, 1);
});

// ---------------------------------------------------------------------------
// validate() — throw paths
// ---------------------------------------------------------------------------

Deno.test("validate: throws when the named model cannot be resolved", async () => {
  const { ctx } = makeCtx({});
  await assertRejects(
    () => run("validate", { cadModelName: "missing-model" }, ctx),
    Error,
    'Model "missing-model" not found',
  );
});

Deno.test("validate: throws when the resolved model has no stored output content (no version pinned)", async () => {
  const definitions = new Map<string, Found>([
    ["empty-part", {
      type: "@magistr/jscad-cad",
      definition: { id: "part-3" },
    }],
  ]);
  const { ctx } = makeCtx({ definitions, content: new Map() });
  await assertRejects(
    () => run("validate", { cadModelName: "empty-part" }, ctx),
    Error,
    'No output data found for model "empty-part"',
  );
});

Deno.test("validate: throws with the pinned version in the message when a version is specified and missing", async () => {
  const definitions = new Map<string, Found>([
    ["versioned-part", {
      type: "@magistr/jscad-cad",
      definition: { id: "part-4" },
    }],
  ]);
  const { ctx } = makeCtx({ definitions, content: new Map() });
  await assertRejects(
    () => run("validate", { cadModelName: "versioned-part", version: 3 }, ctx),
    Error,
    'No output data found for model "versioned-part" version 3',
  );
});

Deno.test("validate: passes a specified version through to dataRepository.getContent", async () => {
  const stl = buildBinaryStl(1);
  const definitions = new Map<string, Found>([
    ["pinned-part", {
      type: "@magistr/jscad-cad",
      definition: { id: "part-5" },
    }],
  ]);
  const content = new Map<string, Uint8Array | null>([
    ["@magistr/jscad-cad:part-5:output:7", stl],
  ]);
  const { ctx, getContentCalls } = makeCtx({ definitions, content });

  await run("validate", { cadModelName: "pinned-part", version: 7 }, ctx);

  assertEquals(getContentCalls[0], [
    "@magistr/jscad-cad",
    "part-5",
    "output",
    7,
  ]);
});

// ---------------------------------------------------------------------------
// validateFile() — happy paths (real Deno.readFile over a temp fixture)
// ---------------------------------------------------------------------------

Deno.test("validateFile: reads a real binary STL file from disk and writes a report", async () => {
  const stl = buildBinaryStl(3);
  await withTempStlFile(stl, async (filePath) => {
    const { ctx, written } = makeCtx({});
    await run("validateFile", { filePath }, ctx);
    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "report");
    assertEquals(written[0].name, "report");
    assertEquals(written[0].payload.format, "binary");
    assertEquals(written[0].payload.triangleCount, 3);
  });
});

Deno.test("validateFile: reads a real ASCII STL file from disk and writes a report", async () => {
  const ascii = encodeAsciiStl({
    facets: [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  await withTempStlFile(ascii, async (filePath) => {
    const { ctx, written } = makeCtx({});
    await run("validateFile", { filePath }, ctx);
    assertEquals(written[0].payload.format, "ascii");
    assertEquals(written[0].payload.triangleCount, 1);
  }, "model.txt");
});

// ---------------------------------------------------------------------------
// validateFile() — throw paths
// ---------------------------------------------------------------------------

Deno.test("validateFile: wraps a missing-file read error with the file path in the message", async () => {
  const root = await Deno.makeTempDir({ prefix: "jscad-stl-validator-" });
  try {
    const { ctx } = makeCtx({});
    const missing = `${root}/does-not-exist.stl`;
    await assertRejects(
      () => run("validateFile", { filePath: missing }, ctx),
      Error,
      `Cannot read "${missing}"`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validateFile: wraps a directory-path read error with the file path in the message", async () => {
  const root = await Deno.makeTempDir({ prefix: "jscad-stl-validator-" });
  try {
    const { ctx } = makeCtx({});
    await assertRejects(
      () => run("validateFile", { filePath: root }, ctx),
      Error,
      `Cannot read "${root}"`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// validateFile() — allowedRoots confinement (operator-set global argument,
// read via context.globalArgs; NOT part of the per-call untrusted arguments)
// ---------------------------------------------------------------------------

Deno.test("validateFile: with allowedRoots configured, accepts a file inside the allowed root", async () => {
  const stl = buildBinaryStl(1);
  await withTempStlFile(stl, async (filePath, root) => {
    const { ctx, written } = makeCtx({ allowedRoots: [root] });
    await run("validateFile", { filePath }, ctx);
    assertEquals(written[0].payload.format, "binary");
    assertEquals(written[0].payload.triangleCount, 1);
  });
});

Deno.test("validateFile: with allowedRoots configured, rejects a file outside every allowed root", async () => {
  const allowedRoot = await Deno.makeTempDir({
    prefix: "jscad-stl-validator-allowed-",
  });
  const stl = buildBinaryStl(1);
  try {
    await withTempStlFile(stl, async (filePath) => {
      const { ctx, written } = makeCtx({ allowedRoots: [allowedRoot] });
      await assertRejects(
        () => run("validateFile", { filePath }, ctx),
        Error,
        "Refusing to read",
      );
      assertEquals(written.length, 0);
    });
  } finally {
    await Deno.remove(allowedRoot, { recursive: true });
  }
});

Deno.test("validateFile: a smuggled per-call args.allowedRoots has NO effect — confinement is governed exclusively by context.globalArgs (operator-set), never the per-call (untrusted) arguments", async () => {
  const restrictiveRoot = await Deno.makeTempDir({
    prefix: "jscad-stl-validator-restrictive-",
  });
  const stl = buildBinaryStl(1);
  try {
    await withTempStlFile(stl, async (filePath, actualRoot) => {
      // ctx.globalArgs.allowedRoots is RESTRICTIVE — it does NOT include the
      // file's real directory. The per-call args smuggle in an
      // `allowedRoots` naming the file's ACTUAL directory, which — if the
      // method mistakenly read confinement off `args` instead of
      // `context.globalArgs` — would incorrectly permit the read. Since the
      // method's arguments schema declares only `filePath`, this extra key
      // must be ignored (stripped by the schema, never consulted), so the
      // read is still rejected under the real (restrictive) globalArgs.
      const { ctx, written } = makeCtx({ allowedRoots: [restrictiveRoot] });
      await assertRejects(
        () =>
          run(
            "validateFile",
            { filePath, allowedRoots: [actualRoot] } as unknown as Record<
              string,
              unknown
            >,
            ctx,
          ),
        Error,
        "Refusing to read",
      );
      assertEquals(written.length, 0);
    });
  } finally {
    await Deno.remove(restrictiveRoot, { recursive: true });
  }
});
