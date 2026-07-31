# Changelog

## 2026.08.01.1

Closes the HIGH remote-shell command-injection finding (bug #1) tracked in the
local `cadvisor-latent-bugs` @magistr/issue-lifecycle model — not filed to the
swamp.club Lab, per CLAUDE.md's Anti-Bypass rule; Lab is `@swamp/*` product
only.

- **Remote-shell command injection (HIGH), closed** — `runSsh()` hands its built
  command string to the REMOTE shell verbatim, and `vmComposeDir`,
  `vmScrapeConfig`, and `vmComposeFile` (admin-configured `globalArguments`)
  were interpolated unescaped into that string at every `cat`/heredoc-append/
  `cd && docker compose`/`sed -i` site in `deploy`, `status`, and `remove`. A
  canonical `shellEsc` helper (copied verbatim from `firecracker`/
  `fc-task-server`: single-quote-wrap, `'` -> `'\''`) is now applied to all
  three values at every remote-command interpolation site. Defense-in-depth, not
  an externally-exploitable hole: these three values are read only from
  `context.globalArgs` (`GlobalArgsSchema`) and every method that uses them
  takes no per-invocation caller arguments, so this closes a hostile-admin or
  misconfiguration vector, not an external attack surface. The
  `${username}@${host}` ssh-destination argv element was already safe (one local
  `Deno.Command` argv slot, never remote-shell-interpreted) and is unchanged.
  The `deploy` heredoc BODY (file data, not a shell token) is deliberately left
  unescaped — only the heredoc TARGET path is wrapped. Behavior-preserving for
  legitimate metacharacter-free paths.
- The four adversarial Site-2 characterization tests, the methods-suite
  `deploy`/`remove` exact-command assertions, and every `cat`-equality stub
  matcher are re-baselined to the single-quote-wrapped expected strings.
  Coverage, property-invariant-flow, and contract-fixture suites use
  `startsWith`/`includes` matchers on metacharacter-free arguments and stay
  green unchanged, demonstrating behavior preservation.
- Model `version` and `manifest.yaml` bumped `2026.07.16.2` -> `2026.08.01.1`
  (in sync). The six remaining sibling latent bugs (fragile `sed` range-delete,
  unnormalized `cpuPercent`, empty-aliases name collapse, unclamped
  counter-reset deltas, README `typeVersion` drift, hardcoded VM port) remain
  deferred and pinned in `cadvisor-latent-bugs`, unchanged.

This release also carries the wave-2c five-suite test backfill
(`ext-quality-test-backfill`) that established the characterization suites the
hardening above re-baselines:

- Added `extensions/models/cadvisor_test.ts` (contract-fixture),
  `cadvisor_methods_test.ts` (methods), `cadvisor_adversarial_test.ts`
  (adversarial), `cadvisor_coverage_test.ts` (coverage),
  `cadvisor_property_test.ts` (property-invariant-flow) — 0 tests before this
  change, 64 after. `cadvisor.ts` is a DUAL-boundary model (SSH via
  `Deno.Command("ssh")` and HTTP via `fetch`), so every suite stubs both: the
  `talos-node` `Deno as unknown as Record<string, unknown>` FakeCommand bridge
  for the SSH side, and the `porkbun` fetch-stub pattern for the HTTP side.
  `deploy`'s 5-second verify `setTimeout` is neutralized (`withSyncSetTimeout`,
  the `talos-node` pattern) so the suite runs synchronously.
- Test-review round 1 (autonomous, 0 CRIT + 1 HIGH) added: a `remove()`
  error-path test — none of its three SSH calls are guarded by try/catch, so a
  mid-teardown failure throws and leaves NO status resource written at all (the
  HIGH finding, since the methods suite otherwise only covered `remove()`'s
  happy path); two `status()` mixed-success/failure tests (its two SSH calls are
  independently try/caught); and the deploy idempotency property now also
  asserts on the written `status` resource's `running`/`scrapeConfigured`
  fields, not just internal SSH call counts (the MEDIUM finding).
- Added `fixtures/` — pure doc-derived, synthetic cAdvisor `/api/v1.3/docker`
  and VictoriaMetrics `/api/v1/query_range` wire-shape fixtures
  (`cadvisor-docker.json`, `vm-query-range.json`) plus a prometheus
  scrape-config before/after text pair (`scrape-config-before.txt`,
  `scrape-config-after.txt`) and `PROVENANCE.md`. No live call was made against
  any real cAdvisor/VictoriaMetrics instance over either boundary (HTTP metrics
  or SSH config/docker-inspect); every value is synthetic (RFC 2606
  `host.example.com`, synthetic 64-hex-char container paths, the real published
  cAdvisor "no memory limit" sentinel constant used only as a documented value,
  never a live measurement).
- The contract-fixture suite pins the RAW cAdvisor/VictoriaMetrics INPUT wire
  keyset + types (not a written-resource-equals-fixture passthrough, unlike
  `porkbun` — `cadvisor.ts` transforms bytes to MB/percent/rates, so the
  transform itself is pinned in the methods and coverage suites instead).
- The adversarial suite separates cadvisor.ts's TWO SSH interpolation sites: the
  `${username}@${host}` ssh-destination argv element (one local Deno.Command
  argv slot, not shell-interpretable) versus `vmComposeDir` / `vmScrapeConfig` /
  `vmComposeFile`, which (at the time of the backfill) landed UNESCAPED inside
  the command string ssh hands to the REMOTE shell — closed above via `shellEsc`
  in this same release. Also pins `remove()`'s unconditional, non-idempotent
  teardown (no existence check; identical commands issued on every call).
- 7 latent bugs found while characterizing `cadvisor.ts` were tracked in the
  LOCAL `cadvisor-latent-bugs` issue-lifecycle model (never the Lab) — the
  remote-shell command injection (now CLOSED above), the fragile `sed`
  range-delete in `remove()`, `cpuPercent` not being per-core-normalized
  (`_numCores` is computed but unused), empty (but present) `aliases` arrays
  collapsing the container name to the literal `"unknown"` instead of falling
  back to the cgroup path, unclamped counter-reset deltas going negative, a
  `README.md` `typeVersion` doc-drift, and `top-memory` hardcoding the
  VictoriaMetrics port instead of exposing it as a global argument. The
  remaining 6 are still PINNED by the suites, deliberately not fixed here.
- `deno.json`: default `test` task stays network-less and run-less
  (`--allow-env=FC_NUM_RUNS --allow-read=extensions,fixtures` — no
  `--allow-net`, no `--allow-run`; `--allow-read` is scoped narrowly to read the
  two committed scrape-config text fixtures, mirroring the `pihole` precedent).
  Added `test:soak` for the high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (cadvisor bundles
  no Claude skill); `ratchet` set to the measured score from
  `swamp extension quality manifest.yaml --json` (100%, Grade A). `watch`/
  `canary` stay `backlog` (allowlist-exempt per STANDARD.md). Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: deploy a cAdvisor container over SSH and wire it in as a
VictoriaMetrics scrape target (`deploy`), report deployment + scrape-config
status (`status`), read live per-container memory/CPU/network metrics straight
from the cAdvisor API (`current-metrics`), rank the biggest and fastest-growing
memory consumers over a lookback window via a VictoriaMetrics range query
(`top-memory`), and tear the container and scrape config back down (`remove`).
