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

const PushResultSchema = z.object({
  endpoint: z.string(),
  lines: z.number(),
  metrics: z.array(z.string()),
  httpStatus: z.number(),
  ok: z.boolean(),
  error: z.union([z.string(), z.null()]),
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
  return result.data.result.flatMap((s) => s.values ?? []).map((v) => ({
    ts: v[0],
    val: parseFloat(v[1]),
  }));
}

/**
 * Validates a query-API response before the direct single-query methods
 * (`query`, `query-range`, `health`) touch it: a `{status:"error"}` envelope
 * or a body whose `data.result` isn't an array throws a mapped Error instead
 * of an uncaught TypeError several frames down. `system-overview` and
 * `container-memory` do NOT go through this — they stay deliberately lenient
 * (missing/empty data degrades to zeroed stats, not a thrown error).
 */
function vmData(result) {
  if (
    result.status === "error" ||
    !Array.isArray(result.data && result.data.result)
  ) {
    throw new Error(
      `VM query error: ${result.error || "response missing data"}`,
    );
  }
  return result.data;
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
 * Virtual block layers node_exporter exports alongside the real hardware.
 * On Unraid an encrypted array slot stacks `dm-N` -> `mdXp1` -> one physical
 * `sdX`, so counting every layer reports one spindle up to three times, and a
 * dm/sd pair showing the same utilisation reads as two independent disks
 * corroborating each other when it is one device seen twice. That is an
 * identity, not a signal (Tower, 2026-08-30: dm-3 = md4p1 = disk4 = sdl).
 * Keep exactly one layer — the physical device — wherever disk I/O is
 * reported. Plain prefixes, no `\d`: nothing real begins with any of them,
 * and the PromQL string then needs no backslash escaping to stay in sync
 * with the client-side check.
 */
const VIRTUAL_DISK_PREFIXES = [
  "dm-",
  "md",
  "loop",
  "sr",
  "zram",
  "ram",
  "nbd",
  "drbd",
  "zd",
] as const;

/**
 * True for a device name that is a real spindle/namespace rather than a
 * mapper/RAID/loop layer. An unlabelled series normalises to `"unknown"`
 * upstream and is kept: it cannot be attributed to a layer, so dropping it
 * would silently lose a genuinely busy disk.
 */
export function isPhysicalDiskDevice(device: string): boolean {
  return device.length > 0 &&
    !VIRTUAL_DISK_PREFIXES.some((p) => device.startsWith(p));
}

/**
 * Disk-utilisation series for `system-overview`. The negative matcher drops
 * the virtual layers at query time so VictoriaMetrics never ships them;
 * `isPhysicalDiskDevice` re-checks client-side so a server that ignores the
 * matcher (or a name the matcher misses) still cannot double-count.
 */
export const DISK_IO_QUERY = `rate(node_disk_io_time_seconds_total{device!~"(${
  VIRTUAL_DISK_PREFIXES.join("|")
}).*"}[5m])*100`;

/**
 * The sample lines of a Prometheus exposition payload: everything that is not
 * blank and not a `#` comment (HELP/TYPE headers are legal in the format and
 * are not samples). One place, so the reported `lines` count and the reported
 * `metrics` names can never disagree about what counted as a sample.
 */
export function sampleLines(body: string): string[] {
  return String(body)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/**
 * Distinct metric names in a Prometheus exposition payload, in first-seen
 * order. A sample is `name{labels} value` or `name value`, so the name ends at
 * the first whitespace or `{`. Names only: the summary and the stored resource
 * stay readable when the payload itself is hundreds of lines.
 */
export function metricNames(body: string): string[] {
  const names = sampleLines(body).map((l) => l.split(/[\s{]/)[0]).filter((n) =>
    n !== ""
  );
  return [...new Set(names)];
}

/**
 * `extra_label` query params for VM's import endpoint, from a comma-separated
 * `key=value` list. Pairs without `=`, or with an empty key, are dropped rather
 * than sent malformed.
 *
 * Each whole pair is percent-encoded, `=` included: VM reads the param VALUE
 * as `name=value`, so `job=x` must arrive as `extra_label=job%3Dx` and be
 * decoded server-side into one value. Encoding only the halves would make VM
 * see a bare `extra_label=job` with a stray `x`.
 *
 * Only the KEY is trimmed, so `"job=x, instance=y"` still parses while a value
 * keeps every character it was given. Trimming the whole pair looked equivalent
 * and was not: it silently rewrote any value with leading or trailing
 * whitespace, so the label VM stored differed from the one the caller passed
 * (found by property f2, 2026-09-02). The split is at the FIRST `=`, so an `=`
 * inside a value survives.
 */
export function extraLabelParams(extraLabels?: string): string {
  return String(extraLabels || "")
    .split(",")
    .map((pair) => {
      const i = pair.indexOf("=");
      if (i < 0) return null;
      const key = pair.slice(0, i).trim();
      return key === "" ? null : `${key}=${pair.slice(i + 1)}`;
    })
    .filter((p) => p !== null)
    .map((p) => `extra_label=${encodeURIComponent(p)}`)
    .join("&");
}

/**
 * VictoriaMetrics query model: instant/range PromQL, scrape-target health, a
 * node-exporter system overview, container memory rankings over the HTTP query
 * API (`/api/v1/query`, `/api/v1/query_range`), and a metrics `push` over the
 * import API (`/api/v1/import/prometheus`).
 */
export const model = {
  type: "@magistr/victoriametrics",
  version: "2026.09.02.1",
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.02.1",
      description:
        "Fix all 11 victoriametrics-latent-bugs (multi-series aggregation, resultType dispatch, response/series shape guards, absence+boot flags, negative-topN clamp); no resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.30.1",
      description:
        "system-overview counts each physical disk once — dm-*/md*/loop*/etc are excluded in PromQL and re-checked client-side; no resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.02.1",
      description:
        "Restore the `push` method and its `pushResult` resource (lost when the model was rewritten); additive only, no existing resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    "pushResult": {
      description:
        "Result of importing metrics in Prometheus exposition format",
      schema: PushResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "push": {
      description:
        "Import metrics into VictoriaMetrics from Prometheus exposition text (one `name{labels} value` per line) via /api/v1/import/prometheus. Lets a job record its own outcome as a series that vmalert can alert on, instead of a chat message nobody diffs. Timestamps are assigned by VM at ingest.",
      arguments: z.object({
        lines: z.string().min(1).describe(
          "Prometheus exposition text; blank lines and # comments are allowed",
        ),
        extraLabels: z.string().optional().describe(
          "Labels applied to every pushed sample, as VM's extra_label query params would take them: comma-separated key=value",
        ),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const body = String(args.lines).trim() + "\n";
        const params = extraLabelParams(args.extraLabels);
        const endpoint = `http://${host}:${
          port || 8428
        }/api/v1/import/prometheus${params ? `?${params}` : ""}`;

        const names = metricNames(body);
        const lineCount = sampleLines(body).length;

        let httpStatus = 0;
        let error: string | null = null;
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body,
          });
          httpStatus = res.status;
          // VM answers 204 with an empty body on success; read it either way so
          // the connection is not left dangling.
          const text = await res.text();
          if (!res.ok) error = `HTTP ${res.status}: ${text.slice(0, 300)}`;
        } catch (e) {
          error = String(e);
        }

        const ok = !error;
        // Record the attempt BEFORE throwing: a push that failed is exactly the
        // one worth having a resource for, and a method that throws without
        // writing leaves no trace of what it tried to send.
        const handle = await context.writeResource("pushResult", "pushResult", {
          endpoint,
          lines: lineCount,
          metrics: names,
          httpStatus,
          ok,
          error,
          timestamp: new Date().toISOString(),
        });
        if (!ok) throw new Error(`VictoriaMetrics import failed: ${error}`);
        return {
          dataHandles: [handle],
          summary: `Pushed ${lineCount} sample(s) to ${host}: ${
            names.join(", ")
          }`,
        };
      },
    },

    "query": {
      description: "Run an instant PromQL query",
      arguments: z.object({
        promql: z.string().describe("PromQL query expression"),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const result = await instantQuery(host, port, args.promql);
        const data = vmData(result);
        const handle = await context.writeResource("queryResult", "current", {
          query: args.promql,
          resultType: data.resultType,
          results: data.resultType === "scalar"
            ? [{ metric: {}, value: parseFloat(data.result[1]) }]
            : data.result.map((r) => ({
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
        const data = vmData(result);
        const handle = await context.writeResource("queryResult", "current", {
          query: args.promql,
          resultType: data.resultType,
          results: data.result.map((r) => ({
            metric: r.metric,
            values: (r.values ?? []).map((v) => ({
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
      arguments: z.object({
        expectedTargets: z.array(z.string()).default([]).describe(
          'Target names ("job (instance)") expected to be present; any not seen in the up vector are appended with status:"unknown"',
        ),
      }),
      execute: async (args, context) => {
        const { host, port } = context.globalArgs;
        const result = await instantQuery(host, port, "up");
        const data = vmData(result);
        const targets = data.result.map((r) => ({
          name: `${r.metric.job} (${r.metric.instance})`,
          status: r.value
            ? (parseFloat(r.value[1]) === 1 ? "up" : "down")
            : "unknown",
        }));
        for (const name of args.expectedTargets) {
          if (!targets.some((t) => t.name === name)) {
            targets.push({ name, status: "unknown" });
          }
        }
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
              DISK_IO_QUERY,
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
        const diskDevices = (diskData.data?.result || [])
          .filter((r) => Array.isArray(r.values) && r.values.length > 0)
          .filter((r) => isPhysicalDiskDevice(r.metric.device || "unknown"))
          .map((r) => {
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
        const row = bootData?.data?.result?.[0];
        const bootTs = row?.value ? parseFloat(row.value[1]) : null;
        const bootTime = bootTs === null
          ? "unknown"
          : new Date(bootTs * 1000).toISOString();
        const uptimeMinutes = bootTs === null
          ? 0
          : Math.round((Date.now() / 1000 - bootTs) / 60);

        // Detect anomalies
        const anomalies: string[] = [];
        if (cpuStats.max > 90) {
          anomalies.push(`CPU spike to ${cpuStats.max.toFixed(1)}%`);
        }
        if (!cpuVals.length) {
          anomalies.push("CPU metric absent (no series returned)");
        }
        if (memStats.max > 90) {
          anomalies.push(`Memory peaked at ${memStats.max.toFixed(1)}%`);
        }
        if (memStats.min > 80) {
          anomalies.push(
            `Memory consistently high (min ${memStats.min.toFixed(1)}%)`,
          );
        }
        if (!memVals.length) {
          anomalies.push("Memory metric absent (no series returned)");
        }
        if (loadStats.max > 30) {
          anomalies.push(`Load spike to ${loadStats.max.toFixed(1)}`);
        }
        if (!loadVals.length) {
          anomalies.push("Load metric absent (no series returned)");
        }
        if (bootTs === null) {
          anomalies.push("Boot time unavailable");
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
          const name = r.metric?.name || "unknown";
          const vals = (r.values ?? []).map((v) => parseFloat(v[1])).filter((
            v,
          ) => v > 0);
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
            containers: containers.slice(0, Math.max(0, args.topN)),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
