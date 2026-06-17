---
issue: gobrr-desired-state-workorders
date: 2026-06-17
kind: decision
---

# Desired-state WorkOrder framing (fixed-point convergence over imperative recipe)

## Context

`build_workorder` assembles the leaf prompt that a `claude --print` agent runs
in a no-clone microVM. Historically the prompt is an **imperative recipe**:
"Apply the requested fixes." Promise Theory / CFEngine argue that **idempotent
desired-state convergence** gives greater assurance than imperative tasks,
because an autonomous agent will deviate from a recipe but can reliably converge
to a measurable end state. This reframes the leaf's job from "do these steps" to
"bring these files to the desired end state."

Two facts bound the design:

- **The leaf is single-shot.** `claude --print` cannot loop. "Converge until the
  gate passes" is therefore the agent's _intent_ plus the **outer gobrr retry
  loop** (`maxAttempts`), never an in-leaf loop. The framing aligns the leaf
  with the loop's fixed-point semantics; it does not give the leaf a retry
  channel.
- **The gate must stay independent** (Promise Theory / sacred rule 5,
  [0005](0005-assessment-boundary-audit.md)). A code leaf is judged by a test it
  never reads (work-contract TDD ordering). So the desired-state prompt must NOT
  name `verifyCommand`, the test, or any gate mechanism — the promise is carried
  by the acceptance criteria the driver already embeds in `spec`.

## Decision

1. **Extract a pure `buildWorkorderPrompt(framing)`** from
   `build_workorder.execute` (the I/O — realpath + read + `scrubSecrets` — stays
   in `execute`; the pure fn receives already-scrubbed slices and never
   re-scrubs). This mirrors the `parseEnvelope` / `planApply` pure cores and
   makes the prompt unit-testable and A/B-able.
2. **Add a `desired-state` framing branch** behind a `PromptFraming` (z.enum)
   value. It reframes the opening instruction as a convergence promise and
   inserts a sentinel scaffold ABOVE the file-slice section (with an
   opaque-content caveat), emitted ONLY in the desired-state branch — so the
   imperative path is **byte-identical** to history (pinned by a regression
   test).
3. **Select the framing by a module constant `WORKORDER_FRAMING`, not a method
   argument.** This keeps the gate independent, avoids a runtime dual-path, and
   leaves the public `build_workorder` argument schema unchanged. The eval
   drives `buildWorkorderPrompt` directly with both framings.
4. **`WORKORDER_FRAMING` stays `imperative` until adoption.** Flipping it to
   `desired-state` requires BOTH: the eval pilot showing desired-state ≥
   imperative AND an explicit human sign-off.

## The eval (adoption gate)

- **Deterministic CI gate** —
  `extensions/models/source_integration_framing.test.ts` pins prompt
  well-formedness for both framings: byte-identity of the imperative path,
  exactly one nonce fence, allowlist echoed, slices inlined, scaffold above
  slices, no re-scrub, and a **gate-leak forbidden-terms** check. The
  forbidden-terms check is **prompt-hygiene, not a security boundary** — the
  real invariant is that `verifyCommand` is absent from `build_workorder`'s
  argument schema.
- **Live A/B pilot** — `tests/eval/workorder-framing/` (opt-in, outside the test
  glob). Pinned `leafModel` / `leafEffort` / fixture / `verifyCommand`. Decision
  criterion: **desired-state ≥ imperative** measured as ≥ 5/5 clean
  (`docker-verify` exit 0) envelopes per framing on the canonical fixture, plus
  a human spot-check of two diffs. Non-deterministic, so it is a
  human-signed-off pilot, never auto-adoption.

  **Pilot result (2026-06-17): desired-state ≥ imperative — bar cleared, no
  regression.** Ran the full 5×3×2 matrix (30 leaves, `claude-sonnet-4-6`/effort
  low) on a scratch jj repo (add `clamp`; fix `lastIndex`; create a `Money` VO),
  each gated by the per-task `deno test` in the hardened container. **Both
  framings: 15/15 green** (every task 5/5 under each framing); all 30 envelopes
  applied cleanly. Spot-checked desired-state diffs were correct (e.g. `Money`
  came back as an immutable VO with positive-integer validation). Caveat: the
  fixture saturated (both framings at 100%), so the pilot proves desired-state
  is **no worse**, not strictly better — a harder, more discriminating fixture
  would be needed to show an advantage. `WORKORDER_FRAMING` stays `imperative`
  pending the human's adoption decision.

  **Harder-fixture follow-up (2026-06-17): still no quality difference.** Re-ran
  the 5×3×2 matrix on terse, discriminating tasks (idempotent `ensureImport`;
  underspecified `slugify` edge cases; an overdraft/negative invariant on
  `Account.withdraw`). Gate pass-rate **among applied leaves was 100% for both
  framings** (imperative 12/12, desired-state 10/10) — every parsed envelope
  produced correct code; on the slug task the two framings emitted the _same_
  implementation. The only spread (imperative 12/15 vs desired-state 10/15
  total) was **envelope-format noise** — dropped `@@ENDEDIT`/markers →
  `envelope_parse` — task-dependent and roughly balanced (desired-state worse on
  slug, imperative worse on account), N=5, not significant, and non-terminal in
  the real loop (`envelope_parse → infra_error → retry`, no attempt consumed).
  **Conclusion: two pilots show no measured quality gain from desired-state
  framing; it is at-best equal.** Adoption is therefore a judgement call on the
  qualitative Promise-Theory rationale, not a data-driven win.

## Consequences

- **Gate independence preserved.** The desired-state prose names no test /
  runner / gate mechanism; `verifyCommand` is not an input to `build_workorder`.
- **Imperative behaviour unchanged.** The constant default + byte-identity test
  guarantee no drift while the pilot is pending.
- **No permanent dual-path.** Both framings live only inside the pure function
  as the eval baseline. On adoption (the `WORKORDER_FRAMING` flip) the losing
  branch AND the `framing` parameter are removed, collapsing
  `buildWorkorderPrompt` to a single path; the skill references
  (`inline-loop.md`, `work-contract.md`, `SKILL.md`), `CHANGELOG.md`,
  `README.md`, `docs/patterns/cli-arg-flag-injection.md`, and `manifest.yaml`
  are refreshed in the same change.

## Out of scope

The pre-existing `isSafeRepoScope` null-byte / percent-encoding gap is tracked
separately under `si-defense-in-depth-followups` and is not touched here.
