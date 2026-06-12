# Autonomous review loop

This file describes the generic autonomous iteration loop used by **Phase 3**
(plan review, [adversarial-review.md](adversarial-review.md)), **Phase 4a**
(test review, [test-review.md](test-review.md)), and **Phase 5** (code review,
[code-review.md](code-review.md)). Read this file alongside whichever phase is
active.

The loop runs autonomously: the skill iterates through reject → revise →
re-review rounds **without human interaction** until the current round produces
zero CRITICAL and zero HIGH findings. For Phases 3 and 5 the clean result is
then presented for human approval; for Phase 4a the clean exit itself is
autonomous (see "Phase 4a clean exit" below). Safeguards prevent infinite loops
and escape to the human when the machine gets stuck.

## Phase-specific mapping

The loop body is identical; only the methods called differ between phases.

| Action                  | Phase 3 (plan review)               | Phase 4a (test review)                  | Phase 5 (code review)           |
| ----------------------- | ----------------------------------- | --------------------------------------- | ------------------------------- |
| Enter review state      | `review_plan`                       | `review_tests`                          | `review_code`                   |
| Target state            | `reviewing`                         | `reviewing_tests`                       | `code_reviewing`                |
| Auto-reject             | `reject_plan --input source=auto`   | `iterate_tests --input source=auto`     | `iterate --input source=auto`   |
| State after auto-reject | `planned`                           | `writing_tests`                         | `implementing`                  |
| Revise                  | Write new plan YAML, call `plan`    | Rewrite tests (still RED, right reason) | Edit code + re-run tests        |
| Re-enter review         | `review_plan`                       | `review_tests`                          | `review_code`                   |
| Final acceptance        | `approve_plan` (human-gated)        | `tests_approved` (**AUTONOMOUS**)       | `resolve_findings` + `complete` |
| Iteration cap env var   | `MAX_PLAN_ITERATIONS`               | `MAX_TEST_ITERATIONS`                   | `MAX_CODE_ITERATIONS`           |
| History phase tag       | `plan_review`                       | `test_review`                           | `code_review`                   |
| Iteration counter       | `hydrate.planIterationsThisVersion` | `hydrate.testReviewIteration`           | `hydrate.codeReviewIteration`   |

All three caps default to `5` and are skill-enforced against the hydrate
counters (the model reads no env vars). Override via
`agent-constraints/iteration-limits.md`.

## Prerequisite

Before starting the loop, you must have called the phase's review-entry method
(`review_plan` or `review_code`) and run at least one full reviewer fan-out with
`record_review` calls for every active matrix entry. The loop's first decision
point is immediately after the first round is recorded.

## Loop control flow

```
MAX_ITERATIONS   = <5 from agent-constraints, or default>
previous_signature = null
```

After every full fan-out round (every active reviewer has called
`record_review`):

1. **Hydrate.** Read the compact decision summary.

   ```bash
   swamp model method run <issue-name> hydrate
   swamp data get <issue-name> hydrate --json
   ```

   Hydrate reports:
   - `state` — current model state
   - `planVersion` — current plan version
   - `planIterationsThisVersion` — plan-review iterations for this plan version
   - `codeReviewIteration` — code-review iteration counter
   - `blocking: {critical, high, total}` — open blocking findings in the current
     round
   - `coverage: {complete, missing}` — which matrix reviewers have recorded a
     result for this round
   - `signature` — stable hash over the set of open CRIT/HIGH findings (used for
     loop detection)

2. **Exit clean?** If `blocking.total == 0 AND coverage.complete`, **exit the
   loop** and go to "Present to human (clean exit)" below.

3. **Safeguard: iteration cap.** If the relevant iteration counter
   (`planIterationsThisVersion` for Phase 3, `codeReviewIteration` for Phase 5)
   is `>= MAX_ITERATIONS`, **exit the loop** and go to "Handover to human
   (safeguard exit): cap reached".

