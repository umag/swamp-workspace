# Manim scene patterns

Reusable recipes for `@magistr/manim/scene`. Text-only (no LaTeX).

## Labelled array of cells

A row of boxes each holding a value, with a tag on the left. The building block
for array/vector/algorithm animations (SAXPY, sorting, prefix-sum, …).

```python
def make_row(vals, color, label):
    cells = VGroup()
    for v in vals:
        sq = Square(0.7).set_stroke(color, 2)
        num = Text(str(v), font_size=24).move_to(sq)
        cells.add(VGroup(sq, num))   # cell = [square, number]
    cells.arrange(RIGHT, buff=0.12)
    tag = Text(label, font_size=26, color=color).next_to(cells, LEFT, buff=0.3)
    return VGroup(tag, cells), cells   # return group AND the cells for indexing
```

Update a cell's value in place (used to show `y[i]` changing):

```python
new_num = Text(str(new_val), font_size=24).move_to(cell[1].get_center())
self.play(Transform(cell[1], new_num))
```

## Sequential per-element loop (CPU style)

Each element handled one after another — separate `self.play` calls sequence it.

```python
for i in range(len(x)):
    self.play(Indicate(xcells[i]), Indicate(ycells[i]), run_time=0.4)
    nv = a * x[i] + y[i]
    self.play(
        Transform(ycells[i][1],
                  Text(str(nv), font_size=24).move_to(ycells[i][1])),
        run_time=0.5,
    )
```

## Parallel update (GPU / CUDA style)

Every element updates in ONE `self.play` — the visual signature of parallelism.

```python
new_nums = [
    Text(str(a * x[i] + y[i]), font_size=24).move_to(ycells[i][1].get_center())
    for i in range(n)
]
self.play(*[Indicate(t, color=YELLOW) for t in threads], run_time=0.6)
self.play(
    *[ycells[i][0].animate.set_stroke(YELLOW, 3) for i in range(n)],
    *[Transform(ycells[i][1], new_nums[i]) for i in range(n)],
    run_time=1.0,
)
```

## Thread grid mapping (one thread per element)

Show blocks × threads and map each to a data cell with arrows.

```python
block_dim = 4
block_colors = [ORANGE, PURPLE]
threads = VGroup()
for i in range(n):
    c = block_colors[i // block_dim]
    box = RoundedRectangle(corner_radius=0.08, width=0.62, height=0.5) \
        .set_stroke(c, 2).set_fill(c, 0.15)
    lbl = Text("b%d.t%d" % (i // block_dim, i % block_dim),
               font_size=14, color=c).move_to(box)
    threads.add(VGroup(box, lbl))
threads.arrange(RIGHT, buff=0.12)

arrows = VGroup(*[
    Arrow(threads[i].get_bottom(), xcells[i].get_top(),
          buff=0.05, stroke_width=2).set_color(block_colors[i // block_dim])
    for i in range(n)
])
self.play(LaggedStart(*[GrowArrow(a) for a in arrows], lag_ratio=0.1))
```

## Vertical layout that stays in frame

Stack titled rows and scale down if crowded.

```python
grid = VGroup(threads, xcells, ycells).arrange(DOWN, buff=0.45)
grid.next_to(code, DOWN, buff=0.5)
if grid.width > 13:
    grid.scale_to_fit_width(13)
```

## Code snippet on screen

```python
code = Text(
    "__global__ void saxpy(int n, float a, float* x, float* y) {\n"
    "    int i = blockIdx.x*blockDim.x + threadIdx.x;\n"
    "    if (i < n) y[i] = a*x[i] + y[i];\n"
    "}",
    font="Monospace", font_size=18, line_spacing=0.7,
).to_edge(UP)
self.play(FadeIn(code))
```
