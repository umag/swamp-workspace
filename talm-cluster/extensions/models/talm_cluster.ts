import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// talm / talosctl executor
// ---------------------------------------------------------------------------

async function runCmd(
  binary: string,
  args: string[],
  cwd: string,
  _timeout = 60000,
  stdin?: string,
) {
  const opts: Deno.CommandOptions = {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: stdin !== undefined ? "piped" : "null",
  };
  const cmd = new Deno.Command(binary, opts);
  const child = cmd.spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(`${binary} ${args[0]} failed: ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgs = z.object({
  clusterDir: z
    .string()
    .describe("Path to talm cluster directory (e.g., .talos/my-cluster)"),
});

const ResultSchema = z.object({
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  timestamp: z.string(),
});

const NodeConfigSchema = z.object({
  nodeIP: z.string(),
  configFile: z.string(),
  template: z.string(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Talos cluster lifecycle model: init, configure, template nodes, apply configs, bootstrap, and run health checks against a talm-managed cluster. */
export const model = {
  type: "@magistr/talm-cluster",
  version: "2026.03.13.1",
  globalArguments: GlobalArgs,
  checks: {
    "cluster-dir-exists": {
      description: "Verify the talm cluster directory exists",
      labels: ["dependency"],
      appliesTo: [
        "init",
        "configure",
        "templateNode",
        "apply",
        "bootstrap",
        "kubeconfig",
        "health",
      ],
      execute: async (context) => {
        try {
          const stat = await Deno.stat(context.globalArgs.clusterDir);
          if (!stat.isDirectory) {
            return {
              pass: false,
              errors: [`${context.globalArgs.clusterDir} is not a directory`],
            };
          }
          return { pass: true };
        } catch {
          return {
            pass: false,
            errors: [
              `Cluster directory does not exist: ${context.globalArgs.clusterDir}`,
            ],
          };
        }
      },
    },
    "talm-available": {
      description: "Verify talm binary is available in PATH",
      labels: ["dependency"],
      appliesTo: ["init", "configure", "templateNode", "apply"],
      execute: async () => {
        try {
          const cmd = new Deno.Command("talm", {
            args: ["--version"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            return {
              pass: false,
              errors: ["talm binary found but returned error"],
            };
          }
          return { pass: true };
        } catch {
          return { pass: false, errors: ["talm binary not found in PATH"] };
        }
      },
    },
  },
  resources: {
    result: {
      description: "Command execution output",
      schema: ResultSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
    nodeConfig: {
      description: "Generated node configuration file path",
      schema: NodeConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    getClusterState: {
      description:
        "Check cluster directory state — whether secrets, values, talosconfig, and kubeconfig exist",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const dir = context.globalArgs.clusterDir;
        const files = [
          "secrets.yaml",
          "values.yaml",
          "talosconfig",
          "kubeconfig",
        ];
        const found: string[] = [];
        const missing: string[] = [];

        for (const f of files) {
          try {
            await Deno.stat(`${dir}/${f}`);
            found.push(f);
          } catch {
            missing.push(f);
          }
        }

        // Check for node config files
        let nodeConfigs = 0;
        try {
          for await (const entry of Deno.readDir(`${dir}/nodes`)) {
            if (entry.isFile && entry.name.endsWith(".yaml")) {
              nodeConfigs++;
            }
          }
        } catch {
          // nodes/ dir may not exist yet
        }

        const handle = await context.writeResource("result", "cluster-state", {
          command: "stat",
          stdout: `Found: ${found.join(", ") || "none"} | Missing: ${
            missing.join(", ") || "none"
          } | Node configs: ${nodeConfigs}`,
          stderr: "",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    init: {
      description: "Initialize talm cluster directory with preset",
      arguments: z.object({
        name: z.string().describe("Cluster name"),
        preset: z.string().default("cozystack").describe(
          "Talm preset (default: cozystack)",
        ),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        await Deno.mkdir(dir, { recursive: true });
        const cmdArgs = [
          "init",
          "--preset",
          args.preset,
          "--name",
          args.name,
          "--force",
          "--update",
        ];
        context.logger.info(`talm ${cmdArgs.join(" ")}`);
        const { stdout, stderr } = await runCmd(
          "talm",
          cmdArgs,
          dir,
          30000,
          "y\ny\ny\ny\ny\n",
        );
        context.logger.info(stdout || "Init completed");
        if (stderr) context.logger.info(stderr);

        // Regenerate talosconfig to match the (possibly new) secrets
        context.logger.info("Regenerating talosconfig from secrets.yaml...");
        const { stdout: tcOut, stderr: tcErr } = await runCmd(
          "talm",
          ["talosconfig"],
          dir,
          15000,
        );
        context.logger.info(tcOut || "talosconfig regenerated");
        if (tcErr) context.logger.info(tcErr);

        const handle = await context.writeResource("result", "init", {
          command: `talm ${cmdArgs.join(" ")} && talm talosconfig`,
          stdout: `${stdout}\n${tcOut}`,
          stderr: `${stderr}\n${tcErr}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description: "Update values.yaml in the cluster directory",
      arguments: z.object({
        endpoint: z.string().describe(
          "API server endpoint URL (e.g., https://192.0.2.17:6443)",
        ),
        floatingIP: z.string().describe("Floating/VIP IP for the cluster"),
        image: z.string().describe(
          "Talos install image (e.g., ghcr.io/cozystack/cozystack/talos:v1.10.5)",
        ),
        podSubnets: z.string().default("10.244.0.0/16").describe("Pod CIDR"),
        serviceSubnets: z.string().default("10.96.0.0/16").describe(
          "Service CIDR",
        ),
        advertisedSubnets: z.string().default("192.0.2.0/24").describe(
          "Advertised subnet for BGP/routing",
        ),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        const valuesPath = `${dir}/values.yaml`;

        // Build values.yaml content
        const values = `endpoint: ${args.endpoint}
floatingIP: ${args.floatingIP}
image: ${args.image}
podSubnets:
  - ${args.podSubnets}
serviceSubnets:
  - ${args.serviceSubnets}
advertisedSubnets:
  - ${args.advertisedSubnets}
`;
        context.logger.info(`Writing values.yaml to ${valuesPath}`);
        context.logger.info(values);
        await Deno.writeTextFile(valuesPath, values);

        const handle = await context.writeResource("result", "configure", {
          command: `write ${valuesPath}`,
          stdout: values,
          stderr: "",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    templateNode: {
      description:
        "Generate node config from template using talm template (retries on connection errors)",
      arguments: z.object({
        nodeIP: z.string().describe("Node IP address"),
        template: z.string().default("templates/controlplane.yaml").describe(
          "Template file path (relative to cluster dir)",
        ),
        outputFile: z.string().describe(
          "Output file path (relative to cluster dir)",
        ),
        installDisk: z.string().default("/dev/vda").describe(
          "Install disk device (talm auto-discovers /dev/sr0 for CD-ROM which is wrong)",
        ),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        const cmdArgs = [
          "template",
          "-e",
          args.nodeIP,
          "-n",
          args.nodeIP,
          "-t",
          args.template,
          "-i",
        ];
        context.logger.info(`talm ${cmdArgs.join(" ")} > ${args.outputFile}`);

        let lastErr;
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            const { stdout, stderr } = await runCmd(
              "talm",
              cmdArgs,
              dir,
              60000,
            );

            // Post-process: fix install disk (talm picks /dev/sr0 CD-ROM on empty disks)
            let config = stdout;
            config = config.replace(
              /disk: \/dev\/sr\d+/,
              `disk: ${args.installDisk}`,
            );

            // Post-process: add dhcp: true to interfaces (needed for IP after install)
            config = config.replace(
              /( +- interface: \S+)\n( +)(routes:|vip:)/gm,
              `$1\n$2dhcp: true\n$2$3`,
            );

            const outPath = `${dir}/${args.outputFile}`;
            const outDir = outPath.substring(0, outPath.lastIndexOf("/"));
            await Deno.mkdir(outDir, { recursive: true });

            await Deno.writeTextFile(outPath, config);
            context.logger.info(`Wrote ${config.length} bytes to ${outPath}`);
            if (config !== stdout) {
              context.logger.info(
                "Post-processed: fixed install disk and added dhcp: true",
              );
            }
            if (stderr) context.logger.info(stderr);

            const handle = await context.writeResource(
              "nodeConfig",
              args.outputFile.replace(/[/.]/g, "-"),
              {
                nodeIP: args.nodeIP,
                configFile: outPath,
                template: args.template,
                timestamp: new Date().toISOString(),
              },
            );
            return { dataHandles: [handle] };
          } catch (e) {
            lastErr = e;
            const msg = e instanceof Error ? e.message : String(e);
            if (
              msg.includes("connection refused") ||
              msg.includes("connection error") ||
              msg.includes("Unavailable") ||
              msg.includes("i/o timeout") ||
              msg.includes("deadline exceeded")
            ) {
              context.logger.info(
                `Attempt ${
                  attempt + 1
                } failed (node not ready), retrying in 15s...`,
              );
              await new Promise((r) => setTimeout(r, 15000));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      },
    },

    apply: {
      description: "Apply node config using talm apply",
      arguments: z.object({
        nodeFile: z.string().describe(
          "Node config file path (relative to cluster dir)",
        ),
        insecure: z.boolean().default(false).describe(
          "Use --insecure flag for maintenance mode",
        ),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        const cmdArgs = ["apply", "-f", args.nodeFile];
        if (args.insecure) cmdArgs.push("-i");
        context.logger.info(`talm ${cmdArgs.join(" ")}`);

        // Apply can take a while — allow retries for transient errors
        let lastErr;
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            const { stdout, stderr } = await runCmd(
              "talm",
              cmdArgs,
              dir,
              120000,
            );
            context.logger.info(stdout || "Apply completed");
            if (stderr) context.logger.info(stderr);
            const handle = await context.writeResource(
              "result",
              `apply-${args.nodeFile.replace(/[/.]/g, "-")}`,
              {
                command: `talm ${cmdArgs.join(" ")}`,
                stdout,
                stderr,
                timestamp: new Date().toISOString(),
              },
            );
            return { dataHandles: [handle] };
          } catch (e) {
            lastErr = e;
            const msg = e instanceof Error ? e.message : String(e);
            if (
              msg.includes("connection refused") ||
              msg.includes("connection reset") ||
              msg.includes("Unavailable") ||
              msg.includes("deadline exceeded") ||
              msg.includes("i/o timeout")
            ) {
              context.logger.info(
                `Attempt ${attempt + 1} failed (transient), retrying in 15s...`,
              );
              await new Promise((r) => setTimeout(r, 15000));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      },
    },

    bootstrap: {
      description:
        "Bootstrap the cluster using talosctl (post-apply, nodes on port 50000)",
      arguments: z.object({
        endpoint: z.string().describe("Node endpoint IP to bootstrap"),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        const talosconfig = `${dir}/talosconfig`;
        const cmdArgs = [
          "bootstrap",
          "--talosconfig",
          talosconfig,
          "--endpoints",
          args.endpoint,
          "--nodes",
          args.endpoint,
        ];
        context.logger.info(`talosctl ${cmdArgs.join(" ")}`);

        // Bootstrap needs retries — node may still be rebooting after apply
        let lastErr;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const { stdout, stderr } = await runCmd(
              "talosctl",
              cmdArgs,
              dir,
              120000,
            );
            context.logger.info(stdout || "Bootstrap completed");
            if (stderr) context.logger.info(stderr);
            const handle = await context.writeResource("result", "bootstrap", {
              command: `talosctl ${cmdArgs.join(" ")}`,
              stdout,
              stderr,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          } catch (e) {
            lastErr = e;
            const msg = e instanceof Error ? e.message : String(e);
            if (
              msg.includes("connection refused") ||
              msg.includes("connection error") ||
              msg.includes("Unavailable") ||
              msg.includes("deadline exceeded") ||
              msg.includes("etcd") ||
              msg.includes("i/o timeout") ||
              msg.includes("transport is closing")
            ) {
              context.logger.info(
                `Attempt ${attempt + 1} failed (transient), retrying in 15s...`,
              );
              await new Promise((r) => setTimeout(r, 15000));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      },
    },

    kubeconfig: {
      description: "Retrieve kubeconfig from a node via talosctl",
      arguments: z.object({
        endpoint: z.string().describe("Node endpoint IP"),
        outputFile: z.string().default("kubeconfig").describe(
          "Output file name (relative to cluster dir)",
        ),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        const talosconfig = `${dir}/talosconfig`;
        const outPath = `${dir}/${args.outputFile}`;
        const cmdArgs = [
          "kubeconfig",
          outPath,
          "--talosconfig",
          talosconfig,
          "--endpoints",
          args.endpoint,
          "--nodes",
          args.endpoint,
          "--force",
        ];
        context.logger.info(`talosctl ${cmdArgs.join(" ")}`);
        const { stderr } = await runCmd(
          "talosctl",
          cmdArgs,
          dir,
          30000,
        );
        context.logger.info(`Wrote kubeconfig to ${outPath}`);
        if (stderr) context.logger.info(stderr);

        const handle = await context.writeResource("result", "kubeconfig", {
          command: `talosctl ${cmdArgs.join(" ")}`,
          stdout: `kubeconfig written to ${outPath}`,
          stderr,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    health: {
      description:
        "Check cluster health via talosctl using cluster talosconfig",
      arguments: z.object({
        waitTimeout: z.string().default("30s").describe(
          "How long to wait for health (e.g., 30s, 5m, 10m)",
        ),
        endpoint: z.string().describe("Node endpoint IP to check"),
      }),
      execute: async (args, context) => {
        const dir = context.globalArgs.clusterDir;
        const talosconfig = `${dir}/talosconfig`;
        const cmdArgs = [
          "health",
          "--talosconfig",
          talosconfig,
          "--endpoints",
          args.endpoint,
          "--nodes",
          args.endpoint,
          "--wait-timeout",
          args.waitTimeout,
        ];
        context.logger.info(`talosctl ${cmdArgs.join(" ")}`);

        let lastErr;
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            const { stdout, stderr } = await runCmd(
              "talosctl",
              cmdArgs,
              dir,
              900000,
            );
            context.logger.info(stdout || "Cluster healthy");
            if (stderr) context.logger.info(stderr);

            const handle = await context.writeResource("result", "health", {
              command: `talosctl ${cmdArgs.join(" ")}`,
              stdout: stdout || "Cluster healthy",
              stderr,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          } catch (e) {
            lastErr = e;
            const msg = e instanceof Error ? e.message : String(e);
            if (
              msg.includes("connection refused") ||
              msg.includes("connection error") ||
              msg.includes("Unavailable") ||
              msg.includes("i/o timeout") ||
              msg.includes("deadline exceeded") ||
              msg.includes("transport is closing") ||
              msg.includes("healthcheck error")
            ) {
              context.logger.info(
                `Attempt ${attempt + 1} failed (transient), retrying in 15s...`,
              );
              await new Promise((r) => setTimeout(r, 15000));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      },
    },
  },
};