4. **Safeguard: loop detection.** If `hydrate.signature == previous_signature`,
   **exit the loop** and go to "Handover: loop detected". Two consecutive rounds
   producing the same finding signature means the machine is stuck.

5. **Safeguard: pivot required.** If any open CRIT/HIGH finding has
   `category: pivot-required` OR its description starts with `FUNDAMENTAL:`,
   **exit the loop** and go to "Handover: pivot required".

6. **Record signature for next comparison.**
   `previous_signature = hydrate.signature`.

7. **Auto-revise.** For Phase 3, draft a revised plan addressing every open
   CRITICAL and HIGH finding, then:

   ```bash
   # Phase 3
   swamp model method run <issue-name> reject_plan \
     --input reason="Autonomous iteration <N>: <crit>C + <high>H" \
     --input source=auto
   swamp model method run <issue-name> plan \
     --input summary="..." \
     --input dddAnalysis="..." \
     --input testStrategy="..." \
     --input-file /tmp/plan-issue-<issue-name>-v<N+1>.yaml
   swamp model method run <issue-name> review_plan
   ```

   For Phase 5, fix the code addressing every open CRITICAL and HIGH finding,
   re-run the tests, then:

   ```bash
   # Phase 5
   swamp model method run <issue-name> iterate \
     --input reason="Autonomous iteration <N>: <crit>C + <high>H" \
     --input source=auto
   # ... make code changes in the branch ...
   swamp model method run <issue-name> review_code
   ```

8. **Re-fan-out reviewers.** Go back to step 1 of the phase's review file (fan
   out the active matrix reviewers in parallel). Then return to step 1 of this
   loop.

**Safety invariant:** the loop only auto-rejects / auto-iterates. Plan and code
acceptance are human-gated (steps 2–5 of this control flow include every
safeguard); test acceptance is the model-enforced autonomous gate described
below. Every round is snapshotted to `reviewHistory` before `reviews` resets —
full audit trail preserved.

## Phase 4a clean exit (autonomous)

**This section applies to test review only.** When the Phase 4a loop exits clean
(full matrix coverage AND zero open CRITICAL AND zero open HIGH), call the
acceptance method immediately — **no human trigger phrase is required or
expected**:

```bash
swamp model method run <issue-name> tests_approved
```

The model itself re-enforces the gate (coverage + zero blocking) and rejects the
call otherwise, so this autonomy is safe by construction. Waiting for a human
here is a process bug: the human gates of this lifecycle are `approve_plan`
(Phase 3) and `resolve_findings` (Phase 5), not `tests_approved`. Equally: never
generalize this exception — it applies to `tests_approved` and nothing else.

The "Present to human" section below does **not** apply to Phase 4a's clean
exit. (The safeguard exits — cap reached, loop detected, pivot required — DO
apply to Phase 4a like any other phase; after the `MAX_TEST_ITERATIONS` cap,
`tests_approved --input override_reason="..."` may be used only with explicit
human direction.)

## Present to human (clean exit — Phases 3 and 5)

Show the final plan (Phase 3) or the final implementation diff + test output
(Phase 5), plus a compact iteration history. For Phase 3, render the plan in the
skimmable format from [plan-presentation.md](plan-presentation.md) (the same
format used at planning.md Step 9) — the skim layer sits on top of the full
verbatim plan content the `approve_plan` gate requires, never replaces it. Build
the history table from `reviewHistory`:

```bash
swamp data get <issue-name> current --json
```

Format:

```markdown
**<Plan|Code> review passed after N iteration(s).**

| Version | Iteration | Phase       | CRIT | HIGH | MED | LOW | Reviewers | Outcome       |
| ------- | --------- | ----------- | ---- | ---- | --- | --- | --------- | ------------- |
| v1      | 1         | plan_review | 0    | 3    | 2   | 1   | code, adv | rejected_auto |
| v2      | 1         | plan_review | 0    | 1    | 2   | 2   | code, adv | rejected_auto |
| v3      | 1         | plan_review | 0    | 0    | 2   | 2   | code, adv | clean         |

Adversarial review passed — no blocking findings. 2 MEDIUM + 2 LOW warnings
noted. Ready for your approval when you are.
```

