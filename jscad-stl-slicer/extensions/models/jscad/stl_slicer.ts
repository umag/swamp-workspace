// Domain Service: StlSlicer
// Slices a binary STL at a given Z plane, produces 6-view engineering projections,
// and provides rotation-invariant mesh analysis (PCA alignment, profile extraction,
// proportional comparison).

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type SliceSegment = { a: Vec2; b: Vec2 };

export type Bounds3 = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
};

export type SliceResult = {
  z: number;
  segments: SliceSegment[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    depth: number;
  };
  svgPath: string;
  trianglesIntersected: number;
};

export type ViewEdge = { u1: number; v1: number; u2: number; v2: number };

// ── PCA & Analysis types ──

export type PrincipalAxes = {
  // Eigenvectors sorted by eigenvalue (largest first = primary axis)
  axes: [Vec3, Vec3, Vec3];
  // Eigenvalues (variance along each axis)
  eigenvalues: [number, number, number];
  // Centroid of the mesh
  centroid: Vec3;
  // Sorted axis lengths (longest, middle, shortest) — rotation-invariant
  sortedLengths: [number, number, number];
};

export type ProfilePoint = { radius: number; height: number };

export type ProfileResult = {
  // Primary axis used for slicing (from PCA)
  primaryAxis: Vec3;
  centroid: Vec3;
  // Profile points: [radius, height] along the primary axis
  profile: ProfilePoint[];
  // Number of slices taken
  sliceCount: number;
  // Symmetry score: 0 = no symmetry, 1 = perfect rotational symmetry
  symmetryScore: number;
};

export type ComparisonResult = {
  // Rotation-invariant sorted dimensions
  refSorted: [number, number, number];
  modelSorted: [number, number, number];
  // Ratios: model / reference for each (longest, middle, shortest)
  ratios: [number, number, number];
  // Proportional comparison (internal ratios)
  refProportions: { midToLong: number; shortToLong: number };
  modelProportions: { midToLong: number; shortToLong: number };
  proportionDeltas: { midToLong: number; shortToLong: number };
  // Profile comparison (if both profiles extracted)
  profileMatch: number | null; // 0-1, 1 = identical profiles
};

// ── Generic axis types ──

export type Axis = "X" | "Y" | "Z";

export type AABBComparison = {
  refAABB: Bounds3;
  modelAABB: Bounds3;
  deltas: { x: number; y: number; z: number };
  deltaPcts: { x: number; y: number; z: number };
  ratios: { x: number; y: number; z: number };
};

export type AxisSymmetry = {
  axis: Axis;
  score: number; // 0 = fully asymmetric, 1 = perfect mirror symmetry
  positiveExtent: number; // max extent in + direction from centroid
  negativeExtent: number; // max extent in - direction from centroid
  extentRatio: number; // min(pos,neg)/max(pos,neg); 1.0 = symmetric extents
};

export type SymmetryAnalysis = {
  centroid: Vec3;
  axes: [AxisSymmetry, AxisSymmetry, AxisSymmetry];
  symmetricAxes: Axis[];
  asymmetricAxes: Axis[];
};

export type DirectionalProfilePoint = {
  height: number;
  positiveExtent: number;
  negativeExtent: number;
  totalSpan: number;
};

export type DirectionalProfileResult = {
  sliceAxis: Axis;
  measureAxis: Axis;
  centroid: Vec3;
  profile: DirectionalProfilePoint[];
  sliceCount: number;
};

export type FeatureRegion = {
  heightRange: [number, number];
  axis: Axis;
  direction: "positive" | "negative" | "both";
  maxProtrusion: number;
  sliceCount: number;
};

export type FeatureDetectionResult = {
  sliceAxis: Axis;
  bodyEnvelope: {
    widthProfile: DirectionalProfilePoint[];
    depthProfile: DirectionalProfilePoint[];
  };
  features: FeatureRegion[];
};

export type CrossSectionMeasurement = {
  height: number;
  widthSpan: number;
  depthSpan: number;
  widthPositive: number;
  widthNegative: number;
  depthPositive: number;
  depthNegative: number;
};

export type MultiSliceResult = {
  sliceAxis: Axis;
  widthAxis: Axis;
  depthAxis: Axis;
  centroid: Vec3;
  slices: CrossSectionMeasurement[];
};

// Axis mapping determined by PCA: maps ref axes to model axes by eigenvalue rank
// e.g., if ref's longest axis is Z and model's longest is Y, axisMap.long = { ref: "Z", model: "Y" }
export type AxisMapping = {
  long: { ref: Axis; model: Axis };
  mid: { ref: Axis; model: Axis };
  short: { ref: Axis; model: Axis };
};

export type AlignedAABBComparison = {
  axisMapping: AxisMapping;
  // Per matched axis (long/mid/short), not per world axis
  long: {
    refSpan: number;
    modelSpan: number;
    delta: number;
    deltaPct: number;
    ratio: number;
  };
  mid: {
    refSpan: number;
    modelSpan: number;
    delta: number;
    deltaPct: number;
    ratio: number;
  };
  short: {
    refSpan: number;
    modelSpan: number;
    delta: number;
    deltaPct: number;
    ratio: number;
  };
};

export type ContourSlice = {
  height: number;
  axis: Axis;
  // Contour points in the slice plane: [u, v] where u and v are the two
  // perpendicular axes. Ordered by angle from centroid for clean polygon.
  points: Vec2[];
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
};

export type ContourStack = {
  sliceAxis: Axis;
  uAxis: Axis;
  vAxis: Axis;
  slices: ContourSlice[];
};

// ── B-spline types ──

export type BSplineCurve = {
  degree: number;
  knots: number[];
  controlPoints: number[]; // 1D control points (y values for profile curves)
  paramRange: [number, number];
};

export type BSplineFitResult = {
  curve: BSplineCurve;
  maxError: number;
  rmsError: number;
};

// ── Skeleton types ──

export type SkeletonPoint = {
  position: Vec3; // centerline position
  radius: number; // cross-section radius at this point
  height: number; // distance along the skeleton from start
};

export type SkeletonResult = {
  points: SkeletonPoint[];
  totalLength: number;
  startRadius: number;
  endRadius: number;
};

// ── Feature decomposition types ──

export type FeatureType = "body" | "tube" | "loop" | "platform";

export type DecomposedFeature = {
  type: FeatureType;
  heightRange: [number, number];
  // For body: revolve profile points [radius, height]
  bodyProfile?: Vec2[];
  // For tube: skeleton centerline
  skeleton?: SkeletonPoint[];
  // For loop: torus parameters
  loopCenter?: Vec3;
  loopRadius?: number;
  tubeRadius?: number;
  loopAxis?: Vec3;
  // For platform: stacked cylinder specs
  steps?: Array<{ radius: number; height: number; z: number }>;
};

export type DecompositionResult = {
  sliceAxis: Axis;
  features: DecomposedFeature[];
  jscadScript: string;
};

// ── Surface distance types ──

export type SurfaceDistanceResult = {
  meanDistance: number;
  rmsDistance: number;
  maxDistance: number; // Hausdorff
  percentile90: number;
  percentile95: number;
  sampleCount: number;
};

export type EnhancedComparisonResult = ComparisonResult & {
  alignedAABB: AlignedAABBComparison;
  symmetryRef: SymmetryAnalysis;
  symmetryModel: SymmetryAnalysis;
};

export type SixViewResult = {
  bounds: Bounds3;
  // 6 views: front(+Y→XZ), back(-Y→XZ), left(-X→YZ), right(+X→YZ), top(+Z→XY), bottom(-Z→XY)
  front: { edges: ViewEdge[]; widthMm: number; heightMm: number };
  back: { edges: ViewEdge[]; widthMm: number; heightMm: number };
  left: { edges: ViewEdge[]; widthMm: number; heightMm: number };
  right: { edges: ViewEdge[]; widthMm: number; heightMm: number };
  top: { edges: ViewEdge[]; widthMm: number; heightMm: number };
  bottom: { edges: ViewEdge[]; widthMm: number; heightMm: number };
  sheetSvg: string;
};

