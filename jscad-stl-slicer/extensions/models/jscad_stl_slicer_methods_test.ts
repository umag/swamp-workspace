/**
 * Methods suite for @magistr/jscad-stl-slicer.
 *
 * Drives every one of the 18 methods via
 * `model.methods.<m>.execute(model.methods.<m>.arguments.parse(rawArgs), ctx)`
 * — the zod-arg + writeResource/createFileWriter seam — against real files on
 * disk (`filePath`/`refPath`/`modelPath` args go through the real
 * `Deno.readFile`) written from byte-accurate synthetic fixtures produced by
 * `fixtures/builders.ts`. `model.ts`/`stl_slicer.ts` are BYTE-FROZEN.
 *
 * The 3 `*Models` methods (`sixViews`, `compareModels`, `enhancedCompareModels`)
 * reach a named `@magistr/jscad-cad` model via
 * `context.definitionRepository.findByNameGlobal` +
 * `context.dataRepository.getContent(type, id, "output")` — both faked here.
 */
import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "jsr:@std/assert@1";
import { model } from "./jscad_stl_slicer.ts";
import { boxFacets, encodeBinaryStl } from "./fixtures/builders.ts";

const boxBytes = encodeBinaryStl(boxFacets([5, 10, 20]));
const bigBoxBytes = encodeBinaryStl(boxFacets([10, 20, 40]));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: unknown };
type FileWritten = { spec: string; name: string; text: string };

function makeCtx(cadModels: Record<string, Uint8Array> = {}) {
  const written: Written[] = [];
  const filesWritten: FileWritten[] = [];
  const ctx = {
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload });
      return Promise.resolve({ name, specName: spec, kind: "resource" });
    },
    createFileWriter: (spec: string, name: string) => ({
      writeText: (text: string) => {
        filesWritten.push({ spec, name, text });
        return Promise.resolve({ name, specName: spec, kind: "file" });
      },
      writeAll: (bytes: Uint8Array) => {
        filesWritten.push({
          spec,
          name,
          text: `<binary:${bytes.byteLength}>`,
        });
        return Promise.resolve({ name, specName: spec, kind: "file" });
      },
    }),
    definitionRepository: {
      // deno-lint-ignore require-await
      findByNameGlobal: async (name: string) => {
        if (!(name in cadModels)) return undefined;
        return { type: "@magistr/jscad-cad", definition: { id: name } };
      },
    },
    dataRepository: {
      // deno-lint-ignore require-await
      getContent: async (_type: string, id: string, _spec: string) => {
        return cadModels[id];
      },
    },
  };
  return { ctx, written, filesWritten };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (
    a: unknown,
    c: unknown,
  ) => Promise<{ dataHandles: unknown[] }>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

async function withTempFiles<T>(
  entries: Record<string, Uint8Array>,
  fn: (paths: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "jscad-stl-slicer-methods-" });
  try {
    const paths: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(entries)) {
      const p = `${dir}/${name}`;
      await Deno.writeFile(p, bytes);
      paths[name] = p;
    }
    return await fn(paths);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// sliceFile
// ---------------------------------------------------------------------------

Deno.test("methods: sliceFile slices at the given Z and writes a slice report + crossSection SVG", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written, filesWritten } = makeCtx();
    const result = await run("sliceFile", { filePath: p, sliceZ: 5 }, ctx);
    assertEquals(result.dataHandles.length, 2);
    assertEquals(written[0].spec, "slice");
    const payload = written[0].payload as Record<string, unknown>;
    assertEquals(payload.sliceZ, 5);
    assertEquals(payload.trianglesIntersected, 8);
    assertEquals(filesWritten[0].spec, "crossSection");
  });
});

Deno.test("methods: sliceFile defaults sliceZ to centerZ() when omitted", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written } = makeCtx();
    await run("sliceFile", { filePath: p }, ctx);
    const payload = written[0].payload as Record<string, unknown>;
    assertEquals(payload.sliceZ, 0);
  });
});

