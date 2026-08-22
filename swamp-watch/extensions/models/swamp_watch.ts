// @magistr/swamp-watch — makes a swamp repo's own scheduled work observable.
//
// The problem this exists for: swamp serve's scheduler is only observable in
// aggregate. "Did ANY scheduled workflow fire in the last 6h" is satisfied
// forever by one chatty two-minute workflow, so a workflow that dies — or was
// never deployed at all — produces no signal. Alerting on log TEXT does not fix
// it either: a rule that needs two identical failures inside 2h is structurally
// blind to every daily and weekly workflow.
//
// So this model publishes, per workflow, the two facts an alert actually needs:
//
//   intent   — what the repo DECLARES via `trigger.schedule`
//   reality  — when that workflow last actually SUCCEEDED
//
// and lets VictoriaMetrics hold them. Alerting is then one comparison per
// workflow rather than one aggregate for the whole scheduler.
//
// Two deliberate design points:
//
//   * Staleness budgets come from the LONGEST gap a cron can produce, not its
//     average. `0 9,20 * * *` fires twice daily but legally goes 13h between
//     fires; a budget built on 12h pages every single night.
//
//   * No last-success state is kept here. swamp's run history is retained for
//     roughly a day, so a weekly workflow's last success has already been
//     evicted by the time anyone asks. Instead every scan pushes what it can
//     see (0 when it sees nothing) and the ALERT reads it back through
//     `max_over_time(...[30d])` — the time-series database is the memory, which
//     also means a scan that stops running cannot erase what it already
//     reported.
//
// `workflow list` has no `--server` flag and `workflow get --server` omits the
// `trigger` field, so intent can only be read from a repo directory. That is
// why `scan` takes a repoDir even when history comes from a server, and why
// `drift` exists at all.

import { z } from "npm:zod@4";
import {
  type CommandRunner,
  defaultFs,
  defaultRunner,
  defaultSleep,
  type FsReader,
  isoToUnixSeconds,
  mapPool,
  maxGapSeconds,
  metricLine,
  readSchedulesFromDisk,
  type Sleeper,
  staleAfterSeconds,
  swampJson,
  SwampWatchError,
} from "./lib/cli.ts";

const GlobalArgsSchema = z.object({
  repoDir: z.string().default(".").describe(
    "Repository directory to read declared workflows from",
  ),
  repoLabel: z.string().default("local").describe(
    "Value of the `repo` label on every emitted series (e.g. mac, serve)",
  ),
  swampBinary: z.string().default("swamp").describe(
    "Path to the swamp CLI",
  ),
  server: z.string().optional().describe(
    "swamp serve URL to read run history from; omit to read the local repo",
  ),
  token: z.string().optional().describe(
    "Server token in <name>.<secret> form, used only with `server`",
  ),
  graceFactor: z.number().default(0.5).describe(
    "Extra staleness budget as a fraction of the schedule's longest gap",
  ),
  minGraceSeconds: z.number().default(1800).describe(
    "Floor on the extra staleness budget, in seconds",
  ),
  budgetOverrides: z.record(z.string(), z.number()).default({}).describe(
    "Per-workflow staleness budget in seconds, overriding the cron-derived one. For workflows whose failures are usually an upstream outage rather than a fault worth paging about.",
  ),
  timeoutMs: z.number().int().min(0).default(120000).describe(
    "Per-CLI-call timeout in milliseconds (0 disables)",
  ),
  concurrency: z.number().int().min(1).max(16).default(2).describe(
    "Concurrent server probes during drift; this server refuses auth well before a dozen",
  ),
  retryBackoffMs: z.number().int().min(0).default(1500).describe(
    "Pause before re-probing a workflow whose first probe failed for a non-404 reason",
  ),
});

const WorkflowStatSchema = z.object({
  workflow: z.string(),
  schedule: z.string(),
  expectedPeriodSeconds: z.number().nullable(),
  staleAfterSeconds: z.number().nullable(),
  lastSuccess: z.string().nullable(),
  lastRun: z.string().nullable(),
  lastStatus: z.string().nullable(),
  runs: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  other: z.number(),
  historyError: z.string().nullable(),
});

const ScanSchema = z.object({
  repo: z.string(),
  repoDir: z.string(),
  historySource: z.string(),
  scheduledCount: z.number(),
  unparsedSchedules: z.array(z.string()),
  workflows: z.array(WorkflowStatSchema),
  lines: z.string(),
  timestamp: z.string(),
});

