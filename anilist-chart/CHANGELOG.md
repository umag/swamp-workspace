# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Real-fix (not byte-frozen) for all 7 latent bugs tracked in the LOCAL
`anilist-chart-latent-bugs` issue-lifecycle model (3 MED, 4 LOW; 0 CRITICAL/HIGH
— see the `2026.08.01.1` entry below for the original per-bug writeup, written
when all 7 were accepted-but-unfixed). `model.version` / `manifest.yaml` bump
`2026.08.01.1` -> `2026.08.02.1`, with a single `upgrades[]` entry
(`upgradeAttributes: (old) => old` — the two new global args are DEFAULTED, so
an old attribute record lacking both keys still reads identically once the zod
defaults apply).

- **LB1 (MED)** The 11 ClickHouse reads (board, chartScores, distinctIds,
  chartMeta, six landing aggregates) plus the freshness read ran with no
  try/catch, so any read throw escaped `execute()` with NO diagnostic marker
  left behind. They are now wrapped in one try/catch: on any throw, a
  `renderRun` marker is written (`ok:false`,
  `refuseReason: "read failed: <message>"`, `anomalies: [<message>]`) THEN the
  error is re-thrown (write-then-rethrow — the same fail-loud shape as
  `publish()`'s existing guard), so the workflow step still fails AND the marker
  now exists for `swamp report get` / `swamp data get` to inspect.
- **LB2 (MED)** The ssh publish `Deno.Command` spawn carried no
  `AbortSignal`/timeout, so a hung ssh connection blocked `publish()` forever. A
  new DEFAULTED global arg `sshTimeoutMs` (default 30000) now bounds the whole
  spawn/write/output round-trip via `AbortController` + `setTimeout` +
  `clearTimeout` (NOT `AbortSignal.timeout`, so a fast success cancels the
  pending timer instead of leaving it to fire after the fact). On abort the
  child is killed, `output()` rejects, and the existing per-page try/catch in
  `publishPages` marks just that page failed — the rest still publish.
- **LB3 (MED)** `ClickHouseClient.query()` buffered the entire response body via
  `res.text()` with no cap. It now streams the body through
  `res.body.getReader()`, counting bytes as chunks accumulate, and throws
  `ClickHouse response exceeds N bytes` the moment the running total passes the
  cap — freeing the partial buffer early rather than fully buffering an
  unbounded/misbehaving upstream first. The cap comes from a new DEFAULTED
  global arg `clickhouseMaxResponseBytes` (default 67108864 = 64MiB), threaded
  through `configFrom` into `ClickHouseConfig.maxResponseBytes`; a body under
  the cap still returns every row (a ceiling, not a silent truncator).
- **LB4 (LOW)** A malformed freshness timestamp (`Date.parse` -> `NaN`) coerced
  `newestDataAgeMs` to `null`, which silently disabled the staleness anomaly
  (`evaluateFreshness` only fires staleness when `newestDataAgeMs !== null`).
  `render()` now distinguishes "raw present but unparseable" from "genuinely
  absent" and passes a new optional `newestTimestampMalformed` flag into
  `FreshnessInput`; when true, `evaluateFreshness` pushes an explicit
  unparseable-timestamp anomaly (staleness check skipped). Still `ok:true`,
  still no false "publishing last-known-good" — the gap is now SIGNALLED, not
  silent.
- **LB5 (LOW)** A non-numeric `media_id` from `distinctMediaIdsQuery` became
  `NaN`, which `arrayIntParam` truncated to the literal string `"NaN"` — an
  invalid `Array(Int64)` wire value that a real ClickHouse rejects, aborting the
  whole render. `render()` now filters `ids` through `.filter(Number.isFinite)`
  before ever building the array param, so a corrupt id is skipped, never sent
  (empty `ids` still routes through the existing `[]` branch). `arrayIntParam`
  also now throws loud on a non-finite input as defense-in-depth, so the
  poisoned literal can never be constructed even by a future caller — though
  filtering means that throw never fires in practice.
- **LB6 (LOW)** A ClickHouse error response's body was echoed verbatim (up to
  500 chars, including newlines) into the thrown error. The body is now trimmed
  to 200 chars, whitespace runs collapsed to a single space, and defensively
  `.replaceAll`'d for the configured key (belt-and-braces — a CH error body
  never legitimately contains it). Still no credential leak in any thrown error
  or written resource; confirmed by a new pure adversarial test that stubs a
  body literally containing a sentinel "key" and asserts it comes back
  `[redacted]`.