export const StlSlicer = {
  // ── Z-plane slice ──
  slice(bytes: Uint8Array, z: number): SliceResult {
    if (bytes.byteLength < 84) throw new Error("Not a valid binary STL");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);
    const segments: SliceSegment[] = [];

    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50;
      const v1: Vec3 = [
        view.getFloat32(off + 12, true),
        view.getFloat32(off + 16, true),
        view.getFloat32(off + 20, true),
      ];
      const v2: Vec3 = [
        view.getFloat32(off + 24, true),
        view.getFloat32(off + 28, true),
        view.getFloat32(off + 32, true),
      ];
      const v3: Vec3 = [
        view.getFloat32(off + 36, true),
        view.getFloat32(off + 40, true),
        view.getFloat32(off + 44, true),
      ];
      const seg = intersectTriangleZ([v1, v2, v3], z);
      if (seg) segments.push(seg);
    }

    if (segments.length === 0) {
      return {
        z,
        segments: [],
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, depth: 0 },
        svgPath: "",
        trianglesIntersected: 0,
      };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const seg of segments) {
      for (const pt of [seg.a, seg.b]) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      }
    }
    return {
      z,
      segments,
      bounds: {
        minX,
        maxX,
        minY,
        maxY,
        width: maxX - minX,
        depth: maxY - minY,
      },
      svgPath: buildSingleViewSvg(
        segments,
        minX,
        minY,
        maxX,
        maxY,
        `Z-slice at ${z.toFixed(1)}mm`,
      ),
      trianglesIntersected: segments.length,
    };
  },

  centerZ(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50;
      for (let v = 0; v < 3; v++) {
        const z = view.getFloat32(off + 20 + v * 12, true);
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    return (minZ + maxZ) / 2;
  },

  // ── PCA: find principal axes of the mesh (rotation-invariant orientation) ──
  principalAxes(bytes: Uint8Array): PrincipalAxes {
    const verts = readVertices(bytes);
    const centroid = computeCentroid(verts);
    const cov = computeCovariance(verts, centroid);
    const { eigenvalues, eigenvectors } = eigenDecomposition3x3(cov);

    // Sort by eigenvalue descending (largest variance = primary axis)
    const indexed: Array<{ val: number; vec: Vec3 }> = [
      { val: eigenvalues[0], vec: eigenvectors[0] },
      { val: eigenvalues[1], vec: eigenvectors[1] },
      { val: eigenvalues[2], vec: eigenvectors[2] },
    ];
    indexed.sort((a, b) => b.val - a.val);

    // Compute axis-aligned bounding box in PCA space for sorted lengths
    const axes = indexed.map((i) => i.vec) as [Vec3, Vec3, Vec3];
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) {
      const centered: Vec3 = [
        v[0] - centroid[0],
        v[1] - centroid[1],
        v[2] - centroid[2],
      ];
      for (let a = 0; a < 3; a++) {
        const proj = dot3(centered, axes[a]);
        if (proj < mins[a]) mins[a] = proj;
        if (proj > maxs[a]) maxs[a] = proj;
      }
    }
    const sortedLengths = [
      maxs[0] - mins[0],
      maxs[1] - mins[1],
      maxs[2] - mins[2],
    ] as [number, number, number];

    return {
      axes,
      eigenvalues: indexed.map((i) => i.val) as [number, number, number],
      centroid,
      sortedLengths,
    };
  },

  // ── Profile extraction: slice along primary axis, measure radius at each height ──
  extractProfile(bytes: Uint8Array, sliceCount = 50): ProfileResult {
    const pca = StlSlicer.principalAxes(bytes);
    const verts = readVertices(bytes);
    const primaryAxis = pca.axes[0];
    const centroid = pca.centroid;

    // Project all vertices onto primary axis to get height range
    let minH = Infinity, maxH = -Infinity;
    for (const v of verts) {
      const h = dot3([
        v[0] - centroid[0],
        v[1] - centroid[1],
        v[2] - centroid[2],
      ], primaryAxis);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }

    // For each slice, find the max radius from the primary axis
    const profile: ProfilePoint[] = [];
    const step = (maxH - minH) / sliceCount;
    let symmetrySum = 0;
    let symmetryCount = 0;

    for (let s = 0; s <= sliceCount; s++) {
      const h = minH + s * step;
      const tolerance = step * 0.6; // overlap slightly

      // Collect vertices near this height
      let maxR = 0;
      let minR = Infinity;
      let rCount = 0;
      const radii: number[] = [];

      for (const v of verts) {
        const centered: Vec3 = [
          v[0] - centroid[0],
          v[1] - centroid[1],
          v[2] - centroid[2],
        ];
        const projH = dot3(centered, primaryAxis);
        if (Math.abs(projH - h) > tolerance) continue;

        // Distance from the primary axis (radius in the perpendicular plane)
        const along: Vec3 = [
          primaryAxis[0] * projH,
          primaryAxis[1] * projH,
          primaryAxis[2] * projH,
        ];
        const perp: Vec3 = [
          centered[0] - along[0],
          centered[1] - along[1],
          centered[2] - along[2],
        ];
        const r = Math.sqrt(perp[0] ** 2 + perp[1] ** 2 + perp[2] ** 2);

        radii.push(r);
        if (r > maxR) maxR = r;
        if (r < minR) minR = r;
        rCount++;
      }

      if (rCount > 0) {
        profile.push({ radius: maxR, height: h - minH });

        // Symmetry: how uniform are the radii at this height?
        // Perfect rotational symmetry → all radii equal → stddev/mean ≈ 0
        if (radii.length > 4) {
          const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
          if (mean > 0.1) {
            const variance = radii.reduce((a, r) => a + (r - mean) ** 2, 0) /
              radii.length;
            const cv = Math.sqrt(variance) / mean; // coefficient of variation
            symmetrySum += Math.max(0, 1 - cv * 2); // cv=0 → 1.0, cv=0.5 → 0
            symmetryCount++;
          }
        }
      }
    }

    return {
      primaryAxis,
      centroid,
      profile,
      sliceCount,
      symmetryScore: symmetryCount > 0 ? symmetrySum / symmetryCount : 0,
    };
  },

  // ── Rotation-invariant comparison of two STL meshes ──
  compare(bytesRef: Uint8Array, bytesModel: Uint8Array): ComparisonResult {
    const refPca = StlSlicer.principalAxes(bytesRef);
    const modelPca = StlSlicer.principalAxes(bytesModel);

    const refS = refPca.sortedLengths;
    const modS = modelPca.sortedLengths;

    const ratios: [number, number, number] = [
      refS[0] > 0 ? modS[0] / refS[0] : 0,
      refS[1] > 0 ? modS[1] / refS[1] : 0,
      refS[2] > 0 ? modS[2] / refS[2] : 0,
    ];

    const refProportions = {
      midToLong: refS[0] > 0 ? refS[1] / refS[0] : 0,
      shortToLong: refS[0] > 0 ? refS[2] / refS[0] : 0,
    };
    const modelProportions = {
      midToLong: modS[0] > 0 ? modS[1] / modS[0] : 0,
      shortToLong: modS[0] > 0 ? modS[2] / modS[0] : 0,
    };

    // Extract profiles for shape comparison
    let profileMatch: number | null = null;
    try {
      const refProfile = StlSlicer.extractProfile(bytesRef, 30);
      const modelProfile = StlSlicer.extractProfile(bytesModel, 30);

      // Normalize both profiles to [0,1] height and [0,1] radius
      if (refProfile.profile.length > 2 && modelProfile.profile.length > 2) {
        const normalizeProfile = (p: ProfilePoint[]) => {
          const maxH = Math.max(...p.map((pt) => pt.height));
          const maxR = Math.max(...p.map((pt) => pt.radius));
          if (maxH === 0 || maxR === 0) return p;
          return p.map((pt) => ({
            radius: pt.radius / maxR,
            height: pt.height / maxH,
          }));
        };

        const normRef = normalizeProfile(refProfile.profile);
        const normMod = normalizeProfile(modelProfile.profile);

        // Sample both at 20 evenly-spaced heights and compare radii
        let diffSum = 0;
        const samples = 20;
        for (let i = 0; i <= samples; i++) {
          const t = i / samples;
          const rRef = interpolateProfile(normRef, t);
          const rMod = interpolateProfile(normMod, t);
          diffSum += Math.abs(rRef - rMod);
        }
        profileMatch = Math.max(0, 1 - diffSum / (samples + 1));
      }
    } catch {
      // Profile extraction can fail on non-manifold meshes
    }

    return {
      refSorted: refS,
      modelSorted: modS,
      ratios,
      refProportions,
      modelProportions,
      proportionDeltas: {
        midToLong: modelProportions.midToLong - refProportions.midToLong,
        shortToLong: modelProportions.shortToLong - refProportions.shortToLong,
      },
      profileMatch,
    };
  },

  // ── AABB comparison (axis-aligned, no rotation) ──
  aabbCompare(
    bytesRef: Uint8Array,
    bytesModel: Uint8Array,
  ): AlignedAABBComparison {
    const refBounds = computeAABB(readVertices(bytesRef));
    const modelBounds = computeAABB(readVertices(bytesModel));

    // Use PCA to determine axis mapping: which ref axis corresponds to which model axis
    const refPca = StlSlicer.principalAxes(bytesRef);
    const modelPca = StlSlicer.principalAxes(bytesModel);
    const axisMapping = buildAxisMapping(
      refBounds,
      modelBounds,
      refPca,
      modelPca,
    );

    const buildAxisComparison = (refSpan: number, modelSpan: number) => ({
      refSpan,
      modelSpan,
      delta: modelSpan - refSpan,
      deltaPct: refSpan > 0 ? ((modelSpan - refSpan) / refSpan) * 100 : 0,
      ratio: refSpan > 0 ? modelSpan / refSpan : 0,
    });

    return {
      axisMapping,
      long: buildAxisComparison(
        getSpan(refBounds, axisMapping.long.ref),
        getSpan(modelBounds, axisMapping.long.model),
      ),
      mid: buildAxisComparison(
        getSpan(refBounds, axisMapping.mid.ref),
        getSpan(modelBounds, axisMapping.mid.model),
      ),
      short: buildAxisComparison(
        getSpan(refBounds, axisMapping.short.ref),
        getSpan(modelBounds, axisMapping.short.model),
      ),
    };
  },

  // ── Per-axis symmetry analysis ──
  analyzeSymmetry(bytes: Uint8Array, threshold = 0.85): SymmetryAnalysis {
    const verts = readVertices(bytes);
    const centroid = computeCentroid(verts);
    const axisVecs: [Axis, Vec3][] = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], [
      "Z",
      [0, 0, 1],
    ]];
    const axes: AxisSymmetry[] = [];

    for (const [axisName, _axisVec] of axisVecs) {
      let posMax = 0, negMax = 0;
      // Bin vertices by height along this axis, compare +/- extent in perpendicular plane
      const idx = axisName === "X" ? 0 : axisName === "Y" ? 1 : 2;
      const perpIndices = [0, 1, 2].filter((i) => i !== idx);
      let minH = Infinity, maxH = -Infinity;
      for (const v of verts) {
        const h = v[idx] - centroid[idx];
        if (h > posMax) posMax = h;
        if (h < negMax) negMax = h; // negMax is negative
        if (v[idx] < minH) minH = v[idx];
        if (v[idx] > maxH) maxH = v[idx];
      }

      // Bin into slices along this axis, compare radial distributions on +/- sides
      const sliceCount = 30;
      const step = (maxH - minH) / sliceCount;
      let symmetrySum = 0, symmetryCount = 0;

      for (let s = 0; s < sliceCount; s++) {
        const hLow = minH + s * step;
        const hHigh = hLow + step;
        const posRadii: number[] = [];
        const negRadii: number[] = [];

        for (const v of verts) {
          if (v[idx] < hLow || v[idx] >= hHigh) continue;
          const perpDist = Math.sqrt(
            (v[perpIndices[0]] - centroid[perpIndices[0]]) ** 2 +
              (v[perpIndices[1]] - centroid[perpIndices[1]]) ** 2,
          );
          // Classify by which side of centroid along this axis
          if (v[idx] >= centroid[idx]) posRadii.push(perpDist);
          else negRadii.push(perpDist);
        }

        if (posRadii.length > 2 && negRadii.length > 2) {
          const posMax = Math.max(...posRadii);
          const negMax = Math.max(...negRadii);
          const maxR = Math.max(posMax, negMax);
          if (maxR > 0.1) {
            symmetrySum += 1 - Math.abs(posMax - negMax) / maxR;
            symmetryCount++;
          }
        }
      }

      const score = symmetryCount > 0 ? symmetrySum / symmetryCount : 0;
      const positiveExtent = posMax;
      const negativeExtent = Math.abs(negMax);
      const maxExtent = Math.max(positiveExtent, negativeExtent);
      const minExtent = Math.min(positiveExtent, negativeExtent);

      axes.push({
        axis: axisName,
        score,
        positiveExtent,
        negativeExtent,
        extentRatio: maxExtent > 0 ? minExtent / maxExtent : 0,
      });
    }

    const symmetricAxes = axes.filter((a) => a.score >= threshold).map((a) =>
      a.axis
    );
    const asymmetricAxes = axes.filter((a) => a.score < threshold).map((a) =>
      a.axis
    );

    return {
      centroid,
      axes: axes as [AxisSymmetry, AxisSymmetry, AxisSymmetry],
      symmetricAxes,
      asymmetricAxes,
    };
  },

  // ── Profile along a specified axis, measuring along another ──
  extractDirectionalProfile(
    bytes: Uint8Array,
    sliceAxis: Axis,
    measureAxis: Axis,
    sliceCount = 50,
  ): DirectionalProfileResult {
    const verts = readVertices(bytes);
    const centroid = computeCentroid(verts);
    const sliceIdx = axisIndex(sliceAxis);
    const measureIdx = axisIndex(measureAxis);

    let minH = Infinity, maxH = -Infinity;
    for (const v of verts) {
      if (v[sliceIdx] < minH) minH = v[sliceIdx];
      if (v[sliceIdx] > maxH) maxH = v[sliceIdx];
    }

    const step = (maxH - minH) / sliceCount;
    const tolerance = step * 0.6;
    const profile: DirectionalProfilePoint[] = [];

    for (let s = 0; s <= sliceCount; s++) {
      const h = minH + s * step;
      let posExtent = 0, negExtent = 0;

      for (const v of verts) {
        if (Math.abs(v[sliceIdx] - h) > tolerance) continue;
        const d = v[measureIdx] - centroid[measureIdx];
        if (d > posExtent) posExtent = d;
        if (d < -negExtent) negExtent = -d; // negExtent is positive magnitude
      }

      profile.push({
        height: h - minH,
        positiveExtent: posExtent,
        negativeExtent: negExtent,
        totalSpan: posExtent + negExtent,
      });
    }

    return { sliceAxis, measureAxis, centroid, profile, sliceCount };
  },

  // ── Multi-height cross-section with separate width and depth ──
  multiSlice(
    bytes: Uint8Array,
    sliceAxis: Axis,
    widthAxis: Axis,
    depthAxis: Axis,
    sliceCount = 30,
  ): MultiSliceResult {
    const verts = readVertices(bytes);
    const centroid = computeCentroid(verts);
    const sIdx = axisIndex(sliceAxis);
    const wIdx = axisIndex(widthAxis);
    const dIdx = axisIndex(depthAxis);

    let minH = Infinity, maxH = -Infinity;
    for (const v of verts) {
      if (v[sIdx] < minH) minH = v[sIdx];
      if (v[sIdx] > maxH) maxH = v[sIdx];
    }

    const step = (maxH - minH) / sliceCount;
    const tolerance = step * 0.6;
    const slices: CrossSectionMeasurement[] = [];

    for (let s = 0; s <= sliceCount; s++) {
      const h = minH + s * step;
      let wPos = 0, wNeg = 0, dPos = 0, dNeg = 0;

      for (const v of verts) {
        if (Math.abs(v[sIdx] - h) > tolerance) continue;
        const wd = v[wIdx] - centroid[wIdx];
        const dd = v[dIdx] - centroid[dIdx];
        if (wd > wPos) wPos = wd;
        if (-wd > wNeg) wNeg = -wd;
        if (dd > dPos) dPos = dd;
        if (-dd > dNeg) dNeg = -dd;
      }

      slices.push({
        height: h - minH,
        widthSpan: wPos + wNeg,
        depthSpan: dPos + dNeg,
        widthPositive: wPos,
        widthNegative: wNeg,
        depthPositive: dPos,
        depthNegative: dNeg,
      });
    }

    return { sliceAxis, widthAxis, depthAxis, centroid, slices };
  },

  // ── Feature detection: find protrusion regions ──
  detectFeatures(
    bytes: Uint8Array,
    sliceAxis: Axis,
    sliceCount = 50,
  ): FeatureDetectionResult {
    const _sIdx = axisIndex(sliceAxis);
    const perpAxes: [Axis, Axis] = sliceAxis === "X"
      ? ["Y", "Z"]
      : sliceAxis === "Y"
      ? ["X", "Z"]
      : ["X", "Y"];

    const widthProfile = StlSlicer.extractDirectionalProfile(
      bytes,
      sliceAxis,
      perpAxes[0],
      sliceCount,
    );
    const depthProfile = StlSlicer.extractDirectionalProfile(
      bytes,
      sliceAxis,
      perpAxes[1],
      sliceCount,
    );

    // Compute median body envelope for each profile
    const widthMedian = medianArray(
      widthProfile.profile.map((p) => p.totalSpan),
    );
    const depthMedian = medianArray(
      depthProfile.profile.map((p) => p.totalSpan),
    );

    const features: FeatureRegion[] = [];
    const minProtrusion = 5; // mm minimum to count as a feature

    // Check width axis for protrusions
    detectProtrusionsOnAxis(
      widthProfile.profile,
      widthMedian,
      perpAxes[0],
      minProtrusion,
      features,
    );
    // Check depth axis
    detectProtrusionsOnAxis(
      depthProfile.profile,
      depthMedian,
      perpAxes[1],
      minProtrusion,
      features,
    );

    return {
      sliceAxis,
      bodyEnvelope: {
        widthProfile: widthProfile.profile,
        depthProfile: depthProfile.profile,
      },
      features,
    };
  },

  // ── Extract actual cross-section contours at multiple heights ──
  extractContours(
    bytes: Uint8Array,
    sliceAxis: Axis,
    sliceCount = 40,
    pointsPerSlice = 64,
  ): ContourStack {
    const verts = readVertices(bytes, 200000);
    const sIdx = axisIndex(sliceAxis);
    const perpAxes: [Axis, Axis] = sliceAxis === "X"
      ? ["Y", "Z"]
      : sliceAxis === "Y"
      ? ["X", "Z"]
      : ["X", "Y"];
    const uIdx = axisIndex(perpAxes[0]);
    const vIdx = axisIndex(perpAxes[1]);

    // Find bounds along slice axis
    let minH = Infinity, maxH = -Infinity;
    for (const v of verts) {
      if (v[sIdx] < minH) minH = v[sIdx];
      if (v[sIdx] > maxH) maxH = v[sIdx];
    }

    const step = (maxH - minH) / sliceCount;
    const tolerance = step * 0.6;
    const slices: ContourSlice[] = [];

    for (let s = 0; s <= sliceCount; s++) {
      const h = minH + s * step;

      // Collect all vertices near this height
      const planePoints: Vec2[] = [];
      for (const v of verts) {
        if (Math.abs(v[sIdx] - h) > tolerance) continue;
        planePoints.push([v[uIdx], v[vIdx]]);
      }

      if (planePoints.length < 3) {
        slices.push({
          height: h - minH,
          axis: sliceAxis,
          points: [],
          bounds: { uMin: 0, uMax: 0, vMin: 0, vMax: 0 },
        });
        continue;
      }

      // Compute centroid of this slice
      let cu = 0, cv = 0;
      for (const [u, v] of planePoints) {
        cu += u;
        cv += v;
      }
      cu /= planePoints.length;
      cv /= planePoints.length;

      // Convert to polar, bin by angle, take max radius per bin → convex hull approx
      const bins = pointsPerSlice;
      const maxR: number[] = new Array(bins).fill(0);
      const binAngles: number[] = new Array(bins).fill(0);

      for (let b = 0; b < bins; b++) {
        binAngles[b] = (b / bins) * Math.PI * 2;
      }

      for (const [u, v] of planePoints) {
        const du = u - cu, dv = v - cv;
        const r = Math.sqrt(du * du + dv * dv);
        let angle = Math.atan2(dv, du);
        if (angle < 0) angle += Math.PI * 2;
        const bin = Math.floor(angle / (Math.PI * 2) * bins) % bins;
        if (r > maxR[bin]) maxR[bin] = r;
      }

      // Convert back to cartesian
      const contourPts: Vec2[] = [];
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (let b = 0; b < bins; b++) {
        if (maxR[b] > 0) {
          const u = cu + Math.cos(binAngles[b]) * maxR[b];
          const v = cv + Math.sin(binAngles[b]) * maxR[b];
          contourPts.push([u, v]);
          if (u < uMin) uMin = u;
          if (u > uMax) uMax = u;
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
        }
      }

      slices.push({
        height: h - minH,
        axis: sliceAxis,
        points: contourPts,
        bounds: { uMin, uMax, vMin, vMax },
      });
    }

    return { sliceAxis, uAxis: perpAxes[0], vAxis: perpAxes[1], slices };
  },

  // ── Polynomial profile fitting ──
  // Fits polynomials to multiSlice data for smooth curve generation
  fitProfiles(
    bytes: Uint8Array,
    sliceAxis: Axis,
    sliceCount = 40,
    maxDegree = 15,
    targetError = 2.0,
  ): {
    totalHeight: number;
    xRadius: { degree: number; coeffs: number[]; maxError: number };
    dP: { degree: number; coeffs: number[]; maxError: number };
    dN: { degree: number; coeffs: number[]; maxError: number };
  } {
    const perpAxes: [Axis, Axis] = sliceAxis === "X"
      ? ["Y", "Z"]
      : sliceAxis === "Y"
      ? ["X", "Z"]
      : ["X", "Y"];
    const ms = StlSlicer.multiSlice(
      bytes,
      sliceAxis,
      perpAxes[0],
      perpAxes[1],
      sliceCount,
    );

    const H = Math.max(...ms.slices.map((s) => s.height));
    if (H === 0) throw new Error("Zero height range");

    // Normalize heights to [0, 1]
    const hs = ms.slices.map((s) => s.height / H);
    const xR = ms.slices.map((s) => (s.widthPositive + s.widthNegative) / 2);
    const dP = ms.slices.map((s) => s.depthPositive);
    const dN = ms.slices.map((s) => s.depthNegative);

    const fitOne = (ys: number[]) => {
      for (let deg = 4; deg <= maxDegree; deg++) {
        const coeffs = leastSquaresPoly(hs, ys, deg);
        const maxErr = Math.max(
          ...hs.map((h, i) => Math.abs(evalPoly(coeffs, h) - ys[i])),
        );
        if (maxErr < targetError) {
          return { degree: deg, coeffs, maxError: maxErr };
        }
      }
      const coeffs = leastSquaresPoly(hs, ys, maxDegree);
      const maxErr = Math.max(
        ...hs.map((h, i) => Math.abs(evalPoly(coeffs, h) - ys[i])),
      );
      return { degree: maxDegree, coeffs, maxError: maxErr };
    };

    return {
      totalHeight: H,
      xRadius: fitOne(xR),
      dP: fitOne(dP),
      dN: fitOne(dN),
    };
  },

  // ── Generate JSCAD script from reference STL analysis ──
  generateScript(
    bytes: Uint8Array,
    sliceAxis: Axis = "Z",
    sliceCount = 60,
  ): string {
    const perpAxes: [Axis, Axis] = sliceAxis === "X"
      ? ["Y", "Z"]
      : sliceAxis === "Y"
      ? ["X", "Z"]
      : ["X", "Y"];
    const ms = StlSlicer.multiSlice(
      bytes,
      sliceAxis,
      perpAxes[0],
      perpAxes[1],
      sliceCount,
    );
    const fit = StlSlicer.fitProfiles(bytes, sliceAxis, sliceCount, 15, 2.0);
    const sym = StlSlicer.analyzeSymmetry(bytes);

    const H = fit.totalHeight;
    const centroid = ms.centroid;
    const _cIdx = axisIndex(perpAxes[1]); // depth axis centroid component

    // Format coefficients
    const fmtCoeffs = (c: number[]) =>
      "[" + c.map((v) => Math.round(v * 10000) / 10000).join(",") + "]";

    // Build piecewise data for the 4 directional extents
    const sliceData = ms.slices.map((s) => {
      const t = Math.round(s.height / H * 1000) / 1000;
      return `[${t},${Math.round(s.widthPositive * 10) / 10},${
        Math.round(s.widthNegative * 10) / 10
      },${Math.round(s.depthPositive * 10) / 10},${
        Math.round(s.depthNegative * 10) / 10
      }]`;
    });

    const widthAxis = perpAxes[0];
    const depthAxis = perpAxes[1];
    const cDepth = Math.round(centroid[axisIndex(depthAxis)] * 10) / 10;

    return `const main = (params = {}) => {
  const { polygon } = primitives;
  const { extrudeFromSlices, slice } = extrusions;

  // Generated from reference STL analysis
  // Slice axis: ${sliceAxis}, Width axis: ${widthAxis}, Depth axis: ${depthAxis}
  // Symmetry: ${widthAxis}=${
      sym.axes[axisIndex(widthAxis)].score > 0.85 ? "symmetric" : "asymmetric"
    }, ${depthAxis}=${
      sym.axes[axisIndex(depthAxis)].score > 0.85 ? "symmetric" : "asymmetric"
    }
  const H = ${Math.round(H * 10) / 10};
  const SLICES = 120;
  const SEGS_PER_QUAD = 12;
  const SEGS = SEGS_PER_QUAD * 4;

  // Width radius polynomial (degree ${fit.xRadius.degree}, max error ${
      Math.round(fit.xRadius.maxError * 10) / 10
    }mm)
  // Input: t ∈ [0,1], output: radius in mm
  const wCoeffs = ${fmtCoeffs(fit.xRadius.coeffs)};

  const evalPoly = (coeffs, t) => {
    let r = 0, tn = 1;
    for (const c of coeffs) { r += c * tn; tn *= t; }
    return Math.max(r, 0.5);
  };

  // 4-directional extents: [t, wPos, wNeg, dPos, dNeg]
  // Centroid ${depthAxis} = ${cDepth}
  const C_DEPTH = ${cDepth};
  const extentData = [
    ${sliceData.join(",\n    ")}
  ];

  const interp4 = (t) => {
    if (t <= extentData[0][0]) return extentData[0];
    if (t >= extentData[extentData.length-1][0]) return extentData[extentData.length-1];
    for (let i = 1; i < extentData.length; i++) {
      if (extentData[i][0] >= t) {
        const p = extentData[i-1], c = extentData[i];
        const f = (t - p[0]) / (c[0] - p[0]);
        return [t, p[1]+f*(c[1]-p[1]), p[2]+f*(c[2]-p[2]), p[3]+f*(c[3]-p[3]), p[4]+f*(c[4]-p[4])];
      }
    }
    return extentData[0];
  };

  const makeSlice = (h) => {
    const t = h / H;
    const wR = evalPoly(wCoeffs, t);
    const [, , , dP, dN] = interp4(t);
    // Y center shifts based on asymmetric extents; half-extent is the radius
    const yCenter = C_DEPTH + (dP - dN) / 2;
    const yR = Math.max((dP + dN) / 2, 0.5);

    const pts = [];
    for (let i = 0; i < SEGS; i++) {
      const angle = (i / SEGS) * Math.PI * 2;
      pts.push([Math.cos(angle) * wR, yCenter + Math.sin(angle) * yR, h]);
    }
    return slice.fromPoints(pts);
  };

  // Base polygon
  const wR0 = evalPoly(wCoeffs, 0);
  const [, , , dP0, dN0] = interp4(0);
  const yC0 = C_DEPTH + (dP0 - dN0) / 2;
  const yR0 = Math.max((dP0 + dN0) / 2, 0.5);
  const basePts = [];
  for (let i = 0; i < SEGS; i++) {
    const angle = (i / SEGS) * Math.PI * 2;
    basePts.push([Math.cos(angle) * wR0, yC0 + Math.sin(angle) * yR0]);
  }

  return extrudeFromSlices({
    numberOfSlices: SLICES + 1,
    callback: (progress, index) => makeSlice((index / SLICES) * H),
  }, polygon({ points: basePts }));
};`;
  },

  // ── B-spline profile fitting (replaces polynomial) ──
  fitBSpline(
    xs: number[],
    ys: number[],
    numControlPoints = 15,
    degree = 3,
  ): BSplineFitResult {
    const n = xs.length;
    if (n < degree + 1) {
      throw new Error("Not enough data points for B-spline degree");
    }

    // Chord-length parameterization
    const params: number[] = [0];
    let totalChord = 0;
    for (let i = 1; i < n; i++) {
      totalChord += Math.sqrt(
        (xs[i] - xs[i - 1]) ** 2 + (ys[i] - ys[i - 1]) ** 2,
      );
      params.push(totalChord);
    }
    for (let i = 0; i < n; i++) params[i] /= totalChord || 1;

    // Generate uniform knot vector with clamped ends
    const m = numControlPoints;
    const knots = bsplineUniformKnots(m, degree);

    // Build basis matrix and solve least-squares
    const N: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < m; j++) {
        row.push(bsplineBasis(j, degree, params[i], knots));
      }
      N.push(row);
    }

    // Solve N^T N c = N^T y
    const NtN: number[][] = Array.from(
      { length: m },
      () => new Array(m).fill(0),
    );
    const Nty: number[] = new Array(m).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        for (let k = 0; k < m; k++) NtN[j][k] += N[i][j] * N[i][k];
        Nty[j] += N[i][j] * ys[i];
      }
    }

    const controlPoints = solveLinearSystem(NtN, Nty);

    // Compute errors
    let maxErr = 0, sumSqErr = 0;
    for (let i = 0; i < n; i++) {
      const val = evaluateBSpline(params[i], controlPoints, degree, knots);
      const err = Math.abs(val - ys[i]);
      if (err > maxErr) maxErr = err;
      sumSqErr += err * err;
    }

    return {
      curve: { degree, knots, controlPoints, paramRange: [0, 1] },
      maxError: maxErr,
      rmsError: Math.sqrt(sumSqErr / n),
    };
  },

  // ── Skeleton extraction for tubular features ──
  extractSkeleton(
    bytes: Uint8Array,
    sliceAxis: Axis,
    featureAxis: Axis,
    sliceCount = 40,
  ): SkeletonResult {
    const verts = readVertices(bytes);
    const sIdx = axisIndex(sliceAxis);
    const fIdx = axisIndex(featureAxis);
    const centroid = computeCentroid(verts);

    // Get body radius at each height (from symmetric axis)
    const perpAxes: Axis[] = (["X", "Y", "Z"] as Axis[]).filter((a) =>
      a !== sliceAxis && a !== featureAxis
    );
    const bodyAxis = perpAxes[0];
    const bIdx = axisIndex(bodyAxis);

    let minH = Infinity, maxH = -Infinity;
    for (const v of verts) {
      if (v[sIdx] < minH) minH = v[sIdx];
      if (v[sIdx] > maxH) maxH = v[sIdx];
    }

    const step = (maxH - minH) / sliceCount;
    const tolerance = step * 0.6;
    const points: SkeletonPoint[] = [];

    for (let s = 0; s <= sliceCount; s++) {
      const h = minH + s * step;
      let bodyMaxR = 0;
      let featureMax = -Infinity, featureMin = Infinity;
      let featureCount = 0;

      for (const v of verts) {
        if (Math.abs(v[sIdx] - h) > tolerance) continue;
        // Body radius (symmetric axis)
        const br = Math.abs(v[bIdx] - centroid[bIdx]);
        if (br > bodyMaxR) bodyMaxR = br;
        // Feature axis extent
        const fd = v[fIdx];
        if (fd > featureMax) featureMax = fd;
        if (fd < featureMin) featureMin = fd;
        featureCount++;
      }

      if (featureCount < 3) continue;

      // Feature extends beyond body radius?
      const featureExtentPos = featureMax - centroid[fIdx];
      const featureExtentNeg = centroid[fIdx] - featureMin;

      // Check positive side
      if (featureExtentPos > bodyMaxR + 5) {
        const tubeCenter = (bodyMaxR + featureExtentPos) / 2 + centroid[fIdx];
        const tubeR = (featureExtentPos - bodyMaxR) / 2;
        const pos: Vec3 = [0, 0, 0];
        pos[sIdx] = h;
        pos[fIdx] = tubeCenter;
        pos[bIdx] = centroid[bIdx];
        points.push({ position: pos, radius: tubeR, height: h - minH });
      }

      // Check negative side
      if (featureExtentNeg > bodyMaxR + 5) {
        const tubeCenter = centroid[fIdx] - (bodyMaxR + featureExtentNeg) / 2;
        const tubeR = (featureExtentNeg - bodyMaxR) / 2;
        const pos: Vec3 = [0, 0, 0];
        pos[sIdx] = h;
        pos[fIdx] = tubeCenter;
        pos[bIdx] = centroid[bIdx];
        points.push({
          position: pos,
          radius: Math.abs(tubeR),
          height: h - minH,
        });
      }
    }

    // Compute total length along the skeleton
    let totalLength = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].position[0] - points[i - 1].position[0];
      const dy = points[i].position[1] - points[i - 1].position[1];
      const dz = points[i].position[2] - points[i - 1].position[2];
      totalLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    return {
      points,
      totalLength,
      startRadius: points.length > 0 ? points[0].radius : 0,
      endRadius: points.length > 0 ? points[points.length - 1].radius : 0,
    };
  },

  // ── RMS surface distance between two meshes ──
  surfaceDistance(
    bytesA: Uint8Array,
    bytesB: Uint8Array,
    sampleCount = 5000,
  ): SurfaceDistanceResult {
    // Read triangles from mesh B for closest-point queries (sample for large meshes)
    const triB = readTriangles(bytesB, 100000);
    // Sample points from mesh A
    const vertsA = readVertices(bytesA, sampleCount);

    // Auto-align: translate mesh A's centroid to mesh B's centroid
    const centA = computeCentroid(vertsA);
    const vertsB = readVertices(bytesB, 1000);
    const centB = computeCentroid(vertsB);
    const offset: Vec3 = [
      centB[0] - centA[0],
      centB[1] - centA[1],
      centB[2] - centA[2],
    ];
    const alignedVertsA = vertsA.map((v) =>
      [v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]] as Vec3
    );

    // Build simple spatial grid for mesh B triangles
    const _grid = buildTriangleGrid(triB, 50);

    const distances: number[] = [];
    for (const va of alignedVertsA) {
      // Brute force: check all triangles (accurate, slower but reliable)
      let best = Infinity;
      for (const t of triB) {
        const d = pointToTriangleDistance(va, t);
        if (d < best) best = d;
      }
      if (isFinite(best) && !isNaN(best)) distances.push(best);
    }

    if (distances.length === 0) {
      return {
        meanDistance: 0,
        rmsDistance: 0,
        maxDistance: 0,
        percentile90: 0,
        percentile95: 0,
        sampleCount: 0,
      };
    }

    distances.sort((a, b) => a - b);
    const n = distances.length;
    const sum = distances.reduce((a, b) => a + b, 0);
    const sumSq = distances.reduce((a, b) => a + b * b, 0);

    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    return {
      meanDistance: isFinite(mean) ? mean : 0,
      rmsDistance: isFinite(rms) ? rms : 0,
      maxDistance: isFinite(distances[n - 1]) ? distances[n - 1] : 0,
      percentile90: distances[Math.floor(n * 0.9)] ?? 0,
      percentile95: distances[Math.floor(n * 0.95)] ?? 0,
      sampleCount: n,
    };
  },

  // ── Full decomposition: segment mesh into features, generate JSCAD ──
  decompose(
    bytes: Uint8Array,
    sliceAxis: Axis = "Z",
    sliceCount = 60,
  ): DecompositionResult {
    const perpAxes: [Axis, Axis] = sliceAxis === "X"
      ? ["Y", "Z"]
      : sliceAxis === "Y"
      ? ["X", "Z"]
      : ["X", "Y"];
    const ms = StlSlicer.multiSlice(
      bytes,
      sliceAxis,
      perpAxes[0],
      perpAxes[1],
      sliceCount,
    );
    const sym = StlSlicer.analyzeSymmetry(bytes);

    const H = Math.max(...ms.slices.map((s) => s.height));
    const centroid = ms.centroid;
    const features: DecomposedFeature[] = [];

    // Determine which perpendicular axis is the body axis (symmetric) vs feature axis
    // Use extent ratio (how centered the axis is) as primary discriminator.
    // If both are similar, use cross-section variation: the axis where max extent
    // significantly exceeds the other axis's extent at the same height is the feature axis.
    const extRatios = perpAxes.map((a) => sym.axes[axisIndex(a)].extentRatio);

    let bodyAxisIdx: number;
    if (Math.abs(extRatios[0] - extRatios[1]) > 0.1) {
      // Clear winner: higher extent ratio = more symmetric = body axis
      bodyAxisIdx = extRatios[0] >= extRatios[1] ? 0 : 1;
    } else {
      // Extent ratios are similar — compare maximum excess per axis
      // The feature axis has at least one slice where it dominates by a large margin
      let maxExcess0 = 0, maxExcess1 = 0;
      for (const s of ms.slices) {
        const w = s.widthPositive + s.widthNegative;
        const d = s.depthPositive + s.depthNegative;
        const minWD = Math.min(w, d);
        if (minWD > 0) {
          if (d > w) maxExcess1 = Math.max(maxExcess1, (d - w) / minWD);
          if (w > d) maxExcess0 = Math.max(maxExcess0, (w - d) / minWD);
        }
      }
      // The axis with the LARGEST single excess is the feature axis
      bodyAxisIdx = maxExcess0 >= maxExcess1 ? 1 : 0;
    }

    const featureAxisIdx = 1 - bodyAxisIdx;
    const bodyAxis = perpAxes[bodyAxisIdx];
    const featureAxis = perpAxes[featureAxisIdx];

    // Extract body profile from the symmetric axis
    const bodyProfile: Vec2[] = [[0, 0]];
    const bodyRadii: number[] = [];
    for (const s of ms.slices) {
      const r = bodyAxisIdx === 0
        ? (s.widthPositive + s.widthNegative) / 2
        : (s.depthPositive + s.depthNegative) / 2;
      bodyProfile.push([r, s.height]);
      bodyRadii.push(r);
    }
    bodyProfile.push([0, H]);

    features.push({
      type: "body",
      heightRange: [0, H],
      bodyProfile,
    });

    // Detect tube features: where feature-axis extent > body radius
    const featureExtents = ms.slices.map((s, i) => {
      const dP = featureAxisIdx === 0 ? s.widthPositive : s.depthPositive;
      const dN = featureAxisIdx === 0 ? s.widthNegative : s.depthNegative;
      const bR = bodyRadii[i];
      return { h: s.height, dP, dN, bR };
    });

    // Positive-side tube (spout)
    const tubePosPoints: SkeletonPoint[] = [];
    for (const e of featureExtents) {
      if (e.dP > e.bR + 3) {
        const tubeCenter = centroid[axisIndex(featureAxis)] + (e.bR + e.dP) / 2;
        const tubeR = (e.dP - e.bR) / 2;
        const pos: Vec3 = [0, 0, 0];
        pos[axisIndex(sliceAxis)] = e.h + (ms.slices[0]?.height ?? 0);
        pos[axisIndex(featureAxis)] = tubeCenter;
        tubePosPoints.push({ position: pos, radius: tubeR, height: e.h });
      }
    }
    if (tubePosPoints.length > 2) {
      features.push({
        type: "tube",
        heightRange: [
          tubePosPoints[0].height,
          tubePosPoints[tubePosPoints.length - 1].height,
        ],
        skeleton: tubePosPoints,
      });
    }

    // Negative-side feature (handle/loop)
    const tubeNegPoints: SkeletonPoint[] = [];
    for (const e of featureExtents) {
      if (e.dN > e.bR + 3) {
        const tubeCenter = centroid[axisIndex(featureAxis)] - (e.bR + e.dN) / 2;
        const tubeR = (e.dN - e.bR) / 2;
        const pos: Vec3 = [0, 0, 0];
        pos[axisIndex(sliceAxis)] = e.h + (ms.slices[0]?.height ?? 0);
        pos[axisIndex(featureAxis)] = tubeCenter;
        tubeNegPoints.push({ position: pos, radius: tubeR, height: e.h });
      }
    }
    if (tubeNegPoints.length > 2) {
      // If it spans a limited height range, it's likely a loop (handle)
      const hRange = tubeNegPoints[tubeNegPoints.length - 1].height -
        tubeNegPoints[0].height;
      const avgR = tubeNegPoints.reduce((s, p) => s + p.radius, 0) /
        tubeNegPoints.length;
      const midH = (tubeNegPoints[0].height +
        tubeNegPoints[tubeNegPoints.length - 1].height) / 2;
      const midY = tubeNegPoints[Math.floor(tubeNegPoints.length / 2)]
        .position[axisIndex(featureAxis)];

      if (hRange < H * 0.4) {
        // Likely a loop/handle
        const loopCenter: Vec3 = [0, 0, 0];
        loopCenter[axisIndex(sliceAxis)] = midH;
        loopCenter[axisIndex(featureAxis)] = midY;
        features.push({
          type: "loop",
          heightRange: [
            tubeNegPoints[0].height,
            tubeNegPoints[tubeNegPoints.length - 1].height,
          ],
          loopCenter,
          loopRadius: hRange / 2,
          tubeRadius: avgR,
          loopAxis: sliceAxis === "Z"
            ? [1, 0, 0]
            : sliceAxis === "Y"
            ? [0, 0, 1]
            : [0, 1, 0],
        });
      } else {
        features.push({
          type: "tube",
          heightRange: [
            tubeNegPoints[0].height,
            tubeNegPoints[tubeNegPoints.length - 1].height,
          ],
          skeleton: tubeNegPoints,
        });
      }
    }

    // Detect base/platform: stepped widths at h≈0
    const baseSlices = ms.slices.filter((s) => s.height < H * 0.05);
    if (baseSlices.length > 0) {
      const maxBaseW = Math.max(...baseSlices.map((s) => s.widthSpan));
      const bodyWAtBase = bodyRadii[0] * 2;
      if (maxBaseW > bodyWAtBase * 1.5) {
        const steps = baseSlices.map((s) => ({
          radius: s.widthSpan / 2,
          height: (ms.slices[1]?.height ?? H / sliceCount) - 0,
          z: s.height,
        }));
        features.push({ type: "platform", heightRange: [0, H * 0.05], steps });
      }
    }

    // Generate JSCAD script
    const script = generateJscadFromFeatures(
      features,
      H,
      sliceAxis,
      featureAxis,
      centroid,
      bodyAxis,
    );

    return { sliceAxis, features, jscadScript: script };
  },

  // ── Enhanced comparison: PCA + aligned AABB + symmetry ──
  enhancedCompare(
    bytesRef: Uint8Array,
    bytesModel: Uint8Array,
  ): EnhancedComparisonResult {
    const pcaResult = StlSlicer.compare(bytesRef, bytesModel);
    const alignedAABB = StlSlicer.aabbCompare(bytesRef, bytesModel);
    const symmetryRef = StlSlicer.analyzeSymmetry(bytesRef);
    const symmetryModel = StlSlicer.analyzeSymmetry(bytesModel);

    return {
      ...pcaResult,
      alignedAABB,
      symmetryRef,
      symmetryModel,
    };
  },

  // ── 6-view orthographic projection ──
  sixViews(
    bytes: Uint8Array,
    refH = 135,
    refW = 260,
    refBytes?: Uint8Array,
  ): SixViewResult {
    if (bytes.byteLength < 84) throw new Error("Not a valid binary STL");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);

    // Collect triangle edges with 3D coords.
    // For large meshes (>50K triangles), sample uniformly to keep SVG size manageable.
    const MAX_TRIANGLES = 50000;
    const stride = triCount > MAX_TRIANGLES
      ? Math.ceil(triCount / MAX_TRIANGLES)
      : 1;

    const edges3d: Array<[Vec3, Vec3]> = [];
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;

    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50;
      const verts: Vec3[] = [
        [
          view.getFloat32(off + 12, true),
          view.getFloat32(off + 16, true),
          view.getFloat32(off + 20, true),
        ],
        [
          view.getFloat32(off + 24, true),
          view.getFloat32(off + 28, true),
          view.getFloat32(off + 32, true),
        ],
        [
          view.getFloat32(off + 36, true),
          view.getFloat32(off + 40, true),
          view.getFloat32(off + 44, true),
        ],
      ];
      // Always update bounds from every triangle for accurate measurements
      for (const [x, y, z] of verts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      // Only collect edges for sampled triangles (silhouette rendering)
      if (i % stride === 0) {
        edges3d.push([verts[0], verts[1]]);
        edges3d.push([verts[1], verts[2]]);
        edges3d.push([verts[2], verts[0]]);
      }
    }

    const bounds: Bounds3 = {
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      sizeX: maxX - minX,
      sizeY: maxY - minY,
      sizeZ: maxZ - minZ,
    };

    // Projection functions for 6 views
    const projections = {
      front: (v: Vec3): Vec2 => [v[0], v[2]],
      back: (v: Vec3): Vec2 => [-v[0], v[2]],
      right: (v: Vec3): Vec2 => [v[1], v[2]],
      left: (v: Vec3): Vec2 => [-v[1], v[2]],
      top: (v: Vec3): Vec2 => [v[0], -v[1]],
      bottom: (v: Vec3): Vec2 => [v[0], v[1]],
    };

    // Project model edges onto each view plane
    const front = projectEdges(edges3d, projections.front);
    const back = projectEdges(edges3d, projections.back);
    const right = projectEdges(edges3d, projections.right);
    const left = projectEdges(edges3d, projections.left);
    const top = projectEdges(edges3d, projections.top);
    const bottom = projectEdges(edges3d, projections.bottom);

    // Project reference STL edges if provided
    let refViews: Record<string, ProjectedView> | undefined;
    if (refBytes && refBytes.byteLength >= 84) {
      const refView = new DataView(
        refBytes.buffer,
        refBytes.byteOffset,
        refBytes.byteLength,
      );
      const refTriCount = refView.getUint32(80, true);
      const refStride = refTriCount > MAX_TRIANGLES
        ? Math.ceil(refTriCount / MAX_TRIANGLES)
        : 1;
      const refEdges3d: Array<[Vec3, Vec3]> = [];

      for (let i = 0; i < refTriCount; i++) {
        if (i % refStride !== 0) continue;
        const off = 84 + i * 50;
        const verts: Vec3[] = [
          [
            refView.getFloat32(off + 12, true),
            refView.getFloat32(off + 16, true),
            refView.getFloat32(off + 20, true),
          ],
          [
            refView.getFloat32(off + 24, true),
            refView.getFloat32(off + 28, true),
            refView.getFloat32(off + 32, true),
          ],
          [
            refView.getFloat32(off + 36, true),
            refView.getFloat32(off + 40, true),
            refView.getFloat32(off + 44, true),
          ],
        ];
        refEdges3d.push([verts[0], verts[1]]);
        refEdges3d.push([verts[1], verts[2]]);
        refEdges3d.push([verts[2], verts[0]]);
      }

      refViews = {
        front: projectEdges(refEdges3d, projections.front),
        back: projectEdges(refEdges3d, projections.back),
        right: projectEdges(refEdges3d, projections.right),
        left: projectEdges(refEdges3d, projections.left),
        top: projectEdges(refEdges3d, projections.top),
        bottom: projectEdges(refEdges3d, projections.bottom),
      };
    }

    const sheetSvg = buildSixViewSheet(
      bounds,
      front,
      back,
      left,
      right,
      top,
      bottom,
      refH,
      refW,
      refViews,
    );

    return {
      bounds,
      front: {
        edges: front.edges,
        widthMm: front.spanU,
        heightMm: front.spanV,
      },
      back: { edges: back.edges, widthMm: back.spanU, heightMm: back.spanV },
      left: { edges: left.edges, widthMm: left.spanU, heightMm: left.spanV },
      right: {
        edges: right.edges,
        widthMm: right.spanU,
        heightMm: right.spanV,
      },
      top: { edges: top.edges, widthMm: top.spanU, heightMm: top.spanV },
      bottom: {
        edges: bottom.edges,
        widthMm: bottom.spanU,
        heightMm: bottom.spanV,
      },
      sheetSvg,
    };
  },
};

