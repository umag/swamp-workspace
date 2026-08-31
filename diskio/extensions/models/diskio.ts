// @magistr/diskio — answer "what is actually reading this disk?" on a Linux
// host whose storage sits behind device-mapper and FUSE.
//
// Three things defeat the obvious tools on an Unraid array, and this model
// exists because of them:
//
//  1. node_exporter exports EVERY layer of the block stack. An encrypted array
//     slot is `dm-N` -> `mdXp1` -> one physical `sdX`, so a top-N utilisation
//     view lists one spindle two or three times and a dm/sd pair reporting the
//     same number reads as two disks corroborating each other. It is an
//     identity, not a signal. `device-map` resolves the stack so the layers
//     can be collapsed.
//
//  2. Containers reach the array through FUSE. `shfs` holds every file
//     descriptor on their behalf, so `lsof /mnt/disk4` names only `shfs` and
//     tells you nothing about who wants the bytes. `open-files` walks
//     /proc/<pid>/fd for every process and re-attributes a FUSE-held file to
//     the container that has the same file open under its own mount path.
//
//  3. cgroup accounting is blind for the same reason: FUSE reads are charged
//     to the shfs process, not to the requesting container's cgroup, so
//     `container_blkio_device_usage_total` omits the real consumer entirely.
//     `readers` samples /proc/<pid>/io instead and reports BOTH counters —
//     `rchar` (bytes the process asked for, which follows the requester
//     through FUSE) and `read_bytes` (actual block I/O, which lands on the
//     FUSE daemon). The gap between them is the indirection made visible.
//
// Everything runs in one SSH round trip per method: the sampling script is
// generated here, base64-encoded, and piped to `bash` on the host, so no
// argument is ever interpolated into a remote shell word.

import { z } from "npm:zod@4";
import { sshExecRaw } from "./lib/ssh.ts";

/* -------------------------------------------------------------------------
 * Injected process runner (see reference-command-runner-injection): every
 * helper takes it as its explicit first parameter so tests can script the
 * host's answers without spawning ssh.
 * ---------------------------------------------------------------------- */

export type SshRunner = (
  host: string,
  user: string,
  command: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunner: SshRunner = sshExecRaw;

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe("SSH address of the host whose disks to read"),
  sshUser: z.string().default("root").describe("SSH username (default: root)"),
  fuseProxies: z.string().default("shfs,unraidd,mergerfs,rclone").describe(
    "Comma-separated process names that hold file descriptors on behalf of other processes. I/O charged to one of these is a proxy for a real consumer, never the consumer itself.",
  ),
});

/* ------------------------------------------------------------------ schemas */

const DeviceSchema = z.object({
  name: z.string(),
  kind: z.enum(["physical", "dm", "md", "loop", "other"]),
  dmName: z.string().nullable(),
  slaves: z.array(z.string()),
  /** The physical spindle this layer ultimately sits on, if resolvable. */
  physical: z.string().nullable(),
  /** Unraid array slot (disk4, parity, cache, …) when disks.ini knows it. */
  slot: z.string().nullable(),
  mountpoint: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  usedPercent: z.number().nullable(),
});

const DeviceMapSchema = z.object({
  host: z.string(),
  devices: z.array(DeviceSchema),
  /** One entry per physical spindle that more than one layer resolves to —
   * exactly the groups a saturation view would otherwise double-count. */
  aliasGroups: z.array(z.object({
    physical: z.string(),
    slot: z.string().nullable(),
    layers: z.array(z.string()),
  })),
  timestamp: z.string(),
});

const ReaderSchema = z.object({
  pid: z.number(),
  command: z.string(),
  container: z.string().nullable(),
  /** Bytes the process ASKED for (rchar) — follows the requester through FUSE. */
  requestedReadMBps: z.number(),
  requestedWriteMBps: z.number(),
  /** Actual block I/O (read_bytes/write_bytes) — lands on the FUSE daemon. */
  blockReadMBps: z.number(),
  blockWriteMBps: z.number(),
  /** True when this process only proxies for others (shfs and friends). */
  fuseProxy: z.boolean(),
  /** Whether the process holds at least one descriptor under the disk being
   * asked about. `rchar` counts EVERY read a process makes — sockets and pipes
   * included — so a busy network service outranks a real disk reader unless
   * this gates it. null when nothing was being attributed to a disk (the bare
   * `readers` method), which is not the same as false. */
  onTarget: z.boolean().nullable(),
});

