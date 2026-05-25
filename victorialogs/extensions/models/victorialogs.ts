import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  host: z.string().describe("VictoriaLogs host (IP or hostname)"),
  port: z.number().default(9428).describe("VictoriaLogs HTTP port"),
});

const QueryResultSchema = z.object({
  query: z.string(),
  totalEntries: z.number(),
  entries: z.array(z.any()),
  timestamp: z.string(),
});

const StatsSchema = z.object({
  query: z.string(),
  stats: z.array(z.any()),
  timestamp: z.string(),
});

const ContainerStatusSchema = z.object({
  logging: z.array(z.object({
    name: z.string(),
    count: z.number(),
  })),
  notLogging: z.array(z.string()),
  period: z.string(),
  timestamp: z.string(),
});

const ErrorSummarySchema = z.object({
  totalErrors: z.number(),
  byContainer: z.array(z.object({
    name: z.string(),
    count: z.number(),
    samples: z.array(z.string()),
  })),
  period: z.string(),
  timestamp: z.string(),
});

async function vlogsQuery(host, port, query, params) {
  const body = new URLSearchParams();
  body.append("query", query);
  for (const [k, v] of Object.entries(params || {})) {
    body.append(k, String(v));
  }
  const resp = await fetch(`http://${host}:${port}/select/logsql/query`, {
    method: "POST",
    body,
  });
  if (!resp.ok) {
    throw new Error(`VLogs query failed: ${resp.status} ${await resp.text()}`);
  }
  const text = await resp.text();
  return text.trim().split("\n").filter((l) => l.trim()).map((l) =>
    JSON.parse(l)
  );
}

async function vlogsStats(host, port, query, params) {
  const body = new URLSearchParams();
  body.append("query", query);
  for (const [k, v] of Object.entries(params || {})) {
    body.append(k, String(v));
  }
  const resp = await fetch(`http://${host}:${port}/select/logsql/query`, {
    method: "POST",
    body,
  });
  if (!resp.ok) {
    throw new Error(`VLogs stats failed: ${resp.status} ${await resp.text()}`);
  }
  const text = await resp.text();
  return text.trim().split("\n").filter((l) => l.trim()).map((l) =>
    JSON.parse(l)
  );
}

async function getRunningContainers(host) {
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
      `root@${host}`,
      "docker ps --format '{{.Names}}'",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return new TextDecoder().decode(output.stdout).trim().split("\n").filter(
    (l) => l.trim(),
  );
}

