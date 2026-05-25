import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  host: z.string().describe("VictoriaMetrics host (IP or hostname)"),
  port: z.number().default(8428).describe("VictoriaMetrics HTTP port"),
});

const QueryResultSchema = z.object({
  query: z.string(),
  resultType: z.string(),
  results: z.array(z.any()),
  timestamp: z.string(),
});

const HealthSchema = z.object({
  targets: z.array(z.object({
    name: z.string(),
    status: z.string(),
  })),
  timestamp: z.string(),
});

const SystemOverviewSchema = z.object({
  cpu: z.object({
    current: z.number(),
    min: z.number(),
    max: z.number(),
    avg: z.number(),
  }),
  memory: z.object({
    usedPercent: z.number(),
    min: z.number(),
    max: z.number(),
    avg: z.number(),
  }),
  load: z.object({
    load1: z.number(),
    min: z.number(),
    max: z.number(),
    avg: z.number(),
  }),
  disk: z.array(
    z.object({
      device: z.string(),
      maxIoPercent: z.number(),
      avgIoPercent: z.number(),
    }),
  ),
  network: z.object({ maxMbps: z.number(), avgMbps: z.number() }),
  uptime: z.object({ bootTime: z.string(), uptimeMinutes: z.number() }),
  anomalies: z.array(z.string()),
  timestamp: z.string(),
});

const ContainerMemorySchema = z.object({
  containers: z.array(z.object({
    name: z.string(),
    maxMB: z.number(),
    startMB: z.number(),
    endMB: z.number(),
    growthPercent: z.number(),
  })),
  timestamp: z.string(),
});

