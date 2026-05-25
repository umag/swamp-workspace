# Feature-Based Modeling for Programmatic CAD

Engineering principles for generating correct 3D models in JSCAD, adapted from
GD&T (ASME Y14.5), feature-based CAD (SolidWorks/Fusion360 paradigm), and
orthographic projection standards (ISO 128).

---

## 1. Datum Reference Frame (GD&T — ASME Y14.5 / ISO 1101)

**Principle:** Every measurement is relative to established datum features, not
arbitrary coordinates. A datum is a theoretically exact geometric reference
derived from a real feature of the part.

**3-2-1 rule (constraining 6 degrees of freedom):**

- **Primary Datum (A):** Constrains 3 DOF (plane contact). Choose the most
  stable/largest feature. For rotationally symmetric parts: the axis of
  symmetry. For prismatic parts: the largest flat face.
- **Secondary Datum (B):** Constrains 2 DOF (line/edge contact). Usually the
  base plane (where the object sits) or a perpendicular face.
- **Tertiary Datum (C):** Constrains the final 1 DOF. The asymmetric feature
  that breaks remaining symmetry (spout direction, keyway, etc.).

Note: a cylindrical datum (bore/shaft) constrains 4 DOF (2 translational + 2
rotational), changing the count. ASME and ISO differ here — ASME datums are
theoretical planes from real features; ISO uses "situation features".

**Rules for JSCAD scripts:**

1. Declare datums as comments at the top of `main()` before any geometry
2. Align primary datum with a standard axis (Z for vertical, X for horizontal)
3. Place secondary datum at the origin plane (Z=0 for base)
4. All `center:` and `translate()` values must trace back to datums
5. Datum features must be real and accessible — never use a small boss or
   internal feature as primary datum

```javascript
// ── Datums ──
// A: Z axis (axis of rotational symmetry)
// B: Z = 0 (base plane — flat bottom sits here)
// C: +Y direction (spout extends this way)
```

**Common mistake:** Choosing an arbitrary axis instead of the natural datum. If
PCA shows the primary axis is tilted relative to X/Y/Z, the model's coordinate
system doesn't match its geometry — redesign the script to align the primary
feature with a standard axis. Programmatic models often default to geometric
center as origin — this is almost never where the manufacturing datum is.

---

## 2. Feature Decomposition

**Principle:** A 3D model is a tree of features, each defined by a 2D sketch +
operation (extrude, revolve, sweep, loft) or a modification (fillet, chamfer,
boolean). The feature tree is the generative recipe.

**Feature types relevant to JSCAD:**

| Feature | JSCAD equivalent                      | When to use                 |
| ------- | ------------------------------------- | --------------------------- |
| Revolve | `extrudeRotate(profile)`              | Rotationally symmetric body |
| Extrude | `extrudeLinear({height}, profile)`    | Prismatic shapes            |
| Sweep   | `hull(sphere_at_A, sphere_at_B, ...)` | Organic spouts, handles     |
| Fillet  | `expand({delta, corners: 'round'})`   | Rounded edges               |
| Boss    | `union(base, cylinder)`               | Mounting posts              |
| Pocket  | `subtract(base, cuboid)`              | Slots, cavities             |
| Pattern | Loop + `translate`                    | Arrays of features          |

**Rules for JSCAD scripts:**

1. Name each feature as a const: `const body = ...`, `const spout = ...`
2. Build features independently, then assemble with `union/subtract`
3. Never nest more than 2 levels of boolean — flatten the tree
4. Comment each feature block with its purpose and datum reference
5. Mirror the manufacturing sequence: start with stock (base shape), then
   `subtract()` for pockets/holes, `union()` for bosses/pads
6. Feature order matters: `subtract(A, B)` != `subtract(B, A)` — always apply
   fillets after cutting pockets that intersect them

**Common mistakes:**

- Building the entire model as one monolithic boolean expression — can't isolate
  which feature caused a measurement error