/** VictoriaLogs query model: runs LogsQL queries, stats, and container/error analytics against a VictoriaLogs HTTP endpoint. */
export const model = {
  type: "@magistr/victorialogs",
  version: "2026.05.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "queryResult": {
      description: "Raw log query result",
      schema: QueryResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "stats": {
      description: "Log statistics result",
      schema: StatsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "containerStatus": {
      description: "Which containers are/aren't logging",
      schema: ContainerStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "errorSummary": {
      description: "Error log summary by container",
      schema: ErrorSummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "query": {
      description: "Run a LogsQL query and return matching entries",
      arguments: z.object({
        logsql: z.string().default("*").describe("LogsQL query expression"),
        start: z.string().default("-24h").describe(
          "Start time (e.g. -24h, -7d, 2026-01-01T00:00:00Z)",
        ),
        end: z.string().optional().describe("End time (default: now)"),
        limit: z.number().default(100).describe("Max entries to return"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const params: Record<string, string> = {
          start: args.start,
          limit: String(args.limit),
        };
        if (args.end) params.end = args.end;

        const entries = await vlogsQuery(host, port, args.logsql, params);
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const handle = await context.writeResource(
          "queryResult",
          `query-${ts}`,
          {
            query: args.logsql,
            totalEntries: entries.length,
            entries: entries.map((e) => ({
              time: e._time,
              container: e.container_name ||
                e["label.com.docker.compose.service"] || "unknown",
              message: (e._msg || "").slice(0, 500),
              stream: e.stream,
            })),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "stats": {
      description: "Run a LogsQL stats query (must include '| stats ...' pipe)",
      arguments: z.object({
        logsql: z.string().default("* | stats count() as total").describe(
          "LogsQL query with stats pipe",
        ),
        start: z.string().default("-24h").describe("Start time"),
        end: z.string().optional().describe("End time"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const params: Record<string, string> = { start: args.start };
        if (args.end) params.end = args.end;

        const results = await vlogsStats(host, port, args.logsql, params);
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const handle = await context.writeResource("stats", `stats-${ts}`, {
          query: args.logsql,
          stats: results,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "container-log-status": {
      description:
        "Compare which running containers are logging vs silent (detect down/broken log pipelines)",
      arguments: z.object({
        start: z.string().default("-1h").describe("Time window to check"),
        end: z.string().optional().describe("End time"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const params: Record<string, string> = { start: args.start };
        if (args.end) params.end = args.end;

        // Get containers that are logging
        const statsQuery =
          "* | stats by (container_name) count() as total | sort by (total) desc";
        const loggedContainers = await vlogsStats(
          host,
          port,
          statsQuery,
          params,
        );
        const loggingSet = new Set(
          loggedContainers.map((e) => e.container_name),
        );

        // Get running containers from docker
        const running = await getRunningContainers(host);
        const notLogging = running.filter((c) => !loggingSet.has(c));

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const handle = await context.writeResource(
          "containerStatus",
          `container-status-${ts}`,
          {
            logging: loggedContainers.map((e) => ({
              name: e.container_name,
              count: parseInt(e.total),
            })),
            notLogging,
            period: args.start,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "error-summary": {
      description: "Summarize error/fatal/panic/OOM log entries by container",
      arguments: z.object({
        start: z.string().default("-24h").describe("Start time"),
        end: z.string().optional().describe("End time"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const params: Record<string, string> = {
          start: args.start,
          limit: "500",
        };
        if (args.end) params.end = args.end;

        const errorQuery =
          '_msg:error OR _msg:fatal OR _msg:panic OR _msg:killed OR _msg:OOM OR _msg:"out of memory" OR _msg:exception OR _msg:"stack trace"';
        const entries = await vlogsQuery(host, port, errorQuery, params);

        // Group by container
        const byContainer: Record<
          string,
          { count: number; samples: string[] }
        > = {};
        for (const e of entries) {
          const name = e.container_name ||
            e["label.com.docker.compose.service"] || "unknown";
          if (!byContainer[name]) byContainer[name] = { count: 0, samples: [] };
          byContainer[name].count++;
          if (byContainer[name].samples.length < 5) {
            byContainer[name].samples.push(
              `[${(e._time || "").slice(0, 19)}] ${
                (e._msg || "").slice(0, 300)
              }`,
            );
          }
        }

        const sorted = Object.entries(byContainer)
          .map(([name, data]) => ({
            name,
            count: data.count,
            samples: data.samples,
          }))
          .sort((a, b) => b.count - a.count);

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const handle = await context.writeResource(
          "errorSummary",
          `error-summary-${ts}`,
          {
            totalErrors: entries.length,
            byContainer: sorted,
            period: args.start,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "compare-periods": {
      description:
        "Compare log volume between two time periods to find services that went down",
      arguments: z.object({
        baseline_start: z.string().default("2026-01-07T00:00:00Z").describe(
          "Baseline period start",
        ),
        baseline_end: z.string().default("2026-01-21T00:00:00Z").describe(
          "Baseline period end",
        ),
        compare_start: z.string().default("-2h").describe(
          "Comparison period start",
        ),
        compare_end: z.string().optional().describe(
          "Comparison period end (default: now)",
        ),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;

        const statsQuery =
          "* | stats by (container_name) count() as total | sort by (total) desc";

        const baselineParams = {
          start: args.baseline_start,
          end: args.baseline_end,
        };
        const compareParams: Record<string, string> = {
          start: args.compare_start,
        };
        if (args.compare_end) compareParams.end = args.compare_end;

        const [baseline, compare] = await Promise.all([
          vlogsStats(host, port, statsQuery, baselineParams),
          vlogsStats(host, port, statsQuery, compareParams),
        ]);

        const baselineMap: Record<string, number> = {};
        for (const e of baseline) {
          baselineMap[e.container_name] = parseInt(e.total);
        }
        const compareMap: Record<string, number> = {};
        for (const e of compare) {
          compareMap[e.container_name] = parseInt(e.total);
        }

        const allContainers = new Set([
          ...Object.keys(baselineMap),
          ...Object.keys(compareMap),
        ]);
        const comparison: Array<
          { name: string; baseline: number; current: number; status: string }
        > = [];
        for (const name of allContainers) {
          const base = baselineMap[name] || 0;
          const comp = compareMap[name] || 0;
          const status = comp === 0 && base > 0
            ? "GONE"
            : base === 0 && comp > 0
            ? "NEW"
            : comp < base * 0.1
            ? "MOSTLY_SILENT"
            : comp > base * 2
            ? "MUCH_MORE_ACTIVE"
            : "NORMAL";
          comparison.push({ name, baseline: base, current: comp, status });
        }

        comparison.sort((a, b) => {
          const order: Record<string, number> = {
            GONE: 0,
            MOSTLY_SILENT: 1,
            NEW: 2,
            MUCH_MORE_ACTIVE: 3,
            NORMAL: 4,
          };
          return (order[a.status] || 9) - (order[b.status] || 9);
        });

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const handle = await context.writeResource("stats", `compare-${ts}`, {
          query: "compare-periods",
          stats: comparison,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