async function vmQuery(host, port, path) {
  const resp = await fetch(`http://${host}:${port}${path}`);
  if (!resp.ok) {
    throw new Error(`VM query failed: ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

async function instantQuery(host, port, query) {
  const url = `/api/v1/query?query=${encodeURIComponent(query)}`;
  return await vmQuery(host, port, url);
}

async function rangeQuery(host, port, query, start, end, step) {
  const url = `/api/v1/query_range?query=${
    encodeURIComponent(query)
  }&start=${start}&end=${end}&step=${step}`;
  return await vmQuery(host, port, url);
}

function extractValues(result) {
  if (!result.data || !result.data.result || !result.data.result[0]) return [];
  return result.data.result[0].values.map((v) => ({
    ts: v[0],
    val: parseFloat(v[1]),
  }));
}

function stats(values) {
  if (!values.length) return { min: 0, max: 0, avg: 0 };
  const nums = values.map((v) => v.val);
  return {
    min: Math.min(...nums),
    max: Math.max(...nums),
    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
  };
}

/**
 * VictoriaMetrics query model: instant/range PromQL, scrape-target health, a
 * node-exporter system overview, and container memory rankings over the HTTP
 * query API (`/api/v1/query`, `/api/v1/query_range`).
 */
export const model = {
  type: "@magistr/victoriametrics",
  version: "2026.05.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "queryResult": {
      description: "Result of a PromQL query",
      schema: QueryResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "health": {
      description: "Scrape target health status",
      schema: HealthSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "overview": {
      description: "System metrics overview",
      schema: SystemOverviewSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "containerMemory": {
      description: "Container memory usage rankings",
      schema: ContainerMemorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "query": {
      description: "Run an instant PromQL query",
      arguments: z.object({
        promql: z.string().describe("PromQL query expression"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const result = await instantQuery(host, port, args.promql);
        const handle = await context.writeResource("queryResult", "current", {
          query: args.promql,
          resultType: result.data.resultType,
          results: result.data.result.map((r) => ({
            metric: r.metric,
            value: r.value ? parseFloat(r.value[1]) : null,
          })),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "query-range": {
      description: "Run a range PromQL query over a time window",
      arguments: z.object({
        promql: z.string().describe("PromQL query expression"),
        hoursBack: z.number().default(12).describe("Hours to look back"),
        stepSeconds: z.number().default(300).describe(
          "Step interval in seconds",
        ),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const end = Math.floor(Date.now() / 1000);
        const start = end - (args.hoursBack * 3600);
        const result = await rangeQuery(
          host,
          port,
          args.promql,
          start,
          end,
          args.stepSeconds,
        );
        const handle = await context.writeResource("queryResult", "current", {
          query: args.promql,
          resultType: result.data.resultType,
          results: result.data.result.map((r) => ({
            metric: r.metric,
            values: r.values.map((v) => ({
              timestamp: v[0],
              value: parseFloat(v[1]),
            })),
          })),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "health": {
      description: "Check scrape target health (up/down status)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, port } = context.globalArgs;
        const result = await instantQuery(host, port, "up");
        const targets = result.data.result.map((r) => ({
          name: `${r.metric.job} (${r.metric.instance})`,
          status: parseFloat(r.value[1]) === 1 ? "up" : "down",
        }));
        const handle = await context.writeResource("health", "current", {
          targets,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "system-overview": {
      description:
        "Get system metrics overview for a time window (CPU, memory, load, disk, network, anomalies)",
      arguments: z.object({
        hoursBack: z.number().default(12).describe("Hours to look back"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const end = Math.floor(Date.now() / 1000);
        const start = end - (args.hoursBack * 3600);
        const step = 300;

        const [cpuData, memData, loadData, diskData, netData, bootData] =
          await Promise.all([
            rangeQuery(
              host,
              port,
              '100-avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100',
              start,
              end,
              step,
            ),
            rangeQuery(
              host,
              port,
              "(1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)*100",
              start,
              end,
              step,
            ),
            rangeQuery(host, port, "node_load1", start, end, step),
            rangeQuery(
              host,
              port,
              "rate(node_disk_io_time_seconds_total[5m])*100",
              start,
              end,
              step,
            ),
            rangeQuery(
              host,
              port,
              'rate(node_network_receive_bytes_total{device="br0"}[5m])*8',
              start,
              end,
              step,
            ),
            instantQuery(host, port, "node_boot_time_seconds"),
          ]);

        const cpuVals = extractValues(cpuData);
        const memVals = extractValues(memData);
        const loadVals = extractValues(loadData);
        const cpuStats = stats(cpuVals);
        const memStats = stats(memVals);
        const loadStats = stats(loadVals);

        // Disk I/O per device
        const diskDevices = (diskData.data.result || []).map((r) => {
          const vals = r.values.map((v) => parseFloat(v[1]));
          const mx = Math.max(...vals);
          return {
            device: r.metric.device || "unknown",
            maxIoPercent: Math.round(mx * 10) / 10,
            avgIoPercent: Math.round(
              vals.reduce((a, b) => a + b, 0) / vals.length * 10,
            ) / 10,
          };
        }).filter((d) => d.maxIoPercent > 10).sort((a, b) =>
          b.maxIoPercent - a.maxIoPercent
        );

        // Network
        const netVals = extractValues(netData);
        const netStats = stats(netVals);

        // Boot time
        const bootTs = bootData.data.result[0]
          ? parseFloat(bootData.data.result[0].value[1])
          : 0;
        const bootTime = new Date(bootTs * 1000).toISOString();
        const uptimeMinutes = Math.round((Date.now() / 1000 - bootTs) / 60);

        // Detect anomalies
        const anomalies: string[] = [];
        if (cpuStats.max > 90) {
          anomalies.push(`CPU spike to ${cpuStats.max.toFixed(1)}%`);
        }
        if (memStats.max > 90) {
          anomalies.push(`Memory peaked at ${memStats.max.toFixed(1)}%`);
        }
        if (memStats.min > 80) {
          anomalies.push(
            `Memory consistently high (min ${memStats.min.toFixed(1)}%)`,
          );
        }
        if (loadStats.max > 30) {
          anomalies.push(`Load spike to ${loadStats.max.toFixed(1)}`);
        }

        // Check for metric gaps (reboot indicator)
        for (let i = 1; i < cpuVals.length; i++) {
          const gap = cpuVals[i].ts - cpuVals[i - 1].ts;
          if (gap > 600) {
            const gapStart = new Date(cpuVals[i - 1].ts * 1000).toISOString();
            const gapEnd = new Date(cpuVals[i].ts * 1000).toISOString();
            anomalies.push(
              `Metric gap ${
                Math.round(gap / 60)
              }min (${gapStart} -> ${gapEnd}) - possible reboot`,
            );
          }
        }

        // Disk anomalies
        for (const d of diskDevices) {
          if (d.maxIoPercent > 90) {
            anomalies.push(`Disk ${d.device} saturated at ${d.maxIoPercent}%`);
          }
        }

        // Memory growth trend
        if (memVals.length > 10) {
          const firstTen = memVals.slice(0, 10).reduce((a, b) => a + b.val, 0) /
            10;
          const lastTen = memVals.slice(-10).reduce((a, b) => a + b.val, 0) /
            10;
          if (lastTen - firstTen > 5) {
            anomalies.push(
              `Memory growing: ${firstTen.toFixed(1)}% -> ${
                lastTen.toFixed(1)
              }% over window`,
            );
          }
        }

        const handle = await context.writeResource("overview", "current", {
          cpu: {
            current: cpuVals.length ? cpuVals[cpuVals.length - 1].val : 0,
            ...cpuStats,
          },
          memory: {
            usedPercent: memVals.length ? memVals[memVals.length - 1].val : 0,
            ...memStats,
          },
          load: {
            load1: loadVals.length ? loadVals[loadVals.length - 1].val : 0,
            ...loadStats,
          },
          disk: diskDevices,
          network: { maxMbps: netStats.max / 1e6, avgMbps: netStats.avg / 1e6 },
          uptime: { bootTime, uptimeMinutes },
          anomalies,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "container-memory": {
      description: "Get container memory usage rankings over a time window",
      arguments: z.object({
        hoursBack: z.number().default(12).describe("Hours to look back"),
        topN: z.number().default(20).describe(
          "Number of top containers to return",
        ),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const end = Math.floor(Date.now() / 1000);
        const start = end - (args.hoursBack * 3600);
        const result = await rangeQuery(
          host,
          port,
          "container_memory_usage_bytes",
          start,
          end,
          600,
        );

        const containers: Array<{
          name: string;
          maxMB: number;
          startMB: number;
          endMB: number;
          growthPercent: number;
        }> = [];
        for (const r of (result.data.result || [])) {
          const name = r.metric.name || "unknown";
          const vals = r.values.map((v) => parseFloat(v[1])).filter((v) =>
            v > 0
          );
          if (!vals.length || Math.max(...vals) < 50 * 1024 * 1024) continue;

          const first = vals[0];
          const last = vals[vals.length - 1];
          const mx = Math.max(...vals);
          const growth = first > 0 ? ((last - first) / first) * 100 : 0;

          containers.push({
            name,
            maxMB: Math.round(mx / 1024 / 1024),
            startMB: Math.round(first / 1024 / 1024),
            endMB: Math.round(last / 1024 / 1024),
            growthPercent: Math.round(growth * 10) / 10,
          });
        }

        containers.sort((a, b) => b.maxMB - a.maxMB);

        const handle = await context.writeResource(
          "containerMemory",
          "current",
          {
            containers: containers.slice(0, args.topN),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
