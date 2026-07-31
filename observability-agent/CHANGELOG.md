# Changelog

## 2026.08.01.1

Fixes two HIGH remote-RCE bugs closed as `observability-agent-rce` (LOCAL
`@magistr/issue-lifecycle` bug model — never the Lab, per this repo's tracking
convention). `observability_agent.ts` is no longer byte-frozen; the model
`version` moves from `2026.07.02.3` to `2026.08.01.1`.

- **Fixed (HIGH)** — `vectorVersion` was interpolated unescaped into `install`'s
  double-quoted curl URL, allowing remote code execution as whatever user SSH
  logs in as (root by default). Closed with a semver allowlist regex
  (`^\d+\.\d+\.\d+$`) on `vectorVersion` in `GlobalArgsSchema`, validated before
  its `.default("0.46.1")`.
- **Fixed (HIGH)** — `bindAddress` was interpolated unescaped into `status`'s
  two curl metrics URLs, making the nominally read-only `status` method also a
  remote code-execution vector. Closed with a host allowlist regex
  (`^[A-Za-z0-9.-]{1,253}$`) on `bindAddress` in `GlobalArgsSchema`, validated
  before its `.default("0.0.0.0")`. `nodePort`/`blackboxPort` were already
  `z.number().int()` and therefore never reachable.
- **Fixed (MEDIUM, folded in for free)** — the bindAddress-newline config
  injection (a hostile `bindAddress` containing `\n` could inject a second
  `ARGS=` line into the node_exporter/blackbox defaults files) is closed by the
  same strict `bindAddress` regex above, since it also rejects newlines.
- Added the repo-canonical `shellEsc` single-quote-wrap helper (copied verbatim
  from `firecracker/extensions/models/firecracker.ts`) and wrapped the two
  remaining curl interpolation sites — `install`'s vector `.deb` URL and
  `status`'s two metrics URLs — as defense-in-depth on top of the allowlist
  regexes.
- Both fixes are behavior-preserving for every legit value: the existing
  defaults (`0.46.1`, `0.0.0.0`) already satisfy their new regex, and
  `install`/`status` still build the identical curl URLs for valid input (now
  additionally single-quoted).
- **Still open** (deferred, different fields/fix paths — tracked in
  `observability-agent-rce`): MEDIUM `bindWaitUnit` systemd-directive injection
  (#3); MEDIUM `hostLabel`/`logFiles`/`logsEndpoint` VRL/YAML config injection
  (#4b-d); LOW `btoa()` non-Latin1 crash (#5); LOW `inventory` doc drift (#6);
  LOW `sshUser`/`sshHost` ssh-argv option-injection note.
- `observability_agent_adversarial_test.ts`: flipped the two HIGH
  characterization pins (vectorVersion, bindAddress) and the MEDIUM
  bindAddress-newline pin to assert `globalArguments.parse` now REJECTS the
  hostile payloads, added positive-acceptance tests for legit `vectorVersion`
  (0.46.1, 0.47.0) and `bindAddress` (0.0.0.0, 192.0.2.10, a hostname), and
  repointed the safe write-target-path test to a benign `bindAddress` (keeping
  the still-unvalidated `hostLabel`/`logsEndpoint`/ `bindWaitUnit` fields
  hostile, preserving that test's intent). All five suites green: 56 tests,
  property suite green at `FC_NUM_RUNS=5000`.

## Test backfill (folded into 2026.08.01.1 above)

Test backfill to the STANDARD.md five-suite quality bar (wave 2c, full build of
the extension-quality backfill program, `ext-quality-test-backfill`), prior to
the fix above.

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
- Pinned several found bugs, characterized rather than fixed at the time (source
  frozen). Filed as a LOCAL `@magistr/issue-lifecycle` bug model,
  `observability-agent-rce` — never the Lab. Two HIGH + one MEDIUM of these are
  now fixed above; see that entry.
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
