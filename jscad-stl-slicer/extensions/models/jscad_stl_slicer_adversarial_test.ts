/**
 * Adversarial suite for @magistr/jscad-stl-slicer.
 *
 * Pins CURRENT (byte-frozen) behaviour under hostile/malformed input —
 * `jscad_stl_slicer.ts` + `jscad/stl_slicer.ts` are not edited. Each test
 * below is keyed to a specific latent finding tracked in the local
 * `jscad-stl-slicer-latent-bugs` issue-lifecycle model (never a swamp.club
 * Lab issue):
 *
 *   HIGH-1  surfaceDistance is unbounded O(sampleCount x triangleCount);
 *           buildTriangleGrid/_closestDistanceToMesh are built and computed
 *           but never consulted — characterized structurally at small N.
 *   HIGH-2  triCount @ offset 80 is never validated against byteLength:
 *           an inflated count throws an unhelpful low-level RangeError; a
 *           deflated count silently truncates with no error.
 *   MED-3   Math.max(...array) spread (fitProfiles/compare/decompose) is a
 *           stack-overflow risk at large N — characterized structurally at
 *           a moderate, CI-safe N, not executed at a crashing size.
 *   MED-4   ASCII-STL text fed through the binary reader is silently
 *           misparsed (bytes [80,84) of text become the triangle count).
 *   MED-5   NaN/Infinity vertex coordinates propagate silently into results.
 *   MED-6   An empty-but-structurally-valid mesh (triCount=0) silently
 *           yields NaN/Infinity in PCA output instead of throwing.
 *   MED-7   The `surfaceDistance` method wrapper swallows any thrown error
 *           and substitutes an all -1 sentinel result.
 *   MED-8   `filePath`/`refPath`/`modelPath` args go straight to
 *           `Deno.readFile` with zero path confinement or validation.
 *   LOW-9   A triangle exactly coplanar with the slicing plane is silently
 *           dropped (zero edges register a crossing).
 *
 * SAFE NEGATIVE: `generateScript`'s code-gen is numeric-only — every
 * geometry-derived value is passed through `Math.round(...)` before string
 * interpolation, and axis letters come only from the closed `Axis` enum, so
 * there is no reachable string-injection / code-injection surface.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { StlSlicer } from "./jscad/stl_slicer.ts";
import { model } from "./jscad_stl_slicer.ts";
import {
  asciiStlText,
  boxFacets,
  coplanarTriangleFacets,
  encodeBinaryStl,
  facet,
  infFacets,
  nanFacets,
  truncate,
  withTriCount,
} from "./fixtures/builders.ts";

const boxBytes = encodeBinaryStl(boxFacets([5, 10, 20]));

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (
    a: unknown,
    c: unknown,
  ) => Promise<{ dataHandles: unknown[] }>;
}>;

function makeCtx() {
  const written: Array<{ spec: string; name: string; payload: unknown }> = [];
  const ctx = {
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload });
      return Promise.resolve({ name, specName: spec, kind: "resource" });
    },
    createFileWriter: () => ({
      writeText: () => Promise.resolve({ kind: "file" }),
      writeAll: () => Promise.resolve({ kind: "file" }),
    }),
    definitionRepository: {
      findByNameGlobal: () => Promise.resolve(undefined),
    },
    dataRepository: { getContent: () => Promise.resolve(undefined) },
  };
  return { ctx, written };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

async function withTempFiles<T>(
  entries: Record<string, Uint8Array>,
  fn: (paths: Record<string, string>, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "jscad-stl-slicer-adversarial-",
  });
  try {
    const paths: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(entries)) {
      const p = `${dir}/${name}`;
      await Deno.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      await Deno.writeFile(p, bytes);
      paths[name] = p;
    }
    return await fn(paths, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// HIGH-1: unbounded O(sampleCount x triangleCount) surfaceDistance; dead grid
// ---------------------------------------------------------------------------

Deno.test("adversarial (HIGH-1): surfaceDistance runs a brute-force O(sampleCount x triangleCount) comparison — characterized structurally at a small, CI-safe N (the spatial grid it builds is never consulted)", () => {
  // Kept intentionally small: this exists to document the complexity class,
  // not to exercise it at a size that would slow down CI. A real regression
  // (wiring up the already-built grid) would not change this test's outcome.
  const meshA = encodeBinaryStl(boxFacets([5, 10, 20]));
  const meshB = encodeBinaryStl(boxFacets([5, 10, 20]));
  const result = StlSlicer.surfaceDistance(meshA, meshB, 24);
  assertEquals(result.meanDistance, 0);
});

// ---------------------------------------------------------------------------
// HIGH-2: triCount @ offset 80 unvalidated against byteLength
// ---------------------------------------------------------------------------

Deno.test("adversarial (HIGH-2): an inflated triCount (more triangles than bytes actually present) throws an unhelpful low-level RangeError, not a validation error", () => {
  const twoFacets = encodeBinaryStl([
    facet([0, 0, 0], [1, 0, 0], [0, 1, 0]),
    facet([0, 0, 1], [1, 0, 1], [0, 1, 1]),
  ]);
  const corrupted = withTriCount(twoFacets, 999999);
  assertThrows(() => StlSlicer.slice(corrupted, 0));
});

Deno.test("adversarial (HIGH-2): a deflated triCount (fewer than the bytes actually present) silently truncates extra facets with no error", () => {
  const twoFacets = encodeBinaryStl([
    facet([0, 0, 100], [1, 0, 100], [0, 1, 100]), // facet 0: nowhere near z=-5
    facet([0, 0, -10], [1, 0, -10], [0, 1, 0]), // facet 1: straddles z=-5
  ]);
  const truncatedCount = withTriCount(twoFacets, 1); // keep only facet 0
  const full = StlSlicer.slice(twoFacets, -5);
  const truncatedResult = StlSlicer.slice(truncatedCount, -5);
  if (full.trianglesIntersected === 0) {
    throw new Error("test setup error: full mesh should intersect at z=-5");
  }
  assertEquals(truncatedResult.trianglesIntersected, 0);
});

Deno.test("adversarial (HIGH-2): a truncated buffer (fewer bytes than the header promises) throws rather than validating up front", () => {
  const short = truncate(boxBytes, 90); // header + partial first facet only
  assertThrows(() => StlSlicer.slice(short, 0));
});

// ---------------------------------------------------------------------------
// MED-3: Math.max(...array) spread — stack-overflow risk at large N
// ---------------------------------------------------------------------------

Deno.test("adversarial (MED-3): fitProfiles's Math.max(...array) spread pattern is exercised at a moderate, CI-safe slice count without incident (the same pattern would throw 'Maximum call stack size exceeded' at tens of thousands of elements — not executed here)", () => {
  const result = StlSlicer.fitProfiles(boxBytes, "Z", 500, 4, 2.0);
  if (!isFinite(result.totalHeight)) {
    throw new Error("expected a finite totalHeight at moderate N");
  }
});

// ---------------------------------------------------------------------------
// MED-4: ASCII STL silently misparsed as binary
// ---------------------------------------------------------------------------

Deno.test("adversarial (MED-4): a well-formed ASCII-STL document fed through the binary reader is misparsed — bytes [80,84) of text become a garbage triangle count (1695166496 for this fixture), throwing a low-level DataView RangeError instead of a clean 'not binary STL' rejection", () => {
  const ascii = asciiStlText([facet([0, 0, 0], [1, 0, 0], [0, 1, 0])]);
  const view = new DataView(ascii.buffer, ascii.byteOffset, ascii.byteLength);
  // There is no format sniff anywhere in the parser: it unconditionally reads
  // a uint32 at byte offset 80 as a triangle count. For this ASCII fixture
  // that byte range decodes to a huge garbage count, far exceeding the
  // buffer -- confirming the parser cannot distinguish ASCII from binary.
  if (view.getUint32(80, true) <= ascii.byteLength) {
    throw new Error("test setup error: expected a garbage-large triCount");
  }
  assertThrows(
    () => StlSlicer.slice(ascii, 0),
    Error,
    "Offset is outside the bounds of the DataView",
  );
});

// ---------------------------------------------------------------------------
// MED-5: NaN/Infinity coordinate propagation
// ---------------------------------------------------------------------------

Deno.test("adversarial (MED-5): a NaN vertex coordinate propagates silently into principalAxes output instead of being rejected", () => {
  const bytes = encodeBinaryStl(nanFacets());
  const pca = StlSlicer.principalAxes(bytes);
  if (
    !Number.isNaN(pca.centroid[0]) &&
    !pca.sortedLengths.some((l) => Number.isNaN(l))
  ) {
    throw new Error(
      "expected NaN to propagate somewhere in centroid or sortedLengths",
    );
  }
});

Deno.test("adversarial (MED-5): an Infinity vertex coordinate propagates silently into principalAxes output instead of being rejected", () => {
  const bytes = encodeBinaryStl(infFacets());
  const pca = StlSlicer.principalAxes(bytes);
  const hasNonFinite = !isFinite(pca.centroid[0]) ||
    !isFinite(pca.centroid[1]) ||
    pca.sortedLengths.some((l) => !isFinite(l) || Number.isNaN(l));
  if (!hasNonFinite) {
    throw new Error("expected Infinity to propagate somewhere in PCA output");
  }
});

// ---------------------------------------------------------------------------
// MED-6: empty-but-valid mesh silently yields NaN, not a thrown error
// ---------------------------------------------------------------------------

Deno.test("adversarial (MED-6): a structurally-valid empty mesh (triCount=0) silently yields a NaN centroid from principalAxes instead of throwing", () => {
  const empty = encodeBinaryStl([]);
  const pca = StlSlicer.principalAxes(empty);
  assertEquals(Number.isNaN(pca.centroid[0]), true);
  assertEquals(Number.isNaN(pca.centroid[1]), true);
  assertEquals(Number.isNaN(pca.centroid[2]), true);
});

// ---------------------------------------------------------------------------
// MED-7: surfaceDistance method wrapper swallows errors to a -1 sentinel
// ---------------------------------------------------------------------------

Deno.test("adversarial (MED-7): the surfaceDistance METHOD swallows a thrown error from StlSlicer.surfaceDistance and writes an all -1 sentinel report, with no error surfaced to the caller", async () => {
  await withTempFiles(
    { "ref.stl": boxBytes, "bad.stl": truncate(boxBytes, 40) },
    async ({ "ref.stl": refPath, "bad.stl": modelPath }) => {
      const { ctx, written } = makeCtx();
      // Does NOT reject -- resolves normally with the sentinel payload.
      await run(
        "surfaceDistance",
        { refPath, modelPath, sampleCount: 10 },
        ctx,
      );
      const payload = written[0].payload as Record<string, number>;
      assertEquals(payload.meanDistance, -1);
      assertEquals(payload.rmsDistance, -1);
      assertEquals(payload.maxDistance, -1);
      assertEquals(payload.percentile90, -1);
      assertEquals(payload.percentile95, -1);
      assertEquals(payload.sampleCount, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// MED-8: path args go straight to Deno.readFile with zero confinement
// ---------------------------------------------------------------------------

Deno.test("adversarial (MED-8): filePath is passed to Deno.readFile with no validation — a relative '..' path escapes the caller's intended subdirectory to read a sibling file, entirely confined to a temp tree", async () => {
  await withTempFiles(
    {
      "allowed/model.stl": boxBytes,
      "sibling.stl": encodeBinaryStl(boxFacets([10, 20, 40])),
    },
    async (_paths, dir) => {
      const { ctx, written } = makeCtx();
      const traversalPath = `${dir}/allowed/../sibling.stl`;
      await run("sliceFile", { filePath: traversalPath, sliceZ: 5 }, ctx);
      const payload = written[0].payload as { bounds: { width: number } };
      // sibling.stl is the [10,20,40]-half box: width at z=5 is 20, not the
      // "allowed/model.stl" box's width of 10 -- proving the traversal read
      // the sibling file with zero path confinement.
      assertEquals(payload.bounds.width, 20);
    },
  );
});

// ---------------------------------------------------------------------------
// LOW-9: coplanar triangles dropped
// ---------------------------------------------------------------------------

Deno.test("adversarial (LOW-9): a triangle exactly coplanar with the slice plane is silently dropped (zero segments, not one)", () => {
  const bytes = encodeBinaryStl(coplanarTriangleFacets(5));
  const result = StlSlicer.slice(bytes, 5);
  assertEquals(result.trianglesIntersected, 0);
  assertEquals(result.segments.length, 0);
});

// ---------------------------------------------------------------------------
// SAFE NEGATIVE: generateScript is numeric-only code-gen, no injection surface
// ---------------------------------------------------------------------------

Deno.test("safe negative: generateScript's geometry-derived values are all Math.round(...) numbers — no string/code-injection surface reaches the generated script", () => {
  const script = StlSlicer.generateScript(boxBytes, "Z", 20);
  // Every "wCoeffs = [...]" line must contain only numeric/array syntax.
  const coeffsLine = script.split("\n").find((l) => l.includes("wCoeffs ="));
  if (!coeffsLine) {
    throw new Error("expected a wCoeffs line in the generated script");
  }
  const coeffsBody = coeffsLine.slice(coeffsLine.indexOf("["));
  if (!/^[\[\]0-9.,\-\s;]+$/.test(coeffsBody)) {
    throw new Error(
      `expected wCoeffs to be purely numeric array syntax, got: ${coeffsBody}`,
    );
  }
  if (
    script.includes("`") || script.includes("eval(") ||
    script.includes("Function(")
  ) {
    throw new Error("unexpected dynamic-code construct in generated script");
  }
});
