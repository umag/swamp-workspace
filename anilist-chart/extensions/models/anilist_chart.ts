import { z } from "npm:zod@4";

// =============================================================================
// @magistr/anilist-chart
// Read-only render layer for the AniList chat statistics site. Ports the legacy
// Python (generate_board.py, generate_landing.py, anilist_chart*.py) into one
// swamp model. The render boundary only READS ClickHouse (metadata + scores are
// written by the @anilist/api ingest model); it never mutates data. Because the
// boundary is read-only it CANNOT corrupt the ingest aggregate, which is why the
// gate here is a light freshness check rather than a cross-aggregate provenance
// gate (plan v11, steps 9-10).
//
// The `render` method fans out all six pages (seven artifacts: /board, /anime,
// /chart, /fresh, /bayes + its sidecar JSON, /current). One failing page never
// suppresses the rest (run.sh semantics), and every produced page passes the
// publish backstop (publish_gate) before it is written.
// =============================================================================

import { ClickHouseClient, type ClickHouseConfig } from "./lib/clickhouse.ts";
import {
  boardQuery,
  chartMetadataQuery,
  chartScoresQuery,
  distinctMediaIdsQuery,
  freshnessQuery,
  landingQueries,
} from "./lib/clickhouse.ts";
import { arrayIntParam, arrayStringParam } from "./lib/clickhouse.ts";
import { currentSeasonInfo } from "./lib/age_penalty.ts";
import { groupRows } from "./lib/rankable.ts";
import { newWarn, type Warn } from "./lib/rankable.ts";
import { computeAwards } from "./lib/awards.ts";
import { computePairs } from "./lib/pairs.ts";
import { type BoardResult, renderBoard } from "./lib/render_board.ts";
import { type LandingStats, renderLanding } from "./lib/render_landing.ts";
import { renderBayesJson, renderChart } from "./lib/render_charts.ts";
import {
  PAGE_FILES,
  type PublishPage,
  publishPages,
  remoteWriteCommand,
} from "./lib/publish.ts";
import {
  aggregateGenres,
  evaluateFreshness,
  type FanOutResult,
  mapBoardRow,
  type PageRender,
  type RawBoardRow,
  type RawChartMeta,
  type RawChartScore,
  runFanOut,
  seasonWindow,
} from "./lib/render_run.ts";

// ── schemas ──────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  clickhouseUrl: z.string().optional().describe(
    "ClickHouse HTTP endpoint for the read-only render user, e.g. https://host:8443.",
  ),
  clickhouseUser: z.string().optional().describe(
    "Read-only ClickHouse user (sent as the X-ClickHouse-User header).",
  ),
  clickhouseKey: z.string().meta({ sensitive: true }).optional().describe(
    "Password for the read-only ClickHouse user (X-ClickHouse-Key header).",
  ),
  clickhouseDatabase: z.string().default("default").describe(
    "ClickHouse database holding anilist_metadata and user_scores.",
  ),
  userNames: z.array(z.string()).default([]).describe(
    "AniList usernames whose scores feed the four genre charts.",
  ),
  topK: z.number().int().positive().default(13).describe(
    "Rows per genre in each chart; also advertised on the /anime landing.",
  ),
  bayesMinVotes: z.number().int().nonnegative().default(5).describe(
    "Bayesian prior weight m (minimum votes for confidence) on the /bayes chart.",
  ),
  penaltyRate: z.number().nonnegative().default(0.05).describe(
    "Per-season age penalty applied on the /fresh chart.",
  ),
  nodeHost: z.string().optional().describe(
    "SSH host of the node serving the pages. Required for `publish`.",
  ),
  nodeUser: z.string().default("root").describe(
    "SSH user for the serving node.",
  ),
  outputDir: z.string().optional().describe(
    "Absolute path of the nginx-served output directory on the node. Required for `publish`.",
  ),
  sshTimeoutMs: z.number().int().positive().default(30000).describe(
    "Timeout for the ssh publish fallback spawn (per page). A hung ssh connection " +
      "aborts after this many ms instead of blocking `publish` forever.",
  ),
  clickhouseMaxResponseBytes: z.number().int().positive().default(67108864)
    .describe(
      "Cap on the total bytes read from a single ClickHouse query response body " +
        "(default 64MiB). Exceeding it aborts that read rather than exhausting memory.",
    ),
});