const DriftSchema = z.object({
  repo: z.string(),
  repoDir: z.string(),
  server: z.string(),
  declaredCount: z.number(),
  presentCount: z.number(),
  missing: z.array(z.object({
    workflow: z.string(),
    schedule: z.string(),
  })),
  present: z.array(z.string()),
  errors: z.array(z.object({ workflow: z.string(), error: z.string() })),
  lines: z.string(),
  timestamp: z.string(),
});

// --- reading the repo and the run history ------------------------------------

/** A workflow name paired with the schedule its repo declares for it. */
interface DeclaredWorkflow {
  name: string;
  schedule: string;
}

/**
 * Every workflow in `repoDir` that declares a `trigger.schedule`.
 *
 * Always a LOCAL read: `swamp workflow list` accepts no `--server`, so a
 * server's declared schedules are simply not obtainable over the wire. Reading
 * the repo is the only way to learn what was supposed to run.
 */
export async function listDeclared(
  run: CommandRunner,
  binary: string,
  repoDir: string,
  timeoutMs: number,
  includeUnscheduled = false,
  fs: FsReader = defaultFs,
): Promise<DeclaredWorkflow[]> {
  const raw = await swampJson(
    run,
    binary,
    ["workflow", "list", "--repo-dir", repoDir, "--json"],
    { timeoutMs },
  );
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new SwampWatchError("workflow list returned no results array");
  }
  // Not every swamp build exposes `trigger` from the CLI — 20260815 returns it
  // from neither `list` nor `get`, while still reading the same files and
  // registering the schedules. Fall back to the definitions on disk so the scan
  // does not silently report a fully scheduled repo as having nothing to watch.
  const onDisk = await readSchedulesFromDisk(fs, repoDir);

  const out: DeclaredWorkflow[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { name?: unknown; trigger?: { schedule?: unknown } };
    if (typeof e.name !== "string" || e.name === "") continue;
    const schedule = typeof e.trigger?.schedule === "string"
      ? e.trigger.schedule
      : (onDisk.get(e.name) ?? "");
    if (schedule === "" && !includeUnscheduled) continue;
    out.push({ name: e.name, schedule });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The two fields of a swamp run record this model reads. */
interface RunRecord {
  startedAt: string;
  status: string;
}

/**
 * Run records for ONE workflow.
 *
 * Per-workflow rather than one global search on purpose: the global history
 * response is capped, and a two-minute workflow emits enough records to push
 * every daily and weekly run out of the window. Asking by name keeps the rare
 * schedules visible.
 */
export async function historyFor(
  run: CommandRunner,
  binary: string,
  workflow: string,
  opts: {
    repoDir: string;
    server?: string;
    token?: string;
    timeoutMs: number;
  },
): Promise<RunRecord[]> {
  const args = ["workflow", "history", "search", workflow];
  if (opts.server) {
    args.push("--server", opts.server);
    if (opts.token) args.push("--token", opts.token);
  } else {
    args.push("--repo-dir", opts.repoDir);
  }
  args.push("--json");
  const raw = await swampJson(run, binary, args, { timeoutMs: opts.timeoutMs });
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: RunRecord[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      startedAt?: unknown;
      status?: unknown;
      workflowName?: unknown;
    };
    if (typeof e.startedAt !== "string" || typeof e.status !== "string") {
      continue;
    }
    // The name filter is a server-side query, not a guarantee; drop anything
    // that came back for a different workflow rather than trusting it.
    if (typeof e.workflowName === "string" && e.workflowName !== workflow) {
      continue;
    }
    out.push({ startedAt: e.startedAt, status: e.status });
  }
  return out;
}

