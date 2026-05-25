# Plan presentation: Wardley maps (strategic issues only)

Optional companion to [plan-presentation.md](plan-presentation.md). Read it only
when an issue poses a **strategic** question rather than a tactical one.

## The layer mismatch

A Wardley map answers "_should we do this, and how strategically_" — horizon of
months/years. An implementation plan answers "_here's exactly how I'll touch
these 5 files_" — horizon of hours/days. They are different layers.

For a typical tactical plan (5–10 steps, 3–5 files, add endpoint / fix bug /
refactor module) a Wardley map is **harmful**:

- All components sit at similar maturity and visibility → three dots in one
  quadrant → useless.
- The plan decision is a 30-second skim; a Wardley map needs interpretation
  (read axes, place components, understand positioning) → it _adds_ cognitive
  load.
- It doesn't show scope (files and ops) — the thing that matters most for
  approve / refine.

**Never bolt a Wardley map onto a routine tactical plan.** It breaks the skim.

## Where it does fit

Exactly one case: the issue itself is a **strategic / scoping** question.

- "Write auth ourselves or use Auth0?" — canonical build-vs-buy.
- "Migrate from our own queue to SQS?" — custom → commodity evolution.
- "Extract the recommendation engine to a separate service?" — value-chain
  analysis.

In issue-lifecycle terms this is **not a plan step — it is a discovery / scoping
step that happens _before_ the implementation plan.** Generate the map ONLY when
the issue or plan involves at least one of:

- Build vs buy (own implementation vs third-party / managed service)
- Migration between custom and commodity components
- Choosing among 3+ alternatives at different maturity levels
- Strategic refactor: extracting a component to its own service

## Two ways to wire it into the lifecycle

- **Strategic issue type.** Mark the issue `strategic` / `scoping`. The
  lifecycle first runs a Wardley step (map + 3–5 lines of recommendation), the
  human makes the build/buy/integrate call, and _then_ the normal tactical plan
  proceeds for the chosen option.
- **Section in the HTML artifact.** When a plan auto-promotes to HTML
  ([plan-html-artifacts.md](plan-html-artifacts.md)) and the alternatives sit in
  different quadrants, add a "Strategic context" section with the map.

## Syntax (Mermaid v11.14+, `wardley` block)

````
```mermaid
wardley
    title Auth: build vs buy
    anchor User [0.95, 0.50]
    component Login UI [0.90, 0.70]
    component Auth API [0.75, 0.40]
    component Session Store [0.50, 0.85]
    component Identity Provider [0.40, 0.30]
    User -> Login UI
    Login UI -> Auth API
    Auth API -> Session Store
    Auth API -> Identity Provider
    evolve Identity Provider 0.85
    note Auth0 sits at commodity end; building in-house drags us back to custom [0.30, 0.20]
```
````

Here `Identity Provider` is currently custom (0.30); `evolve` shows movement
toward commodity (0.85) → use a managed solution, don't build. The strategic
implication is visible at a glance.

Conventions when you do generate one:

- Y-axis = **visibility** (0 = infrastructure, 1 = user-facing).
- X-axis = **evolution** (0 = genesis, 1 = commodity).
- Mark the **anchor** (User / Customer) explicitly.
- Add `evolve` for components actively moving along the evolution axis.
- One `note` is enough — call out the single strategic conclusion.

## Caveat

The Mermaid `wardley` type is **beta**: custom D3 renderer, no hand-drawn mode.
Fine for production HTML artifacts, but the Claude Code CLI does **not** render
Mermaid at all — so a Wardley map **lives in an HTML artifact only, never in the
main terminal plan output.**
