import { z } from "npm:zod@4";
import { isValidSshHost, sshExec, sshExecRaw } from "./lib/ssh.ts";

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// deno-lint-ignore no-control-regex
const PATH_RE = /^[^\x00-\x1f\x7f`$\\;|&'"()*?[\]{}<>!#~\s]+$/;
// Linux interface name: max 15 chars, alphanumeric + underscore + dot + hyphen
const IFACE_RE = /^[a-zA-Z0-9_.-]{1,15}$/;
// Network namespace name — conservative, shell-safe.
const NETNS_RE = /^[a-zA-Z0-9_.-]{1,32}$/;
// IPv4 dotted-quad and CIDR (a.b.c.d/prefix) — for veth/host addressing.
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/** Add `k` to the last octet of a dotted-quad IPv4 address (no carry — `k`
 * must keep the octet in range, which holds for the /30 veth convention). */
export function addToIp(ip: string, k: number): string {
  const parts = ip.split(".");
  parts[3] = String(Number(parts[3]) + k);
  return parts.join(".");
}

/** Deterministic short hex hash (djb2). Derives a unique, <=15-char root-side
 * veth name from the per-VM namespace, so two VMs never collide on the veth
 * name in the root namespace regardless of their veth subnets. */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/** Derive the host↔namespace veth addresses + prefix from a veth subnet
 * (e.g. `10.0.1.0/30`): the root-side host IP (`.1`, the guest namespace's
 * gateway), the namespace-side IP (`.2`), and the CIDR prefix. Single source of
 * truth shared by {@link buildSetupTapScript} and {@link buildVerifyNetnsCmd} so
 * the addressing convention can never drift between wiring and verification. */
export function deriveVethAddrs(
  vethSubnet: string,
): { vethHostIp: string; vethNsIp: string; vethPrefix: string } {
  const vethNet = vethSubnet.split("/")[0];
  const vethPrefix = vethSubnet.split("/")[1];
  return {
    vethHostIp: addToIp(vethNet, 1), // root-side address (guest ns gateway)
    vethNsIp: addToIp(vethNet, 2), // namespace-side address
    vethPrefix,
  };
}

/** Inputs to {@link buildSetupTapScript}: the guest-facing tap (tapName/hostIp/
 * prefix/guestSubnet) plus, in netns mode, the namespace name and host↔ns veth
 * subnet. */
export interface TapSetupArgs {
  tapName: string;
  hostIp: string;
  prefix: number;
  guestSubnet: string;
  netns?: string;
  vethSubnet?: string;
}

/** Build the `setup_tap` shell script.
 *
 * With no `netns` the output is the historical root-namespace recipe, kept
 * byte-identical so the single-VM path never regresses. With `netns` set it
 * builds an isolated namespace so many clones of one base snapshot run without
 * overlap (the upstream Firecracker "network for clones" pattern): the guest's
 * baked tap/IP live inside the namespace, a veth pair links it to the host, and
 * a veth-subnet-scoped double MASQUERADE carries egress. Per-VM uniqueness comes
 * from `netns` + `vethSubnet`; the root-side veth name is derived from a hash of
 * the namespace so concurrent VMs never collide in the root namespace, and the
 * host-side rules are comment-tagged so kill_vmm can flush exactly this VM's. */
export function buildSetupTapScript(args: TapSetupArgs): string {
  const tap = shellEsc(args.tapName);
  const cidr = shellEsc(args.hostIp + "/" + args.prefix);
  const hostIp = shellEsc(args.hostIp);
  const guestSubnet = shellEsc(args.guestSubnet);

  if (!args.netns) {
    return [
      `ip link show ${tap} 2>/dev/null || ip tuntap add dev ${tap} mode tap`,
      `ip addr show ${tap} | grep -q ${hostIp} || ip addr add ${cidr} dev ${tap}`,
      `ip link set ${tap} up`,
      `sysctl -w net.ipv4.ip_forward=1 -q`,
      `iptables -t nat -C POSTROUTING -s ${guestSubnet} -j MASQUERADE 2>/dev/null || ` +
      `iptables -t nat -A POSTROUTING -s ${guestSubnet} -j MASQUERADE`,
      `echo ok`,
    ].join("\n");
  }

  const ns = shellEsc(args.netns);
  const nsx = `ip netns exec ${ns}`;
  const vethSubnet = args.vethSubnet ?? "10.0.0.0/30";
  const { vethHostIp, vethNsIp, vethPrefix } = deriveVethAddrs(vethSubnet);
  // Root-side veth name must be unique in the root ns and <=15 chars; derive it
  // from a hash of the (unique) namespace so distinct VMs never collide. The
  // ns-side peer is fixed (isolated in the namespace).
  const rootVeth = shellEsc(("fcv" + shortHash(args.netns)).slice(0, 15));
  const nsVeth = "fcveth0";
  const vethHostCidr = shellEsc(vethHostIp + "/" + vethPrefix);
  const vethNsCidr = shellEsc(vethNsIp + "/" + vethPrefix);
  const vethSubnetEsc = shellEsc(vethSubnet);
  const vethHostIpEsc = shellEsc(vethHostIp);
  // Tag host-namespace-side rules so kill_vmm can flush exactly this VM's rules.
  const cmt = shellEsc("fc-netns:" + args.netns);

  return [
    // Namespace + the guest's baked tap, INSIDE the namespace.
    `ip netns add ${ns} 2>/dev/null || true`,
    `${nsx} ip link set lo up`,
    `${nsx} ip link show ${tap} 2>/dev/null || ${nsx} ip tuntap add dev ${tap} mode tap`,
    `${nsx} ip addr add ${cidr} dev ${tap} 2>/dev/null || true`,
    `${nsx} ip link set ${tap} up`,
    // veth pair: root <-> namespace. Gate (re)creation on the NS-side peer
    // (fcveth0) — the end that determines guest egress — NOT the root-side veth.
    // Keying on the root-side name short-circuits when it lingers but the ns peer
    // is gone (e.g. a persisted/half-torn-down netns), leaving a permanently
    // uplink-less namespace that fabric_up would still count "ready". When the ns
    // peer is missing, drop any stale root-side half (atomic veth creation fails
    // if the root name already exists) and rebuild the pair.
    `${nsx} ip link show ${nsVeth} 2>/dev/null || { ip link del ${rootVeth} 2>/dev/null || true; ip link add ${rootVeth} type veth peer name ${nsVeth} netns ${ns}; }`,
    `ip addr add ${vethHostCidr} dev ${rootVeth} 2>/dev/null || true`,
    `ip link set ${rootVeth} up`,
    `${nsx} ip addr add ${vethNsCidr} dev ${nsVeth} 2>/dev/null || true`,
    `${nsx} ip link set ${nsVeth} up`,
    `${nsx} ip route replace default via ${vethHostIpEsc}`,
    // Forwarding: host + inside the namespace (tap <-> veth).
    `sysctl -w net.ipv4.ip_forward=1 -q`,
    `${nsx} sysctl -w net.ipv4.ip_forward=1 -q`,
    // In-namespace egress NAT: guest subnet out via the ns-side veth.
    `${nsx} iptables -t nat -C POSTROUTING -s ${guestSubnet} -o ${nsVeth} -j MASQUERADE 2>/dev/null || ` +
    `${nsx} iptables -t nat -A POSTROUTING -s ${guestSubnet} -o ${nsVeth} -j MASQUERADE`,
    // Scoped FORWARD inside the namespace (never -P FORWARD ACCEPT).
    `${nsx} iptables -C FORWARD -i ${tap} -o ${nsVeth} -j ACCEPT 2>/dev/null || ${nsx} iptables -A FORWARD -i ${tap} -o ${nsVeth} -j ACCEPT`,
    `${nsx} iptables -C FORWARD -i ${nsVeth} -o ${tap} -j ACCEPT 2>/dev/null || ${nsx} iptables -A FORWARD -i ${nsVeth} -o ${tap} -j ACCEPT`,
    // Host egress NAT: veth subnet out via the default-route interface.
    // Comment-tagged so kill_vmm can flush exactly this VM's host-side rules.
    `UP=$(ip route show default | awk '{print $5; exit}')`,
    // Fail LOUD when the host has no default route: a worker with no host uplink
    // can never reach the API, and the in-namespace verify gate cannot observe a
    // missing HOST egress, so silently skipping these rules would mask a dead
    // worker as "ready". Abort instead of building an `-o ""` MASQUERADE.
    `[ -n "$UP" ] || { echo "setup_tap: no host default route (no uplink)" >&2; exit 1; }`,
    `iptables -t nat -C POSTROUTING -s ${vethSubnetEsc} -o "$UP" -m comment --comment ${cmt} -j MASQUERADE 2>/dev/null || ` +
    `iptables -t nat -A POSTROUTING -s ${vethSubnetEsc} -o "$UP" -m comment --comment ${cmt} -j MASQUERADE`,
    // Scoped host FORWARD for the root-side veth (never -P FORWARD ACCEPT).
    `iptables -C FORWARD -i ${rootVeth} -m comment --comment ${cmt} -j ACCEPT 2>/dev/null || iptables -A FORWARD -i ${rootVeth} -m comment --comment ${cmt} -j ACCEPT`,
    `iptables -C FORWARD -o ${rootVeth} -m comment --comment ${cmt} -j ACCEPT 2>/dev/null || iptables -A FORWARD -o ${rootVeth} -m comment --comment ${cmt} -j ACCEPT`,
    `echo ok`,
  ].join("\n");
}

/** Build the readiness-assertion script for a fabric worker's namespace. After
 * {@link buildSetupTapScript} runs, confirm — INSIDE the worker's netns — that
 * the host↔ns veth (`fcveth0`) carries its address, the guest tap is up, and the
 * default route points at the veth gateway. Exits non-zero with a diagnostic on
 * the first missing piece, so `bringUpWorker` can refuse to count a half-built
 * netns as "ready" (the uplink race). Pure builder; every interpolated value is
 * shellEsc'd, IP/route matches are literal + word-bounded (`grep -qwF`). Checks
 * host↔netns wiring only — NOT in-guest routing or end-to-end reachability. */
export function buildVerifyNetnsCmd(
  netns: string,
  vethSubnet: string,
  tapName: string,
): string {
  const ns = shellEsc(netns);
  const nsx = `ip netns exec ${ns}`;
  const tap = shellEsc(tapName);
  const nsVeth = "fcveth0";
  const { vethHostIp, vethNsIp } = deriveVethAddrs(vethSubnet);
  const nsIp = shellEsc(vethNsIp);
  const route = "default via " + vethHostIp;
  const gw = shellEsc(route);
  // Diagnostics interpolate the shellEsc'd handles (${ns}/${tap}) so the builder
  // is safe by construction regardless of how a caller sourced netns/tapName; the
  // IP/route fragments are deriveVethAddrs numerics (no shell metachars).
  return [
    `${nsx} ip -o -4 addr show dev ${nsVeth} 2>/dev/null | grep -qwF ${nsIp} || ` +
    `{ echo "verify_netns ${ns}: ${nsVeth} missing addr ${vethNsIp}" >&2; exit 1; }`,
    `${nsx} ip link show ${tap} up 2>/dev/null | grep -qwF ${tap} || ` +
    `{ echo "verify_netns ${ns}: tap ${tap} not up" >&2; exit 1; }`,
    `${nsx} ip route show default 2>/dev/null | grep -qwF ${gw} || ` +
    `{ echo "verify_netns ${ns}: no ${route}" >&2; exit 1; }`,
    `echo verified`,
  ].join("\n");
}

/** The `ip netns exec <netns> ` command prefix, or an empty string when no
 * namespace is set. Used to launch processes (firecracker, the task server)
 * inside a per-VM namespace. */
export function netnsExecPrefix(netns?: string): string {
  return netns ? `ip netns exec ${shellEsc(netns)} ` : "";
}

const GlobalArgsSchema = z.object({
  host: z.string().describe(
    "SSH host/IP of the machine running Firecracker — host key verification is disabled; use on trusted networks only",
  ),
  user: z.string().default("root").describe("SSH username (default: root)"),
  socketPath: z.string().regex(PATH_RE).describe(
    "Path to the Firecracker Unix socket on the remote host (e.g. /run/firecracker.socket). One model instance = one microVM socket.",
  ),
  netns: z.union([z.literal(""), z.string().regex(NETNS_RE)]).optional()
    .describe(
      "Optional Linux network namespace for this microVM. When set, start_vmm launches Firecracker inside it (ip netns exec) and kill_vmm tears it down — lets many clones of one base snapshot run without IP/gateway overlap. Pair with setup_tap's netns mode. Omit for the single-VM root-namespace path (unchanged).",
    ),
});

// --- Output schemas ---

const StatusSchema = z.object({
  instanceInfo: z.record(z.string(), z.unknown()),
  vmState: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
});

const MachineConfigSchema = z.object({
  vcpu_count: z.number().optional(),
  mem_size_mib: z.number().optional(),
  smt: z.boolean().optional(),
  track_dirty_pages: z.boolean().optional(),
  timestamp: z.string(),
});

const ActionResultSchema = z.object({
  action: z.string(),
  success: z.boolean(),
  message: z.string(),
  timestamp: z.string(),
});

// --- sshCurl helpers ---

type CurlResult = { status: number; body: string };

async function sshCurl(
  host: string,
  user: string,
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CurlResult> {
  const bodyJson = body !== undefined ? JSON.stringify(body) : undefined;

  let cmd = `curl -sS --unix-socket ${
    shellEsc(socketPath)
  } http://localhost${path}`;
  cmd += ` -X ${shellEsc(method)}`;
  cmd += ` -H 'Accept: application/json'`;
  if (bodyJson !== undefined) {
    cmd += ` -H 'Content-Type: application/json'`;
    cmd += ` -d ${shellEsc(bodyJson)}`;
  }
  cmd += ` --max-time 30`;
  cmd += ` -w '\\n__HTTP_STATUS__%{http_code}'`;

  const result = await sshExec(host, user, cmd);
  const stdout = result.stdout;

  const statusMatch = stdout.match(/\n__HTTP_STATUS__(\d{3})$/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const responseBody = statusMatch
    ? stdout.slice(0, statusMatch.index)
    : stdout;

  if (status >= 400) {
    let faultMessage = responseBody.trim();
    try {
      const parsed = JSON.parse(responseBody);
      if (parsed.fault_message) faultMessage = parsed.fault_message;
    } catch { /* keep raw body */ }
    throw new Error(
      `Firecracker HTTP ${status} at ${method} ${path}: ${faultMessage}`,
    );
  }

  return { status, body: responseBody };
}

async function sshCurlJson<T>(
  host: string,
  user: string,
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await sshCurl(host, user, socketPath, method, path, body);
  if (!result.body.trim()) return {} as T;
  try {
    return JSON.parse(result.body) as T;
  } catch {
    throw new Error(
      `Firecracker ${method} ${path} returned non-JSON: ${
        result.body.slice(0, 200)
      }`,
    );
  }
}

// --- Fast task fabric: warm worker-VM pool + shared queue (factory pattern) ---
//
// `fabric_up` is a rule-6 factory: ONE call fans out N warm worker VMs (each in
// its own netns, restored from the snapshot, running the looping AGENT_SCRIPT)
// that pull from a SHARED host queue served by a per-VM daemon. `submit`
// enqueues (non-blocking, any time — including while tasks run); `poll` collects
// results by id; `fabric_down` reaps the pool. submit/poll touch only the host
// queue, never the minutes-long agent run, so they neither hold the swamp
// __global__ lock for a task's duration nor need a per-task workflow.

/** Per-fabric shared host paths under one queue root. */
export function fabricPaths(queueRoot: string): {
  queueDir: string;
  claimedDir: string;
  resultsDir: string;
  failedDir: string;
  serverPath: string;
} {
  return {
    queueDir: `${queueRoot}/queue`,
    claimedDir: `${queueRoot}/claimed`,
    resultsDir: `${queueRoot}/results`,
    failedDir: `${queueRoot}/failed`,
    serverPath: `${queueRoot}/fabric-server.py`,
  };
}

/** The exact JSON object `submit` serializes into the queue for one task. The
 * OAuth token is deliberately ABSENT here — the daemon injects it at serve time —
 * so this is the credential-hygiene boundary the queue file must never cross.
 * Pure; unit-tested. */
/** UTF-8-safe base64 encode. `btoa` only handles Latin1, so task prompts that
 * embed non-ASCII file content (emoji, box-drawing, CJK, …) throw "characters
 * outside of the Latin1 range". Encode to UTF-8 bytes first. */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function buildQueuePayload(
  t: { prompt: string; model?: string; effort?: string; gitRepoUrl?: string },
  id: string,
): {
  id: string;
  prompt: string;
  model: string;
  effort: string;
  gitRepoUrl: string;
} {
  return {
    id,
    prompt: t.prompt,
    model: t.model ?? "",
    effort: t.effort ?? "",
    gitRepoUrl: t.gitRepoUrl ?? "",
  };
}

/** Parse the `poll` daemon stdout (`===id===\n<base64>\n` lines + `PENDING=N`)
 * into a decoded id->result map and the pending count. Pure; unit-tested. */
export function parsePollOutput(
  stdout: string,
): { completed: Record<string, string>; pending: number } {
  const completed: Record<string, string> = {};
  const re = /===(.+?)===\n([^\n]*)\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    try {
      completed[m[1]] = new TextDecoder().decode(
        Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)),
      );
    } catch {
      completed[m[1]] = "";
    }
  }
  const pendingMatch = stdout.match(/PENDING=(\d+)/);
  return { completed, pending: pendingMatch ? Number(pendingMatch[1]) : 0 };
}

