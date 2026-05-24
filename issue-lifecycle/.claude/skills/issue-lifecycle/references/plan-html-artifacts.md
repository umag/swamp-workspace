# Plan presentation: HTML artifact escalation

Optional companion to [plan-presentation.md](plan-presentation.md). Read it
when a plan is too large or too comparative for the terminal render.

Markdown is a low-bandwidth format. Past ~100 lines it stops working as
communication: the reader scrolls instead of skims and the scope/risk anchors
get lost. The rule the Claude Code team converged on: **if the reader is a
model, markdown; if the reader is a human and the plan takes more than ~30
seconds to read, HTML.** Switching cost is near zero.

## When to escalate

Propose an HTML artifact if **any** of these is true:

- More than **4 files** touched.
- A **migration**, **schema change**, or **breaking API change** is involved.
- **3+ alternatives** need to be compared side by side.
- **Multi-issue / multi-PR** work.

These map to where HTML strictly beats markdown:

| Situation | Why HTML wins |
|-----------|---------------|
| Comparing alternatives | side-by-side columns vs scrolling between A/B/C |
| Large scope (10+ files) | collapsible per-module sections + dependency tree |
| Migrations / schema | before/after in two columns |
| Multi-step with deps | dependency overview with ordering |

## Auto-promote, don't wait to be asked

The escalation should fire **on its own**, not require the human to request
it. Heuristic the issue-lifecycle harness uses:

> **files > 4 OR the plan text contains `migration` / `schema` / `breaking`**
> → offer HTML proactively.

When the terminal render would exceed ~100 lines, stop and output exactly:

> This plan is large enough to warrant an HTML artifact. Want me to generate
> one?

— then wait. Don't dump 150 lines of markdown first.

## What the HTML artifact contains

Same sections as the terminal format (Goal, Approach, Domain impact, Scope,
Risks, Steps, Non-goals, Open questions), plus:

- **Collapsible per-module breakdown** for large scope — one `<details>` block
  per module/aggregate so the reader expands only what they care about.
- **Side-by-side alternative comparison** when 3+ options exist.
- **Dependency overview** when steps have ordering constraints.
- **Strategic context section** (optional) — a Wardley map when alternatives
  sit in different evolution quadrants ("write our own cache" vs "managed
  Redis"). See [plan-wardley.md](plan-wardley.md). Wardley lives **only** in
  HTML — the CLI doesn't render Mermaid.

Constraints: a **single self-contained `.html` file, inline CSS, no external
dependencies**. Always also print a short terminal summary (Goal + Scope table
+ Risks) so the decision can start in the terminal and only drop to the
browser when the reader wants depth.

## Persisted plan + drift detection

- Save the approved plan alongside the model state so it survives session
  resumption (Claude Code also persists plan-mode plans under
  `~/.claude/plans/`).
- If implementation later deviates from the approved plan, diff against the
  saved copy and re-plan rather than silently diverging.

## Triage summary

| Plan size | Format |
|-----------|--------|
| 1–2 files, 1 step | inline in terminal |
| 3–5 files, ≤8 steps | markdown in terminal (plan-presentation.md) |
| 5+ files, or migration | HTML artifact + short terminal summary |
| refactor / multi-issue | HTML mandatory |
