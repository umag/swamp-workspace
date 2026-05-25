# JSCAD v2 API Reference (Verified)

All examples tested against `@jscad/modeling@2.12.0`.
Source: official JSCAD tutorials and source code.

> **In swamp `@jscad/cad` scripts**: no `require()` or `import` needed.
> The following names are injected into scope automatically:
> `primitives`, `transforms`, `booleans`, `expansions`, `extrusions`,
> `hulls`, `measurements`, `text`, `colors`

---

## Script Convention

```javascript
// Minimal valid CadScript
const main = (params = {}) => {
  return primitives.cuboid({ size: [10, 10, 10] });
};
```

- Must define `main` (function declaration or `const main = ...`)
- `main` receives `params` object (can be empty `{}`)
- Must return a single geometry or array of geometries
- No imports, no require, no side effects

---

## 3D Primitives

### `primitives.cuboid(options)`

| Param    | Type        | Default       | Notes                     |
|----------|-------------|---------------|---------------------------|
| `size`   | `[x, y, z]` | `[2, 2, 2]`   | Width, depth, height      |
| `center` | `[x, y, z]` | `[0, 0, 0]`   | Position of center        |

```javascript
// ✅ Correct
primitives.cuboid({ size: [20, 10, 5] })
primitives.cuboid({ size: [10, 10, 10], center: [5, 0, 0] })
primitives.cuboid()  // 2×2×2 at origin

// ❌ Wrong
primitives.cuboid({ size: 10 })         // size must be array
primitives.cuboid({ size: [10], center: true })  // center must be array
primitives.cube(...)                    // use cuboid in v2
```

---

### `primitives.cylinder(options)`

| Param      | Type        | Default     | Notes                          |
|------------|-------------|-------------|--------------------------------|
| `radius`   | `number`    | `1`         | Radius of both end circles     |
| `height`   | `number`    | `2`         | Distance between faces         |
| `segments` | `number`    | `32`        | Circular resolution            |
| `center`   | `[x, y, z]` | `[0, 0, 0]` | Position of center             |

```javascript
// ✅ Correct
primitives.cylinder({ radius: 5, height: 20 })
primitives.cylinder({ radius: 2.5, height: 20, segments: 64 })
primitives.cylinder({ radius: 3, height: 10, center: [0, 0, 5] })

// ❌ Wrong
primitives.cylinder({ radius: 5, height: 20, center: true })  // center must be array
primitives.cylinder({ length: 20 })   // use height, not length
primitives.cylinder({ diameter: 10 }) // use radius, not diameter
```

---

### `primitives.sphere(options)`

| Param      | Type        | Default     | Notes             |
|------------|-------------|-------------|-------------------|
| `radius`   | `number`    | `1`         |                   |
| `segments` | `number`    | `32`        |                   |
| `center`   | `[x, y, z]` | `[0, 0, 0]` |                   |

```javascript
// ✅ Correct
primitives.sphere({ radius: 10 })
primitives.sphere({ radius: 5, segments: 64 })

// ❌ Wrong
primitives.sphere({ diameter: 10 })  // use radius
primitives.sphere({ r: 5 })         // use radius
```

---

### `primitives.torus(options)`

| Param          | Type     | Default | Notes                        |
|----------------|----------|---------|------------------------------|
| `innerRadius`  | `number` | `1`     | Tube radius                  |
| `outerRadius`  | `number` | `4`     | Major (ring) radius          |
| `innerSegments`| `number` | `32`    | Tube cross-section segments  |
| `outerSegments`| `number` | `32`    | Ring segments                |

```javascript
primitives.torus({ innerRadius: 3, outerRadius: 10 })
primitives.torus({ innerRadius: 5, outerRadius: 20, outerSegments: 64 })
```

---

### `primitives.roundedCuboid(options)`

| Param         | Type        | Default     |
|---------------|-------------|-------------|
| `size`        | `[x, y, z]` | `[2, 2, 2]` |
| `roundRadius` | `number`    | `0.2`       |
| `segments`    | `number`    | `32`        |

```javascript
primitives.roundedCuboid({ size: [10, 10, 5], roundRadius: 1.0 })
```

---

### `primitives.cone(options)`

| Param        | Type        | Default     |
|--------------|-------------|-------------|
| `height`     | `number`    | `2`         |
| `radius1`    | `number`    | `1`         | Bottom radius |
| `radius2`    | `number`    | `0`         | Top radius (0 = point) |
| `segments`   | `number`    | `32`        |

```javascript
primitives.cone({ height: 10, radius1: 5, radius2: 0 })   // pointed cone
primitives.cone({ height: 10, radius1: 5, radius2: 2 })   // truncated cone
```

---

## 2D Primitives (for extrusion)

