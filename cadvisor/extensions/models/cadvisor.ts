import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  host: z.string().describe("Docker host (IP or hostname)"),
  username: z.string().default("root").describe("SSH username"),
  cadvisorPort: z.number().default(8080).describe("cAdvisor exposed port"),
  vmComposeDir: z.string().describe(
    "Path to VictoriaMetrics docker-compose directory on the host",
  ),
  vmComposeFile: z.string().default("compose-vl-single.yml").describe(
    "VM compose file name",
  ),
  vmScrapeConfig: z.string().default("prometheus-vl-single.yml").describe(
    "VM prometheus scrape config file name",
  ),
});

const StatusSchema = z.object({
  running: z.boolean(),
  containerStatus: z.string(),
  port: z.number(),
  scrapeConfigured: z.boolean(),
  timestamp: z.string(),
});

const MetricsSchema = z.object({
  containers: z.array(z.object({
    name: z.string(),
    memoryUsageMB: z.number(),
    memoryLimitMB: z.number(),
    memoryPercent: z.number(),
    cpuPercent: z.number(),
    networkRxMBps: z.number(),
    networkTxMBps: z.number(),
  })),
  totalMemoryMB: z.number(),
  totalContainers: z.number(),
  timestamp: z.string(),
});

const TopMemorySchema = z.object({
  containers: z.array(z.object({
    name: z.string(),
    currentMB: z.number(),
    maxMB: z.number(),
    avgMB: z.number(),
    growthMB: z.number(),
    growthPercent: z.number(),
  })),
  hoursBack: z.number(),
  timestamp: z.string(),
});

interface ContainerStat {
  timestamp: string;
  memory?: { usage?: number };
  cpu?: { usage: { total: number; per_cpu_usage?: number[] } };
  network?: { rx_bytes?: number; tx_bytes?: number };
}

interface ContainerInfo {
  stats?: ContainerStat[];
  aliases?: string[];
  spec?: { memory?: { limit?: number }; cpu?: { limit?: number } };
}

interface CurrentMetric {
  name: string;
  memoryUsageMB: number;
  memoryLimitMB: number;
  memoryPercent: number;
  cpuPercent: number;
  networkRxMBps: number;
  networkTxMBps: number;
}

interface VmRangeResult {
  data?: {
    result?: Array<{
      metric: { name?: string };
      values: [number, string][];
    }>;
  };
}

interface TopMemoryEntry {
  name: string;
  currentMB: number;
  maxMB: number;
  avgMB: number;
  growthMB: number;
  growthPercent: number;
}

async function runSsh(host, username, command) {
  const cmd = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      `${username}@${host}`,
      command,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) throw new Error(`SSH failed: ${stderr}`);
  return stdout;
}

