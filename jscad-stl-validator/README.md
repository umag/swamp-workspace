# @magistr/jscad-stl-validator

STL file validator for swamp. It parses binary or ASCII STL geometry and emits a
structured validation report covering the detected format, triangle count, the
binary header's expected triangle count, the number of degenerate (zero-area or
duplicate-vertex) faces, an axis-aligned bounding box, and a list of issues. Use
it to confirm that geometry exported by a
[`@magistr/jscad-cad`](https://github.com/umag/swamp-workspace) model was
serialized correctly before sending it to a slicer or printer.

This extension depends on `@magistr/jscad-cad`: the `validate` method reads the
STL bytes stored as that model's `output` data artifact. The `validateFile`
method needs no dependency and validates any STL file already on disk.

## Model instance

Create a model instance of type `@magistr/jscad-stl-validator`. It takes no
global arguments — all inputs are passed per method call.

```yaml
type: "@magistr/jscad-stl-validator"
typeVersion: 2026.05.25.1
name: stl-validator
version: 1
tags: {}
globalArguments: {}
methods: {}
```

## Usage

Validate the STL stored by a `@magistr/jscad-cad` model instance (here named
`my-part`), optionally pinning a specific data version:

```bash
# Validate the latest stored output of the jscad-cad model "my-part"
swamp model method run stl-validator validate --input cadModelName=my-part

# Validate a specific data version
swamp model method run stl-validator validate \
  --input cadModelName=my-part --input version=3

# Validate an STL file directly from disk
swamp model method run stl-validator validateFile \
  --input filePath=/tmp/part.stl
```

Both methods write a `report` resource. Inspect it with `swamp data` once the
method completes.

## Report fields

- `valid` — true when no issues were detected.
- `format` — `binary`, `ascii`, `empty`, or `unknown`.
- `triangleCount` — triangles actually parsed from the file.
- `expectedTriangleCount` — triangle count from the binary header (null for
  ASCII).
- `degenerateTriangles` — zero-area or duplicate-vertex faces found.
- `boundingBox` — `min`, `max`, and `size` vectors, or null when no geometry.
- `issues` — human-readable descriptions of every problem found.

## License

MIT — see [LICENSE.md](LICENSE.md).
