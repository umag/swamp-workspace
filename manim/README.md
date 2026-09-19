# @magistr/manim

Drive the [ManimCommunity](https://github.com/ManimCommunity/manim) animation
engine from swamp. The `@magistr/manim/scene` model takes Python source that
defines one or more manim `Scene` classes, renders them headless through the
`manim` CLI, and captures three swamp data artifacts per run:

- **`output`** — the rendered media file (`mp4`/`gif`/`png`/`webm`).
- **`log`** — the CLI stdout + stderr for that render.
- **`result`** — render metadata (scenes, quality, format, size, duration).

The model owns no manim logic itself: it writes the script to a private temp
workspace, invokes the CLI with `--media_dir` pointed there, discovers the
produced file, and cleans the workspace up afterward. A non-zero exit — or a
zero exit that produced no matching file — fails the method with a named
`ManimRenderError` whose message carries the stderr tail, so the failure is
captured by `swamp report get @swamp/method-summary`.

## Prerequisites

manim must be reachable from the host running the model. It is **not** bundled
(it needs Python plus native libraries — cairo, pango, and ffmpeg). The
`command` global argument is the invocation prefix, so point it at whatever form
is installed:

```bash
# manim on PATH (pip install manim)
swamp model create @magistr/manim/scene my-manim

# or run it through uv without a global install
swamp model create @magistr/manim/scene my-manim \
  --global command='["uvx","manim"]'

# or through the official container image
swamp model create @magistr/manim/scene my-manim \
  --global command='["docker","run","--rm","-i","manimcommunity/manim","manim"]'
```

## Render a scene

Prefer a workflow so the run is recorded, scored, and auditable:

```yaml
# workflows/manim-demo.yaml
inputs:
  script:
    type: string
  scene:
    type: string
    default: "Demo"
jobs:
  - name: main
    dependsOn: []
    weight: 0
    steps:
      - name: render
        dependsOn: []
        weight: 0
        task:
          type: model_method
          modelIdOrName: my-manim
          methodName: render
          inputs:
            script: ${{ inputs.script }}
            sceneNames: ["${{ inputs.scene }}"]
            quality: high
            format: mp4
```

For a quick one-off, run the method directly:

```bash
swamp model @magistr/manim/scene method run render my-manim --input '{
  "script": "from manim import *\nclass Demo(Scene):\n    def construct(self):\n        self.play(Create(Circle()))",
  "sceneNames": ["Demo"],
  "quality": "medium",
  "format": "mp4"
}'
```

Then reference the produced artifacts via CEL, e.g.
`data.latest("my-manim","result").attributes.durationMs`, or fetch the file path
from `model.my-manim.file.output.output.path`.

## `render` arguments

| Argument      | Type     | Default    | Notes                                           |
| ------------- | -------- | ---------- | ----------------------------------------------- |
| `script`      | string   | (required) | Python source defining the Scene class(es).     |
| `sceneNames`  | string[] | `[]`       | Scenes to render; empty renders **all** (`-a`). |
| `quality`     | enum     | `medium`   | `low`/`medium`/`high`/`production`/`fourk`.     |
| `format`      | enum     | `mp4`      | `mp4`/`gif`/`png`/`webm`.                       |
| `resolution`  | string   | —          | `"WIDTH,HEIGHT"`, e.g. `"1920,1080"`.           |
| `fps`         | int      | —          | Frame-rate override.                            |
| `transparent` | bool     | `false`    | Transparent background.                         |
| `extraArgs`   | string[] | `[]`       | Raw CLI args appended before the script path.   |

Quality letters map to manim's presets: `low`=480p15, `medium`=720p30,
`high`=1080p60, `production`=1440p60, `fourk`=2160p60.

## Development

```bash
deno task check   # type-check
deno task lint    # lint
deno task test    # unit tests (injected runner + IO; no manim spawned)
```

The domain layer (`extensions/models/manim/types.ts`) is pure; the subprocess
and filesystem seams (`runner.ts`) are injected, so the full render path is
tested without installing manim.