// ── STL reading helpers ──

function axisIndex(axis: Axis): number {
  return axis === "X" ? 0 : axis === "Y" ? 1 : 2;
}

function _axisFromIndex(idx: number): Axis {
  return idx === 0 ? "X" : idx === 1 ? "Y" : "Z";
}

function computeAABB(verts: Vec3[]): Bounds3 {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x, y, z] of verts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

function getSpan(b: Bounds3, axis: Axis): number {
  return axis === "X" ? b.sizeX : axis === "Y" ? b.sizeY : b.sizeZ;
}

function buildAxisMapping(
  _refBounds: Bounds3,
  _modelBounds: Bounds3,
  refPca: PrincipalAxes,
  modelPca: PrincipalAxes,
): AxisMapping {
  // For each PCA eigenvector (sorted by eigenvalue), find which world axis it's closest to
  const findDominantAxis = (pca: PrincipalAxes): [Axis, Axis, Axis] => {
    return pca.axes.map((vec) => {
      const absX = Math.abs(vec[0]),
        absY = Math.abs(vec[1]),
        absZ = Math.abs(vec[2]);
      if (absX >= absY && absX >= absZ) return "X" as Axis;
      if (absY >= absX && absY >= absZ) return "Y" as Axis;
      return "Z" as Axis;
    }) as [Axis, Axis, Axis];
  };

  const refAxes = findDominantAxis(refPca);
  const modelAxes = findDominantAxis(modelPca);

  return {
    long: { ref: refAxes[0], model: modelAxes[0] },
    mid: { ref: refAxes[1], model: modelAxes[1] },
    short: { ref: refAxes[2], model: modelAxes[2] },
  };
}