- **LB7 (LOW)** `arrayStringParam`'s hand-rolled escaping left an embedded NUL
  byte completely unescaped. A third `.replace()` pass now encodes it as the
  two-character `\0` escape, running AFTER the backslash-doubling and quote
  passes (order matters: the new escape's own backslash must not be doubled by
  an earlier pass). Encode, not reject — this is a URL query-param value, not
  raw SQL text, matching LB5's "don't abort the render" philosophy.

**Two DEFAULTED global args** (`sshTimeoutMs`, `clickhouseMaxResponseBytes`) are
the only `globalArguments` change, so the appended `upgrades[]` entry is a
correct identity `upgradeAttributes: (old) => old`.

**Byte-stability**: the contract-fixture suite (`anilist_chart.test.ts` plus
every `lib/*.test.ts` oracle-parity file), the property-invariant-flow suite,
and the live ClickHouse column-parity suite are UNCHANGED. Only the pinned
characterization of each fixed bug flips from "pins the bug" to "pins the fix":
in `anilist_chart_methods_test.ts` the LB1, LB4, and LB6 tests; in
`anilist_chart_adversarial_test.ts` the LB2, LB3, LB5, and LB7 tests, plus its
malformed-JSONEachRow and 200-status-inline-exception tests (which now also
assert the LB1 marker survives); and one new unit added to
`lib/render_run.test.ts` (LB4's `newestTimestampMalformed` branch, additive —
the 6 pre-existing freshness tests are untouched). The methods happy path (11
reads, 7 artifacts, `ok:true`, empty refused/failed) and the publish suite are
byte-identical.

`quality.yaml` re-stamped from a real
`swamp extension quality manifest.yaml --json` measurement; all five suites stay
`present`, Grade A. `README.md`'s "Known latent bugs" section is replaced with a
"Fixed in 2026.08.02.1" note.

## 2026.08.01.1

Docs-only completion of the quality ratchet: added real JSDoc to the two
exported symbols of `extensions/models/anilist_chart.ts` that the wave-4
backfill below left undocumented — the `RenderTaskBundle` interface and the
`model` const — raising `symbols-docs` coverage from 50% (2/4) to 100% (4/4) and
earning the last rubric point. This is the first version bump since the backfill
below (which never bumped the version): `model.version` and `manifest.yaml` move
from `2026.07.21.1` to `2026.08.01.1`. No runtime behavior changed and no tests
were added or flipped — the five existing suites (`contract-fixture`, `methods`,
`adversarial`, `coverage`, `property-invariant-flow`) stay green unchanged.
Ratchet: **100% (14/14, rubricVersion 3) — Grade A**, up from 92% (13/14).

Everything below this point is the prior wave-4 backfill entry, retained as-is
except for the two bullets whose "byte-frozen"/"unreachable" claims about
`symbols-docs` are now superseded by the entry above.