/** Worker index from a netns name like `fcw-3` (or a hyphenated prefix, `fc-w-3`):
 * the trailing hyphen-delimited integer, or null if absent / out of [1,256]. Used
 * by fabric_recycle + fabric_down to map a netns back to its worker slot. */
export function workerIndexFromNetns(ns: string): number | null {
  const i = Number(ns.split("-").pop());
  return Number.isInteger(i) && i >= 1 && i <= 256 ? i : null;
}

/** Shell pipeline that lists the live worker netns for `netnsPrefix` by
 * enumerating `ip netns list` + any leftover socket/pid files. fabric_down uses
 * it to reap the ACTUAL pool (not a caller-supplied count). Exported so its shell
 * syntax is regression-tested (`bash -n`). */
export function buildDiscoverWorkersCmd(netnsPrefix: string): string {
  const p = netnsPrefix;
  // Escape regex metachars (NETNS_RE permits '.') so a dotted prefix can't loosen
  // the discovery filter into matching unrelated namespaces.
  const pRe = p.replace(/[.\\+*?^$()[\]{}|]/g, "\\$&");
  // Single line on purpose: a brace group + a pipe split across newlines is a
  // bash syntax error (a pipe may neither start nor be orphaned after `}` on a
  // new line). Keep the whole pipeline on one line.
  const sources =
    `ip netns list 2>/dev/null | awk '{print $1}'; ls -1d /tmp/${p}-*.socket /tmp/${p}-*.server.pid 2>/dev/null | xargs -r -n1 basename | sed -e 's/[.]socket$//' -e 's/[.]server[.]pid$//'`;
  return `{ ${sources}; } | grep -E ${shellEsc(`^${pRe}-[0-9]+$`)} | sort -u`;
}

/** Build the `start_vmm` shell command. Extracted so `fabric_up` reuses the
 * exact VMM-launch recipe the `start_vmm` method uses (no parallel logic). */
export function buildStartVmmCmd(
  socketPath: string,
  netns?: string,
  logPath?: string,
  vsockUdsPath?: string,
): string {
  const pidFile = socketPath + ".pid";
  const socketBasename = socketPath.split("/").pop() ?? "firecracker";
  const lp = logPath ?? `/var/log/${socketBasename}.log`;
  const vsockCleanup = vsockUdsPath
    ? `rm -f ${shellEsc(vsockUdsPath)} ${vsockUdsPath}_*;`
    : "";
  return [
    `if [ -f ${shellEsc(pidFile)} ]; then`,
    `  PID=$(cat ${shellEsc(pidFile)});`,
    `  if kill -0 "$PID" 2>/dev/null && test -S ${shellEsc(socketPath)}; then`,
    `    echo "alive:$PID"; exit 0;`,
    `  fi;`,
    `fi`,
    `rm -f ${shellEsc(socketPath)} ${shellEsc(pidFile)}`,
    vsockCleanup,
    `setsid ${netnsExecPrefix(netns)}firecracker --api-sock ${
      shellEsc(socketPath)
    } --level Error </dev/null >${shellEsc(lp)} 2>&1 &`,
    `FC_PID=$!`,
    `echo $FC_PID > ${shellEsc(pidFile)}`,
    `for i in $(seq 1 30); do test -S ${
      shellEsc(socketPath)
    } && break; sleep 0.1; done`,
    `test -S ${
      shellEsc(socketPath)
    } || { echo "socket not ready after 3s"; exit 1; }`,
    `echo "started:$FC_PID"`,
  ].join("\n");
}

/** Build the `kill_vmm` teardown command. Extracted so `fabric_down` reaps each
 * worker exactly as `kill_vmm` does (PID kill + socket + vsock + netns + NAT). */