function medianArray(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function detectProtrusionsOnAxis(
  profile: DirectionalProfilePoint[],
  medianSpan: number,
  axis: Axis,
  minProtrusion: number,
  features: FeatureRegion[],
): void {
  const threshold = Math.max(medianSpan * 1.3, medianSpan + minProtrusion);
  let regionStart = -1;
  let maxProt = 0;
  let direction: "positive" | "negative" | "both" = "both";

  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    const _totalExcess = p.totalSpan - medianSpan;
    const posExcess = p.positiveExtent - medianSpan / 2;
    const negExcess = p.negativeExtent - medianSpan / 2;

    if (p.totalSpan > threshold) {
      if (regionStart < 0) {
        regionStart = i;
        maxProt = 0;
        direction = "both";
      }
      const prot = p.totalSpan - medianSpan;
      if (prot > maxProt) {
        maxProt = prot;
        // Determine direction of protrusion
        if (posExcess > minProtrusion && negExcess <= minProtrusion) {
          direction = "positive";
        } else if (negExcess > minProtrusion && posExcess <= minProtrusion) {
          direction = "negative";
        } else direction = "both";
      }
    } else if (regionStart >= 0) {
      features.push({
        heightRange: [profile[regionStart].height, profile[i - 1].height],
        axis,
        direction,
        maxProtrusion: maxProt,
        sliceCount: i - regionStart,
      });
      regionStart = -1;
    }
  }

  // Close open region at end
  if (regionStart >= 0) {
    features.push({
      heightRange: [
        profile[regionStart].height,
        profile[profile.length - 1].height,
      ],
      axis,
      direction,
      maxProtrusion: maxProt,
      sliceCount: profile.length - regionStart,
    });
  }
}

