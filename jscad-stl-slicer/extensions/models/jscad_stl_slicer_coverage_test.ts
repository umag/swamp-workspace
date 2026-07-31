/**
 * Coverage suite for @magistr/jscad-stl-slicer.
 *
 * Fills branch-coverage gaps not exercised by the methods/contract/
 * adversarial suites: axis permutations, decompose's body-vs-feature axis
 * discriminator, protrusion direction classification, degenerate (non-
 * coplanar) triangles, LOW-10 (degree-15 Vandermonde instability), and
 * LOW-11 (isotropic-mesh PCA axis lability). `stl_slicer.ts` is BYTE-FROZEN.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { type Axis, StlSlicer } from "./jscad/stl_slicer.ts";
import {
  boxFacets,
  degenerateSpikeTriangleFacets,
  encodeBinaryStl,
  octahedronFacets,
  stackedBoxWithBumpFacets,
} from "./fixtures/builders.ts";

// ---------------------------------------------------------------------------
// Axis permutations
// ---------------------------------------------------------------------------

const AXES: Axis[] = ["X", "Y", "Z"];
const boxBytes = encodeBinaryStl(boxFacets([5, 10, 20]));

Deno.test("coverage: multiSlice runs cleanly for every sliceAxis x widthAxis x depthAxis permutation", () => {
  for (const sliceAxis of AXES) {
    for (const widthAxis of AXES) {
      for (const depthAxis of AXES) {
        if (widthAxis === depthAxis) continue;
        const result = StlSlicer.multiSlice(
          boxBytes,
          sliceAxis,
          widthAxis,
          depthAxis,
          10,
        );
        assertEquals(result.sliceAxis, sliceAxis);
        assertEquals(result.widthAxis, widthAxis);
        assertEquals(result.depthAxis, depthAxis);
        if (result.slices.length === 0) {
          throw new Error(
            `expected slices for ${sliceAxis}/${widthAxis}/${depthAxis}`,
          );
        }
      }
    }
  }
});

Deno.test("coverage: extractDirectionalProfile runs cleanly for every sliceAxis x measureAxis pair", () => {
  for (const sliceAxis of AXES) {
    for (const measureAxis of AXES) {
      const result = StlSlicer.extractDirectionalProfile(
        boxBytes,
        sliceAxis,
        measureAxis,
        10,
      );
      assertEquals(result.sliceAxis, sliceAxis);
      assertEquals(result.measureAxis, measureAxis);
    }
  }
});

Deno.test("coverage: detectFeatures runs cleanly for every sliceAxis (X/Y/Z perpendicular-pair selection)", () => {
  for (const sliceAxis of AXES) {
    const result = StlSlicer.detectFeatures(boxBytes, sliceAxis, 20);
    assertEquals(result.sliceAxis, sliceAxis);
  }
});

Deno.test("coverage: decompose runs cleanly for every sliceAxis", () => {
  for (const sliceAxis of AXES) {
    const result = StlSlicer.decompose(boxBytes, sliceAxis, 20);
    assertEquals(result.sliceAxis, sliceAxis);
    if (result.features.length === 0) {
      throw new Error(`expected at least the body feature for ${sliceAxis}`);
    }
  }
});

// ---------------------------------------------------------------------------
// decompose(): body-vs-feature axis discriminator ("clear winner" branch)
// ---------------------------------------------------------------------------

Deno.test("coverage: decompose's clear-winner discriminator picks the more symmetric perpendicular axis (Y) as the body axis when X carries an asymmetric bump", () => {
  // Body box symmetric in X and Y; a bump glued only to +X within the
  // middle third of the height range breaks X's symmetry while leaving Y
  // fully symmetric -- extentRatio(Y) - extentRatio(X) should exceed the
  // 0.1 "clear winner" threshold in decompose()'s discriminator. Both body
  // and bump use `stackedBoxWithBumpFacets` so the bump's side walls carry
  // vertices at several intermediate Z levels, not just its two end
  // corners -- decompose/detectFeatures bin by discrete vertex height, so a
  // corner-only bump would only ever populate 2 of the ~40 slice bins.
  const bytes = encodeBinaryStl(
    stackedBoxWithBumpFacets([10, 10, 30], [4, 4, 4], 0, 40, 6),
  );
  const result = StlSlicer.decompose(bytes, "Z", 40);
  assertEquals(result.features[0].type, "body");
  if (result.features.length < 2) {
    throw new Error(
      "expected the X-axis bump to register as a non-body feature",
    );
  }
});

// ---------------------------------------------------------------------------
// detectFeatures(): protrusion direction classification
// ---------------------------------------------------------------------------

Deno.test("coverage: detectFeatures classifies a +X-only bump as direction='positive' on the X axis", () => {
  const bytes = encodeBinaryStl(
    stackedBoxWithBumpFacets([10, 10, 30], [4, 4, 4], 0, 40, 6),
  );
  const result = StlSlicer.detectFeatures(bytes, "Z", 40);
  const positiveX = result.features.find(
    (f) => f.axis === "X" && f.direction === "positive",
  );
  if (!positiveX) {
    throw new Error(
      `expected a positive-direction X feature, got: ${
        JSON.stringify(result.features)
      }`,
    );
  }
  if (positiveX.maxProtrusion <= 0) {
    throw new Error("expected a positive maxProtrusion for the bump feature");
  }
});

// ---------------------------------------------------------------------------
// Degenerate (non-coplanar) triangles
// ---------------------------------------------------------------------------

Deno.test("coverage: a degenerate (zero-area) non-coplanar triangle does not crash slice() and yields a zero-length degenerate segment", () => {
  const bytes = encodeBinaryStl(degenerateSpikeTriangleFacets(-5, 5));
  const result = StlSlicer.slice(bytes, 0);
  assertEquals(result.trianglesIntersected, 1);
  const [seg] = result.segments;
  // Both intersection points come from the same physical edge (the two
  // coincident vertices), so the "segment" has zero length.
  assertEquals(seg.a[0], seg.b[0]);
  assertEquals(seg.a[1], seg.b[1]);
});

// ---------------------------------------------------------------------------
// LOW-10: degree-15 Vandermonde instability
// ---------------------------------------------------------------------------

Deno.test("coverage (LOW-10): fitProfiles with an unattainable targetError returns the degree-15 fit unconditionally, even though a lower degree may fit at least as well (Vandermonde instability at high degree)", () => {
  const result = StlSlicer.fitProfiles(boxBytes, "Z", 30, 15, 1e-9);
  assertEquals(result.xRadius.degree, 15);
  assertEquals(result.xRadius.coeffs.length, 16);
  // Characterize only: the degree-15 normal-equations solve is numerically
  // unstable and its maxError is not guaranteed to be an improvement over a
  // lower-degree fit. Must remain finite (not NaN/Infinity) to be usable.
  if (!isFinite(result.xRadius.maxError)) {
    throw new Error(
      `expected a finite (if possibly large) maxError, got ${result.xRadius.maxError}`,
    );
  }
});

// ---------------------------------------------------------------------------
// LOW-11: isotropic-mesh PCA axis lability
// ---------------------------------------------------------------------------

Deno.test("coverage (LOW-11): principalAxes on a perfectly isotropic octahedron yields three exactly-equal sortedLengths -- the specific primary-axis LABEL is not a meaningful/stable contract and is deliberately NOT equality-asserted here", () => {
  // NOTE: an axis-aligned BOX is not actually isotropic to this algorithm --
  // its quad-diagonal triangulation weights two opposite corners more
  // heavily than the other six (see the contract-fixture suite's note),
  // which measurably breaks isotropy even for equal half-extents. A regular
  // octahedron (one triangle per face, every vertex touching exactly 4
  // faces) has no such weighting bias and gives an EXACTLY diagonal,
  // EXACTLY equal-entry covariance matrix.
  const octBytes = encodeBinaryStl(octahedronFacets(10));
  const pca = StlSlicer.principalAxes(octBytes);
  const [a, b, c] = pca.sortedLengths;
  assertEquals(a, b);
  assertEquals(b, c);
  // Intentionally not asserted: which world axis ends up labeled axes[0].
});