**Wait for an explicit trigger phrase** before calling the acceptance method:

- `approve`
- `approved`
- `looks good`
- `ship it`
- `go`
- `LGTM`

Then call:

- Phase 3: `swamp model method run <issue-name> approve_plan`
- Phase 5:
  `swamp model method run <issue-name> resolve_findings --input-file /tmp/resolutions-issue-<issue-name>.yaml`

If the model rejects the call with an error (e.g. matrix coverage incomplete,
still-open findings), do NOT silence the error. Investigate — the autonomous
loop has a bug or the model state is corrupted.

**Sacred rule:** Even when the loop exits clean, do not call `approve_plan`
(Phase 3) or `resolve_findings` (Phase 5) without the human trigger phrase.
`tests_approved` (Phase 4a) is the single exception: it is called autonomously
when coverage is complete and zero blocking findings remain — do not generalize
this exception.

If the human rejects (says "reject", "no", "try a different approach"), call the
reject method with `source=human` and the human's feedback as the reason, then
return to the previous phase for a fresh revision:

- Phase 3: `reject_plan --input source=human` → back to Phase 2 (planning)
- Phase 5: `iterate --input source=human` → back to Phase 4 (implementation)

## Handover to human (safeguard exit)

One of the three safeguards fired. Present the full history + current state and
ask for **direction**, not approval.

### Format for `cap_reached`

```markdown
**Autonomous iteration cap reached (<N> rounds).** The <plan|code> is still not
clean after <N> automatic revisions. Current blocking findings:

<list of open CRIT + HIGH findings from the latest round, grouped by reviewer>

Full iteration history attached. Your options:

1. Reduce scope — accept a narrower fix and re-plan
2. Different approach — pivot the strategy
3. Accept remaining findings — mark specific findings as accepted/wontfix
4. Manual intervention — take over the <plan|code> directly

How would you like to proceed?
```

### Format for `loop_detected`

```markdown
**Loop detected — two consecutive iterations produced the same findings.** The
autonomous loop is stuck. The same CRIT/HIGH findings keep being raised despite
revisions.

<list of the repeated findings>

This usually means the current approach cannot actually address these concerns.
Your options:

1. Pivot the approach entirely
2. Mark the repeated findings as wontfix with justification
3. Accept that the result is incomplete and proceed anyway (requires you to
   explicitly mark findings as accepted before approval)

What's the right call?
```

### Format for `pivot_required`

```markdown
**Fundamental concern raised — needs human judgment.**

A finding was marked as `pivot-required` or prefixed `FUNDAMENTAL:`, which
signals the current approach may be wrong at a level the autonomous loop can't
resolve.

<the specific finding + full reviewer output>

This isn't something I should auto-fix. What's your call on the direction?
```

### Hand-off rules

- **Never call the acceptance method in handover mode**, even if the human says
  "looks fine". The safeguard fired for a reason.
- If the human wants to proceed after handover, they need to either:
  - Give clear direction that resolves the safeguard (e.g. "mark those as
    wontfix"), after which you update findings' `status` accordingly and re-run
    the loop from the top, OR
  - Explicitly override with "force approve" — in which case you still do not
    auto-call. You re-fan-out reviewers, ensure matrix coverage is complete, and
    ask for the normal trigger phrase.

## Recovering from loop bugs

If the loop misbehaves (hydrate reports stale data, coverage lies, signatures
change unexpectedly):

1. Stop the loop immediately — do NOT auto-iterate again
2. Dump `swamp data get <issue-name> current --json` and the hydrate output
3. Present both to the human with the specific inconsistency
4. Ask for direction — likely a bug in the skill or the model

Do not try to "fix" by calling more methods. State diagnosis first.
