# Concurrency substrate (sacred rule 3 — the detail)

Concurrency IS supported but has two HARD requirements (verified 2026-06-11).

## (a) netns per leaf

The baked snapshot freezes every guest at `172.16.0.2` / gw `172.16.0.1:8080`,
so concurrent clones collide unless each runs in its own Linux network
namespace. Use:

- `@magistr/firecracker` ≥ `2026.06.11.2` — `netns` global arg →
  `start_vmm`/`kill_vmm` via `ip netns exec`;
  `setup_tap --input netns=<run>-<leaf> --input vethSubnet=10.0.N.0/30`,
  a UNIQUE /30 per concurrent leaf. (The fabric methods — `fabric_up` etc. —
  handle netns internally; manual netns wrangling is only for the low-level
  per-VM methods.)
- `@magistr/fc-task-server` ≥ `2026.06.11.3` — keys its
  `/tmp/fc-{task,result}-<netns>-<port>` files by netns; older versions
  clobber across VMs.

Pin BOTH in `config.pinnedVersions` and fail closed on mismatch at pre-flight.

## (b) single-process fan-out

Launch the concurrent leaves from ONE swamp process — a workflow with parallel
jobs or `forEach … concurrency: N`. NEVER spawn N separate `swamp` CLI
invocations per leaf: each grabs the `__global__` datastore lock for its whole
run (held while the VM works) and they serialize — most time out at 60s.

## Caps

`maxConcurrentVMs` is a host-resource guard (≈512 MiB RAM per restored VM);
raise it as headroom allows. Only wallclock + invocation count are *enforced*;
dollar cost is advisory.