Test + docs backfill to the STANDARD.md five-suite quality bar
(`ext-quality-bf-anilist-chart`, wave-4 batch-4d, the FINAL batch of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `anilist_chart.ts` and every `lib/*.ts` file were byte-frozen at the
time; the model `version` stayed `2026.07.21.1`; `manifest.yaml` was unchanged.

- Re-assigned the 16 pre-existing test files (all dumped under
  `contract-fixture` by the scaffolder) to their HONEST primary role: 12 stay
  `contract-fixture` (external-oracle/byte/schema/render-parity pins:
  `lib/bayesian.test.ts`, `lib/age_penalty.test.ts`, `lib/format.test.ts`,
  `lib/chart_rank.test.ts`, `lib/awards.test.ts`, `lib/pairs.test.ts`,
  `lib/render_board.test.ts`, `lib/render_charts.test.ts`,
  `lib/render_landing.test.ts`, `lib/css_parity.test.ts`,
  `lib/clickhouse.test.ts`, `anilist_chart.test.ts`); 4 move to `coverage`
  (port-invented internal guard/gate/fault-isolation branches with no external
  oracle: `lib/rankable.test.ts`, `lib/render_run.test.ts`,
  `lib/publish.test.ts`, `lib/publish_gate.test.ts`). No file was moved or
  renamed — only the `quality.yaml` role label changed.
- Added `extensions/models/anilist_chart_methods_test.ts` (`methods` gap, new,
  21 tests) — drives `model.methods.settings/render/publish.execute()` against a
  stubbed `globalThis.fetch` (the single ClickHouse HTTP seam) and a fake
  context, with `FakeTime` for deterministic timestamps. `publish` is exercised
  via the LOCAL `Deno.makeTempDir` filesystem path (atomic temp+rename verified
  on disk); the ssh `Deno.Command` branch is deliberately NOT stubbed (the
  Deno-skew rule forbids an `as typeof Deno.Command` cast) — its fault semantics
  are already covered by `lib/publish.test.ts`'s injected-writer unit, which is
  agnostic to which writer is plugged in.
- Added `extensions/models/anilist_chart_adversarial_test.ts` (`adversarial`
  gap, new, 15 tests) — hostile ClickHouse HTTP responses (non-200, malformed
  JSONEachRow, a 200-status inline exception body), HTML/CSS injection payloads
  driven through `execute()` (proving the render pipeline's `esc()` escaping
  defends the output end-to-end, including the publish_gate backstop),
  SQL-injection defenses (`assertIdent`, the `ClickHouseClient` constructor),
  and a credential-leak sweep. Also PINS the two latent bugs that resist
  stubbing through the model boundary (LB2: no ssh timeout, via a source-text
  scan for `AbortSignal`; LB7: `arrayStringParam`'s hand-rolled escaping, via
  direct pure-function tests) plus an end-to-end characterization of LB5 (a
  non-numeric `media_id` reaching ClickHouse as the literal `[NaN]` array
  parameter).
- Added `extensions/models/anilist_chart_property_test.ts`
  (`property-invariant-flow` gap, new, 15 properties) — `npm:fast-check@4.8.0`
  (pinned exact version), `FC_NUM_RUNS`-gated (default 200, verified green at
  `FC_NUM_RUNS=5000` before this suite was committed). Covers `bayesianRating`'s
  convex-combination bounds + R-monotonicity + boundary cases,
  `globalAverageC`'s population-mean bounds, `rankGenre`'s sortedness +
  permutation-preservation + non-mutation + determinism, `buildFinalChartData`'s
  topK-slot-count + global cross-genre dedup + soundness, `agePenaltyFactor`'s
  future/null gate + year-monotonicity, `esc`'s round-trip-inverse +
  no-bare-metacharacter invariant, and one end-to-end
  `buildRenderTasks -> runFanOut` FLOW property over randomized-but-valid inputs
  (fixed 3-user/4-title shape, only the numeric fields vary, to avoid the
  array-size/title-collision flakiness a fully unrestricted arbitrary would
  introduce over this domain).
- Recorded 7 accepted LOW/MEDIUM latent bugs (0 CRITICAL/HIGH) in the LOCAL
  `anilist-chart-latent-bugs` issue-lifecycle model — never the swamp.club Lab
  (this is a `@magistr/*` extension bug, not a swamp-product issue):
  1. **LB1 (MED)** a read-phase ClickHouse failure aborts `render()` entirely
     with no diagnostic marker left behind (no `renderRun` resource is written
     when a mid-flight read throws).
  2. **LB2 (MED)** the ssh publish `Deno.Command` spawn carries no
     `AbortSignal`/timeout — a hung ssh connection blocks `publish()` forever
     (contrast with the ClickHouse fetch, which IS bounded by
     `AbortSignal.timeout(30_000)`).
  3. **LB3 (MED)** `ClickHouseClient.query()` buffers the entire response and
     enforces no row cap — an unbounded/misbehaving upstream can exhaust memory.
  4. **LB4 (LOW)** a malformed freshness timestamp is coerced to `null` and
     silently disables the staleness anomaly — no crash, but also no signal,
     even if the corpus really is stale.
  5. **LB5 (LOW)** a non-numeric `media_id` from `distinctMediaIdsQuery` becomes
     `NaN`, which `arrayIntParam` truncates to the literal string `"NaN"`,
     producing an invalid `Array(Int64)` wire value that a real ClickHouse
     rejects — aborting the whole render.
  6. **LB6 (LOW)** a ClickHouse error response's body is echoed verbatim (up to
     500 chars) into the thrown error message. Confirmed this is NOT a
     credential leak — the configured `X-ClickHouse-Key` never appears in any
     thrown error or written resource.
  7. **LB7 (LOW)** `arrayStringParam`'s hand-rolled string escaping (manual
     backslash/quote replacement, not a vetted quoting library) — pinned exact
     behavior on adversarial inputs, including an embedded NUL byte that passes
     through completely unescaped.

  All defended-negative behavior was also PINNED as a positive characterization:
  HTML/CSS injection is escaped via `esc()` everywhere (including the
  `publish_gate` backstop), SQL injection is blocked by parameter binding plus
  the `IDENT_RE` identifier allowlist, and divide-by-zero/NaN paths fail loud
  via `assertFinite`/`fx2` rather than leaking a broken cell into a page.