const ReadersSchema = z.object({
  host: z.string(),
  sampleSeconds: z.number(),
  readers: z.array(ReaderSchema),
  totals: z.object({
    requestedReadMBps: z.number(),
    blockReadMBps: z.number(),
    blockWriteMBps: z.number(),
    proxyBlockReadMBps: z.number(),
  }),
  timestamp: z.string(),
});

const OpenFileSchema = z.object({
  pid: z.number(),
  command: z.string(),
  container: z.string().nullable(),
  fd: z.number(),
  path: z.string(),
  sizeBytes: z.number().nullable(),
  fuseProxy: z.boolean(),
  /** When a FUSE proxy holds the file, the processes that have the same file
   * open under their own mount path — the actual consumers. */
  consumers: z.array(z.object({
    pid: z.number(),
    command: z.string(),
    container: z.string().nullable(),
    path: z.string(),
  })),
});

const OpenFilesSchema = z.object({
  host: z.string(),
  path: z.string(),
  files: z.array(OpenFileSchema),
  scanned: z.number(),
  truncated: z.boolean(),
  timestamp: z.string(),
});

const AttributionSchema = z.object({
  host: z.string(),
  /** What the caller asked about, verbatim. */
  target: z.string(),
  physical: z.string().nullable(),
  slot: z.string().nullable(),
  layers: z.array(z.string()),
  mountpoint: z.string().nullable(),
  sampleSeconds: z.number(),
  topReaders: z.array(ReaderSchema),
  openFiles: z.array(OpenFileSchema),
  /** One-line plain-language answer, safe to put straight into an alert. */
  summary: z.string(),
  timestamp: z.string(),
});

/* ------------------------------------------------------------- script plumbing */

/** Base64 so no caller-supplied value is ever a remote shell word. */
function encodeScript(script: string): string {
  const bytes = new TextEncoder().encode(script);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function runScript(
  run: SshRunner,
  host: string,
  user: string,
  script: string,
): Promise<string> {
  const res = await run(
    host,
    user,
    `echo ${encodeScript(script)} | base64 -d | bash`,
  );
  if (res.code !== 0) {
    throw new Error(
      `diskio probe failed on ${host} (exit ${res.code}): ${
        (res.stderr || res.stdout).slice(-400)
      }`,
    );
  }
  return res.stdout;
}

/**
 * Rows are `TAG|field|field|…`; the last field may itself contain `|` (a file
 * path legitimately can). Short rows are PADDED with empty strings rather than
 * returned ragged: a truncated line from a host under load must not make the
 * caller destructure `undefined` — a bare `DEV|` crashed probeDeviceMap on
 * `slaves.split`.
 */
function rows(stdout: string, tag: string, fields: number): string[][] {
  const out: string[][] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(tag + "|")) continue;
    const parts = line.slice(tag.length + 1).split("|");
    const row = parts.slice(0, fields - 1);
    row.push(parts.slice(fields - 1).join("|"));
    while (row.length < fields) row.push("");
    out.push(row);
  }
  return out;
}

/** `Number("")` is 0, not NaN — an unreadable /sys/block size would otherwise
 * be reported as a 0-byte device rather than as "unknown". Blank is null. */
const num = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const MB = 1048576;
/** Descriptors beyond this are not reported; `truncated` says so. */
const FD_SCAN_CAP = 20000;

/** A path we will hand to a script that does prefix matching. Reject anything
 * that is not a plain absolute path — the value still never becomes a shell
 * word, but a caller should not be able to steer the scan with newlines. */
