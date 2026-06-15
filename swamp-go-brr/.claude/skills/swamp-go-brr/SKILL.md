---
name: swamp-go-brr
description: >
  Run an autonomous development loop with the @magistr/swamp-go-brr/gobrr model:
  decompose human intake into a dynamic Task DAG, then drive a headless loop that
  runs each leaf as `claude --print` inside a Firecracker microVM (no-clone — files
  sent in the prompt, repo stays on the host), applies the returned diff onto a jj
  change behind an allowlist ACL, and gates it with a deterministic
  @magistr/swamp-go-brr/docker-verify run. Tasks can file follow-ups that become
  blocking DAG nodes. Do NOT use to drive a GitHub issue through review/approval
  or to iterate on code-review findings (both are `issue-lifecycle`), to file a
  bug (`swamp-issue`), or to boot a one-off VM (`@magistr/firecracker`). Triggers
  on "swamp-go-brr", "go brr", "gobrr run",
  "autonomous dev loop", "task DAG run", "decompose into tasks and build",
  "drive the gobrr loop", "spawn firecracker coding agents".
---

# swamp-go-brr — autonomous merkle-DAG development loop

The loop is four models the agent drives inline (no driver script), plus a
**Phase-0 `preflight`** model that sets up the substrate — **run preflight
first** ([references/preflight.md](references/preflight.md)); skipping it is the
top cause of a slow, fumbling run:

| Model                         | Owns                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `preflight`                   | Phase-0 substrate (docker-only): digest-pin the gate image, emit the run `config`              |
| `gobrr`                       | PURE DAG state machine: Task DAG, scheduler, follow-up recursion; never touches the filesystem |
| `source-integration`          | host code-ownership: build WorkOrder, apply the envelope behind the allowlist ACL              |
| `@magistr/firecracker` fabric | executor: one leaf = one `claude --print` in a microVM                                         |
| `docker-verify`               | the deterministic green gate                                                                   |

## Sacred rules (front-loaded — never violate)

1. **ISOLATION INVARIANT.** Every fetched, generated, or untrusted line of work
   executes ONLY inside the `@magistr/firecracker` fabric worker VM or the
   `docker-verify` container. Never run agent-authored content on the host
   shell. The host only applies a parsed _diff_ (never a mounted workspace)
   behind the `source-integration` allowlist ACL.
2. **PRE-LAUNCH SCOPING.** Before any leaf runs, the human MUST confirm: the
   target jj repo (`repoScope`), the host-pinned `verifyCommand`, and the
   `verifyInputs` surface (test files + helpers + fixtures). The loop REFUSES to
   start without them; never infer them from cwd. Follow-ups are bounded to
   `repoScope`.
3. **CONCRETE CAPS.** Defaults: `maxConcurrentVMs=5`, `maxAttempts=2`,
   `maxFollowupDepth=3`, `maxInvocations=100`, `wallclockSeconds=7200`,
   `stallN=2`, `stallK=3`. Concurrency IS supported but has two HARD
   requirements: a network namespace per leaf (pinned substrate versions, fail
   closed on mismatch) and single-process fan-out (NEVER N parallel `swamp` CLI
   invocations — they serialize on the global datastore lock). Details + version
   pins: [references/concurrency.md](references/concurrency.md).
4. **STALL HANDOVER.** On `stalled`/cap halt, present the `haltReason` + the
   enumerated `haltOptions` + the `stallCulprits`, and hand to the human. Do not
   spin.
5. **APPROVAL POSTURE.** Finding-resolution inside a leaf is headless. The GREEN
   GATE is the `docker-verify` exit code, never the agent's self-report. A code
   task may never edit a `verifyInputs` file (hard-rejected); a test task
   auto-merges (gate=advisory). Two residuals are accepted, documented limits —
   see [references/work-contract.md](references/work-contract.md).

## Phase → reference dispatch

| Phase            | What happens                                                                                             | Reference                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Preflight (0)    | digest-pin the gate image + emit `config`; create si/dv/fab; warm the fabric; scaffold a greenfield base | [references/preflight.md](references/preflight.md)         |
| Intake + scoping | confirm repoScope / verifyCommand / verifyInputs; `start`                                                | inline (sacred rule 2)                                     |
| Decompose        | break intake into a Task DAG; `seed_tasks`                                                               | [references/work-contract.md](references/work-contract.md) |
| Drive            | `next → build_workorder → fabric.submit → fabric.poll → apply → docker-verify → report` inline loop      | [references/inline-loop.md](references/inline-loop.md)     |
| Work contract    | WorkOrder→prompt, WorkResult←envelope, the gate                                                          | [references/work-contract.md](references/work-contract.md) |
| Practices        | what to inject into each leaf's prompt                                                                   | [references/practices.md](references/practices.md)         |
| Report / halt    | hydrate, complete, stall/cap handover                                                                    | [references/reporting.md](references/reporting.md)         |

## Minimal flow (abbreviated — full loop in references/inline-loop.md)

```bash
# 0. Pre-flight: human confirms repoScope, verifyCommand, verifyInputs (rule 2)
swamp model method run <run> start --input intake=... --input config=...
swamp model method run <run> seed_tasks --input tasks=...   # file-scoped DAG
swamp model method run fab fabric_up --input concurrency=5 ...  # once per run

# 1. Loop until all-green / stalled:
swamp model method run <run> next --input owner=<driverId>
swamp data get <run> decision --json                  # leased? → drive batch:
swamp model method run si build_workorder ...         # allowlist slice → prompt
swamp model method run fab submit ... && ... poll ... # claude --print in microVM
swamp model method run si apply ...                   # @@EDIT envelope → jj change
jj edit <changeId> && swamp model method run dv verify ...  # gate in isolation
swamp model method run <run> report --input taskId=... --input verifyExitCode=...

# 2. all-green → complete; fabric_down. stalled → hand to human (rule 4).
```

## Resuming

```bash
swamp model method run <run-name> hydrate
swamp data get <run-name> summary --json
```

Hydrate reports status, per-status bucket counts, leased VMs, follow-up waits,
stall culprits, cost estimate, and the enumerated halt options.

## Model methods (quick reference)

**gobrr (pure DAG state machine):** `start` (intake+config) · `seed_tasks`
(batch, derives gate, rejects cycles) · `next` (lease) · `report`
(workResult+verifyExitCode) · `add_followup` (depth-3, cycle/scope guarded) ·
`heartbeat` · `hydrate` · `abort` · `complete`.

**source-integration (host code/ACL actor):** `build_workorder` (read allowlist
files → leaf prompt, no-clone) · `apply` (parse @@EDIT envelope → per-task
base-isolated jj changes behind the realpath allowlist ACL → host-observed
changedPaths + scrubbed diff).

**firecracker fabric (executor):** `fabric_up` · `submit` · `poll` ·
`fabric_down`. **docker-verify (gate):** `verify`.

See `swamp model type describe @magistr/swamp-go-brr/gobrr --json` (and
`…/source-integration`).

## Related skills

| Need                                         | Skill                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| Drive a GitHub issue through review→approval | `issue-lifecycle` (do NOT use this)                    |
| File a bug/feature                           | `swamp-issue`                                          |
| Boot/snapshot a single microVM               | `@magistr/firecracker`                                 |
| The practices injected into leaves           | `tessl__tdd`, `tessl__ddd` (as content, not installed) |
