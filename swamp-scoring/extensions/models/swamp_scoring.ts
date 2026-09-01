/**
 * Swamp Club scoring tracker — scrapes user profiles and leaderboard,
 * compares users, tracks scoring deltas, reports top operations.
 *
 * @module
 */
import { z } from "npm:zod@4";

const DEFAULT_BASE_URL = "https://swamp-club.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const UserEntrySchema = z.object({
  username: z.string().describe("Swamp Club username to track"),
});

const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .default(DEFAULT_BASE_URL)
    .describe("Swamp Club base URL"),
  users: z
    .array(UserEntrySchema)
    .describe("Users to track"),
  telegramModel: z
    .string()
    .optional()
    .describe(
      "Instance name of a @magistr/telegram/send model for alerts (e.g. tg-bot)",
    ),
  telegramChatId: z
    .string()
    .optional()
    .describe("Telegram chat ID for alert messages"),
  serveUrl: z
    .string()
    .optional()
    .describe(
      "Swamp serve URL for bench serve/worker tests (e.g. https://swamp-fleet.aopab.art)",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ActivityEntrySchema = z.object({
  operation: z.string(),
  quantity: z.number(),
  multiplier: z.number(),
  points: z.number(),
  timestamp: z.string(),
});

const UserSnapshotSchema = z.object({
  username: z.string(),
  totalPoints: z.number(),
  tier: z.number(),
  maxTier: z.number(),
  rank: z.string(),
  activeDays: z.number(),
  totalEvents: z.number(),
  extensionsShipped: z.number(),
  issuesFiled: z.number(),
  scrapedAt: z.string(),
});

const ActivityBreakdownSchema = z.object({
  username: z.string(),
  entries: z.array(ActivityEntrySchema),
  totalPoints: z.number(),
  totalEvents: z.number(),
  activeDays: z.number(),
  scrapedAt: z.string(),
});

const LeaderboardEntrySchema = z.object({
  rank: z.number(),
  username: z.string(),
  badge: z.string(),
  score: z.number(),
  events: z.number(),
});

const LeaderboardSchema = z.object({
  board: z.string(),
  entries: z.array(LeaderboardEntrySchema),
  scrapedAt: z.string(),
});

const ComparisonSchema = z.object({
  users: z.array(
    z.object({
      username: z.string(),
      totalPoints: z.number(),
      activeDays: z.number(),
      totalEvents: z.number(),
      pointsPerDay: z.number(),
      eventsPerDay: z.number(),
      tier: z.number(),
      rank: z.string(),
    }),
  ),
  leader: z.string(),
  gap: z.number(),
  comparedAt: z.string(),
});

const DeltaSchema = z.object({
  username: z.string(),
  previousPoints: z.number(),
  currentPoints: z.number(),
  delta: z.number(),
  previousEvents: z.number(),
  currentEvents: z.number(),
  eventsDelta: z.number(),
  periodHours: z.number(),
  measuredAt: z.string(),
});

const DeltaReportSchema = z.object({
  deltas: z.array(DeltaSchema),
  reportedAt: z.string(),
});

const TopOpsSchema = z.object({
  username: z.string(),
  operations: z.array(
    z.object({
      operation: z.string(),
      totalPoints: z.number(),
      totalQuantity: z.number(),
      avgPointsPerOp: z.number(),
    }),
  ),
  scrapedAt: z.string(),
});

const ActionRateSchema = z.object({
  action: z.string(),
  source: z.string(),
  basePoints: z.number(),
  multiplier: z.number(),
  pointsPerUnit: z.number(),
  occurrences: z.number(),
  totalQuantity: z.number(),
  totalPoints: z.number(),
});

const RateCardSchema = z.object({
  username: z.string(),
  actions: z.array(ActionRateSchema),
  activeMultiplier: z.number(),
  totalPoints: z.number(),
  scrapedAt: z.string(),
});

const RateDeltaSchema = z.object({
  username: z.string(),
  changes: z.array(
    z.object({
      action: z.string(),
      previousBase: z.number(),
      currentBase: z.number(),
      previousMultiplier: z.number(),
      currentMultiplier: z.number(),
      baseDelta: z.number(),
      multiplierDelta: z.number(),
    }),
  ),
  newActions: z.array(z.string()),
  measuredAt: z.string(),
});

const BenchResultSchema = z.object({
  action: z.string(),
  run: z.number(),
  points: z.number(),
  basePoints: z.number(),
  multiplier: z.number(),
  quantity: z.number(),
});

const BenchReportSchema = z.object({
  username: z.string(),
  results: z.array(BenchResultSchema),
  summary: z.array(
    z.object({
      action: z.string(),
      runs: z.number(),
      firstBase: z.number(),
      lastBase: z.number(),
      avgBase: z.number(),
      diminishing: z.boolean(),
    }),
  ),
  repoPath: z.string(),
  scrapedAt: z.string(),
});

// ---------------------------------------------------------------------------
// HTML scraping helpers
// ---------------------------------------------------------------------------

async function fetchPage(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": DEFAULT_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  return resp.text();
}

function extractNumber(text: string): number {
  const cleaned = text.replace(/[,\s]/g, "");
  const m = cleaned.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// Scraping: user profile
// ---------------------------------------------------------------------------

interface ParsedProfile {
  username: string;
  totalPoints: number;
  tier: number;
  maxTier: number;
  rank: string;
  activeDays: number;
  totalEvents: number;
  extensionsShipped: number;
  issuesFiled: number;
}

function parseProfilePage(html: string, username: string): ParsedProfile {
  // Meta description: "magistr on Swamp Club. Bog Keeper · 6,054,132 pts. ..."
  let totalPoints = 0;
  let rank = "Unknown";
  const metaMatch = html.match(
    new RegExp(
      `content="${username} on Swamp Club\\.\\s*([^·]+)·\\s*([\\d,]+)\\s*pts`,
      "i",
    ),
  );
  if (metaMatch) {
    rank = metaMatch[1].trim();
    totalPoints = extractNumber(metaMatch[2]);
  } else {
    const ptsMatch = html.match(/([\d,]+)\s*pts/i);
    if (ptsMatch) totalPoints = extractNumber(ptsMatch[1]);
  }

  // Tier: ">tier</span>...<span ...>12</span>"
  let tier = 0;
  const maxTier = 20;
  const tierMatch = html.match(
    />tier<\/span>[^]*?<span[^>]*>(\d+)<\/span>/i,
  );
  if (tierMatch) tier = parseInt(tierMatch[1]);

  // Active days from the activity page (not on profile) — try meta or streak
  let activeDays = 0;
  const daysMatch = html.match(/(\d+)\s*active\s*days/i);
  if (daysMatch) activeDays = parseInt(daysMatch[1]);

  // Total events (populated by activity page, not profile)
  const totalEvents = 0;

  // Extensions and issues counts are in badges, not as plain "47 SHIPPED"
  const extensionsShipped = 0;
  const issuesFiled = 0;

  return {
    username,
    totalPoints,
    tier,
    maxTier,
    rank,
    activeDays,
    totalEvents,
    extensionsShipped,
    issuesFiled,
  };
}

// ---------------------------------------------------------------------------
// Scraping: activity breakdown
// ---------------------------------------------------------------------------

interface ParsedActivity {
  entries: Array<{
    operation: string;
    quantity: number;
    multiplier: number;
    points: number;
    timestamp: string;
  }>;
  totalPoints: number;
  totalEvents: number;
  activeDays: number;
}

function parseActivityPage(
  html: string,
): ParsedActivity {
  const entries: ParsedActivity["entries"] = [];

  // SSR HTML per row — each is a <li title="activity"> with 4 grid spans:
  //   span[0]: time (e.g. "19:43")
  //   span[1]: source (cli/collective/serve/api/publish/bonus)
  //   span[2]: operation text ("model method ×1" or "@magistr/seaweedfs")
  //   span[3]: scoring ("×1.66 +8" for CLI, or just "+500" for publish/bonus)
  const liPattern = /<li[^>]*title="activity"[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(html)) !== null) {
    const row = liMatch[1];

    // Source: look for any source label (cli, collective, serve, api, publish, bonus)
    const sourceMatch = row.match(
      /tracking-\[0\.14em\][^>]*>(cli|collective|serve|api|publish|bonus)<\/span>/i,
    );
    if (!sourceMatch) continue;
    const source = sourceMatch[1].trim().toLowerCase();

    // Operation text: third span with the action description
    const opMatch = row.match(/text-hud-label[^>]*>([^<]+)<\/span>/);
    if (!opMatch) continue;
    const opText = opMatch[1].trim();

    // Points: green span "+N" (always present)
    const ptsMatch = row.match(/text-green-400[^>]*>\+([\d,]+)<\/span>/);
    // Also check for points without green class (publish/bonus use different styling)
    const altPtsMatch = row.match(/\+([\d,]+)<\/span>\s*<\/span>\s*$/);
    const rawPts = ptsMatch?.[1] ?? altPtsMatch?.[1];
    if (!rawPts) continue;
    const points = extractNumber(rawPts);

    // Multiplier: amber span "×1.66" (absent for publish/bonus)
    const multMatch = row.match(/text-amber-300[^>]*>×([\d.]+)<\/span>/);
    const multiplier = multMatch ? parseFloat(multMatch[1]) : 0;

    // Quantity: "model method ×1" → 1, or package names have no ×
    const qtyMatch = opText.match(/^(.+?)\s*×(\d+)$/);
    const operation = qtyMatch ? qtyMatch[1] : opText;
    const quantity = qtyMatch ? parseInt(qtyMatch[2]) : 1;

    entries.push({
      operation: `${source} ${operation}`,
      quantity,
      multiplier,
      points,
      timestamp: new Date().toISOString(),
    });
  }

  // Summary stats: "6,052,695 PTS" or ">6,052,695</...>...PTS"
  let totalPoints = 0;
  const tpMatch = html.match(/([\d,]+)\s*(?:<[^>]*>\s*)*pts/i);
  if (tpMatch) totalPoints = extractNumber(tpMatch[1]);

  // Events: "341,159 · 172 DAYS" or similar
  let totalEvents = 0;
  const teMatch = html.match(/([\d,]+)\s*(?:·|&#183;)\s*\d+\s*days/i);
  if (teMatch) totalEvents = extractNumber(teMatch[1]);

  // "172 active days"
  let activeDays = 0;
  const adMatch = html.match(/(\d+)\s*active\s*days/i);
  if (adMatch) activeDays = parseInt(adMatch[1]);

  return { entries, totalPoints, totalEvents, activeDays };
}

// ---------------------------------------------------------------------------
// Scraping: leaderboard
// ---------------------------------------------------------------------------

interface ParsedLeaderboardEntry {
  rank: number;
  username: string;
  badge: string;
  score: number;
  events: number;
}

function parseLeaderboardPage(html: string): ParsedLeaderboardEntry[] {
  const entries: ParsedLeaderboardEntry[] = [];

  // Each row: <div class="grid ...">
  //   <span ...>1</span>  (rank)
  //   <span ...><a href="/u/mgreten" title="Bog Keeper" ...>mgreten</a></span>
  //   <span ... aria-label="Tier 15, ..."><span ...>T15</span>...</span>
  // </div>
  const rowPattern =
    /class="flex items-center justify-end[^"]*"[^>]*>(\d+)<\/span>\s*<span[^>]*><a\s+href="\/u\/([\w-]+)"[^>]*title="([^"]*)"[^>]*>[^<]*<\/a>/gi;
  let m;
  while ((m = rowPattern.exec(html)) !== null) {
    entries.push({
      rank: parseInt(m[1]),
      username: m[2],
      badge: m[3],
      score: 0,
      events: 0,
    });
  }

  // Enrich with scores from meta descriptions if embedded
  for (const entry of entries) {
    const metaMatch = html.match(
      new RegExp(
        `${entry.username} on Swamp Club\\.\\s*[^·]+·\\s*([\\d,]+)\\s*pts`,
      ),
    );
    if (metaMatch) entry.score = extractNumber(metaMatch[1]);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

interface WriteResourceFn {
  (spec: string, name: string, data: Record<string, unknown>): Promise<{
    name: string;
  }>;
}

interface ReadModelDataFn {
  (instanceName: string, specName?: string): Promise<
    Array<{ attributes: Record<string, unknown> }>
  >;
}

interface RunModelFn {
  (opts: {
    definition: string;
    method: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
}

interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResourceFn;
  readModelData: ReadModelDataFn;
  runModel: RunModelFn;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Swamp Club scoring tracker. */
export const model = {
  type: "@magistr/swamp-scoring",
  version: "2026.08.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    snapshot: {
      description: "Per-user profile snapshot",
      schema: UserSnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    activity: {
      description: "Per-user activity breakdown",
      schema: ActivityBreakdownSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    leaderboard: {
      description: "Leaderboard snapshot",
      schema: LeaderboardSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    comparison: {
      description: "Cross-user scoring comparison",
      schema: ComparisonSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    delta: {
      description: "Scoring changes between snapshots",
      schema: DeltaReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "top-ops": {
      description: "Top operations by points for a user",
      schema: TopOpsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "rate-card": {
      description: "Per-action scoring rates with base points and multiplier",
      schema: RateCardSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "rate-delta": {
      description: "Changes in per-action scoring rates between snapshots",
      schema: RateDeltaSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    bench: {
      description:
        "Per-action scoring benchmark — measures exact points per CLI command",
      schema: BenchReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "Scrape profiles and activity for all configured users, store snapshots",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        const baseUrl = globalArgs.baseUrl || DEFAULT_BASE_URL;
        const handles: Array<{ name: string }> = [];

        for (const user of globalArgs.users) {
          const profileHtml = await fetchPage(
            `${baseUrl}/u/${user.username}`,
          );
          const profile = parseProfilePage(profileHtml, user.username);

          const h1 = await context.writeResource(
            "snapshot",
            `${user.username}`,
            {
              ...profile,
              scrapedAt: new Date().toISOString(),
            },
          );
          handles.push(h1);

          const activityHtml = await fetchPage(
            `${baseUrl}/u/${user.username}/activity`,
          );
          const activity = parseActivityPage(activityHtml);

          const h2 = await context.writeResource(
            "activity",
            `${user.username}`,
            {
              username: user.username,
              entries: activity.entries,
              totalPoints: activity.totalPoints || profile.totalPoints,
              totalEvents: activity.totalEvents || profile.totalEvents,
              activeDays: activity.activeDays || profile.activeDays,
              scrapedAt: new Date().toISOString(),
            },
          );
          handles.push(h2);
        }

        return { dataHandles: handles };
      },
    },

    leaderboard: {
      description: "Scrape the all-time leaderboard and store it",
      arguments: z.object({
        board: z
          .enum(["all-time", "week", "today"])
          .default("all-time")
          .describe("Which leaderboard board to scrape"),
      }),
      execute: async (
        args: { board: string },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const baseUrl = context.globalArgs.baseUrl || DEFAULT_BASE_URL;
        const html = await fetchPage(`${baseUrl}/leaderboard`);
        const entries = parseLeaderboardPage(html);

        const h = await context.writeResource("leaderboard", args.board, {
          board: args.board,
          entries,
          scrapedAt: new Date().toISOString(),
        });

        return { dataHandles: [h] };
      },
    },

    compare: {
      description: "Compare all tracked users by score, events, and daily rate",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        const snapshots: Array<{
          username: string;
          totalPoints: number;
          activeDays: number;
          totalEvents: number;
          tier: number;
          rank: string;
        }> = [];

        const baseUrl = globalArgs.baseUrl || DEFAULT_BASE_URL;

        for (const user of globalArgs.users) {
          const html = await fetchPage(`${baseUrl}/u/${user.username}`);
          const profile = parseProfilePage(html, user.username);
          snapshots.push({
            username: user.username,
            totalPoints: profile.totalPoints,
            activeDays: profile.activeDays,
            totalEvents: profile.totalEvents,
            tier: profile.tier,
            rank: profile.rank,
          });
        }

        const users = snapshots.map((s) => ({
          ...s,
          pointsPerDay: s.activeDays > 0
            ? Math.round(s.totalPoints / s.activeDays)
            : 0,
          eventsPerDay: s.activeDays > 0
            ? Math.round(s.totalEvents / s.activeDays)
            : 0,
        }));

        users.sort((a, b) => b.totalPoints - a.totalPoints);
        const leader = users[0]?.username ?? "none";
        const gap = users.length >= 2
          ? users[0].totalPoints - users[1].totalPoints
          : 0;

        const h = await context.writeResource("comparison", "current", {
          users,
          leader,
          gap,
          comparedAt: new Date().toISOString(),
        });

        return { dataHandles: [h] };
      },
    },

    delta: {
      description:
        "Compute scoring changes since last sync for all tracked users",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        const baseUrl = globalArgs.baseUrl || DEFAULT_BASE_URL;
        const deltas: Array<z.infer<typeof DeltaSchema>> = [];

        for (const user of globalArgs.users) {
          let prevPoints = 0;
          let prevEvents = 0;
          let prevTime = new Date().toISOString();

          try {
            const existing = await context.readModelData("", "snapshot");
            const userRow = existing.find(
              (r) => r.attributes?.username === user.username,
            );
            if (userRow?.attributes) {
              prevPoints = (userRow.attributes.totalPoints as number) ?? 0;
              prevEvents = (userRow.attributes.totalEvents as number) ?? 0;
              prevTime = (userRow.attributes.scrapedAt as string) ??
                prevTime;
            }
          } catch {
            // no previous data
          }

          const html = await fetchPage(`${baseUrl}/u/${user.username}`);
          const profile = parseProfilePage(html, user.username);

          const now = new Date();
          const prev = new Date(prevTime);
          const periodHours = Math.max(
            1,
            (now.getTime() - prev.getTime()) / 3_600_000,
          );

          deltas.push({
            username: user.username,
            previousPoints: prevPoints,
            currentPoints: profile.totalPoints,
            delta: profile.totalPoints - prevPoints,
            previousEvents: prevEvents,
            currentEvents: profile.totalEvents,
            eventsDelta: profile.totalEvents - prevEvents,
            periodHours: Math.round(periodHours * 10) / 10,
            measuredAt: now.toISOString(),
          });
        }

        const h = await context.writeResource("delta", "current", {
          deltas,
          reportedAt: new Date().toISOString(),
        });

        return { dataHandles: [h] };
      },
    },

    "top-ops": {
      description:
        "Scrape activity and rank operations by total points for a user",
      arguments: z.object({
        username: z.string().describe("Username to analyze"),
      }),
      execute: async (
        args: { username: string },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const baseUrl = context.globalArgs.baseUrl || DEFAULT_BASE_URL;
        const html = await fetchPage(
          `${baseUrl}/u/${args.username}/activity`,
        );
        const activity = parseActivityPage(html);

        const byOp = new Map<
          string,
          { totalPoints: number; totalQuantity: number; count: number }
        >();
        for (const e of activity.entries) {
          const existing = byOp.get(e.operation) ??
            { totalPoints: 0, totalQuantity: 0, count: 0 };
          existing.totalPoints += e.points;
          existing.totalQuantity += e.quantity;
          existing.count++;
          byOp.set(e.operation, existing);
        }

        const operations = Array.from(byOp.entries())
          .map(([operation, stats]) => ({
            operation,
            totalPoints: stats.totalPoints,
            totalQuantity: stats.totalQuantity,
            avgPointsPerOp: stats.totalQuantity > 0
              ? Math.round(stats.totalPoints / stats.totalQuantity)
              : 0,
          }))
          .sort((a, b) => b.totalPoints - a.totalPoints);

        const h = await context.writeResource("top-ops", args.username, {
          username: args.username,
          operations,
          scrapedAt: new Date().toISOString(),
        });

        return { dataHandles: [h] };
      },
    },

    rates: {
      description:
        "Scrape per-action scoring rates — base points, multiplier, and points per unit",
      arguments: z.object({
        username: z.string().describe("Username to scrape rates for"),
      }),
      execute: async (
        args: { username: string },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const baseUrl = context.globalArgs.baseUrl || DEFAULT_BASE_URL;
        const html = await fetchPage(
          `${baseUrl}/u/${args.username}/activity`,
        );
        const activity = parseActivityPage(html);

        const byAction = new Map<
          string,
          {
            source: string;
            action: string;
            points: number;
            qty: number;
            mult: number;
            count: number;
          }
        >();

        for (const e of activity.entries) {
          const parts = e.operation.split(" ", 2);
          const source = parts[0] ?? "";
          const action = e.operation.slice(source.length + 1);
          const key = e.operation;
          const existing = byAction.get(key) ??
            { source, action, points: 0, qty: 0, mult: e.multiplier, count: 0 };
          existing.points += e.points;
          existing.qty += e.quantity;
          existing.mult = e.multiplier;
          existing.count++;
          byAction.set(key, existing);
        }

        const actions = Array.from(byAction.entries())
          .map(([_key, s]) => {
            const pointsPerUnit = s.qty > 0 ? Math.round(s.points / s.qty) : 0;
            // publish/bonus have no multiplier (0) — base = points directly
            const basePoints = s.qty > 0
              ? s.mult > 0
                ? Math.round(s.points / s.qty / s.mult)
                : Math.round(s.points / s.qty)
              : 0;
            return {
              action: s.action,
              source: s.source,
              basePoints,
              multiplier: s.mult,
              pointsPerUnit,
              occurrences: s.count,
              totalQuantity: s.qty,
              totalPoints: s.points,
            };
          })
          .sort((a, b) => b.basePoints - a.basePoints);

        const activeMult = actions.length > 0 ? actions[0].multiplier : 1;

        const h = await context.writeResource("rate-card", args.username, {
          username: args.username,
          actions,
          activeMultiplier: activeMult,
          totalPoints: activity.totalPoints,
          scrapedAt: new Date().toISOString(),
        });

        const handles: Array<{ name: string }> = [h];

        // Compare with previous rate-card to detect changes
        try {
          const prev = await context.readModelData("", "rate-card");
          const prevCard = prev.find(
            (r) => r.attributes?.username === args.username,
          );
          if (prevCard?.attributes) {
            const prevActions = (prevCard.attributes.actions as Array<{
              action: string;
              basePoints: number;
              multiplier: number;
            }>) ?? [];
            const prevByAction = new Map(
              prevActions.map((a) => [a.action, a]),
            );
            const changes: Array<{
              action: string;
              previousBase: number;
              currentBase: number;
              previousMultiplier: number;
              currentMultiplier: number;
              baseDelta: number;
              multiplierDelta: number;
            }> = [];
            const newActions: string[] = [];

            for (const curr of actions) {
              const p = prevByAction.get(curr.action);
              if (!p) {
                newActions.push(curr.action);
              } else if (
                p.basePoints !== curr.basePoints ||
                p.multiplier !== curr.multiplier
              ) {
                changes.push({
                  action: curr.action,
                  previousBase: p.basePoints,
                  currentBase: curr.basePoints,
                  previousMultiplier: p.multiplier,
                  currentMultiplier: curr.multiplier,
                  baseDelta: curr.basePoints - p.basePoints,
                  multiplierDelta: curr.multiplier - p.multiplier,
                });
              }
            }

            if (changes.length > 0 || newActions.length > 0) {
              const h2 = await context.writeResource(
                "rate-delta",
                args.username,
                {
                  username: args.username,
                  changes,
                  newActions,
                  measuredAt: new Date().toISOString(),
                },
              );
              handles.push(h2);
            }
          }
        } catch {
          // no previous rate-card
        }

        return { dataHandles: handles };
      },
    },

    alert: {
      description:
        "Send a Telegram alert with scoring deltas and comparison summary",
      arguments: z.object({
        minDelta: z
          .number()
          .default(0)
          .describe("Only alert if any user delta exceeds this threshold"),
      }),
      execute: async (
        args: { minDelta: number },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs } = context;
        if (!globalArgs.telegramModel || !globalArgs.telegramChatId) {
          throw new Error(
            "telegramModel and telegramChatId must be set for alerts",
          );
        }

        const baseUrl = globalArgs.baseUrl || DEFAULT_BASE_URL;
        const lines: string[] = ["<b>Swamp Club Scoring Report</b>\n"];
        let maxDelta = 0;

        for (const user of globalArgs.users) {
          const html = await fetchPage(`${baseUrl}/u/${user.username}`);
          const profile = parseProfilePage(html, user.username);

          let prevPoints = 0;
          try {
            const existing = await context.readModelData("", "snapshot");
            const userRow = existing.find(
              (r) => r.attributes?.username === user.username,
            );
            if (userRow?.attributes) {
              prevPoints = (userRow.attributes.totalPoints as number) ?? 0;
            }
          } catch {
            // no previous snapshot
          }

          const delta = profile.totalPoints - prevPoints;
          maxDelta = Math.max(maxDelta, Math.abs(delta));
          const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
          const ptsPerDay = profile.activeDays > 0
            ? Math.round(profile.totalPoints / profile.activeDays)
            : 0;

          lines.push(
            `<b>${user.username}</b>: ${profile.totalPoints.toLocaleString()} pts ${arrow}${
              Math.abs(delta).toLocaleString()
            }`,
          );
          lines.push(
            `  T${profile.tier}/${profile.maxTier} ${profile.rank} | ${profile.activeDays}d | ${ptsPerDay.toLocaleString()}/day`,
          );
        }

        if (args.minDelta > 0 && maxDelta < args.minDelta) {
          return { dataHandles: [] };
        }

        await context.runModel({
          definition: globalArgs.telegramModel,
          method: "sendMessage",
          arguments: {
            chatId: globalArgs.telegramChatId,
            text: lines.join("\n"),
            parseMode: "HTML",
          },
        });

        return { dataHandles: [] };
      },
    },

    bench: {
      description:
        "Init a temp repo, run each CLI command N times, scrape points awarded per call to detect diminishing returns",
      arguments: z.object({
        username: z
          .string()
          .describe("Username to scrape combat log for"),
        runs: z
          .number()
          .int()
          .default(3)
          .describe("How many times to repeat each command"),
      }),
      execute: async (
        args: { username: string; runs: number },
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const baseUrl = context.globalArgs.baseUrl || DEFAULT_BASE_URL;
        const tmpDir = `/tmp/swamp-bench-${Date.now()}`;
        const log: string[] = [];

        async function exec(
          cmd: string[],
          cwd: string,
        ): Promise<{ ok: boolean; stdout: string }> {
          const proc = new Deno.Command("swamp", {
            args: cmd,
            cwd,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await proc.output();
          return {
            ok: output.success,
            stdout: new TextDecoder().decode(output.stdout),
          };
        }

        async function getEntries(): Promise<ParsedActivity["entries"]> {
          const html = await fetchPage(
            `${baseUrl}/u/${args.username}/activity`,
          );
          return parseActivityPage(html).entries;
        }

        // Phase 1: Init repo
        await Deno.mkdir(tmpDir, { recursive: true });
        await exec(["init"], tmpDir);
        log.push("init");

        // Phase 2: Extension lifecycle (no publish)
        const extDir = `${tmpDir}/extensions/models`;
        await Deno.mkdir(extDir, { recursive: true });
        const extSource = `import { z } from "npm:zod@4";
const S = z.object({ msg: z.string() });
/** Bench model. */
export const model = {
  type: "@local/bench-ext",
  version: "2026.01.01.1",
  globalArguments: z.object({ greeting: z.string().default("hi") }),
  resources: { out: { description: "output", schema: S, lifetime: "infinite" as const, garbageCollection: 5 } },
  methods: {
    ping: {
      description: "Return greeting",
      arguments: z.object({}),
      execute: async (_a: Record<string, never>, ctx: { globalArgs: { greeting: string }; writeResource: (s: string, n: string, d: Record<string, unknown>) => Promise<{ name: string }> }) => {
        const h = await ctx.writeResource("out", "pong", { msg: ctx.globalArgs.greeting });
        return { dataHandles: [h] };
      },
    },
  },
};`;
        await Deno.writeTextFile(`${extDir}/bench_ext.ts`, extSource);
        log.push("wrote extension source");

        const manifestYaml = `manifestVersion: 1
name: "@local/bench-ext"
version: "2026.01.01.1"
description: "Bench extension"
models:
  - extensions/models/bench_ext.ts
platforms: []
labels: []`;
        await Deno.writeTextFile(`${tmpDir}/manifest.yaml`, manifestYaml);

        // Extension commands
        const extCmds: string[][] = [
          ["extension", "fmt", "manifest.yaml", "--json"],
          ["extension", "quality", "manifest.yaml", "--json"],
          ["extension", "version", "--manifest", "manifest.yaml", "--json"],
          ["extension", "source", "list", "--json"],
          ["extension", "trust", "list", "--json"],
          ["extension", "list", "--json"],
          ["extension", "search", "pihole", "--json"],
          ["extension", "info", "@magistr/pihole", "--json"],
          ["extension", "outdated", "--json"],
        ];
        for (const c of extCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Pull a few extensions
        for (const pkg of ["@magistr/pihole", "@magistr/reading-list"]) {
          await exec(["extension", "pull", pkg], tmpDir);
          log.push(`extension pull ${pkg}`);
        }

        // Phase 3: Model lifecycle
        await exec(
          ["model", "create", "command/shell", "bench-shell", "--json"],
          tmpDir,
        );
        log.push("model create");

        // Also create a model from our local extension
        await exec(
          ["model", "create", "@local/bench-ext", "bench-local", "--json"],
          tmpDir,
        );
        log.push("model create @local/bench-ext");

        const modelCmds: string[][] = [
          ["model", "search", "--json"],
          ["model", "list", "--json"],
          ["model", "get", "bench-shell", "--json"],
          ["model", "get", "bench-local", "--json"],
          ["model", "validate", "bench-shell", "--json"],
          ["model", "validate", "bench-local", "--json"],
          ["model", "evaluate", "bench-shell", "--json"],
          ["model", "evaluate", "bench-local", "--json"],
          ["model", "type", "search", "--json"],
          [
            "model",
            "type",
            "describe",
            "command/shell",
            "--compact",
            "--json",
          ],
          [
            "model",
            "method",
            "describe",
            "execute",
            "bench-shell",
            "--json",
          ],
        ];
        for (const c of modelCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Model method runs — capture output ID from first run
        let methodOutputId = "";
        for (let i = 0; i < args.runs; i++) {
          const shellOut = await exec(
            [
              "model",
              "method",
              "run",
              "execute",
              "bench-shell",
              "--arg",
              `cmd=echo run${i}`,
              "--json",
            ],
            tmpDir,
          );
          if (i === 0 && shellOut.ok) {
            try {
              const parsed = JSON.parse(shellOut.stdout);
              methodOutputId = parsed.outputId ?? "";
            } catch {
              // parse failure
            }
          }
          await exec(
            [
              "model",
              "@local/bench-ext",
              "method",
              "run",
              "ping",
              "bench-local",
              "--json",
            ],
            tmpDir,
          );
        }
        log.push(`model method run × ${args.runs * 2}`);

        // Model output/history commands using captured ID
        if (methodOutputId) {
          const outputCmds: string[][] = [
            [
              "model",
              "method",
              "history",
              "get",
              methodOutputId,
              "bench-shell",
              "--json",
            ],
            [
              "model",
              "method",
              "history",
              "logs",
              methodOutputId,
              "bench-shell",
            ],
            ["model", "output", "get", methodOutputId, "bench-shell", "--json"],
            ["model", "output", "logs", methodOutputId, "bench-shell"],
            [
              "model",
              "output",
              "data",
              methodOutputId,
              "bench-shell",
              "--json",
            ],
          ];
          for (const c of outputCmds) {
            await exec(c, tmpDir);
            log.push(c.join(" "));
          }
        }

        // Phase 4: Workflow lifecycle
        const wfYaml = `jobs:
  - name: main
    steps:
      - name: echo
        task:
          type: model_method
          modelIdOrName: bench-shell
          methodName: execute
        dependsOn: []
        weight: 0
      - name: ping
        task:
          type: model_method
          modelIdOrName: bench-local
          methodName: ping
        dependsOn:
          - echo
        weight: 0
    dependsOn: []
    weight: 0`;
        await Deno.writeTextFile(`${tmpDir}/bench-wf.yaml`, wfYaml);
        await exec(
          [
            "workflow",
            "create",
            "bench-wf",
            "--input-file",
            `${tmpDir}/bench-wf.yaml`,
          ],
          tmpDir,
        );
        log.push("workflow create");

        const wfCmds: string[][] = [
          ["workflow", "search", "--json"],
          ["workflow", "get", "bench-wf", "--json"],
          ["workflow", "validate", "bench-wf", "--json"],
          ["workflow", "evaluate", "bench-wf", "--json"],
          ["workflow", "schema", "get", "bench-wf", "--json"],
        ];
        for (const c of wfCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Workflow runs — capture run ID from first run
        let wfRunId = "";
        for (let i = 0; i < args.runs; i++) {
          const wfOut = await exec(
            ["workflow", "run", "bench-wf", "--json"],
            tmpDir,
          );
          if (i === 0 && wfOut.ok) {
            try {
              const parsed = JSON.parse(wfOut.stdout);
              wfRunId = parsed.runId ?? parsed.id ?? "";
            } catch {
              // parse failure
            }
          }
        }
        log.push(`workflow run × ${args.runs}`);

        // Workflow history using captured run ID
        await exec(
          ["workflow", "history", "search", "--json"],
          tmpDir,
        );
        await exec(["workflow", "run", "search", "--json"], tmpDir);
        if (wfRunId) {
          await exec(
            ["workflow", "history", "get", wfRunId, "--json"],
            tmpDir,
          );
          await exec(
            ["workflow", "history", "logs", wfRunId],
            tmpDir,
          );
          log.push(`workflow history get/logs ${wfRunId}`);
        }
        log.push("workflow history");

        // Phase 5: Data commands (after runs produced data)
        const dataCmds: string[][] = [
          ["data", "list", "--json"],
          ["data", "get", "bench-shell", "--json"],
          ["data", "search", "--json"],
          ["data", "query", "bench-shell", "true", "--json"],
          ["data", "versions", "bench-shell", "--json"],
        ];
        for (const c of dataCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Data lifecycle extras
        await exec(["data", "gc", "bench-shell", "--json"], tmpDir);
        log.push("data gc");

        // Phase 6: Vault lifecycle (local_encryption — no HC vault needed)
        await exec(
          ["vault", "create", "local_encryption", "bench-vault"],
          tmpDir,
        );
        await exec(
          ["vault", "put", "bench-vault", "TEST_KEY=test_value", "-f"],
          tmpDir,
        );
        log.push("vault create + put");

        const vaultCmds: string[][] = [
          ["vault", "search", "--json"],
          ["vault", "type", "search", "--json"],
          ["vault", "get", "bench-vault", "--json"],
          ["vault", "describe", "bench-vault", "--json"],
          ["vault", "list-keys", "bench-vault", "--json"],
          ["vault", "read-secret", "bench-vault", "TEST_KEY"],
          ["vault", "inspect", "bench-vault", "--json"],
        ];
        for (const c of vaultCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Vault extras
        await exec(
          ["vault", "audit-trail", "bench-vault", "--json"],
          tmpDir,
        );
        await exec(
          [
            "vault",
            "annotate",
            "bench-vault",
            "--annotation",
            "bench=true",
            "--json",
          ],
          tmpDir,
        );
        log.push("vault audit-trail + annotate");

        // Phase 7: Report commands
        const reportCmds: string[][] = [
          ["report", "list", "--json"],
          ["report", "type", "search", "--json"],
          ["report", "search", "--json"],
          [
            "report",
            "get",
            "@swamp/method-summary",
            "--model",
            "bench-shell",
            "--json",
          ],
          [
            "report",
            "describe",
            "@swamp/method-summary",
            "--json",
          ],
        ];
        for (const c of reportCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Phase 8: Doctor / diagnostics
        const doctorCmds: string[][] = [
          ["doctor", "extensions", "--json"],
          ["doctor", "datastores", "--json"],
          ["doctor", "vaults", "--json"],
          ["doctor", "workflows", "--json"],
          ["doctor", "audit", "--json"],
          ["doctor", "secrets", "--json"],
          ["doctor", "install", "--json"],
        ];
        for (const c of doctorCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Phase 9: Run tracking
        const runCmds: string[][] = [
          ["run", "history", "--json"],
          ["run", "doctor", "--json"],
          ["run", "gc", "--json"],
        ];
        for (const c of runCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Phase 10: Extension source/trust lifecycle
        await exec(
          ["extension", "source", "add", `${tmpDir}/extensions`, "--json"],
          tmpDir,
        );
        log.push("extension source add");
        await exec(
          ["extension", "source", "rm", `${tmpDir}/extensions`, "--json"],
          tmpDir,
        );
        log.push("extension source rm");
        await exec(
          ["extension", "trust", "add", "@local", "--json"],
          tmpDir,
        );
        log.push("extension trust add");
        await exec(
          ["extension", "trust", "rm", "@local", "--json"],
          tmpDir,
        );
        log.push("extension trust rm");

        // Phase 10b: Misc commands
        const miscCmds: string[][] = [
          ["version"],
          ["help"],
          ["summarise", "--json"],
          ["auth", "whoami", "--json"],
          ["config", "list", "--json"],
          ["config", "get", "json"],
          ["config", "set", "json", "true"],
          ["datastore", "status", "--json"],
          ["datastore", "type", "search", "--json"],
          ["datastore", "lock", "status", "--json"],
          ["datastore", "namespace", "list", "--json"],
          ["serve", "daemon", "status", "--json"],
          ["worker", "list", "--json"],
          ["worker", "token", "list", "--json"],
          ["worker", "daemon", "status", "--json"],
          ["telemetry", "stats", "--json"],
          ["audit", "--json"],
          ["source", "path", "--json"],
          ["model", "method", "history", "search", "bench-shell", "--json"],
          ["model", "output", "search", "bench-shell", "--json"],
        ];
        for (const c of miscCmds) {
          await exec(c, tmpDir);
          log.push(c.join(" "));
        }

        // Phase 11: Serve + worker + access (if serveUrl configured)
        const serveUrl = context.globalArgs.serveUrl;
        if (serveUrl) {
          log.push(`serve phase: ${serveUrl}`);

          // Access token lifecycle
          const tokenMintProc = new Deno.Command("swamp", {
            args: [
              "access",
              "token",
              "mint",
              "--name",
              "bench-token",
              "--json",
            ],
            cwd: tmpDir,
            stdout: "piped",
            stderr: "piped",
          });
          const tokenOut = await tokenMintProc.output();
          let benchToken = "";
          if (tokenOut.success) {
            try {
              const tokenResult = JSON.parse(
                new TextDecoder().decode(tokenOut.stdout),
              );
              benchToken = tokenResult.token ?? "";
            } catch {
              // parse failure
            }
          }
          log.push("access token mint");

          const accessCmds: string[][] = [
            ["access", "token", "list", "--json"],
            ["access", "grant", "list", "--json"],
            ["access", "group", "list", "--json"],
            ["access", "group", "list-idp", "--json"],
            ["access", "can-i", "read", "--json"],
            ["access", "check", "--json"],
            ["access", "reload", "--json"],
          ];
          for (const c of accessCmds) {
            await exec(c, tmpDir);
            log.push(c.join(" "));
          }

          // Access grant lifecycle
          await exec(
            [
              "access",
              "grant",
              "create",
              "--subject",
              "user:bench",
              "--action",
              "read",
              "--resource",
              "model:*",
              "--json",
            ],
            tmpDir,
          );
          log.push("access grant create");
          await exec(["access", "grant", "list", "--json"], tmpDir);

          // Worker commands
          const workerCmds: string[][] = [
            ["worker", "list", "--json"],
            ["worker", "queue", "--json"],
            ["worker", "verify", "--json"],
          ];
          for (const c of workerCmds) {
            await exec(c, tmpDir);
            log.push(c.join(" "));
          }

          // Worker token lifecycle
          await exec(
            [
              "worker",
              "token",
              "create",
              "--name",
              "bench-worker",
              "--json",
            ],
            tmpDir,
          );
          log.push("worker token create");
          await exec(["worker", "token", "list", "--json"], tmpDir);

          // Serve reload
          await exec(["serve", "reload", "--json"], tmpDir);
          log.push("serve reload");

          // Workflow trigger lifecycle — set a real schedule, wait for
          // serve to fire it, then measure collective vs cli scoring
          await exec(
            [
              "workflow",
              "trigger",
              "set",
              "bench-wf",
              "--schedule",
              "* * * * *",
              "--json",
            ],
            tmpDir,
          );
          log.push("workflow trigger set (every minute)");
          await exec(["serve", "reload", "--json"], tmpDir);
          log.push("serve reload (to pick up trigger)");
          await exec(
            ["workflow", "trigger", "get", "bench-wf", "--json"],
            tmpDir,
          );

          // Wait up to 90s for serve to fire the scheduled workflow
          log.push("waiting for serve-triggered run...");
          for (let wait = 0; wait < 9; wait++) {
            await new Promise((r) => setTimeout(r, 10_000));
            const histOut = await exec(
              ["workflow", "history", "search", "--json"],
              tmpDir,
            );
            if (histOut.ok) {
              try {
                const hist = JSON.parse(histOut.stdout);
                const runs = hist.results ?? hist.runs ?? [];
                const serveRun = runs.find(
                  (r: { initiatedBy?: string }) =>
                    r.initiatedBy && r.initiatedBy.includes("schedule"),
                );
                if (serveRun) {
                  log.push(
                    `serve-triggered run found after ${(wait + 1) * 10}s`,
                  );
                  break;
                }
              } catch {
                // parse failure
              }
            }
          }
          log.push("collective scoring measurement done");
          log.push("workflow trigger get");

          // Rotate then revoke bench token, remove trigger, revoke grant
          if (benchToken) {
            const rotateOut = await exec(
              ["access", "token", "rotate", benchToken, "--json"],
              tmpDir,
            );
            log.push("access token rotate");
            let revokeToken = benchToken;
            if (rotateOut.ok) {
              try {
                const parsed = JSON.parse(rotateOut.stdout);
                revokeToken = parsed.token ?? benchToken;
              } catch {
                // keep original
              }
            }
            await exec(
              ["access", "token", "revoke", revokeToken, "--json"],
              tmpDir,
            );
            log.push("access token revoke");
          }
          await exec(
            ["workflow", "trigger", "remove", "bench-wf", "--json"],
            tmpDir,
          );
          log.push("workflow trigger remove");
          await exec(
            [
              "access",
              "grant",
              "revoke",
              "--subject",
              "user:bench",
              "--action",
              "read",
              "--resource",
              "model:*",
              "--json",
            ],
            tmpDir,
          );
          log.push("access grant revoke");
        } else {
          log.push("serve phase: SKIPPED (no serveUrl configured)");
        }

        // Scrape combat log once
        await new Promise((r) => setTimeout(r, 3000));
        const entries = await getEntries();

        // Build results from all combat log entries
        const results: Array<{
          action: string;
          run: number;
          points: number;
          basePoints: number;
          multiplier: number;
          quantity: number;
        }> = [];

        for (const e of entries) {
          const base = e.quantity > 0 && e.multiplier > 0
            ? Math.round(e.points / e.quantity / e.multiplier)
            : e.quantity > 0
            ? Math.round(e.points / e.quantity)
            : e.points;
          results.push({
            action: e.operation,
            run: 1,
            points: e.points,
            basePoints: base,
            multiplier: e.multiplier,
            quantity: e.quantity,
          });
        }

        // Deduplicate by action, keep highest-quantity entry
        const deduped = new Map<string, (typeof results)[0]>();
        for (const r of results) {
          const existing = deduped.get(r.action);
          if (!existing || r.quantity > existing.quantity) {
            deduped.set(r.action, r);
          }
        }
        const dedupedResults = Array.from(deduped.values()).sort(
          (a, b) => b.basePoints - a.basePoints,
        );

        const summary = dedupedResults.map((r) => ({
          action: r.action,
          runs: 1,
          firstBase: r.basePoints,
          lastBase: r.basePoints,
          avgBase: r.basePoints,
          diminishing: false,
        }));

        // Cleanup
        try {
          await Deno.remove(tmpDir, { recursive: true });
        } catch {
          // cleanup failure is non-fatal
        }

        const h = await context.writeResource("bench", args.username, {
          username: args.username,
          results: dedupedResults,
          summary,
          repoPath: tmpDir,
          scrapedAt: new Date().toISOString(),
        });

        return { dataHandles: [h] };
      },
    },
  },
};