export function buildKillVmmCmd(
  socketPath: string,
  netns?: string,
  vsockUdsPath?: string,
): string {
  const pidFile = socketPath + ".pid";
  const vsock = vsockUdsPath ?? "";
  const vsockCleanup = vsock
    ? `rm -f ${shellEsc(vsock)} ${vsock}_* ${shellEsc(vsock + ".task.json")} ${
      shellEsc(vsock + ".result.txt")
    };`
    : "";
  const cmt = shellEsc("fc-netns:" + (netns ?? ""));
  const netnsCleanup = netns
    ? [
      `ip netns del ${shellEsc(netns)} 2>/dev/null || true`,
      `for tc in nat:POSTROUTING filter:FORWARD; do`,
      `  T=\${tc%%:*}; C=\${tc##*:};`,
      `  while N=$(iptables -t "$T" -L "$C" --line-numbers -n 2>/dev/null | grep -F ${cmt} | head -1 | awk '{print $1}'); [ -n "$N" ]; do`,
      `    iptables -t "$T" -D "$C" "$N" 2>/dev/null || break;`,
      `  done;`,
      `done`,
    ].join("\n")
    : "";
  return [
    `if [ -f ${shellEsc(pidFile)} ]; then`,
    `  PID=$(cat ${shellEsc(pidFile)});`,
    `  kill "$PID" 2>/dev/null; sleep 0.5;`,
    `  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null;`,
    `  rm -f ${shellEsc(pidFile)};`,
    `elif test -S ${shellEsc(socketPath)}; then`,
    `  PID=$(fuser ${shellEsc(socketPath)} 2>/dev/null | tr -d ' ');`,
    `  [ -n "$PID" ] && { kill "$PID" 2>/dev/null; sleep 0.5; kill -9 "$PID" 2>/dev/null; };`,
    `fi`,
    `rm -f ${shellEsc(socketPath)}`,
    vsockCleanup,
    netnsCleanup,
    `echo ok`,
  ].join("\n");
}

/** The fabric queue daemon. Serves the next QUEUED task (atomic claim) on
 * GET /task with the OAuth token injected at serve time, and stores POSTed
 * results by id on POST /result?id=. One instance runs per worker netns; all
 * instances share the queue/claimed/results dirs on the host filesystem
 * (netns isolates only the network, so the shared dirs work across workers). */
export const FABRIC_SERVER_PY = `#!/usr/bin/env python3
import os, json, glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

QUEUE_DIR = os.environ["FC_QUEUE_DIR"]
CLAIMED_DIR = os.environ["FC_CLAIMED_DIR"]
RESULTS_DIR = os.environ["FC_RESULTS_DIR"]
FAILED_DIR = os.environ.get("FC_FAILED_DIR", os.path.join(os.path.dirname(CLAIMED_DIR), "failed"))
TOKEN = os.environ.get("FC_OAUTH_TOKEN", "")
BIND_IP = os.environ.get("FC_BIND_IP", "172.16.0.1")
BIND_PORT = int(os.environ.get("FC_BIND_PORT", "8080"))
NETNS = os.environ.get("FC_NETNS", "w")

def claim_next():
    for path in sorted(glob.glob(os.path.join(QUEUE_DIR, "*.json"))):
        # Encode the claiming worker's netns so a watchdog (fabric_recycle) can
        # tell which worker is stuck on a claimed task; utime stamps the claim
        # time so stall age = now - mtime.
        dst = os.path.join(CLAIMED_DIR, NETNS + "__" + os.path.basename(path))
        try:
            os.rename(path, dst)
        except OSError:
            continue
        os.utime(dst, None)
        try:
            with open(dst) as f:
                return json.load(f)
        except Exception:
            # Poison task (malformed JSON). Quarantine it so it never wedges a
            # pool slot or re-fails every recycle window, surface an error result
            # keyed by the id parsed from the filename, then keep serving the
            # next queued task (don't abandon the whole poll on one bad file).
            base = os.path.basename(dst)
            tid = base[len(NETNS) + 2:].rsplit(".json", 1)[0].split("-", 1)[-1]
            try:
                with open(os.path.join(RESULTS_DIR, tid + ".txt"), "w") as rf:
                    rf.write("ERROR: malformed task json")
            except Exception:
                pass
            try:
                os.replace(dst, os.path.join(FAILED_DIR, base))
            except Exception:
                try:
                    os.unlink(dst)
                except OSError:
                    pass
            continue
    return None

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()
    def do_GET(self):
        if not self.path.startswith("/task"):
            self.send_response(404)
            self.end_headers()
            return
        task = claim_next()
        if task is None:
            self.send_response(204)
            self.end_headers()
            return
        task["token"] = TOKEN
        body = json.dumps(task).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        if not self.path.startswith("/result"):
            self.send_response(404)
            self.end_headers()
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id", [""])[0]) or self.headers.get("X-Task-Id", "")
        n = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(n) if n else b""
        if tid:
            # Only THIS worker's OWN-netns claim for this id counts. Atomically
            # unlink it first as the gate to writing the result: if our claim is
            # gone (fabric_recycle re-queued it and another worker re-claimed it),
            # this is a stale late result -> drop it. Scoping the match to our
            # NETNS prefix means a slow/late worker can never delete another
            # worker's freshly re-claimed file (the requeue-race clobber).
            claimed = None
            for c in sorted(glob.glob(
                os.path.join(CLAIMED_DIR, NETNS + "__*" + tid + ".json"))):
                try:
                    os.unlink(c)
                    claimed = c
                    break
                except OSError:
                    pass
            if claimed is not None:
                tmp = os.path.join(RESULTS_DIR, tid + ".txt.tmp")
                with open(tmp, "wb") as f:
                    f.write(body)
                os.rename(tmp, os.path.join(RESULTS_DIR, tid + ".txt"))
        self.send_response(200)
        self.end_headers()

ThreadingHTTPServer((BIND_IP, BIND_PORT), H).serve_forever()
`;

/** Build the command that deploys + starts the fabric daemon inside a worker's
 * netns, bound to the guest gateway, sharing the fabric queue dirs. */
export function buildDeployFabricCmd(
  netns: string,
  bindIp: string,
  port: number,
  paths: ReturnType<typeof fabricPaths>,
  oauthToken: string,
  pidFile: string,
): string {
  const b64 = btoa(FABRIC_SERVER_PY);
  return [
    `mkdir -p ${shellEsc(paths.queueDir)} ${shellEsc(paths.claimedDir)} ${
      shellEsc(paths.resultsDir)
    } ${shellEsc(paths.failedDir)}`,
    `echo ${shellEsc(b64)} | base64 -d > ${shellEsc(paths.serverPath)}`,
    `if [ -f ${shellEsc(pidFile)} ]; then kill "$(cat ${
      shellEsc(pidFile)
    })" 2>/dev/null || true; rm -f ${shellEsc(pidFile)}; fi`,
    `export FC_QUEUE_DIR=${shellEsc(paths.queueDir)} FC_CLAIMED_DIR=${
      shellEsc(paths.claimedDir)
    } FC_RESULTS_DIR=${shellEsc(paths.resultsDir)} FC_FAILED_DIR=${
      shellEsc(paths.failedDir)
    }`,
    `export FC_OAUTH_TOKEN=${shellEsc(oauthToken)} FC_BIND_IP=${
      shellEsc(bindIp)
    } FC_BIND_PORT=${port} FC_NETNS=${shellEsc(netns)}`,
    `setsid ${netnsExecPrefix(netns)}python3 ${
      shellEsc(paths.serverPath)
    } </dev/null >/dev/null 2>&1 & echo $! > ${shellEsc(pidFile)}`,
    `for i in $(seq 1 30); do ${
      netnsExecPrefix(netns)
    }python3 -c "import socket;s=socket.socket();s.settimeout(0.1);s.connect((${
      JSON.stringify(bindIp)
    },${port}))" 2>/dev/null && break; sleep 0.1; done`,
    `echo deployed`,
  ].join("\n");
}

/** Options for bringing up one fabric worker (shared by fabric_up + fabric_recycle). */
export interface FabricWorkerOpts {
  netnsPrefix: string;
  tapName: string;
  tapIp: string;
  guestSubnet: string;
  port: number;
  oauthToken: string;
  snapshotPath: string;
  memFilePath: string;
}

/** Bring up (or restart) worker `i`: clean any stale/wedged instance, set up its
 * netns tap, start a fresh VMM, deploy the fabric daemon on the shared queue, and
 * restore the warm snapshot. Reused by fabric_up (initial pool) and fabric_recycle
 * (restart a stalled worker) — idempotent thanks to the leading kill. */