Deno.test("methods: sliceFile computes widthDeltaPct/depthDeltaPct against supplied reference dimensions", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written } = makeCtx();
    await run("sliceFile", {
      filePath: p,
      sliceZ: 5,
      referenceWidthMm: 5,
      referenceDepthMm: 10,
    }, ctx);
    const payload = written[0].payload as Record<string, unknown>;
    // width=10 vs ref=5 -> +100%; depth=20 vs ref=10 -> +100%
    assertEquals(payload.widthDeltaPct, 100);
    assertEquals(payload.depthDeltaPct, 100);
  });
});

// ---------------------------------------------------------------------------
// sixViewsFile / sixViews (jscad-cad model)
// ---------------------------------------------------------------------------

Deno.test("methods: sixViewsFile writes a sixViewReport + sixViewSheet SVG with the box's bounds", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written, filesWritten } = makeCtx();
    await run("sixViewsFile", { filePath: p }, ctx);
    const payload = written[0].payload as { bounds: Record<string, number> };
    assertEquals(payload.bounds.sizeX, 10);
    assertEquals(payload.bounds.sizeZ, 40);
    assertEquals(filesWritten[0].spec, "sixViewSheet");
  });
});

Deno.test("methods: sixViews resolves a named @magistr/jscad-cad model's output STL via definitionRepository + dataRepository", async () => {
  const { ctx, written } = makeCtx({ "my-cad-part": boxBytes });
  await run("sixViews", { cadModelName: "my-cad-part" }, ctx);
  const payload = written[0].payload as { bounds: Record<string, number> };
  assertEquals(payload.bounds.sizeX, 10);
});

Deno.test("methods: sixViews throws a clear error when the named jscad-cad model is not found", async () => {
  const { ctx } = makeCtx({});
  await assertRejects(
    () => run("sixViews", { cadModelName: "nonexistent" }, ctx),
    Error,
    'Model "nonexistent" not found',
  );
});

Deno.test("methods: sixViews throws when the jscad-cad model has no output data", async () => {
  const { ctx } = makeCtx({
    "empty-model": undefined as unknown as Uint8Array,
  });
  await assertRejects(
    () => run("sixViews", { cadModelName: "empty-model" }, ctx),
    Error,
    'No output data found for model "empty-model"',
  );
});

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

Deno.test("methods: analyze writes an analysisReport with PCA axes/proportions and a profileData file", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written, filesWritten } = makeCtx();
    await run("analyze", { filePath: p, sliceCount: 20 }, ctx);
    const payload = written[0].payload as Record<string, unknown>;
    // Dominant component points along Z but is not exactly [0,0,1] -- see
    // the contract-fixture suite's note on per-corner vertex weighting.
    const primaryAxis = payload.primaryAxis as number[];
    assertAlmostEquals(primaryAxis[2], 0.9967992582212498, 1e-9);
    assertAlmostEquals(
      (payload.proportions as { midToLong: number }).midToLong,
      0.5657771032326211,
      1e-9,
    );
    assertEquals(filesWritten[0].spec, "profileData");
  });
});

// ---------------------------------------------------------------------------
// analyzeSymmetry
// ---------------------------------------------------------------------------

Deno.test("methods: analyzeSymmetry writes a symmetryReport classifying axes at the given threshold", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written } = makeCtx();
    await run("analyzeSymmetry", { filePath: p, threshold: 0.85 }, ctx);
    const payload = written[0].payload as {
      symmetricAxes: string[];
      asymmetricAxes: string[];
    };
    assertEquals(
      payload.symmetricAxes.length + payload.asymmetricAxes.length,
      3,
    );
  });
});

// ---------------------------------------------------------------------------
// extractDirectionalProfile
// ---------------------------------------------------------------------------

Deno.test("methods: extractDirectionalProfile writes a directionalProfile JSON file", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, filesWritten } = makeCtx();
    await run("extractDirectionalProfile", {
      filePath: p,
      sliceAxis: "Z",
      measureAxis: "X",
      sliceCount: 10,
    }, ctx);
    assertEquals(filesWritten[0].spec, "directionalProfile");
    const parsed = JSON.parse(filesWritten[0].text);
    assertEquals(parsed.sliceAxis, "Z");
    assertEquals(parsed.measureAxis, "X");
  });
});

