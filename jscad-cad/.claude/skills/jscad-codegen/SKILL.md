---
name: jscad-codegen
description: >
  Generate, validate, and render JSCAD v2 CAD scripts using Claude LLM.
  Follows DDD and swamp extension model design principles.
  Use when the user asks to generate a CAD model from a natural language prompt,
  fix a JSCAD script, or validate an STL output.
  Triggers on: "generate cad", "create 3d model", "jscad script", "make a part",
  "design a", "cad model", "generate stl", "fix jscad", "validate stl",
  "render model", "text to cad".
---

# JSCAD Code Generation Skill

Generate valid JSCAD v2 `main()` scripts from natural language, render them via
the `@magistr/jscad-cad` swamp model, and validate the resulting STL with
`@magistr/jscad-stl-validator`. Auto-retry on failures up to 3 times.

## Mandatory Script Rules

Every generated script MUST follow these rules. Violations cause runtime errors.

1. **Signature:** `const main = (params = {}) => { ... };` — always this exact
   form
2. **No imports:** Never use `import`, `require()`, or `from`. All APIs are
   injected
3. **No side effects:** Pure function only — no `console.log`, no `Deno.*`, no
   `fetch`
4. **Return geometry:** Must return a JSCAD geometry object or array of them
5. **Namespace access:** Use `primitives.cuboid()`, `booleans.subtract()` etc. —
   never bare names
6. **Size as array:** `cuboid({ size: [x,y,z] })` — never `size: 10`
7. **Center as array:** `center: [x,y,z]` — never `center: true`
8. **Cylinder:** `{ radius: 5, height: 20 }` — never `r`, `h`, or `length`
9. **Radians:** `rotate([rx, ry, rz], shape)` — values in radians, not degrees
10. **Oversized cutters:** When using `subtract()` for holes/cavities, the
    cutter must be taller than the full outer body it cuts through. Use
    `height: outerH + 2` (outer body height + 2mm), not bore depth + 2mm. This
    prevents z-fighting at both ends.

### Injected Scope (available without import)

```
primitives   — cuboid, cylinder, sphere, torus, cone, polygon, circle, square
transforms   — translate, rotate, scale, mirror, align, center
booleans     — subtract, union, intersect
extrusions   — extrudeLinear, extrudeRotate, extrudeFromSlices
hulls        — hull, hullChain
measurements — measureBoundingBox, measureVolume, measureSurfaceArea
colors       — colorize, colorNameToRgb
```

See full verified API: [references/jscad-v2-api.md](references/jscad-v2-api.md)

## Named Coordinates Rule

**Every position and dimension must be a named constant. No inline arithmetic in
`center:` or `translate()`.**

```javascript
// ✅ CORRECT — all positions derived and named
const wall = 3;
const innerW = 100;
const innerD = 60;
const innerH = 40;
const outerW = innerW + 2 * wall;
const outerD = innerD + 2 * wall;
const outerH = innerH + wall; // open top
const boxCenterX = 0;
const boxCenterY = 0;
const boxCenterZ = outerH / 2;
const innerCenterZ = wall + innerH / 2;

const outer = cuboid({
  size: [outerW, outerD, outerH],
  center: [boxCenterX, boxCenterY, boxCenterZ],
});
const inner = cuboid({
  size: [innerW, innerD, innerH + 2],
  center: [boxCenterX, boxCenterY, innerCenterZ],
});

// ❌ WRONG — inline arithmetic in center
const outer = cuboid({ size: [106, 66, 43], center: [0, 0, 43 / 2] });
const inner = cuboid({ size: [100, 60, 40], center: [0, 0, 3 + 40 / 2] });
```

See also:
[references/geometry-positioning.md](references/geometry-positioning.md)

## Feature-Based Modeling

Before writing geometry, decompose the object into features. See:
[references/feature-based-modeling.md](references/feature-based-modeling.md) and
[references/reverse-engineering.md](references/reverse-engineering.md)

1. **Establish datums:** Z axis = primary symmetry, Z=0 = base, +Y = asymmetric
   feature
2. **Decompose into features:** body, handle, spout, bore, lid — one named block
   each
3. **Express dimensions as ratios:** `const BODY_R = TOTAL_H * 0.22` — never
   magic numbers
4. **Symmetric bodies → extrudeRotate:** Define `[radius, z]` profile, use
   `segments: 64`
5. **Organic appendages → hull of spheres:** Tapering sphere chain for
   spouts/handles
6. **Handles → hull of spheres:** Always use `hulls.hull()` or
   `hulls.hullChain()` of `sphere()`/`cylinder()` primitives for handles. Do NOT
   use `torus()` — it creates a closed ring that needs complex clipping. Hull of
   spheres gives direct control over the handle curve and attachment points.

## Workflow

```
User prompt → Generate script → Render STL → Validate → Copy to project
                    ↑                |              |
                    └── retry ←──────┘── retry ←────┘  (max 3 attempts)
```

### Step 1 — Generate Script

Write a JSCAD `main()` function following the rules above.

### Step 2 — Render via Swamp

**Always write script to a YAML file first. Never pass inline via
`--input script=...`**

```bash
# Write script to YAML input file using the Write tool
# Then render:
swamp model method run box-test run \
  --input-file /tmp/jscad-inputs.yaml \
  --json > /tmp/render-result.json 2>&1
```

The YAML file format:

```yaml
script: |
  const main = (params = {}) => {
    // ... script here ...
  };
outputFormat: stl
```

### Step 3 — Validate STL

```bash
swamp model method run stl-check validate \
  --input cadModelName=box-test \
  --json > /tmp/validate-result.json 2>&1
```

- `valid: true` → proceed
- `valid: false` → read `issues[]`, retry with error context

### Step 4 — Copy STL to Project

```bash
swamp data get box-test output --json  # get contentPath
cp "$(pwd)/$CONTENT_PATH" "$(pwd)/<filename>.stl"
```

### Step 5 — Report

Show: generated script, triangle count, bounding box, file path.

## Reference STL Comparison (optional)

When a reference STL exists, analyze before generating:

```bash
# Symmetry analysis
swamp model method run <slicer> analyzeSymmetry \
  --input filePath=/path/to/reference.stl --json

# Profile extraction
swamp model method run <slicer> extractDirectionalProfile \
  --input filePath=/path/to/reference.stl \
  --input sliceAxis=Z --input measureAxis=X --json

# Feature detection
swamp model method run <slicer> detectFeatures \
  --input filePath=/path/to/reference.stl \
  --input sliceAxis=Z --json

# Compare after generation
swamp model method run <slicer> enhancedCompareModels \
  --input refPath=/path/to/reference.stl \
  --input cadModelName=box-test --json
```

## Required Models

```bash
swamp model search --json  # verify box-test and stl-check exist
```

If missing:

```bash
swamp model create @magistr/jscad-cad box-test --json
swamp model create @magistr/jscad-stl-validator stl-check --json
```