async function vmQuery(host, port, path) {
  const resp = await fetch(`http://${host}:${port}${path}`);
  if (!resp.ok) {
    throw new Error(`VM query failed: ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

/** Swamp model that deploys cAdvisor and queries container resource metrics from cAdvisor and VictoriaMetrics. */
export const model = {
  type: "@magistr/cadvisor",
  version: "2026.05.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "status": {
      description: "cAdvisor deployment status",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "current": {
      description: "Current container metrics from cAdvisor",
      schema: MetricsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "topMemory": {
      description: "Top memory consumers over time from VictoriaMetrics",
      schema: TopMemorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "deploy": {
      description:
        "Deploy cAdvisor container and add it as a scrape target in VictoriaMetrics",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const {
          host,
          username,
          cadvisorPort,
          vmComposeDir,
          vmComposeFile,
          vmScrapeConfig,
        } = context.globalArgs;

        // 1. Deploy cAdvisor container
        context.logger.info("Deploying cAdvisor container...");
        const runCmd = [
          "docker run -d",
          "--name=cadvisor",
          "--restart=always",
          `--publish=${cadvisorPort}:8080`,
          "--volume=/:/rootfs:ro",
          "--volume=/var/run:/var/run:ro",
          "--volume=/sys:/sys:ro",
          "--volume=/var/lib/docker/:/var/lib/docker:ro",
          "--volume=/dev/disk/:/dev/disk:ro",
          "--privileged",
          "--device=/dev/kmsg",
          "gcr.io/cadvisor/cadvisor:v0.51.0",
        ].join(" ");

        // Check if already running
        let alreadyRunning = false;
        try {
          const check = await runSsh(
            host,
            username,
            "docker inspect cadvisor --format '{{.State.Running}}' 2>/dev/null",
          );
          if (check.trim() === "true") {
            alreadyRunning = true;
            context.logger.info("cAdvisor already running");
          } else {
            // Remove stopped container
            await runSsh(
              host,
              username,
              "docker rm cadvisor 2>/dev/null || true",
            );
          }
        } catch {
          // Container doesn't exist
        }

        if (!alreadyRunning) {
          await runSsh(host, username, runCmd);
          context.logger.info("cAdvisor container started");
        }

        // 2. Add scrape target to prometheus config
        context.logger.info("Configuring VictoriaMetrics scrape target...");
        const scrapeConfigPath = `${vmComposeDir}/${vmScrapeConfig}`;
        const currentConfig = await runSsh(
          host,
          username,
          `cat ${scrapeConfigPath}`,
        );

        if (!currentConfig.includes("cadvisor")) {
          const cadvisorJob = [
            "",
            "- job_name: cadvisor",
            "  scrape_interval: 30s",
            "  static_configs:",
            "  - targets:",
            `    - ${host}:${cadvisorPort}`,
          ].join("\n");

          await runSsh(
            host,
            username,
            `cat >> ${scrapeConfigPath} << 'HEREDOC'\n${cadvisorJob}\nHEREDOC`,
          );
          context.logger.info("Added cadvisor scrape target to config");

          // 3. Reload VictoriaMetrics config
          await runSsh(
            host,
            username,
            `cd ${vmComposeDir} && docker compose -f ${vmComposeFile} restart victoriametrics`,
          );
          context.logger.info(
            "Restarted VictoriaMetrics to pick up new config",
          );
        } else {
          context.logger.info("Scrape target already configured");
        }

        // 4. Verify
        await new Promise((r) => setTimeout(r, 5000));
        let running = false;
        try {
          const status = await runSsh(
            host,
            username,
            "docker inspect cadvisor --format '{{.State.Status}}'",
          );
          running = status.trim() === "running";
        } catch {
          running = false;
        }

        const finalConfig = await runSsh(
          host,
          username,
          `cat ${scrapeConfigPath}`,
        );
        const scrapeConfigured = finalConfig.includes("cadvisor");

        const handle = await context.writeResource("status", "current", {
          running,
          containerStatus: running ? "running" : "not running",
          port: cadvisorPort,
          scrapeConfigured,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "status": {
      description: "Check cAdvisor deployment status",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, username, cadvisorPort, vmComposeDir, vmScrapeConfig } =
          context.globalArgs;

        let running = false;
        let containerStatus = "not found";
        try {
          const status = await runSsh(
            host,
            username,
            "docker inspect cadvisor --format '{{.State.Status}}'",
          );
          containerStatus = status.trim();
          running = containerStatus === "running";
        } catch {
          // not found
        }

        const scrapeConfigPath = `${vmComposeDir}/${vmScrapeConfig}`;
        let scrapeConfigured = false;
        try {
          const config = await runSsh(
            host,
            username,
            `cat ${scrapeConfigPath}`,
          );
          scrapeConfigured = config.includes("cadvisor");
        } catch {
          // can't read
        }

        const handle = await context.writeResource("status", "current", {
          running,
          containerStatus,
          port: cadvisorPort,
          scrapeConfigured,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "current-metrics": {
      description: "Get current container metrics directly from cAdvisor API",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, cadvisorPort } = context.globalArgs;

        const resp = await fetch(
          `http://${host}:${cadvisorPort}/api/v1.3/docker`,
        );
        if (!resp.ok) throw new Error(`cAdvisor API failed: ${resp.status}`);
        const data = await resp.json() as Record<string, ContainerInfo>;

        const containers: CurrentMetric[] = [];
        for (const [path, info] of Object.entries(data)) {
          if (!info.stats || !info.stats.length) continue;
          const latest = info.stats[info.stats.length - 1];
          const prev = info.stats.length > 1
            ? info.stats[info.stats.length - 2]
            : null;

          const name =
            (info.aliases ? info.aliases[0] : path.split("/").pop()) ??
              "unknown";
          const memUsage = latest.memory?.usage || 0;
          const memLimit = info.spec?.memory?.limit || 0;

          let cpuPercent = 0;
          if (prev && latest.cpu && prev.cpu) {
            const cpuDelta = latest.cpu.usage.total - prev.cpu.usage.total;
            const timeDelta = new Date(latest.timestamp).getTime() -
              new Date(prev.timestamp).getTime();
            if (timeDelta > 0) {
              const _numCores = info.spec?.cpu?.limit ||
                (latest.cpu.usage.per_cpu_usage?.length || 1);
              cpuPercent = (cpuDelta / (timeDelta * 1e6)) * 100;
            }
          }

          let rxRate = 0, txRate = 0;
          if (prev && latest.network && prev.network) {
            const timeDelta = (new Date(latest.timestamp).getTime() -
              new Date(prev.timestamp).getTime()) / 1000;
            if (timeDelta > 0) {
              const rxDelta = (latest.network.rx_bytes || 0) -
                (prev.network.rx_bytes || 0);
              const txDelta = (latest.network.tx_bytes || 0) -
                (prev.network.tx_bytes || 0);
              rxRate = rxDelta / timeDelta / 1024 / 1024;
              txRate = txDelta / timeDelta / 1024 / 1024;
            }
          }

          containers.push({
            name,
            memoryUsageMB: Math.round(memUsage / 1024 / 1024),
            memoryLimitMB: memLimit > 0 && memLimit < 1e18
              ? Math.round(memLimit / 1024 / 1024)
              : 0,
            memoryPercent: memLimit > 0 && memLimit < 1e18
              ? Math.round(memUsage / memLimit * 1000) / 10
              : 0,
            cpuPercent: Math.round(cpuPercent * 100) / 100,
            networkRxMBps: Math.round(rxRate * 100) / 100,
            networkTxMBps: Math.round(txRate * 100) / 100,
          });
        }

        containers.sort((a, b) => b.memoryUsageMB - a.memoryUsageMB);
        const totalMem = containers.reduce((s, c) => s + c.memoryUsageMB, 0);

        const handle = await context.writeResource("current", "current", {
          containers,
          totalMemoryMB: totalMem,
          totalContainers: containers.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "top-memory": {
      description:
        "Get top memory consumers over time from VictoriaMetrics (requires cAdvisor metrics to be scraped)",
      arguments: z.object({
        hoursBack: z.number().default(12).describe("Hours to look back"),
        topN: z.number().default(20).describe("Number of top containers"),
      }),
      execute: async (args, context) => {
        const { host } = context.globalArgs;
        const vmPort = 8428;
        const end = Math.floor(Date.now() / 1000);
        const start = end - (args.hoursBack * 3600);

        const query = 'container_memory_usage_bytes{name!=""}';
        const url = `/api/v1/query_range?query=${
          encodeURIComponent(query)
        }&start=${start}&end=${end}&step=300`;
        const result = await vmQuery(host, vmPort, url) as VmRangeResult;

        const containers: TopMemoryEntry[] = [];
        for (const r of (result.data?.result || [])) {
          const name = r.metric.name || "unknown";
          const vals = r.values.map((v) => parseFloat(v[1])).filter((v) =>
            v > 0
          );
          if (!vals.length) continue;

          const first = vals[0];
          const last = vals[vals.length - 1];
          const mx = Math.max(...vals);
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          const growth = last - first;
          const growthPct = first > 0 ? (growth / first) * 100 : 0;

          containers.push({
            name,
            currentMB: Math.round(last / 1024 / 1024),
            maxMB: Math.round(mx / 1024 / 1024),
            avgMB: Math.round(avg / 1024 / 1024),
            growthMB: Math.round(growth / 1024 / 1024),
            growthPercent: Math.round(growthPct * 10) / 10,
          });
        }

        containers.sort((a, b) => b.maxMB - a.maxMB);

        const handle = await context.writeResource("topMemory", "current", {
          containers: containers.slice(0, args.topN),
          hoursBack: args.hoursBack,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "remove": {
      description: "Remove cAdvisor container and scrape config",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, username, vmComposeDir, vmComposeFile, vmScrapeConfig } =
          context.globalArgs;

        // Stop and remove container
        await runSsh(
          host,
          username,
          "docker stop cadvisor 2>/dev/null; docker rm cadvisor 2>/dev/null || true",
        );

        // Remove scrape config entry
        const scrapeConfigPath = `${vmComposeDir}/${vmScrapeConfig}`;
        await runSsh(
          host,
          username,
          `sed -i '/cadvisor/,/- .*:8080/{//d;d}' ${scrapeConfigPath} 2>/dev/null; sed -i '/cadvisor/d' ${scrapeConfigPath} 2>/dev/null; sed -i '/^$/N;/^\\n$/d' ${scrapeConfigPath} 2>/dev/null || true`,
        );

        // Restart VM
        await runSsh(
          host,
          username,
          `cd ${vmComposeDir} && docker compose -f ${vmComposeFile} restart victoriametrics`,
        );

        const handle = await context.writeResource("status", "current", {
          running: false,
          containerStatus: "removed",
          port: 0,
          scrapeConfigured: false,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