// ── B-spline helpers ──

function bsplineUniformKnots(
  numControlPoints: number,
  degree: number,
): number[] {
  const m = numControlPoints + degree + 1;
  const knots: number[] = [];
  for (let i = 0; i < m; i++) {
    if (i <= degree) knots.push(0);
    else if (i >= m - degree - 1) knots.push(1);
    else knots.push((i - degree) / (m - 2 * degree - 1));
  }
  return knots;
}

function bsplineBasis(
  i: number,
  p: number,
  t: number,
  knots: number[],
): number {
  // de Boor-Cox recursion
  if (p === 0) {
    return (t >= knots[i] && t < knots[i + 1]) ||
        (t === knots[i + 1] && i + 1 === knots.length - 1)
      ? 1
      : 0;
  }
  let left = 0, right = 0;
  const dLeft = knots[i + p] - knots[i];
  const dRight = knots[i + p + 1] - knots[i + 1];
  if (dLeft > 0) {
    left = ((t - knots[i]) / dLeft) * bsplineBasis(i, p - 1, t, knots);
  }
  if (dRight > 0) {
    right = ((knots[i + p + 1] - t) / dRight) *
      bsplineBasis(i + 1, p - 1, t, knots);
  }
  return left + right;
}

function evaluateBSpline(
  t: number,
  controlPoints: number[],
  degree: number,
  knots: number[],
): number {
  let result = 0;
  for (let i = 0; i < controlPoints.length; i++) {
    result += bsplineBasis(i, degree, t, knots) * controlPoints[i];
  }
  return result;
}

