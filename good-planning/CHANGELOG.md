# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Real-fix wave for the eight GP-1..GP-8 bugs pinned by the prior release's
adversarial suite (same wave as sibling extensions `seadex` and
`victoriametrics`, both already at `2026.08.02.1`). Model version bumped
`2026.07.16.2` → `2026.08.02.1` with an `upgrades[]` entry; resource schema
unchanged (`upgradeAttributes: (old) => old`).

- **GP-1 fixed** (MEDIUM) — `start()` now reads the existing `current` resource
  before writing. If a plan already exists it throws (naming its
  `state`/`planVersion`) instead of silently wiping it — pass the new
  `force: true` argument to intentionally discard an existing plan and start
  fresh.
- **GP-2 fixed** (MEDIUM) — `adapt()` now resets the tripwire matching
  `triggeredBy` back to `"dormant"` when it was `"fired"`, so a stale
  re-`trigger()` after `adapt()` → `monitor()` correctly rejects with "No fired
  tripwire" until a fresh `evaluate()` fires it again.
- **GP-3 fixed** (MEDIUM) — `commitmentSatisfiesSixProperties`'s `byDate` check
  no longer relies on `Date.parse`'s engine-defined leniency. It now requires a
  strict ISO-8601 calendar date or date-time (`z.iso.date()` /
  `z.iso.datetime()`); `"2026"` and `"next quarter"` are both rejected,
  `"2026-09-01"` still accepted.
- **GP-4 fixed** (LOW) — `evaluate()` now rejects a mismatched-layer payload
  (e.g. `timeToCruxWeeks` for a signpost with no matching ceiling) instead of
  silently dropping it, naming the offending field and the layer it needs.
- **GP-5 fixed** (LOW) — `commitGateReport`, `governabilityScore`, and
  `auditDiagnosticQuestions.layer1Visible` now share one `hasLiveAssumption`
  predicate that excludes `state:"broken"` assumptions. A plan whose every
  assumption is broken now fails the commit gate and scores Layer-1 absent; a
  plan with at least one non-broken assumption still scores it present.
- **GP-6 fixed** (LOW) — `tripwire.pullbackRung` is now bounds-checked against a
  _non-empty_ `pullbackLadder`: `add_tripwire` rejects a rung past the current
  ladder length, and `set_pullback_ladder` rejects a ladder too short for an
  already-referenced rung. A rung recorded before any ladder is set (deferred)
  and `pullbackRung:0` against an empty ladder both stay legal — required by the
  frozen contract fixture.
- **GP-7 fixed** (LOW) — every `add_*` method (`add_assumption`,
  `add_commitment`, `add_allocation`, `add_ceiling`, `add_tripwire`) is now
  idempotent: a structurally-identical repeat call is a no-op (still returns a
  handle); a call differing in even one field still appends normally.
- **GP-8 fixed** (LOW) — `computeTriggerPoint` and `computeMaxTolerableLoss` now
  throw on non-finite (`NaN`/`Infinity`) inputs instead of propagating them
  through the arithmetic. The method-arguments zod boundary already rejected
  both for plain `z.number()` fields; these two guards close the gap for direct
  calls to the exported pure helpers.
- Rewrote the eight GP-* pins in `good_planning_adversarial_test.ts` from
  "asserts the buggy behavior" to "asserts the fixed behavior", and added
  idempotence (GP-7), `force:true` (GP-1), strict-date (GP-3), and ladder-bounds
  (GP-6) positive-path tests alongside them. The frozen contract suite
  `good_planning.test.ts` and the `methods`/`coverage`/ `property` suites are
  unchanged (traced call-by-call; every exercised path uses matching-layer
  payloads, distinct `add_*` args, finite numbers, and a fresh-context `start`).
- `quality.yaml`: re-stamped from a live `swamp extension quality` run; dropped
  the prior release's "byte-frozen / no behavior change" wording now that this
  release ships real fixes. All five suites stay `present`; ratchet stays `100`
  / `"Grade A"`.

## Unreleased (2026.07.16.2 — superseded by 2026.08.02.1 above)

Test + docs backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `extensions/models/good_planning.ts` and `manifest.yaml` were
byte-frozen at the time; the model `version` stayed `2026.07.16.2`.

- Kept `extensions/models/good_planning.test.ts` (25 tests) verbatim as the
  `contract-fixture` suite — its fake-context harness (in-memory store +
  `readResource`/`writeResource` running `PlanStateSchema.parse` on every state
  write) is the pattern every new suite file below reuses, each as its own
  self-contained copy per the established porkbun/comfyui precedent.
