# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave 2c, full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `observability_agent.ts` is byte-frozen and the model
`version` stays `2026.07.02.3`.

- Added `extensions/models/observability_agent_test.ts` (contract-fixture),
  `observability_agent_methods_test.ts` (methods),
  `observability_agent_adversarial_test.ts` (adversarial),
  `observability_agent_coverage_test.ts` (coverage), and
  `observability_agent_property_test.ts` (property-invariant-flow) — 0 tests
  before this change, 54 after.
- Added `fixtures/` — pure doc/source-derived, synthetic
  `{success, stdout, stderr}` envelopes (`install`, `configure`,
  `configure-novector`, `status`, `inventory`, `error`) plus `PROVENANCE.md`. No
  live call was made against any real `@magistr/observability/agent` instance in
  this homelab; every hostname/IP is synthetic (`host.example`, RFC 5737
  `192.0.2.x`/`198.51.100.x`/`203.0.113.x`).
- Every suite drives `model.methods.<m>.execute()` (and, in the contract-fixture
  suite, `model.resources.<spec>.schema`) against the talm-cluster DUAL-SHAPE
  `Deno.Command` stub (`spawn()` -> `stdin.getWriter()` -> `write`/`close` ->
  `output()`, AND a direct `output()`), reassigned via the
  `(Deno as unknown as { Command: unknown })` bridge and restored in `finally` —
  never a direct `as typeof Deno.Command` cast. The stub CAPTURES the piped
  stdin script, because the real behavior/attack surface here is the generated
  REMOTE bash script, not the local `ssh` argv.
- Pins several found bugs, characterized rather than fixed (source frozen).
  Filed as a LOCAL `@magistr/issue-lifecycle` bug model,
  `observability-agent-rce` — never the Lab:
  1. **HIGH** — `vectorVersion` is interpolated unescaped into `install`'s
     double-quoted curl URL -> remote code execution as whatever user SSH logs
     in as (root by default).
  2. **HIGH** — `bindAddress` is interpolated unescaped into `status`'s curl
     URLs -> the nominally read-only `status` method is also a remote
     code-execution vector. `nodePort`/`blackboxPort` are `z.number().int()` and
     therefore NOT reachable — only the string-typed `bindAddress`/
     `vectorVersion` fields are.
  3. **MEDIUM** — `bindWaitUnit` newlines survive base64 verbatim into
     `10-boot.conf` -> arbitrary systemd `[Unit]`/`[Service]` directive
     injection.
  4. **MEDIUM** — `bindAddress`/`hostLabel`/`logsEndpoint`/`logFiles` each
     independently corrupt exporter flags / the VRL remap transform / the Vector
     YAML (extra `include:` entries, a second sink `endpoint`) — never escapes
     to a shell (config-integrity injection, not code-exec).
  5. **LOW** — `btoa()` throws an unhandled `DOMException` on non-Latin1 config
     content (`writeRemoteFile`) instead of a clean validation error.
  6. **LOW** — the `inventory` method is undocumented in both README.md and
     manifest.yaml (both list only install/configure/status).
- `deno.json`: default `test` task is network-less AND run-less
  (`--allow-env=FC_NUM_RUNS` only, no `--allow-run`/`--allow-net`/
  `--allow-read`) — a mis-stubbed test that constructs a real
  `Deno.Command("ssh")` fails `PermissionDenied` instead of SSHing a real host
  and running the destructive `install`/`configure`. Added `test:soak` for the
  high-count nightly property soak (`FC_NUM_RUNS=10000`).
- `deno.lock`: regenerated for the new dev-only test deps (`jsr:@std/assert@1`,
  `npm:fast-check@4.8.0`); the bundler inlines npm deps at bundle time, so the
  lockfile only covers local `deno test`/`deno
  check`, never the published
  extension bundle.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na`
  (observability-agent bundles no Claude skill). Ratchet recorded HONESTLY at
  the measured live score — 85% (12/14, rubricVersion 3) — not baseline 0. The
  registry CLI (`swamp extension quality manifest.yaml
  --json`) prints that
  score to stdout but exits 1 because of Lab #1481 (two doc-factor gaps,
  `rich-readme` + `symbols-docs`, both out of scope for this test-only
  backfill); `scripts/quality/score_ratchet.ts`'s `readScoreViaSwamp` throws on
  that non-zero exit, so `deno task quality:ratchet` reports observability-agent
  **skipped**, not failed — CI stays green. Removed from `quality-allowlist.txt`
  in the same change (all five suites + both non-`na` docs items are `present`,
  so allowlist membership is no longer warranted per STANDARD.md's
  backlog-eligibility-equals-allowlist-membership rule).

## 2026.07.02.3

Initial release: `install` (apt-installs node-exporter + blackbox-exporter,
installs vector from a pinned `.deb`), `configure` (writes exporter/blackbox/
vector configs bound to `bindAddress`, grants blackbox `CAP_NET_RAW`, enables +
restarts services), and `status` (systemd + listener health) over SSH.
