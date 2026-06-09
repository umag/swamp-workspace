import { z } from "npm:zod@4";
import { isValidSshHost, sshExec, sshExecRaw } from "./lib/ssh.ts";

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// deno-lint-ignore no-control-regex
const PATH_RE = /^[^\x00-\x1f\x7f`$\\;|&'"()*?[\]{}<>!#~\s]+$/;
// Linux interface name: max 15 chars, alphanumeric + underscore + dot + hyphen
const IFACE_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

const GlobalArgsSchema = z.object({
  host: z.string().describe(
    "SSH host/IP of the machine running Firecracker — host key verification is disabled; use on trusted networks only",
  ),
  user: z.string().default("root").describe("SSH username (default: root)"),
  socketPath: z.string().regex(PATH_RE).describe(
    "Path to the Firecracker Unix socket on the remote host (e.g. /run/firecracker.socket). One model instance = one microVM socket.",
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

// --- Agent script (shared by build_ubuntu_rootfs + update_agent_script) ---
//
// Runs as PID 1 inside the Ubuntu guest (booted with init=/opt/fc-agent.sh).
// It mounts its own pseudo-filesystems, brings up the TAP NIC, seeds entropy
// for the old guest kernel, polls the host task server (172.16.0.1:8080) for a task,
// runs Claude Code authenticated SOLELY via CLAUDE_CODE_OAUTH_TOKEN, and POSTs
// the result back. As PID 1 it must never exit, so it idles at the end.
const AGENT_SCRIPT = `#!/bin/sh
# PID 1 under Firecracker (init=/opt/fc-agent.sh): mount our own fs, never exit.
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true

SAY() { printf "[agent] %s\\n" "$*" > /dev/ttyS0 2>/dev/null; }
SAY "agent started (ubuntu)"

export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
mkdir -p /workspace

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

SAY "polling for task"
while true; do
  TASK_JSON=\$(curl -s -m 15 http://172.16.0.1:8080/task 2>/dev/null)
  [ -n "\$TASK_JSON" ] && break
  sleep 1
done
SAY "got task"

printf "%s" "\$TASK_JSON" > /tmp/task.json
PROMPT=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('prompt',''))" 2>/dev/null)
TOKEN=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('token',''))" 2>/dev/null)
GIT_URL=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('gitRepoUrl',''))" 2>/dev/null)
MODEL=\$(python3 -c "import json; print(json.load(open('/tmp/task.json')).get('model',''))" 2>/dev/null)

export HOME=/workspace
export CLAUDE_CODE_OAUTH_TOKEN="\$TOKEN"

