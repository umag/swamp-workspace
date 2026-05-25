import { z } from "npm:zod@4";
import { connLabel, runSshRaw, virsh } from "./lib/connection.ts";
import { parseKV } from "./lib/parse.ts";

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

const HostInfoSchema = z.object({
  hostname: z.string(),
  uri: z.string(),
  cpuModel: z.string(),
  cpuCount: z.number(),
  cpuFrequency: z.string(),
  cpuSockets: z.number(),
  coresPerSocket: z.number(),
  threadsPerCore: z.number(),
  numaNodes: z.number(),
  memoryMB: z.number(),
  libvirtVersion: z.string(),
  hypervisorVersion: z.string(),
  timestamp: z.string(),
});

const StatsSchema = z.object({
  type: z.string(),
  stats: z.record(z.string(), z.string()),
  timestamp: z.string(),
});

const DeviceListSchema = z.object({
  host: z.string(),
  devices: z.array(z.object({ name: z.string(), type: z.string() })),
  count: z.number(),
  timestamp: z.string(),
});

/**
 * `@bad-at-naming/libvirt/host` — hypervisor host information and node statistics.
 *
 * Reports CPU model/topology, memory, libvirt and hypervisor versions, host
 * capabilities and SMBIOS sysinfo XML, live CPU/memory stats, and the node
 * device list. Connects over SSH when `host` is set, otherwise runs `virsh`
 * locally against `uri` (default qemu:///system).
 *
 * @example
 * # remote (SSH) host
 * swamp model create @bad-at-naming/libvirt/host hv --input host=10.0.0.5
 * swamp model method run hv info
 * # local host
 * swamp model create @bad-at-naming/libvirt/host local-hv
 * swamp model method run local-hv info
 */
export const model = {
  type: "@bad-at-naming/libvirt/host",
  version: "2026.05.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    info: {
      description: "Hypervisor host information",
      schema: HostInfoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    stats: {
      description: "Host statistics (CPU, memory)",
      schema: StatsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    devices: {
      description: "Node device list",
      schema: DeviceListSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    info: {
      description: "Get hypervisor host info (CPU, memory, versions)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const [nodeResult, hostnameResult, versionResult, uriResult] =
          await Promise.all([
            virsh(conn, ["nodeinfo"]),
            virsh(conn, ["hostname"]),
            virsh(conn, ["version"]),
            virsh(conn, ["uri"]),
          ]);
        const node = parseKV(nodeResult.stdout);
        const ver = parseKV(versionResult.stdout);
        const data = {
          hostname: hostnameResult.stdout.trim(),
          uri: uriResult.stdout.trim(),
          cpuModel: node["CPU model"] || "",
          cpuCount: parseInt(node["CPU(s)"] || "0"),
          cpuFrequency: node["CPU frequency"] || "",
          cpuSockets: parseInt(node["CPU socket(s)"] || "0"),
          coresPerSocket: parseInt(node["Core(s) per socket"] || "0"),
          threadsPerCore: parseInt(node["Thread(s) per core"] || "0"),
          numaNodes: parseInt(node["NUMA cell(s)"] || "0"),
          memoryMB: Math.round(parseInt(node["Memory size"] || "0") / 1024),
          libvirtVersion: ver["Using library"] || "",
          hypervisorVersion: ver["Running hypervisor"] || "",
          timestamp: new Date().toISOString(),
        };
        context.logger.info(
          `${data.hostname}: ${data.cpuModel}, ${data.cpuCount} CPUs, ${data.memoryMB}MB RAM`,
        );
        context.logger.info(`Libvirt: ${data.libvirtVersion}`);
        context.logger.info(`Hypervisor: ${data.hypervisorVersion}`);
        const handle = await context.writeResource("info", "main", data);
        return { dataHandles: [handle] };
      },
    },

    capabilities: {
      description: "Get hypervisor capabilities XML",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["capabilities"]);
        context.logger.info(`Capabilities XML: ${result.stdout.length} bytes`);
        const handle = await context.writeResource("stats", "capabilities", {
          type: "capabilities",
          stats: { xml: result.stdout },
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sysinfo: {
      description: "Get host system information (SMBIOS/DMI data)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["sysinfo"]);
        context.logger.info(`Sysinfo XML: ${result.stdout.length} bytes`);
        const handle = await context.writeResource("stats", "sysinfo", {
          type: "sysinfo",
          stats: { xml: result.stdout },
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    cpuStats: {
      description: "Get host CPU usage statistics",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["nodecpustats", "--percent"]);
        const stats: Record<string, string> = {};
        for (const line of result.stdout.trim().split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) stats[parts[0]] = parts.slice(1).join(" ");
        }
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("stats", "cpustats", {
          type: "nodecpustats",
          stats,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    memStats: {
      description: "Get host memory statistics",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["nodememstats"]);
        const stats: Record<string, string> = {};
        for (const line of result.stdout.trim().split("\n")) {
          const sep = line.indexOf(":");
          if (sep !== -1) {
            stats[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
          }
        }
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("stats", "memstats", {
          type: "nodememstats",
          stats,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    deviceList: {
      description:
        "List node devices (PCI, USB, network, storage controllers, etc.)",
      arguments: z.object({
        cap: z.string().optional().describe(
          "Filter by capability: system, pci, usb, usb_device, net, scsi_host, scsi, storage, drm",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const listArgs = args.cap
          ? ["nodedev-list", "--cap", args.cap]
          : ["nodedev-list"];
        const [treeResult, listResult] = await Promise.all([
          virsh(conn, ["nodedev-list", "--tree"]),
          virsh(conn, listArgs),
        ]);
        const devices = listResult.stdout.trim().split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((name) => ({ name, type: args.cap || "all" }));
        context.logger.info(
          `${devices.length} devices${args.cap ? ` (cap=${args.cap})` : ""}`,
        );
        context.logger.info(treeResult.stdout);
        const handle = await context.writeResource("devices", "list", {
          host: connLabel(conn),
          devices,
          count: devices.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    addRoute: {
      description:
        "Add a static route on the hypervisor host (SSH host mode only; runs `ip route` over SSH)",
      arguments: z.object({
        destination: z.string().describe(
          "Destination CIDR (e.g., 10.244.0.0/16)",
        ),
        gateway: z.string().describe("Gateway IP address"),
        replace: z.boolean().default(true).describe(
          "Use 'replace' instead of 'add' to be idempotent",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const verb = args.replace ? "replace" : "add";
        // runSshRaw throws in local/URI mode — `ip route` only makes sense on
        // a remote SSH host, not on the swamp host running virsh locally.
        const result = await runSshRaw(conn, [
          "ip",
          "route",
          verb,
          args.destination,
          "via",
          args.gateway,
        ]);
        context.logger.info(
          `Route ${verb}d: ${args.destination} via ${args.gateway}`,
        );
        const handle = await context.writeResource(
          "stats",
          `route-${args.destination.replace(/[/.]/g, "-")}`,
          {
            type: "route",
            stats: {
              action: verb,
              destination: args.destination,
              gateway: args.gateway,
              stdout: result.stdout.trim(),
            },
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