function solveLinearSystem(A: number[][], b: number[]): number[] {
  const m = b.length;
  const aug = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < m; col++) {
    let maxRow = col, maxVal = Math.abs(aug[col][col]);
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(aug[r][col]) > maxVal) {
        maxRow = r;
        maxVal = Math.abs(aug[r][col]);
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-20) continue;
    for (let j = col; j <= m; j++) aug[col][j] /= pivot;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      for (let j = col; j <= m; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  return aug.map((r) => r[m]);
}

// ── Triangle / surface distance helpers ──

type Triangle3D = { v1: Vec3; v2: Vec3; v3: Vec3 };

function readTriangles(bytes: Uint8Array, maxTris = 0): Triangle3D[] {
  if (bytes.byteLength < 84) throw new Error("Not a valid binary STL");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = view.getUint32(80, true);
  const stride = maxTris > 0 && triCount > maxTris
    ? Math.ceil(triCount / maxTris)
    : 1;
  const tris: Triangle3D[] = [];
  for (let i = 0; i < triCount; i += stride) {
    const off = 84 + i * 50;
    tris.push({
      v1: [
        view.getFloat32(off + 12, true),
        view.getFloat32(off + 16, true),
        view.getFloat32(off + 20, true),
      ],
      v2: [
        view.getFloat32(off + 24, true),
        view.getFloat32(off + 28, true),
        view.getFloat32(off + 32, true),
      ],
      v3: [
        view.getFloat32(off + 36, true),
        view.getFloat32(off + 40, true),
        view.getFloat32(off + 44, true),
      ],
    });
  }
  return tris;
}

type SpatialGrid = { cells: Map<string, number[]>; cellSize: number };