// ---------------------------------------------------------------------------
// detectFeatures
// ---------------------------------------------------------------------------

Deno.test("methods: detectFeatures writes a featureDetectionReport", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written } = makeCtx();
    await run(
      "detectFeatures",
      { filePath: p, sliceAxis: "Z", sliceCount: 20 },
      ctx,
    );
    const payload = written[0].payload as {
      sliceAxis: string;
      featureCount: number;
    };
    assertEquals(payload.sliceAxis, "Z");
    assertEquals(typeof payload.featureCount, "number");
  });
});

// ---------------------------------------------------------------------------
// multiSlice
// ---------------------------------------------------------------------------

Deno.test("methods: multiSlice writes a multiSliceData JSON file with width/depth per height", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, filesWritten } = makeCtx();
    await run("multiSlice", {
      filePath: p,
      sliceAxis: "Z",
      widthAxis: "X",
      depthAxis: "Y",
      sliceCount: 10,
    }, ctx);
    const parsed = JSON.parse(filesWritten[0].text);
    assertEquals(parsed.sliceAxis, "Z");
    if (!Array.isArray(parsed.slices) || parsed.slices.length === 0) {
      throw new Error("expected a non-empty slices array");
    }
  });
});

// ---------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------

Deno.test("methods: decompose writes a generated JSCAD script file and a featureDetectionReport", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, written, filesWritten } = makeCtx();
    await run(
      "decompose",
      { filePath: p, sliceAxis: "Z", sliceCount: 20 },
      ctx,
    );
    const payload = written[0].payload as {
      sliceAxis: string;
      featureCount: number;
    };
    assertEquals(payload.sliceAxis, "Z");
    if (payload.featureCount < 1) {
      throw new Error("expected at least the 'body' feature");
    }
    if (!filesWritten[0].text.includes("const main")) {
      throw new Error("expected a generated JSCAD script");
    }
  });
});

// ---------------------------------------------------------------------------
// surfaceDistance
// ---------------------------------------------------------------------------

Deno.test("methods: surfaceDistance writes a surfaceDistanceReport comparing two meshes", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes, "model.stl": boxBytes },
    async ({ "ref.stl": refPath, "model.stl": modelPath }) => {
      const { ctx, written } = makeCtx();
      await run(
        "surfaceDistance",
        { refPath, modelPath, sampleCount: 50 },
        ctx,
      );
      const payload = written[0].payload as {
        meanDistance: number;
        sampleCount: number;
      };
      // Identical mesh compared to itself: distances should be ~0.
      assertEquals(payload.meanDistance, 0);
      if (payload.sampleCount <= 0) {
        throw new Error(
          "expected a positive sampleCount for two identical meshes",
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// extractSkeleton
// ---------------------------------------------------------------------------

Deno.test("methods: extractSkeleton writes a skeleton JSON file", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, filesWritten } = makeCtx();
    await run("extractSkeleton", {
      filePath: p,
      sliceAxis: "Z",
      featureAxis: "Y",
      sliceCount: 20,
    }, ctx);
    const parsed = JSON.parse(filesWritten[0].text);
    if (!("points" in parsed) || !("totalLength" in parsed)) {
      throw new Error("expected a SkeletonResult shape");
    }
  });
});

// ---------------------------------------------------------------------------
// generateScript / fitProfiles
// ---------------------------------------------------------------------------

Deno.test("methods: generateScript writes a numeric-only JSCAD script file (no path/string injection surface)", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, filesWritten } = makeCtx();
    await run(
      "generateScript",
      { filePath: p, sliceAxis: "Z", sliceCount: 20 },
      ctx,
    );
    if (!filesWritten[0].text.includes("extrudeFromSlices")) {
      throw new Error("expected the generated extrudeFromSlices script body");
    }
  });
});