- JSCAD lacks native fillet/chamfer — must construct from primitives or use
  hull-based approximations. This is the biggest gap vs GUI CAD. For critical
  fillets, define the cross-section explicitly and sweep it

---

## 2.5 Handling Asymmetry

**Principle:** Most real objects are NOT fully symmetric. They have a symmetric
body with asymmetric features (handles, knobs, mounting tabs, keyways). The
modeling strategy depends on the symmetry classification.

**Use `analyzeSymmetry` to classify:**

| Symmetry result                | Modeling strategy                                       |
| ------------------------------ | ------------------------------------------------------- |
| All 3 axes symmetric           | Full `extrudeRotate` — no clipping needed               |
| 2 axes symmetric, 1 asymmetric | Revolve body, features extend along the asymmetric axis |
| 1 axis symmetric, 2 asymmetric | Revolve body + clip with half-space + union features    |
| No axes symmetric              | Multi-profile extrusion or primitive composition        |

**Pattern for partially symmetric objects:**

```javascript
// 1. Revolve body from symmetric axis profile
const bodyProfile = polygon({ points: profileFromDirectionalExtraction });
const bodyRevolved = extrudeRotate({ segments: 64 }, bodyProfile);

// 2. Clip if body extends beyond reference bounds on asymmetric side
const clipPlane = cuboid({
  size: [big, big, big],
  center: [0, -big / 2 - clipY, h / 2],
});
const body = subtract(bodyRevolved, clipPlane);

// 3. Union with detected features
const feature1 = hull(
  translate([0, attachY, featureMinH], sphere({ radius: r1 })),
  translate([0, tipY, featureMidH], sphere({ radius: r2 })),
);
return union(body, feature1);
```

**Key rule:** Extract the body profile from the SYMMETRIC measurement axis
(`extractDirectionalProfile` with `measureAxis` = symmetric axis). This avoids
contamination from asymmetric features. Use the asymmetric axis profile only to
determine where features attach.

**`extentRatio` from `analyzeSymmetry`** is the clearest indicator: values near
1.0 mean the centroid is centered (symmetric extents); values near 0.5 mean the
centroid is offset (one side extends much further than the other, usually due to
features).

---

## 3. Profile-Driven Bodies (Revolve/Sweep)

**Principle:** For rotationally symmetric parts, the entire shape is defined by
a single 2D profile curve. The profile is the most information-dense
representation — it encodes the body, neck, lid, and base in one array.

**Profile convention:**

- Points are `[radius, height]` from base (height=0) to top
- First point should have `height=0` (base)
- For closed revolve: first point and last point should have `radius ≥ 0`
- Sharp transitions = feature boundaries (body→neck = sudden radius decrease)

```javascript
// Profile for a vase-like body
const profile = primitives.polygon({
  points: [
    [0, 0], // center of base
    [baseR, 0], // base radius
    [maxR, H * 0.35], // widest point at 35% height
    [maxR * 0.6, H * 0.7],
    [neckR, H], // neck
    [0, H], // center of top
  ],
});
const body = extrusions.extrudeRotate({ segments: 64 }, profile);
```

**Rules:**

1. Define profile points as proportions of overall height, not absolute mm
2. The widest point position (as % of height) defines the "character" of the
   shape
3. Validate by checking `extractProfile()` output matches your intended curve
4. For non-symmetric features (spout, handle), use `hull()` of positioned
   spheres
5. Profile must be closed and non-self-intersecting — a gap of 0.001mm causes
   garbage geometry. Validate closure programmatically.
6. For revolve: all profile X-coordinates must be >= 0. If any cross the
   rotation axis, you get self-intersecting geometry.
7. For hollow bodies (vases), define profile as the wall cross-section, not the
   complete outline.
8. Use `segments: 64` for smooth appearance, `48` for 3D printing, `32` for
   preview/comparison.

**Common mistakes:**

