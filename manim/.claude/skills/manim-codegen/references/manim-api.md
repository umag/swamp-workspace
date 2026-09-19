# Manim API cheat sheet (ManimCommunity v0.19+)

Verified against the `manim` CLI used by `@magistr/manim/scene`. Text-only
(Pango) — no LaTeX. All names are available after `from manim import *`.

## Coordinates and constants

- Frame is ~14.2 wide × 8 tall, origin at center.
- Direction vectors: `UP DOWN LEFT RIGHT UL UR DL DR ORIGIN`, e.g.
  `mob.shift(RIGHT * 2 + UP)`.
- Colors: `RED ORANGE YELLOW GREEN TEAL BLUE PURPLE PINK WHITE GRAY BLACK` and
  shades `BLUE_A..BLUE_E`. Custom: `"#ff8800"`.

## Text (use these, not MathTex/Tex)

```python
Text("hello", font_size=36, color=YELLOW)
Text("code", font="Monospace", font_size=20, line_spacing=0.8)
MarkupText('normal <span foreground="red">red</span>')  # Pango markup
Paragraph("line 1", "line 2", alignment="left")
```

## Common mobjects

```python
Dot(color=RED); Line(LEFT, RIGHT); Arrow(LEFT, RIGHT, buff=0.1)
Circle(radius=1); Square(side_length=1); Rectangle(width=3, height=1)
RoundedRectangle(corner_radius=0.1, width=2, height=1)
Triangle(); Polygon([-1,0,0],[1,0,0],[0,1,0]); Ellipse(width=3, height=1)
NumberPlane(); Axes(x_range=[0,10,1], y_range=[0,5,1])
VGroup(a, b, c)   # group; supports .arrange(), .scale(), .animate
```

## Positioning

```python
mob.to_edge(UP)                 # UP/DOWN/LEFT/RIGHT, buff=DEFAULT
mob.to_corner(UL)
mob.move_to(other.get_center())
mob.next_to(other, DOWN, buff=0.3)
mob.shift(RIGHT * 2)
mob.scale(0.5); mob.scale_to_fit_width(12)
group.arrange(RIGHT, buff=0.2)  # lay out children in a line
group.arrange_in_grid(rows=2, buff=0.3)
```

## Animations (pass to self.play)

```python
Write(text); FadeIn(m); FadeOut(m); Create(shape); Uncreate(shape)
GrowArrow(arrow); GrowFromCenter(m); DrawBorderThenFill(shape)
Transform(a, b)        # a becomes b (a is mutated on screen)
ReplacementTransform(a, b)
mob.animate.shift(UP)  # .animate proxy: animate any method/attr change
mob.animate.set_color(RED); mob.animate.set_stroke(YELLOW, 3)
Indicate(m, color=YELLOW); Flash(point); Wiggle(m); Circumscribe(m)
LaggedStart(*anims, lag_ratio=0.1)   # stagger many at once
AnimationGroup(*anims)               # play together
self.play(a1, a2, run_time=1.5)      # multiple anims in parallel
self.wait(1)                          # hold
```

## Parallel vs sequential

- Many anims in one `self.play(...)` run **simultaneously** — this is how the
  CUDA-SAXPY scene shows every thread updating at once.
- Separate `self.play(...)` calls run **in sequence** — a for-loop of single
  `self.play` calls is the sequential/CPU-loop look.

## Updaters (dynamic follow)

```python
label.add_updater(lambda m: m.next_to(dot, UP))
self.play(dot.animate.shift(RIGHT * 3))   # label follows
label.clear_updaters()
```

## ValueTracker (animate a number)

```python
t = ValueTracker(0)
num = always_redraw(lambda: Text(f"{t.get_value():.1f}"))
self.add(num)
self.play(t.animate.set_value(10), run_time=2)
```
