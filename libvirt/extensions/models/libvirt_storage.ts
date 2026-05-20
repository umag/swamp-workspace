import { z } from "npm:zod@4";
import {
  connLabel,
  IDEMPOTENT_ERRORS,
  isIdempotent,
  virsh,
  virshTry,
} from "./lib/connection.ts";
import { parseKV, parsePoolList, parseVolList } from "./lib/parse.ts";

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

const PoolSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  state: z.string(),
  autostart: z.string(),
  persistent: z.string(),
  type: z.string(),
  capacity: z.string(),
  allocation: z.string(),
  available: z.string(),
});

const PoolListSchema = z.object({
  host: z.string(),
  pools: z.array(PoolSchema),
  count: z.number(),
  timestamp: z.string(),
});

const PoolDetailSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  state: z.string(),
  autostart: z.string(),
  persistent: z.string(),
  type: z.string(),
  capacity: z.string(),
  allocation: z.string(),
  available: z.string(),
  xml: z.string(),
  timestamp: z.string(),
});

const VolumeSchema = z.object({
  name: z.string(),
  pool: z.string(),
  type: z.string(),
  capacity: z.string(),
  allocation: z.string(),
  path: z.string(),
});

const VolumeListSchema = z.object({
  pool: z.string(),
  volumes: z.array(VolumeSchema),
  count: z.number(),
  timestamp: z.string(),
});

const VolumeDetailSchema = z.object({
  name: z.string(),
  pool: z.string(),
  type: z.string(),
  capacity: z.string(),
  allocation: z.string(),
  path: z.string(),
  xml: z.string(),
  timestamp: z.string(),
});

