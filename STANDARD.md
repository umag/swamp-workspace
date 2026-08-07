# Extension Quality Standard

This is the machine-checked quality bar for every extension in swamp-workspace.
It is enforced by the `compliance` job in `.github/workflows/ci.yml` via the
validators under `scripts/quality/`.

Phase A (this document + its CI gate) ships the standard and its enforcement.
Three sibling phases build on the schema this document defines:

- **Phase B** (`ext-quality-release-watch-soak`) — the generalized `watch:`
  release-watch workflow and rotating high-count property soak.
- **Phase C** (`ext-quality-live-canary`) — the live `canary:` verification
  workflow against a real running instance.
- **Phase D** (`ext-quality-test-backfill`) — backfilling the five suites for
  every extension currently on `quality-allowlist.txt`, shrinking the allowlist
  to empty over time.

Phase A declares the `watch:` and `canary:` shapes in the schema and describes
them below so Phases B/C have a stable contract to build against, but does
**not** build those workflows itself.

## The five required suites

Every extension declares five test suites in its `quality.yaml`, named by
**ROLE** — never by filename convention. Real test file names are heterogeneous
across this repo (`stripe-mpp` uses `stripe_mpp_methods_test.ts`, `swamp-go-brr`
uses co-located `<model>.test.ts`, `libvirt` uses topical `_test.ts`, `comfyui`
uses `.test.ts`). A suite is **present** iff its `quality.yaml` entry declares
`files[]` that exist on disk — the compliance checker never scans for a filename
pattern.

The single source of truth for this list is `REQUIRED_SUITES` in
[`scripts/quality/schema.ts`](scripts/quality/schema.ts) — this list is tested
equal to it in `schema.test.ts`. If you edit one, edit the other.

<!-- REQUIRED_SUITES:START -->

- `contract-fixture` — pins the model's wire format / SDK behavior to a spec or
  a fixture, independent of any live network call. Answers: "if this test
  breaks, did the contract with the outside world change?"
- `methods` — exercises every model method's success and failure paths, with
  `fetch`/subprocess calls stubbed. Answers: "does each method do what it says?"
- `adversarial` — attacker's-perspective tests: injection, malformed input,
  credential handling, spec-violating responses. Answers: "what happens when the
  input or the network is hostile?"
- `coverage` — regression tests closing gaps a code reviewer found (a guard with
  no test protecting it). Answers: "if someone deletes this guard, does a test
  go red?"
- `property-invariant-flow` — property-based / invariant / multi-step-flow tests
  using `fast-check`, gated by an `FC_NUM_RUNS` env knob (small by default in
  CI, large in a rotating nightly soak). Answers: "does this hold for every
  input, not just the examples I thought of?"

<!-- REQUIRED_SUITES:END -->

## quality.yaml schema

`schemaVersion: 1`. Every suite/docs-item/watch/canary entry is one of three
states:

- **`present`** — backed by real `files: [...]` that must exist on disk.
- **`na`** — permanently not applicable, with a justification of **at least 12
  trimmed characters**. Never allowlist-gated; a legitimately inapplicable suite
  stays `na` forever.
- **`backlog`** — temporary debt, with a justification of **≥12 characters that
  cites `ext-quality-test-backfill`** (the Phase D tracking issue) so the debt
  is traceable.

**Backlog eligibility == allowlist membership — but only for what Phase A
actually enforces: the five suites and the three `docs` items.** A backlog
`tests.*` or `docs.*` entry on a non-allowlisted extension fails compliance, and
vice versa (`check_allowlist.ts` cross-checks both directions via `schema.ts`'s
`hasAnyBacklog`). `watch` and `canary` are **exempt from this gate** — every
extension's `watch`/`canary` will legitimately be `backlog` until Phase B/C ship
the workflows those blocks describe (see "Seeding the baseline" below), so
gating them on the allowlist would force even a fully-compliant extension like
`stripe-mpp` onto it for no reason connected to what this phase enforces.

### `tests:` block

Keyed by the five suite roles above. See the worked examples below.

### `watch:` block (Phase B's contract)

```yaml
watch:
  state: present
  sources:
    - { kind: npm, package: mppx, distTag: latest }
```

Phase A validates only the `state`/`justification` envelope here. `sources[]`
carries Phase B's four-kind union (npm package, GitHub release, container image
tag, or arbitrary URL-poll — exact shape TBD by Phase B) and is treated as a
validated-elsewhere passthrough by this schema (`scripts/lib/watch_schema.ts`,
which does not exist yet, will own that validation). `present` requires at least
one entry in `sources[]` — an empty watch that watches nothing is a compliance
violation.

