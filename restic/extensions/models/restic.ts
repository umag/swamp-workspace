import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Process runner (injected so methods are testable without spawning restic)
// ---------------------------------------------------------------------------

/** Result of one restic process invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawns `bin args` with `env` merged over the parent environment. */
export type CommandRunner = (
  bin: string,
  args: string[],
  env: Record<string, string>,
) => Promise<RunResult>;

/** Default runner: real `Deno.Command`. */
export const defaultRunner: CommandRunner = async (bin, args, env) => {
  const out = await new Deno.Command(bin, {
    args,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

/** restic exit codes (restic >= 0.17). */
export const EXIT = {
  ok: 0,
  fatal: 1,
  incomplete: 3,
  noRepository: 10,
  lockFailed: 11,
  wrongPassword: 12,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Global arguments shared by every method. */
export const GlobalArgsSchema = z.object({
  repository: z.string().min(1).describe(
    "restic repository URL, e.g. rest:http://backup.example.lan:8000/laptop/",
  ),
  password: z.string().min(1).meta({ sensitive: true }).describe(
    "Repository encryption password (RESTIC_PASSWORD)",
  ),
  restUsername: z.string().optional().describe(
    "rest-server HTTP basic-auth user (RESTIC_REST_USERNAME)",
  ),
  restPassword: z.string().optional().meta({ sensitive: true }).describe(
    "rest-server HTTP basic-auth password (RESTIC_REST_PASSWORD)",
  ),
  paths: z.array(z.string()).default([]).describe(
    "Default paths to back up",
  ),
  excludes: z.array(z.string()).default([]).describe(
    "Exclude patterns passed as --exclude",
  ),
  excludeCaches: z.boolean().default(true).describe(
    "Skip directories holding a CACHEDIR.TAG",
  ),
  hostname: z.string().optional().describe(
    "Override the host name recorded in snapshots",
  ),
  tags: z.array(z.string()).default([]).describe(
    "Tags added to every backup snapshot",
  ),
  binary: z.string().default("restic").describe("restic executable"),
  cacheDir: z.string().optional().describe("Override --cache-dir"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SnapshotSummarySchema = z.object({
  id: z.string(),
  shortId: z.string(),
  time: z.string(),
  hostname: z.string(),
  paths: z.array(z.string()),
  tags: z.array(z.string()),
});

/** `status` output: is the repository there, and what is the newest snapshot. */
export const RepoStatusSchema = z.object({
  repository: z.string(),
  reachable: z.boolean(),
  initialized: z.boolean(),
  repoId: z.string().nullable(),
  snapshotCount: z.number(),
  latestSnapshot: SnapshotSummarySchema.nullable(),
  latestAgeHours: z.number().nullable(),
  error: z.string().nullable(),
  timestamp: z.string(),
});

/** `init` output. */
export const InitResultSchema = z.object({
  repository: z.string(),
  action: z.enum(["created", "already-initialized"]),
  repoId: z.string(),
  timestamp: z.string(),
});

/** `backup` output: restic's summary message plus collected file errors. */
export const BackupSummarySchema = z.object({
  repository: z.string(),
  paths: z.array(z.string()),
  dryRun: z.boolean(),
  complete: z.boolean(),
  snapshotId: z.string().nullable(),
  filesNew: z.number(),
  filesChanged: z.number(),
  filesUnmodified: z.number(),
  dataAdded: z.number(),
  dataAddedPacked: z.number(),
  totalFilesProcessed: z.number(),
  totalBytesProcessed: z.number(),
  durationSeconds: z.number(),
  errorCount: z.number(),
  errors: z.array(z.object({ item: z.string(), message: z.string() })),
  timestamp: z.string(),
});

/** `snapshots` output. */
export const SnapshotListSchema = z.object({
  repository: z.string(),
  count: z.number(),
  snapshots: z.array(SnapshotSummarySchema),
  timestamp: z.string(),
});

/** `check` output. */
export const CheckResultSchema = z.object({
  repository: z.string(),
  ok: z.boolean(),
  readData: z.string().nullable(),
  numErrors: z.number(),
  suggestRepairIndex: z.boolean(),
  suggestPrune: z.boolean(),
  errors: z.array(z.string()),
  timestamp: z.string(),
});

/** `forget` output. */
export const ForgetResultSchema = z.object({
  repository: z.string(),
  dryRun: z.boolean(),
  prune: z.boolean(),
  policy: z.record(z.string(), z.union([z.number(), z.string()])),
  kept: z.number(),
  removed: z.number(),
  removedIds: z.array(z.string()),
  timestamp: z.string(),
});

/** `stats` output. */
export const StatsResultSchema = z.object({
  repository: z.string(),
  mode: z.string(),
  totalSize: z.number(),
  totalUncompressedSize: z.number().nullable(),
  compressionRatio: z.number().nullable(),
  totalBlobCount: z.number().nullable(),
  snapshotsCount: z.number(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Environment for restic: secrets go via env, never argv. */
export function resticEnv(g: GlobalArgs): Record<string, string> {
  const env: Record<string, string> = {
    RESTIC_REPOSITORY: g.repository,
    RESTIC_PASSWORD: g.password,
  };
  if (g.restUsername) env.RESTIC_REST_USERNAME = g.restUsername;
  if (g.restPassword) env.RESTIC_REST_PASSWORD = g.restPassword;
  return env;
}

/** Replace every secret value in `text` with `***`. */
export function redact(text: string, g: GlobalArgs): string {
  let out = text;
  for (const s of [g.password, g.restPassword]) {
    if (s && s.length >= 3) out = out.split(s).join("***");
  }
  return out;
}

function commonFlags(g: GlobalArgs): string[] {
  return g.cacheDir ? ["--cache-dir", g.cacheDir] : [];
}

/** Parse restic `--json` line output; non-JSON lines are ignored. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // progress fragments are not always whole JSON objects
    }
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function describeExit(code: number): string {
  switch (code) {
    case EXIT.noRepository:
      return "repository does not exist (run init)";
    case EXIT.lockFailed:
      return "repository is locked by another process";
    case EXIT.wrongPassword:
      return "wrong repository password";
    default:
      return `restic exited with code ${code}`;
  }
}

/** Run restic; throw a redacted, named error on any exit not in `allow`. */
export async function restic(
  run: CommandRunner,
  g: GlobalArgs,
  args: string[],
  allow: number[] = [EXIT.ok],
): Promise<RunResult> {
  let res: RunResult;
  try {
    res = await run(g.binary, [...commonFlags(g), ...args], resticEnv(g));
  } catch (e) {
    throw new Error(
      `failed to start ${g.binary}: ${
        redact(e instanceof Error ? e.message : String(e), g)
      }`,
    );
  }
  if (!allow.includes(res.code)) {
    const tail = redact(res.stderr.trim().split("\n").slice(-5).join("\n"), g);
    throw new Error(
      `restic ${args[0]}: ${describeExit(res.code)}${tail ? `\n${tail}` : ""}`,
    );
  }
  return res;
}

interface RawSnapshot {
  id?: string;
  short_id?: string;
  time?: string;
  hostname?: string;
  paths?: string[];
  tags?: string[] | null;
}

function toSummary(s: RawSnapshot): z.infer<typeof SnapshotSummarySchema> {
  const id = s.id ?? "";
  return {
    id,
    shortId: s.short_id ?? id.slice(0, 8),
    time: s.time ?? "",
    hostname: s.hostname ?? "",
    paths: s.paths ?? [],
    tags: s.tags ?? [],
  };
}

function parseSnapshots(stdout: string): z.infer<
  typeof SnapshotSummarySchema
>[] {
  const t = stdout.trim();
  if (!t) return [];
  const raw = JSON.parse(t) as RawSnapshot[] | null;
  return (raw ?? []).map(toSummary).sort((a, b) =>
    a.time.localeCompare(b.time)
  );
}

function now(): string {
  return new Date().toISOString();
}

/** Minimal slice of the swamp method context this model uses. */
export interface Ctx {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Method implementations
// ---------------------------------------------------------------------------

/** Read repository state without changing anything. */
export async function statusImpl(run: CommandRunner, ctx: Ctx) {
  const g = ctx.globalArgs;
  const base = { repository: g.repository, timestamp: now() };
  const cfg = await restic(run, g, ["cat", "config", "--json"], [
    EXIT.ok,
    EXIT.noRepository,
    EXIT.fatal,
  ]);
  let data: z.infer<typeof RepoStatusSchema>;
  if (cfg.code === EXIT.noRepository) {
    data = {
      ...base,
      reachable: true,
      initialized: false,
      repoId: null,
      snapshotCount: 0,
      latestSnapshot: null,
      latestAgeHours: null,
      error: null,
    };
  } else if (cfg.code !== EXIT.ok) {
    data = {
      ...base,
      reachable: false,
      initialized: false,
      repoId: null,
      snapshotCount: 0,
      latestSnapshot: null,
      latestAgeHours: null,
      error: redact(cfg.stderr.trim().split("\n").slice(-3).join("\n"), g),
    };
  } else {
    const repoId = String(JSON.parse(cfg.stdout).id ?? "");
    const snaps = parseSnapshots(
      (await restic(run, g, ["snapshots", "--json", "--no-lock"])).stdout,
    );
    const latest = snaps.at(-1) ?? null;
    data = {
      ...base,
      reachable: true,
      initialized: true,
      repoId,
      snapshotCount: snaps.length,
      latestSnapshot: latest,
      latestAgeHours: latest
        ? Math.round(
          (Date.now() - Date.parse(latest.time)) / 36_000,
        ) / 100
        : null,
      error: null,
    };
  }
  return await ctx.writeResource("repoStatus", "status", data);
}

/** Create the repository if absent; no-op if it already exists. */
export async function initImpl(run: CommandRunner, ctx: Ctx) {
  const g = ctx.globalArgs;
  const cfg = await restic(run, g, ["cat", "config", "--json"], [
    EXIT.ok,
    EXIT.noRepository,
  ]);
  let action: "created" | "already-initialized";
  let repoId: string;
  if (cfg.code === EXIT.ok) {
    action = "already-initialized";
    repoId = String(JSON.parse(cfg.stdout).id ?? "");
  } else {
    const res = await restic(run, g, ["init", "--json"]);
    const msg = jsonLines(res.stdout).find((m) =>
      m.message_type === "initialized"
    );
    action = "created";
    repoId = String(msg?.id ?? "");
  }
  return await ctx.writeResource("initResult", "init", {
    repository: g.repository,
    action,
    repoId,
    timestamp: now(),
  });
}

/** Arguments for `backup`. */
export const BackupArgs = z.object({
  paths: z.array(z.string()).optional().describe(
    "Paths to back up (default: globalArguments.paths)",
  ),
  tags: z.array(z.string()).optional().describe("Extra snapshot tags"),
  dryRun: z.boolean().default(false).describe("Pass --dry-run"),
  maxErrors: z.number().int().min(0).default(50).describe(
    "Max file errors to record",
  ),
});

/** Back up paths; exit 3 (some files unreadable) is recorded, not thrown. */
export async function backupImpl(
  run: CommandRunner,
  args: z.infer<typeof BackupArgs>,
  ctx: Ctx,
) {
  const g = ctx.globalArgs;
  const paths = args.paths?.length ? args.paths : g.paths;
  if (!paths.length) {
    throw new Error("backup: no paths (set globalArguments.paths or --input)");
  }
  const flags = ["backup", "--json"];
  if (g.excludeCaches) flags.push("--exclude-caches");
  for (const e of g.excludes) flags.push("--exclude", e);
  if (g.hostname) flags.push("--host", g.hostname);
  for (const t of [...g.tags, ...(args.tags ?? [])]) flags.push("--tag", t);
  if (args.dryRun) flags.push("--dry-run");
  flags.push("--", ...paths);

  const res = await restic(run, g, flags, [EXIT.ok, EXIT.incomplete]);
  const msgs = jsonLines(res.stdout);
  const summary = msgs.find((m) => m.message_type === "summary");
  if (!summary) {
    throw new Error("restic backup: no summary message in output");
  }
  const errMsgs = [
    ...msgs.filter((m) => m.message_type === "error"),
    ...jsonLines(res.stderr).filter((m) => m.message_type === "error"),
  ];
  const errors = errMsgs.slice(0, args.maxErrors).map((m) => ({
    item: String(m.item ?? ""),
    message: redact(
      String((m.error as { message?: string })?.message ?? m.error ?? ""),
      g,
    ),
  }));
  return await ctx.writeResource("backupSummary", "backup", {
    repository: g.repository,
    paths,
    dryRun: args.dryRun,
    complete: res.code === EXIT.ok,
    snapshotId: typeof summary.snapshot_id === "string"
      ? summary.snapshot_id
      : null,
    filesNew: num(summary.files_new),
    filesChanged: num(summary.files_changed),
    filesUnmodified: num(summary.files_unmodified),
    dataAdded: num(summary.data_added),
    dataAddedPacked: num(summary.data_added_packed),
    totalFilesProcessed: num(summary.total_files_processed),
    totalBytesProcessed: num(summary.total_bytes_processed),
    durationSeconds: num(summary.total_duration),
    errorCount: errMsgs.length,
    errors,
    timestamp: now(),
  });
}

/** Arguments for `snapshots`. */
export const SnapshotsArgs = z.object({
  host: z.string().optional().describe("Only snapshots from this host"),
  tag: z.string().optional().describe("Only snapshots with this tag"),
  latest: z.number().int().min(1).optional().describe(
    "Only the newest N per host/path group",
  ),
});

/** List snapshots (lock-free read). */
export async function snapshotsImpl(
  run: CommandRunner,
  args: z.infer<typeof SnapshotsArgs>,
  ctx: Ctx,
) {
  const g = ctx.globalArgs;
  const flags = ["snapshots", "--json", "--no-lock"];
  if (args.host) flags.push("--host", args.host);
  if (args.tag) flags.push("--tag", args.tag);
  if (args.latest) flags.push("--latest", String(args.latest));
  const snaps = parseSnapshots((await restic(run, g, flags)).stdout);
  return await ctx.writeResource("snapshotList", "snapshots", {
    repository: g.repository,
    count: snaps.length,
    snapshots: snaps,
    timestamp: now(),
  });
}

/** Arguments for `check`. */
export const CheckArgs = z.object({
  readDataSubset: z.string().regex(/^(\d+(\.\d+)?%|\d+\/\d+|\d+[KMGT]?)$/)
    .optional().describe(
      "Also read and verify pack data, e.g. '5%', '1/10', '2G'",
    ),
});

/** Verify repository integrity; a failed check is data, not an exception. */
export async function checkImpl(
  run: CommandRunner,
  args: z.infer<typeof CheckArgs>,
  ctx: Ctx,
) {
  const g = ctx.globalArgs;
  const flags = ["check", "--json"];
  if (args.readDataSubset) {
    flags.push(`--read-data-subset=${args.readDataSubset}`);
  }
  const res = await restic(run, g, flags, [EXIT.ok, EXIT.fatal]);
  const msgs = jsonLines(res.stdout);
  const summary = msgs.find((m) => m.message_type === "summary") ?? {};
  const errors = [
    ...msgs.filter((m) => m.message_type === "error"),
    ...jsonLines(res.stderr).filter((m) => m.message_type === "error"),
  ].map((m) =>
    redact(
      String((m.error as { message?: string })?.message ?? m.message ?? ""),
      g,
    )
  );
  if (res.code !== EXIT.ok && errors.length === 0) {
    errors.push(redact(res.stderr.trim().split("\n").slice(-5).join("\n"), g));
  }
  const numErrors = Math.max(num(summary.num_errors), errors.length);
  return await ctx.writeResource("checkResult", "check", {
    repository: g.repository,
    ok: res.code === EXIT.ok && numErrors === 0,
    readData: args.readDataSubset ?? null,
    numErrors,
    suggestRepairIndex: summary.suggest_repair_index === true,
    suggestPrune: summary.suggest_prune === true,
    errors: errors.slice(0, 50),
    timestamp: now(),
  });
}

/** Arguments for `forget`. */
export const ForgetArgs = z.object({
  keepLast: z.number().int().min(1).optional(),
  keepHourly: z.number().int().min(1).optional(),
  keepDaily: z.number().int().min(1).optional(),
  keepWeekly: z.number().int().min(1).optional(),
  keepMonthly: z.number().int().min(1).optional(),
  keepYearly: z.number().int().min(1).optional(),
  keepWithin: z.string().regex(/^(\d+[yMdh])+$/).optional().describe(
    "e.g. '30d', '1y6M'",
  ),
  prune: z.boolean().default(false).describe("Also prune unreferenced data"),
  dryRun: z.boolean().default(true).describe(
    "Only report what would be removed (default true)",
  ),
});

const POLICY_FLAGS: Record<string, string> = {
  keepLast: "--keep-last",
  keepHourly: "--keep-hourly",
  keepDaily: "--keep-daily",
  keepWeekly: "--keep-weekly",
  keepMonthly: "--keep-monthly",
  keepYearly: "--keep-yearly",
  keepWithin: "--keep-within",
};

/** Apply a retention policy. Refuses to run without at least one keep rule. */
export async function forgetImpl(
  run: CommandRunner,
  args: z.infer<typeof ForgetArgs>,
  ctx: Ctx,
) {
  const g = ctx.globalArgs;
  const policy: Record<string, number | string> = {};
  const flags = ["forget", "--json"];
  for (const [k, flag] of Object.entries(POLICY_FLAGS)) {
    const v = (args as Record<string, unknown>)[k];
    if (v === undefined) continue;
    policy[k] = v as number | string;
    flags.push(flag, String(v));
  }
  if (Object.keys(policy).length === 0) {
    throw new Error("forget: refusing to run without a keep policy");
  }
  if (g.hostname) flags.push("--host", g.hostname);
  if (args.prune) flags.push("--prune");
  if (args.dryRun) flags.push("--dry-run");
  const res = await restic(run, g, flags);
  const first = res.stdout.split("\n").find((l) => l.trim().startsWith("["));
  const groups = first
    ? JSON.parse(first) as { keep?: RawSnapshot[]; remove?: RawSnapshot[] }[]
    : [];
  const removed = groups.flatMap((gr) => gr.remove ?? []);
  return await ctx.writeResource("forgetResult", "forget", {
    repository: g.repository,
    dryRun: args.dryRun,
    prune: args.prune,
    policy,
    kept: groups.reduce((n, gr) => n + (gr.keep?.length ?? 0), 0),
    removed: removed.length,
    removedIds: removed.map((s) => s.id ?? ""),
    timestamp: now(),
  });
}

/** Arguments for `stats`. */
export const StatsArgs = z.object({
  mode: z.enum([
    "raw-data",
    "restore-size",
    "files-by-contents",
    "blobs-per-file",
  ])
    .default("raw-data"),
});

/** Repository size statistics. */
export async function statsImpl(
  run: CommandRunner,
  args: z.infer<typeof StatsArgs>,
  ctx: Ctx,
) {
  const g = ctx.globalArgs;
  const res = await restic(run, g, [
    "stats",
    "--json",
    "--no-lock",
    "--mode",
    args.mode,
  ]);
  const s = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  const opt = (v: unknown) => typeof v === "number" ? v : null;
  return await ctx.writeResource("statsResult", "stats", {
    repository: g.repository,
    mode: args.mode,
    totalSize: num(s.total_size),
    totalUncompressedSize: opt(s.total_uncompressed_size),
    compressionRatio: opt(s.compression_ratio),
    totalBlobCount: opt(s.total_blob_count),
    snapshotsCount: num(s.snapshots_count),
    timestamp: now(),
  });
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const res = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 30,
});

/**
 * restic backup repository model: status, init, backup, snapshots, check,
 * forget and stats against any restic backend (rest-server, local, S3, …).
 * Secrets reach restic only through environment variables and are redacted
 * from every error message.
 */
export const model = {
  type: "@magistr/restic",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    repoStatus: res(
      "Repository reachability and newest snapshot",
      RepoStatusSchema,
    ),
    initResult: res(
      "Result of init (created or already present)",
      InitResultSchema,
    ),
    backupSummary: res("Summary of the last backup run", BackupSummarySchema),
    snapshotList: res("Snapshot listing", SnapshotListSchema),
    checkResult: res("Result of the last integrity check", CheckResultSchema),
    forgetResult: res("Result of the last forget/prune", ForgetResultSchema),
    statsResult: res("Repository size statistics", StatsResultSchema),
  },
  methods: {
    status: {
      description:
        "Read repository state (initialized, snapshot count, newest snapshot age) without modifying it",
      arguments: z.object({}),
      execute: async (_args, context) => ({
        dataHandles: [await statusImpl(defaultRunner, context)],
      }),
    },
    init: {
      description: "Initialize the repository; no-op when it already exists",
      arguments: z.object({}),
      execute: async (_args, context) => ({
        dataHandles: [await initImpl(defaultRunner, context)],
      }),
    },
    backup: {
      description:
        "Back up paths; records the restic summary and any unreadable files",
      arguments: BackupArgs,
      execute: async (args, context) => ({
        dataHandles: [await backupImpl(defaultRunner, args, context)],
      }),
    },
    snapshots: {
      description: "List snapshots, optionally filtered by host/tag/latest",
      arguments: SnapshotsArgs,
      execute: async (args, context) => ({
        dataHandles: [await snapshotsImpl(defaultRunner, args, context)],
      }),
    },
    check: {
      description:
        "Verify repository integrity, optionally reading a subset of pack data",
      arguments: CheckArgs,
      execute: async (args, context) => ({
        dataHandles: [await checkImpl(defaultRunner, args, context)],
      }),
    },
    forget: {
      description:
        "Apply a keep policy (dry-run by default); optionally prune. Fails against an append-only rest-server",
      arguments: ForgetArgs,
      execute: async (args, context) => ({
        dataHandles: [await forgetImpl(defaultRunner, args, context)],
      }),
    },
    stats: {
      description: "Repository size and compression statistics",
      arguments: StatsArgs,
      execute: async (args, context) => ({
        dataHandles: [await statsImpl(defaultRunner, args, context)],
      }),
    },
  },
};
