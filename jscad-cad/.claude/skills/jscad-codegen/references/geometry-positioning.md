# Geometry Positioning — Common Mistakes and Fixes

## The Problem: Inline Position Math

When building multi-part models (boxes, enclosures, assemblies), computing
positions inline inside `translate()` or `center:` causes parts to protrude,
misalign, or float in space. The math is opaque and hard to verify.

**Symptom:** Ribs/walls/shelves sticking out of the box. Parts not flush.

**Root cause:** Different parts using different position formulas that don't
share a common reference frame.

---

## The Fix: Declare Coordinates Once

### Step 1 — Declare all dimensions as constants

```javascript
const wall = 3;
const hddW = 101.6;
const hddH = 26.1;
const hddD = 146;
const gap = 2;
const cols = 4;
const rows = 2;
```

### Step 2 — Derive inner and outer dimensions

```javascript
const innerW = cols * hddW + (cols - 1) * gap;
const innerH = rows * hddH + (rows - 1) * gap;
const innerD = hddD;

const outerW = innerW + 2 * wall;
const outerH = innerH + 2 * wall;
const outerD = innerD + wall; // back wall only — front open
```

### Step 3 — Derive named center coordinates

In JSCAD, all primitives are centered at origin by default. `center:` sets where
the center of the primitive lands in world space.

```javascript
// Y: front (open) = -outerD/2, back (wall outer face) = +outerD/2
// Inner depth spans: Y = -outerD/2  to  Y = outerD/2 - wall
// Center of inner depth:
const innerYCenter = -outerD / 2 + innerD / 2; // = -wall/2

// Z: bottom plate top face = +wall/2, top plate bottom face = wall + innerH
// Center of inner height:
const innerZCenter = wall / 2 + innerH / 2;
```

### Step 4 — Use named centers everywhere

```javascript
// ✅ All parts share the same reference — easy to verify alignment
const bottom = cuboid({
  size: [outerW, outerD, wall],
  center: [0, innerYCenter, 0],
});

const top = cuboid({
  size: [outerW, outerD, wall],
  center: [0, innerYCenter, wall + innerH],
});

const leftWall = cuboid({
  size: [wall, outerD, outerH],
  center: [-(innerW / 2 + wall / 2), innerYCenter, innerZCenter],
});

const rib = cuboid({
  size: [gap, innerD, outerH],
  center: [ribX, innerYCenter, innerZCenter],
}); // same innerYCenter!

const shelf = cuboid({
  size: [innerW, innerD, gap],
  center: [0, innerYCenter, wall + hddH + gap / 2],
});
```

---

## Checklist Before Writing Any Part

- [ ] All dimensions declared as named constants
- [ ] `innerYCenter`, `innerZCenter` (and `innerXCenter` if needed) computed
      once
- [ ] Every `center:` uses only those named constants — no inline arithmetic
- [ ] Back wall, ribs, and shelf all use the **same** `innerYCenter`
- [ ] Cutter shapes for boolean subtract are **larger** than the wall they cut
      (add +2 to the cutting dimension to avoid co-planar faces)

---

## Quick Reference: Center Formula

For a box with walls only on some sides:

```
Open front (no front wall):
  outerD = innerD + wall          (back wall only)
  innerYCenter = -wall / 2        (shifts all inner parts toward open front)

Walls on both sides:
  outerD = innerD + 2 * wall
  innerYCenter = 0                (centered, no shift needed)

Z (bottom and top walls):
  innerZCenter = wall / 2 + innerH / 2
  bottom plate center Z = 0
  top plate center Z    = wall + innerH
```
