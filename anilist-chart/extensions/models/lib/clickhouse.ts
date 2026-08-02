// Read-only ClickHouse HTTP client for the render path.
//
// This client ONLY READS. Every write (ingest of scores + metadata) lives in
// the @anilist/api model under a separate, write-capable ClickHouse user; the
// render user should be provisioned read-only server-side. Auth is by header
// (X-ClickHouse-User / X-ClickHouse-Key), the SQL travels in the POST body, and
// bound values travel as `param_<name>` query parameters so user input never
// concatenates into SQL. Table/database identifiers cannot be parameterized, so
// they pass through a strict allowlist. Every request is bounded by
// AbortSignal.timeout, and every response body read is bounded by
// maxResponseBytes (streamed, capped early rather than fully buffered first).

export interface ClickHouseConfig {
  url: string; // http(s)://host:port
  user: string;
  key: string;
  database: string;
  timeoutMs?: number;
  /** Cap on the total bytes read from a query response body; defaults to 64MiB
   * in `query()`. Exceeding it aborts the read early (streamed, not buffered
   * first) rather than exhausting memory on an unbounded/misbehaving upstream. */
  maxResponseBytes?: number;
}

/** Read config from the environment (needs --allow-env). Throws if incomplete. */
export function configFromEnv(): ClickHouseConfig {
  const url = Deno.env.get("CLICKHOUSE_URL");
  const user = Deno.env.get("CLICKHOUSE_USER");
  const key = Deno.env.get("CLICKHOUSE_KEY");
  const database = Deno.env.get("CLICKHOUSE_DATABASE") ?? "default";
  if (!url || !user || key === undefined) {
    throw new Error(
      "ClickHouse config missing: set CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_KEY (CLICKHOUSE_DATABASE optional).",
    );
  }
  return { url, user, key, database };
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Allowlist a SQL identifier (db/table/column). Throws on anything else. */
export function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Format a string array as a ClickHouse HTTP param value for Array(String).
 * Order matters: the backslash-doubling pass must run BEFORE the quote and
 * NUL passes, so neither of their inserted backslashes is itself doubled.
 */
export function arrayStringParam(values: string[]): string {
  return "[" +
    values
      .map((v) =>
        "'" +
        v
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/\0/g, "\\0") +
        "'"
      )
      .join(",") +
    "]";
}

/**
 * Format a number array as a ClickHouse HTTP param value for Array(Int64).
 * Throws on a non-finite input (NaN/+-Infinity) rather than letting
 * `Math.trunc` pass it straight through to `String()`, which would otherwise
 * emit the literal (invalid) array element "NaN"/"Infinity"/"-Infinity".
 * Callers should filter non-finite ids before building the array (see
 * render()'s `.filter(Number.isFinite)`); this is defense-in-depth so the
 * poisoned literal can never be constructed even by a future caller.
 */
export function arrayIntParam(values: number[]): string {
  return "[" +
    values.map((v) => {
      if (!Number.isFinite(v)) {
        throw new Error(`arrayIntParam: non-finite value: ${v}`);
      }
      return String(Math.trunc(v));
    }).join(",") +
    "]";
}

/**
 * Read a Response body as text, but abort the read early once the running
 * byte total exceeds `maxBytes` -- freeing the partial buffer and cancelling
 * the underlying stream rather than fully buffering an unbounded or
 * misbehaving upstream body first (LB3). Falls back to `res.text()` on a
 * runtime that gives no readable stream (`res.body` null), which a real fetch
 * response with a body never does.
 */