function buildTriangleGrid(
  tris: Triangle3D[],
  resolution: number,
): SpatialGrid {
  // Find bounds
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const t of tris) {
    for (const v of [t.v1, t.v2, t.v3]) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }
  const cellSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / resolution;
  const cells = new Map<string, number[]>();

  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    // Insert triangle into all cells its AABB overlaps
    const tMinX = Math.min(t.v1[0], t.v2[0], t.v3[0]);
    const tMaxX = Math.max(t.v1[0], t.v2[0], t.v3[0]);
    const tMinY = Math.min(t.v1[1], t.v2[1], t.v3[1]);
    const tMaxY = Math.max(t.v1[1], t.v2[1], t.v3[1]);
    const tMinZ = Math.min(t.v1[2], t.v2[2], t.v3[2]);
    const tMaxZ = Math.max(t.v1[2], t.v2[2], t.v3[2]);

    const x0 = Math.floor(tMinX / cellSize), x1 = Math.floor(tMaxX / cellSize);
    const y0 = Math.floor(tMinY / cellSize), y1 = Math.floor(tMaxY / cellSize);
    const z0 = Math.floor(tMinZ / cellSize), z1 = Math.floor(tMaxZ / cellSize);

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x},${y},${z}`;
          const list = cells.get(key);
          if (list) list.push(i);
          else cells.set(key, [i]);
        }
      }
    }
  }
  return { cells, cellSize };
}

function pointToTriangleDistance(p: Vec3, t: Triangle3D): number {
  // Project point onto triangle plane, clamp to triangle, return distance
  const e0: Vec3 = [t.v2[0] - t.v1[0], t.v2[1] - t.v1[1], t.v2[2] - t.v1[2]];
  const e1: Vec3 = [t.v3[0] - t.v1[0], t.v3[1] - t.v1[1], t.v3[2] - t.v1[2]];
  const v0p: Vec3 = [p[0] - t.v1[0], p[1] - t.v1[1], p[2] - t.v1[2]];

  const d00 = dot3(e0, e0);
  const d01 = dot3(e0, e1);
  const d11 = dot3(e1, e1);
  const d20 = dot3(v0p, e0);
  const d21 = dot3(v0p, e1);

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-20) {
    // Degenerate triangle, return distance to nearest vertex
    return Math.min(
      Math.sqrt(
        (p[0] - t.v1[0]) ** 2 + (p[1] - t.v1[1]) ** 2 + (p[2] - t.v1[2]) ** 2,
      ),
      Math.sqrt(
        (p[0] - t.v2[0]) ** 2 + (p[1] - t.v2[1]) ** 2 + (p[2] - t.v2[2]) ** 2,
      ),
      Math.sqrt(
        (p[0] - t.v3[0]) ** 2 + (p[1] - t.v3[1]) ** 2 + (p[2] - t.v3[2]) ** 2,
      ),
    );
  }

  let u = (d11 * d20 - d01 * d21) / denom;
  let v = (d00 * d21 - d01 * d20) / denom;

  // Clamp to triangle
  if (u < 0) u = 0;
  if (v < 0) v = 0;
  if (u + v > 1) {
    const s = 1 / (u + v);
    u *= s;
    v *= s;
  }

  const closest: Vec3 = [
    t.v1[0] + u * e0[0] + v * e1[0],
    t.v1[1] + u * e0[1] + v * e1[1],
    t.v1[2] + u * e0[2] + v * e1[2],
  ];

  return Math.sqrt(
    (p[0] - closest[0]) ** 2 + (p[1] - closest[1]) ** 2 +
      (p[2] - closest[2]) ** 2,
  );
}

function _closestDistanceToMesh(
  p: Vec3,
  tris: Triangle3D[],
  grid: SpatialGrid,
): number {
  const cs = grid.cellSize;
  const cx = Math.floor(p[0] / cs),
    cy = Math.floor(p[1] / cs),
    cz = Math.floor(p[2] / cs);

  // Search expanding neighborhood
  let bestDist = Infinity;
  for (let r = 0; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) < r && Math.abs(dy) < r && Math.abs(dz) < r) {
            continue; // skip interior of previous radius
          }
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const indices = grid.cells.get(key);
          if (!indices) continue;
          for (const i of indices) {
            const d = pointToTriangleDistance(p, tris[i]);
            if (d < bestDist) bestDist = d;
          }
        }
      }
    }
    // If we found something within this radius's guaranteed distance, stop
    if (bestDist < (r + 1) * cs) break;
  }

  return bestDist;
}

// ── JSCAD script generation from decomposed features ──

function generateJscadFromFeatures(
  features: DecomposedFeature[],
  H: number,
  _sliceAxis: Axis,
  featureAxis: Axis,
  centroid: Vec3,
  _bodyAxis: Axis,
): string {
  const lines: string[] = [];
  lines.push(`const main = (params = {}) => {`);
  lines.push(
    `  const { polygon, cylinder, sphere, torus, cuboid } = primitives;`,
  );
  lines.push(`  const { union, subtract } = booleans;`);
  lines.push(`  const { translate, rotateX, rotateY, rotateZ } = transforms;`);
  lines.push(`  const { extrudeRotate } = extrusions;`);
  lines.push(`  const { hullChain } = hulls;`);
  lines.push(``);
  lines.push(`  const H = ${Math.round(H * 10) / 10};`);
  lines.push(``);

  const featureNames: string[] = [];

  for (let fi = 0; fi < features.length; fi++) {
    const f = features[fi];
    const name = `f${fi}_${f.type}`;
    featureNames.push(name);

    if (f.type === "body" && f.bodyProfile) {
      lines.push(`  // Feature ${fi}: Body (extrudeRotate)`);
      const pts = f.bodyProfile.map(([r, h]) =>
        `[${Math.round(r * 10) / 10},${Math.round(h * 10) / 10}]`
      ).join(",");
      lines.push(`  const ${name} = extrudeRotate({ segments: 64 },`);
      lines.push(`    polygon({ points: [${pts}] }));`);
      lines.push(``);
    }

    if (f.type === "tube" && f.skeleton && f.skeleton.length > 1) {
      lines.push(`  // Feature ${fi}: Tube (hullChain)`);
      lines.push(`  const ${name} = hullChain(`);
      for (const pt of f.skeleton) {
        const [x, y, z] = pt.position.map((v) => Math.round(v * 10) / 10);
        const r = Math.round(pt.radius * 10) / 10;
        lines.push(
          `    translate([${x},${y},${z}], sphere({ radius: ${r}, segments: 20 })),`,
        );
      }
      lines.push(`  );`);
      lines.push(``);
    }

    if (f.type === "loop" && f.loopCenter && f.loopRadius && f.tubeRadius) {
      lines.push(`  // Feature ${fi}: Loop/Handle (torus)`);
      const [cx, cy, cz] = f.loopCenter.map((v) => Math.round(v * 10) / 10);
      const lr = Math.round(f.loopRadius * 10) / 10;
      const tr = Math.round(f.tubeRadius * 10) / 10;
      const rotAxis = f.loopAxis || [1, 0, 0];
      const rotFn = rotAxis[0] ? "rotateX" : rotAxis[1] ? "rotateY" : "rotateZ";
      lines.push(`  const ${name} = translate([${cx},${cy},${cz}],`);
      lines.push(
        `    ${rotFn}(Math.PI / 2, torus({ innerRadius: ${tr}, outerRadius: ${lr}, outerSegments: 48, innerSegments: 12 })));`,
      );
      lines.push(``);
    }

    if (f.type === "platform" && f.steps) {
      lines.push(`  // Feature ${fi}: Base platform`);
      const stepStrs = f.steps.map((s) =>
        `cylinder({ radius: ${Math.round(s.radius * 10) / 10}, height: ${
          Math.round(s.height * 10) / 10
        }, center: [0,0,${Math.round(s.z * 10) / 10}], segments: 48 })`
      );
      lines.push(`  const ${name} = union(${stepStrs.join(", ")});`);
      lines.push(``);
    }
  }

  // Clip body -Y side if featureAxis is Y and body extends beyond reference
  const fIdx = axisIndex(featureAxis);
  const clipY = centroid[fIdx] - 65; // approximate -Y clip from centroid
  lines.push(`  const raw = union(${featureNames.join(", ")});`);
  lines.push(
    `  const clipNeg = cuboid({ size: [300, 300, H + 20], center: [0, ${
      Math.round(clipY - 150)
    }, H/2] });`,
  );
  lines.push(`  return subtract(raw, clipNeg);`);
  lines.push(`};`);

  return lines.join("\n");
}

// ── Polynomial fitting helpers ──

function evalPoly(coeffs: number[], x: number): number {
  let result = 0, xn = 1;
  for (const c of coeffs) {
    result += c * xn;
    xn *= x;
  }
  return result;
}

function leastSquaresPoly(
  xs: number[],
  ys: number[],
  degree: number,
): number[] {
  const n = xs.length;
  const m = degree + 1;

  // Build normal equations: V^T V c = V^T y
  // V is Vandermonde matrix
  const VtV: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const Vty: number[] = new Array(m).fill(0);

  for (let i = 0; i < n; i++) {
    const row: number[] = new Array(m);
    row[0] = 1;
    for (let j = 1; j < m; j++) row[j] = row[j - 1] * xs[i];

    for (let j = 0; j < m; j++) {
      for (let k = 0; k < m; k++) VtV[j][k] += row[j] * row[k];
      Vty[j] += row[j] * ys[i];
    }
  }

  // Gaussian elimination with partial pivoting
  const aug = VtV.map((r, i) => [...r, Vty[i]]);
  for (let col = 0; col < m; col++) {
    let maxRow = col, maxVal = Math.abs(aug[col][col]);
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(aug[r][col]) > maxVal) {
        maxRow = r;
        maxVal = Math.abs(aug[r][col]);
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-20) continue;
    for (let j = col; j <= m; j++) aug[col][j] /= pivot;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      for (let j = col; j <= m; j++) aug[r][j] -= f * aug[col][j];
    }
  }

  return aug.map((r) => r[m]);
}

// ── STL reading helpers ──

function readVertices(bytes: Uint8Array, sampleMax = 100000): Vec3[] {
  if (bytes.byteLength < 84) throw new Error("Not a valid binary STL");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = view.getUint32(80, true);
  const stride = triCount * 3 > sampleMax
    ? Math.ceil(triCount / (sampleMax / 3))
    : 1;
  const verts: Vec3[] = [];

  for (let i = 0; i < triCount; i += stride) {
    const off = 84 + i * 50;
    verts.push([
      view.getFloat32(off + 12, true),
      view.getFloat32(off + 16, true),
      view.getFloat32(off + 20, true),
    ]);
    verts.push([
      view.getFloat32(off + 24, true),
      view.getFloat32(off + 28, true),
      view.getFloat32(off + 32, true),
    ]);
    verts.push([
      view.getFloat32(off + 36, true),
      view.getFloat32(off + 40, true),
      view.getFloat32(off + 44, true),
    ]);
  }
  return verts;
}

function computeCentroid(verts: Vec3[]): Vec3 {
  let sx = 0, sy = 0, sz = 0;
  for (const [x, y, z] of verts) {
    sx += x;
    sy += y;
    sz += z;
  }
  const n = verts.length;
  return [sx / n, sy / n, sz / n];
}

function computeCovariance(verts: Vec3[], centroid: Vec3): number[][] {
  // 3x3 covariance matrix
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const v of verts) {
    const d: Vec3 = [
      v[0] - centroid[0],
      v[1] - centroid[1],
      v[2] - centroid[2],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        c[i][j] += d[i] * d[j];
      }
    }
  }
  const n = verts.length;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] /= n;
  return c;
}

