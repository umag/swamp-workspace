import { z } from "npm:zod@4";
import {
  connLabel,
  defineXml,
  redactSecrets,
  virsh,
  virshTry,
} from "./lib/connection.ts";
import { parseKV, parseNetList } from "./lib/parse.ts";

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

const NetworkSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  state: z.string(),
  autostart: z.string(),
  persistent: z.string(),
  bridge: z.string(),
});

const NetworkListSchema = z.object({
  host: z.string(),
  networks: z.array(NetworkSchema),
  count: z.number(),
  timestamp: z.string(),
});

const NetworkDetailSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  state: z.string(),
  autostart: z.string(),
  persistent: z.string(),
  bridge: z.string(),
  xml: z.string(),
  timestamp: z.string(),
});

const DhcpLeaseSchema = z.object({
  expiry: z.string(),
  mac: z.string(),
  protocol: z.string(),
  ipaddr: z.string(),
  hostname: z.string(),
  clientid: z.string(),
});

const DhcpLeaseListSchema = z.object({
  network: z.string(),
  leases: z.array(DhcpLeaseSchema),
  count: z.number(),
  timestamp: z.string(),
});

const ActionResultSchema = z.object({
  network: z.string(),
  action: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

/**
 * `@bad-at-naming/libvirt/network` — virtual network lifecycle and inspection.
 *
 * Lists and describes virtual networks, starts/stops/defines/undefines them,
 * toggles autostart, and reads DHCP leases. Connects over SSH when `host` is
 * set, otherwise runs `virsh` locally against `uri` (default qemu:///system).
 *
 * @example
 * swamp model create @bad-at-naming/libvirt/network nets --input host=10.0.0.5
 * swamp model method run nets list
 * swamp model method run nets dhcpLeases --input name=default
 */
export const model = {
  type: "@bad-at-naming/libvirt/network",
  version: "2026.05.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    network: {
      description: "Virtual network list or detail",
      schema: NetworkListSchema.or(NetworkDetailSchema),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dhcpLeases: {
      description: "DHCP leases for a network",
      schema: DhcpLeaseListSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    actionResult: {
      description: "Result of a network action",
      schema: ActionResultSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description: "List all virtual networks",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["net-list", "--all"]);
        const rawNets = parseNetList(result.stdout);
        const networks: z.infer<typeof NetworkSchema>[] = [];
        for (const net of rawNets) {
          const info = parseKV(
            (await virsh(conn, ["net-info", net.name])).stdout,
          );
          networks.push({
            name: net.name,
            uuid: info["UUID"] || "",
            state: info["Active"] === "yes" ? "active" : "inactive",
            autostart: info["Autostart"] || net.autostart,
            persistent: info["Persistent"] || net.persistent,
            bridge: info["Bridge"] || "",
          });
        }
        context.logger.info(`Found ${networks.length} networks`);
        for (const n of networks) {
          context.logger.info(`  ${n.name}: ${n.state}, bridge=${n.bridge}`);
        }
        const handle = await context.writeResource("network", "list", {
          host: connLabel(conn),
          networks,
          count: networks.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    get: {
      description:
        "Get detailed info for a virtual network including XML config",
      arguments: z.object({ name: z.string().describe("Network name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const [infoResult, xmlResult] = await Promise.all([
          virsh(conn, ["net-info", args.name]),
          virsh(conn, ["net-dumpxml", args.name]),
        ]);
        const info = parseKV(infoResult.stdout);
        const data = {
          name: args.name,
          uuid: info["UUID"] || "",
          state: info["Active"] === "yes" ? "active" : "inactive",
          autostart: info["Autostart"] || "",
          persistent: info["Persistent"] || "",
          bridge: info["Bridge"] || "",
          xml: xmlResult.stdout,
          timestamp: new Date().toISOString(),
        };
        context.logger.info(
          `${data.name}: ${data.state}, bridge=${data.bridge}`,
        );
        const handle = await context.writeResource("network", args.name, data);
        return { dataHandles: [handle] };
      },
    },

    dumpxml: {
      description: "Get raw XML definition of a network",
      arguments: z.object({ name: z.string().describe("Network name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["net-dumpxml", args.name]);
        // Redact any embedded passwords in the LOG; stored message keeps raw XML.
        context.logger.info(redactSecrets(result.stdout));
        const handle = await context.writeResource("actionResult", args.name, {
          network: args.name,
          action: "dumpxml",
          message: result.stdout,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    start: {
      description: "Start (activate) a virtual network",
      arguments: z.object({ name: z.string().describe("Network name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["net-start", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          network: args.name,
          action: "start",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop (deactivate) a virtual network",
      arguments: z.object({ name: z.string().describe("Network name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["net-destroy", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          network: args.name,
          action: "stop",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    define: {
      description: "Define a virtual network from XML (does not start it)",
      arguments: z.object({
        xml: z.string().describe("Full libvirt network XML definition"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await defineXml(conn, "net-define", args.xml);
        context.logger.info(result.stdout.trim());
        const nameMatch = result.stdout.match(/Network\s+(\S+)\s+defined/);
        const name = nameMatch?.[1] || "unknown";
        const handle = await context.writeResource("actionResult", name, {
          network: name,
          action: "define",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    undefine: {
      description: "Undefine a virtual network (remove persistent config)",
      arguments: z.object({ name: z.string().describe("Network name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["net-undefine", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          network: args.name,
          action: "undefine",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    autostart: {
      description: "Enable or disable autostart for a virtual network",
      arguments: z.object({
        name: z.string().describe("Network name"),
        enabled: z.boolean().describe("true to enable, false to disable"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = args.enabled
          ? ["net-autostart", args.name]
          : ["net-autostart", "--disable", args.name];
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          network: args.name,
          action: "autostart",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    dhcpLeases: {
      description: "List DHCP leases for a virtual network",
      arguments: z.object({ name: z.string().describe("Network name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        // virshTry: an inactive network returns non-zero; treat as empty leases.
        const result = await virshTry(conn, ["net-dhcp-leases", args.name]);
        const leases: z.infer<typeof DhcpLeaseSchema>[] = [];
        for (const line of result.stdout.trim().split("\n")) {
          if (line.match(/^[-\s]*$/) || line.match(/^\s*Expiry/)) continue;
          const parts = line.trim().split(/\s{2,}/);
          if (parts.length >= 5) {
            leases.push({
              expiry: parts[0],
              mac: parts[1],
              protocol: parts[2],
              ipaddr: parts[3],
              hostname: parts[4] || "",
              clientid: parts[5] || "",
            });
          }
        }
        context.logger.info(`${leases.length} DHCP leases for ${args.name}`);
        for (const l of leases) {
          context.logger.info(`  ${l.ipaddr} → ${l.mac} (${l.hostname})`);
        }
        const handle = await context.writeResource("dhcpLeases", args.name, {
          network: args.name,
          leases,
          count: leases.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
