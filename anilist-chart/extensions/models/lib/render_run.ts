// Orchestration for the render run: the SIMPLE freshness gate, the fan-out that
// keeps one failing page from suppressing the rest, and the pure glue that turns
// raw ClickHouse rows into the shapes the render modules and the board compute
// consume. Everything here is pure and dependency-injected so it tests under the
// flagless `test` task; the model entry (anilist_chart.ts) supplies the real
// ClickHouse reads and resource writes.

import type { Row } from "./rankable.ts";
import {
  buildFinalChartData,
  type ChartMode,
  type Rankable,
  rankGenre,
} from "./chart_rank.ts";
import {
  bayesFormatEligible,
  bayesianRating,
  globalAverageC,
} from "./bayesian.ts";
import {
  agePenaltyFactor,
  currentSeasonInfo,
  penalizedScore,
  type Season,
  seasonFromMonth,
} from "./age_penalty.ts";
import type { ChartRow } from "./render_charts.ts";
import { findUnpublishable } from "./publish_gate.ts";

// ── freshness gate (plan v11 step 9) ─────────────────────────────────────────
// A read-only boundary cannot corrupt data, so this is deliberately light: it
// refuses to publish ONLY when there is nothing usable to render, and otherwise
// renders whatever exists and LOGS anomalies. It is NOT the deleted v10
// provenance gate (there is no runId column and the CH user is read-only).

export const STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30d, outlives weekly
export const COVERAGE_TOLERANCE = 0.9; // below this -> anomaly (never a refusal)

export interface FreshnessInput {
  scoreRowCount: number;
  metadataRowCount: number;
  /** referenced media_ids that have metadata / referenced media_ids, 0..1. */
  metadataCoverage: number;
  /** now - max(last_updated) in ms; null when unknown. */
  newestDataAgeMs: number | null;
  /**
   * True when a freshness timestamp WAS present but failed to parse (as
   * opposed to genuinely absent). Optional and falsey by default so existing
   * callers/tests are unaffected; when true, the gap is surfaced as an
   * anomaly instead of silently skipping the staleness check (LB4).
   */
  newestTimestampMalformed?: boolean;
  /** false on the very first run (no prior run marker yet). */
  priorRunExists: boolean;
  staleWindowMs?: number;
  coverageTolerance?: number;
}

export interface FreshnessVerdict {
  ok: boolean;
  refuseReason: string | null;
  anomalies: string[];
}

export function evaluateFreshness(input: FreshnessInput): FreshnessVerdict {
  const anomalies: string[] = [];
  const staleWindow = input.staleWindowMs ?? STALE_WINDOW_MS;
  const tolerance = input.coverageTolerance ?? COVERAGE_TOLERANCE;

  // No usable data at all -> refuse (an empty board/landing is worse than none).
  if (input.scoreRowCount === 0) {
    return {
      ok: false,
      refuseReason: "no score rows in user_scores",
      anomalies,
    };
  }

  // Empty metadata: fatal on a normal run, EXEMPT on the first run (the ingest
  // may not have populated metadata yet). 47 media_ids legitimately lack
  // metadata forever, so this only fires on TOTALLY empty metadata.
  if (input.metadataRowCount === 0) {
    if (input.priorRunExists) {
      return {
        ok: false,
        refuseReason: "metadata is empty on a non-first run",
        anomalies,
      };
    }
    anomalies.push("metadata empty on first run; rendering anyway (exempt)");
  }

  // Staler than a wide window is an ANOMALY, never a refusal: the corpus is
  // frozen (ingest likely stalled), but last-known-good scores still render a
  // correct board, and refusing would WEDGE publication — the exact failure this
  // gate is built to avoid. Surface it loudly instead of serving it silently.
  if (input.newestDataAgeMs !== null && input.newestDataAgeMs > staleWindow) {
    anomalies.push(
      `newest data is ${Math.round(input.newestDataAgeMs / 86400000)}d old, ` +
        `past the ${Math.round(staleWindow / 86400000)}d window; ` +
        `publishing last-known-good`,
    );
  }

  // Low coverage is an ANOMALY, never a refusal (ratio-vs-tolerance).
  if (input.metadataCoverage < tolerance) {
    anomalies.push(
      `metadata coverage ${(input.metadataCoverage * 100).toFixed(1)}% below ` +
        `${(tolerance * 100).toFixed(0)}% tolerance`,
    );
  }

  // A timestamp that was present but unparseable is an ANOMALY (LB4): the
  // gap in the staleness check must be SIGNALLED, not silent, even though it
  // never blocks publication (a genuinely stale-but-parseable corpus is
  // handled by the branch above).
  if (input.newestTimestampMalformed) {
    anomalies.push(
      "freshness timestamp unparseable; staleness check skipped",
    );
  }

  return { ok: true, refuseReason: null, anomalies };
}

