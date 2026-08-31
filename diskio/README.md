# @magistr/diskio

Answer **"what is actually reading this disk?"** on a Linux host whose storage
sits behind device-mapper and FUSE — where the obvious tools all lie.

## Why it exists

Three separate blind spots, all of which fired at once on an Unraid host on
2026-08-30 and produced a drive-failure scare that was neither a drive nor a
failure:

1. **node_exporter exports every layer of the block stack.** An encrypted array
   slot is `dm-N` → `mdXp1` → one physical `sdX`. A top-N utilisation view lists
   that one spindle two or three times, and a `dm-3`/`sdl` pair reporting the
   same number reads as two disks corroborating each other. It is an identity,
   not a signal.
2. **`lsof` on a FUSE mount names only the FUSE daemon.** Containers reach the
   array through `shfs`, which holds every descriptor on their behalf, so
   `lsof /mnt/disk4` tells you `shfs` and nothing about who wants the bytes.
3. **cgroup accounting is blind for the same reason.** FUSE reads are charged to
   the `shfs` process, not to the requesting container's cgroup, so
   `container_blkio_device_usage_total` omits the real consumer entirely and
   cadvisor's `container_fs_reads_bytes_total` reports nonsense.

## Methods

| Method       | Answers                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-map` | What is this device, physically? Resolves every dm/md/loop layer to its spindle and Unraid slot, and returns the `aliasGroups` a per-device metric would double-count. |
| `readers`    | Who is doing disk I/O right now? Samples `/proc/<pid>/io` over a window, attributes each pid to its container.                                                         |
| `open-files` | What is open under this path, and who really holds it?                                                                                                                 |
| `attribute`  | All three, scoped to one disk, plus a one-line `summary`.                                                                                                              |

```bash
swamp model method run unraid-diskio attribute --input '{"target":"sdl","sampleSeconds":30}'
swamp model method run unraid-diskio device-map
swamp model method run unraid-diskio open-files --input '{"path":"/mnt/disk4"}'
```

## The two counters

`readers` reports both, and the gap between them **is** the FUSE indirection:

- `requestedRead/WriteMBps` — from `rchar`/`wchar`: bytes the process _asked
  for_. This follows the requester through FUSE, so the container shows up here.
- `blockRead/WriteMBps` — from `read_bytes`/`write_bytes`: block I/O actually
  issued. This lands on the FUSE daemon, not on the container.

`rchar` also counts **sockets and pipes**, so a busy network service can outrank
the real disk reader. `attribute` therefore sets `onTarget` on each reader —
true only when that process (or a proxy acting for it) holds a descriptor under
the disk's mountpoint — and the summary credits nobody else. In the live run
this removed `swamp-serve` at 29.8 MB/s of websocket traffic and left
`transmission` at 6.34 MB/s, which was the actual answer. `onTarget` is `null`
from the bare `readers` method, which is not the same as `false`.

A process flagged `fuseProxy` is never the answer — it is standing in for
someone. `summarize()` never credits it, and `open-files` walks the other
processes' descriptors to name the container that has the same file open under
its own mount path.

## Configuration

```yaml
globalArguments:
  sshHost: 10.0.0.10
  sshUser: root
  fuseProxies: shfs,unraidd,mergerfs,rclone # processes that stand in for others
```

## Safety

Every probe is one SSH round trip: the script is generated locally,
base64-encoded, and piped to `bash`, so no caller-supplied value ever becomes a
remote shell word. `path` and `target` are additionally validated against a
strict allow-list. Nothing is written on the target host — no temp files outside
`mktemp`, no `find` over `/mnt/user`.

## Cost

`device-map` reads `/sys/block` and `/proc/mounts`. `readers` takes two
`/proc/*/io` snapshots `sampleSeconds` apart. `open-files` reads every
`/proc/<pid>/fd` link once and caps at 20 000 descriptors (`truncated: true`
when it hits the cap). None of them touch the array filesystem.

The fd scan costs **two forks per process**, not per descriptor — one `ls -l`
for the links and one `stat -L` for the referent sizes. The per-descriptor
version took over two minutes on a host with ~13 000 open fds; this takes about
25 seconds.