// Jacobi eigenvalue algorithm for symmetric 3x3 matrix
function eigenDecomposition3x3(
  m: number[][],
): { eigenvalues: Vec3; eigenvectors: [Vec3, Vec3, Vec3] } {
  // Work on a copy
  const a = m.map((r) => [...r]);
  // Eigenvectors start as identity
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (let iter = 0; iter < 50; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (Math.abs(a[i][j]) > maxVal) {
          maxVal = Math.abs(a[i][j]);
          p = i;
          q = j;
        }
      }
    }
    if (maxVal < 1e-12) break;

    // Compute rotation angle
    const theta = a[p][p] === a[q][q]
      ? Math.PI / 4
      : 0.5 * Math.atan2(2 * a[p][q], a[p][p] - a[q][q]);
    const c = Math.cos(theta), s = Math.sin(theta);

    // Rotate matrix: A' = G^T A G
    const newA = a.map((r) => [...r]);
    newA[p][p] = c * c * a[p][p] + 2 * s * c * a[p][q] + s * s * a[q][q];
    newA[q][q] = s * s * a[p][p] - 2 * s * c * a[p][q] + c * c * a[q][q];
    newA[p][q] = 0;
    newA[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i === p || i === q) continue;
      newA[i][p] = c * a[i][p] + s * a[i][q];
      newA[p][i] = newA[i][p];
      newA[i][q] = -s * a[i][p] + c * a[i][q];
      newA[q][i] = newA[i][q];
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) a[i][j] = newA[i][j];
    }

    // Update eigenvectors
    for (let i = 0; i < 3; i++) {
      const vip = v[i][p], viq = v[i][q];
      v[i][p] = c * vip + s * viq;
      v[i][q] = -s * vip + c * viq;
    }
  }

  const eigenvalues: Vec3 = [a[0][0], a[1][1], a[2][2]];
  const eigenvectors: [Vec3, Vec3, Vec3] = [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]],
  ];

  return { eigenvalues, eigenvectors };
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function interpolateProfile(
  profile: { radius: number; height: number }[],
  t: number,
): number {
  if (profile.length === 0) return 0;
  if (t <= 0) return profile[0].radius;
  if (t >= 1) return profile[profile.length - 1].radius;

  for (let i = 1; i < profile.length; i++) {
    if (profile[i].height >= t) {
      const prev = profile[i - 1];
      const curr = profile[i];
      const frac = (t - prev.height) / (curr.height - prev.height);
      return prev.radius + frac * (curr.radius - prev.radius);
    }
  }
  return profile[profile.length - 1].radius;
}

// ── Slice & projection helpers ──

function intersectTriangleZ(
  verts: [Vec3, Vec3, Vec3],
  zPlane: number,
): SliceSegment | null {
  const pts: Vec2[] = [];
  const edges: [Vec3, Vec3][] = [[verts[0], verts[1]], [verts[1], verts[2]], [
    verts[2],
    verts[0],
  ]];
  for (const [a, b] of edges) {
    const za = a[2], zb = b[2];
    if ((za <= zPlane && zb > zPlane) || (zb <= zPlane && za > zPlane)) {
      const t = (zPlane - za) / (zb - za);
      pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  if (pts.length < 2) return null;
  return { a: pts[0], b: pts[1] };
}

type ProjectedView = {
  edges: ViewEdge[];
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  spanU: number;
  spanV: number;
};

function projectEdges(
  edges3d: Array<[Vec3, Vec3]>,
  project: (v: Vec3) => Vec2,
): ProjectedView {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const edges: ViewEdge[] = edges3d.map(([a, b]) => {
    const [u1, v1] = project(a);
    const [u2, v2] = project(b);
    if (u1 < minU) minU = u1;
    if (u1 > maxU) maxU = u1;
    if (u2 < minU) minU = u2;
    if (u2 > maxU) maxU = u2;
    if (v1 < minV) minV = v1;
    if (v1 > maxV) maxV = v1;
    if (v2 < minV) minV = v2;
    if (v2 > maxV) maxV = v2;
    return { u1, v1, u2, v2 };
  });
  return {
    edges,
    minU,
    maxU,
    minV,
    maxV,
    spanU: maxU - minU,
    spanV: maxV - minV,
  };
}

function buildSingleViewSvg(
  segments: SliceSegment[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  label: string,
): string {
  const pad = 10, scale = 2;
  const w = Math.ceil((maxX - minX) * scale + pad * 2);
  const h = Math.ceil((maxY - minY) * scale + pad * 2);
  const tx = (x: number) => (x - minX) * scale + pad;
  const ty = (y: number) => h - ((y - minY) * scale + pad);
  const lines = segments.map((s) =>
    `<line x1="${tx(s.a[0]).toFixed(1)}" y1="${ty(s.a[1]).toFixed(1)}" x2="${
      tx(s.b[0]).toFixed(1)
    }" y2="${ty(s.b[1]).toFixed(1)}" stroke="#2563eb" stroke-width="1.5"/>`
  ).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="#f8fafc"/>
  ${lines}
  <text x="${pad}" y="${h - 2}" font-size="8" fill="#64748b">${label} — ${
    (maxX - minX).toFixed(1)
  }×${(maxY - minY).toFixed(1)}mm</text>
</svg>`;
}

// Build a 6-view engineering drawing sheet with reference silhouette overlays
function buildSixViewSheet(
  bounds: Bounds3,
  front: ProjectedView,
  back: ProjectedView,
  left: ProjectedView,
  right: ProjectedView,
  top: ProjectedView,
  bottom: ProjectedView,
  refH: number,
  refW: number,
  refViews?: Record<string, ProjectedView>,
): string {
  const PAD = 20; // padding around each view
  const LABEL = 16; // label height below each view
  const SCALE = 1.5; // px per mm

  // Cell size: max of all view spans to keep uniform scale
  const cellW = Math.ceil(
    Math.max(
          front.spanU,
          back.spanU,
          left.spanU,
          right.spanU,
          top.spanU,
          bottom.spanU,
        ) * SCALE + PAD * 2,
  );
  const cellH = Math.ceil(
    Math.max(
          front.spanV,
          back.spanV,
          left.spanV,
          right.spanV,
          top.spanV,
          bottom.spanV,
        ) * SCALE + PAD * 2 + LABEL,
  );

  // Layout: 3 columns × 2 rows
  // Row 0: Front | Right | Back
  // Row 1: Top   | Left  | Bottom
  const COLS = 3, ROWS = 2;
  const totalW = cellW * COLS + 40;
  const totalH = cellH * ROWS + 60;

  const views = [
    {
      v: front,
      label: `FRONT  ${front.spanU.toFixed(1)}W×${front.spanV.toFixed(1)}H mm`,
      col: 0,
      row: 0,
    },
    {
      v: right,
      label: `RIGHT  ${right.spanU.toFixed(1)}W×${right.spanV.toFixed(1)}H mm`,
      col: 1,
      row: 0,
    },
    {
      v: back,
      label: `BACK   ${back.spanU.toFixed(1)}W×${back.spanV.toFixed(1)}H mm`,
      col: 2,
      row: 0,
    },
    {
      v: top,
      label: `TOP    ${top.spanU.toFixed(1)}W×${top.spanV.toFixed(1)}H mm`,
      col: 0,
      row: 1,
    },
    {
      v: left,
      label: `LEFT   ${left.spanU.toFixed(1)}W×${left.spanV.toFixed(1)}H mm`,
      col: 1,
      row: 1,
    },
    {
      v: bottom,
      label: `BOTTOM ${bottom.spanU.toFixed(1)}W×${
        bottom.spanV.toFixed(1)
      }H mm`,
      col: 2,
      row: 1,
    },
  ];

  // View name keys matching refViews
  const viewKeys = ["front", "right", "back", "top", "left", "bottom"];

  const svgContent = views.map(({ v, label, col, row }, idx) => {
    const ox = col * cellW + 20; // origin X of this cell
    const oy = row * cellH + 40; // origin Y of this cell

    // Map view coords to cell pixels (model's coordinate space)
    const tu = (u: number) => ox + PAD + (u - v.minU) * SCALE;
    const tv = (vv: number) => oy + PAD + (v.maxV - vv) * SCALE; // flip V (Y up)

    // Draw all projected model edges (blue)
    const edgeLines = v.edges.map((e) =>
      `<line x1="${tu(e.u1).toFixed(1)}" y1="${tv(e.v1).toFixed(1)}" ` +
      `x2="${tu(e.u2).toFixed(1)}" y2="${tv(e.v2).toFixed(1)}" ` +
      `stroke="#2563eb" stroke-width="0.3" opacity="0.12"/>`
    ).join("");

    // Cell border
    const border = `<rect x="${ox}" y="${oy}" width="${cellW - 4}" height="${
      cellH - LABEL - 4
    }" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.5"/>`;

    // Label
    const labelEl = `<text x="${ox + PAD}" y="${
      oy + cellH - LABEL + 10
    }" font-size="9" font-family="monospace" fill="#334155">${label}</text>`;

    // Reference silhouette from actual STL (red, all 6 views)
    let refPath = "";
    const viewKey = viewKeys[idx];
    if (refViews && refViews[viewKey]) {
      const rv = refViews[viewKey];
      // Scale reference to fit within the same cell, centered
      // Map ref coords into the cell using the model's coordinate space
      // Center the reference overlay on the model's center
      const modelCenterU = (v.minU + v.maxU) / 2;
      const modelCenterV = (v.minV + v.maxV) / 2;
      const refCenterU = (rv.minU + rv.maxU) / 2;
      const refCenterV = (rv.minV + rv.maxV) / 2;
      const offsetU = modelCenterU - refCenterU;
      const offsetV = modelCenterV - refCenterV;

      const refLines = rv.edges.map((e) =>
        `<line x1="${tu(e.u1 + offsetU).toFixed(1)}" y1="${
          tv(e.v1 + offsetV).toFixed(1)
        }" ` +
        `x2="${tu(e.u2 + offsetU).toFixed(1)}" y2="${
          tv(e.v2 + offsetV).toFixed(1)
        }" ` +
        `stroke="#dc2626" stroke-width="0.3" opacity="0.10"/>`
      ).join("");
      refPath = refLines;
    }

    // Center crosshairs
    const cx = tu((v.minU + v.maxU) / 2);
    const cy = tv((v.minV + v.maxV) / 2);
    const cross = `<line x1="${(cx - 6).toFixed(0)}" y1="${
      cy.toFixed(0)
    }" x2="${(cx + 6).toFixed(0)}" y2="${
      cy.toFixed(0)
    }" stroke="#94a3b8" stroke-width="0.5"/>
    <line x1="${cx.toFixed(0)}" y1="${(cy - 6).toFixed(0)}" x2="${
      cx.toFixed(0)
    }" y2="${(cy + 6).toFixed(0)}" stroke="#94a3b8" stroke-width="0.5"/>`;

    return `${border}${refPath}${edgeLines}${cross}${labelEl}`;
  }).join("\n");

  // Title
  const title =
    `<text x="20" y="25" font-size="13" font-family="monospace" font-weight="bold" fill="#1e293b">6-VIEW PROJECTION  [Blue=model  Red=reference]</text>
  <text x="20" y="38" font-size="9" font-family="monospace" fill="#64748b">Overall: ${
      bounds.sizeX.toFixed(1)
    }W × ${bounds.sizeY.toFixed(1)}D × ${
      bounds.sizeZ.toFixed(1)
    }H mm  |  Ref: ~${refW}L × ${refH}H mm</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}">
  <rect width="${totalW}" height="${totalH}" fill="#ffffff"/>
  ${title}
  ${svgContent}
</svg>`;
}
