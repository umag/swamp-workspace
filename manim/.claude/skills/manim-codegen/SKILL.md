---
name: manim-codegen
description: >
  Generate and render Manim (ManimCommunity) animations through the
  @magistr/manim/scene swamp model. Use when the user asks to animate a
  concept, algorithm, math idea, or data structure as a video. Triggers on:
  "animate", "manim", "make an animation", "visualize this algorithm",
  "render a scene", "explainer video", "animate saxpy", "show me a video of".
  Do NOT use for still images (use comfyui) or non-video rendering.
---

# Manim Code Generation

Write a ManimCommunity `Scene` in Python, then render it through the
`@magistr/manim/scene` swamp model — never by calling the `manim` CLI directly
(that bypasses swamp; see CLAUDE.md Rule 10). The model writes the script to a
temp workspace, runs `manim render` headless, and captures the media file, CLI
log, and metadata as swamp data.

## Mandatory script rules

Every generated script MUST follow these — violations cause runtime errors:

1. **Import:** start with `from manim import *`. No other imports unless pure
   stdlib (`math`, `random`, `itertools`).
2. **Scene class:** define `class Name(Scene):` with `def construct(self):`. The
   class name MUST equal the `sceneNames` entry you pass to the model.
3. **No file/network I/O:** no `open()`, no `Deno`, no `fetch`, no reading
   external assets. The render runs in a throwaway sandbox. External images or
   SVGs are not available — build everything from primitives and `Text`.
4. **No `MathTex` / `Tex` / `Title` / `BulletedList`.** They require a LaTeX
   install that is usually absent — the render fails with
   `RuntimeError: latex failed`. Use `Text(...)` (Pango) for all labels, and
   `Text(..., font="Monospace")` for code. If you genuinely need a formula and
   LaTeX is confirmed installed, only then use `MathTex`.
5. **Deterministic:** if you use `random`, seed it (`random.seed(0)`), so the
   render is reproducible.
6. **Drive the timeline:** every visual change goes through `self.play(...)` or
   `self.add(...)` + `self.wait(...)`. Nothing appears unless played or added.
7. **Stay in frame:** the frame is ~14.2 × 8 units. Arrange groups with
   `.arrange(DOWN)` / `.next_to()` / `.to_edge()`; scale a crowded group with
   `group.scale_to_fit_width(12)` rather than letting it overflow.

## Minimal template

```python
from manim import *


class Demo(Scene):
    def construct(self):
        title = Text("My Title", font_size=44).to_edge(UP)
        self.play(Write(title))
        dot = Dot(color=YELLOW)
        self.play(FadeIn(dot))
        self.play(dot.animate.shift(RIGHT * 3))
        self.wait(1)
```

See [references/manim-api.md](references/manim-api.md) for the mobject and
animation cheat sheet, and [references/patterns.md](references/patterns.md) for
reusable recipes (labelled arrays, per-element loops, parallel highlights — the
shape used for the SAXPY / CUDA-SAXPY scenes).

## Rendering through swamp

Prefer a workflow so the run is recorded and scored (CLAUDE.md "prefer
workflows"). Wrap one `render` step:

```yaml
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
          modelIdOrName: manim-demo # your @magistr/manim/scene instance
          methodName: render
          inputs:
            script: |
              from manim import *
              class Demo(Scene):
                  def construct(self):
                      self.play(Write(Text("hi")))
                      self.wait(0.5)
            sceneNames: ["Demo"] # MUST match the class name
            quality: low # low is fast; bump for final cut
            format: mp4
```

Iterate at `quality: low` (480p15, seconds to render); switch to `high`
(1080p60) only for the final render.

## After a render

- Metadata: `swamp data get <instance> result --json` → `success`, `format`,
  `sizeBytes`, `durationMs`.
- The video: `swamp data get <instance> output --json` → copy the `contentPath`
  (or base64-decode `content`) to a viewable file.
- On failure the method throws `ManimRenderError`; read the cause with
  `swamp report get @swamp/method-summary --model <instance> --json`, or read
  the `log` artifact for the full manim stderr. See
  [references/troubleshooting.md](references/troubleshooting.md).