export async function bringUpWorker(
  host: string,
  user: string,
  i: number,
  o: FabricWorkerOpts,
  paths: ReturnType<typeof fabricPaths>,
): Promise<string> {
  const netns = `${o.netnsPrefix}-${i}`;
  const socketPath = `/tmp/${o.netnsPrefix}-${i}.socket`;
  const vethSubnet = `10.0.${i}.0/30`;
  const srvPid = `/tmp/${o.netnsPrefix}-${i}.server.pid`;
  const setupTap = buildSetupTapScript({
    tapName: o.tapName,
    hostIp: o.tapIp,
    prefix: 24,
    guestSubnet: o.guestSubnet,
    netns,
    vethSubnet,
  });
  const verifyNetns = buildVerifyNetnsCmd(netns, vethSubnet, o.tapName);
  // Wire the netns, then VERIFY the veth uplink + default route actually exist
  // before booting the VM. setup_tap can intermittently leave a half-built netns
  // (missing fcveth0 / default route); without this gate that worker is counted
  // "ready" and fails every guest task with ConnectionRefused. A clean kill_vmm
  // (`ip netns del`) at the top of each attempt resets state between retries.
  // If it never comes up, throw — fabric_up records the worker as a failure
  // (Promise.allSettled) and fabric_recycle re-attempts it, instead of a silent
  // half-built pool member.
  const MAX_SETUP_ATTEMPTS = 3; // initial + 2 retries
  let wired = false;
  for (let attempt = 1; attempt <= MAX_SETUP_ATTEMPTS; attempt++) {
    await sshExec(host, user, buildKillVmmCmd(socketPath, netns));
    try {
      await sshExec(host, user, setupTap);
      const v = await sshExecRaw(host, user, verifyNetns);
      if (v.code === 0) {
        wired = true;
        break;
      }
      console.error(
        `bringUpWorker ${netns}: netns verify failed (attempt ${attempt}/${MAX_SETUP_ATTEMPTS}): ${
          (v.stderr || v.stdout).trim()
        }`,
      );
    } catch (e) {
      // setup_tap itself failed (e.g. the host has no default route).
      console.error(
        `bringUpWorker ${netns}: setup_tap failed (attempt ${attempt}/${MAX_SETUP_ATTEMPTS}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  if (!wired) {
    throw new Error(
      `bringUpWorker ${netns}: veth uplink + default route never came up after ${MAX_SETUP_ATTEMPTS} setup_tap attempt(s)`,
    );
  }
  await sshExec(host, user, buildStartVmmCmd(socketPath, netns));
  await sshExec(
    host,
    user,
    buildDeployFabricCmd(netns, o.tapIp, o.port, paths, o.oauthToken, srvPid),
  );
  await sshCurl(host, user, socketPath, "PUT", "/snapshot/load", {
    snapshot_path: o.snapshotPath,
    mem_file_path: o.memFilePath,
    resume_vm: true,
  });
  return netns;
}

// --- Agent script (shared by build_ubuntu_rootfs + update_agent_script) ---
//
// Runs as PID 1 inside the Ubuntu guest (booted with init=/opt/fc-agent.sh).
// It mounts its own pseudo-filesystems, brings up the TAP NIC, seeds entropy
// for the old guest kernel, polls the host task server (172.16.0.1:8080) for a task,
// runs Claude Code authenticated SOLELY via CLAUDE_CODE_OAUTH_TOKEN, and POSTs
// the result back. As PID 1 it must never exit, so it idles at the end.
export const AGENT_SCRIPT = `#!/bin/sh
# PID 1 under Firecracker (init=/opt/fc-agent.sh): mount our own fs, never exit.
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true

SAY() { printf "[agent] %s\\n" "$*" > /dev/ttyS0 2>/dev/null; }
SAY "agent started (ubuntu)"

export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
mkdir -p /workspace
export HOME=/workspace
# The agent is PID 1 / root; IS_SANDBOX=1 lets claude accept
# --dangerously-skip-permissions as root (the microVM is the sandbox).
export IS_SANDBOX=1

ip link set lo up 2>/dev/null || true
ip link set eth0 up 2>/dev/null || true
ip addr add 172.16.0.2/24 dev eth0 2>/dev/null || true
ip route add default via 172.16.0.1 2>/dev/null || true
printf "nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n" > /etc/resolv.conf
SAY "network up"

SAY "seeding entropy"
python3 -c "
import struct, os, fcntl
RNDADDENTROPY = 0x40085203
data = open('/dev/urandom','rb').read(64)
buf = bytearray(struct.pack('ii',512,64)+data)
fd = os.open('/dev/random', os.O_WRONLY)
fcntl.ioctl(fd, RNDADDENTROPY, buf)
os.close(fd)
" 2>/dev/null || true

# Sync the clock once from the task server's Date header (HEAD, does not consume a task).
DATE_HDR=\$(curl -sfI -m 10 http://172.16.0.1:8080/task 2>/dev/null | grep -i "^date:" | sed "s/^[^:]*: *//" | tr -d "\\r")
[ -n "\$DATE_HDR" ] && date -s "\$DATE_HDR" >/dev/null 2>&1 || true
SAY "clock=\$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Auth comes ONLY from CLAUDE_CODE_OAUTH_TOKEN. Config holds the onboarding flag only.
printf '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' > /workspace/.claude.json

# WARM WORKER LOOP: poll for a task -> run it -> POST the result tagged with its
# id -> loop back and poll for the next one. The VM is reused across many tasks
# with NO per-task restore (warm-VM reuse). PID 1 never exits: the loop is
# infinite, idle-polling when the queue is empty. Backward-compatible with a
# single-shot task server (it unlinks the one task after serving, so the next
# poll is empty and the worker simply idle-polls; an absent id is fine).
SAY "worker ready; polling for tasks"
while true; do
  TASK_JSON=""
  while true; do
    TASK_JSON=\$(curl -s -m 15 http://172.16.0.1:8080/task 2>/dev/null)
    [ -n "\$TASK_JSON" ] && break
    sleep 1
  done

  printf "%s" "\$TASK_JSON" > /tmp/task.json
  ID=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('id',''))" 2>/dev/null)
  PROMPT=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('prompt',''))" 2>/dev/null)
  TOKEN=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('token',''))" 2>/dev/null)
  GIT_URL=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('gitRepoUrl',''))" 2>/dev/null)
  MODEL=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('model',''))" 2>/dev/null)
  EFFORT=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('effort',''))" 2>/dev/null)
  SAY "got task \${ID:-?}"

  export CLAUDE_CODE_OAUTH_TOKEN="\$TOKEN"

  # Fresh per-task workspace so a reused worker never leaks state between tasks.
  WORKDIR="/workspace/job-\${ID:-x}"
  rm -rf "\$WORKDIR"; mkdir -p "\$WORKDIR"
  if [ -n "\$GIT_URL" ]; then
    git clone --depth 1 -- "\$GIT_URL" "\$WORKDIR/repo" >/dev/null 2>&1 && WORKDIR="\$WORKDIR/repo"
  fi

  SAY "running claude task=\${ID:-?} model=\${MODEL:-default} effort=\${EFFORT:-default}"
  cd "\$WORKDIR"
  # --dangerously-skip-permissions: the microVM itself is the sandbox, so the
  # agent runs unattended without permission prompts (which would hang --print).
  RESULT=\$(claude --print --dangerously-skip-permissions \${MODEL:+--model "\$MODEL"} \${EFFORT:+--effort "\$EFFORT"} "\$PROMPT" 2>&1)
  CLAUDE_EXIT=\$?
  SAY "claude task=\${ID:-?} exit=\$CLAUDE_EXIT len=\$(printf "%s" "\$RESULT" | wc -c)"
  [ \$CLAUDE_EXIT -ne 0 ] && RESULT="ERROR: claude exit=\$CLAUDE_EXIT: \$RESULT"

  printf "%s" "\$RESULT" > /tmp/result.txt
  # Tag the result with the task id (query param + header) so a queue server can
  # correlate it; a single-shot server that ignores the id still gets the body.
  curl -s -m 20 -X POST --data-binary @/tmp/result.txt -H "Content-Type: text/plain" -H "X-Task-Id: \${ID}" -H "Expect:" "http://172.16.0.1:8080/result?id=\${ID}" >/dev/null 2>&1
  cd /
  rm -rf "/workspace/job-\${ID:-x}"
  SAY "task \${ID:-?} done; polling for next"
