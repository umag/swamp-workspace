# Reverse Engineering: Mesh to Parametric CAD

Best practices for reconstructing parametric models from reference STL meshes,
adapted for programmatic JSCAD generation without a CAD kernel.

---

## Standard Pipeline (Scan-to-CAD)

The established pipeline from commercial tools (Geomagic, SpaceClaim, SolidWorks):

1. **Pre-processing** — noise removal, hole filling, mesh simplification
2. **Segmentation** — partition mesh into regions of uniform geometric type
3. **Surface fitting** — fit analytic surfaces or freeform surfaces to each segment
4. **Feature recognition** — identify CAD features from the fitted surface network
5. **Parametric model construction** — build a feature tree that reproduces the shape

Our pipeline (implementable in TypeScript on triangle meshes):

1. **PCA** → establish coordinate frame, find primary axis
2. **Cross-section slicing** along primary axis → contour polygons at each height
3. **Circle/ellipse fitting** to each contour → radial profile for revolve body
4. **Topology change detection** in cross-sections → feature branch points
5. **Shape decomposition** → isolate body, spout, handle, base
6. **Skeleton extraction** for tubular features → hullChain centerline path
7. **B-spline fitting** to profiles and centerlines
8. **Validation** using RMS surface distance

---

## Feature Recognition Methods

### Axis of Revolution Detection
- For a surface of revolution, all vertex normals intersect the axis
- Practical: slice mesh at multiple heights, fit circles, axis = line through centers
- Source: Li et al., "GlobFit" (SIGGRAPH 2011)

### Tubular Feature Detection (spouts, pipes)
- Extract curve skeleton (medial axis), verify circular cross-sections
- Or: chain adjacent cylindrical RANSAC segments along a spine curve
- Source: Bénière et al., "Comprehensive reverse engineering" (CAD 2013)

### Toroidal Features (handles, loops)
- Gaussian curvature changes sign on a torus (+ outer, - inner)
- Topologically: a handle creates genus-1 (loop that doesn't bound a disk)
- Source: Attene et al., "Hierarchical mesh segmentation" (Visual Computer 2006)

### Prismatic Features (stepped bases)
- Detect planar regions via RANSAC or normal clustering
- Group co-planar faces, detect step transitions at different heights
- Source: Sunil & Pande, "Automatic feature recognition" (CAD 2008)

---

## Skeleton Extraction for Tubular Features

The **centroid-of-cross-sections** method is the simplest and most robust:

1. Isolate the tubular sub-mesh (via segmentation)
2. Identify the two boundary loops (body junction and opening)
3. Compute geodesic distance from one boundary
4. At each distance value, find the centroid of the level-set contour
5. The sequence of centroids IS the centerline → use as hullChain path
6. At each point, cross-section radius → sphere radius in the hullChain

More sophisticated: **Laplacian mesh contraction** (Au et al., SIGGRAPH 2008)
— iteratively contract mesh toward skeleton. ~10-20 iterations of solving
a sparse linear system. Produces clean 1D skeleton with branch detection.

---

## Shape Decomposition

### Shape Diameter Function (SDF) — best for our use case
For each face, cast rays inward, measure local thickness.
Parts with different thickness cluster separately:
- Body: thick
- Spout: thin tube
- Handle: thin curved tube
- Base: medium flat

Source: Shapira et al., "Consistent mesh partitioning using SDF"
(Visual Computer 2008)

### Dihedral Angle + Graph Cut
Compute dihedral angle at every mesh edge. Concave edges (angle > 180°)
are likely part boundaries. Find minimum-weight cycle separating regions.

Source: Katz & Tal, "Hierarchical mesh decomposition" (SIGGRAPH 2003)

### Practical approach for our pipeline
1. Cross-section slicing along primary axis
2. At each height, compare measured width/depth against revolve body radius
3. Where measured extent > body radius + threshold → feature present
4. Classify direction: +Y = spout, -Y = handle, stepped widths = base
5. Extract feature points at each height → centerline for hullChain

---

## Curve Fitting: B-Splines, Not Polynomials

**Why polynomials fail:** A single polynomial is C∞ smooth. Real profiles have
tangent discontinuities at feature transitions. Higher degree → Runge oscillation.

**B-splines are the standard:**
- Piecewise polynomial, degree p, C^{p-1} at interior knots
- **Degree 3 (cubic) is the default.** C² continuity looks smooth.
- Reduce continuity at feature boundaries by repeating knots
- 10-20 control points suffice for complex profiles

**Fitting procedure:**
1. Parameterize data using chord-length: tᵢ = tᵢ₋₁ + |pᵢ - pᵢ₋₁| / total
2. Place knots — uniform or at detected feature boundaries
3. Solve least-squares: minimize Σ|C(tᵢ) - pᵢ|² (linear system)

**Handling discontinuities:**
1. Detect jumps in first derivative of profile data
2. Segment profile at discontinuities
3. Fit separate B-splines to each smooth segment
4. Join with C⁰ at sharp corners, C¹ at soft transitions

**Implementation:**
- B-spline evaluation: de Boor's algorithm (~30 lines)
- Cubic interpolating spline: tridiagonal linear system, O(n)
- npm: `nurbs` package, or implement de Boor directly

Sources:
- Piegl & Tiller, *The NURBS Book* (Springer, 1997) — Chapter 9
- de Boor, *A Practical Guide to Splines* (Springer, 2001)

---

## Validation Metrics

### RMS Surface Distance (primary metric)
- For each vertex on model A, find closest point on B's surface
- Report: mean, RMS, max (Hausdorff), 90th percentile
- This is what commercial scan-comparison tools report

### Hausdorff Distance
- Maximum distance any point must travel to reach the other surface
- Use 90th/95th percentile variant for robustness against outliers
- Source: Aspert et al., "MESH" (IEEE ICME, 2002)

### Volume IoU (Intersection over Union)
- Voxelize both meshes, count agreeing/disagreeing voxels
- Single 0-1 score for overall shape match
- Fast, easy to implement

### Cross-Section Comparison
- Slice both meshes at same heights, compare 2D contours
- Metrics: area difference, contour Hausdorff, width/depth span difference
- Natural for cross-section-based reconstruction

### Our current metrics and what to add

| Have | Missing |
|------|---------|
| Aligned AABB comparison | RMS surface distance |
| PCA sorted lengths | Hausdorff distance (90th pct) |
| Profile match (PCA) | Volume IoU |
| MultiSlice span comparison | Per-feature comparison |
| Symmetry analysis | Cross-section area comparison |

---

## Summary: Recommended Improvements

1. **Add SDF-based decomposition** to `detectFeatures` — classify by thickness
2. **Add skeleton extraction** (centroid-of-cross-sections) for tubular features
3. **Replace polynomials with cubic B-splines** in `fitProfiles`
4. **Add RMS surface distance** as validation metric
5. **Update `generateScript`** to:
   - Decompose into features first
   - Use extrudeRotate for the body (from B-spline profile)
   - Use hullChain with skeleton-extracted centerline for tubes
   - Use torus for detected loops
   - Use stacked cylinders for stepped bases

Sources:
- Varady et al., "Reverse engineering of geometric models" (CAD 1997)
- Schnabel et al., "Efficient RANSAC" (CGF 2007)
- Au et al., "Skeleton extraction by mesh contraction" (SIGGRAPH 2008)
- Shapira et al., "SDF mesh partitioning" (Visual Computer 2008)
- Piegl & Tiller, *The NURBS Book* (1997)
- Besl & McKay, "ICP registration" (IEEE TPAMI 1992)
