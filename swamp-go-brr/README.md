# @magistr/swamp-go-brr

Autonomous merkle-DAG development loop, driver-free.

## Models

- **`gobrr`** — a PURE DAG state machine. A Run aggregate over a dynamic Task
  DAG with a scheduler (lease TTL/heartbeat/reap, concurrency gate, stall),
  follow-up expansion, and run caps. Methods: `start`, `seed_tasks`, `next`,
  `report`, `add_followup`, `heartbeat`, `hydrate`, `abort`, `complete`. It
  never touches the filesystem — it consumes a `WorkResult` + the verify exit
  code as arguments.
- **`source-integration`** — the host code-ownership / allowlist-ACL actor.
  - `build_workorder` — read the allowlist file slice from `repoScope`
    (realpath + DENY + secret-scrub) into the leaf prompt; no-clone
    (`gitRepoUrl=""`).
  - `apply` — parse the `@@EDIT` envelope (nonce-fence forgery defense), apply
    each task as a **per-task base-isolated** jj change off the common base,
    behind a realpath-anchored allowlist ACL (DENY set, symlink/gitlink/mode
    rejection, size caps, mode-aware post-apply re-walk tripwire); return
    host-observed `changedPaths` + a secret-scrubbed diff.
- **`docker-verify`** — the deterministic green gate. Runs the host-pinned
  verify command to completion in a hardened, network-less, token-less,
  read-only container and returns the raw exit code.

## The loop (driver-free, inline)

The agent drives the loop by calling the models — there is **no driver script**:

```
next -> build_workorder -> fabric.submit -> fabric.poll -> apply -> docker-verify -> report
```

`gobrr` owns the DAG/gate/scheduling; `@magistr/firecracker`'s fabric executes
the leaves in microVMs; `source-integration` owns code (build + apply behind the
ACL); `docker-verify` is the gate. Green per-task siblings rebase onto the base
into one linear history after the run.