const SettingsSchema = z.object({
  clickhouseDatabase: z.string(),
  clickhouseConfigured: z.boolean(),
  userCount: z.number(),
  topK: z.number(),
  bayesMinVotes: z.number(),
  penaltyRate: z.number(),
  timestamp: z.string(),
});

const RenderedPageSchema = z.object({
  page: z.string(),
  html: z.string(),
  bytes: z.number(),
  recordCount: z.number().optional(),
  skipped: z.array(z.string()).default([]),
  timestamp: z.string(),
});

const RenderRunSchema = z.object({
  timestamp: z.string(),
  ok: z.boolean(),
  refuseReason: z.string().nullable(),
  published: z.array(z.string()),
  refused: z.array(z.string()),
  failed: z.array(z.string()),
  anomalies: z.array(z.string()),
  topK: z.number(),
  bayesMinVotes: z.number(),
});

const PublishRunSchema = z.object({
  timestamp: z.string(),
  ok: z.boolean(),
  target: z.string(),
  published: z.array(z.string()),
  failed: z.array(z.string()),
  missing: z.array(z.string()),
});

// ── pure task builder (unit-tested; the execute below only supplies the IO) ──

/** Everything the seven render tasks need, already read out of ClickHouse. */
export interface RenderInputs {
  boardRows: RawBoardRow[];
  boardNrows: number;
  chartScores: RawChartScore[];
  chartMeta: RawChartMeta[];
  landing: LandingStats;
  topK: number;
  bayesMinVotes: number;
  penaltyRate: number;
  now: Date;
}

/**
 * Value object returned by `buildRenderTasks`: the ordered list of per-page
 * render tasks (each producing one `PageRender` when invoked), plus the
 * shared `Warn` sink the board task's compute functions accumulate into as
 * they run, so the caller can inspect skips and dropped notes once every
 * task has executed.
 */
