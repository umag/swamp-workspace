# Changelog

## Unreleased

Test + docs backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `extensions/models/good_planning.ts` and `manifest.yaml` are
byte-frozen; the model `version` stays `2026.07.16.2`.

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
  into), and corrupted-stored-state `ZodError`s on read. Also PINS eight found
  bugs (characterized, NOT fixed — tracked in the LOCAL
  `good-planning-latent-bugs` issue-lifecycle model, never filed to the Lab):
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
