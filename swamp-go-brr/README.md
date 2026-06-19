# @magistr/swamp-go-brr

An autonomous, driver-free development loop. You hand it an intake and a
host-pinned test command; it decomposes the work into a dynamic DAG of tasks,
runs each task as a `claude --print` agent inside a throwaway Firecracker
microVM, applies only the returned diff behind an allowlist ACL, and merges a
task **only** when a deterministic, network-less container says the tests pass.
Nothing the agent writes ever runs on your host.

---

## Tutorial — your first autonomous run

> Goal: take a tiny intake from zero to a green, merged change. You need a `jj`
> repo, Docker, an SSH-reachable Firecracker host, and a Claude Code OAuth token
> in a vault. The agent drives this loop for you when you use the bundled
> `swamp-go-brr` skill — the commands below are what it runs.

```bash
# 0. Pre-flight: stand up the substrate ONCE (local OCI registry, digest-pin the
#    gate image, emit the run config). Skipping this is the #1 cause of a slow run.
swamp model method run pf pin_image --input ...
swamp model method run pf config    --input ...      # gate params + fabric_up inputs

# 1. Start the run (human-confirmed repoScope / verifyCommand / verifyInputs) and
#    seed the file-scoped task DAG. Warm the microVM pool once.
swamp model method run run start      --input intake="add a /health endpoint" --input config=...
swamp model method run run seed_tasks --input tasks=...
swamp model method run fab fabric_up  --input concurrency=8 ...

# 2. Loop until all-green (the skill does this for you):
swamp model method run run next --input owner=driver-1   # lease the next ready task
#    decision=leased? -> build_workorder -> fabric.submit/poll -> apply -> docker-verify -> report
#    decision=all-green? -> complete.   decision=stalled? -> hand to a human.

# 3. Finish.
swamp model method run run complete
```

When `next` reports `all-green`, every task passed its gate and the green
per-task changes have been rebased into one linear history. If it reports
`stalled` or a cap was hit, you get an enumerated list of options instead of an
infinite spin.

---

## How-to guides

### Capture per-leaf cost, tokens, and time

Submit leaves in JSON mode so Claude's usage rides back, then derive an OTLP
trace + metrics:

```bash
# leaves run `claude --print --output-format json`; needs @magistr/firecracker >= 2026.06.18.1
swamp model method run fab submit --input tasks='[{"prompt":"...","outputFormat":"json"}]'
# ... after the run drives report() with the leaf usage ...
swamp model method run run emit_otlp
swamp data get run traceOtlp   --json | jq -r .content.status        # ok | unavailable | empty | partial
swamp data get run metricsOtlp --json | jq   .content.resourceMetrics
```

`leaf.declared.*` attributes (tokens, cost) are what Claude self-reports;
`leaf.host.duration_ms` is what the loop measured. They are kept separate on
purpose — declared values are advisory and never gate anything.

### Ship the OTLP to a collector (Honeycomb, Tempo, an OTLP gateway…)

`gobrr` stays pure and never makes network calls; the `otlp-export` model is the
only egress. Wire the endpoint + token from a vault and push:

```bash
swamp model method run exporter export_run            # endpoint+token are global args (vault CEL)
swamp data get exporter exportStatus --json | jq -r .content.status   # ok | skipped | error
```

The resolved endpoint URL and token are never stored or logged (only a
userinfo/query-stripped host); a collector failure records `error` and never
aborts the run.

### Resume or inspect a halted run

```bash
swamp model method run run hydrate                    # compact status summary
swamp data get run summary --json | jq .content       # buckets, halt reason + options, stall culprits
```

### Tune concurrency

`maxConcurrentVMs` defaults to **8** (≈4 GiB on an 8 GiB Firecracker host;
leaves are I/O-bound on the model API). Raise it as RAM allows, and validate the
pool with a probe leaf after `fabric_up`. See `references/concurrency.md` in the
bundled skill for the netns + version-pin requirements.

---

## Reference — the models

| Model                | Owns                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`          | Phase-0 substrate (Docker only): ensure the local OCI registry, digest-pin the gate image, emit the run `config`.                                                                                                                                                                                                |
| `gobrr`              | The PURE Run/DAG state machine: scheduler (lease TTL/heartbeat/reap, concurrency gate, stall), follow-up expansion, run caps, and the derived projections (`hydrate`, `complete`, `emit_otlp`). Never touches the filesystem or network.                                                                         |
| `source-integration` | Host code-ownership: `build_workorder` (read the allowlist file slice into the leaf prompt, no-clone) and `apply` (parse the `@@EDIT` envelope, write each task as a per-task base-isolated `jj` change behind a realpath-anchored allowlist ACL, return host-observed `changedPaths` + a secret-scrubbed diff). |
| `docker-verify`      | The deterministic green gate: run the host-pinned verify command to completion in a hardened, network-less, token-less, read-only container; return the raw exit code.                                                                                                                                           |
| `otlp-export`        | The loop's only network egress: POST `gobrr`'s derived `traceOtlp`/`metricsOtlp` over OTLP/HTTP (https) to a configurable collector; best-effort, credentials from a vault CEL.                                                                                                                                  |

The executor is a separate extension, **`@magistr/firecracker`** (its `fabric`
runs each leaf as one `claude --print` in a microVM). Per-leaf usage capture
needs `@magistr/firecracker >= 2026.06.18.1` (the opt-in `outputFormat=json`);
an older fabric still works, you just get no token/cost telemetry.

`gobrr` key resources: `run` (authoritative state), `summary`, `decision`,
`stepOutputs` (7d audit log), `traceOtlp` (7d), `metricsOtlp`. Read any of them
with `swamp data get <name> <resource> --json | jq .content`.

---

## Explanation — why it is built this way

**The gate is sacred and unforgeable.** A task goes green **only** on
`docker-verify` exit code `0` — never on the agent's self-report. A code task
may not touch a `verifyInputs` (test) file; that split makes the gate
unforgeable in the common case.

**Isolation invariant.** Every fetched, generated, or agent-authored line runs
only inside a Firecracker microVM or the `docker-verify` container. The host
only ever applies a _parsed diff_ behind the allowlist ACL — never a mounted
workspace, never agent code on the host shell.

**Pure core, side effects at the edges.** `gobrr` is a pure state machine: all
decision logic lives in unit-tested pure helpers, and the methods are thin
wrappers. Side effects live in the side-effectful models (`source-integration`
writes via `jj`, `docker-verify` shells to Docker, `otlp-export` makes the one
network call) — never in a bespoke driver script. This is what lets the loop be
driven _inline_ by the agent.

**Measured, not asserted (Promise Theory).** Trust is the measured gate result,
not a promise. The same discipline governs observability: host-observed facts
(`changedPaths`, the verify exit, the loop's wall-clock) are truth; agent-
declared facts (the envelope summary, Claude's token/cost usage) are advisory
and namespaced `*.declared.*` so they can never masquerade as host truth.

**Bounded retention for anything secret-bearing.** Scrubbed audit tails live 7
days, not forever; the authoritative secret-scrub runs unconditionally at each
storage boundary so a forgetful caller cannot leak.

For the full operator playbook (decomposition contract, the work-contract
envelope grammar, concurrency/version pins, reporting, observability), use the
bundled **`swamp-go-brr` skill**, which dispatches to focused reference files.

## License

MIT — see [LICENSE.md](LICENSE.md). Changelog: [CHANGELOG.md](CHANGELOG.md).