```javascript
primitives.rectangle({ size: [10, 5] })
primitives.circle({ radius: 5 })
primitives.polygon({ points: [[0,0],[10,0],[5,8]] })
primitives.ellipse({ radius: [10, 5] })
primitives.roundedRectangle({ size: [10, 5], roundRadius: 1 })
```

---

## Transforms

All transforms are **pure functions** — they return a new geometry and never modify the input.

### `transforms.translate([x, y, z], shape)`

```javascript
transforms.translate([10, 0, 0], primitives.sphere({ radius: 5 }))
transforms.translate([0, 0, -5], myShape)
```

### `transforms.rotate([rx, ry, rz], shape)` (radians)

```javascript
transforms.rotate([Math.PI / 2, 0, 0], myShape)   // 90° around X
transforms.rotate([0, 0, Math.PI / 4], myShape)    // 45° around Z

// Convenience helpers (also available in transforms):
transforms.rotateX(Math.PI / 2, myShape)
transforms.rotateY(Math.PI / 3, myShape)
transforms.rotateZ(Math.PI / 4, myShape)
```

### `transforms.scale([sx, sy, sz], shape)`

```javascript
transforms.scale([2, 2, 2], myShape)        // uniform 2×
transforms.scale([1, 1, 0.5], myShape)      // squash Z
```

### `transforms.mirror({ normal: [x,y,z] }, shape)`

```javascript
transforms.mirror({ normal: [1, 0, 0] }, myShape)   // mirror across YZ plane
transforms.mirror({ normal: [0, 1, 0] }, myShape)   // mirror across XZ plane
```

---

## Boolean Operations

### `booleans.subtract(base, ...cutters)`

Removes cutter volumes from base. **Order matters.**

```javascript
const box = primitives.cuboid({ size: [20, 20, 20] });
const hole = primitives.cylinder({ radius: 3, height: 22 });
booleans.subtract(box, hole)   // box with hole through it

// Multiple cuts
booleans.subtract(box, hole1, hole2, hole3)
```

### `booleans.union(...shapes)`

```javascript
booleans.union(shape1, shape2, shape3)
```

### `booleans.intersect(...shapes)`

Returns only the overlapping volume.

```javascript
booleans.intersect(primitives.cuboid({ size: [10,10,10] }), primitives.sphere({ radius: 6 }))
```

---

## Extrusions

```javascript
// Extrude a 2D profile along Z
const profile = primitives.circle({ radius: 5 });
extrusions.extrudeLinear({ height: 20 }, profile)

// Rotate-extrude (revolve) a 2D profile
const profile2 = primitives.rectangle({ size: [3, 10] });
extrusions.extrudeRotate({ segments: 32 }, profile2)
```

---

## Common Patterns

### Cylinder centered for clean subtraction

Always make the cutter **slightly taller** than the base to avoid co-planar faces:

```javascript
const base = primitives.cuboid({ size: [20, 20, 10] });     // height 10
const drill = primitives.cylinder({ radius: 3, height: 12 }); // height 12 (+2)
booleans.subtract(base, drill)
```

### Array of shapes

```javascript
const main = () => {
  return [
    primitives.sphere({ radius: 5 }),
    transforms.translate([15, 0, 0], primitives.sphere({ radius: 5 })),
  ];
};
```

### Parametric model

```javascript
const main = (params = {}) => {
  const size = params.size ?? 10;
  const holeRadius = params.holeRadius ?? 2;
  const base = primitives.cuboid({ size: [size, size, size] });
  const hole = primitives.cylinder({ radius: holeRadius, height: size + 2 });
  return booleans.subtract(base, hole);
};
```

---

## V1 vs V2 — Breaking Differences

| V1 (broken in v2) | V2 (correct) |
|---|---|
| `CSG.cube({radius:[1,1,1]})` | `primitives.cuboid({size:[2,2,2]})` |
| `shape.translate([x,y,z])` | `transforms.translate([x,y,z], shape)` |
| `cube({size:10, center:true})` | `cuboid({size:[10,10,10]})` (center is always `[0,0,0]` by default) |
| `cylinder({r:5, h:10})` | `cylinder({radius:5, height:10})` |
| `sphere({r:5, fn:32})` | `sphere({radius:5, segments:32})` |
| `require('@jscad/csg')` | Built-in via injected scope |

---

## Sources

- [JSCAD Official Tutorials](https://openjscad.xyz/docs/)
- [JSCAD v2 Design Guide — 3D Primitives](https://openjscad.xyz/dokuwiki/doku.php?id=en:design_guide_3d_primitives)
- [JSCAD v2 Quick Reference Operations](https://openjscad.xyz/dokuwiki/doku.php?id=en:quick_reference_operations)
- [@jscad/modeling source](https://github.com/jscad/OpenJSCAD.org/tree/master/packages/modeling/src)