- Added `extensions/models/good_planning_methods_test.ts` (`methods`, 49 tests)
  — every one of the 17 model methods' success path, `guardState` throw, and "No
  plan — run 'start' first" no-plan throw, driven through the method's real zod
  `arguments` schema (not `execute()` directly), so a CLI-boundary regression
  would surface here too.
- Added `extensions/models/good_planning_adversarial_test.ts` (`adversarial`, 26
  tests) — zod-boundary rejections (empty required strings, negative numbers)
  and admissions (no upper bound on budgets/string length), injection-shaped
  strings stored inertly (this model has no fetch/shell/HTML sink to inject
  into), and corrupted-stored-state `ZodError`s on read. Also pinned eight found
  bugs (characterized, not yet fixed at the time — tracked in the LOCAL
  `good-planning-latent-bugs` issue-lifecycle model, never filed to the Lab; see
  the `2026.08.02.1` entry above for the real fixes):
  1. **GP-1** (MEDIUM) — `start()` is unguarded and destructive: re-invoking it
     on an existing committed/monitoring plan silently wipes every layer and all
     history, resetting `planVersion` to 1.
  2. **GP-2** (MEDIUM) — a fired tripwire re-triggers `trigger()` with no
     intervening `evaluate()` after an `adapt()` → `monitor()` cycle, because
     `adapt()` never resets the tripwire's `state` back to `"dormant"`.
  3. **GP-3** (MEDIUM) — `commitmentSatisfiesSixProperties`'s `byDate` check
     inherits `Date.parse`'s leniency (`"2026"` parses; `"next quarter"` does
     not), which is engine-defined and may diverge across V8 versions.
  4. **GP-4** (LOW) — `evaluate()` silently drops a `timeToCruxWeeks` payload
     when the signpost has no matching ceiling — no error, partial no-op.
  5. **GP-5** (LOW) — `commitGateReport`/`governabilityScore` count assumptions
     by array length only, ignoring `state:"broken"` — a plan whose every
     assumption is broken still commits and still scores layer-1 present.
  6. **GP-6** (LOW) — `tripwire.pullbackRung` is never bounds-checked against
     `pullbackLadder.length`; a dangling index is accepted.
  7. **GP-7** (LOW) — every `add_*` method performs no dedup; repeated calls
     with identical arguments append duplicates.
  8. **GP-8** (LOW) — `computeTriggerPoint`/`computeMaxTolerableLoss` propagate
     `NaN`/`Infinity` unguarded when called directly, bypassing the
     method-arguments zod boundary (which, on inspection here, actually rejects
     both `NaN` and `Infinity` for a plain `z.number()` field — correcting the
     approved plan's assumption that `.nonnegative()` alone admits `Infinity`
     through that boundary).
- Added `extensions/models/good_planning_coverage_test.ts` (`coverage`, 14
  tests) — `evaluate()`'s ceiling branch when `timeToCruxWeeks` is omitted,
  `adapt()`'s matching/non-matching `exercisedCeilingCrux` branches,
  `guardState()`'s array-form vs. scalar-form rejection message, every FALSE
  branch of `auditDiagnosticQuestions` isolated individually (including a
  zero-sum-allocation and an incomplete-commitments case the contract-fixture
  did not cover), `hydrate()`'s commitment/hypothesis split arithmetic, and
  `archive()`'s guard-throw from every non-terminal-reachable state.
- Added `extensions/models/good_planning_property_test.ts`
  (`property-invariant-flow`, 9 tests) — `fast-check@4.8.0` gated by
  `FC_NUM_RUNS`, `@std/testing` `FakeTime` for the idempotence check: loss-sum
  exactness + monotonicity, trigger-point linearity + monotonicity,
  governability score always `k/5` in `[0, 1]`,
  `commitGateReport.ok ⇔
  governabilityScore === 1` over randomized
  layer-presence combinations, `knownSignposts` sorted+deduped regardless of
  input order/duplication, a randomized legal method-call flow that keeps
  `current` `PlanStateSchema` -valid after every single step, and `hydrate()`
  idempotence under a frozen clock.
- `deno.json`: `test` task now globs `extensions/models/`
  (`--allow-env=
  FC_NUM_RUNS`, no other permissions — the model does no I/O);
  `check` task globs `extensions/models/*.ts`; added `test:soak` for the
  high-count nightly property soak.
- `quality.yaml`: all five required suites flip `backlog` → `present`;
  `docs.readme`/`docs.changelog`/`docs.skill` flip `backlog` → `present`
  (README.md, this CHANGELOG.md, and `.claude/skills/good-planning/SKILL.md` all
  already exist); `watch`/`canary` stay `backlog` (Phase B/C, exempt from the
  allowlist gate); measured ratchet `100` / `"Grade A"`. Removed from
  `quality-allowlist.txt` in the same change.