export function assertSafePath(path: string): string {
  if (!/^\/[\w\-./ +@:,'()\[\]#&=]*$/.test(path) || path.includes("..")) {
    throw new Error(
      `Refusing to scan ${
        JSON.stringify(path)
      }: expected a plain absolute path`,
    );
  }
  return path;
}

/** `sdl`, `dm-3`, `md4p1`, `disk4`, `/mnt/disk4` are all valid targets. */
export function assertSafeTarget(target: string): string {
  if (!/^[\w\-./]{1,128}$/.test(target) || target.includes("..")) {
    throw new Error(
      `Refusing to resolve ${
        JSON.stringify(target)
      }: expected a device name, array slot, or mountpoint`,
    );
  }
  return target;
}

/* ------------------------------------------------------------------- probes */

const MAP_SCRIPT = String.raw`
set -u
cd /sys/block 2>/dev/null || exit 1
for n in *; do
  [ -e "$n" ] || continue
  size=$(cat "$n/size" 2>/dev/null || echo "")
  dmname=$(cat "$n/dm/name" 2>/dev/null || echo "")
  slaves=$(ls "$n/slaves" 2>/dev/null | tr '\n' ',' || echo "")
  echo "DEV|$n|$size|$dmname|$slaves"
done
awk '$1 ~ /^\/dev\// { print "MNT|" $1 "|" $2 }' /proc/mounts
if [ -r /var/local/emhttp/disks.ini ]; then
  awk -F= '
    /^name=/  { n=$2; gsub(/"/,"",n) }
    /^device=/{ v=$2; gsub(/"/,"",v); if (n != "" && v != "") print "SLOT|" n "|" v }
  ' /var/local/emhttp/disks.ini
fi
df -B1 --output=source,target,size,used 2>/dev/null | tail -n +2 |
  awk '{ print "DF|" $1 "|" $2 "|" $3 "|" $4 }'
`;

function classify(
  name: string,
  dmName: string,
): z.infer<typeof DeviceSchema>["kind"] {
  if (dmName || name.startsWith("dm-")) return "dm";
  if (/^md\d/.test(name)) return "md";
  if (name.startsWith("loop")) return "loop";
  if (
    /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|mmcblk\d+)$/.test(name)
  ) {
    return "physical";
  }
  return "other";
}

export async function probeDeviceMap(
  run: SshRunner,
  host: string,
  user: string,
): Promise<z.infer<typeof DeviceMapSchema>> {
  const out = await runScript(run, host, user, MAP_SCRIPT);

  const bySlaves = new Map<string, string[]>();
  const devices: z.infer<typeof DeviceSchema>[] = [];
  for (const [name, size, dmName, slaves] of rows(out, "DEV", 4)) {
    const list = slaves.split(",").filter(Boolean);
    bySlaves.set(name, list);
    devices.push({
      name,
      kind: classify(name, dmName),
      dmName: dmName || null,
      slaves: list,
      physical: null,
      slot: null,
      // /sys/block/*/size is in 512-byte sectors, always, regardless of the
      // device's own logical block size.
      sizeBytes: num(size) === null ? null : num(size)! * 512,
      mountpoint: null,
      usedPercent: null,
    });
  }

  const slotByDev = new Map<string, string>();
  for (const [slot, dev] of rows(out, "SLOT", 2)) slotByDev.set(dev, slot);
  const devBySlot = new Map<string, string>();
  for (const [dev, slot] of slotByDev) devBySlot.set(slot, dev);

  // Walk the stack down to the spindle.
  //
  // Two links exist and neither alone is enough:
  //   - /sys/block/<dev>/slaves, which covers device-mapper and partitions
  //     (dm-9 -> nvme0n1p1 -> nvme0n1);
  //   - Unraid's array table, which is the ONLY place md4p1 -> sdl is written
  //     down. Unraid's md driver is not Linux md: /sys/block/md4 exposes no
  //     slaves, so the dm layer of an encrypted slot dead-ends there. Slot N
  //     is diskN by construction, so mdN(pM) resolves through disks.ini.
  const resolve = (name: string, seen = new Set<string>()): string | null => {
    if (seen.has(name)) return null; // cycle guard: a stack must terminate
    seen.add(name);
    const dev = devices.find((d) => d.name === name);
    if (dev && dev.kind === "physical") return name;

    const slaves = bySlaves.get(name) ?? [];
    for (const s of slaves) {
      if (s === name) continue; // a dm device names itself in dm/name
      const r = resolve(s, seen);
      if (r) return r;
    }

    const md = /^md(\d+)(p\d+)?$/.exec(name);
    if (md) {
      const slotDev = devBySlot.get(`disk${md[1]}`);
      if (slotDev && !seen.has(slotDev)) return resolve(slotDev, seen);
    }

    // A partition: fall back to the whole device, once.
    const base = name.replace(/p?\d+$/, "");
    if (base !== name && base.length > 0) return resolve(base, seen);
    return null;
  };
  for (const d of devices) d.physical = resolve(d.name);

  // /dev/mapper/md4p1 -> md4p1, /dev/sdl1 -> sdl1
  const devName = (src: string) => src.replace(/^\/dev\/(mapper\/)?/, "");
  const mountByDev = new Map<string, string>();
  for (const [src, target] of rows(out, "MNT", 2)) {
    mountByDev.set(devName(src), target);
  }
  const usedByMount = new Map<string, number>();
  for (const [, target, size, used] of rows(out, "DF", 4)) {
    const s = num(size), u = num(used);
    if (s && u !== null && s > 0) usedByMount.set(target, round2(u / s * 100));
  }
  for (const d of devices) {
    const mp = mountByDev.get(d.name) ??
      mountByDev.get(d.dmName ?? "") ??
      // A partition of this device is what actually gets mounted.
      [...mountByDev.entries()].find(([k]) =>
        k.replace(/p?\d+$/, "") === d.name
      )
        ?.[1] ??
      null;
    d.mountpoint = mp;
    d.usedPercent = mp ? usedByMount.get(mp) ?? null : null;
    d.slot = slotByDev.get(d.name) ??
      (d.physical ? slotByDev.get(d.physical) ?? null : null);
  }

  const groups = new Map<string, string[]>();
  for (const d of devices) {
    if (!d.physical) continue;
    groups.set(d.physical, [...(groups.get(d.physical) ?? []), d.name]);
  }
  const aliasGroups = [...groups.entries()]
    .filter(([, layers]) => layers.length > 1)
    .map(([physical, layers]) => ({
      physical,
      slot: slotByDev.get(physical) ?? null,
      layers: layers.sort(),
    }))
    .sort((a, b) => a.physical.localeCompare(b.physical));

  return {
    host,
    devices: devices.sort((a, b) => a.name.localeCompare(b.name)),
    aliasGroups,
    timestamp: new Date().toISOString(),
  };
}