// ── fan-out (plan v11 step 10) ───────────────────────────────────────────────
// run.sh exists precisely to replace the a&&b&&c chain that aborted the rest;
// this mirrors it. Every task runs; a throwing task is reported and the others
// still produce artifacts. A produced page is then run through the publish
// backstop: clean pages publish, dirty pages are refused (and reported).

export interface PageRender {
  key: string;
  html: string;
  recordCount?: number;
  skipped?: string[];
}

export interface FanOutResult {
  published: PageRender[];
  refused: { key: string; reasons: string[] }[];
  failed: { key: string; error: string }[];
}

/**
 * Run each task in order (order matters: a later task may read a value an
 * earlier one set in a shared closure, e.g. the landing reading the board's
 * recordCount). A task that throws is caught and reported; the rest continue.
 */
export function runFanOut(
  tasks: { key: string; render: () => PageRender }[],
  gate: (html: string) => string[] = findUnpublishable,
): FanOutResult {
  const published: PageRender[] = [];
  const refused: { key: string; reasons: string[] }[] = [];
  const failed: { key: string; error: string }[] = [];

  for (const task of tasks) {
    let page: PageRender;
    try {
      page = task.render();
    } catch (e) {
      failed.push({
        key: task.key,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const reasons = gate(page.html);
    if (reasons.length > 0) refused.push({ key: task.key, reasons });
    else published.push(page);
  }

  return { published, refused, failed };
}

// ── raw ClickHouse row coercion ──────────────────────────────────────────────
// JSONEachRow serialises Int64 as strings to protect JS precision, so numeric
// columns arrive as strings; coerce defensively at the boundary.

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export interface RawBoardRow {
  user_name: string;
  media_id: number | string;
  score: number | string | null;
  title_romaji?: string | null;
  title_english?: string | null;
  genres?: string[] | null;
  start_year?: number | string | null;
  format?: string | null;
  episodes?: number | string | null;
  duration?: number | string | null;
  average_score?: number | string | null;
  popularity?: number | string | null;
  cover_image_large?: string | null;
}

/** One boardQuery row -> the board compute's Row (rankable.ts). */
export function mapBoardRow(raw: RawBoardRow): Row {
  return {
    user: raw.user_name,
    media_id: Number(raw.media_id),
    score: num(raw.score) ?? 0,
    romaji: str(raw.title_romaji),
    english: str(raw.title_english),
    genres: Array.isArray(raw.genres) ? raw.genres : null,
    year: num(raw.start_year),
    format: str(raw.format),
    episodes: num(raw.episodes),
    duration: num(raw.duration),
    world: num(raw.average_score),
    popularity: num(raw.popularity),
    cover: str(raw.cover_image_large),
  };
}

// ── chart aggregation glue ───────────────────────────────────────────────────
// process_data() from the four chart scripts, unified. Aggregates score>0 rows
// per media into (avg, votes), joins metadata, fans to genres, enriches per
// mode, ranks per genre, and de-duplicates via buildFinalChartData.

export interface RawChartScore {
  user_name?: string;
  media_id: number | string;
  score: number | string | null;
}

export interface RawChartMeta {
  media_id: number | string;
  title_romaji?: string | null;
  title_english?: string | null;
  genres?: string[] | null;
  format?: string | null;
  start_year?: number | string | null;
  start_date?: string | null;
  cover_image_large?: string | null;
}

export interface ChartParams {
  mode: ChartMode;
  topK: number;
  now?: Date;
  penaltyRate?: number;
  minVotes?: number; // bayes m
}

export interface ChartAggregation {
  /** genre -> full ranked list (pre-dedup); feeds renderBayesJson. */
  genreMap: Record<string, Rankable[]>;
  /** genre -> topK slots after cross-genre dedup; feeds renderChart. */
  final: Record<string, (Rankable | null)[]>;
  /** global mean vote C over the score>0 corpus (the /bayes prior + info line). */
  globalC: number;
}

function chartTitle(meta: RawChartMeta): string {
  return str(meta.title_romaji) || str(meta.title_english) ||
    `Unknown (ID: ${meta.media_id})`;
}

/**
 * A title is eligible for THIS chart. chart/current/fresh drop only explicit
 * MOVIE (a null format survives, matching `metadata.get('format') == 'MOVIE'`);
 * bayes drops MOVIE and null (bayesFormatEligible, matching the SQL
 * `format != 'MOVIE'` on a Nullable column).
 */
function eligible(mode: ChartMode, format: string | null): boolean {
  if (mode === "bayes") return bayesFormatEligible(format);
  return format !== "MOVIE";
}

/** True when a title's start_date lands in the current anime season (current chart). */
function inCurrentSeason(
  startDate: string | null,
  season: Season,
  year: number,
): boolean {
  if (!startDate) return false;
  const m = Number(startDate.slice(5, 7));
  const y = Number(startDate.slice(0, 4));
  if (!Number.isFinite(m) || !Number.isFinite(y)) return false;
  return seasonFromMonth(m) === season && y === year;
}

export function aggregateGenres(
  scores: RawChartScore[],
  metadata: RawChartMeta[],
  params: ChartParams,
): ChartAggregation {
  const { mode, topK } = params;
  const now = params.now ?? new Date();
  const rate = params.penaltyRate;
  const m = params.minVotes ?? 5;
  const { season, year } = currentSeasonInfo(now);

  const metaById = new Map<number, RawChartMeta>();
  for (const meta of metadata) metaById.set(Number(meta.media_id), meta);

  // Aggregate score>0 rows per media; collect the corpus for the bayes prior C.
  const agg = new Map<number, { sum: number; count: number }>();
  const corpus: number[] = [];
  for (const s of scores) {
    const sc = num(s.score);
    if (sc === null || sc <= 0) continue;
    corpus.push(sc);
    const id = Number(s.media_id);
    const cur = agg.get(id) ?? { sum: 0, count: 0 };
    cur.sum += sc;
    cur.count += 1;
    agg.set(id, cur);
  }
  const c = globalAverageC(corpus);

  const genreMap: Record<string, Rankable[]> = {};
  for (const [id, { sum, count }] of agg) {
    if (count === 0) continue;
    const meta = metaById.get(id);
    if (!meta) continue;
    if (!eligible(mode, str(meta.format))) continue;
    if (
      mode === "current" && !inCurrentSeason(str(meta.start_date), season, year)
    ) {
      continue;
    }

    const avg = sum / count;
    const startYear = num(meta.start_year);
    const rowBase: ChartRow = {
      media_id: id,
      title: chartTitle(meta),
      votes: count,
      average_score: avg,
      cover_url: str(meta.cover_image_large),
    };
    if (mode === "fresh") {
      rowBase.start_year = startYear;
      rowBase.age_penalty_factor = agePenaltyFactor(
        startYear,
        season,
        year,
        rate,
      );
      rowBase.penalized_score = penalizedScore(
        avg,
        startYear,
        season,
        year,
        rate,
      );
    } else if (mode === "bayes") {
      rowBase.bayesian_rating = bayesianRating(avg, count, m, c);
    }

    for (const g of Array.isArray(meta.genres) ? meta.genres : []) {
      (genreMap[g] ??= []).push(rowBase);
    }
  }

  const ranked: Record<string, Rankable[]> = {};
  for (const [g, list] of Object.entries(genreMap)) {
    ranked[g] = rankGenre(list, mode);
  }

  return {
    genreMap: ranked,
    final: buildFinalChartData(ranked, topK),
    globalC: c,
  };
}

// ── season window for the landing (generate_landing.season_window) ───────────

const RU_SEASON = ["зима", "весна", "лето", "осень"];

export interface SeasonWindow {
  /** YYYY-MM-DD, inclusive lower bound. */
  start: string;
  /** YYYY-MM-DD, exclusive upper bound. */
  end: string;
  /** e.g. "лето 2026". */
  label: string;
}

function ymd(y: number, mon1: number, day: number): string {
  return `${y}-${String(mon1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
}

export function seasonWindow(now: Date = new Date()): SeasonWindow {
  const y = now.getFullYear();
  const q = Math.floor((now.getMonth() + 1 - 1) / 3); // 0..3
  const start = ymd(y, q * 3 + 1, 1);
  const endYear = y + (q === 3 ? 1 : 0);
  const endMonth = ((q + 1) % 4) * 3 + 1;
  const end = ymd(endYear, endMonth, 1);
  return { start, end, label: `${RU_SEASON[q]} ${y}` };
}
