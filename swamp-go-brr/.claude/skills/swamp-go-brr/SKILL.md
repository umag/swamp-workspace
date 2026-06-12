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
  (that is `issue-lifecycle`), to file a bug (`swamp-issue`), or to boot a one-off
  VM (`@magistr/firecracker`). Triggers on "swamp-go-brr", "go brr", "gobrr run",
  "autonomous dev loop", "task DAG run", "decompose into tasks and build",
  "drive the gobrr loop", "spawn firecracker coding agents".
---

# swamp-go-brr — autonomous merkle-DAG development loop

`@magistr/swamp-go-brr/gobrr` is a PURE DAG state machine — it owns
**orchestration** (the Task DAG + scheduler) and **recursion** (follow-up
expansion) and never touches the filesystem. The host **code-ownership** boundary
(build the WorkOrder, apply the returned envelope behind the allowlist ACL) is a
separate side-effectful model, `@magistr/swamp-go-brr/source-integration`. A
Firecracker microVM runs only one small piece of work per leaf, given the
practices + context it needs.

## Sacred rules (front-loaded — never violate)

1. **ISOLATION INVARIANT.** Every fetched, generated, or untrusted line of work
   executes ONLY inside the `@magistr/firecracker` fabric worker VM or the
   `docker-verify` container. Never run agent-authored content on the host shell.
   The host only applies a parsed *diff* (never a mounted workspace) behind the
   `source-integration` allowlist ACL.
2. **PRE-LAUNCH SCOPING.** Before any leaf runs, the human MUST confirm: the
   target jj repo (`repoScope`), the host-pinned `verifyCommand`, and the
   `verifyInputs` surface (test files + helpers + fixtures). The loop REFUSES to
   start without them; never infer them from cwd. Follow-ups are bounded to
   `repoScope`.
3. **CONCRETE CAPS.** Defaults: `maxConcurrentVMs=5`, `maxAttempts=2`,
   `maxFollowupDepth=3`, `maxInvocations=100`, `wallclockSeconds=7200`,
   `stallN=2`, `stallK=3`. Concurrency IS supported but has two HARD
   requirements (verified 2026-06-11):
   (a) **netns per leaf.** The baked snapshot freezes every guest at
   `172.16.0.2` / gw `172.16.0.1:8080`, so concurrent clones collide unless each
   runs in its own Linux network namespace. Use `@magistr/firecracker`
   ≥ `2026.06.11.2` (`netns` global arg → `start_vmm`/`kill_vmm` via
   `ip netns exec`; `setup_tap --input netns=<run>-<leaf> --input vethSubnet=10.0.N.0/30`,
   a UNIQUE /30 per concurrent leaf) and `@magistr/fc-task-server`
   ≥ `2026.06.11.3` (keys its `/tmp/fc-{task,result}-<netns>-<port>` files by
   netns; older versions clobber across VMs). Pin BOTH in `config.pinnedVersions`.
   (b) **single-process fan-out.** Launch the concurrent leaves from ONE swamp
   process — a workflow with parallel jobs or `forEach … concurrency: N`. NEVER
   spawn N separate `swamp` CLI invocations per leaf: each grabs the
   `__global__` datastore lock for its whole run (held while the VM works) and
   they serialize → most time out at 60s. `maxConcurrentVMs` is a host-resource
   guard (≈512 MiB RAM per restored VM); raise it as headroom allows. Only
   wallclock + invocation count are *enforced*; dollar cost is advisory.
4. **STALL HANDOVER.** On `stalled`/cap halt, present the `haltReason` + the
   enumerated `haltOptions` + the `stallCulprits`, and hand to the human. Do not
   spin.
5. **APPROVAL POSTURE.** Finding-resolution inside a leaf is headless. The GREEN
   GATE is the `docker-verify` exit code, never the agent's self-report. A code
   task may never edit a `verifyInputs` file (hard-rejected); a test task
   auto-merges (gate=advisory). Two residuals are accepted, documented limits —
   see [references/work-contract.md](references/work-contract.md).

## Phase → reference dispatch

| Phase | What happens | Reference |
|-------|-------------|-----------|
| Intake + scoping | confirm repoScope / verifyCommand / verifyInputs; `start` | inline (sacred rule 2) |
| Decompose | break intake into a Task DAG; `seed_tasks` | [references/work-contract.md](references/work-contract.md) |
| Drive | `next → build_workorder → fabric.submit → fabric.poll → apply → docker-verify → report` inline loop | [references/inline-loop.md](references/inline-loop.md) |
| Work contract | WorkOrder→prompt, WorkResult←envelope, the gate | [references/work-contract.md](references/work-contract.md) |
| Practices | what to inject into each leaf's prompt | [references/practices.md](references/practices.md) |
| Report / halt | hydrate, complete, stall/cap handover | [references/reporting.md](references/reporting.md) |

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

**firecracker fabric (executor):** `fabric_up` · `submit` · `poll` · `fabric_down`.
**docker-verify (gate):** `verify`.

See `swamp model type describe @magistr/swamp-go-brr/gobrr --json` (and
`…/source-integration`).

## Related skills

| Need | Skill |
|------|-------|
| Drive a GitHub issue through review→approval | `issue-lifecycle` (do NOT use this) |
| File a bug/feature | `swamp-issue` |
| Boot/snapshot a single microVM | `@magistr/firecracker` |
| The practices injected into leaves | `tessl__tdd`, `tessl__ddd` (as content, not installed) |