### `canary:` block (Phase C's contract)

```yaml
canary:
  state: present
  instance: my-widget-instance
  method: lookup
  args: { id: "abc123" }
  assert: "data.latest('widget', 'lookup').attributes.status == 'ok'"
  fixture:
    method: lookup
    redact: ["$.secretKey", "$.token"]
```

- `instance` + `method` (+ optional `args`, default `{}`) — the live model
  method Phase C's canary workflow will run against a real instance.
- `assert` (optional) — a CEL expression checked against the result.
- `fixture` (optional) — records the canary's own output as a regression
  fixture. `redact` lists JSONPath-like pointers into the response that must be
  scrubbed before the fixture is committed (never commit secrets captured from a
  live run).
- **Fixture path convention:** canary/contract fixtures live under
  `<extension>/fixtures/` — a dedicated directory, sibling to
  `extensions/models/`, so they are easy to find and to `.gitignore`-audit for
  accidental secrets.

### `docs:` block

`readme`, `changelog`, `skill` — same present/na/backlog envelope as the test
suites. `skill` covers the bundled-Claude-skill tessl score (≥90); `na` when the
extension bundles no skill at all.

### `soak:` block (property-soak-permission-source-of-truth)

```yaml
soak:
  state: present
  denoArgs: ["--allow-read", "--allow-write", "--allow-env=FC_NUM_RUNS"]
```

OPTIONAL — same present/na/backlog envelope as `watch:`/`canary:`, and (like
them) exempt from allowlist gating. The single source of truth for what a
`test` task's permission authority means, and for what counts as a legitimate
NARROWING of it, is
[`scripts/lib/soak_permissions.ts`](scripts/lib/soak_permissions.ts),
enforced at PR time by `scripts/quality/check_soak.ts`
(`deno task quality:soak`).

**The extension's own `deno.json` `test` task IS the default source of
authority** — `scripts/soak_schedule.ts` derives the nightly soak's argv
directly from it for every extension with no `soak:` block at all. A `soak:`
override is a RARE, human-reviewed exception, needed only when the test
task's authority is BROAD — exactly `--allow-all`, an unscoped `--allow-run`,
or an unscoped `--allow-net` (nothing else; see `isBroadGrant`) — because an
unattended nightly soak must never silently inherit that. Today only three
extensions qualify: `swamp-go-brr`, `stripe-mpp`, `jscad-cad`.

`present` carries `denoArgs`, not `files[]` — the exact deno permission flags
`run_soak.ts` should run the property soak with. `check_soak.ts` verifies it
NEVER exceeds the test task's own authority (an allow flag the test task
doesn't grant, a scope wider than the test task's, or a `--deny-X` guard
dropped/narrowed vs. the test task's) and always adequately covers
`FC_NUM_RUNS` via `--allow-env`. `backlog` cites its OWN tracking issue,
`ext-quality-release-watch-soak` (Phase B) — not Phase D's
`ext-quality-test-backfill` — since authoring a narrowed override is Phase
B's work, not the five-suite backfill's.

### `ratchet:` block

```yaml
ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" }
```

Records the extension's `swamp extension quality manifest.yaml --json` score at
the time this file was last authored/updated. `score_ratchet.ts` re-scores the
extension live in CI and compares:

- **Same `rubricVersion`, current ≥ baseline** → pass.
- **Same `rubricVersion`, current < baseline** → fail (a real regression).
- **`rubricVersion` differs** → `rebaseline` (informational, never a CI failure)
  — the registry's rubric changed what the percentage even means, so comparing
  across versions would be a repo-wide false red the day the rubric bumps.
  Whoever bumps the rubric is expected to re-run the score gate and update every
  `ratchet.rubricVersion`/`baselinePercentage` deliberately.

## Worked example: a fully compliant `quality.yaml`