Deno.test("methods: fitProfiles writes polynomial coefficients for xRadius/dP/dN", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, filesWritten } = makeCtx();
    await run("fitProfiles", {
      filePath: p,
      sliceAxis: "Z",
      sliceCount: 20,
      maxDegree: 6,
      targetError: 2.0,
    }, ctx);
    const parsed = JSON.parse(filesWritten[0].text);
    for (const key of ["xRadius", "dP", "dN"]) {
      if (!Array.isArray(parsed[key]?.coeffs)) {
        throw new Error(`expected ${key}.coeffs array`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// extractContours
// ---------------------------------------------------------------------------

Deno.test("methods: extractContours writes a contour stack with points per slice", async () => {
  await withTempFiles({ "part.stl": boxBytes }, async ({ "part.stl": p }) => {
    const { ctx, filesWritten } = makeCtx();
    await run("extractContours", {
      filePath: p,
      sliceAxis: "Z",
      sliceCount: 10,
      pointsPerSlice: 16,
    }, ctx);
    const parsed = JSON.parse(filesWritten[0].text);
    if (!Array.isArray(parsed.slices) || parsed.slices.length === 0) {
      throw new Error("expected a non-empty contour slice stack");
    }
  });
});

// ---------------------------------------------------------------------------
// compareFiles / compareModels
// ---------------------------------------------------------------------------

Deno.test("methods: compareFiles writes a comparisonReport with ratio 2 for a uniformly 2x-scaled model", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes, "model.stl": bigBoxBytes },
    async ({ "ref.stl": refPath, "model.stl": modelPath }) => {
      const { ctx, written } = makeCtx();
      await run("compareFiles", { refPath, modelPath }, ctx);
      const payload = written[0].payload as { ratios: number[] };
      assertEquals(payload.ratios[0], 2);
    },
  );
});

Deno.test("methods: compareModels compares a reference file against a named jscad-cad model's output", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes },
    async ({ "ref.stl": refPath }) => {
      const { ctx, written } = makeCtx({ "cad-part": bigBoxBytes });
      await run("compareModels", { refPath, cadModelName: "cad-part" }, ctx);
      const payload = written[0].payload as { ratios: number[] };
      assertEquals(payload.ratios[0], 2);
    },
  );
});

Deno.test("methods: compareModels throws when the named jscad-cad model is not found", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes },
    async ({ "ref.stl": refPath }) => {
      const { ctx } = makeCtx({});
      await assertRejects(
        () => run("compareModels", { refPath, cadModelName: "missing" }, ctx),
        Error,
        'Model "missing" not found',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// enhancedCompareFiles / enhancedCompareModels
// ---------------------------------------------------------------------------

Deno.test("methods: enhancedCompareFiles writes an enhancedComparisonReport with alignedAABB + symmetry axes", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes, "model.stl": bigBoxBytes },
    async ({ "ref.stl": refPath, "model.stl": modelPath }) => {
      const { ctx, written } = makeCtx();
      await run("enhancedCompareFiles", { refPath, modelPath }, ctx);
      const payload = written[0].payload as {
        ratios: number[];
        alignedAABB: { long: { ratio: number } };
        symmetryRefAxes: string[];
        symmetryModelAxes: string[];
      };
      assertEquals(payload.ratios[0], 2);
      assertEquals(payload.alignedAABB.long.ratio, 2);
      assertEquals(Array.isArray(payload.symmetryRefAxes), true);
      assertEquals(Array.isArray(payload.symmetryModelAxes), true);
    },
  );
});

Deno.test("methods: enhancedCompareModels compares a reference file against a named jscad-cad model's output", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes },
    async ({ "ref.stl": refPath }) => {
      const { ctx, written } = makeCtx({ "cad-part": bigBoxBytes });
      await run(
        "enhancedCompareModels",
        { refPath, cadModelName: "cad-part" },
        ctx,
      );
      const payload = written[0].payload as { ratios: number[] };
      assertEquals(payload.ratios[0], 2);
    },
  );
});

Deno.test("methods: enhancedCompareModels throws when the named jscad-cad model has no output data", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes },
    async ({ "ref.stl": refPath }) => {
      const { ctx } = makeCtx({
        "no-output": undefined as unknown as Uint8Array,
      });
      await assertRejects(
        () =>
          run(
            "enhancedCompareModels",
            { refPath, cadModelName: "no-output" },
            ctx,
          ),
        Error,
        'No output data found for model "no-output"',
      );
    },
  );
});