- Using scaled spheres instead of `extrudeRotate` — gives ellipsoids, not the
  nuanced curves of real objects
- Winding order of profile points determines surface normal direction, which
  affects boolean operations. If `subtract()` behaves unexpectedly, try
  reversing profile point order.
- Sweeps along curved paths can self-intersect at tight bends. Bend radius must
  be > maximum profile radius.

---

## 4. Proportional / Parametric Design

**Principle:** Define geometry through ratios and constraints, not absolute
dimensions. This makes models scale-invariant and easier to verify against
references regardless of orientation.

**Key ratios to define first:**

| Ratio             | Meaning                   | Example |
| ----------------- | ------------------------- | ------- |
| `bodyH / totalH`  | What fraction is the body | 0.55    |
| `maxR / totalH`   | How "fat" is the body     | 0.22    |
| `neckR / maxR`    | How tight is the neck     | 0.23    |
| `spoutL / totalH` | How far the spout extends | 0.35    |
| `handleR / maxR`  | Handle proportion         | 0.45    |
| `widestAt`        | Height % of widest point  | 0.35    |

**Three tiers of parameters (Suh's Axiomatic Design):**

1. **Driving/master dimensions** — set by user (e.g., `TOTAL_H = 260`)
2. **Derived dimensions** — computed from masters via ratios
3. **Manufacturing constraints** — clamps (min wall thickness, min hole dia)

**Rules:**

1. Start with overall dimension (`TOTAL_H`), derive everything from ratios
2. Ratios should be extracted from reference images/STLs, not guessed
3. Use the `compare` method to verify: `proportionDeltas` should be < 0.05
4. When scaling, only change `TOTAL_H` — all proportions follow automatically
5. Define each relationship exactly once, in one direction — if
   `width =
   height * 2` exists, never also write `height = width * 0.5`
6. Test parametric models at extreme values (min, max, mid-range) — a model that
   works at 100mm may self-intersect at 20mm due to fillets exceeding edge
   lengths

---

## 5. Rotation-Invariant Verification

**Principle:** Two models of the same object may have completely different
coordinate system orientations. Compare using PCA-aligned sorted axis lengths
and internal proportions, never raw X/Y/Z dimensions.

**Comparison metrics (from `compareModels` method):**

| Metric                         | Good match       | Meaning                 |
| ------------------------------ | ---------------- | ----------------------- |
| `ratios` (all 3)               | All ≈ same value | Uniform scaling         |
| `proportionDeltas.midToLong`   | < 0.05           | Same shape proportions  |
| `proportionDeltas.shortToLong` | < 0.05           | Same shape proportions  |
| `profileMatch`                 | > 0.85           | Profile curves similar  |
| `symmetryScore`                | Both similar     | Same symmetry character |

**Use `enhancedCompare` which provides both PCA and AABB metrics:**

| Metric                                  | Good match       | Meaning                                           |
| --------------------------------------- | ---------------- | ------------------------------------------------- |
| `alignedAABB.long/mid/short.deltaPct`   | All < 5%         | Bounding box dimensions match per PCA-mapped axis |
| `alignedAABB.long/mid/short.ratio`      | All ≈ same value | Uniform scaling                                   |
| `proportionDeltas.midToLong`            | < 0.05           | PCA shape proportions match                       |
| `profileMatch`                          | > 0.85           | PCA profile curves similar                        |
| `symmetryRefAxes` = `symmetryModelAxes` | Same set         | Same symmetry character                           |

**PCA vs AABB discrepancy:** PCA comparison can be misleading for asymmetric
objects. PCA finds the axes of maximum variance, which tilt when features
(handles, protrusions) extend asymmetrically. The aligned AABB comparison uses
PCA only to MAP axes between meshes (longest↔longest, etc.), then compares the
actual bounding box spans along those mapped world axes.

- When AABB matches but PCA `proportionDeltas` don't → trust AABB. The PCA axis
  tilt is the discrepancy, not the model.
- When neither match → the model dimensions are actually wrong.
- When symmetry axes differ → wrong modeling approach (e.g., full revolve when
  the reference is clipped on one side).

**PCA gotchas:**

- PCA has **sign ambiguity**: eigenvectors can point either direction. Our
  implementation resolves by mapping to closest world axis.
- PCA fails for **rotationally symmetric** objects (sphere, cylinder, cube):
  two+ eigenvalues are equal, axes indeterminate.
- **Weight vertices by face area** for faithful alignment. Our implementation
  samples uniformly to approximate this.

**Rules:**

1. Always run `enhancedCompare` before declaring a model "done"
2. Fix AABB dimensions first (aligned deltas), then PCA profile shape
3. If symmetry axes differ, rethink the modeling approach
4. For programmatic CAD output, consider comparing parameter vectors directly
   rather than mesh comparison — it's more robust and cheaper

---

## 6. Orthographic Projection (ISO 128)

**Principle:** 6 standard views fully describe a 3D object. Each view shows two
of three principal dimensions.

**Third-angle projection (ISO standard, used by our slicer):**

```
Row 0:  FRONT  |  RIGHT  |  BACK
Row 1:  TOP    |  LEFT   |  BOTTOM
```

**What each view tells you:**

- **Front/Back:** Width (X) × Height (Z) — the canonical silhouette
- **Left/Right:** Depth (Y) × Height (Z) — shows spout/handle extent
- **Top/Bottom:** Width (X) × Depth (Y) — shows plan view, roundness

**Rules:**

1. The "canonical" view of an object should be the FRONT or RIGHT view
2. After PCA alignment, the primary axis → longest dimension in the view
3. Asymmetric features (spout) should be visible in LEFT or RIGHT views
4. If TOP view is nearly circular, the object has good rotational symmetry

---

## Summary: Top 10 Rules for Programmatic CAD

1. Establish datum planes explicitly — put primary datum at z=0, build from
   there
2. One const per feature; call order is your feature tree
3. All dimensions derived from named master parameters via ratios
4. Profiles must be closed, non-self-intersecting, on one side of revolve axis
5. Fillets/chamfers are the hardest part in CSG — plan for approximations
6. Validate parametric models at extreme values, not just nominal
7. Each part defines its own local coordinate system at its datum
8. Assemble with named transforms derived from shared skeleton, not magic
   numbers
9. For mesh comparison, PCA-align and compare sorted axis lengths + profile
   curves
10. Orient models so FRONT view shows the most characteristic shape

---

## Sources

**Standards:**

- ASME Y14.5-2018 — Dimensioning and Tolerancing (GD&T)
- ISO 1101:2017 — Geometrical tolerancing
- ISO 5459:2011 — Datums and datum systems
- ISO 128-1:2020, ISO 128-3:2020 — Technical drawings, views
- ASME Y14.3-2012 — Multiview and sectional view drawings
- ISO 10303-42 — Geometric and topological representation (STEP)
- ISO 10303-108 — Parameterization and constraints
- ISO 10303-224 — STEP AP224 (mechanical product definition)

**Textbooks:**

- Shah & Mantyla — _Parametric and Feature-Based CAD/CAM_ (Wiley, 1995)
- Suh — _Axiomatic Design_ (Oxford, 2001) — Independence & Information Axioms
- Ullman — _The Mechanical Design Process_
- Mortenson — _Geometric Modeling_ (3rd ed., Industrial Press)
- Mantyla — _An Introduction to Solid Modeling_ (CS Press, 1988)

**Papers (mesh comparison):**

- Osada et al. (2002) — _Shape Distributions_
- Kazhdan et al. (2003) — _Rotation Invariant Spherical Harmonic Representation_
- Vranic & Saupe (2001) — _3D Shape Descriptor Based on 3D Fourier Transform_
- Horn (1987) — _Closed-form solution of absolute orientation using unit
  quaternions_