async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`ClickHouse response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

export class ClickHouseClient {
  private readonly cfg: ClickHouseConfig;

  constructor(cfg: ClickHouseConfig) {
    assertIdent(cfg.database);
    this.cfg = cfg;
  }

  get database(): string {
    return this.cfg.database;
  }

  /**
   * Run a read query and parse JSONEachRow. `FORMAT JSONEachRow` is appended
   * here; callers pass SQL without a FORMAT clause. `params` are bound as
   * `param_<name>` (use arrayStringParam / arrayIntParam for array values).
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: Record<string, string | number> = {},
  ): Promise<T[]> {
    const u = new URL(this.cfg.url);
    for (const [k, v] of Object.entries(params)) {
      u.searchParams.set(`param_${k}`, String(v));
    }
    const res = await fetch(u, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": this.cfg.user,
        "X-ClickHouse-Key": this.cfg.key,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: sql + "\nFORMAT JSONEachRow",
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    const maxBytes = this.cfg.maxResponseBytes ?? 64 * 1024 * 1024;
    const text = await readCappedText(res, maxBytes);
    if (!res.ok) {
      // Trim + redact: at most 200 chars, whitespace runs collapsed, and the
      // configured key defensively stripped even though a CH error body never
      // legitimately contains it (belt-and-braces against a future CH change).
      const trimmed = text.slice(0, 200).replace(/\s+/g, " ").trim();
      const redacted = trimmed.replaceAll(this.cfg.key, "[redacted]");
      throw new Error(`ClickHouse ${res.status}: ${redacted}`);
    }
    const out: T[] = [];
    for (const line of text.split("\n")) {
      if (line.length > 0) out.push(JSON.parse(line) as T);
    }
    return out;
  }

  /** Connectivity probe. */
  async ping(): Promise<boolean> {
    const rows = await this.query<{ one: number }>("SELECT 1 AS one");
    return rows.length === 1;
  }

  /** DESCRIBE TABLE <db>.<table> -> column descriptors (name, type, ...). */
  async describeTable(
    table: string,
  ): Promise<{ name: string; type: string }[]> {
    const db = assertIdent(this.cfg.database);
    const t = assertIdent(table);
    return await this.query<{ name: string; type: string }>(
      `DESCRIBE TABLE ${db}.${t}`,
    );
  }
}

// ── expected schema (MEASURED, plan v11) ─────────────────────────────────────
// The live column-parity test in clickhouse.test.ts reads DESCRIBE TABLE and
// asserts these are present — real drift detection, not a constant compare.
export const EXPECTED_METADATA_COLUMNS = [
  "media_id",
  "title_romaji",
  "title_english",
  "title_native",
  "genres",
  "tags",
  "start_year",
  "start_date",
  "end_date",
  "format",
  "status",
  "episodes",
  "duration",
  "average_score",
  "popularity",
  "studios",
  "cover_image_large",
  "last_updated",
] as const;

export const EXPECTED_SCORE_COLUMNS = [
  "user_name",
  "media_id",
  "score",
  "last_updated",
] as const;

// ── the real query families ──────────────────────────────────────────────────
// Both tables are ReplacingMergeTree(last_updated). The render runs right after
// the ingest re-inserts everything, so any read that COUNTS votes must dedupe
// with FINAL, or a title briefly shows doubled votes. The oracle's board and
// landing already use FINAL; the four charts historically did NOT — the port
// ADDS FINAL to the chart score reads. NOTE: adding FINAL to the chart score
// reads is expected to move vote counts DOWN on the first human read (duplicate
// pre-merge rows stop being double-counted).

/** Board: one flat pull, no user filter, FINAL on both sides (generate_board.py:121). */
export function boardQuery(db: string): string {
  const d = assertIdent(db);
  return `SELECT
    s.user_name, s.media_id, s.score,
    m.title_romaji, m.title_english, m.genres,
    m.start_year, m.format, m.episodes, m.duration,
    m.average_score, m.popularity, m.cover_image_large
  FROM (SELECT user_name, media_id, score
        FROM ${d}.user_scores FINAL) AS s
  LEFT JOIN (SELECT media_id, title_romaji, title_english, genres,
                    start_year, format, episodes, duration,
                    average_score, popularity, cover_image_large
             FROM ${d}.anilist_metadata FINAL) AS m
  USING media_id`;
}

/** Landing's six aggregate reads (generate_landing.py:69-98), all FINAL. */
export function landingQueries(db: string): {
  totals: string;
  titles: string;
  genres: string;
  currentSeason: string;
  movies: string;
  years: string;
} {
  const d = assertIdent(db);
  return {
    totals:
      `SELECT uniqExact(user_name) AS users, count() AS rows, countIf(score > 0) AS rated FROM ${d}.user_scores FINAL`,
    titles: `SELECT count() AS titles FROM ${d}.anilist_metadata FINAL`,
    // The ARRAY JOIN is isolated in a subquery: aliasing the outer count AS
    // `genres` while ARRAY JOINing the `genres` column in the same scope makes
    // ClickHouse bind the join source to the output alias and fail on `g`.
    genres:
      `SELECT uniqExact(g) AS genres FROM (SELECT arrayJoin(genres) AS g FROM ${d}.anilist_metadata FINAL)`,
    currentSeason:
      `SELECT uniqExact(s.media_id) AS cur_titles, uniqExact(s.user_name) AS cur_users
      FROM (SELECT user_name, media_id FROM ${d}.user_scores FINAL) AS s
      INNER JOIN (SELECT media_id, start_date FROM ${d}.anilist_metadata FINAL) AS m USING media_id
      WHERE m.start_date >= {seasonStart:Date} AND m.start_date < {seasonEnd:Date}`,
    movies: `SELECT uniqExact(s.media_id) AS movies
      FROM (SELECT media_id, score FROM ${d}.user_scores FINAL) AS s
      INNER JOIN (SELECT media_id, format FROM ${d}.anilist_metadata FINAL) AS m USING media_id
      WHERE s.score > 0 AND m.format = 'MOVIE'`,
    years: `SELECT min(start_year) AS y_min, max(start_year) AS y_max
      FROM ${d}.anilist_metadata FINAL
      WHERE start_year IS NOT NULL AND start_year > 1900`,
  };
}

/**
 * Newest ingest timestamp on user_scores, for the staleness anomaly. No FINAL:
 * max(last_updated) is the newest write regardless of which duplicate row wins
 * the merge, which is exactly the "how fresh is the corpus" signal we want, and
 * FINAL would only add merge cost.
 */
export function freshnessQuery(db: string): string {
  const d = assertIdent(db);
  return `SELECT max(last_updated) AS newest FROM ${d}.user_scores`;
}

/**
 * Chart score read (the four genre charts). ADDS FINAL — this read counts votes,
 * so it must dedupe. Bind {names:Array(String)} via arrayStringParam.
 */
export function chartScoresQuery(db: string): string {
  const d = assertIdent(db);
  return `SELECT user_name, media_id, score
    FROM ${d}.user_scores FINAL
    WHERE user_name IN {names:Array(String)}`;
}

/**
 * DISTINCT media_id enumeration — stays WITHOUT FINAL: DISTINCT already dedupes
 * (matching fetch_metadata.py:381), so FINAL would only add merge cost.
 */
export function distinctMediaIdsQuery(db: string): string {
  const d = assertIdent(db);
  return `SELECT DISTINCT media_id
    FROM ${d}.user_scores
    WHERE user_name IN {names:Array(String)}`;
}

/**
 * Per-chart metadata read. FINAL to take the latest row per title (metadata is
 * ReplacingMergeTree). Bind {ids:Array(Int64)} via arrayIntParam. The MOVIE
 * exclusion for /bayes stays in SQL (see bayesian.ts) — Nullable format means
 * `format != 'MOVIE'` correctly drops null-format rows too.
 */
export function chartMetadataQuery(db: string): string {
  const d = assertIdent(db);
  return `SELECT media_id, title_romaji, title_english, genres, format,
                 start_year, start_date, cover_image_large
    FROM ${d}.anilist_metadata FINAL
    WHERE media_id IN {ids:Array(Int64)}`;
}