/** Two /proc/<pid>/io snapshots `seconds` apart, joined on pid. */
function readersScript(seconds: number): string {
  return String.raw`
set -u
A=$(mktemp) ; B=$(mktemp) ; D=$(mktemp)
trap 'rm -f "$A" "$B" "$D"' EXIT
cd /proc 2>/dev/null || exit 1
snap() {
  for pid in [0-9]*; do
    [ -r "$pid/io" ] || continue
    # rchar/wchar = bytes the process asked for (survives FUSE indirection);
    # read_bytes/write_bytes = block I/O actually issued for it.
    vals=$(sed -n 's/^rchar: //p;s/^wchar: //p;s/^read_bytes: //p;s/^write_bytes: //p' "$pid/io" | tr '\n' ' ')
    set -- $vals
    [ $# -eq 4 ] && echo "$pid $1 $2 $3 $4"
  done | sort -k1,1
}
snap > "$A"
sleep ` + seconds + String.raw`
snap > "$B"
join "$A" "$B" | awk '{
  drc=$6-$2; dwc=$7-$3; drb=$8-$4; dwb=$9-$5;
  if (drc>0 || dwc>0 || drb>0 || dwb>0) print $1, drc, dwc, drb, dwb
}' > "$D"
while read -r pid drc dwc drb dwb; do
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-200)
  [ -z "$cmd" ] && cmd="[$(cat "/proc/$pid/comm" 2>/dev/null)]"
  cid=$(grep -om1 '[0-9a-f]\{64\}' "/proc/$pid/cgroup" 2>/dev/null || true)
  echo "P|$pid|$drc|$dwc|$drb|$dwb|$cid|$cmd"
done < "$D"
docker ps --no-trunc --format 'C|{{.ID}}|{{.Names}}' 2>/dev/null || true
`;
}

function containerIndex(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, name] of rows(out, "C", 2)) m.set(id, name);
  return m;
}

function commName(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return (first.replace(/^\[|\]$/g, "").split("/").pop() ?? "").trim();
}