```yaml
schemaVersion: 1
extension: stripe-mpp
tests:
  contract-fixture: {
    state: present,
    files: ["extensions/models/stripe_mpp_test.ts"],
  }
  methods: {
    state: present,
    files: ["extensions/models/stripe_mpp_methods_test.ts"],
  }
  adversarial: {
    state: present,
    files: ["extensions/models/stripe_mpp_adversarial_test.ts"],
  }
  coverage: {
    state: present,
    files: ["extensions/models/stripe_mpp_coverage_test.ts"],
  }
  property-invariant-flow:
    state: present
    files:
      - "extensions/models/stripe_mpp_property_test.ts"
      - "extensions/models/stripe_mpp_invariant_property_test.ts"
      - "extensions/models/stripe_mpp_flow_property_test.ts"
watch:
  state: backlog
  justification: "no generalized release-watch yet — tracked in ext-quality-test-backfill"
canary:
  state: na
  justification: "seller settlement requires real Stripe test-mode keys not available in CI"
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: present, files: ["CHANGELOG.md"] }
  skill: { state: present, files: [".claude/skills/stripe-mpp/SKILL.md"] }
ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" }
```

## Worked example: a compliance failure and its fix

Given this (invalid) entry:

```yaml
tests:
  methods: {
    state: present,
    files: ["extensions/models/widget_methods_test.ts"],
  }
```

...where `widget_methods_test.ts` was never actually created, running the
compliance check locally produces:

```
$ deno run --allow-read scripts/quality/check_compliance.ts widget
widget: [tests.methods-file-missing] tests.methods declares "extensions/models/widget_methods_test.ts" but it does not exist
  WHY: a suite/doc marked "present" must be backed by a real file so the standard cannot be gamed by declaring files that were never written
  FIX: create extensions/models/widget_methods_test.ts, or change tests.methods's state to "na"/"backlog" with a justification

1 violation(s) across 1 extension(s).
```

The remedy is exactly what the FIX line says: either write the file, or honestly
mark the suite `na`/`backlog` with a justification. Re-running the same command
after either fix exits 0.

## Why the compliance job runs GLOBAL, not diff-scoped

`.github/workflows/ci.yml`'s `discover` job scopes the `deno-check` matrix to
only the extensions a given PR touched (a performance optimization for the
per-extension fmt/lint/check/test matrix). The compliance job deliberately does
**not** use that scoping: it runs `check_compliance.ts`, `check_allowlist.ts`,
and `score_ratchet.ts` across **every** extension on **every** PR and push. A
shared-file-only change (or an extension rename) that happened to fall outside
the diff-scoped matrix must never silently bypass per-extension enforcement —
the whole point of a compliance gate is that it cannot be dodged by touching the
"wrong" file.

## Seeding the baseline

Only `stripe-mpp` carries all five suites today. Every other extension is, by
definition, an "offender" (missing ≥1 required suite) the day this gate lands.
`quality-offenders.baseline.txt` is the write-once seed of that set;
`quality-allowlist.txt` starts identical to it and may only **shrink** as Phase
D backfills each extension to full compliance. This is intentional: day-one
enforcement is "no regression + no new offenders", not "everyone green" — see
`check_allowlist.ts` for the shrink-only guard mechanics (subset-of-baseline
check, plus a merge-base diff so the baseline itself cannot be edited to grow).

## Running the compliance check locally

The exact commands CI runs (from the repo root):

```bash
cd scripts
deno task quality:check              # check_compliance.ts, every extension
deno task quality:check -- widget    # scope to one extension
deno task quality:allowlist          # check_allowlist.ts
deno task quality:ratchet            # score_ratchet.ts (shells out to swamp)
deno task quality:harness            # check_property_harness.ts
deno task quality:soak               # check_soak.ts (property-soak permissions)
deno task test                       # the validators' own unit tests
```

Every script also answers `--help` with its usage and exit-code contract.

## Scaffolding a new extension's quality.yaml

```bash
deno run --allow-read --allow-write scripts/quality/scaffold.ts <extension-name>
```

Generates a `quality.yaml` if one doesn't already exist (detecting suite files
by role keyword in their filename), defaulting any undetected suite to
`backlog`. **Never overwrites an existing file** — safe to re-run against every
extension; already-authored files (and their justifications) come back
unchanged.

## CI reporting

The compliance job's summary folds into the sticky PR comment alongside the
`tessl` and `promptfoo` reports, under a distinct `ci-report:compliance` marker
(see `scripts/build-ci-report.ts`).

## Registry quality score

`swamp extension quality <manifest> --json` runs entirely offline/local — no
`SWAMP_API_KEY` or `~/.config/swamp/auth.json` needed — which is why the
compliance job never wires in the publish-scoped credential the
`extension-publish` job uses. A smoke-check in the compliance job asserts this
stays true (no swamp auth file or `SWAMP_API_KEY` present in the job env) as a
regression guard.