const ActionResultSchema = z.object({
  resource: z.string(),
  action: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

/**
 * `@bad-at-naming/libvirt/storage` — storage pool and volume management.
 *
 * Lists/describes pools and volumes, and creates, builds, starts, stops,
 * defines, undefines, autostarts, refreshes, resizes, clones, and deletes
 * them. Pool start / pool define / volume create are idempotent (an
 * already-active pool or already-existing object is reported as success).
 * Connects over SSH when `host` is set, otherwise runs `virsh` locally
 * against `uri` (default qemu:///system).
 *
 * @example
 * swamp model create @bad-at-naming/libvirt/storage stor --input host=10.0.0.5
 * swamp model method run stor poolList
 * swamp model method run stor volList --input pool=default
 */
export const model = {
  type: "@bad-at-naming/libvirt/storage",
  version: "2026.05.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pool: {
      description: "Storage pool list or detail",
      schema: PoolListSchema.or(PoolDetailSchema),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    volume: {
      description: "Storage volume list or detail",
      schema: VolumeListSchema.or(VolumeDetailSchema),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    actionResult: {
      description: "Result of a storage action",
      schema: ActionResultSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    // ==================== Storage Pools ====================

    poolList: {
      description: "List all storage pools",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["pool-list", "--all", "--details"]);
        const rawPools = parsePoolList(result.stdout);
        const pools: z.infer<typeof PoolSchema>[] = [];
        for (const p of rawPools) {
          const info = parseKV(
            (await virsh(conn, ["pool-info", p.name])).stdout,
          );
          pools.push({
            name: p.name,
            uuid: info["UUID"] || "",
            state: info["State"] || p.state,
            autostart: info["Autostart"] || p.autostart,
            persistent: info["Persistent"] || "",
            type: info["Type"] || "",
            capacity: info["Capacity"] || "",
            allocation: info["Allocation"] || "",
            available: info["Available"] || "",
          });
        }
        context.logger.info(`Found ${pools.length} storage pools`);
        for (const p of pools) {
          context.logger.info(
            `  ${p.name}: ${p.state} (${p.type}, ${p.capacity})`,
          );
        }
        const handle = await context.writeResource("pool", "list", {
          host: connLabel(conn),
          pools,
          count: pools.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolGet: {
      description: "Get detailed info for a storage pool including XML",
      arguments: z.object({ name: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const [infoResult, xmlResult] = await Promise.all([
          virsh(conn, ["pool-info", args.name]),
          virsh(conn, ["pool-dumpxml", args.name]),
        ]);
        const info = parseKV(infoResult.stdout);
        const data = {
          name: args.name,
          uuid: info["UUID"] || "",
          state: info["State"] || "",
          autostart: info["Autostart"] || "",
          persistent: info["Persistent"] || "",
          type: info["Type"] || "",
          capacity: info["Capacity"] || "",
          allocation: info["Allocation"] || "",
          available: info["Available"] || "",
          xml: xmlResult.stdout,
          timestamp: new Date().toISOString(),
        };
        context.logger.info(
          `${data.name}: ${data.state}, ${data.type}, capacity=${data.capacity}`,
        );
        const handle = await context.writeResource("pool", args.name, data);
        return { dataHandles: [handle] };
      },
    },

    poolStart: {
      description:
        "Start (activate) a storage pool. Idempotent: succeeds if already active.",
      arguments: z.object({ name: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const res = await virshTry(conn, ["pool-start", args.name]);
        let message: string;
        if (res.code === 0) {
          message = res.stdout.trim();
        } else if (
          isIdempotent(res, IDEMPOTENT_ERRORS.poolAlreadyActive)
        ) {
          message = `Pool ${args.name} already active (idempotent)`;
          context.logger.info(message);
        } else {
          throw new Error(
            `virsh pool-start failed (exit ${res.code}): ${
              res.stderr.slice(-500)
            }`,
          );
        }
        context.logger.info(message);
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolStart",
          message,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolBuild: {
      description:
        "Build a storage pool (creates target directory for dir pools)",
      arguments: z.object({ name: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["pool-build", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolBuild",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolStop: {
      description: "Stop (deactivate) a storage pool",
      arguments: z.object({ name: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["pool-destroy", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolStop",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolDefine: {
      description:
        "Define a storage pool from parameters. Idempotent: succeeds if pool already exists.",
      arguments: z.object({
        name: z.string().describe("Pool name"),
        type: z.enum([
          "dir",
          "fs",
          "netfs",
          "disk",
          "iscsi",
          "logical",
          "scsi",
          "mpath",
          "rbd",
          "gluster",
          "zfs",
        ]).describe("Pool type"),
        target: z.string().optional().describe(
          "Target path (e.g. /var/lib/libvirt/images)",
        ),
        sourceHost: z.string().optional().describe(
          "Source host for network pools",
        ),
        sourcePath: z.string().optional().describe("Source path/name"),
        sourceFormat: z.string().optional().describe(
          "Source format (e.g. nfs, cifs, auto)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = ["pool-define-as", args.name, args.type];
        if (args.sourceHost) argv.push("--source-host", args.sourceHost);
        if (args.sourcePath) argv.push("--source-path", args.sourcePath);
        if (args.sourceFormat) argv.push("--source-format", args.sourceFormat);
        if (args.target) argv.push("--target", args.target);
        const res = await virshTry(conn, argv);
        let message: string;
        if (res.code === 0) {
          message = res.stdout.trim();
        } else if (isIdempotent(res, IDEMPOTENT_ERRORS.alreadyExists)) {
          message = `Pool ${args.name} already defined (idempotent)`;
        } else {
          throw new Error(
            `virsh pool-define-as failed (exit ${res.code}): ${
              res.stderr.slice(-500)
            }`,
          );
        }
        context.logger.info(message);
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolDefine",
          message,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolUndefine: {
      description: "Undefine a storage pool (remove persistent config)",
      arguments: z.object({ name: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["pool-undefine", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolUndefine",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolAutostart: {
      description: "Enable or disable autostart for a storage pool",
      arguments: z.object({
        name: z.string().describe("Pool name"),
        enabled: z.boolean().describe("true to enable, false to disable"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = args.enabled
          ? ["pool-autostart", args.name]
          : ["pool-autostart", "--disable", args.name];
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolAutostart",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    poolRefresh: {
      description: "Refresh a storage pool to discover new volumes",
      arguments: z.object({ name: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["pool-refresh", args.name]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: args.name,
          action: "poolRefresh",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ==================== Storage Volumes ====================

    volList: {
      description: "List all volumes in a storage pool",
      arguments: z.object({ pool: z.string().describe("Pool name") }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, ["vol-list", args.pool, "--details"]);
        const rawVols = parseVolList(result.stdout);
        const volumes: z.infer<typeof VolumeSchema>[] = [];
        for (const v of rawVols) {
          const info = parseKV(
            (await virsh(conn, ["vol-info", v.name, "--pool", args.pool]))
              .stdout,
          );
          volumes.push({
            name: v.name,
            pool: args.pool,
            type: info["Type"] || "",
            capacity: info["Capacity"] || "",
            allocation: info["Allocation"] || "",
            path: v.path,
          });
        }
        context.logger.info(`${volumes.length} volumes in pool ${args.pool}`);
        for (const v of volumes) {
          context.logger.info(`  ${v.name}: ${v.type}, ${v.capacity}`);
        }
        const handle = await context.writeResource(
          "volume",
          `${args.pool}-list`,
          {
            pool: args.pool,
            volumes,
            count: volumes.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    volGet: {
      description: "Get detailed info for a storage volume including XML",
      arguments: z.object({
        name: z.string().describe("Volume name"),
        pool: z.string().describe("Pool name"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const [infoResult, xmlResult, pathResult] = await Promise.all([
          virsh(conn, ["vol-info", args.name, "--pool", args.pool]),
          virsh(conn, ["vol-dumpxml", args.name, "--pool", args.pool]),
          virsh(conn, ["vol-path", args.name, "--pool", args.pool]),
        ]);
        const info = parseKV(infoResult.stdout);
        const data = {
          name: args.name,
          pool: args.pool,
          type: info["Type"] || "",
          capacity: info["Capacity"] || "",
          allocation: info["Allocation"] || "",
          path: pathResult.stdout.trim(),
          xml: xmlResult.stdout,
          timestamp: new Date().toISOString(),
        };
        context.logger.info(
          `${data.name}: ${data.type}, capacity=${data.capacity}, path=${data.path}`,
        );
        const handle = await context.writeResource(
          "volume",
          `${args.pool}-${args.name}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    volCreate: {
      description:
        "Create a new storage volume. Idempotent: succeeds if volume already exists.",
      arguments: z.object({
        pool: z.string().describe("Pool name"),
        name: z.string().describe("Volume name"),
        capacity: z.string().describe(
          "Capacity with unit (e.g. 10G, 500M, 1T)",
        ),
        format: z.enum(["qcow2", "raw", "vmdk"]).default("qcow2").describe(
          "Volume format",
        ),
        allocation: z.string().optional().describe(
          "Initial allocation with unit (for thin provisioning, e.g. 0)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = [
          "vol-create-as",
          args.pool,
          args.name,
          args.capacity,
          "--format",
          args.format,
        ];
        if (args.allocation) argv.push("--allocation", args.allocation);
        const res = await virshTry(conn, argv);
        let message: string;
        if (res.code === 0) {
          message = res.stdout.trim();
        } else if (isIdempotent(res, IDEMPOTENT_ERRORS.alreadyExists)) {
          message = `Volume ${args.name} already exists (idempotent)`;
        } else {
          throw new Error(
            `virsh vol-create-as failed (exit ${res.code}): ${
              res.stderr.slice(-500)
            }`,
          );
        }
        context.logger.info(message);
        const handle = await context.writeResource("actionResult", args.name, {
          resource: `${args.pool}/${args.name}`,
          action: "volCreate",
          message,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    volDelete: {
      description: "Delete a storage volume",
      arguments: z.object({
        name: z.string().describe("Volume name"),
        pool: z.string().describe("Pool name"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "vol-delete",
          args.name,
          "--pool",
          args.pool,
        ]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: `${args.pool}/${args.name}`,
          action: "volDelete",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    volResize: {
      description: "Resize a storage volume",
      arguments: z.object({
        name: z.string().describe("Volume name"),
        pool: z.string().describe("Pool name"),
        capacity: z.string().describe("New capacity with unit (e.g. 20G)"),
        shrink: z.boolean().default(false).describe(
          "Allow shrinking (data loss risk)",
        ),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const argv = [
          "vol-resize",
          args.name,
          args.capacity,
          "--pool",
          args.pool,
        ];
        if (args.shrink) argv.push("--shrink");
        const result = await virsh(conn, argv);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource("actionResult", args.name, {
          resource: `${args.pool}/${args.name}`,
          action: "volResize",
          message: result.stdout.trim(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    volClone: {
      description: "Clone a storage volume",
      arguments: z.object({
        name: z.string().describe("Source volume name"),
        pool: z.string().describe("Pool name"),
        newName: z.string().describe("New cloned volume name"),
      }),
      execute: async (args, context) => {
        const conn = context.globalArgs;
        const result = await virsh(conn, [
          "vol-clone",
          args.name,
          args.newName,
          "--pool",
          args.pool,
        ]);
        context.logger.info(result.stdout.trim());
        const handle = await context.writeResource(
          "actionResult",
          args.newName,
          {
            resource: `${args.pool}/${args.newName}`,
            action: "volClone",
            message: result.stdout.trim(),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