export async function probeReaders(
  run: SshRunner,
  host: string,
  user: string,
  seconds: number,
  topN: number,
  proxies: string[],
): Promise<z.infer<typeof ReadersSchema>> {
  // A rate needs a window. Clamping would silently report a number nobody
  // measured, so a zero or negative window is refused before any ssh call.
  if (!Number.isFinite(seconds) || seconds < 1) {
    throw new Error(
      `sampleSeconds must be at least 1, got ${seconds}: a rate over a zero-length window is not a number.`,
    );
  }
  const out = await runScript(run, host, user, readersScript(seconds));
  const containers = containerIndex(out);

  const all: z.infer<typeof ReaderSchema>[] = [];
  for (const [pid, drc, dwc, drb, dwb, cid, cmd] of rows(out, "P", 7)) {
    const per = (v: string) => round2((num(v) ?? 0) / seconds / MB);
    all.push({
      pid: num(pid) ?? 0,
      command: cmd.trim(),
      container: (cid && containers.get(cid)) || null,
      requestedReadMBps: per(drc),
      requestedWriteMBps: per(dwc),
      blockReadMBps: per(drb),
      blockWriteMBps: per(dwb),
      fuseProxy: proxies.includes(commName(cmd)),
      onTarget: null,
    });
  }

  const sum = (f: (r: z.infer<typeof ReaderSchema>) => number) =>
    round2(all.reduce((n, r) => n + f(r), 0));

  return {
    host,
    sampleSeconds: seconds,
    readers: all
      .sort((a, b) =>
        (b.requestedReadMBps + b.blockReadMBps) -
        (a.requestedReadMBps + a.blockReadMBps)
      )
      .slice(0, topN),
    totals: {
      requestedReadMBps: sum((r) => r.requestedReadMBps),
      blockReadMBps: sum((r) => r.blockReadMBps),
      blockWriteMBps: sum((r) => r.blockWriteMBps),
      proxyBlockReadMBps: round2(
        all.filter((r) => r.fuseProxy).reduce((n, r) => n + r.blockReadMBps, 0),
      ),
    },
    timestamp: new Date().toISOString(),
  };
}

/** Every open regular file, so a FUSE-held path can be matched back to the
 * container holding the same file under its own mount. Kernel and container-
 * runtime paths are dropped in-script to keep the payload small. */
export const FD_SCRIPT = String.raw`
set -u
cd /proc 2>/dev/null || exit 1
for pid in [0-9]*; do
  [ -d "$pid/fd" ] || continue
  # TWO forks per process, not two per descriptor. A host with ~600 processes
  # and ~20000 open fds costs ~1200 forks here; a readlink+stat per fd cost
  # 40000 and took minutes.
  #   ls -l  -> fd number and link target, in one pass
  #   stat -L -> the REFERENT's size, keyed by the same fd path
  fds=$(ls -l "$pid/fd" 2>/dev/null |
    sed -n 's/^l.* \([0-9][0-9]*\) -> \(\/.*\)$/\1 \2/p' |
    grep -v ' /proc/\| /sys/\| /dev/\| /run/\| /tmp/\| /var/lib/docker/\| /var/log/\| /usr/\| /etc/\| /boot/')
  [ -z "$fds" ] && continue
  cmd=$(tr '\0' ' ' < "$pid/cmdline" 2>/dev/null | cut -c1-200)
  [ -z "$cmd" ] && cmd="[$(cat "$pid/comm" 2>/dev/null)]"
  cid=$(grep -om1 '[0-9a-f]\{64\}' "$pid/cgroup" 2>/dev/null || true)
  echo "M|$pid|$cid|$cmd"
  stat -Lc 'S|%n|%s' /proc/"$pid"/fd/* 2>/dev/null || true
  echo "$fds" | while read -r fd target; do
    echo "F|$pid|$fd|$target"
  done
done
docker ps --no-trunc --format 'C|{{.ID}}|{{.Names}}' 2>/dev/null || true
`;

/** One row per (container, path): a database or media server reaches the same
 * file from many worker pids, and listing each is noise, not information. */
function dedupeConsumers<
  T extends { container: string | null; path: string; command: string },
