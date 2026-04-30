---
name: good-planning
description: Operationalize Felipe Bovolon's "Good Planning Bad Planning" four-layer architecture as queryable swamp state. Use when converting a strategic choice into funded, synchronized, contingent, and revisable commitments — or auditing whether an existing plan can actually be steered. Triggers on "good planning", "build a plan", "audit a plan", "plan governability", "tripwire", "signpost", "pullback ladder", "first binding crux", "max tolerable loss", "trigger point", "commit gate", "do strategic planning", "convert strategy to action", "we just had an offsite", "how do we know if assumptions are breaking", "the plan looks good on paper but". Do NOT use for raw project scheduling, OKR drafting, or single-team sprint planning — this is for organization-level commitment design.
---

# Good Planning

Drives the `@magistr/good-planning` model. Strategy chooses; planning commits.
The model exists to refuse calling a plan "committed" until every layer of the
article's architecture is materially present.

## When to invoke

A user describes converting strategy to action, or asks whether their existing
plan would survive contact with reality. Concrete tells:

- "We just had a strategy offsite — now what?"
- "How do we know if our assumptions are breaking?"
- "The plan slipped and nobody saw it coming."
- "We hit our targets but ran out of capacity."
- "Can we audit our current plan?"

Skip this skill for: project schedules, OKR drafting, sprint planning, or
strategy-choice work itself. Strategy is upstream; planning is what this covers.

## Four layers (one line each)

1. **Assumption** — what the plan believes about the world; signposts tell you
   when belief and reality diverge.
2. **Allocative** — what is actually funded and protected; budgets reveal real
   priorities regardless of what the strategy deck says.
3. **Coordinative** — how commitments interlock; the same commitments should
   describe the same plan to every function.
4. **Adaptive** — how the plan revises. Two halves:
   - _Ceiling_ — the first binding crux of success and the trigger point for
     relieving it.
   - _Floor_ — signposts → tripwires → pre-authorized actions, plus a pullback
     ladder and an explicit max tolerable loss.

## Two formulas

```
trigger_point     = time_to_crux − lead_time_to_relieve − safety_margin
max_tolerable_loss = sunk + shutdown + liabilities + working_cap_unwind + tail
```

A negative trigger point means the plan is already late. Max tolerable loss must
be stated _before_ stress arrives.

## Six properties of a real commitment

The model refuses to register a commitment without all six:

1. owner (personal accountability — empty string fails)
2. resource (budgeted; zero fails)
3. time (parseable date)
4. dependencies (may be empty for a top-level commitment)
5. review rule (cadence string)
6. consequence-if-changed

Every commitment must be tagged either `commitment` (the org can directly
execute) or `hypothesis` (an external response the org can influence but not
control). Hypotheses get tested, not completed.

## Workflow

### 0. Audit an existing plan (the fast path)

If the user already has a plan and wants to know whether it's actually
governable, audit first — don't ask them to rebuild from scratch.

```
swamp model method run <plan-name> audit     # answers the 4 diagnostic Qs
swamp model method run <plan-name> hydrate   # compact governability summary
swamp data get <plan-name> hydrate
```

The audit's `governabilityScore` (0..1) tells you which of the five layer
answers are missing. Zero on Layer 1 means the plan quietly assumes certainty.
Zero on Layer 4 floor means there is no tripwire system.

### 1. Build a plan from a strategic choice

```
swamp model create @magistr/good-planning <plan-name>
swamp model method run <plan-name> start \
  --input strategicChoice="…" --input horizon="3y"
```

Then add to each layer:

- `add_assumption` — Layer 1 (statement + impact + vulnerability + signpost)
- `add_commitment` — Layer 2/3 (six-property gate; commitment vs hypothesis)
- `add_allocation` — Layer 2 (protected budget per priority)
- `add_ceiling` — Layer 4a (crux + lead time + safety margin + signpost)
- `add_tripwire` — Layer 4b (signpost + threshold + pre-authorized action)
- `set_pullback_ladder` — Layer 4b (ordered cuts)
- `set_loss_budget` — Layer 4b (five components)

### 2. Commit (the gate)

```
swamp model method run <plan-name> commit
```

Refuses if any layer is empty or any commitment is missing properties. The error
names every gap. Do not weaken this gate — it IS the model.

### 3. Monitor on a cadence

```
swamp model method run <plan-name> monitor
swamp model method run <plan-name> evaluate \
  --input signpostName="…" --input reading="…" \
  --input tripwireState=fired
```

`evaluate` throws on unknown signpost names so typos surface fast.

### 4. Adapt when a tripwire fires or a ceiling is breached

```
swamp model method run <plan-name> trigger \
  --input signpostName="…" --input reason="…"
swamp model method run <plan-name> adapt \
  --input triggeredBy="…" --input actionTaken="…" --input reason="…"
```

Or, if the assumption itself broke:

```
swamp model method run <plan-name> revise \
  --input reason="…" --input brokenAssumptions='["…"]'
```

`revise` bumps `planVersion` and returns to `drafted`.

### 5. Audit and scorecard

```
swamp model method run <plan-name> audit     # answers the 4 diagnostic Qs
swamp model method run <plan-name> hydrate   # compact governability summary
swamp data get <plan-name> hydrate --version <n>
```

The hydrate summary is what an autonomous monitor loop reads to decide whether
to fire a tripwire or page a human.

## What this skill will NOT do

- Pick the strategic choice for the user. That is upstream work.
- Weaken the commit gate via "force" or "skip" flags.
- Score a plan as governable when any layer is missing.
- Treat scenarios as governable if they don't change the first binding
  constraint or the action package — the article calls those "ranges," not
  scenarios.

## Article reference

Bovolon, Felipe. "Good Planning Bad Planning." _Sequential Advantage_, April
16 2026. https://bovolon.substack.com/p/good-planning-bad-planning
