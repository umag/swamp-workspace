import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// talosctl executor
// ---------------------------------------------------------------------------

function isTransientError(text) {
  return (
    text.includes("connection refused") ||
    text.includes("connection reset") ||
    text.includes("connection error") ||
    text.includes("Unavailable") ||
    text.includes("deadline exceeded") ||
    text.includes("i/o timeout") ||
    text.includes("transport is closing")
  );
}

async function talosctl(
  globalArgs,
  args,
  _timeout = 30000,
  retries = 0,
  retryDelay = 15000,
) {
  // talosctl requires: <command> [flags] — insecure must come after the subcommand
  const cmdArgs = [...args];

  if (globalArgs.insecure) {
    cmdArgs.push("--insecure");
  }

  cmdArgs.push("--endpoints", globalArgs.endpoint);
  cmdArgs.push("--nodes", globalArgs.endpoint);

  if (globalArgs.talosconfig) {
    cmdArgs.push("--talosconfig", globalArgs.talosconfig);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const cmd = new Deno.Command("talosctl", {
      args: cmdArgs,
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
    if (attempt < retries && isTransientError(errText)) {
      await new Promise((r) => setTimeout(r, retryDelay));
      continue;
    }

    throw new Error(`talosctl ${args[0]} failed: ${errText}`);
  }
  throw new Error(`talosctl ${args[0]} failed after ${retries + 1} attempts`);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgs = z.object({
  endpoint: z.string().describe("Talos node endpoint (IP or hostname)"),
  talosconfig: z
    .string()
    .optional()
    .describe("Path to talosconfig file (defaults to ~/.talos/config)"),
  insecure: z
    .boolean()
    .default(false)
    .describe(
      "Use --insecure flag (skip TLS verification, for maintenance mode)",
    ),
});

const VersionSchema = z
  .object({
    node: z.string(),
    tag: z.string(),
    sha: z.string().optional(),
    arch: z.string().optional(),
    platform: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const ServiceSchema = z
  .object({
    id: z.string(),
    state: z.string(),
    health: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const EtcdMemberOutputSchema = z
  .object({
    hostname: z.string(),
    id: z.string(),
    peerUrls: z.array(z.string()),
    clientUrls: z.array(z.string()),
    isLearner: z.boolean(),
    timestamp: z.string(),
  })
  .passthrough();

const KubeconfigSchema = z.object({
  kubeconfig: z.string().meta({ sensitive: true }),
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

/** Swamp model for managing Talos Linux nodes via the talosctl CLI: version, services, etcd members, kubeconfig, config apply/patch, bootstrap, reboot, shutdown, reset, upgrade, and cluster health. */
export const model = {
  type: "@magistr/talos-node",
  version: "2026.03.13.1",
  globalArguments: GlobalArgs,
  checks: {
    "talosctl-available": {
      description: "Verify talosctl binary is available in PATH",
      labels: ["dependency"],
      appliesTo: [
        "applyConfig",
        "bootstrap",
        "reboot",
        "shutdown",
        "reset",
        "upgrade",
        "patchConfig",
      ],
      execute: async () => {
        try {
          const cmd = new Deno.Command("talosctl", {
            args: ["version", "--client"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            return {
              pass: false,
              errors: ["talosctl binary found but returned error"],
            };
          }
          return { pass: true };
        } catch {
          return { pass: false, errors: ["talosctl binary not found in PATH"] };
        }
      },
    },
    "talosconfig-exists": {
      description: "Verify talosconfig file exists when specified",
      labels: ["dependency"],
      appliesTo: [
        "applyConfig",
        "bootstrap",
        "reboot",
        "shutdown",
        "reset",
        "upgrade",
        "patchConfig",
      ],
      execute: async (context) => {
        if (!context.globalArgs.talosconfig) return { pass: true };
        try {
          await Deno.stat(context.globalArgs.talosconfig);
          return { pass: true };
        } catch {
          return {
            pass: false,
            errors: [
              `talosconfig not found: ${context.globalArgs.talosconfig}`,
            ],
          };
        }
      },
    },
  },
  resources: {
    version: {
      description: "Talos node version info",
      schema: VersionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    service: {
      description: "Talos service status",
      schema: ServiceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    etcdMember: {
      description: "Etcd cluster member",
      schema: EtcdMemberOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    kubeconfig: {
      description: "Cluster kubeconfig",
      schema: KubeconfigSchema,
      sensitiveOutput: true,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    result: {
      description: "Operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    version: {
      description: "Get Talos version info",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await talosctl(context.globalArgs, [
          "version",
          "--json",
        ]);
        const data = JSON.parse(stdout);
        const ver = data.version || data.server?.version || {};
        const handle = await context.writeResource("version", "main", {
          node: context.globalArgs.endpoint,
          tag: ver.tag || "unknown",
          sha: ver.sha,
          arch: ver.arch,
          platform: data.platform?.name,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    services: {
      description: "List all services on the node (factory output)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await talosctl(context.globalArgs, ["services"]);
        const lines = stdout.trim().split("\n");
        const handles = [];
        // Parse tabular: NODE  SERVICE  STATE  HEALTH  ...
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length < 4) continue;
          // First column is NODE IP, second is SERVICE
          const id = parts[1];
          const state = parts[2];
          const health = parts[3];
          const handle = await context.writeResource("service", id, {
            id,
            state,
            health,
            timestamp: new Date().toISOString(),
          });
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    etcdMembers: {
      description: "List etcd cluster members",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await talosctl(context.globalArgs, [
          "etcd",
          "members",
        ]);
        const lines = stdout.trim().split("\n");
        const handles = [];
        // Parse tabular: NODE  ID  HOSTNAME  PEER URLS  CLIENT URLS  LEARNER
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length < 6) continue;
          const handle = await context.writeResource(
            "etcdMember",
            parts[2], // hostname
            {
              hostname: parts[2],
              id: parts[1],
              peerUrls: [parts[3]],
              clientUrls: [parts[4]],
              isLearner: parts[5] === "true",
              timestamp: new Date().toISOString(),
            },
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    kubeconfig: {
      description: "Retrieve cluster kubeconfig",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await talosctl(context.globalArgs, [
          "kubeconfig",
          "-",
        ]);
        const handle = await context.writeResource("kubeconfig", "main", {
          kubeconfig: stdout,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    applyConfig: {
      description:
        "Apply machine config (use insecure=true for maintenance mode)",
      arguments: z.object({
        configFile: z.string().describe("Path to the machine config YAML file"),
        mode: z
          .enum(["auto", "reboot", "no-reboot", "staged"])
          .default("auto")
          .describe("Apply mode"),
        insecure: z
          .boolean()
          .default(false)
          .describe("Override global insecure flag (for maintenance mode)"),
      }),
      execute: async (args, context) => {
        const globalArgs = args.insecure
          ? { ...context.globalArgs, insecure: true }
          : context.globalArgs;
        const { stderr } = await talosctl(
          globalArgs,
          [
            "apply-config",
            "--file",
            args.configFile,
            "--mode",
            args.mode,
          ],
          120000,
          12,
          15000,
        );
        const handle = await context.writeResource("result", "applyConfig", {
          success: true,
          message:
            `Config applied to ${context.globalArgs.endpoint} (mode=${args.mode})`,
          warnings: stderr
            ? stderr
              .split("\n")
              .filter((l) => l.trim())
            : [],
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    bootstrap: {
      description: "Bootstrap the cluster (run on first controlplane only)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        await talosctl(context.globalArgs, ["bootstrap"], 120000, 20, 15000);
        const handle = await context.writeResource("result", "bootstrap", {
          success: true,
          message: `Bootstrap initiated on ${context.globalArgs.endpoint}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    reboot: {
      description: "Reboot the node",
      arguments: z.object({
        mode: z
          .enum(["default", "powercycle"])
          .default("default")
          .describe("Reboot mode"),
      }),
      execute: async (args, context) => {
        const cmdArgs = ["reboot"];
        if (args.mode === "powercycle") cmdArgs.push("--mode", "powercycle");
        await talosctl(context.globalArgs, cmdArgs);
        const handle = await context.writeResource("result", "reboot", {
          success: true,
          message:
            `Reboot (${args.mode}) initiated on ${context.globalArgs.endpoint}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    shutdown: {
      description: "Shutdown the node",
      arguments: z.object({
        force: z.boolean().default(false).describe("Force shutdown"),
      }),
      execute: async (args, context) => {
        const cmdArgs = ["shutdown"];
        if (args.force) cmdArgs.push("--force");
        await talosctl(context.globalArgs, cmdArgs);
        const handle = await context.writeResource("result", "shutdown", {
          success: true,
          message: `Shutdown initiated on ${context.globalArgs.endpoint}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    reset: {
      description: "Reset the node (wipes state)",
      arguments: z.object({
        graceful: z.boolean().default(true).describe("Graceful reset"),
      }),
      execute: async (args, context) => {
        const cmdArgs = ["reset"];
        if (!args.graceful) cmdArgs.push("--graceful=false");
        await talosctl(context.globalArgs, cmdArgs, 120000);
        const handle = await context.writeResource("result", "reset", {
          success: true,
          message:
            `Reset initiated on ${context.globalArgs.endpoint} (graceful=${args.graceful})`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    upgrade: {
      description: "Upgrade Talos on the node",
      arguments: z.object({
        image: z
          .string()
          .describe(
            "Talos installer image (e.g. ghcr.io/siderolabs/installer:v1.9.5)",
          ),
        preserve: z.boolean().default(false).describe(
          "Preserve ephemeral data",
        ),
      }),
      execute: async (args, context) => {
        const cmdArgs = ["upgrade", "--image", args.image];
        if (args.preserve) cmdArgs.push("--preserve");
        await talosctl(context.globalArgs, cmdArgs, 300000);
        const handle = await context.writeResource("result", "upgrade", {
          success: true,
          message:
            `Upgrade to ${args.image} initiated on ${context.globalArgs.endpoint}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    patchConfig: {
      description:
        "Patch machine config with a YAML patch file (triggers reboot by default)",
      arguments: z.object({
        patchFile: z
          .string()
          .describe("Path to the YAML patch file"),
        mode: z
          .enum(["auto", "reboot", "no-reboot", "staged"])
          .default("auto")
          .describe("Apply mode"),
      }),
      execute: async (args, context) => {
        const { stderr } = await talosctl(
          context.globalArgs,
          [
            "patch",
            "machineconfig",
            "--patch-file",
            args.patchFile,
            "--mode",
            args.mode,
          ],
          120000,
          12,
          15000,
        );
        const handle = await context.writeResource("result", "patchConfig", {
          success: true,
          message:
            `Config patched on ${context.globalArgs.endpoint} (mode=${args.mode})`,
          warnings: stderr
            ? stderr
              .split("\n")
              .filter((l) => l.trim())
            : [],
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    health: {
      description: "Check cluster health",
      arguments: z.object({
        waitTimeout: z
          .string()
          .default("10s")
          .describe(
            "How long to wait for health check to pass (e.g. 30s, 2m, 5m)",
          ),
      }),
      execute: async (args, context) => {
        const { stdout } = await talosctl(
          context.globalArgs,
          ["health", "--wait-timeout", args.waitTimeout],
          600000,
          20,
          15000,
        );
        const handle = await context.writeResource("result", "health", {
          success: true,
          message: stdout.trim() || "Cluster healthy",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
