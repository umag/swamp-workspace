import { z } from "npm:zod@4";
import {
  connLabel,
  defineXml,
  IDEMPOTENT_ERRORS,
  isIdempotent,
  type LibvirtConn,
  redactSecrets,
  virsh,
  virshTry,
} from "./lib/connection.ts";
import {
  parseKV,
  parseTableOutput,
  parseVmList,
  parseXmlDisks,
  parseXmlGraphics,
  parseXmlInterfaces,
} from "./lib/parse.ts";

const GlobalArgsSchema = z.object({
  host: z.string().optional().describe(
    "SSH host/IP of the libvirt hypervisor. If set, virsh runs there over SSH. Omit for local/URI mode.",
  ),
  user: z.string().default("root").describe(
    "SSH username (SSH mode only; default: root)",
  ),
  uri: z.string().optional().describe(
    "Libvirt connection URI. Local mode (no host) defaults to qemu:///system; in SSH mode it is passed to the remote virsh via -c when set.",
  ),
});

const VmSchema = z.object({
  name: z.string(),
  state: z.string(),
  autostart: z.string(),
  vcpus: z.number(),
  memoryMB: z.number(),
  uuid: z.string(),
});

const VmListSchema = z.object({
  host: z.string(),
  vms: z.array(VmSchema),
  count: z.number(),
  timestamp: z.string(),
});

const VmDetailSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  state: z.string(),
  vcpus: z.number(),
  cpuTime: z.string(),
  memoryMB: z.number(),
  maxMemoryMB: z.number(),
  autostart: z.string(),
  disks: z.array(
    z.object({ source: z.string(), target: z.string(), bus: z.string() }),
  ),
  interfaces: z.array(
    z.object({ mac: z.string(), source: z.string(), model: z.string() }),
  ),
  graphics: z.array(
    z.object({ type: z.string(), port: z.string(), listen: z.string() }),
  ),
  timestamp: z.string(),
});

const SnapshotSchema = z.object({
  name: z.string(),
  creationTime: z.string(),
  state: z.string(),
  parent: z.string(),
  description: z.string(),
});

const SnapshotListSchema = z.object({
  domain: z.string(),
  snapshots: z.array(SnapshotSchema),
  count: z.number(),
  timestamp: z.string(),
});

const StatsSchema = z.object({
  domain: z.string(),
  stats: z.record(z.string(), z.string()),
  timestamp: z.string(),
});

const ActionResultSchema = z.object({
  domain: z.string(),
  action: z.string(),
  message: z.string(),
  state: z.string(),
  timestamp: z.string(),
});

// Guest-agent info types virsh accepts; user input is validated against this
// allowlist so it cannot inject an arbitrary `--flag` into the argv.
const GUEST_INFO_TYPES = [
  "users",
  "os",
  "timezone",
  "hostname",
  "filesystem",
  "disk",
  "interface",
];

async function getDomDetail(conn: LibvirtConn, name: string) {
  const info = parseKV((await virsh(conn, ["dominfo", name])).stdout);
  return {
    name,
    uuid: info["UUID"] || "",
    state: info["State"] || "",
    vcpus: parseInt(info["CPU(s)"] || "0"),
    cpuTime: info["CPU time"] || "",
    memoryMB: Math.round(parseInt(info["Used memory"] || "0") / 1024),
    maxMemoryMB: Math.round(parseInt(info["Max memory"] || "0") / 1024),
    autostart: info["Autostart"] || "",
    disks: [],
    interfaces: [],
    graphics: [],
    timestamp: new Date().toISOString(),
  };
}

async function reportState(
  conn: LibvirtConn,
  name: string,
  action: string,
  context: {
    logger: { info: (m: string) => void };
    writeResource: CallableFunction;
  },
) {
  const detail = await getDomDetail(conn, name);
  context.logger.info(`${action} VM ${name}: now ${detail.state}`);
  const handle = await context.writeResource("actionResult", name, {
    domain: name,
    action,
    message: `${action} completed`,
    state: detail.state,
    timestamp: detail.timestamp,
  });
  return { dataHandles: [handle] };
}

