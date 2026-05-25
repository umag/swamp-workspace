import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Helper: transient error detection
// ---------------------------------------------------------------------------

function isTransientError(text) {
  return (
    text.includes("connection refused") ||
    text.includes("connection reset") ||
    text.includes("Unable to connect to the server") ||
    text.includes("i/o timeout") ||
    text.includes("TLS handshake timeout") ||
    text.includes("net/http: request canceled") ||
    text.includes("ECONNREFUSED") ||
    text.includes("ETIMEDOUT")
  );
}

// ---------------------------------------------------------------------------
// Helper: run kubectl with kubeconfig/context
// ---------------------------------------------------------------------------

async function kubectl(globalArgs, args) {
  const cmdArgs = [...args];

  if (globalArgs.kubeconfig) {
    cmdArgs.push("--kubeconfig", globalArgs.kubeconfig);
  }
  if (globalArgs.context) {
    cmdArgs.push("--context", globalArgs.context);
  }

  const cmd = new Deno.Command("kubectl", {
    args: cmdArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success) {
    throw new Error(
      `kubectl ${args.slice(0, 3).join(" ")} failed: ${stderr || stdout}`,
    );
  }

  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Helper: run linstor commands via kubectl exec into linstor-controller
// Retries up to 3 times on transient errors.
// ---------------------------------------------------------------------------

async function linstor(globalArgs, args) {
  const execArgs = [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    ...args,
  ];

  const kubectlArgs = [...execArgs];
  if (globalArgs.kubeconfig) {
    kubectlArgs.push("--kubeconfig", globalArgs.kubeconfig);
  }
  if (globalArgs.context) {
    kubectlArgs.push("--context", globalArgs.context);
  }

  const maxRetries = 3;
  const retryDelay = 5000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const cmd = new Deno.Command("kubectl", {
      args: kubectlArgs,
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    if (output.success) {
      return { stdout, stderr };
    }

    const errText = stderr || stdout;
    if (attempt < maxRetries && isTransientError(errText)) {
      await new Promise((r) => setTimeout(r, retryDelay));
      continue;
    }

    throw new Error(`linstor ${args.slice(0, 3).join(" ")} failed: ${errText}`);
  }

  throw new Error(
    `linstor ${args.slice(0, 3).join(" ")} failed after ${
      maxRetries + 1
    } attempts`,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgs = z.object({
  kubeconfig: z
    .string()
    .optional()
    .describe("Path to kubeconfig for the Cozystack cluster"),
  context: z
    .string()
    .optional()
    .describe("Kubeconfig context to use"),
});

const NodeSchema = z.object({
  name: z.string(),
  type: z.string(),
  addresses: z.string(),
  state: z.string(),
  timestamp: z.string(),
});

const StoragePoolSchema = z.object({
  node: z.string(),
  storagePool: z.string(),
  driver: z.string(),
  poolName: z.string(),
  free: z.string(),
  capacity: z.string(),
  state: z.string(),
  timestamp: z.string(),
});

const ResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  warnings: z.array(z.string()).optional(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Linstor distributed storage management model for Cozystack. Provides node and
 * storage-pool discovery, ZFS pool creation, failmode tuning, and storage-class
 * application via kubectl and linstor controller exec, with idempotent methods
 * and live pre-flight checks.
 */
export const model = {
  type: "@magistr/cozystack-linstor",
  version: "2026.03.13.1",
  globalArguments: GlobalArgs,
  checks: {
    "cluster-reachable": {
      description: "Verify kubectl can reach the Kubernetes cluster",
      labels: ["live"],
      appliesTo: ["createZfsPool", "setZfsFailmode", "applyStorageClasses"],
      execute: async (context) => {
        try {
          const cmdArgs = ["cluster-info", "--request-timeout=5s"];
          if (context.globalArgs.kubeconfig) {
            cmdArgs.push("--kubeconfig", context.globalArgs.kubeconfig);
          }
          if (context.globalArgs.context) {
            cmdArgs.push("--context", context.globalArgs.context);
          }
          const cmd = new Deno.Command("kubectl", {
            args: cmdArgs,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            const stderr = new TextDecoder().decode(output.stderr);
            return {
              pass: false,
              errors: [`Cluster unreachable: ${stderr.split("\n")[0]}`],
            };
          }
          return { pass: true };
        } catch (e) {
          return {
            pass: false,
            errors: [
              `kubectl not available: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ],
          };
        }
      },
    },
    "linstor-controller-ready": {
      description:
        "Verify linstor-controller pod is running before executing linstor commands",
      labels: ["live", "dependency"],
      appliesTo: ["createZfsPool", "setZfsFailmode", "applyStorageClasses"],
      execute: async (context) => {
        try {
          const cmdArgs = [
            "get",
            "deploy/linstor-controller",
            "-n",
            "cozy-linstor",
            "-o",
            "jsonpath={.status.readyReplicas}",
          ];
          if (context.globalArgs.kubeconfig) {
            cmdArgs.push("--kubeconfig", context.globalArgs.kubeconfig);
          }
          if (context.globalArgs.context) {
            cmdArgs.push("--context", context.globalArgs.context);
          }
          const cmd = new Deno.Command("kubectl", {
            args: cmdArgs,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          const stdout = new TextDecoder().decode(output.stdout).trim();
          if (!output.success || !stdout || parseInt(stdout) < 1) {
            return {
              pass: false,
              errors: [
                "linstor-controller deployment not ready in cozy-linstor namespace",
              ],
            };
          }
          return { pass: true };
        } catch (e) {
          return {
            pass: false,
            errors: [
              `Cannot check linstor-controller: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ],
          };
        }
      },
    },
  },
  resources: {
    node: {
      description: "Linstor cluster node",
      schema: NodeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    storagePool: {
      description: "Linstor storage pool",
      schema: StoragePoolSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    result: {
      description: "Operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    getLinstorControllerStatus: {
      description: "Check if linstor-controller deployment is ready",
      arguments: z.object({}),
      execute: async (_args, context) => {
        try {
          const { stdout } = await kubectl(context.globalArgs, [
            "get",
            "deploy/linstor-controller",
            "-n",
            "cozy-linstor",
            "-o",
            "json",
          ]);
          const deploy = JSON.parse(stdout);
          const replicas = deploy.status?.readyReplicas || 0;
          const desired = deploy.spec?.replicas || 1;
          const handle = await context.writeResource(
            "result",
            "linstor-controller-status",
            {
              success: replicas >= desired,
              message: `linstor-controller: ${replicas}/${desired} ready`,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        } catch (e) {
          const handle = await context.writeResource(
            "result",
            "linstor-controller-status",
            {
              success: false,
              message: `linstor-controller not found: ${
                e instanceof Error ? e.message : String(e)
              }`,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }
      },
    },

    listNodes: {
      description: "List Linstor cluster nodes",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await linstor(context.globalArgs, [
          "node",
          "list",
          "--output-version=v1",
          "-m",
        ]);

        const data = JSON.parse(stdout);
        const nodes = data[0]?.nodes || data.nodes || data || [];
        const handles: unknown[] = [];
        const now = new Date().toISOString();

        for (const node of nodes) {
          const addresses = (node.net_interfaces || [])
            .map((ni) => `${ni.name}:${ni.address}`)
            .join(", ");

          const handle = await context.writeResource("node", node.name, {
            name: node.name,
            type: node.type || "unknown",
            addresses,
            state: node.connection_status || "unknown",
            timestamp: now,
          });
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    listStoragePools: {
      description: "List Linstor storage pools across all nodes",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await linstor(context.globalArgs, [
          "storage-pool",
          "list",
          "--output-version=v1",
          "-m",
        ]);

        const data = JSON.parse(stdout);
        const pools = data[0]?.stor_pools || data.stor_pools || data || [];
        const handles: unknown[] = [];
        const now = new Date().toISOString();

        for (const pool of pools) {
          const freeSpace = pool.free_space;
          const handle = await context.writeResource(
            "storagePool",
            `${pool.node_name}-${pool.stor_pool_name}`,
            {
              node: pool.node_name,
              storagePool: pool.stor_pool_name,
              driver: pool.provider_kind || "unknown",
              poolName: pool.props?.["StorDriver/StorPoolName"] ||
                pool.stor_pool_name,
              free: freeSpace?.free_capacity != null
                ? String(freeSpace.free_capacity)
                : "unknown",
              capacity: freeSpace?.total_capacity != null
                ? String(freeSpace.total_capacity)
                : "unknown",
              state: pool.reports ? "error" : "ok",
              timestamp: now,
            },
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    createZfsPool: {
      description:
        "Create a ZFS storage pool on a node. Idempotent: skips if pool already exists.",
      arguments: z.object({
        node: z.string().describe("Node name to create the pool on"),
        device: z.string().describe("Block device path (e.g. /dev/vdb)"),
        poolName: z.string().default("data").describe("ZFS pool name"),
        storagePool: z
          .string()
          .default("data")
          .describe("Linstor storage pool name"),
      }),
      execute: async (args, context) => {
        const now = new Date().toISOString();

        // Check if storage pool already exists on this node
        const { stdout: listOut } = await linstor(context.globalArgs, [
          "storage-pool",
          "list",
          "-n",
          args.node,
          "--output-version=v1",
          "-m",
        ]);
        const listData = JSON.parse(listOut);
        const pools = listData[0]?.stor_pools || listData.stor_pools ||
          listData || [];

        const existing = pools.find(
          (p) =>
            p.stor_pool_name === args.storagePool && p.node_name === args.node,
        );

        if (existing) {
          const handle = await context.writeResource(
            "result",
            `create-zfs-${args.node}-${args.storagePool}`,
            {
              success: true,
              message:
                `Storage pool '${args.storagePool}' already exists on node '${args.node}', skipped creation`,
              timestamp: now,
            },
          );
          return { dataHandles: [handle] };
        }

        // Create the ZFS device pool
        const { stderr } = await linstor(context.globalArgs, [
          "physical-storage",
          "create-device-pool",
          "zfs",
          args.node,
          args.device,
          "--pool-name",
          args.poolName,
          "--storage-pool",
          args.storagePool,
        ]);

        const warnings = stderr
          ? stderr.split("\n").filter((l) => l.trim())
          : [];

        const handle = await context.writeResource(
          "result",
          `create-zfs-${args.node}-${args.storagePool}`,
          {
            success: true,
            message:
              `Created ZFS pool '${args.poolName}' with storage pool '${args.storagePool}' on node '${args.node}' using device '${args.device}'`,
            warnings: warnings.length > 0 ? warnings : undefined,
            timestamp: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    setZfsFailmode: {
      description:
        "Set ZFS failmode=continue on a node. Idempotent (re-setting is a no-op).",
      arguments: z.object({
        node: z.string().describe("Node name"),
        poolName: z.string().default("data").describe("ZFS pool name"),
      }),
      execute: async (args, context) => {
        const now = new Date().toISOString();

        // Run zpool set via kubectl exec on the linstor-satellite daemonset pod for the node
        const { stderr } = await kubectl(context.globalArgs, [
          "exec",
          "-n",
          "cozy-linstor",
          `ds/linstor-satellite.${args.node}`,
          "--",
          "zpool",
          "set",
          "failmode=continue",
          args.poolName,
        ]);

        const warnings = stderr
          ? stderr.split("\n").filter((l) => l.trim())
          : [];

        const handle = await context.writeResource(
          "result",
          `set-failmode-${args.node}-${args.poolName}`,
          {
            success: true,
            message:
              `Set failmode=continue on ZFS pool '${args.poolName}' on node '${args.node}'`,
            warnings: warnings.length > 0 ? warnings : undefined,
            timestamp: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    applyStorageClasses: {
      description:
        "Apply a storage class YAML manifest. Idempotent (uses kubectl apply).",
      arguments: z.object({
        manifestPath: z
          .string()
          .describe("Path to the storage classes YAML file"),
      }),
      execute: async (args, context) => {
        const now = new Date().toISOString();

        const { stderr } = await kubectl(context.globalArgs, [
          "apply",
          "-f",
          args.manifestPath,
        ]);

        const warnings = stderr
          ? stderr.split("\n").filter((l) => l.trim())
          : [];

        const handle = await context.writeResource(
          "result",
          `apply-storage-classes`,
          {
            success: true,
            message: `Applied storage classes from '${args.manifestPath}'`,
            warnings: warnings.length > 0 ? warnings : undefined,
            timestamp: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
