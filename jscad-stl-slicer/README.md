# @magistr/jscad-stl-slicer

A swamp extension model for geometric analysis of STL meshes. It parses binary
STL triangle data and produces measurable, rotation-invariant reports without
any external CAD dependency at runtime. Capabilities include Z-plane slicing
with SVG cross-sections, 6-view orthographic engineering drawings, PCA-based
principal-axis and proportion analysis, per-axis mirror symmetry detection,
directional profile extraction, asymmetric feature detection, polynomial profile
fitting, centerline skeleton extraction, JSCAD script generation, and
RMS/Hausdorff surface-distance and proportion comparison between two meshes.

It pairs with [`@magistr/jscad-cad`](https://github.com/umag/swamp-workspace):
the `sixViews`, `compareModels`, and `enhancedCompareModels` methods read the
`output` STL produced by a named `@magistr/jscad-cad` model so you can diff a
generated part against a reference scan. File-path variants (`sliceFile`,
`compareFiles`, `surfaceDistance`, etc.) operate on STL files on disk directly.

## Model instance

Add an instance to your swamp definitions. The model takes no global arguments;
all inputs are supplied per method call.

```yaml
type: "@magistr/jscad-stl-slicer"
typeVersion: 2026.05.25.1
id: 00000000-0000-0000-0000-000000000000
name: stl-slicer
version: 1
tags: {}
globalArguments: {}
methods: {}
```

## Usage

Slice an STL at its mid-height and emit an SVG cross-section plus measurements:

```bash
swamp model method run stl-slicer sliceFile \
  --input filePath=/path/to/part.stl

# 6-view orthographic sheet with a reference overlay
swamp model method run stl-slicer sixViewsFile \
  --input filePath=/path/to/part.stl \
  --input refPath=/path/to/reference.stl

# PCA analysis: principal axes, proportions, symmetry score
swamp model method run stl-slicer analyze \
  --input filePath=/path/to/part.stl --input sliceCount=50

# Per-axis mirror symmetry (symmetric vs asymmetric axes)
swamp model method run stl-slicer analyzeSymmetry \
  --input filePath=/path/to/part.stl --input threshold=0.85

# Detect asymmetric feature regions (protrusions, appendages)
swamp model method run stl-slicer detectFeatures \
  --input filePath=/path/to/part.stl --input sliceAxis=Z

# Rotation-invariant comparison of two STL files
swamp model method run stl-slicer compareFiles \
  --input refPath=/path/to/reference.stl \
  --input modelPath=/path/to/candidate.stl

# Combined PCA + aligned AABB + symmetry comparison vs a jscad-cad model
swamp model method run stl-slicer enhancedCompareModels \
  --input refPath=/path/to/reference.stl \
  --input cadModelName=my-cad-part
```

## Methods

| Method                                           | Purpose                                            |
| ------------------------------------------------ | -------------------------------------------------- |
| `sliceFile`                                      | Z-plane slice + cross-section SVG + measurements   |
| `sixViewsFile` / `sixViews`                      | 6-view orthographic sheet (file / jscad-cad model) |
| `analyze`                                        | PCA axes, proportions, profile, symmetry score     |
| `analyzeSymmetry`                                | Per-axis mirror symmetry classification            |
| `extractDirectionalProfile`                      | Profile along one axis, extent along another       |
| `detectFeatures`                                 | Asymmetric protrusion / appendage detection        |
| `multiSlice`                                     | Width/depth cross-sections at many heights         |
| `decompose`                                      | Feature decomposition + generated JSCAD script     |
| `surfaceDistance`                                | Mean / RMS / Hausdorff / percentile distances      |
| `extractSkeleton`                                | Centerline skeleton of tubular features            |
| `generateScript` / `fitProfiles`                 | JSCAD script / polynomial profile coefficients     |
| `extractContours`                                | Cross-section contour points at many heights       |
| `compareFiles` / `compareModels`                 | PCA comparison (two files / file vs jscad-cad)     |
| `enhancedCompareFiles` / `enhancedCompareModels` | PCA + AABB + symmetry comparison                   |

## Dependencies

Depends on `@magistr/jscad-cad`. The `*Models` methods resolve a named
`@magistr/jscad-cad` model and read its latest `output` STL data.

## License

MIT — see [LICENSE.md](LICENSE.md).
