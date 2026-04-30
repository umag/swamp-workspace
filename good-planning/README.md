# Good Planning Extension Model

The `@magistr/good-planning` extension model operationalizes Felipe Bovolon's
[Good Planning Bad Planning](https://bovolon.substack.com/p/good-planning-bad-planning)
four-layer architecture as queryable swamp state.

> Strategy chooses a direction. Planning decides whether that choice can survive
> contact with money, capacity, time, and surprise. The organization does not
> become what it declares. It becomes what it actually funds, sequences,
> protects, and revises.

A plan should not be a slide deck. This model makes commitments, assumptions,
signposts, tripwires, ceilings, and the pullback ladder first-class state that
can be evaluated and revised on a cadence — rather than executed-as- written
until reality breaks it and forces a conference room.

## Four Layers

| Layer | What               | Diagnostic question                                                                                                                                                                  |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Assumption         | Can leadership name in two minutes the assumptions that, if wrong, would invalidate the plan? And the signposts that would tell them they were breaking?                             |
| 2     | Allocative         | Lay the strategy deck next to the budget. Would an outsider say they are about the same company?                                                                                     |
| 3     | Coordinative       | Would Marketing, Operations, Finance, and Engineering each describe the same plan with the same timelines and dependencies?                                                          |
| 4a    | Adaptive — ceiling | Have you named the first binding crux of success, the lead time to relieve it, and the trigger point? Are pre-authorized option premiums in place?                                   |
| 4b    | Adaptive — floor   | Do you have signposts with tripwires that trigger pre-authorized actions, a pullback ladder, an explicit maximum tolerable loss, and structural protections for fast-moving hazards? |

The `audit` method answers all five questions against the current plan state.
The `hydrate` method writes a compact `summary` resource holding a governability
scorecard.

## State Machine

```
drafted ──[commit]──> committed     (gated: all four layers populated)
committed ──[monitor]──> monitoring
monitoring ──[evaluate]──> monitoring  (read signposts, update layer state)
monitoring ──[trigger]──> adapting     (tripwire fired or ceiling crossed)
adapting ──[adapt]──> committed        (pullback or option exercised)
adapting ──[revise]──> drafted         (assumption broken — re-plan)
committed ──[archive]──> archived
monitoring ──[archive]──> archived
```

`commit` is the gate. It refuses to leave `drafted` unless:

- there is at least one assumption with a signpost,
- there is at least one commitment, and every commitment has all six properties
  (owner, resource, time, dependencies, review rule, consequence-if-changed),
- there is at least one allocation with a protected budget,
- there is at least one ceiling with a computed trigger point, and
- there is at least one tripwire with a pre-authorized action.

These gates encode the article's claim that _most companies fail on layers one,
two, and four_ — refusing to call a plan committed without them is the point.

## The Six-Property Commitment Rule

> Without these six properties you do not have a plan. You have a wish list.

`add_commitment` enforces all six properties up front. It also requires every
line item to be tagged either `commitment` (the org can directly execute it) or
`hypothesis` (an external response the org can influence but not control).
Hypotheses get tested, not completed; the model surfaces this distinction in the
audit and the scorecard.

## Adaptive Layer Mathematics

**Ceiling trigger point** (per the article):

```
trigger_point = time_to_hit_crux − lead_time_to_relieve_crux − safety_margin
```

If the trigger point is negative, the plan is already late. Before the trigger,
the model expects you to spend only on low-regret option premiums (permits,
vendor qualification, modular designs, cross-training); after, the option is
exercised.

**Maximum tolerable loss**:

```
max_tolerable_loss = sunk_cost + shutdown_cost + committed_liabilities
                     + working_capital_unwind + tail_provisions
```

Stated _before_ stress arrives, so cuts are not improvised under pressure.

## Methods

- `start` — create a draft plan with `strategicChoice` and `horizon`
- `add_assumption` — record an assumption with impact / vulnerability / signpost
- `add_commitment` — six-property commitment or hypothesis
- `add_allocation` — protected budget per priority (Beyond Budgeting separation)
- `add_ceiling` — first-binding crux + lead time + signpost
- `add_tripwire` — signpost threshold + pre-authorized action + pullback rung
- `set_pullback_ladder` — ordered list of cuts
- `set_loss_budget` — sunk + shutdown + liabilities + working-capital + tail
- `commit` — drafted → committed (gated)
- `monitor` — committed → monitoring
- `evaluate` — read a signpost; updates assumption / tripwire / ceiling state
- `trigger` — monitoring → adapting (a signpost has breached its tripwire)
- `adapt` — record adaptation; adapting → committed
- `revise` — adapting → drafted (assumption broken; re-plan)
- `archive` — terminal
- `hydrate` — write compact governability scorecard summary
- `audit` — answer the four diagnostic questions

## Resources

- `state` — single source of truth, holds the full plan
- `summary` — compact scorecard written by `hydrate`

Both have `lifetime: infinite` and modest GC. Sensitive fields (none by default)
can be marked with `z.meta({ sensitive: true })` if your assumption or
commitment narrative contains restricted material.

## Citation

Bovolon, Felipe. "Good Planning Bad Planning." _Sequential Advantage_, April
16 2026. https://bovolon.substack.com/p/good-planning-bad-planning

## License

MIT — see [LICENSE.md](LICENSE.md).
