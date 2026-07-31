# Changelog

## Unreleased

Test + docs backfill to the STANDARD.md five-suite quality bar
(`ext-quality-bf-anilist-chart`, wave-4 batch-4d, the FINAL batch of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `anilist_chart.ts` and every `lib/*.ts` file are byte-frozen; the model
`version` stays `2026.07.21.1`; `manifest.yaml` is unchanged.

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
  `anilist_chart.ts` itself is byte-frozen, so the registry's `symbols-docs`
  JSDoc-coverage point could not be earned this way; see the ratchet note
  below).
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
  STANDARD.md, tracked in `ext-quality-test-backfill`). Measured ratchet: **92%
  (13/14, rubricVersion 3)** — see the quality.yaml `ratchet` block for the full
  honest label. This is NOT Grade A: the remaining point (`symbols-docs`, JSDoc
  coverage ≥80% on the byte-frozen `anilist_chart.ts` entrypoint, currently
  ~50%) is unreachable without editing frozen source, which this change
  deliberately does not do.
- Removed `anilist-chart` from the repo-root `quality-allowlist.txt`
  (shrink-only gate) — done LAST, after all five suites were confirmed present.