/** Fold one workflow's run records into the numbers the metrics need. */
export function summarise(
  workflow: string,
  schedule: string,
  records: RunRecord[],
  graceFactor: number,
  minGraceSeconds: number,
  historyError: string | null = null,
  budgetOverride: number | null = null,
): z.infer<typeof WorkflowStatSchema> {
  let period: number | null = null;
  try {
    period = schedule === "" ? null : maxGapSeconds(schedule);
  } catch {
    period = null;
  }
  let lastSuccess: string | null = null;
  let lastRun: string | null = null;
  let lastStatus: string | null = null;
  let succeeded = 0;
  let failed = 0;
  let other = 0;
  for (const r of records) {
    if (r.status === "succeeded") {
      succeeded++;
      if (lastSuccess === null || r.startedAt > lastSuccess) {
        lastSuccess = r.startedAt;
      }
    } else if (r.status === "failed") {
      failed++;
    } else {
      other++;
    }
    if (lastRun === null || r.startedAt > lastRun) {
      lastRun = r.startedAt;
      lastStatus = r.status;
    }
  }
  return {
    workflow,
    schedule,
    expectedPeriodSeconds: period,
    // An override wins over the cron-derived budget even when the schedule is
    // unparseable: the whole point is to say "do not page about this one yet".
    staleAfterSeconds: budgetOverride !== null
      ? Math.round(budgetOverride)
      : (period === null
        ? null
        : staleAfterSeconds(period, graceFactor, minGraceSeconds)),
    lastSuccess,
    lastRun,
    lastStatus,
    runs: records.length,
    succeeded,
    failed,
    other,
    historyError,
  };
}

/**
 * Render the exposition for a scan.
 *
 * A workflow with no observed success still gets a `last_success` line, valued
 * 0. Emitting nothing would leave the series absent, and an absent series
 * cannot be compared — the never-succeeded case, which is the one worth
 * catching, would be the one case that stayed silent.
 */
export function scanLines(
  repo: string,
  stats: ReadonlyArray<z.infer<typeof WorkflowStatSchema>>,
  scannedAt: number,
): string {
  const lines: string[] = [
    "# HELP swamp_workflow_declared Workflow declares a trigger.schedule in this repo",
    "# TYPE swamp_workflow_declared gauge",
  ];
  for (const s of stats) {
    lines.push(
      metricLine("swamp_workflow_declared", {
        workflow: s.workflow,
        repo,
        schedule: s.schedule,
      }, 1),
    );
  }
  lines.push(
    "# HELP swamp_workflow_expected_period_seconds Longest legal gap between two fires of the declared schedule",
    "# TYPE swamp_workflow_expected_period_seconds gauge",
  );
  for (const s of stats) {
    if (s.expectedPeriodSeconds === null) continue;
    lines.push(
      metricLine("swamp_workflow_expected_period_seconds", {
        workflow: s.workflow,
        repo,
      }, s.expectedPeriodSeconds),
    );
  }
  lines.push(
    "# HELP swamp_workflow_stale_after_seconds Age at which a missing success should alert",
    "# TYPE swamp_workflow_stale_after_seconds gauge",
  );
  for (const s of stats) {
    if (s.staleAfterSeconds === null) continue;
    lines.push(
      metricLine("swamp_workflow_stale_after_seconds", {
        workflow: s.workflow,
        repo,
      }, s.staleAfterSeconds),
    );
  }
  lines.push(
    "# HELP swamp_workflow_last_success_timestamp_seconds Unix time of the most recent successful run visible in run history (0 = none seen)",
    "# TYPE swamp_workflow_last_success_timestamp_seconds gauge",
  );
  for (const s of stats) {
    lines.push(
      metricLine("swamp_workflow_last_success_timestamp_seconds", {
        workflow: s.workflow,
        repo,
      }, isoToUnixSeconds(s.lastSuccess)),
    );
  }
  lines.push(
    "# HELP swamp_workflow_last_run_timestamp_seconds Unix time of the most recent run of any status (0 = none seen)",
    "# TYPE swamp_workflow_last_run_timestamp_seconds gauge",
  );
  for (const s of stats) {
    lines.push(
      metricLine("swamp_workflow_last_run_timestamp_seconds", {
        workflow: s.workflow,
        repo,
      }, isoToUnixSeconds(s.lastRun)),
    );
  }
  lines.push(
    "# HELP swamp_workflow_runs Runs of each status visible in the retained run history",
    "# TYPE swamp_workflow_runs gauge",
  );
  for (const s of stats) {
    lines.push(
      metricLine("swamp_workflow_runs", {
        workflow: s.workflow,
        repo,
        status: "succeeded",
      }, s.succeeded),
    );
    lines.push(
      metricLine("swamp_workflow_runs", {
        workflow: s.workflow,
        repo,
        status: "failed",
      }, s.failed),
    );
  }
  lines.push(
    "# HELP swamp_watch_observed_timestamp_seconds Unix time swamp-watch last observed this workflow declaring a schedule",
    "# TYPE swamp_watch_observed_timestamp_seconds gauge",
  );
  for (const s of stats) {
    lines.push(
      metricLine("swamp_watch_observed_timestamp_seconds", {
        workflow: s.workflow,
        repo,
      }, scannedAt),
    );
  }
  lines.push(
    "# HELP swamp_watch_scan_timestamp_seconds Unix time this scan completed",
    "# TYPE swamp_watch_scan_timestamp_seconds gauge",
    metricLine("swamp_watch_scan_timestamp_seconds", { repo }, scannedAt),
    "# HELP swamp_watch_scan_workflows Scheduled workflows seen by this scan",
    "# TYPE swamp_watch_scan_workflows gauge",
    metricLine("swamp_watch_scan_workflows", { repo }, stats.length),
  );
  return lines.join("\n") + "\n";
}

