# @magistr/jscad-cad

JSCAD v2 CAD renderer for [swamp](https://github.com/systeminit/swamp). Evaluate
a [JSCAD](https://openjscad.xyz/) CadScript — a JavaScript module that exports
`main(params)` returning geometry — and serialize the result to a CAD file in
`STL`, `STL-ASCII`, `DXF`, `SVG`, `OBJ`, or `3MF` format.

The extension ships the **jscad-codegen** Claude Code skill (under
`.claude/skills/jscad-codegen/`), which teaches feature-based modeling, geometry
positioning, and reverse-engineering of existing parts so an agent can author
correct JSCAD v2 scripts.

## Model

- `@magistr/jscad-cad` — stateless renderer. No global arguments; everything is
  passed per method call.

## Method

| Method | Purpose                                                         |
| ------ | --------------------------------------------------------------- |
| `run`  | Evaluate a CadScript and serialize geometry to an OutputFormat. |

`run` arguments:

- `script` (string, required) — JSCAD JavaScript defining
  `main(params) → geometry`.
- `parameters` (object, default `{}`) — key/value parameters passed to `main`.
- `outputFormat` (enum, default `stl`) — one of `stl`, `stl-ascii`, `dxf`,
  `svg`, `obj`, `3mf`.

It writes three data artifacts: `result` (render summary), `output` (the CAD
file bytes), and `log` (evaluation warnings).

## Usage

Create the model instance:

```yaml
type: "@magistr/jscad-cad"
name: cad
```

Render a parametric cube to STL:

```bash
swamp model method run cad run \
  --input script='const { primitives } = require("@jscad/modeling"); function main(p){ return primitives.cube({ size: p.size }); } module.exports = { main };' \
  --input parameters='{"size": 20}' \
  --input outputFormat=stl
```

Inspect the render result and locate the generated file:

```bash
swamp data query cad result
```

## Notes

- Geometry evaluation runs in a sandboxed subprocess.
- `objectCount` in the result reports how many shapes `main()` returned.