/**
 * `@bad-at-naming/libvirt/vm` — full VM (domain) lifecycle, tuning, monitoring,
 * snapshots, and guest-agent operations.
 *
 * Lists/describes domains; starts, stops (graceful + forced), reboots, resets,
 * suspends, resumes; defines (idempotent — redefines an existing domain),
 * undefines, renames, saves/restores; tunes vCPUs/memory; attaches/detaches
 * disks and interfaces; changes media; reports block/interface/memory/CPU
 * stats; manages snapshots; and queries the guest agent. start/stop/forceStop/
 * undefine/detachDisk are idempotent. Connects over SSH when `host` is set,
 * otherwise runs `virsh` locally against `uri` (default qemu:///system).
 *
 * @example
 * swamp model create @bad-at-naming/libvirt/vm vms --input host=10.0.0.5
 * swamp model method run vms list
 * swamp model method run vms start --input name=web
 */
export const model = {
  type: "@bad-at-naming/libvirt/vm",
  version: "2026.05.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description: "VM list or detail",
      schema: VmListSchema.or(VmDetailSchema),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    actionResult: {
      description: "Result of a VM action (start, stop, etc.)",
      schema: ActionResultSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    snapshot: {
      description: "Snapshot list or detail",
      schema: SnapshotListSchema.or(SnapshotSchema),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    stats: {
      description: "VM statistics (block, interface, memory, CPU)",
      schema: StatsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    // ==================== Domain Listing ====================

    list: {
      description: "List all VMs with state, vCPUs, memory, and autostart",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const [listResult, autostartResult] = await Promise.all([
          virsh(conn, ["list", "--all"]),
          virsh(conn, [
            "list",
            "--all",
            "--autostart",
            "--name",
          ]),
        ]);
        const rawVms = parseVmList(listResult.stdout);
        const vms: z.infer<typeof VmSchema>[] = [];
        const autoNames = new Set(
          autostartResult.stdout.trim().split("\n").map((n) => n.trim()).filter(
            Boolean,
          ),
        );
        for (const vm of rawVms) {
          const info = parseKV(
            (await virsh(conn, ["dominfo", vm.name])).stdout,
          );
          vms.push({
            name: vm.name,
            state: vm.state,
            autostart: autoNames.has(vm.name) ? "enabled" : "disabled",
            vcpus: parseInt(info["CPU(s)"] || "0"),
            memoryMB: Math.round(parseInt(info["Max memory"] || "0") / 1024),
            uuid: info["UUID"] || "",
          });
        }
        context.logger.info(`Found ${vms.length} VMs`);
        for (const vm of vms) {
          context.logger.info(
            `  ${vm.name}: ${vm.state} (${vm.vcpus} vCPU, ${vm.memoryMB}MB)`,
          );
        }
        const handle = await context.writeResource("vm", "list", {
          host: connLabel(conn),
          vms,
          count: vms.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    get: {
      description: "Get detailed VM info including disks, NICs, and graphics",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const [infoResult, xmlResult] = await Promise.all([
          virsh(conn, ["dominfo", args.name]),
          virsh(conn, ["dumpxml", args.name]),
        ]);
        const info = parseKV(infoResult.stdout);
        const xml = xmlResult.stdout;
        const data = {
          name: args.name,
          uuid: info["UUID"] || "",
          state: info["State"] || "",
          vcpus: parseInt(info["CPU(s)"] || "0"),
          cpuTime: info["CPU time"] || "",
          memoryMB: Math.round(parseInt(info["Used memory"] || "0") / 1024),
          maxMemoryMB: Math.round(parseInt(info["Max memory"] || "0") / 1024),
          autostart: info["Autostart"] || "",
          disks: parseXmlDisks(xml),
          interfaces: parseXmlInterfaces(xml),
          graphics: parseXmlGraphics(xml),
          timestamp: new Date().toISOString(),
        };
        context.logger.info(
          `${data.name}: ${data.state}, ${data.vcpus} vCPU, ${data.memoryMB}/${data.maxMemoryMB}MB`,
        );
        const handle = await context.writeResource("vm", args.name, data);
        return { dataHandles: [handle] };
      },
    },

    dumpxml: {
      description: "Get raw XML definition of a VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["dumpxml", args.name]);
        // Redact graphics passwords in the LOG; stored message keeps raw XML.
        context.logger.info(redactSecrets(result.stdout));
        const handle = await context.writeResource("actionResult", args.name, {
          domain: args.name,
          action: "dumpxml",
          message: result.stdout,
          state: "",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ==================== Domain Lifecycle ====================

    start: {
      description: "Start a VM. Idempotent — succeeds if already running.",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const res = await virshTry(conn, ["start", args.name]);
        if (res.code !== 0) {
          if (isIdempotent(res, IDEMPOTENT_ERRORS.vmAlreadyRunning)) {
            context.logger.info(`VM ${args.name} is already running`);
          } else {
            throw new Error(
              `virsh start failed (exit ${res.code}): ${
                res.stderr.slice(-500)
              }`,
            );
          }
        }
        return await reportState(conn, args.name, "start", context);
      },
    },

    stop: {
      description:
        "Gracefully shut down a VM (ACPI). Idempotent — succeeds if already stopped.",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const res = await virshTry(conn, ["shutdown", args.name]);
        if (res.code !== 0) {
          if (isIdempotent(res, IDEMPOTENT_ERRORS.vmNotRunning)) {
            context.logger.info(`VM ${args.name} is already stopped`);
          } else {
            throw new Error(
              `virsh shutdown failed (exit ${res.code}): ${
                res.stderr.slice(-500)
              }`,
            );
          }
        }
        return await reportState(conn, args.name, "shutdown", context);
      },
    },

    forceStop: {
      description:
        "Force stop a VM (pull the power cord). Idempotent — succeeds if already stopped.",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const res = await virshTry(conn, ["destroy", args.name]);
        if (res.code !== 0) {
          if (
            isIdempotent(res, IDEMPOTENT_ERRORS.vmNotRunning) ||
            isIdempotent(res, IDEMPOTENT_ERRORS.domainNotFound)
          ) {
            context.logger.info(`VM ${args.name} is already stopped`);
          } else {
            throw new Error(
              `virsh destroy failed (exit ${res.code}): ${
                res.stderr.slice(-500)
              }`,
            );
          }
        }
        return await reportState(conn, args.name, "destroy", context);
      },
    },

    restart: {
      description: "Reboot a running VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        await virsh(conn, ["reboot", args.name]);
        return await reportState(conn, args.name, "reboot", context);
      },
    },

    reset: {
      description: "Hard reset a VM (no ACPI, immediate reset)",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        await virsh(conn, ["reset", args.name]);
        return await reportState(conn, args.name, "reset", context);
      },
    },

    suspend: {
      description: "Suspend (pause) a running VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        await virsh(conn, ["suspend", args.name]);
        return await reportState(conn, args.name, "suspend", context);
      },
    },

    resume: {
      description: "Resume a suspended (paused) VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        await virsh(conn, ["resume", args.name]);
        return await reportState(conn, args.name, "resume", context);
      },
    },

    autostart: {
      description: "Enable or disable autostart for a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        enabled: z.boolean().describe("true to enable, false to disable"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = args.enabled
          ? ["autostart", args.name]
          : ["autostart", "--disable", args.name];
        await virsh(conn, argv);
        return await reportState(conn, args.name, "autostart", context);
      },
    },

    define: {
      description:
        "Define a VM from XML. Idempotent: undefines an existing domain of the same name first, then redefines.",
      arguments: z.object({
        xml: z.string().describe("Full libvirt domain XML definition"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const xmlNameMatch = args.xml.match(/<name>([^<]+)<\/name>/);
        const domName = xmlNameMatch?.[1];

        // Pre-emptively remove an existing domain of the same name so a
        // redefine is idempotent (matches the published behavior; the fork's
        // UUID-preserving approach is intentionally NOT adopted).
        if (domName) {
          const check = await virshTry(conn, ["domstate", domName]);
          if (check.code === 0) {
            const state = check.stdout.trim();
            context.logger.info(
              `VM ${domName} exists (state: ${state}), will redefine`,
            );
            if (state === "running" || state === "paused") {
              await virshTry(conn, ["destroy", domName]);
            }
            const undef = await virshTry(conn, [
              "undefine",
              domName,
              "--nvram",
            ]);
            if (undef.code !== 0) {
              await virshTry(conn, ["undefine", domName]);
            }
          }
        }

        const result = await defineXml(conn, "define", args.xml);
        // Prefer the authoritative <name> from the XML; fall back to the
        // virsh stdout (stripping any surrounding quotes newer virsh adds).
        const nameMatch = result.stdout.match(/Domain\s+(\S+)\s+defined/);
        const name = domName ||
          nameMatch?.[1]?.replace(/^['"]|['"]$/g, "") || "unknown";
        context.logger.info(`Defined VM: ${name}`);
        const handle = await context.writeResource("actionResult", name, {
          domain: name,
          action: "define",
          message: result.stdout.trim(),
          state: "shut off",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    undefine: {
      description: "Undefine a VM (remove its persistent configuration)",
      arguments: z.object({
        name: z.string().describe("VM name"),
        removeStorage: z.boolean().default(false).describe(
          "Also remove all associated storage volumes",
        ),
        snapshotsMetadata: z.boolean().default(false).describe(
          "Also remove snapshot metadata",
        ),
        nvram: z.boolean().default(false).describe(
          "Also remove NVRAM file (required for UEFI VMs)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["undefine", args.name];
        if (args.removeStorage) argv.push("--remove-all-storage");
        if (args.snapshotsMetadata) argv.push("--snapshots-metadata");
        if (args.nvram) argv.push("--nvram");
        const res = await virshTry(conn, argv);
        let message: string;
        if (res.code === 0) {
          message = res.stdout.trim() || `${args.name} undefined`;
          context.logger.info(message);
        } else if (isIdempotent(res, IDEMPOTENT_ERRORS.domainNotFound)) {
          message = `VM ${args.name} is already undefined`;
          context.logger.info(message);
        } else {
          throw new Error(
            `virsh undefine failed (exit ${res.code}): ${
              res.stderr.slice(-500)
            }`,
          );
        }
        const handle = await context.writeResource("actionResult", args.name, {
          domain: args.name,
          action: "undefine",
          message,
          state: "undefined",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    rename: {
      description: "Rename a VM (must be shut off)",
      arguments: z.object({
        name: z.string().describe("Current VM name"),
        newName: z.string().describe("New VM name"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "domrename",
          args.name,
          args.newName,
        ]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource(
          "actionResult",
          args.newName,
          {
            domain: args.newName,
            action: "rename",
            message: `Renamed ${args.name} → ${args.newName}`,
            state: "shut off",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    save: {
      description: "Save VM state to a file (like hibernate)",
      arguments: z.object({
        name: z.string().describe("VM name"),
        file: z.string().describe("Path on hypervisor to save state to"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        await virsh(conn, ["save", args.name, args.file]);
        context.logger.info(`Saved VM ${args.name} to ${args.file}`);
        const handle = await context.writeResource("actionResult", args.name, {
          domain: args.name,
          action: "save",
          message: `State saved to ${args.file}`,
          state: "saved",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    restore: {
      description: "Restore a VM from a saved state file",
      arguments: z.object({
        file: z.string().describe("Path on hypervisor to restore from"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        await virsh(conn, ["restore", args.file]);
        context.logger.info(`Restored from ${args.file}`);
        const handle = await context.writeResource("actionResult", "restored", {
          domain: "restored",
          action: "restore",
          message: `Restored from ${args.file}`,
          state: "running",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ==================== Resource Tuning ====================

    setVcpus: {
      description: "Change the number of virtual CPUs",
      arguments: z.object({
        name: z.string().describe("VM name"),
        count: z.number().int().min(1).describe("Number of vCPUs"),
        maximum: z.boolean().default(false).describe(
          "Set maximum vCPU count instead of current",
        ),
        config: z.boolean().default(false).describe(
          "Apply to persistent config (next boot)",
        ),
        live: z.boolean().default(true).describe(
          "Apply to running VM (hotplug)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["setvcpus", args.name, String(args.count)];
        if (args.maximum) argv.push("--maximum");
        if (args.live && !args.maximum) argv.push("--live");
        if (args.config) argv.push("--config");
        if (argv.length === 3) argv.push("--config");
        await virsh(conn, argv);
        context.logger.info(`Set vCPUs for ${args.name} to ${args.count}`);
        return await reportState(conn, args.name, "setVcpus", context);
      },
    },

    setMemory: {
      description: "Change memory allocation (in MiB)",
      arguments: z.object({
        name: z.string().describe("VM name"),
        sizeMB: z.number().int().min(64).describe("Memory in MiB"),
        maximum: z.boolean().default(false).describe(
          "Set maximum memory instead of current",
        ),
        config: z.boolean().default(false).describe(
          "Apply to persistent config",
        ),
        live: z.boolean().default(true).describe("Apply to running VM"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const cmd = args.maximum ? "setmaxmem" : "setmem";
        const argv = [cmd, args.name, String(args.sizeMB * 1024)];
        if (args.live && !args.maximum) argv.push("--live");
        if (args.config) argv.push("--config");
        if (argv.length === 3) argv.push("--config");
        await virsh(conn, argv);
        context.logger.info(`Set ${cmd} for ${args.name} to ${args.sizeMB}MB`);
        return await reportState(conn, args.name, cmd, context);
      },
    },

    attachDisk: {
      description: "Attach a disk device to a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        source: z.string().describe(
          "Disk source path (image file or block device)",
        ),
        target: z.string().describe("Target device name (e.g. vdb, sdb)"),
        driver: z.enum(["qcow2", "raw"]).default("qcow2").describe(
          "Disk driver/format",
        ),
        cache: z.enum([
          "none",
          "writethrough",
          "writeback",
          "directsync",
          "unsafe",
        ]).optional().describe("Cache mode"),
        persistent: z.boolean().default(false).describe(
          "Make change persistent across reboots (running VMs)",
        ),
        config: z.boolean().default(false).describe(
          "Apply to persistent config only (stopped VMs)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = [
          "attach-disk",
          args.name,
          args.source,
          args.target,
          "--driver",
          "qemu",
          "--subdriver",
          args.driver,
        ];
        if (args.cache) argv.push("--cache", args.cache);
        if (args.config) argv.push("--config");
        else if (args.persistent) argv.push("--persistent");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        return await reportState(conn, args.name, "attachDisk", context);
      },
    },

    detachDisk: {
      description:
        "Detach a disk device from a VM. Idempotent: succeeds if disk not found.",
      arguments: z.object({
        name: z.string().describe("VM name"),
        target: z.string().describe("Target device name to detach (e.g. vdb)"),
        persistent: z.boolean().default(false).describe(
          "Make change persistent (running VMs)",
        ),
        config: z.boolean().default(false).describe(
          "Apply to persistent config only (stopped VMs)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["detach-disk", args.name, args.target];
        if (args.config) argv.push("--config");
        else if (args.persistent) argv.push("--persistent");
        const res = await virshTry(conn, argv);
        if (res.code !== 0) {
          if (isIdempotent(res, IDEMPOTENT_ERRORS.diskNotFound)) {
            context.logger.info(
              `Disk ${args.target} not found on ${args.name}, already detached`,
            );
          } else {
            throw new Error(
              `virsh detach-disk failed (exit ${res.code}): ${
                res.stderr.slice(-500)
              }`,
            );
          }
        } else {
          context.logger.info(res.stdout.trim());
        }
        return await reportState(conn, args.name, "detachDisk", context);
      },
    },

    attachInterface: {
      description: "Attach a network interface to a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        type: z.enum(["bridge", "network"]).describe("Interface type"),
        source: z.string().describe(
          "Source bridge/network name (e.g. br0, default)",
        ),
        model: z.string().default("virtio").describe(
          "NIC model (virtio, e1000, rtl8139)",
        ),
        persistent: z.boolean().default(false).describe(
          "Make change persistent",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = [
          "attach-interface",
          args.name,
          args.type,
          args.source,
          "--model",
          args.model,
        ];
        if (args.persistent) argv.push("--persistent");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        return await reportState(conn, args.name, "attachInterface", context);
      },
    },

    detachInterface: {
      description: "Detach a network interface from a VM by MAC address",
      arguments: z.object({
        name: z.string().describe("VM name"),
        type: z.enum(["bridge", "network"]).describe("Interface type"),
        mac: z.string().describe("MAC address of the interface to detach"),
        persistent: z.boolean().default(false).describe(
          "Make change persistent",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = [
          "detach-interface",
          args.name,
          args.type,
          "--mac",
          args.mac,
        ];
        if (args.persistent) argv.push("--persistent");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        return await reportState(conn, args.name, "detachInterface", context);
      },
    },

    changeMedia: {
      description: "Change CD/DVD media for a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        target: z.string().describe("Target device (e.g. hda, sda)"),
        source: z.string().optional().describe("New ISO path (omit to eject)"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["change-media", args.name, args.target];
        if (args.source) argv.push(args.source, "--insert");
        else argv.push("--eject");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        return await reportState(conn, args.name, "changeMedia", context);
      },
    },

    // ==================== Monitoring ====================

    blockList: {
      description: "List all block devices for a VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "domblklist",
          args.name,
          "--details",
        ]);
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "stats",
          `${args.name}-blklist`,
          {
            domain: args.name,
            stats: { output: result.stdout },
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    interfaceList: {
      description: "List all network interfaces for a VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["domiflist", args.name]);
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "stats",
          `${args.name}-iflist`,
          {
            domain: args.name,
            stats: { output: result.stdout },
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    interfaceAddresses: {
      description: "Get IP addresses of a VM's interfaces",
      arguments: z.object({
        name: z.string().describe("VM name"),
        source: z.enum(["lease", "agent", "arp"]).default("lease").describe(
          "Address source: lease (DHCP), agent (guest-agent), arp",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virshTry(conn, [
          "domifaddr",
          args.name,
          "--source",
          args.source,
        ]);
        context.logger.info(result.stdout || "(no addresses found)");
        const handle = await context.writeResource(
          "stats",
          `${args.name}-ifaddr`,
          {
            domain: args.name,
            stats: { source: args.source, output: result.stdout },
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    blockStats: {
      description: "Get block device I/O statistics for a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        device: z.string().optional().describe(
          "Specific block device (e.g. vda). Omit for all.",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["domblkstat", args.name];
        if (args.device) argv.push(args.device);
        const result = await virsh(conn, argv);
        const stats = parseKV(result.stdout);
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "stats",
          `${args.name}-blkstat`,
          {
            domain: args.name,
            stats,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    interfaceStats: {
      description: "Get network interface statistics for a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        interface: z.string().describe("Interface device name (e.g. vnet0)"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "domifstat",
          args.name,
          args.interface,
        ]);
        const stats = parseKV(result.stdout);
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "stats",
          `${args.name}-ifstat`,
          {
            domain: args.name,
            stats,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    memoryStats: {
      description: "Get memory statistics for a VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["dommemstat", args.name]);
        const stats: Record<string, string> = {};
        for (const line of result.stdout.trim().split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) stats[parts[0]] = parts.slice(1).join(" ");
        }
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "stats",
          `${args.name}-memstat`,
          {
            domain: args.name,
            stats,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    cpuStats: {
      description: "Get CPU statistics for a VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["cpu-stats", args.name, "--total"]);
        const stats = parseKV(result.stdout);
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "stats",
          `${args.name}-cpustat`,
          {
            domain: args.name,
            stats,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    domstats: {
      description:
        "Get comprehensive statistics for a VM (state, CPU, balloon, vCPU, net, block)",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["domstats", args.name]);
        const stats: Record<string, string> = {};
        for (const line of result.stdout.trim().split("\n")) {
          const eq = line.indexOf("=");
          if (eq === -1) continue;
          stats[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        context.logger.info(
          `${Object.keys(stats).length} stats collected for ${args.name}`,
        );
        const handle = await context.writeResource(
          "stats",
          `${args.name}-domstats`,
          {
            domain: args.name,
            stats,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // ==================== Snapshots ====================

    snapshotList: {
      description: "List all snapshots for a VM",
      arguments: z.object({ name: z.string().describe("VM name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const treeResult = await virshTry(conn, [
          "snapshot-list",
          args.name,
          "--tree",
        ]);
        const listResult = await virshTry(conn, ["snapshot-list", args.name]);
        const snapshots: z.infer<typeof SnapshotSchema>[] = [];
        const rows = parseTableOutput(listResult.stdout);
        for (const row of rows) {
          const name = row["Name"] || "";
          if (!name) continue;
          const info = parseKV(
            (await virshTry(conn, ["snapshot-info", args.name, name])).stdout,
          );
          snapshots.push({
            name,
            creationTime: row["Creation Time"] || info["Date"] || "",
            state: row["State"] || info["State"] || "",
            parent: info["Parent"] || "",
            description: info["Description"] || "",
          });
        }
        context.logger.info(`${snapshots.length} snapshots for ${args.name}`);
        if (treeResult.stdout.trim()) context.logger.info(treeResult.stdout);
        const handle = await context.writeResource(
          "snapshot",
          `${args.name}-list`,
          {
            domain: args.name,
            snapshots,
            count: snapshots.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    snapshotCreate: {
      description: "Create a snapshot of a VM",
      arguments: z.object({
        name: z.string().describe("VM name"),
        snapshotName: z.string().describe("Name for the snapshot"),
        description: z.string().optional().describe("Snapshot description"),
        quiesce: z.boolean().default(false).describe(
          "Quiesce guest filesystem (requires guest agent)",
        ),
        diskOnly: z.boolean().default(false).describe(
          "Disk-only snapshot (no memory)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = [
          "snapshot-create-as",
          args.name,
          "--name",
          args.snapshotName,
        ];
        if (args.description) argv.push("--description", args.description);
        if (args.quiesce) argv.push("--quiesce");
        if (args.diskOnly) argv.push("--disk-only");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource(
          "snapshot",
          `${args.name}-${args.snapshotName}`,
          {
            name: args.snapshotName,
            creationTime: new Date().toISOString(),
            state: "created",
            parent: "",
            description: args.description || "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    snapshotInfo: {
      description: "Get info about a specific snapshot",
      arguments: z.object({
        name: z.string().describe("VM name"),
        snapshotName: z.string().describe("Snapshot name"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "snapshot-info",
          args.name,
          args.snapshotName,
        ]);
        const info = parseKV(result.stdout);
        context.logger.info(result.stdout);
        const handle = await context.writeResource(
          "snapshot",
          `${args.name}-${args.snapshotName}`,
          {
            name: args.snapshotName,
            creationTime: info["Date"] || "",
            state: info["State"] || "",
            parent: info["Parent"] || "",
            description: info["Description"] || "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    snapshotRevert: {
      description: "Revert a VM to a snapshot",
      arguments: z.object({
        name: z.string().describe("VM name"),
        snapshotName: z.string().describe("Snapshot name to revert to"),
        running: z.boolean().default(false).describe("Start VM after revert"),
        paused: z.boolean().default(false).describe(
          "Leave VM paused after revert",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["snapshot-revert", args.name, args.snapshotName];
        if (args.running) argv.push("--running");
        if (args.paused) argv.push("--paused");
        await virsh(conn, argv);
        context.logger.info(
          `Reverted ${args.name} to snapshot ${args.snapshotName}`,
        );
        return await reportState(conn, args.name, "snapshotRevert", context);
      },
    },

    snapshotDelete: {
      description: "Delete a snapshot",
      arguments: z.object({
        name: z.string().describe("VM name"),
        snapshotName: z.string().describe("Snapshot name to delete"),
        children: z.boolean().default(false).describe(
          "Also delete child snapshots",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["snapshot-delete", args.name, args.snapshotName];
        if (args.children) argv.push("--children");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource(
          "actionResult",
          `${args.name}-snapdel`,
          {
            domain: args.name,
            action: "snapshotDelete",
            message: `Deleted snapshot ${args.snapshotName}`,
            state: "",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    snapshotDumpxml: {
      description: "Get raw XML of a snapshot",
      arguments: z.object({
        name: z.string().describe("VM name"),
        snapshotName: z.string().describe("Snapshot name"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "snapshot-dumpxml",
          args.name,
          args.snapshotName,
        ]);
        // Redact graphics passwords in the LOG; stored message keeps raw XML.
        context.logger.info(redactSecrets(result.stdout));
        const handle = await context.writeResource(
          "actionResult",
          `${args.name}-snapxml`,
          {
            domain: args.name,
            action: "snapshotDumpxml",
            message: result.stdout,
            state: "",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // ==================== Guest Agent ====================

    guestInfo: {
      description:
        "Query guest information via QEMU guest agent (hostname, OS, IPs, filesystems, etc.)",
      arguments: z.object({
        name: z.string().describe("VM name"),
        types: z.string().optional().describe(
          "Comma-separated types: users, os, timezone, hostname, filesystem, disk, interface (omit for all)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["guestinfo", args.name];
        if (args.types) {
          for (const raw of args.types.split(",")) {
            const t = raw.trim();
            if (!t) continue;
            if (!GUEST_INFO_TYPES.includes(t)) {
              throw new Error(
                `Invalid guestinfo type "${t}". Allowed: ${
                  GUEST_INFO_TYPES.join(", ")
                }`,
              );
            }
            argv.push(`--${t}`);
          }
        }
        const result = await virshTry(conn, argv);
        if (result.code !== 0) {
          context.logger.warn(
            `Guest agent not available: ${result.stderr.slice(-200)}`,
          );
        }
        const stats = parseKV(result.stdout);
        context.logger.info(result.stdout || "(no guest agent response)");
        const handle = await context.writeResource(
          "stats",
          `${args.name}-guestinfo`,
          {
            domain: args.name,
            stats,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    setUserPassword: {
      description:
        "Set a user password inside the guest (requires guest agent). NOTE: the password is passed as a virsh argument and is visible in the hypervisor's process list while running — see README limitations.",
      arguments: z.object({
        name: z.string().describe("VM name"),
        username: z.string().describe("Username inside the guest"),
        password: z.string().describe("New password"),
        encrypted: z.boolean().default(false).describe(
          "Password is already encrypted/hashed",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        // virsh set-user-password has no --file/--stdin input, so the password
        // must be an argv token (shell-quoted, injection-safe). It is visible in
        // the hypervisor's process list while running and is never logged here
        // (only the username is). See README "Security notes".
        const argv = [
          "set-user-password",
          args.name,
          args.username,
          args.password,
        ];
        if (args.encrypted) argv.push("--encrypted");
        await virsh(conn, argv);
        context.logger.info(
          `Set password for user ${args.username} in ${args.name}`,
        );
        const handle = await context.writeResource("actionResult", args.name, {
          domain: args.name,
          action: "setUserPassword",
          message: `Password set for ${args.username}`,
          state: "",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