/** Render the exposition for a drift probe. */
export function driftLines(
  repo: string,
  server: string,
  present: ReadonlyArray<string>,
  missing: ReadonlyArray<{ workflow: string; schedule: string }>,
  scannedAt: number,
): string {
  const lines: string[] = [
    "# HELP swamp_workflow_present_on_server Declared workflow is known to the server (1) or absent from it (0)",
    "# TYPE swamp_workflow_present_on_server gauge",
  ];
  for (const w of present) {
    lines.push(
      metricLine("swamp_workflow_present_on_server", {
        workflow: w,
        repo,
        server,
      }, 1),
    );
  }
  for (const m of missing) {
    lines.push(
      metricLine("swamp_workflow_present_on_server", {
        workflow: m.workflow,
        repo,
        server,
        schedule: m.schedule,
      }, 0),
    );
  }
  lines.push(
    "# HELP swamp_watch_drift_timestamp_seconds Unix time this drift probe completed",
    "# TYPE swamp_watch_drift_timestamp_seconds gauge",
    metricLine(
      "swamp_watch_drift_timestamp_seconds",
      { repo, server },
      scannedAt,
    ),
    "# HELP swamp_watch_drift_missing Declared workflows the server does not have",
    "# TYPE swamp_watch_drift_missing gauge",
    metricLine("swamp_watch_drift_missing", { repo, server }, missing.length),
  );
  return lines.join("\n") + "\n";
}

// --- method implementations --------------------------------------------------

/** The slice of swamp method context this model uses. */
interface Ctx {
  globalArgs: Record<string, unknown>;
  writeResource: (
    spec: string,
    instance: string,
    attrs: unknown,
  ) => Promise<unknown>;
}

/**
 * `scan` implementation: read intent and reality for one repo in a single
 * execution, write the `scan` resource, and return it.
 */
export async function runScan(
  run: CommandRunner,
  args: { includeUnscheduled?: boolean },
  context: Ctx,
) {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const declared = await listDeclared(
    run,
    g.swampBinary,
    g.repoDir,
    g.timeoutMs,
    args.includeUnscheduled ?? false,
  );

  const stats: z.infer<typeof WorkflowStatSchema>[] = [];
  const unparsed: string[] = [];
  for (const d of declared) {
    let records: RunRecord[] = [];
    let historyError: string | null = null;
    try {
      records = await historyFor(run, g.swampBinary, d.name, {
        repoDir: g.repoDir,
        server: g.server,
        token: g.token,
        timeoutMs: g.timeoutMs,
      });
    } catch (err) {
      // A history read that fails must not erase the workflow from the scan —
      // dropping it would take its series with it and silence the very alert
      // this model exists to raise.
      historyError = err instanceof Error ? err.message : String(err);
    }
    const s = summarise(
      d.name,
      d.schedule,
      records,
      g.graceFactor,
      g.minGraceSeconds,
      historyError,
      g.budgetOverrides[d.name] ?? null,
    );
    if (d.schedule !== "" && s.expectedPeriodSeconds === null) {
      unparsed.push(`${d.name}: ${d.schedule}`);
    }
    stats.push(s);
  }

  const now = new Date();
  const scannedAt = Math.floor(now.getTime() / 1000);
  const attrs = {
    repo: g.repoLabel,
    repoDir: g.repoDir,
    historySource: g.server ?? `local:${g.repoDir}`,
    scheduledCount: stats.length,
    unparsedSchedules: unparsed,
    workflows: stats,
    lines: scanLines(g.repoLabel, stats, scannedAt),
    timestamp: now.toISOString(),
  };
  await context.writeResource("scan", "scan-current", attrs);
  return attrs;
}