SAY "syncing clock"
DATE_HDR=\$(curl -sfI -m 10 http://172.16.0.1:8080/task 2>/dev/null | grep -i "^date:" | sed "s/^[^:]*: *//" | tr -d "\\r")
[ -n "\$DATE_HDR" ] && date -s "\$DATE_HDR" >/dev/null 2>&1 || true
SAY "clock=\$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Auth comes ONLY from CLAUDE_CODE_OAUTH_TOKEN. Config holds the onboarding flag only.
printf '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' > /workspace/.claude.json

WORKDIR=/workspace
if [ -n "\$GIT_URL" ]; then
  git clone --depth 1 -- "\$GIT_URL" /workspace/repo >/dev/null 2>&1 && WORKDIR=/workspace/repo
fi

SAY "running claude model=\${MODEL:-default}"
cd "\$WORKDIR"
RESULT=\$(claude --print \${MODEL:+--model "\$MODEL"} "\$PROMPT" 2>&1)
CLAUDE_EXIT=\$?
SAY "claude exit=\$CLAUDE_EXIT len=\$(printf "%s" "\$RESULT" | wc -c)"
[ \$CLAUDE_EXIT -ne 0 ] && RESULT="ERROR: claude exit=\$CLAUDE_EXIT: \$RESULT"

printf "%s" "\$RESULT" > /tmp/result.txt
curl -s -m 20 -X POST --data-binary @/tmp/result.txt -H "Content-Type: text/plain" -H "Expect:" http://172.16.0.1:8080/result >/dev/null 2>&1
SAY "done"

# PID 1 must never exit (kernel would panic). Idle until the host kills the VM.
while true; do sleep 3600; done
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
  version: "2026.06.09.19",
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
        await sshCurl(host, user, socketPath, "PUT", "/snapshot/load", body);
        context.logger.info(`snapshot restored from ${args.snapshotPath}`);
        const handle = await context.writeResource("action", "restore", {
          action: "restore",
          success: true,
          message: `Snapshot restored from ${args.snapshotPath}${
            args.vsockUdsPath ? ` (vsock: ${args.vsockUdsPath})` : ""
          }`,
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
        const pidFile = socketPath + ".pid";
        const vsock = args.vsockUdsPath ?? "";
        const vsockCleanup = vsock
          ? `rm -f ${shellEsc(vsock)} ${vsock}_* ${
            shellEsc(vsock + ".task.json")
          } ${shellEsc(vsock + ".result.txt")};`
          : "";
        // Precision kill: use PID sidecar (avoids pkill which kills all firecracker processes).
        // SIGTERM first → 0.5s wait → SIGKILL if still alive. Fallback to fuser if no sidecar.
        const cmd = [
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
          `echo ok`,
        ].join("\n");
        const { stdout } = await sshExec(host, user, cmd);
        context.logger.info(`kill_vmm: ${stdout.trim()}`);
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
        hostIp: z.string().default("172.16.0.1").describe(
          "Host IP on the TAP subnet (guest default gateway)",
        ),
        prefix: z.number().int().min(16).max(30).default(24).describe(
          "Subnet prefix length (default: 24 → /24)",
        ),
        guestSubnet: z.string().default("172.16.0.0/24").describe(
          "Guest subnet for NAT masquerade rule",
        ),
      }),
      execute: async (args, context) => {
        const { host, user } = context.globalArgs;
        const cmd = [
          // Create TAP if not present
          `ip link show ${
            shellEsc(args.tapName)
          } 2>/dev/null || ip tuntap add dev ${
            shellEsc(args.tapName)
          } mode tap`,
          // Assign IP if not already assigned
          `ip addr show ${shellEsc(args.tapName)} | grep -q ${
            shellEsc(args.hostIp)
          } || ip addr add ${shellEsc(args.hostIp + "/" + args.prefix)} dev ${
            shellEsc(args.tapName)
          }`,
          `ip link set ${shellEsc(args.tapName)} up`,
          `sysctl -w net.ipv4.ip_forward=1 -q`,
          // Add masquerade rule if not already present
          `iptables -t nat -C POSTROUTING -s ${
            shellEsc(args.guestSubnet)
          } -j MASQUERADE 2>/dev/null || ` +
          `iptables -t nat -A POSTROUTING -s ${
            shellEsc(args.guestSubnet)
          } -j MASQUERADE`,
          `echo ok`,
        ].join("\n");
        const { stdout } = await sshExec(host, user, cmd);
        context.logger.info(
          `setup_tap: ${args.tapName} ${args.hostIp}/${args.prefix} NAT ${args.guestSubnet} (${stdout.trim()})`,
        );
        const handle = await context.writeResource("action", "setup_tap", {
          action: "setup_tap",
          success: true,
          message:
            `TAP ${args.tapName} ready: host=${args.hostIp}/${args.prefix} NAT=${args.guestSubnet}`,
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
        const pidFile = socketPath + ".pid";
        const socketBasename = socketPath.split("/").pop() ?? "firecracker";
        const logPath = args.logPath ??
          `/var/log/${socketBasename}.log`;
        const vsockCleanup = args.vsockUdsPath
          ? `rm -f ${shellEsc(args.vsockUdsPath)} ${args.vsockUdsPath}_*;`
          : "";

        // Check if already alive via PID sidecar, then start fresh if not.
        // On fresh start: remove stale socket + vsock UDS files so restore-snapshot
        // doesn't hit EADDRINUSE when Firecracker binds the vsock backend.
        // Polls 100ms × 30 = 3s max for socket readiness (vs hardcoded sleep 1).
        const cmd = [
          `if [ -f ${shellEsc(pidFile)} ]; then`,
          `  PID=$(cat ${shellEsc(pidFile)});`,
          `  if kill -0 "$PID" 2>/dev/null && test -S ${
            shellEsc(socketPath)
          }; then`,
          `    echo "alive:$PID"; exit 0;`,
          `  fi;`,
          `fi`,
          `rm -f ${shellEsc(socketPath)} ${shellEsc(pidFile)}`,
          vsockCleanup,
          `setsid firecracker --api-sock ${
            shellEsc(socketPath)
          } --level Error </dev/null >${shellEsc(logPath)} 2>&1 &`,
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
  },
};
