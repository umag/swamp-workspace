/**
 * Contract-fixture tests for @magistr/jscad-stl-slicer.
 *
 * Pins exact, hand-derivable output on known synthetic solids by calling
 * `StlSlicer.<fn>(bytes, ...)` directly (the geometry seam — no model/zod
 * layer involved). `extensions/models/jscad/stl_slicer.ts` is BYTE-FROZEN:
 * every assertion here characterizes what the shipped algorithm already
 * computes for a deterministic axis-aligned input, not an independently
 * "correct" answer.
 *
 * Primary solid: an axis-aligned box, half-extents [5, 10, 20] (full size
 * 10 x 20 x 40), centered at the origin. NOTE: `readVertices` reads raw
 * per-TRIANGLE vertex occurrences, not deduplicated mesh vertices, and a
 * 12-triangle box (2 triangles/face via an a-b-c/a-c-d diagonal split)
 * cannot weight all 8 corners equally (36 vertex-slots / 8 corners = 4.5,
 * not an integer — two opposite corners are always counted twice as often
 * as the other six). That off-diagonal covariance perturbation means the
 * PCA axes come out only APPROXIMATELY world-aligned (dominant component
 * ~0.997-0.9975, not exactly 1) — pinned here to the actual measured
 * values, not an idealized [0,0,1]/[0,1,0]/[1,0,0].
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { StlSlicer } from "./jscad/stl_slicer.ts";
import {
  boxFacets,
  encodeBinaryStl,
  stackedPrismFacets,
} from "./fixtures/builders.ts";

const BOX_HALF: [number, number, number] = [5, 10, 20];
const boxBytes = encodeBinaryStl(boxFacets(BOX_HALF));
const bigBoxBytes = encodeBinaryStl(boxFacets([10, 20, 40])); // uniform 2x scale

// ---------------------------------------------------------------------------
// slice()
// ---------------------------------------------------------------------------

Deno.test("contract: slice() at z=5 through the box yields the full 10x20 cross-section, 8 triangles intersected", () => {
  const result = StlSlicer.slice(boxBytes, 5);
  assertEquals(result.trianglesIntersected, 8);
  assertAlmostEquals(result.bounds.width, 10, 1e-4);
  assertAlmostEquals(result.bounds.depth, 20, 1e-4);
  assertAlmostEquals(result.bounds.minX, -5, 1e-4);
  assertAlmostEquals(result.bounds.maxX, 5, 1e-4);
  assertAlmostEquals(result.bounds.minY, -10, 1e-4);
  assertAlmostEquals(result.bounds.maxY, 10, 1e-4);
  assertEquals(result.z, 5);
  if (result.svgPath.length === 0) {
    throw new Error("expected a non-empty svgPath");
  }
});

Deno.test("contract: centerZ() returns the box's exact mid-height", () => {
  assertAlmostEquals(StlSlicer.centerZ(boxBytes), 0, 1e-4);
});

Deno.test("contract: slice() above the box bounds yields zero segments and an empty svgPath", () => {
  const result = StlSlicer.slice(boxBytes, 1000);
  assertEquals(result.trianglesIntersected, 0);
  assertEquals(result.segments.length, 0);
  assertEquals(result.svgPath, "");
});

// ---------------------------------------------------------------------------
// principalAxes() / PCA
// ---------------------------------------------------------------------------

Deno.test("contract: principalAxes() on the box pins the measured (near-but-not-exactly-axis-aligned) primary/mid/short axes and sortedLengths", () => {
  const pca = StlSlicer.principalAxes(boxBytes);
  // Dominant component of each axis is close to +/-1 (Z, Y, X respectively)
  // but measurably off due to the uneven per-corner vertex weighting
  // described above -- pin the actual measured vectors, tight tolerance.
  assertAlmostEquals(pca.axes[0][0], 0.030468307089978844, 1e-9);
  assertAlmostEquals(pca.axes[0][1], 0.07391157603945879, 1e-9);
  assertAlmostEquals(pca.axes[0][2], 0.9967992582212498, 1e-9);
  assertAlmostEquals(pca.sortedLengths[0], 41.654884920538954, 1e-6);
  assertAlmostEquals(pca.sortedLengths[1], 23.56738012583072, 1e-6);
  assertAlmostEquals(pca.sortedLengths[2], 12.314310890166695, 1e-6);
  assertAlmostEquals(pca.centroid[0], 0, 1e-6);
  assertAlmostEquals(pca.centroid[1], 0, 1e-6);
  assertAlmostEquals(pca.centroid[2], 0, 1e-6);
});

// ---------------------------------------------------------------------------
// compare() — uniform 2x scale
// ---------------------------------------------------------------------------

Deno.test("contract: compare() between a box and its uniform 2x scale pins ratios of exactly 2 on every axis and zero proportion deltas", () => {
  const result = StlSlicer.compare(boxBytes, bigBoxBytes);
  // Scale-invariant: exact regardless of the axis-tilt perturbation above,
  // because doubling every coordinate scales the covariance matrix by
  // exactly 4 (IEEE-754 doubling is exact) with IDENTICAL eigenvectors.
  assertEquals(result.ratios[0], 2);
  assertEquals(result.ratios[1], 2);
  assertEquals(result.ratios[2], 2);
  assertAlmostEquals(result.refProportions.midToLong, 0.5657771032326211, 1e-9);
  assertAlmostEquals(
    result.refProportions.shortToLong,
    0.29562705343340956,
    1e-9,
  );
  // Proportions are IDENTICAL between ref and a uniformly-scaled model
  // (both derived from the same relative axis-tilt), regardless of the
  // absolute tilt value.
  assertEquals(result.modelProportions, result.refProportions);
  assertAlmostEquals(result.proportionDeltas.midToLong, 0, 1e-9);
  assertAlmostEquals(result.proportionDeltas.shortToLong, 0, 1e-9);
  // A uniformly-scaled copy of the same shape normalizes to an identical
  // profile curve.
  assertEquals(result.profileMatch, 1);
});

// ---------------------------------------------------------------------------
// sixViews()
// ---------------------------------------------------------------------------

Deno.test("contract: sixViews() bounds and per-view widthMm/heightMm match the box's exact extents", () => {
  const result = StlSlicer.sixViews(boxBytes);
  assertAlmostEquals(result.bounds.sizeX, 10, 1e-4);
  assertAlmostEquals(result.bounds.sizeY, 20, 1e-4);
  assertAlmostEquals(result.bounds.sizeZ, 40, 1e-4);

  assertAlmostEquals(result.front.widthMm, 10, 1e-4); // [X, Z]
  assertAlmostEquals(result.front.heightMm, 40, 1e-4);
  assertAlmostEquals(result.back.widthMm, 10, 1e-4); // [-X, Z]
  assertAlmostEquals(result.back.heightMm, 40, 1e-4);
  assertAlmostEquals(result.left.widthMm, 20, 1e-4); // [-Y, Z]
  assertAlmostEquals(result.left.heightMm, 40, 1e-4);
  assertAlmostEquals(result.right.widthMm, 20, 1e-4); // [Y, Z]
  assertAlmostEquals(result.right.heightMm, 40, 1e-4);
  assertAlmostEquals(result.top.widthMm, 10, 1e-4); // [X, -Y]
  assertAlmostEquals(result.top.heightMm, 20, 1e-4);
  assertAlmostEquals(result.bottom.widthMm, 10, 1e-4); // [X, Y]
  assertAlmostEquals(result.bottom.heightMm, 20, 1e-4);
  if (result.sheetSvg.length === 0) {
    throw new Error("expected a non-empty sheetSvg");
  }
});

Deno.test("contract: sixViews() with a reference overlay still returns the primary model's own bounds unchanged", () => {
  const result = StlSlicer.sixViews(boxBytes, 135, 260, bigBoxBytes);
  assertAlmostEquals(result.bounds.sizeX, 10, 1e-4);
  assertAlmostEquals(result.bounds.sizeZ, 40, 1e-4);
});

// ---------------------------------------------------------------------------
// analyzeSymmetry() — a per-axis binning quirk on a truly symmetric prism
// ---------------------------------------------------------------------------

Deno.test("contract: analyzeSymmetry() on a perfectly centered prism pins extentRatio=1 (genuinely symmetric extents) but score=0 for every axis -- the per-axis height bin classifies pos/neg by that SAME axis's sign, so a bin can practically never contain both sides at once", () => {
  // A prism centered at the origin has, by construction, IDENTICAL positive
  // and negative extents on every axis (extentRatio == 1). But the score
  // loop bins vertices by the axis's OWN raw coordinate into 30 slices and
  // then classifies pos/neg by that same coordinate's sign relative to the
  // centroid -- so within any single narrow bin, the vertices are almost
  // always all on ONE side already, and `posRadii.length>2 && negRadii.
  // length>2` is (for this discretely-vertexed synthetic solid) never
  // satisfied. This is a real, measured quirk of the shipped scoring
  // algorithm, not a hand-picked edge case.
  const stackedBytes = encodeBinaryStl(
    stackedPrismFacets(10, 40, 16, 20, [0, 0, 0]),
  );
  const result = StlSlicer.analyzeSymmetry(stackedBytes);
  for (const axis of result.axes) {
    assertEquals(axis.extentRatio, 1);
    assertEquals(axis.score, 0);
  }
  assertEquals(result.symmetricAxes.length, 0);
  assertEquals(result.asymmetricAxes.length, 3);
});

// ---------------------------------------------------------------------------
// extractProfile() — constant-radius prism
// ---------------------------------------------------------------------------

Deno.test("contract: extractProfile() on a height-subdivided prism yields a near-constant radius profile and a high symmetry score", () => {
  const stackedBytes = encodeBinaryStl(
    stackedPrismFacets(10, 40, 16, 20, [0, 0, 0]),
  );
  const profile = StlSlicer.extractProfile(stackedBytes, 20);
  assertEquals(profile.profile.length, 21);
  const radii = profile.profile.map((p) => p.radius);
  const maxR = Math.max(...radii);
  const minR = Math.min(...radii);
  // A regular 16-gon inscribed at radius 10 has every profile sample at
  // essentially the exact same distance (float32 round-trip noise only).
  assertAlmostEquals(minR, 10, 1e-3);
  assertAlmostEquals(maxR, 10, 1e-3);
  if (profile.symmetryScore < 0.85) {
    throw new Error(
      `expected a high rotational symmetry score, got ${profile.symmetryScore}`,
    );
  }
});