/**
 * `drift` implementation: probe the configured server once per declared
 * workflow, write the `drift` resource, and return it.
 */
export async function runDrift(
  run: CommandRunner,
  _args: Record<string, never>,
  context: Ctx,
  sleep: Sleeper = defaultSleep,
) {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  if (!g.server) {
    throw new SwampWatchError(
      "drift needs the `server` global argument — there is nothing to compare the repo against",
    );
  }
  const declared = await listDeclared(
    run,
    g.swampBinary,
    g.repoDir,
    g.timeoutMs,
    true,
  );
  const probeOnce = async (d: DeclaredWorkflow) => {
    const args = ["workflow", "get", d.name, "--server", g.server!];
    if (g.token) args.push("--token", g.token);
    args.push("--json");
    await swampJson(run, g.swampBinary, args, { timeoutMs: g.timeoutMs });
  };

  const probes = await mapPool(declared, g.concurrency, async (d) => {
    let lastText = "";
    // One retry: this server intermittently refuses auth under even modest
    // concurrency, and a refused probe must not leave a hole in the drift
    // picture. A genuinely missing workflow fails identically both times.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(g.retryBackoffMs);
      try {
        await probeOnce(d);
        return { d, outcome: "present" as const, error: "" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const detail = err instanceof SwampWatchError ? (err.detail ?? "") : "";
        lastText = (msg + " " + detail).trim();
        // Only "not found" is drift. Auth failures and timeouts are the PROBE
        // breaking; reporting those as a missing workflow would manufacture a
        // deploy-drift alert out of a flaky connection.
        if (/not found/i.test(lastText)) {
          return { d, outcome: "missing" as const, error: lastText };
        }
      }
    }
    return { d, outcome: "error" as const, error: lastText };
  });

  const present: string[] = [];
  const missing: { workflow: string; schedule: string }[] = [];
  const errors: { workflow: string; error: string }[] = [];
  for (const p of probes) {
    if (p.outcome === "present") present.push(p.d.name);
    else if (p.outcome === "missing") {
      missing.push({ workflow: p.d.name, schedule: p.d.schedule });
    } else errors.push({ workflow: p.d.name, error: p.error });
  }
  const now = new Date();
  const attrs = {
    repo: g.repoLabel,
    repoDir: g.repoDir,
    server: g.server,
    declaredCount: declared.length,
    presentCount: present.length,
    missing,
    present,
    errors,
    lines: driftLines(
      g.repoLabel,
      g.server,
      present,
      missing,
      Math.floor(now.getTime() / 1000),
    ),
    timestamp: now.toISOString(),
  };
  await context.writeResource("drift", "drift-current", attrs);
  return attrs;
}

// --- model -------------------------------------------------------------------

/** The `@magistr/swamp-watch` model definition swamp loads at startup. */
export const model = {
  type: "@magistr/swamp-watch",
  version: "2026.08.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "scan": {
      description:
        "Per-workflow declared schedule and last-success state, with Prometheus exposition",
      schema: ScanSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "drift": {
      description:
        "Which declared workflows the server actually has, with Prometheus exposition",
      schema: DriftSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "scan": {
      description:
        "Read every workflow that declares a trigger.schedule and its run history in one execution, then emit per-workflow freshness metrics (expected period, staleness budget, last success) as Prometheus exposition for `@magistr/victoriametrics` push.",
      arguments: z.object({
        includeUnscheduled: z.boolean().default(false).describe(
          "Also report workflows with no trigger.schedule",
        ),
      }),
      execute: (args: { includeUnscheduled?: boolean }, context: Ctx) =>
        runScan(defaultRunner, args, context),
    },
    "drift": {
      description:
        "Probe the configured server for every workflow this repo declares and emit which are present and which are missing. Catches a workflow that carries a schedule locally but was never deployed, which no scheduler-side check can see.",
      arguments: z.object({}),
      execute: (args: Record<string, never>, context: Ctx) =>
        runDrift(defaultRunner, args, context, defaultSleep),
    },
  },
};
