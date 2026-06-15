# Inline agent loop (host side)

gobrr is a PURE DAG state machine. The agent drives the loop inline — no driver
script — by calling four models: **gobrr** (state), **`@magistr/firecracker`
fabric** (executor), **`@magistr/swamp-go-brr/source-integration`** (host
code-ownership / allowlist ACL), and **`@magistr/swamp-go-brr/docker-verify`**
(gate). Each step is a model-method call; the side effects live in the
side-effectful models, never in a bespoke script.

## 0. Pre-flight (once per run)

1. Confirm with the human: `repoScope` (the jj repo), `verifyCommand`,
   `verifyInputs` (sacred rule 2). Refuse to proceed without all three.
2. Assert the pinned substrate versions and **fail closed** on mismatch.
3. `start` (intake+config), then `seed_tasks` (the file-scoped DAG — distinct
   files per task, so the per-task changes rebase together cleanly).
4. `fabric_up` **once** (warm worker pool); record the run's **common base**
   change id (`jj log -r @ -T change_id`) — every task's apply branches off it.
   The pool stays up for the WHOLE run — every batch/round reuses the warm
   workers. `fabric_down` runs ONLY at run completion or abort (§3), NEVER
   between batches (tearing it down mid-run throws away the warm workers and the
   queue).

## 1. The loop

```
base = <baseline change id>
while true:
  next  = swamp model method run <run> next --input owner=<driverId>
  read decision: swamp data get <run> decision --json
  case decision.outcome:
    all-green        -> complete; fabric_down (run is done); break
    stalled|blocked  -> hand to human (reporting.md, sacred rule 4); break
                        (leave the fabric UP — the human may resume the run)
    leased           -> drive the leased batch (below)
```

## 2. Drive a leased batch

| Step              | Method                                        | Notes                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build prompt      | `source-integration build_workorder`          | reads the allowlist file slice (realpath + DENY + scrub), injects practices, emits the @@EDIT prompt; **no clone**                                                                                                                              |
| execute           | `firecracker submit` then `poll`              | `gitRepoUrl=""` (no-clone — the slice is in the prompt); poll is non-blocking                                                                                                                                                                   |
| apply             | `source-integration apply`                    | parses the @@EDIT envelope, applies each task as a **sibling off the common base** (per-task isolated, never stacked) behind the realpath allowlist ACL; returns per-task `{changeId, host-observed changedPaths, scrubbed diff, failureKind?}` |
| gate (per task)   | `jj edit <changeId>` → `docker-verify verify` | each task's isolated tree is gated alone; read the exit code from the docker-verify model's **latest/`current`** data resource (`.content.exitCode`), not a `result` instance                                                                   |
| report (per task) | gobrr `report`                                | `{taskId, owner, workResult, verifyExitCode}`; greens ONLY on `exitCode==0`. A null/garbled `verifyExitCode` is ignored — the task stays leased, no attempt consumed                                                                            |

`apply` is the single serial host writer. Its safety controls — token-scrub of
the persisted diff, the realpath-anchored ACL (traversal / absolute / symlinked
parent), the DENY set (`.git`/`.jj`/hooks/`.gitattributes`/CI),
regular-file-only writes (no symlink/gitlink/mode), the size/edit caps, and the
mode-aware POST-APPLY RE-WALK tripwire — are **code-resident in the model**
(`source_integration.ts` + `lib/acl.ts`), not the driver. The envelope grammar
is [work-contract.md](work-contract.md); the gate contract + accepted residuals
are there too.

## 3. Assemble + halt

- After the run, the **green** per-task siblings rebase onto the base into one
  linear history; failed/exhausted ones are dropped (file-disjoint tasks → no
  conflicts).
- **Multi-round base advance.** gobrr branches EVERY task off the ONE fixed
  base, so a task that imports another task's NEW file fails its isolated gate.
  Do independent units first; when they green, `jj rebase` the siblings into a
  linear stack, take the top change_id as the new base, and pass
  `apply --input
  base=<new base>` for the next round. `seed_tasks` is additive
  mid-run; a `next` → `all-green` only means all _currently-seeded_ tasks are
  done — seed the next round and keep going.
- On `stalled`/cap, present `haltReason` + `haltOptions` + `stallCulprits` and
  hand to the human — see [reporting.md](reporting.md). Do not spin.
- `abort` records leased vmIds; reap them and `fabric_down` before exiting.

## 4. Operational gotchas (each cost real time when missed)

- **`next` leases ONE task per call.** Call it repeatedly to fill a batch up to
  `maxConcurrentVMs`, collecting each `decision.content.taskId`.
- **Resources are wrapped in `.content`.** Read state as
  `swamp data get <model> <res> --json | jq -r .content | jq …`.
- **The gate is offline + read-only.** docker-verify forces `--network none`,
  rootfs read-only (tmpfs `/work-tmp`), tree mounted `:ro`, and the image MUST
  be digest-pinned (`…@sha256:<64hex>` — needs a RepoDigest, so push to a local
  registry). Bake deps into `DENO_DIR` in the image; the verifyCommand copies
  that cache to the writable tmpfs and runs
  `deno test … --cached-only --no-lock` (without `--no-lock`, deno tries to
  write `deno.lock` into the ro tree → exit 1 for any npm import).
- **The gate runs the verifyCommand only** (e.g. `deno test`) — NOT
  `deno
  fmt`/`lint`. Those surface later at `swamp extension push`. Run them
  as a host post-pass (static tools don't execute the code, so the isolation
  invariant holds).
- **Poll in a background loop**, not a foreground sleep.
- **Leaf retry:** a real gate failure bounces the task to `pending` (one attempt
  consumed). Re-`next`, then rebuild the workorder with an AUGMENTED spec naming
  the exact fix. If only the gate config was wrong (the code is fine), reuse the
  existing change and report it green instead of re-running the VM.
