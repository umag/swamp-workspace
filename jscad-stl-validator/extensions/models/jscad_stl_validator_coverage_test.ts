/**
 * Coverage suite: remaining branches not exercised by the methods,
 * contract-fixture, or adversarial suites.
 *
 * `jscad_stl_validator.ts` / `jscad/stl_validator.ts` are BYTE-FROZEN; every
 * test here characterizes current behavior.
 *
 * All fixture content is synthetic — see fixtures/PROVENANCE.md.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./jscad_stl_validator.ts";
import { StlValidator } from "./jscad/stl_validator.ts";
import { encodeBinaryStl, nTriangles } from "./fixtures/stl_builders.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Found = { type: string; definition: { id: string } };

function makeCtx(
  opts: {
    definitions?: Map<string, Found>;
    content?: Map<string, Uint8Array | null>;
  } = {},
) {
  const getContentCalls: Array<
    [string, string, string, number | undefined]
  > = [];
  return {
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
      writeResource: (_spec: string, name: string, payload: unknown) =>
        Promise.resolve({ spec: "report", name, payload }),
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
// Degenerate-triangle branches — each of the three duplicate-vertex
// conditions, plus the near-zero-cross-product (colinear, all distinct)
// branch, individually.
// ---------------------------------------------------------------------------

Deno.test("coverage: degenerate via v1===v2 (first duplicate-vertex condition)", () => {
  const stl = encodeBinaryStl({
    triangles: [{ v1: [0, 0, 0], v2: [0, 0, 0], v3: [1, 0, 0] }],
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.degenerateTriangles, 1);
  assertEquals(report.boundingBox, null); // sole triangle is degenerate -> no geometry
});

Deno.test("coverage: degenerate via v1===v3 (second duplicate-vertex condition)", () => {
  const stl = encodeBinaryStl({
    triangles: [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 0, 0] }],
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.degenerateTriangles, 1);
});

Deno.test("coverage: degenerate via v2===v3 (third duplicate-vertex condition)", () => {
  const stl = encodeBinaryStl({
    triangles: [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [1, 0, 0] }],
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.degenerateTriangles, 1);
});

Deno.test("coverage: degenerate via near-zero cross product — three DISTINCT colinear points (not caught by the duplicate-vertex shortcut)", () => {
  const stl = encodeBinaryStl({
    triangles: [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [2, 0, 0] }], // all on the x-axis, pairwise distinct
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.degenerateTriangles, 1);
});

Deno.test("coverage: a mix of one degenerate and one valid triangle — bounding box covers only the valid one", () => {
  const stl = encodeBinaryStl({
    triangles: [
      { v1: [0, 0, 0], v2: [0, 0, 0], v3: [1, 0, 0] }, // degenerate
      { v1: [5, 5, 5], v2: [6, 5, 5], v3: [5, 6, 5] }, // valid
    ],
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.triangleCount, 2);
  assertEquals(report.degenerateTriangles, 1);
  assertEquals(report.boundingBox, {
    min: [5, 5, 5],
    max: [6, 6, 5],
    size: [1, 1, 0],
  });
});

// ---------------------------------------------------------------------------
// Reclassification branch — POSITIVE case: a "solid"-looking header whose
// claimed count DOES match actual size is correctly routed to the binary
// parser despite the ASCII-looking header (contrast with the LB2 pin in the
// adversarial suite, where a mismatched count breaks this).
// ---------------------------------------------------------------------------

Deno.test("coverage: a 'solid'-header binary buffer whose claimed count matches actual size is correctly classified as binary", () => {
  const stl = encodeBinaryStl({
    header: "solid",
    claimedTriangleCount: 2, // matches the actual 2 triangles below
    triangles: nTriangles(2),
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.format, "binary");
  assertEquals(report.triangleCount, 2);
  assertEquals(report.valid, true);
  assertEquals(report.issues, []);
});

Deno.test("coverage: the reclassification guard requires claimedCount > 0 — a 'solid'-header buffer with claimedCount=0 and matching size still falls through to ASCII", () => {
  const stl = encodeBinaryStl({
    header: "solid",
    claimedTriangleCount: 0,
    triangles: [], // size = 84, matches 84 + 0*50, but triCount>0 guard fails
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.format, "ascii");
  assertEquals(report.triangleCount, 0);
  assertEquals(
    report.issues.some((i) => i.includes("No facets found")),
    true,
  );
});

// ---------------------------------------------------------------------------
// validate() — version passthrough
// ---------------------------------------------------------------------------

Deno.test("coverage: validate passes args.version through to dataRepository.getContent verbatim", async () => {
  const stl = encodeBinaryStl({ triangles: nTriangles(1) });
  const definitions = new Map<string, Found>([
    ["v-part", { type: "@magistr/jscad-cad", definition: { id: "id-1" } }],
  ]);
  const content = new Map<string, Uint8Array | null>([
    ["@magistr/jscad-cad:id-1:output:9", stl],
  ]);
  const { ctx, getContentCalls } = makeCtx({ definitions, content });

  await run("validate", { cadModelName: "v-part", version: 9 }, ctx);

  assertEquals(getContentCalls[0], ["@magistr/jscad-cad", "id-1", "output", 9]);
});

Deno.test("coverage: validate omits version (undefined) when not specified", async () => {
  const stl = encodeBinaryStl({ triangles: nTriangles(1) });
  const definitions = new Map<string, Found>([
    ["v-part2", { type: "@magistr/jscad-cad", definition: { id: "id-2" } }],
  ]);
  const content = new Map<string, Uint8Array | null>([
    ["@magistr/jscad-cad:id-2:output:latest", stl],
  ]);
  const { ctx, getContentCalls } = makeCtx({ definitions, content });

  await run("validate", { cadModelName: "v-part2" }, ctx);

  assertEquals(getContentCalls[0], [
    "@magistr/jscad-cad",
    "id-2",
    "output",
    undefined,
  ]);
});