export interface RenderTaskBundle {
  tasks: { key: string; render: () => PageRender }[];
  /** Board compute warnings (award skips + dropped curated notes) after run. */
  warn: Warn;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

/**
 * Assemble the ordered task list. The board runs first and stores its actual
 * record count in a shared closure the landing then reads, so a skipped award
 * lowers what the landing advertises, and a failing board still leaves the
 * landing a sensible fallback (BOARD_RECORDS=15) rather than aborting it.
 */
export function buildRenderTasks(inp: RenderInputs): RenderTaskBundle {
  const warn = newWarn();
  const { season, year } = currentSeasonInfo(inp.now);
  let boardRecordCount = 15; // fallback if the board renderer throws

  const chartParams = {
    topK: inp.topK,
    now: inp.now,
    penaltyRate: inp.penaltyRate,
    minVotes: inp.bayesMinVotes,
  };

  const tasks: { key: string; render: () => PageRender }[] = [
    {
      key: "board",
      render: (): PageRender => {
        const rows = inp.boardRows.map(mapBoardRow);
        const grouped = groupRows(rows);
        const awards = computeAwards(grouped, rows, warn);
        const pairs = computePairs(grouped, rows, warn);
        const res: BoardResult = renderBoard({
          users: grouped.users,
          nrows: inp.boardNrows,
          top: awards.top,
          rest: awards.rest,
          keepers: awards.keepers,
          pairs,
          now: inp.now,
        });
        boardRecordCount = res.recordCount;
        return {
          key: "board",
          html: res.html,
          recordCount: res.recordCount,
          skipped: res.skipped,
        };
      },
    },
    {
      key: "landing",
      render: (): PageRender => ({
        key: "landing",
        html: renderLanding({
          stats: inp.landing,
          recordCount: boardRecordCount,
          topK: inp.topK,
        }),
        recordCount: boardRecordCount,
      }),
    },
    {
      key: "chart",
      render: (): PageRender => ({
        key: "chart",
        html: renderChart({
          mode: "chart",
          topK: inp.topK,
          final: aggregateGenres(inp.chartScores, inp.chartMeta, {
            ...chartParams,
            mode: "chart",
          }).final,
        }),
      }),
    },
    {
      key: "fresh",
      render: (): PageRender => ({
        key: "fresh",
        html: renderChart({
          mode: "fresh",
          topK: inp.topK,
          final: aggregateGenres(inp.chartScores, inp.chartMeta, {
            ...chartParams,
            mode: "fresh",
          }).final,
        }),
      }),
    },
    {
      key: "bayes",
      render: (): PageRender => {
        const agg = aggregateGenres(inp.chartScores, inp.chartMeta, {
          ...chartParams,
          mode: "bayes",
        });
        return {
          key: "bayes",
          html: renderChart({
            mode: "bayes",
            topK: inp.topK,
            final: agg.final,
            m: inp.bayesMinVotes,
            c: agg.globalC,
            now: inp.now,
          }),
        };
      },
    },
    {
      key: "bayes-json",
      render: (): PageRender => ({
        key: "bayes-json",
        html: renderBayesJson(
          aggregateGenres(inp.chartScores, inp.chartMeta, {
            ...chartParams,
            mode: "bayes",
          }).genreMap,
        ),
      }),
    },
    {
      key: "current",
      render: (): PageRender => ({
        key: "current",
        html: renderChart({
          mode: "current",
          topK: inp.topK,
          season,
          year,
          final: aggregateGenres(inp.chartScores, inp.chartMeta, {
            ...chartParams,
            mode: "current",
          }).final,
        }),
      }),
    },
  ];

  return { tasks, warn };
}

// ── model ────────────────────────────────────────────────────────────────────

type Ctx = Record<string, unknown>;

function writeResourceOf(context: Ctx) {
  return context.writeResource as (
    resource: string,
    instance: string,
    data: unknown,
  ) => Promise<unknown>;
}

function configFrom(g: Record<string, unknown>): ClickHouseConfig | null {
  const url = g.clickhouseUrl as string | undefined;
  const user = g.clickhouseUser as string | undefined;
  const key = g.clickhouseKey as string | undefined;
  if (!url || !user || key === undefined) return null;
  return {
    url,
    user,
    key,
    database: (g.clickhouseDatabase as string) ?? "default",
    maxResponseBytes: g.clickhouseMaxResponseBytes as number | undefined,
  };
}

/**
 * The `@magistr/anilist-chart` extension facade: a read-only render layer
 * over ClickHouse-backed AniList chat statistics. Declares the model's
 * `globalArguments` (ClickHouse connection plus render-tuning knobs), its
 * four resource specs (`settings`, `renderedPage`, `renderRun`,
 * `publishRun`), and its three methods — `settings` echoes the resolved
 * configuration, `render` fans out the seven page artifacts behind the
 * freshness gate, and `publish` writes the rendered pages to the serving
 * node, preferring a local filesystem write and falling back to ssh.
 */
export const model = {
  type: "@magistr/anilist-chart",
  version: "2026.08.19.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      fromVersion: "2026.08.01.1",
      toVersion: "2026.08.02.1",
      description:
        "Real-fix LB1-LB7; adds two DEFAULTED global args (sshTimeoutMs, " +
        "clickhouseMaxResponseBytes) whose defaults preserve every existing config",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    settings: {
      description:
        "Resolved render settings (topK, bayes m, penalty rate, user count); no secrets.",
      schema: SettingsSchema,
      lifetime: "30d",
      garbageCollection: 5,
    },
    renderedPage: {
      description:
        "One rendered static artifact (board, landing, a genre chart, or the bayes JSON), keyed by kind.",
      schema: RenderedPageSchema,
      // Weekly cadence: keep each page well past a run so a stale page is
      // observable between runs (NOT the 1h default the sibling reads use).
      lifetime: "45d",
      garbageCollection: 7,
    },
    renderRun: {
      description:
        "Per-run summary marker: freshness verdict, published/refused/failed pages, anomalies.",
      lifetime: "90d",
      garbageCollection: 20,
      schema: RenderRunSchema,
    },
    publishRun: {
      description:
        "Per-publish marker: which rendered pages were written to the serving node, which failed, which were missing.",
      lifetime: "90d",
      garbageCollection: 20,
      schema: PublishRunSchema,
    },
  },
  methods: {
    settings: {
      description:
        "Echo the resolved render settings from global arguments. Makes no external calls; useful for verifying configuration before a render run.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const g = (context.globalArgs ?? {}) as Record<string, unknown>;
        const writeResource = writeResourceOf(context);
        const users = Array.isArray(g.userNames) ? g.userNames : [];
        const handle = await writeResource("settings", "main", {
          clickhouseDatabase: (g.clickhouseDatabase as string) ?? "default",
          clickhouseConfigured: Boolean(g.clickhouseUrl && g.clickhouseUser),
          userCount: users.length,
          topK: (g.topK as number) ?? 13,
          bayesMinVotes: (g.bayesMinVotes as number) ?? 5,
          penaltyRate: (g.penaltyRate as number) ?? 0.05,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    publish: {
      description:
        "Write the rendered pages from the renderedPage artifacts onto the serving node over SSH. Each file is written atomically (temp + rename) and one failing page never suppresses the rest, so a broken write never leaves a half-served page.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const g = (context.globalArgs ?? {}) as Record<string, unknown>;
        const writeResource = writeResourceOf(context);
        const readResource = context.readResource as
          | ((name: string) => Promise<unknown>)
          | undefined;
        const now = new Date();

        const host = g.nodeHost as string | undefined;
        const dir = g.outputDir as string | undefined;
        const user = (g.nodeUser as string) ?? "root";
        const target = `${user}@${host ?? "?"}:${dir ?? "?"}`;
        const sshTimeoutMs = (g.sshTimeoutMs as number) ?? 30000;

        if (!host || !dir || !readResource) {
          const handle = await writeResource("publishRun", "publish-run", {
            timestamp: nowIso(now),
            ok: false,
            target,
            published: [],
            failed: [],
            missing: [
              !host || !dir
                ? "nodeHost/outputDir not configured"
                : "no readResource in context",
            ],
          });
          return { dataHandles: [handle] };
        }

        // Collect the pages that were actually rendered; a page with no artifact
        // (never rendered, or refused this run) is reported missing, not written.
        const pages: PublishPage[] = [];
        const missing: string[] = [];
        for (const key of Object.keys(PAGE_FILES)) {
          const art = await readResource(key).catch(() => null);
          const html = (art as { html?: unknown } | null)?.html;
          if (typeof html === "string" && html.length > 0) {
            pages.push({ key, content: html });
          } else {
            missing.push(key);
          }
        }

        // Prefer a direct filesystem write when the output dir is on this host
        // (the scheduled run lives in the serve container with the dir mounted);
        // fall back to SSH when it is not (e.g. a manual run from a laptop). The
        // serve container has no `ssh` binary, so SSH-only silently loses every
        // page there — the local path is what makes the weekly run publish.
        let dirLocal = false;
        try {
          const st = await Deno.stat(dir);
          dirLocal = st.isDirectory;
        } catch {
          dirLocal = false;
        }

        const result = await publishPages(pages, async (file, content) => {
          if (dirLocal) {
            const tmp = `${dir}/.${file}.tmp`;
            await Deno.writeTextFile(tmp, content);
            await Deno.rename(tmp, `${dir}/${file}`); // atomic swap
            return;
          }
          // Bound the whole spawn/write/output round-trip: a hung ssh (dead
          // network, stuck host key prompt despite BatchMode) must not block
          // publish() forever. AbortController + setTimeout + clearTimeout
          // (NOT AbortSignal.timeout) so a fast success cancels the pending
          // timer instead of leaving it to fire after the fact.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), sshTimeoutMs);
          try {
            const child = new Deno.Command("ssh", {
              args: [
                "-o",
                "BatchMode=yes",
                `${user}@${host}`,
                remoteWriteCommand(dir, file),
              ],
              stdin: "piped",
              stdout: "piped",
              stderr: "piped",
              signal: controller.signal,
            }).spawn();
            const w = child.stdin.getWriter();
            await w.write(new TextEncoder().encode(content));
            await w.close();
            const out = await child.output();
            if (out.code !== 0) {
              throw new Error(
                `ssh exit ${out.code}: ${
                  new TextDecoder().decode(out.stderr).trim()
                }`,
              );
            }
          } finally {
            clearTimeout(timer);
          }
        });

        const failures = [
          ...result.failed.map((f) => `${f.key}: ${f.error}`),
          ...result.skipped.map((k) => `${k}: no filename mapping`),
        ];
        const handle = await writeResource("publishRun", "publish-run", {
          timestamp: nowIso(now),
          ok: failures.length === 0 && result.published.length > 0,
          target: `${dirLocal ? "local" : "ssh"} ${target}`,
          published: result.published,
          failed: failures,
          missing,
        });
        // Fail LOUD: a scheduled run that writes zero pages, or leaves any page
        // stale, must surface as a failed workflow step, not a silent success.
        if (result.published.length === 0 || failures.length > 0) {
          throw new Error(
            `publish incomplete: ${result.published.length} written, ${failures.length} failed [${
              failures.join("; ")
            }]`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    render: {
      description:
        "Render all six pages (seven artifacts) from ClickHouse and publish every one that passes the freshness gate and the publish backstop. One failing page never suppresses the rest; refused/failed pages are reported in the run marker.",
      arguments: z.object({
        topK: z.number().int().positive().default(13).describe(
          "Rows per genre; threaded into BOTH the chart compute and the landing copy.",
        ),
        bayesMinVotes: z.number().int().nonnegative().default(5).describe(
          "Bayesian prior weight m; threaded into the /bayes chart.",
        ),
      }),
      execute: async (args: unknown, context: Ctx) => {
        const a = (args ?? {}) as { topK?: number; bayesMinVotes?: number };
        const g = (context.globalArgs ?? {}) as Record<string, unknown>;
        const writeResource = writeResourceOf(context);
        const readResource = context.readResource as
          | ((name: string) => Promise<unknown>)
          | undefined;

        const topK = a.topK ?? (g.topK as number) ?? 13;
        const bayesMinVotes = a.bayesMinVotes ?? (g.bayesMinVotes as number) ??
          5;
        const penaltyRate = (g.penaltyRate as number) ?? 0.05;
        const userNames =
          (Array.isArray(g.userNames) ? g.userNames : []) as string[];
        const now = new Date();

        const cfg = configFrom(g);
        if (!cfg) {
          const handle = await writeResource("renderRun", "render-run", {
            timestamp: nowIso(now),
            ok: false,
            refuseReason:
              "ClickHouse is not configured (need clickhouseUrl/User/Key global args).",
            published: [],
            refused: [],
            failed: [],
            anomalies: [],
            topK,
            bayesMinVotes,
          });
          return { dataHandles: [handle] };
        }

        const client = new ClickHouseClient(cfg);
        const db = cfg.database;
        const win = seasonWindow(now);
        const N = (v: unknown) => Number(v ?? 0);

        // ── reads ─────────────────────────────────────────────────────────
        // The 11 reads (board, chartScores, distinctIds, chartMeta, six
        // landing aggregates, freshness) plus the pure freshness-input
        // computation are wrapped in ONE try/catch: any read throwing (a
        // non-200 response, a malformed-JSONEachRow parse error, a 200-status
        // inline exception) previously escaped execute() with NO diagnostic
        // marker at all. Now the marker is always written on the way out —
        // write-then-rethrow, mirroring publish()'s existing fail-loud guard —
        // so the workflow step still fails AND a `renderRun` marker survives
        // for `swamp report get`/`swamp data get` to inspect (LB1).
        let boardRows: RawBoardRow[];
        let chartScores: RawChartScore[];
        let chartMeta: RawChartMeta[];
        let landing: LandingStats;
        let priorRunExists = false;
        let coverage: number;
        let newestDataAgeMs: number | null;
        let newestTimestampMalformed = false;

        try {
          boardRows = await client.query<RawBoardRow>(boardQuery(db));
          chartScores = await client.query<RawChartScore>(
            chartScoresQuery(db),
            { names: arrayStringParam(userNames) },
          );
          const idRows = await client.query<{ media_id: number | string }>(
            distinctMediaIdsQuery(db),
            { names: arrayStringParam(userNames) },
          );
          // LB5: a corrupt/non-numeric media_id (Number(...) -> NaN) is
          // dropped here rather than sent to ClickHouse as the poisoned
          // literal array element "NaN" (arrayIntParam now throws on it
          // defensively too, but filtering means that throw never fires in
          // practice). Empty `ids` still routes through the `[]` branch below.
          const ids = idRows.map((r) => Number(r.media_id)).filter(
            Number.isFinite,
          );
          chartMeta = ids.length === 0 ? [] : await client.query<
            RawChartMeta
          >(chartMetadataQuery(db), { ids: arrayIntParam(ids) });

          const lq = landingQueries(db);
          const totals = (await client.query(lq.totals))[0] as Record<
            string,
            unknown
          >;
          const titles = (await client.query(lq.titles))[0] as Record<
            string,
            unknown
          >;
          const genres = (await client.query(lq.genres))[0] as Record<
            string,
            unknown
          >;
          const cur = (await client.query(lq.currentSeason, {
            seasonStart: win.start,
            seasonEnd: win.end,
          }))[0] as Record<string, unknown>;
          const movies = (await client.query(lq.movies))[0] as Record<
            string,
            unknown
          >;
          const years = (await client.query(lq.years))[0] as Record<
            string,
            unknown
          >;

          landing = {
            users: N(totals?.users),
            rows: N(totals?.rows),
            rated: N(totals?.rated),
            titles: N(titles?.titles),
            genres: N(genres?.genres),
            cur_titles: N(cur?.cur_titles),
            cur_users: N(cur?.cur_users),
            movies: N(movies?.movies),
            y_min: N(years?.y_min),
            y_max: N(years?.y_max),
            season: win.label,
          };

          // ── freshness gate reads ──────────────────────────────────────
          if (readResource) {
            try {
              priorRunExists = Boolean(
                await readResource("render-run"),
              );
            } catch {
              priorRunExists = false;
            }
          }
          const referenced = new Set(ids);
          const withMeta = new Set(chartMeta.map((m) => Number(m.media_id)));
          coverage = referenced.size === 0
            ? 1
            : [...referenced].filter((id) => withMeta.has(id)).length /
              referenced.size;

          // max(last_updated) on user_scores -> corpus age, so a frozen
          // ingest is surfaced as an anomaly rather than silently served.
          // Parsed as UTC; a few hours of tz skew is irrelevant against a
          // multi-week stale window.
          const freshRow =
            (await client.query<{ newest?: string }>(freshnessQuery(db)))[0];
          const newestRaw = freshRow?.newest;
          const newestPresent = newestRaw != null &&
            !newestRaw.startsWith("0000");
          const newestMs = newestPresent
            ? Date.parse(String(newestRaw).replace(" ", "T") + "Z")
            : NaN;
          newestDataAgeMs = Number.isFinite(newestMs)
            ? now.getTime() - newestMs
            : null;
          // LB4: distinguish "raw present but unparseable" from "genuinely
          // absent" so a garbage timestamp surfaces as an anomaly instead of
          // silently disabling the staleness check (evaluateFreshness only
          // fires staleness when newestDataAgeMs !== null).
          newestTimestampMalformed = newestPresent &&
            !Number.isFinite(newestMs);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await writeResource("renderRun", "render-run", {
            timestamp: nowIso(now),
            ok: false,
            refuseReason: `read failed: ${msg}`,
            published: [],
            refused: [],
            failed: [],
            anomalies: [msg],
            topK,
            bayesMinVotes,
          });
          throw e;
        }

        const verdict = evaluateFreshness({
          scoreRowCount: landing.rows,
          metadataRowCount: landing.titles,
          metadataCoverage: coverage,
          newestDataAgeMs,
          newestTimestampMalformed,
          priorRunExists,
        });

        if (!verdict.ok) {
          const handle = await writeResource("renderRun", "render-run", {
            timestamp: nowIso(now),
            ok: false,
            refuseReason: verdict.refuseReason,
            published: [],
            refused: [],
            failed: [],
            anomalies: verdict.anomalies,
            topK,
            bayesMinVotes,
          });
          return { dataHandles: [handle] };
        }

        // ── fan-out + publish ─────────────────────────────────────────────
        const { tasks, warn } = buildRenderTasks({
          boardRows,
          boardNrows: landing.rows,
          chartScores,
          chartMeta,
          landing,
          topK,
          bayesMinVotes,
          penaltyRate,
          now,
        });
        const result: FanOutResult = runFanOut(tasks);

        const handles: unknown[] = [];
        for (const page of result.published) {
          handles.push(
            await writeResource("renderedPage", page.key, {
              page: page.key,
              html: page.html,
              bytes: page.html.length,
              recordCount: page.recordCount,
              skipped: page.skipped ?? [],
              timestamp: nowIso(now),
            }),
          );
        }

        const anomalies = [
          ...verdict.anomalies,
          ...warn.skips,
          ...warn.curated,
          ...result.refused.map((r) =>
            `refused ${r.key}: ${r.reasons.join("; ")}`
          ),
          ...result.failed.map((f) => `failed ${f.key}: ${f.error}`),
        ];
        handles.push(
          await writeResource("renderRun", "render-run", {
            timestamp: nowIso(now),
            ok: true,
            refuseReason: null,
            published: result.published.map((p) => p.key),
            refused: result.refused.map((r) => r.key),
            failed: result.failed.map((f) => f.key),
            anomalies,
            topK,
            bayesMinVotes,
          }),
        );

        return { dataHandles: handles };
      },
    },
  },
};