done
`;

// --- Model ---

/**
 * The `@magistr/firecracker` model — Firecracker microVM lifecycle over SSH +
 * the Unix-socket REST API. One model instance maps to one microVM socket:
 * configure machine/boot/drives/network, start/stop/pause/resume, snapshot and
 * restore, precision-kill the VMM, and bootstrap the host (install Firecracker,
 * guest kernel, TAP, Ubuntu rootfs + Claude Code agent).
 */
export const model = {
  type: "@magistr/firecracker",
  version: "2026.06.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Instance info and current VM state",
      schema: StatusSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    machineConfig: {
      description: "Machine configuration (vCPUs, memory)",
      schema: MachineConfigSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    action: {
      description: "Result of a lifecycle action",
      schema: ActionResultSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
    fabric: {
      description: "Fabric pool state (queueRoot, concurrency, workers).",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    submitted: {
      description: "Ids of tasks enqueued onto the fabric in a submit call.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "24h",
      garbageCollection: 20,
    },
    results: {
      description:
        "Completed fabric task results (id -> output) + pending count.",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "24h",
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-ssh-host": {
      description:
        "The host global argument must be a non-empty SSH host/IP, not a placeholder",
      labels: ["policy"],
      execute: (context) => {
        const host = context.globalArgs?.host;
        if (!isValidSshHost(host)) {
          return {
            pass: false,
            errors: [
              `globalArgs.host must be a non-empty SSH host/IP (got ${
                JSON.stringify(host)
              })`,
            ],
          };
        }
        return { pass: true };
      },
    },
    "host-reachable": {
      description:
        "The Firecracker host must answer over SSH before a method mutates it",
      labels: ["live"],
      execute: async (context) => {
        const host = context.globalArgs?.host;
        const user = context.globalArgs?.user ?? "root";
        if (!isValidSshHost(host)) {
          return { pass: false, errors: ["globalArgs.host is not set"] };
        }
        const res = await sshExecRaw(host, user, "echo ready");
        if (res.code !== 0 || res.stdout.trim() !== "ready") {
          return {
            pass: false,
            errors: [
              `SSH host ${host} is not reachable (exit ${res.code}): ${
                res.stderr.trim().slice(-200)
              }`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    // ==================== Inspection ====================

    status: {
      description: "Get instance info and VM state",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const instanceInfo = await sshCurlJson<Record<string, unknown>>(
          host,
          user,
          socketPath,
          "GET",
          "/",
        );
        // GET /vm is only valid for running/paused VMs; fall back gracefully pre-boot
        let vmState: Record<string, unknown> = {};
        try {
          vmState = await sshCurlJson<Record<string, unknown>>(
            host,
            user,
            socketPath,
            "GET",
            "/vm",
          );
        } catch { /* pre-boot: state already in instanceInfo */ }
        context.logger.info(
          `state: ${instanceInfo.state ?? vmState.state ?? "unknown"}`,
        );
        const data = {
          instanceInfo,
          vmState,
          timestamp: new Date().toISOString(),
        };
        const handle = await context.writeResource("status", "current", data);
        return { dataHandles: [handle] };
      },
    },

    // ==================== Pre-boot configuration ====================

    configure: {
      description:
        "Set machine vCPUs and memory. PRE-BOOT ONLY — must be called before start. Returns HTTP 400 (fault_message) if VM is already running.",
      arguments: z.object({
        vcpuCount: z.number().int().min(1).max(32).describe(
          "vCPU count (1–32)",
        ),
        memSizeMib: z.number().int().min(128).describe(
          "Memory in MiB (minimum 128)",
        ),
        smt: z.boolean().optional().default(false).describe(
          "Enable simultaneous multi-threading",
        ),
        trackDirtyPages: z.boolean().optional().default(false).describe(
          "Enable dirty-page tracking (needed for live migration)",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PUT", "/machine-config", {
          vcpu_count: args.vcpuCount,
          mem_size_mib: args.memSizeMib,
          smt: args.smt,
          track_dirty_pages: args.trackDirtyPages,
        });
        context.logger.info(
          `machine-config set: ${args.vcpuCount} vCPU, ${args.memSizeMib} MiB`,
        );
        const handle = await context.writeResource("machineConfig", "current", {
          vcpu_count: args.vcpuCount,
          mem_size_mib: args.memSizeMib,
          smt: args.smt,
          track_dirty_pages: args.trackDirtyPages,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    set_boot: {
      description:
        "Set boot source (kernel image path, boot args, optional initrd). PRE-BOOT ONLY.",
      arguments: z.object({
        kernelImagePath: z.string().regex(PATH_RE).describe(
          "Path to the uncompressed kernel image on the Firecracker host",
        ),
        bootArgs: z.string().describe(
          "Kernel boot arguments (e.g. 'console=ttyS0 reboot=k panic=1 pci=off')",
        ),
        initrdPath: z.string().regex(PATH_RE).optional().describe(
          "Optional path to initrd on the Firecracker host",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const body: Record<string, string> = {
          kernel_image_path: args.kernelImagePath,
          boot_args: args.bootArgs,
        };
        if (args.initrdPath) body.initrd_path = args.initrdPath;
        await sshCurl(host, user, socketPath, "PUT", "/boot-source", body);
        context.logger.info(`boot-source set: ${args.kernelImagePath}`);
        const handle = await context.writeResource("action", "set_boot", {
          action: "set_boot",
          success: true,
          message: `Boot source set: ${args.kernelImagePath}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    set_drive: {
      description:
        "Set a drive (rootfs or data). Idempotent PUT — creates or updates by drive_id. PRE-BOOT ONLY for root drives.",
      arguments: z.object({
        driveId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).describe(
          "Drive identifier (e.g. 'rootfs', 'data1')",
        ),
        pathOnHost: z.string().regex(PATH_RE).describe(
          "Path to the drive image file on the Firecracker host",
        ),
        isRootDevice: z.boolean().describe(
          "Whether this is the root block device",
        ),
        isReadOnly: z.boolean().default(false).describe("Mount as read-only"),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(
          host,
          user,
          socketPath,
          "PUT",
          `/drives/${args.driveId}`,
          {
            drive_id: args.driveId,
            path_on_host: args.pathOnHost,
            is_root_device: args.isRootDevice,
            is_read_only: args.isReadOnly,
          },
        );
        context.logger.info(
          `drive '${args.driveId}' set: ${args.pathOnHost} (root=${args.isRootDevice}, ro=${args.isReadOnly})`,
        );
        const handle = await context.writeResource(
          "action",
          `set_drive_${args.driveId}`,
          {
            action: "set_drive",
            success: true,
            message: `Drive '${args.driveId}' configured: ${args.pathOnHost}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    set_network: {
      description:
        "Set a network interface. Idempotent PUT. PRE-BOOT ONLY. The tap device must pre-exist on the host.",
      arguments: z.object({
        ifaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).describe(
          "Interface identifier (e.g. 'eth0')",
        ),
        hostDevName: z.string().regex(IFACE_RE).describe(
          "Host tap device name (e.g. 'tap0', max 15 chars)",
        ),
        guestMac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/)
          .optional()
          .describe(
            "Guest MAC address — auto-assigned by Firecracker if omitted",
          ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const body: Record<string, string> = {
          iface_id: args.ifaceId,
          host_dev_name: args.hostDevName,
        };
        if (args.guestMac) body.guest_mac = args.guestMac;
        await sshCurl(
          host,
          user,
          socketPath,
          "PUT",
          `/network-interfaces/${args.ifaceId}`,
          body,
        );
        context.logger.info(
          `network-interface '${args.ifaceId}' set: tap=${args.hostDevName}`,
        );
        const handle = await context.writeResource(
          "action",
          `set_network_${args.ifaceId}`,
          {
            action: "set_network",
            success: true,
            message:
              `Network interface '${args.ifaceId}' configured: tap=${args.hostDevName}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // ==================== vsock + agent rootfs ====================

    set_vsock: {
      description:
        "Configure a virtio-vsock device. PRE-BOOT ONLY — call before start. On snapshot restore, pass vsock_override to change the UDS path per-VM.",
      arguments: z.object({
        guestCid: z.number().int().min(3).describe(
          "Guest CID (context identifier) for the vsock device — must be ≥ 3",
        ),
        udsPath: z.string().regex(PATH_RE).describe(
          "Host-side Unix socket path for the vsock device (e.g. /tmp/fc-agent-1.vsock)",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PUT", "/vsock", {
          guest_cid: args.guestCid,
          uds_path: args.udsPath,
        });
        context.logger.info(
          `vsock configured: guest_cid=${args.guestCid} uds_path=${args.udsPath}`,
        );
        const handle = await context.writeResource("action", "set_vsock", {
          action: "set_vsock",
          success: true,
          message:
            `vsock device configured: CID=${args.guestCid} at ${args.udsPath}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    build_ubuntu_rootfs: {
      description:
        "Build a fresh Ubuntu rootfs (ext4) from scratch via debootstrap, layered with the glibc claude-linux-x64 binary + ca-certificates, curl, git, python3, iproute2, and the PID-1 agent script (booted via init=/opt/fc-agent.sh). Replaces the old Alpine/musl rootfs to avoid missing-CA-cert / BusyBox quirks. Runs the heavy build in the BACKGROUND on the host and returns immediately — poll completion with wait_serial(target='ROOTFS BUILD COMPLETE', logPath='/var/log/fc-rootfs-build.log', timeoutSeconds=300). Builds to a temp image then atomically moves it over rootfsPath. Idempotent: skipped if /opt/firecracker/.ubuntu-rootfs-ready exists unless force=true. Requires internet on the host; installs debootstrap via apt if missing.",
      arguments: z.object({
        claudeCodeVersion: z.string().default("latest").describe(
          "claude-code release tag (default: latest). Uses the glibc claude-linux-x64 build.",
        ),
        rootfsPath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/rootfs.ext4",
        ).describe("Final path for the rootfs image on the Firecracker host"),
        sizeMib: z.number().int().min(512).max(8192).default(2048).describe(
          "Size of the rootfs image in MiB",
        ),
        suite: z.string().regex(/^[a-z]+$/).default("noble").describe(
          "Ubuntu suite/codename for debootstrap (e.g. noble, jammy)",
        ),
        force: z.boolean().default(false).describe(
          "Rebuild even if the ready-marker already exists",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;

        const agentB64 = btoa(AGENT_SCRIPT);
        const marker = "/opt/firecracker/.ubuntu-rootfs-ready";
        const buildLog = "/var/log/fc-rootfs-build.log";
        const buildScriptPath = "/opt/firecracker/build-rootfs.sh";
        const tmpImg = "/opt/firecracker/rootfs.ubuntu.ext4";
        const mnt = "/mnt/fc-ubuntu-build";

        const resolveVersionCmd = args.claudeCodeVersion === "latest"
          ? `curl -fsSL https://api.github.com/repos/anthropics/claude-code/releases/latest | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])"`
          : `echo ${shellEsc(args.claudeCodeVersion)}`;

        // Background build script. @@VER@@ is substituted from the resolved tag
        // at launch time so the version is captured in the host-side script.
        const buildScript = [
          "#!/bin/sh",
          "set -e",
          "echo ROOTFS BUILD START",
          `umount ${mnt} 2>/dev/null || true`,
          `rm -f ${tmpImg}`,
          `truncate -s ${args.sizeMib}M ${tmpImg}`,
          `mkfs.ext4 -F -q ${tmpImg}`,
          `mkdir -p ${mnt}`,
          `mount ${tmpImg} ${mnt}`,
          `debootstrap --variant=minbase --include=ca-certificates,curl,git,python3,iproute2,iputils-ping,wget,procps ${args.suite} ${mnt} http://archive.ubuntu.com/ubuntu`,
          "echo DEBOOTSTRAP DONE",
          `curl -fsSL "https://github.com/anthropics/claude-code/releases/download/@@VER@@/claude-linux-x64.tar.gz" | tar -xz -C ${mnt}/usr/local/bin/`,
          `chmod +x ${mnt}/usr/local/bin/claude`,
          `mkdir -p ${mnt}/opt ${mnt}/workspace`,
          `echo ${agentB64} | base64 -d > ${mnt}/opt/fc-agent.sh`,
          `chmod +x ${mnt}/opt/fc-agent.sh`,
          `printf 'nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n' > ${mnt}/etc/resolv.conf`,
          "sync",
          `umount ${mnt}`,
          `mv -f ${tmpImg} ${args.rootfsPath}`,
          `touch ${marker}`,
          "echo ROOTFS BUILD COMPLETE",
        ].join("\n");

        const buildScriptB64 = btoa(buildScript);

        const launchCmd = [
          "set -e",
          // Idempotency: skip if already built unless forced.
          args.force
            ? `rm -f ${marker}`
            : `if test -f ${marker}; then echo already-built; exit 0; fi`,
          // debootstrap must be present on the host.
          `command -v debootstrap >/dev/null 2>&1 || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y debootstrap; }`,
          `VER=$(${resolveVersionCmd})`,
          `echo ${
            shellEsc(buildScriptB64)
          } | base64 -d | sed "s|@@VER@@|$VER|g" > ${buildScriptPath}`,
          `: > ${buildLog}`,
          `setsid sh ${buildScriptPath} >${buildLog} 2>&1 </dev/null &`,
          `echo "build started ver=$VER pid=$!"`,
        ].join("\n");

        const { stdout } = await sshExec(host, user, launchCmd);
        const out = stdout.trim();
        const alreadyBuilt = out.includes("already-built");
        context.logger.info(`build_ubuntu_rootfs: ${out}`);
        const handle = await context.writeResource(
          "action",
          "build_ubuntu_rootfs",
          {
            action: "build_ubuntu_rootfs",
            success: true,
            message: alreadyBuilt
              ? `Ubuntu rootfs already built (marker present). Pass force=true to rebuild.`
              : `Ubuntu rootfs build started in background. Poll with wait_serial(target='ROOTFS BUILD COMPLETE', logPath='${buildLog}', timeoutSeconds=300). ${out}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    update_agent_script: {
      description:
        "Replace /opt/fc-agent.sh in the rootfs image with the current PID-1 Ubuntu agent (init=/opt/fc-agent.sh). The VM must NOT be running — unmount happens after write. Use this to deploy a new agent version without a full rootfs rebuild.",
      arguments: z.object({
        rootfsPath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/rootfs.ext4",
        ).describe("Path to the rootfs image on the Firecracker host"),
        mountPoint: z.string().regex(PATH_RE).default("/mnt/fc-agent-update")
          .describe("Temporary mount point (created if absent)"),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;

        const agentScriptB64 = btoa(AGENT_SCRIPT);
        const agentPath = args.mountPoint + "/opt/fc-agent.sh";

        const cmd = [
          `mkdir -p ${shellEsc(args.mountPoint)}`,
          `mount ${shellEsc(args.rootfsPath)} ${shellEsc(args.mountPoint)}`,
          `echo ${shellEsc(agentScriptB64)} | base64 -d > ${
            shellEsc(agentPath)
          }`,
          `chmod +x ${shellEsc(agentPath)}`,
          `umount ${shellEsc(args.mountPoint)}`,
          `echo ok`,
        ].join("\n");

        await sshExec(host, user, cmd);
        context.logger.info(
          `agent script updated in ${args.rootfsPath}`,
        );
        const handle = await context.writeResource(
          "action",
          "update_agent_script",
          {
            action: "update_agent_script",
            success: true,
            message: `Agent script updated in ${args.rootfsPath}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    wait_serial: {
      description:
        "Poll the Firecracker process log file until a target string appears (serial console output). Use during snapshot baking to detect when guest reaches 'polling for task' state before pausing.",
      arguments: z.object({
        target: z.string().describe(
          "String to wait for in the serial log (e.g. 'polling for task')",
        ),
        logPath: z.string().regex(PATH_RE).optional().describe(
          "Path to the FC log file on the host. Defaults to /var/log/<socket-basename>.log",
        ),
        timeoutSeconds: z.number().int().min(5).max(300).default(60).describe(
          "Max seconds to wait for the target string",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const socketBasename = socketPath.split("/").pop() ?? "firecracker";
        const logPath = args.logPath ?? `/var/log/${socketBasename}.log`;
        const target = args.target;
        const timeout = args.timeoutSeconds;

        const cmd = [
          `LOG=${shellEsc(logPath)}`,
          `TARGET=${shellEsc(target)}`,
          `DEADLINE=$(($(date +%s) + ${timeout}))`,
          `while [ "$(date +%s)" -lt "$DEADLINE" ]; do`,
          `  grep -qF "$TARGET" "$LOG" 2>/dev/null && echo "found" && exit 0`,
          `  sleep 0.5`,
          `done`,
          `echo "timeout after ${timeout}s" >&2`,
          `exit 1`,
        ].join("\n");

        const { stdout } = await sshExec(host, user, cmd);
        context.logger.info(
          `wait_serial: ${stdout.trim()} (target="${target}")`,
        );
        const handle = await context.writeResource("action", "wait_serial", {
          action: "wait_serial",
          success: true,
          message: `Serial target found: "${target}" in ${logPath}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    snapshot: {
      description:
        "Snapshot the microVM state to disk. VM must be paused first (call pause()). Creates a memory + disk snapshot for fast restore.",
      arguments: z.object({
        snapshotPath: z.string().regex(PATH_RE).describe(
          "Host path to write the snapshot file (e.g. /opt/firecracker/agent-snapshot.snap)",
        ),
        memFilePath: z.string().regex(PATH_RE).describe(
          "Host path to write the memory file (e.g. /opt/firecracker/agent-snapshot.mem)",
        ),
        snapshotType: z.enum(["Full", "Diff"]).default("Full").describe(
          "Full captures the entire state; Diff captures only changes since last snapshot",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PUT", "/snapshot/create", {
          snapshot_path: args.snapshotPath,
          mem_file_path: args.memFilePath,
          snapshot_type: args.snapshotType,
        });
        context.logger.info(`snapshot written: ${args.snapshotPath}`);
        const handle = await context.writeResource("action", "snapshot", {
          action: "snapshot",
          success: true,
          message: `Snapshot (${args.snapshotType}) at ${args.snapshotPath}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    restore: {
      description:
        "Restore a microVM from a snapshot. Requires a fresh Firecracker process (socket exists but no VM started). Use vsockUdsPath to give this instance its own vsock UDS path (avoids collisions between concurrent VMs).",
      arguments: z.object({
        snapshotPath: z.string().regex(PATH_RE).describe(
          "Path to the snapshot file",
        ),
        memFilePath: z.string().regex(PATH_RE).describe(
          "Path to the memory file",
        ),
        vsockUdsPath: z.string().regex(PATH_RE).optional().describe(
          "Override vsock UDS path for this instance (vsock_override) — required when running concurrent VMs from the same snapshot",
        ),
        ifaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).optional().describe(
          "Network interface id baked into the snapshot (e.g. 'eth0') to remap on restore. Pair with hostDevName to emit network_overrides — lets a clone bind its own per-VM tap.",
        ),
        hostDevName: z.string().regex(IFACE_RE).optional().describe(
          "Host tap device to bind the baked interface to on restore (network_overrides). Requires ifaceId.",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const body: Record<string, unknown> = {
          snapshot_path: args.snapshotPath,
          mem_file_path: args.memFilePath,
          resume_vm: true,
        };
        if (args.vsockUdsPath) {
          body.vsock_override = { uds_path: args.vsockUdsPath };
        }
        if (args.ifaceId && args.hostDevName) {
          body.network_overrides = [
            { iface_id: args.ifaceId, host_dev_name: args.hostDevName },
          ];
        }
        await sshCurl(host, user, socketPath, "PUT", "/snapshot/load", body);
        context.logger.info(
          `snapshot restored from ${args.snapshotPath}${
            args.hostDevName
              ? ` (iface ${args.ifaceId}→${args.hostDevName})`
              : ""
          }`,
        );
        const handle = await context.writeResource("action", "restore", {
          action: "restore",
          success: true,
          message: `Snapshot restored from ${args.snapshotPath}${
            args.vsockUdsPath ? ` (vsock: ${args.vsockUdsPath})` : ""
          }${args.hostDevName ? ` (tap: ${args.hostDevName})` : ""}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ==================== Lifecycle ====================

    start: {
      description:
        "Start the microVM (InstanceStart). Call after all pre-boot configuration is complete.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PUT", "/actions", {
          action_type: "InstanceStart",
        });
        context.logger.info("InstanceStart sent");
        const handle = await context.writeResource("action", "start", {
          action: "start",
          success: true,
          message: "InstanceStart action sent",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description:
        "Stop the microVM (InstanceHalt). Checks VM state first — idempotent if already stopped.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;

        // Check state first to make stop idempotent
        let currentState = "unknown";
        try {
          const vmState = await sshCurlJson<{ state?: string }>(
            host,
            user,
            socketPath,
            "GET",
            "/vm",
          );
          currentState = vmState.state ?? "unknown";
        } catch { /* socket may be gone if VM process already exited */ }

        if (currentState === "Not started") {
          context.logger.info("VM already stopped (state: Not started)");
          const handle = await context.writeResource("action", "stop", {
            action: "stop",
            success: true,
            message: "VM was already stopped — no action taken",
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        await sshCurl(host, user, socketPath, "PUT", "/actions", {
          action_type: "InstanceHalt",
        });
        context.logger.info("InstanceHalt sent");
        const handle = await context.writeResource("action", "stop", {
          action: "stop",
          success: true,
          message: "InstanceHalt action sent",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    send_ctrl_alt_del: {
      description:
        "Send Ctrl+Alt+Del to the guest for graceful shutdown. Requires guest ACPI support — silently ignored if the guest does not handle it.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PUT", "/actions", {
          action_type: "SendCtrlAltDel",
        });
        context.logger.info("SendCtrlAltDel sent");
        const handle = await context.writeResource(
          "action",
          "send_ctrl_alt_del",
          {
            action: "send_ctrl_alt_del",
            success: true,
            message:
              "SendCtrlAltDel sent (graceful shutdown — requires guest ACPI support)",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    pause: {
      description: "Pause the microVM. VM must be in Running state.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PATCH", "/vm", {
          state: "Paused",
        });
        context.logger.info("VM paused");
        const handle = await context.writeResource("action", "pause", {
          action: "pause",
          success: true,
          message: "VM paused",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    resume: {
      description: "Resume a paused microVM.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PATCH", "/vm", {
          state: "Resumed",
        });
        context.logger.info("VM resumed");
        const handle = await context.writeResource("action", "resume", {
          action: "resume",
          success: true,
          message: "VM resumed",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    kill_vmm: {
      description:
        "Kill the Firecracker process owning this socket (via PID sidecar, falls back to fuser). Removes socket, PID file, and vsock UDS files. Safe when no VM is running.",
      arguments: z.object({
        vsockUdsPath: z.string().regex(PATH_RE).optional().describe(
          "vsock UDS base path — also removes {vsockUdsPath}_* side-car files",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const netns = context.globalArgs.netns;
        const cmd = buildKillVmmCmd(socketPath, netns, args.vsockUdsPath);
        const { stdout } = await sshExec(host, user, cmd);
        context.logger.info(
          `kill_vmm: ${stdout.trim()}${
            netns ? ` (netns ${netns} removed)` : ""
          }`,
        );
        const handle = await context.writeResource("action", "kill_vmm", {
          action: "kill_vmm",
          success: true,
          message: `Killed VMM at ${socketPath}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    set_entropy_device: {
      description:
        "Configure a virtio-rng entropy device via PUT /entropy. PRE-BOOT ONLY — must be called before start. The guest gets entropy from the host's /dev/urandom, unblocking getrandom() and /dev/random inside the VM. Essential for TLS/crypto in musl-based guests.",
      arguments: z.object({}),
      execute: async (_args: unknown, context) => {
        const { host, user, socketPath } = context.globalArgs;
        await sshCurl(host, user, socketPath, "PUT", "/entropy", {});
        context.logger.info("entropy device configured");
        const handle = await context.writeResource(
          "action",
          "set_entropy_device",
          {
            action: "set_entropy_device",
            success: true,
            message: "virtio-rng entropy device configured",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    install_firecracker: {
      description:
        "Download and install the latest Firecracker release binary from GitHub onto the host. Replaces /usr/local/bin/firecracker in-place. Idempotent: skips download if already at the target version.",
      arguments: z.object({
        version: z.string().optional().describe(
          "Specific version tag to install (e.g. 'v1.12.0'). Defaults to latest GitHub release.",
        ),
        arch: z.string().optional().describe(
          "CPU architecture (e.g. 'x86_64', 'aarch64'). Auto-detected if omitted.",
        ),
        installPath: z.string().regex(PATH_RE).default(
          "/usr/local/bin/firecracker",
        ).describe(
          "Destination path for the binary",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const installPath = args.installPath ?? "/usr/local/bin/firecracker";

        const cmd = [
          // Auto-detect arch if not specified
          `ARCH=${shellEsc(args.arch ?? "")}`,
          `[ -z "$ARCH" ] && ARCH=$(uname -m)`,
          // Resolve version: use specified or query GitHub API for latest tag
          `VERSION=${shellEsc(args.version ?? "")}`,
          `if [ -z "$VERSION" ]; then`,
          `  API=$(curl -fsSL "https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest")`,
          `  VERSION=$(printf '%s' "$API" | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")`,
          `fi`,
          `echo "Resolved version: $VERSION arch: $ARCH"`,
          // Check if already installed at that version
          `CURRENT=$(${
            shellEsc(installPath)
          } --version 2>/dev/null | grep -oE 'v[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || echo "")`,
          `echo "Current: $CURRENT"`,
          `if [ "$CURRENT" = "$VERSION" ]; then echo "already at $VERSION, skipping"; exit 0; fi`,
          // Fetch asset download URL from GitHub API releases
          `API2=$(curl -fsSL "https://api.github.com/repos/firecracker-microvm/firecracker/releases/tags/$VERSION")`,
          `URL=$(printf '%s' "$API2" | python3 -c "`,
          `import sys, json`,
          `data = json.load(sys.stdin)`,
          `assets = data.get('assets', [])`,
          `arch = '${
            args.arch ?? ""
          }' or __import__('subprocess').check_output(['uname','-m']).decode().strip()`,
          `match = next((a['browser_download_url'] for a in assets if a['name'].endswith('.tgz') and arch in a['name'] and 'jailer' not in a['name']), None)`,
          `print(match or '')`,
          `")`,
          `[ -z "$URL" ] && { echo "ERROR: no .tgz asset found for $VERSION $ARCH"; exit 1; }`,
          `echo "Downloading $URL"`,
          // Download and extract
          `TMPDIR=$(mktemp -d)`,
          `curl -fsSL -L -o "$TMPDIR/fc.tgz" "$URL"`,
          `tar -xzf "$TMPDIR/fc.tgz" -C "$TMPDIR"`,
          `BINARY=$(find "$TMPDIR" -type f -name "firecracker*" ! -name "*.tgz" | grep -v jailer | head -1)`,
          `[ -z "$BINARY" ] && { echo "ERROR: binary not found"; find "$TMPDIR"; exit 1; }`,
          `echo "Found binary: $BINARY"`,
          `chmod +x "$BINARY"`,
          `mv "$BINARY" ${shellEsc(installPath)}`,
          `rm -rf "$TMPDIR"`,
          `${shellEsc(installPath)} --version`,
          `echo "ok"`,
        ].join("\n");

        const { stdout } = await sshExec(host, user, cmd);
        context.logger.info(`install_firecracker: ${stdout.trim()}`);
        const handle = await context.writeResource(
          "action",
          "install_firecracker",
          {
            action: "install_firecracker",
            success: true,
            message: stdout.trim(),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    install_guest_kernel: {
      description:
        "Download a modern Firecracker-tested guest kernel (vmlinux) from the Firecracker CI artifacts bucket and install it at installPath (default /opt/firecracker/vmlinux), backing up the previous kernel once to <installPath>.orig.bak. Replaces the legacy 4.14 kernel whose old crng/getrandom behavior blocked TLS/crypto. A snapshot must be re-baked after changing the kernel. Idempotent: records the installed version in /opt/firecracker/.guest-kernel-version and skips if it already matches unless force=true.",
      arguments: z.object({
        kernelVersion: z.string().default("6.1.128").describe(
          "Kernel version available in the Firecracker CI bucket (e.g. 6.1.128, 5.10.233)",
        ),
        ciVersion: z.string().default("v1.12").describe(
          "Firecracker CI artifacts prefix (e.g. v1.12)",
        ),
        arch: z.string().optional().describe(
          "CPU architecture (default: uname -m, e.g. x86_64)",
        ),
        installPath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/vmlinux",
        ).describe("Destination path for the kernel image"),
        url: z.string().optional().describe(
          "Full override URL for the vmlinux image (bypasses ciVersion/kernelVersion)",
        ),
        force: z.boolean().default(false).describe(
          "Re-download even if the recorded version already matches",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const installPath = args.installPath ?? "/opt/firecracker/vmlinux";
        const verFile = "/opt/firecracker/.guest-kernel-version";
        const urlTemplate = args.url ??
          `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/${args.ciVersion}/@@ARCH@@/vmlinux-${args.kernelVersion}`;

        const cmd = [
          "set -e",
          `ARCH=${shellEsc(args.arch ?? "")}`,
          `[ -z "$ARCH" ] && ARCH=$(uname -m)`,
          `URL=$(printf '%s' ${
            shellEsc(urlTemplate)
          } | sed "s|@@ARCH@@|$ARCH|g")`,
          `WANT=${shellEsc(args.kernelVersion)}`,
          args.force
            ? `rm -f ${verFile}`
            : `if [ -f ${verFile} ] && [ "$(cat ${verFile})" = "$WANT" ] && test -s ${
              shellEsc(installPath)
            }; then echo "already $WANT"; exit 0; fi`,
          `echo "Downloading $URL"`,
          `TMP=$(mktemp)`,
          `curl -fsSL -o "$TMP" "$URL"`,
          `test -s "$TMP" || { echo "ERROR: empty download"; rm -f "$TMP"; exit 1; }`,
          // Back up the existing kernel once.
          `if test -s ${shellEsc(installPath)} && ! test -f ${
            shellEsc(installPath)
          }.orig.bak; then cp ${shellEsc(installPath)} ${
            shellEsc(installPath)
          }.orig.bak; fi`,
          `mv "$TMP" ${shellEsc(installPath)}`,
          `printf '%s' "$WANT" > ${verFile}`,
          `ls -la ${shellEsc(installPath)}`,
          `echo "installed $WANT"`,
        ].join("\n");

        const { stdout } = await sshExec(host, user, cmd);
        const out = stdout.trim();
        context.logger.info(`install_guest_kernel: ${out}`);
        const handle = await context.writeResource(
          "action",
          "install_guest_kernel",
          {
            action: "install_guest_kernel",
            success: true,
            message: out,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    setup_tap: {
      description:
        "Idempotent: create a TAP device on the host, assign an IP, and enable NAT masquerade so guest VMs can reach the internet. Safe to call on every workflow run — skips steps that are already done.",
      arguments: z.object({
        tapName: z.string().regex(IFACE_RE).default("tap0").describe(
          "TAP device name (default: tap0)",
        ),
        hostIp: z.string().regex(IPV4_RE).default("172.16.0.1").describe(
          "Host IP on the TAP subnet (guest default gateway)",
        ),
        prefix: z.number().int().min(16).max(30).default(24).describe(
          "Subnet prefix length (default: 24 → /24)",
        ),
        guestSubnet: z.string().regex(CIDR_RE).default("172.16.0.0/24")
          .describe(
            "Guest subnet for NAT masquerade rule",
          ),
        netns: z.union([z.literal(""), z.string().regex(NETNS_RE)]).optional()
          .describe(
            "Optional network namespace. When set, the tap + veth + NAT are built INSIDE this namespace so many clones of one base snapshot run without overlap (reusing the same guest IP). Omit for the single-VM root-namespace path (unchanged).",
          ),
        vethSubnet: z.string().regex(CIDR_RE).default("10.0.0.0/30").describe(
          "Host↔namespace veth subnet (netns mode only). MUST be unique per concurrent VM; .1 is the host side, .2 the namespace side. Derive per-VM (e.g. 10.0.<index>.0/30).",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const cmd = buildSetupTapScript(args);
        const { stdout } = await sshExec(host, user, cmd);
        const where = args.netns ? ` netns=${args.netns}` : "";
        context.logger.info(
          `setup_tap: ${args.tapName} ${args.hostIp}/${args.prefix} NAT ${args.guestSubnet}${where} (${stdout.trim()})`,
        );
        const handle = await context.writeResource("action", "setup_tap", {
          action: "setup_tap",
          success: true,
          message:
            `TAP ${args.tapName} ready: host=${args.hostIp}/${args.prefix} NAT=${args.guestSubnet}${where}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    start_vmm: {
      description:
        "Start a Firecracker process and wait for the API socket. Idempotent: if the PID sidecar shows a live process with a ready socket, returns without starting a new one. When starting fresh, cleans up stale vsock UDS files to prevent Firecracker 'address in use' errors on snapshot restore.",
      arguments: z.object({
        logPath: z.string().regex(PATH_RE).optional().describe(
          "Path to write Firecracker stderr/stdout on the host (default: /var/log/fc-<socket-basename>.log)",
        ),
        vsockUdsPath: z.string().regex(PATH_RE).optional().describe(
          "vsock UDS base path — stale files at this path and {path}_* are removed when starting fresh to avoid EADDRINUSE on snapshot restore",
        ),
      }),
      execute: async (args, context) => {
        const { host, user, socketPath } = context.globalArgs;
        const cmd = buildStartVmmCmd(
          socketPath,
          context.globalArgs.netns,
          args.logPath,
          args.vsockUdsPath,
        );

        const { stdout } = await sshExec(host, user, cmd);
        const line = stdout.trim();
        const reused = line.startsWith("alive:");
        context.logger.info(
          `start_vmm: ${line} (${
            reused ? "warm process reused" : "fresh process started"
          })`,
        );
        const handle = await context.writeResource("action", "start_vmm", {
          action: "start_vmm",
          success: true,
          message: reused
            ? `Reused warm VMM at ${socketPath} (${line})`
            : `Started VMM at ${socketPath} (${line})`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ==================== Fast task fabric (factory + queue) ====================

    fabric_up: {
      description:
        "Factory: spawn a warm worker-VM pool. Fans out `concurrency` netns microVMs (each restored from the snapshot and running the looping agent) that pull tasks from a shared host queue served by a per-VM fabric daemon. One call brings up the whole pool concurrently; submit/poll/fabric_down drive it afterwards.",
      arguments: z.object({
        concurrency: z.number().int().min(1).max(64).default(8).describe(
          "Pool size = max concurrent worker VMs (configurable; ~512MiB RAM each)",
        ),
        snapshotPath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/agent-snapshot.snap",
        ),
        memFilePath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/agent-snapshot.mem",
        ),
        queueRoot: z.string().regex(PATH_RE).default("/tmp/fc-fabric"),
        netnsPrefix: z.string().regex(NETNS_RE).default("fcw"),
        tapName: z.string().regex(IFACE_RE).default("tap0"),
        tapIp: z.string().regex(IPV4_RE).default("172.16.0.1"),
        guestSubnet: z.string().regex(CIDR_RE).default("172.16.0.0/24"),
        port: z.number().int().default(8080),
        oauthToken: z.string().describe(
          "Claude Code OAuth token; the daemon injects it at serve time (never written to the queue)",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const paths = fabricPaths(args.queueRoot);
        await sshExec(
          host,
          user,
          `mkdir -p ${shellEsc(paths.queueDir)} ${shellEsc(paths.claimedDir)} ${
            shellEsc(paths.resultsDir)
          } ${shellEsc(paths.failedDir)}`,
        );
        // Bring up workers concurrently but tolerate partial failure: a worker
        // that fails to come up must NOT discard the fabric resource (which would
        // orphan the workers that DID start, with no recorded state for
        // fabric_down to reap). Record what came up, then surface failures.
        const settled = await Promise.allSettled(
          Array.from(
            { length: args.concurrency },
            (_, k) => bringUpWorker(host, user, k + 1, args, paths),
          ),
        );
        const workers = settled
          .filter((s): s is PromiseFulfilledResult<string> =>
            s.status === "fulfilled"
          )
          .map((s) => s.value);
        const failures = settled
          .map((s, k) =>
            s.status === "rejected" ? `${args.netnsPrefix}-${k + 1}` : null
          )
          .filter((x): x is string => x !== null);
        context.logger.info(
          `fabric_up: ${workers.length}/${args.concurrency} warm worker(s) ready on queue ${args.queueRoot}${
            failures.length ? `; FAILED: ${failures.join(",")}` : ""
          }`,
        );
        const handle = await context.writeResource("fabric", "fabric", {
          queueRoot: args.queueRoot,
          concurrency: args.concurrency,
          netnsPrefix: args.netnsPrefix,
          port: args.port,
          workers,
          failures,
          status: failures.length ? "degraded" : "up",
          timestamp: new Date().toISOString(),
        });
        if (failures.length) {
          throw new Error(
            `fabric_up: ${failures.length} worker(s) failed to start (${
              failures.join(",")
            }); ${workers.length} are up and recorded — run fabric_recycle or fabric_down to reconcile`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    submit: {
      description:
        "Enqueue agent tasks onto the fabric queue (NON-BLOCKING, callable any time — including while tasks are running). Returns the generated task ids. Workers pull and run them as slots free up; the daemon injects the OAuth token at serve time so it is never written to the queue.",
      arguments: z.object({
        queueRoot: z.string().regex(PATH_RE).default("/tmp/fc-fabric"),
        tasks: z.array(
          z.object({
            prompt: z.string(),
            model: z.string().optional(),
            effort: z.string().optional(),
            gitRepoUrl: z.string().optional(),
          }),
        ).min(1),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const paths = fabricPaths(args.queueRoot);
        const ids: string[] = [];
        const writes: string[] = [`mkdir -p ${shellEsc(paths.queueDir)}`];
        const base = Date.now();
        for (let k = 0; k < args.tasks.length; k++) {
          const t = args.tasks[k];
          const id = crypto.randomUUID();
          ids.push(id);
          const seq = String(base + k).padStart(16, "0");
          const b64 = utf8ToBase64(JSON.stringify(buildQueuePayload(t, id)));
          const tmp = `${paths.queueDir}/.${seq}-${id}.json.tmp`;
          const fin = `${paths.queueDir}/${seq}-${id}.json`;
          // tmp + atomic rename so a worker never claims a half-written task file
          writes.push(
            `echo ${shellEsc(b64)} | base64 -d > ${shellEsc(tmp)} && mv ${
              shellEsc(tmp)
            } ${shellEsc(fin)}`,
          );
        }
        await sshExec(host, user, writes.join("\n"));
        context.logger.info(`submit: enqueued ${ids.length} task(s)`);
        const handle = await context.writeResource("submitted", "submitted", {
          ids,
          count: ids.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poll: {
      description:
        "Collect completed task results from the fabric (NON-BLOCKING, idempotent). Returns a map of task id -> result for every result posted so far (optionally filtered to `ids`), plus the number still pending in the queue.",
      arguments: z.object({
        queueRoot: z.string().regex(PATH_RE).default("/tmp/fc-fabric"),
        ids: z.array(z.string()).optional().describe(
          "If given, only report these ids",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const paths = fabricPaths(args.queueRoot);
        const cmd = [
          `for f in ${
            shellEsc(paths.resultsDir)
          }/*.txt; do [ -e "$f" ] || continue; n=$(basename "$f" .txt); printf '===%s===\\n' "$n"; base64 -w0 "$f"; printf '\\n'; done`,
          `printf 'PENDING=%s\\n' "$(ls ${shellEsc(paths.queueDir)} ${
            shellEsc(paths.claimedDir)
          } 2>/dev/null | grep -c '[.]json$' || echo 0)"`,
        ].join("\n");
        const { stdout } = await sshExec(host, user, cmd);
        const { completed, pending } = parsePollOutput(stdout);
        const wanted = args.ids
          ? Object.fromEntries(
            Object.entries(completed).filter(([k]) => args.ids!.includes(k)),
          )
          : completed;
        context.logger.info(
          `poll: ${Object.keys(wanted).length} completed, ${pending} pending`,
        );
        const handle = await context.writeResource("results", "results", {
          completed: wanted,
          completedCount: Object.keys(wanted).length,
          pending,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    fabric_down: {
      description:
        "Tear down the whole fabric: reap every worker VM (PID + socket + netns + NAT, exactly as kill_vmm), stop the daemons, and remove the queue root. Discovers the live workers by enumerating the host (netns list + socket/pid files for the prefix) so it reaps the ACTUAL pool regardless of the size it was brought up with — no worker leaks on a concurrency mismatch. `concurrency` is only a lower-bound fallback. Idempotent.",
      arguments: z.object({
        concurrency: z.number().int().min(1).max(64).default(8).describe(
          "Lower-bound fallback only; the real pool is discovered from host state",
        ),
        netnsPrefix: z.string().regex(NETNS_RE).default("fcw"),
        queueRoot: z.string().regex(PATH_RE).default("/tmp/fc-fabric"),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const p = args.netnsPrefix;
        // Discover the live pool from host state (source of truth), not from the
        // caller-supplied count: netns names + leftover socket/pid files. This is
        // what prevents a worker leak when fabric_down is called with a smaller
        // concurrency than fabric_up used.
        const { stdout } = await sshExec(
          host,
          user,
          buildDiscoverWorkersCmd(p),
        );
        const indices = new Set<number>();
        for (const ns of stdout.trim().split("\n").filter(Boolean)) {
          const i = workerIndexFromNetns(ns);
          if (i !== null) indices.add(i);
        }
        // Union with the fallback range so a half-torn-down worker (netns already
        // gone but NAT/pidfile lingering) is still cleaned.
        for (let i = 1; i <= args.concurrency; i++) indices.add(i);
        const reap = async (i: number): Promise<void> => {
          const netns = `${p}-${i}`;
          const socketPath = `/tmp/${p}-${i}.socket`;
          const srvPid = `/tmp/${p}-${i}.server.pid`;
          await sshExec(
            host,
            user,
            `if [ -f ${shellEsc(srvPid)} ]; then kill "$(cat ${
              shellEsc(srvPid)
            })" 2>/dev/null || true; rm -f ${shellEsc(srvPid)}; fi`,
          );
          await sshExec(host, user, buildKillVmmCmd(socketPath, netns));
        };
        await Promise.all([...indices].map((i) => reap(i)));
        await sshExec(host, user, `rm -rf ${shellEsc(args.queueRoot)}`);
        context.logger.info(
          `fabric_down: reaped ${indices.size} worker(s) [${
            [...indices].sort((a, b) => a - b).join(",")
          }], removed ${args.queueRoot}`,
        );
        const handle = await context.writeResource("fabric", "fabric", {
          status: "down",
          reaped: [...indices].sort((a, b) => a - b),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    fabric_recycle: {
      description:
        "Liveness watchdog: re-queue tasks claimed longer than `timeoutSeconds` ago (a wedged/hung worker) and restart the workers that were stuck on them, so a hung agent never permanently loses a pool slot. Idempotent; call periodically while a fabric is up.",
      arguments: z.object({
        concurrency: z.number().int().min(1).max(64).default(8),
        timeoutSeconds: z.number().int().min(1).default(600),
        queueRoot: z.string().regex(PATH_RE).default("/tmp/fc-fabric"),
        netnsPrefix: z.string().regex(NETNS_RE).default("fcw"),
        tapName: z.string().regex(IFACE_RE).default("tap0"),
        tapIp: z.string().regex(IPV4_RE).default("172.16.0.1"),
        guestSubnet: z.string().regex(CIDR_RE).default("172.16.0.0/24"),
        port: z.number().int().default(8080),
        snapshotPath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/agent-snapshot.snap",
        ),
        memFilePath: z.string().regex(PATH_RE).default(
          "/opt/firecracker/agent-snapshot.mem",
        ),
        oauthToken: z.string(),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const paths = fabricPaths(args.queueRoot);
        // 1. Identify claims older than the timeout WITHOUT moving them yet —
        //    capture each stalled claim's full basename. (Requeue happens in step
        //    3, only AFTER the owning worker is killed, so a slow-but-alive worker
        //    can never POST a late result for a task we've already re-dispatched.)
        const scan = [
          `now=$(date +%s)`,
          `for f in ${
            shellEsc(paths.claimedDir)
          }/*.json; do [ -e "$f" ] || continue;`,
          `  age=$(( now - $(stat -c %Y "$f") ));`,
          `  if [ "$age" -gt ${args.timeoutSeconds} ]; then basename "$f"; fi;`,
          `done`,
        ].join("\n");
        const { stdout } = await sshExec(host, user, scan);
        const stalledFiles = stdout.trim().split("\n").filter(Boolean);
        const stalledNs = [
          ...new Set(stalledFiles.map((b) => b.split("__")[0]).filter(Boolean)),
        ];
        // 2. Restart each stalled worker FIRST. bringUpWorker kills the wedged VM
        //    (and its in-VM agent), so by the time we requeue in step 3 the old
        //    worker is dead and cannot clobber the re-dispatched task.
        const restarted: string[] = [];
        for (const ns of stalledNs) {
          const i = workerIndexFromNetns(ns);
          if (i === null) continue;
          try {
            await bringUpWorker(host, user, i, args, paths);
            restarted.push(ns);
          } catch (e) {
            // A single failed restart must not abort the method before step 3 —
            // the captured claims still get requeued; the next recycle retries.
            context.logger.info(
              `fabric_recycle: restart of ${ns} failed (${
                e instanceof Error ? e.message : String(e)
              }); its task is still requeued for another worker`,
            );
          }
        }
        // 3. Now requeue exactly the claims we captured in step 1 (strip the netns
        //    prefix to restore the original queue name). A claim whose worker
        //    finished just in time is already gone -> the mv no-ops.
        if (stalledFiles.length) {
          const mvs = stalledFiles.map((b) => {
            const orig = b.includes("__") ? b.slice(b.indexOf("__") + 2) : b;
            return `mv ${shellEsc(`${paths.claimedDir}/${b}`)} ${
              shellEsc(`${paths.queueDir}/${orig}`)
            } 2>/dev/null || true`;
          });
          await sshExec(host, user, mvs.join("\n"));
        }
        context.logger.info(
          `fabric_recycle: restarted ${restarted.length} stalled worker(s) + re-queued ${stalledFiles.length} task(s)${
            restarted.length ? ": " + restarted.join(",") : ""
          }`,
        );
        const handle = await context.writeResource("fabric", "fabric", {
          status: "recycled",
          restarted,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
