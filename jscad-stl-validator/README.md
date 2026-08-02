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

Create a model instance of type `@magistr/jscad-stl-validator`. It takes two
optional global arguments, `allowedRoots` and `maxFileBytes` (see
[Trust boundary](#trust-boundary--allowedroots) below) — all other inputs are
passed per method call.

```yaml
type: "@magistr/jscad-stl-validator"
typeVersion: 2026.08.02.1
name: stl-validator
version: 1
tags: {}
globalArguments:
  allowedRoots: []
  maxFileBytes: 268435456
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

## Trust boundary & `allowedRoots`

`validateFile` is an operator-supplied-absolute-path method by design — the
`filePath` argument is meant to be a path the operator (or a trusted workflow)
already controls, the same way the sibling `jscad-stl-slicer` extension works.
It is not meant to accept a path from an untrusted or end-user-facing caller.

As defense in depth, `validateFile` always:

- rejects any `filePath` that is not absolute;
- rejects any `filePath` containing a literal `.` or `..` path segment (checked
  before the filesystem is touched, so a traversal attempt against a nonexistent
  target is still refused, not silently masked by a "file not found" error);
- canonicalizes the path via `Deno.realPath` (resolving symlinks) before reading
  it.

If `validateFile` is ever wired behind a less-trusted caller, set the
`allowedRoots` global argument to the directories that should be readable. When
`allowedRoots` is non-empty, the canonicalized target must fall under one of the
canonicalized roots — anything else is refused with a
`Refusing to read "<path>": outside allowedRoots` error. When `allowedRoots` is
empty (the default), the historical unconfined contract is preserved: any clean
absolute path is read exactly as before.

`allowedRoots` is read only from the model's global arguments
(`context.globalArgs`) — it can never be set or overridden by the per-call
`filePath` argument, so an untrusted caller cannot smuggle in its own
confinement roots.

Note that even a correctly confined `validateFile` still returns a structural
summary of whatever file it reads — `format`, `triangleCount`, and bounding-box
floats derived from the file's bytes. If exposing this method to a less-trusted
caller, keep `allowedRoots` narrow (e.g. a single scratch/upload directory) so
that summary can't be used to probe the contents of arbitrary files on the host.

`maxFileBytes` (default 268435456, i.e. 256 MiB) caps the size of file
`validateFile` will read from disk. The target's size is checked via `Deno.stat`
BEFORE `Deno.readFile`, so an oversized file is never buffered into memory — an
over-cap file is rejected with a
`Refusing to read "<path>": file exceeds maxFileBytes (<size> > <cap>)` error.
Like `allowedRoots`, it is read only from `context.globalArgs` and cannot be
overridden by a per-call argument. The default is generous so legitimate
multi-MB STL files pass; narrow it if `validateFile` is exposed to a
less-trusted caller.

## Report fields

- `valid` — true when no issues were detected.
- `format` — `binary`, `ascii`, `empty`, or `unknown`.
- `triangleCount` — triangles actually parsed from the file.
- `expectedTriangleCount` — triangle count from the binary header (null for
  ASCII).
- `degenerateTriangles` — zero-area or duplicate-vertex faces found.
- `boundingBox` — `min`, `max`, and `size` vectors, or null when no geometry.
- `issues` — human-readable descriptions of every problem found.

As of `2026.08.02.1`, ASCII validation performs the SAME degenerate-triangle and
NaN/Infinity finite-value checks as binary validation (previously the ASCII path
skipped both, always reporting `degenerateTriangles: 0` and never flagging
non-finite coordinates). A file whose 80-byte binary header happens to spell
`"solid"` is also now correctly classified as binary whenever its claimed
triangle count disagrees with its actual size and its body doesn't look like
ASCII text — previously such a corrupt binary file was misdetected as ASCII,
losing the real diagnosis.

## License

MIT — see [LICENSE.md](LICENSE.md).
