# Changelog

## 2026.08.31.1

First release.

Answers "what is actually reading this disk?" on a Linux host whose storage sits
behind device-mapper and FUSE. Built after a homelab disk-saturation alert named
`dm-3` and `sdl` as two failing drives when they are one 14.6TB spindle, and
`lsof /mnt/disk4` could name only `shfs` while the real reader was a torrent
daemon seeding a large library.

- `device-map` — resolves every dm/md/loop layer to its physical spindle and
  Unraid array slot, and returns `aliasGroups`: the layer sets a per-device
  metric double-counts.
- `readers` — samples `/proc/<pid>/io` over a window and ranks processes by disk
  I/O with container attribution, reporting requested bytes (`rchar`) and block
  I/O (`read_bytes`) separately. The gap between them is the FUSE indirection
  made visible.
- `open-files` — walks `/proc/<pid>/fd` for every process and re-attributes a
  FUSE-held descriptor to the container holding the same file under its own
  mount path, matched on basename **and** size.
- `attribute` — all three for one device, array slot or mountpoint, plus a
  one-line `summary`.

Every probe is one SSH round trip: the script is generated locally,
base64-encoded and piped to `bash`, so no caller-supplied value ever becomes a
remote shell word. `path` and `target` are additionally allow-listed. Helpers
take an injected `SshRunner`, so no test spawns ssh.

Three host-behaviour traps are encoded here because each one shipped green and
was only caught against the live host:

- **`md4p1 -> sdl` exists only in `/var/local/emhttp/disks.ini`.** Unraid's md
  driver is not Linux md — `/sys/block/md4` exposes no `slaves`, so walking
  `/sys/block` alone returns `physical: null` for every encrypted array slot.
- **`stat -Lc %n` echoes its argument.** `cd /proc; stat "$pid"/fd/*` emits
  relative keys, so every size parsed as null — which sorted real media files
  below zero-length rows and silently disabled the size check that stops two
  files sharing a basename being conflated (Postgres relfilenode `2688` exists
  under every database on the host).
- **`rchar` counts sockets and pipes.** A websocket-heavy service outranked the
  real disk reader, so `attribute` sets `onTarget` per reader — true only when
  that process, or a proxy acting for it, holds a descriptor under the disk's
  mountpoint — and the summary credits nobody else. `null` (not evaluated) is
  kept distinct from `false`.

The fd scan costs two forks per **process** (`ls -l` plus `stat -L`), not per
descriptor: ~13 000 open fds in ~25s, against over two minutes for the
per-descriptor version.