- Expanded `README.md` with an architecture/data-flow section, the seam map, and
  a latent-bugs summary (a documentation-only change — the entrypoint
  `anilist_chart.ts` itself was byte-frozen at the time, so the registry's
  `symbols-docs` JSDoc-coverage point could not be earned this way; that point
  was earned later, in `2026.08.01.1` above).
- `deno.json`: the default `test` task now grants
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (previously flagless) —
  needed for the `methods` suite's real `Deno.makeTempDir` local-publish path
  and the property suite's `FC_NUM_RUNS` knob. `test:css` and `test:live` are
  unchanged (still separately scoped, still excluded from the default `test`
  task). Added `test:soak` (`FC_NUM_RUNS=10000 deno task test:soak`) for a
  high-count nightly property run.
- `quality.yaml`: all five required suites now `present`; `docs.readme` /
  `docs.changelog` `present`; `docs.skill` stays `na` ("anilist-chart bundles no
  Claude skill — a chart-rendering/publish pipeline, nothing to document as a
  skill"); `watch`/`canary` stay `backlog` (exempt from the allowlist gate per
  STANDARD.md, tracked in `ext-quality-test-backfill`). Measured ratchet at the
  time: **92% (13/14, rubricVersion 3)** — NOT Grade A, since the remaining
  point (`symbols-docs`, JSDoc coverage ≥80% on the then-byte-frozen
  `anilist_chart.ts` entrypoint, then ~50%) was unreachable without editing
  frozen source, which this change deliberately did not do. That point was
  earned in `2026.08.01.1` above, moving the ratchet to 100% (14/14) — Grade A.
- Removed `anilist-chart` from the repo-root `quality-allowlist.txt`
  (shrink-only gate) — done LAST, after all five suites were confirmed present.
