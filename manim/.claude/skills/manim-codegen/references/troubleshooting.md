# Manim render troubleshooting

The `@magistr/manim/scene` method throws `ManimRenderError` on a non-zero exit
or when no output file matches the requested format. The message carries the
stderr tail; the full CLI output is in the `log` artifact, and the failure is
captured by `swamp report get @swamp/method-summary --model <instance> --json`.

| Symptom (stderr)                                       | Cause                                                                        | Fix                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `RuntimeError: latex failed` / `latex not found`       | Used `MathTex`, `Tex`, `Title`, or `BulletedList` without a LaTeX install    | Replace with `Text(...)` / `MarkupText`. Only use `MathTex` if LaTeX is confirmed installed.  |
| `There are no scenes inside that module`               | `sceneNames` doesn't match a class, or the class isn't a `Scene` subclass    | Make `sceneNames` exactly equal the class name; ensure `class X(Scene):`.                     |
| `No file matching '<name>'` / render prompts           | Multiple scenes and none named                                               | Pass the specific scene in `sceneNames`; empty list renders all via `-a`.                     |
| `ffmpeg` / `Command 'ffmpeg' not found`                | ffmpeg missing on the host for mp4/webm muxing                               | Install ffmpeg, or render `format: png` (single frame, no ffmpeg).                            |
| `cannot load library 'libcairo'` / pycairo build error | Native cairo/pango missing in the manim environment                          | Install cairo+pango, or use a `command` prefix with the `manimcommunity/manim` docker image.  |
| `NameError: name 'X' is not defined`                   | Missing `from manim import *`, or a typo'd mobject/animation                 | Start the script with `from manim import *`; check the name against `manim-api.md`.           |
| Exit 0 but `ManimRenderError: produced no <fmt> file`  | Scene ran but wrote nothing (empty `construct`, or output in another format) | Ensure at least one `self.play`/`self.add`; confirm `format` matches what the scene produces. |
| Objects off-screen / clipped                           | Group larger than the ~14.2×8 frame                                          | `group.scale_to_fit_width(13)` or lay out with `.arrange()` / `.to_edge()`.                   |

## Speed

- Iterate at `quality: low` (480p15) — seconds per render. Only switch to
  `high`/`production`/`fourk` for the final cut.
- `uvx` caches the manim environment after the first run; the first render in a
  fresh cache is slower.

## Inspecting a failed run

```bash
swamp report get @swamp/method-summary --model <instance> --json
swamp data get <instance> log --json   # full manim stdout+stderr
```