>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = `${c.container ?? c.command}|${c.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function probeOpenFiles(
  run: SshRunner,
  host: string,
  user: string,
  path: string,
  proxies: string[],
  limit: number,
): Promise<z.infer<typeof OpenFilesSchema>> {
  assertSafePath(path);
  const out = await runScript(run, host, user, FD_SCRIPT);
  const containers = containerIndex(out);

  const meta = new Map<number, { command: string; container: string | null }>();
  for (const [pid, cid, cmd] of rows(out, "M", 3)) {
    meta.set(num(pid) ?? 0, {
      command: cmd.trim(),
      container: (cid && containers.get(cid)) || null,
    });
  }

  const sizeByFdPath = new Map<string, number | null>();
  for (const [fdPath, size] of rows(out, "S", 2)) {
    sizeByFdPath.set(fdPath, num(size));
  }

  type Fd = { pid: number; fd: number; size: number | null; path: string };
  const fds: Fd[] = [];
  for (const [pid, fd, target] of rows(out, "F", 3)) {
    fds.push({
      pid: num(pid) ?? 0,
      fd: num(fd) ?? 0,
      size: sizeByFdPath.get(`/proc/${pid}/fd/${fd}`) ?? null,
      path: target,
    });
  }

  const isProxy = (pid: number) =>
    proxies.includes(commName(meta.get(pid)?.command ?? ""));

  const prefix = path.endsWith("/") ? path : path + "/";
  const matched = fds.filter((f) =>
    f.path === path || f.path.startsWith(prefix)
  );

  // A file held only by a FUSE daemon has a real consumer elsewhere holding
  // the SAME file under a different mount path. Match on basename, and require
  // the size to agree so two unrelated files that happen to share a name are
  // not conflated.
  const byBasename = new Map<string, Fd[]>();
  for (const f of fds) {
    const base = f.path.split("/").pop() ?? "";
    if (!base) continue;
    byBasename.set(base, [...(byBasename.get(base) ?? []), f]);
  }

  const files = matched
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, limit)
    .map((f) => {
      const m = meta.get(f.pid);
      const proxy = isProxy(f.pid);
      const base = f.path.split("/").pop() ?? "";
      const consumers = proxy
        ? dedupeConsumers(
          (byBasename.get(base) ?? [])
            .filter((c) =>
              c.pid !== f.pid && !isProxy(c.pid) &&
              // Sizes must AGREE. When either is unknown the basename alone is
              // not evidence — a Postgres relfilenode like `2688` exists under
              // every database on the host — so an unsized pair is dropped
              // rather than guessed at.
              f.size !== null && c.size !== null && c.size === f.size
            )
            .map((c) => ({
              pid: c.pid,
              command: meta.get(c.pid)?.command ?? "",
              container: meta.get(c.pid)?.container ?? null,
              path: c.path,
            })),
        )
        : [];
      return {
        pid: f.pid,
        command: m?.command ?? "",
        container: m?.container ?? null,
        fd: f.fd,
        path: f.path,
        sizeBytes: f.size,
        fuseProxy: proxy,
        consumers,
      };
    });

  return {
    host,
    path,
    files,
    scanned: fds.length,
    truncated: fds.length >= FD_SCAN_CAP,
    timestamp: new Date().toISOString(),
  };
}

/** Plain-language answer, built only from what the probes actually returned. */
export function summarize(
  target: string,
  physical: string | null,
  layers: string[],
  readers: z.infer<typeof ReaderSchema>[],
  files: z.infer<typeof OpenFileSchema>[],
): string {
  const parts: string[] = [];
  if (physical && layers.length > 1) {
    parts.push(
      `${target} resolves to ${physical}; ${
        layers.join(", ")
      } are layers of that one device, not separate disks.`,
    );
  }

  // Credit a proxy's bytes to whoever asked for them, never to the proxy — and
  // never credit a process that holds nothing on this disk. rchar counts
  // sockets and pipes, so a busy network service (swamp-serve, at 29.8 MB/s of
  // websocket traffic in the live run of 2026-08-30) outranks the real reader
  // unless this gates it.
  const candidates = readers.filter((r) =>
    !r.fuseProxy && r.requestedReadMBps > 0
  );
  const onDisk = candidates.filter((r) => r.onTarget !== false);
  if (candidates.length === 0) {
    parts.push("No process registered any read in the sample window.");
  } else if (onDisk.length === 0) {
    parts.push(
      "No process holding a file on this disk registered a read in the sample window; the block I/O is readahead or metadata.",
    );
  } else {
    const top = onDisk.slice(0, 3).map((r) =>
      `${
        r.container ?? (commName(r.command) || `pid ${r.pid}`)
      } ${r.requestedReadMBps} MB/s`
    );
    parts.push(`Top readers: ${top.join(", ")}.`);
    const offDisk = candidates.length - onDisk.length;
    if (offDisk > 0) {
      parts.push(
        `${offDisk} busier process(es) excluded: their reads are sockets or other filesystems, not this disk.`,
      );
    }
  }

  const consumers = new Set<string>();
  for (const f of files) {
    for (const c of f.consumers) {
      consumers.add(c.container ?? commName(c.command));
    }
    if (!f.fuseProxy) consumers.add(f.container ?? commName(f.command));
  }
  if (consumers.size > 0) {
    parts.push(
      `Files open on it belong to: ${[...consumers].sort().join(", ")}.`,
    );
  }
  return parts.join(" ");
}

/* --------------------------------------------------------------- method API */

/** The slice of swamp's method context this model uses. swamp owns the real
 * object; this is a structural view of it, not a replacement. */
export interface MethodContext {
  globalArgs: {
    sshHost: string;
    sshUser?: string;
    fuseProxies?: string;
  };
  logger: { info: (message: string) => void };
  writeResource: (
    specName: string,
    dataName: string,
    payload: unknown,
  ) => Promise<unknown>;
}

const ReadersArgsSchema = z.object({
  sampleSeconds: z.number().min(1).max(600).default(15).describe(
    "Sampling window in seconds. Short windows catch bursts; 60s reflects steady load.",
  ),
  topN: z.number().min(1).default(15).describe("How many processes to keep"),
});
const OpenFilesArgsSchema = z.object({
  path: z.string().describe(
    "Absolute path prefix to report on, e.g. /mnt/disk4",
  ),
  limit: z.number().default(40).describe("Max files to report, largest first"),
});
const AttributeArgsSchema = z.object({
  target: z.string().describe(
    "Device (sdl, dm-3), Unraid array slot (disk4, cache), or mountpoint (/mnt/disk4)",
  ),
  sampleSeconds: z.number().min(1).max(600).default(15).describe(
    "Sampling window in seconds",
  ),
  topN: z.number().min(1).default(10).describe("How many readers to keep"),
  limit: z.number().min(0).default(20).describe("How many open files to keep"),
});

export type ReadersArgs = z.infer<typeof ReadersArgsSchema>;
export type OpenFilesArgs = z.infer<typeof OpenFilesArgsSchema>;
export type AttributeArgs = z.infer<typeof AttributeArgsSchema>;

function proxyList(context: MethodContext): string[] {
  return (context.globalArgs.fuseProxies ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------- impls */

export async function deviceMapImpl(run: SshRunner, context: MethodContext) {
  const { sshHost, sshUser } = context.globalArgs;
  const map = await probeDeviceMap(run, sshHost, sshUser ?? "root");
  for (const g of map.aliasGroups) {
    context.logger.info(
      `${g.physical}${g.slot ? ` (${g.slot})` : ""} is exported as ${
        g.layers.join(", ")
      }`,
    );
  }
  const handle = await context.writeResource("deviceMap", "current", map);
  return { dataHandles: [handle] };
}

export async function readersImpl(
  run: SshRunner,
  args: ReadersArgs,
  context: MethodContext,
) {
  const { sshHost, sshUser } = context.globalArgs;
  const result = await probeReaders(
    run,
    sshHost,
    sshUser ?? "root",
    args.sampleSeconds,
    args.topN,
    proxyList(context),
  );
  context.logger.info(
    `${result.totals.blockReadMBps} MB/s block reads, ${result.totals.proxyBlockReadMBps} MB/s of it through FUSE proxies`,
  );
  const handle = await context.writeResource("readers", "current", result);
  return { dataHandles: [handle] };
}

export async function openFilesImpl(
  run: SshRunner,
  args: OpenFilesArgs,
  context: MethodContext,
) {
  const { sshHost, sshUser } = context.globalArgs;
  const result = await probeOpenFiles(
    run,
    sshHost,
    sshUser ?? "root",
    args.path,
    proxyList(context),
    args.limit,
  );
  const handle = await context.writeResource(
    "openFiles",
    `open-files-${args.path.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}`,
    result,
  );
  return { dataHandles: [handle] };
}

export async function attributeImpl(
  run: SshRunner,
  args: AttributeArgs,
  context: MethodContext,
) {
  const { sshHost, sshUser } = context.globalArgs;
  const user = sshUser ?? "root";
  const proxies = proxyList(context);
  assertSafeTarget(args.target);

  const map = await probeDeviceMap(run, sshHost, user);
  const hit = map.devices.find((d) =>
    d.name === args.target || d.slot === args.target ||
    d.dmName === args.target || d.mountpoint === args.target
  );
  if (!hit) {
    throw new Error(
      `No block device, array slot or mountpoint on ${sshHost} matches ${
        JSON.stringify(args.target)
      }. Run device-map to see what exists.`,
    );
  }
  const physical = hit.physical ?? (hit.kind === "physical" ? hit.name : null);
  const layers = map.devices
    .filter((d) => physical !== null && d.physical === physical)
    .map((d) => d.name)
    .sort();
  // The mountpoint may sit on any layer of the same spindle, not on the layer
  // the caller happened to name.
  const mountpoint = hit.mountpoint ??
    map.devices.find((d) =>
      physical !== null && d.physical === physical && d.mountpoint
    )?.mountpoint ?? null;

  const readers = await probeReaders(
    run,
    sshHost,
    user,
    args.sampleSeconds,
    args.topN,
    proxies,
  );
  const openFiles = mountpoint
    ? await probeOpenFiles(run, sshHost, user, mountpoint, proxies, args.limit)
    : null;

  // A process is "on target" if it, or a proxy acting for it, holds a
  // descriptor under this mountpoint.
  const onTargetPids = new Set<number>();
  for (const f of openFiles?.files ?? []) {
    onTargetPids.add(f.pid);
    for (const c of f.consumers) onTargetPids.add(c.pid);
  }
  const topReaders = readers.readers.map((r) => ({
    ...r,
    onTarget: openFiles === null ? null : onTargetPids.has(r.pid),
  }));

  const summary = summarize(
    args.target,
    physical,
    layers,
    topReaders,
    openFiles?.files ?? [],
  );
  context.logger.info(summary);

  const handle = await context.writeResource("attribution", "current", {
    host: sshHost,
    target: args.target,
    physical,
    slot: hit.slot,
    layers,
    mountpoint,
    sampleSeconds: args.sampleSeconds,
    topReaders,
    openFiles: openFiles?.files ?? [],
    summary,
    timestamp: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

/* ------------------------------------------------------------------- model */

export const model = {
  type: "@magistr/diskio",
  version: "2026.08.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "deviceMap": {
      description:
        "Block-device topology: every dm/md/loop layer resolved to its physical spindle and Unraid array slot, plus the alias groups a per-device metric would double-count",
      schema: DeviceMapSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "readers": {
      description:
        "Processes ranked by disk I/O over a sampling window, with requested (rchar) and block (read_bytes) rates side by side and container attribution",
      schema: ReadersSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "openFiles": {
      description:
        "Files open under a path, with FUSE-held descriptors re-attributed to the containers that actually hold them",
      schema: OpenFilesSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "attribution": {
      description:
        "Full answer for one disk: what it physically is, who is reading it, and which files they have open",
      schema: AttributionSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    "device-map": {
      description:
        "Resolve the host's block stack: each dm-N/mdXpN/loopN down to the physical sdX/nvme it sits on, joined with Unraid array slots and mountpoints. Use the aliasGroups to collapse layers before ranking devices by utilisation — otherwise one spindle is counted two or three times.",
      arguments: z.object({}),
      execute: (_args: unknown, context: MethodContext) =>
        deviceMapImpl(defaultRunner, context),
    },
    "readers": {
      description:
        "Sample /proc/<pid>/io over a window and rank every process by disk I/O, attributing each to its container. Reports requested bytes (rchar) alongside block I/O (read_bytes): a FUSE daemon such as shfs carries the block I/O while the container that wanted the data shows up only in rchar, and cgroup/cadvisor metrics miss it entirely.",
      arguments: ReadersArgsSchema,
      execute: (args: ReadersArgs, context: MethodContext) =>
        readersImpl(defaultRunner, args, context),
    },
    "open-files": {
      description:
        "List files open under a path by walking /proc/<pid>/fd for every process. Unlike lsof on a FUSE mount — which names only the FUSE daemon — a proxy-held file is matched back to the containers holding the same file under their own mount path.",
      arguments: OpenFilesArgsSchema,
      execute: (args: OpenFilesArgs, context: MethodContext) =>
        openFilesImpl(defaultRunner, args, context),
    },
    "attribute": {
      description:
        "Answer 'what is reading this disk?' for one device, array slot or mountpoint: resolve it through the block stack, sample the readers, and list the open files with their real consumers. One method because the three probes are only meaningful together — the readers are unattributable without the device map, and the map is inert without the readers.",
      arguments: AttributeArgsSchema,
      execute: (args: AttributeArgs, context: MethodContext) =>
        attributeImpl(defaultRunner, args, context),
    },
  },
};
