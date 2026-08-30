import { z } from "npm:zod@4";

const ANILIST_API = "https://graphql.anilist.co";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Max consecutive 429 retries before giving up — unattended scheduled runs
// must fail fast rather than retry forever.
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Build a per-invocation AniList GraphQL client. AniList allows 30 req/min
 * (degraded) / 90 req/min (normal); remaining budget is tracked from response
 * headers and slept against pre-flight when needed — but that state lives in
 * this closure, NOT a module-level singleton, so one invocation's
 * low-remaining/future-reset response can never force an unrelated later
 * call (a different method, or the same method on a later run) to
 * pre-flight-sleep. Callers make exactly one `makeGql()` per method
 * invocation and thread the returned client through every `gql()` call (and
 * into `fetchAllPages`/`refreshMetadata`) that invocation makes.
 */
function makeGql(authToken?: string) {
  const rateLimit = { remaining: 30, resetAt: 0 };

  return async function gql(
    query: string,
    variables: Record<string, unknown> = {},
    attempt = 0,
  ) {
    // Pre-flight: if we know we're out of budget, wait for reset
    if (rateLimit.remaining <= 1 && rateLimit.resetAt > Date.now()) {
      const waitMs = rateLimit.resetAt - Date.now() + 500;
      await sleep(waitMs);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    // AniList's degraded mode serves empty activity results to unauthenticated
    // clients — authenticated reads keep working (and see followers-only feeds).
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const response = await fetch(ANILIST_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    // Update rate limit state from headers
    const limitRemaining = response.headers.get("X-RateLimit-Remaining");
    const limitReset = response.headers.get("X-RateLimit-Reset");
    if (limitRemaining !== null) {
      rateLimit.remaining = parseInt(limitRemaining, 10);
    }
    if (limitReset !== null) {
      rateLimit.resetAt = parseInt(limitReset, 10) * 1000;
    }

    // Handle 429 with retry
    if (response.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `AniList rate limit: ${MAX_RATE_LIMIT_RETRIES} retries exhausted`,
        );
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 60;
      await sleep(waitSec * 1000);
      return gql(query, variables, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      // AniList intermittently 5xxs (esp. in degraded mode) — retry transient
      // server errors with a short backoff before giving up. A scheduled run
      // that fails on one 500 loses its whole window (stateless serve runs).
      if (response.status >= 500 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(5_000 * (attempt + 1));
        return gql(query, variables, attempt + 1);
      }
      throw new Error(`AniList API error ${response.status}: ${text}`);
    }

    // Read the body ONCE as text, then guard the parse — mirrors the
    // non-ok text path above, so a WAF/CDN error page served at HTTP 200
    // (non-JSON body) is mapped into a handled AniList-specific error
    // instead of an uncaught SyntaxError.
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `AniList API error: non-JSON 200 response body: ${text.slice(0, 200)}`,
      );
    }
    if (json.errors) {
      // AniList can return 200 with a 429 error in the body. `status` may be
      // a number, a numeric string, or absent entirely with only a
      // rate-limit message in play — match all three so a misshapen error
      // body can't silently bypass the dedicated retry path and fall
      // through to the generic errors-throw below.
      const isRateLimited = json.errors.some(
        (e: { status?: unknown; message?: unknown }) => {
          const s = typeof e.status === "string" ? Number(e.status) : e.status;
          if (s === 429) return true;
          const m = String(e.message ?? "").toLowerCase();
          return m.includes("rate limit") || m.includes("too many request");
        },
      );
      if (isRateLimited) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new Error(
            `AniList rate limit: ${MAX_RATE_LIMIT_RETRIES} retries exhausted`,
          );
        }
        await sleep(60_000);
        return gql(query, variables, attempt + 1);
      }
      throw new Error(
        `AniList GraphQL errors: ${
          json.errors.map((e: { message: string }) => e.message).join(", ")
        }`,
      );
    }
    // A 200 with no errors[] but also no data is a hostile/malformed
    // response — every caller derefs `data.<Field>` unconditionally, so
    // guard here rather than let it surface as an uncaught TypeError two or
    // three frames downstream.
    if (json.data == null) {
      throw new Error(
        "AniList API error: 200 response with null data and no errors",
      );
    }
    return json.data;
  };
}

// The client makeGql() returns — threaded explicitly through
// fetchAllPages/refreshMetadata and every method's execute(), never a
// module-level singleton.
type Gql = ReturnType<typeof makeGql>;

const GlobalArgsSchema = z.object({
  mediaType: z.enum(["ANIME", "MANGA"]).default("ANIME").describe(
    "Default media type for queries",
  ),
  accessToken: z.string().meta({ sensitive: true }).optional().describe(
    "AniList personal access token — required for update-progress mutations. Get at: https://anilist.co/settings/developer",
  ),
  // ClickHouse target for the charting ingest pipeline (ingest-scores). Wire
  // the password via a vault reference in the instance globalArguments.
  clickhouseUrl: z.string().optional().describe(
    "ClickHouse HTTP base URL (e.g. http://host:8123) — required for the ingest-scores charting pipeline",
  ),
  clickhouseDatabase: z.string().default("default").describe(
    "ClickHouse database holding anilist_metadata + user_scores",
  ),
  clickhouseUser: z.string().default("default").describe(
    "ClickHouse HTTP user",
  ),
  clickhousePassword: z.string().meta({ sensitive: true }).optional().describe(
    "ClickHouse HTTP password (wire via vault)",
  ),
});

// Shared shape of the runtime context passed to method execute functions.
type ExecContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
};

const MediaSchema = z.object({
  id: z.number(),
  title: z.object({
    romaji: z.string().nullable(),
    english: z.string().nullable(),
    native: z.string().nullable(),
  }),
  format: z.string().nullable(),
  status: z.string().nullable(),
  episodes: z.number().nullable(),
  chapters: z.number().nullable(),
  volumes: z.number().nullable(),
  averageScore: z.number().nullable(),
  meanScore: z.number().nullable(),
  popularity: z.number().nullable(),
  genres: z.array(z.string()),
  seasonYear: z.number().nullable(),
  season: z.string().nullable(),
  startDate: z.object({
    year: z.number().nullable(),
    month: z.number().nullable(),
    day: z.number().nullable(),
  }).nullable(),
  siteUrl: z.string().nullable(),
  description: z.string().nullable(),
  coverImage: z.object({
    large: z.string().nullable(),
  }).nullable(),
}).passthrough();

const MediaListEntrySchema = z.object({
  id: z.number(),
  status: z.string().nullable(),
  score: z.number().nullable(),
  progress: z.number().nullable(),
  repeat: z.number().nullable().describe(
    "Times rewatched. Selected by USERLIST_QUERY so a `repeat` written via update-progress can actually be read back — without it the field reads as absent whether or not the write landed.",
  ),
  media: MediaSchema,
}).passthrough();

const SEARCH_QUERY = `
query ($search: String!, $type: MediaType, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(search: $search, type: $type, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      format status episodes chapters volumes
      averageScore meanScore popularity
      genres seasonYear season
      startDate { year month day }
      siteUrl description
      coverImage { large }
    }
  }
}`;

const DETAILS_QUERY = `
query ($id: Int!) {
  Media(id: $id) {
    id
    title { romaji english native }
    format status episodes chapters volumes
    averageScore meanScore popularity
    genres seasonYear season
    startDate { year month day }
    endDate { year month day }
    siteUrl description
    coverImage { large }
    bannerImage
    studios(isMain: true) { nodes { name } }
    staff(sort: RELEVANCE, perPage: 5) {
      nodes { name { full } }
    }
    relations {
      edges {
        relationType
        node { id title { romaji } type format }
      }
    }
    recommendations(sort: RATING_DESC, perPage: 5) {
      nodes { mediaRecommendation { id title { romaji } averageScore } }
    }
    tags { name rank }
    externalLinks { site url }
    nextAiringEpisode { airingAt episode timeUntilAiring }
  }
}`;

/**
 * NOTE: byte-unchanged query body (still a bare `score`, not the decimal
 * ingest format). Only `export` was added so tests can pin that invariant.
 */
export const USERLIST_QUERY = `
query ($userName: String!, $type: MediaType, $status: MediaListStatus) {
  MediaListCollection(userName: $userName, type: $type, status: $status) {
    lists {
      name status
      entries {
        id status score progress repeat updatedAt
        media {
          id
          title { romaji english native }
          format status episodes chapters volumes
          averageScore meanScore popularity
          genres seasonYear season
          startDate { year month day }
          siteUrl description
          coverImage { large }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Charting ingest queries (ingest-scores) — anchored to the ClickHouse schema.
// `score(format:` and `duration` live ONLY on these two consts.
// ---------------------------------------------------------------------------

/** Per-user scored-list ingest: COMPLETED + CURRENT, decimal score, chunked. */
export const LIST_INGEST_QUERY = `
query ($userName: String, $chunk: Int, $perChunk: Int) {
  MediaListCollection(userName: $userName, type: ANIME, status_in: [COMPLETED, CURRENT], chunk: $chunk, perChunk: $perChunk, sort: SCORE_DESC) {
    lists {
      status
      entries {
        mediaId
        score(format: POINT_10_DECIMAL)
        status
      }
    }
    hasNextChunk
  }
}`;

/**
 * Metadata batch: every source field for the 17 non-default anilist_metadata
 * columns. startDate is selected once and fans out to start_year + start_date
 * downstream.
 */
export const METADATA_INGEST_QUERY = `
query ($ids: [Int], $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(id_in: $ids, type: ANIME, sort: ID) {
      id
      title { romaji english native }
      genres
      tags { name rank isMediaSpoiler }
      startDate { year month day }
      endDate { year month day }
      format
      status
      episodes
      duration
      averageScore
      popularity
      studios(isMain: true) { nodes { name } }
      coverImage { large }
    }
  }
}`;

const WATCHING_QUERY = `
query ($userName: String!) {
  MediaListCollection(userName: $userName, type: ANIME, status: CURRENT) {
    lists {
      entries {
        progress
        media {
          id
          title { romaji english }
          synonyms
          episodes
          status
          nextAiringEpisode { episode airingAt timeUntilAiring }
        }
      }
    }
  }
}`;

const SEASONAL_QUERY = `
query ($season: MediaSeason!, $seasonYear: Int!, $type: MediaType, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: $type, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      format status episodes
      averageScore meanScore popularity
      genres seasonYear season
      startDate { year month day }
      nextAiringEpisode { episode airingAt timeUntilAiring }
      siteUrl
      coverImage { large }
    }
  }
}`;

/** Mutation behind `update-progress`. Exported so tests can pin that $repeat is
 * both declared and forwarded — a declared-but-unforwarded variable is silently
 * ignored by AniList. */
export const UPDATE_PROGRESS_MUTATION = `
mutation ($mediaId: Int!, $progress: Int!, $status: MediaListStatus, $repeat: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status, repeat: $repeat) {
    id mediaId status progress repeat updatedAt
  }
}`;

const SET_SCORE_MUTATION = `
mutation ($mediaId: Int!, $score: Float, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, score: $score, status: $status) {
    id mediaId status score updatedAt
  }
}`;

const TRENDING_QUERY = `
query ($type: MediaType, $sort: [MediaSort], $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(type: $type, sort: $sort) {
      id
      title { romaji english native }
      format status episodes chapters volumes
      averageScore meanScore popularity
      genres seasonYear season
      startDate { year month day }
      siteUrl description
      coverImage { large }
    }
  }
}`;

// Paginate through all pages of a query, collecting media results.
// Caps at maxPages to avoid runaway requests. Takes the caller's `gql`
// client (per-invocation rate-limit state) rather than reaching for a
// module-level one.
async function fetchAllPages(
  gql: Gql,
  query: string,
  variables: Record<string, unknown>,
  maxPages: number,
) {
  const allMedia: unknown[] = [];
  let page = 1;
  let pageInfo;

  do {
    const data = await gql(query, { ...variables, page, perPage: 50 });
    const media = data.Page.media;
    pageInfo = data.Page.pageInfo;
    allMedia.push(...media);
    page++;
  } while (pageInfo.hasNextPage && page <= maxPages);

  return { media: allMedia, pageInfo };
}

// ---------------------------------------------------------------------------
// Charting ingest: ClickHouse HTTP writer + row transforms
// (ingest-scores is the ONLY writer of user_scores / anilist_metadata)
// ---------------------------------------------------------------------------

type ClickHouseConfig = {
  url: string;
  database: string;
  user: string;
  password: string;
};

// INSERT column sets, byte-aligned with the live ClickHouse DDL. Both OMIT
// last_updated so the ReplacingMergeTree DEFAULT now() fires as the version.
const SCORE_COLUMNS = ["user_name", "media_id", "score"];
const METADATA_COLUMNS = [
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
];

function clickhouseConfig(
  g: z.infer<typeof GlobalArgsSchema>,
): ClickHouseConfig {
  if (!g.clickhouseUrl) {
    throw new Error(
      "clickhouseUrl is required in globalArguments for the ingest-scores charting pipeline",
    );
  }
  return {
    url: g.clickhouseUrl.replace(/\/+$/, ""),
    database: g.clickhouseDatabase,
    user: g.clickhouseUser,
    password: g.clickhousePassword ?? "",
  };
}

// POST rows to ClickHouse over the HTTP interface as JSONEachRow. Named-tuple
// columns (tags) need input_format_json_named_tuples_as_objects=1 pinned in
// `settings` so an array of {name,rank,isMediaSpoiler} objects parses.
async function clickhouseInsert(
  cfg: ClickHouseConfig,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  settings: Record<string, string> = {},
): Promise<void> {
  if (rows.length === 0) return;
  const query = `INSERT INTO ${cfg.database}.${table} (${
    columns.join(", ")
  }) FORMAT JSONEachRow`;
  const params = new URLSearchParams({ query, ...settings });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson",
  };
  if (cfg.user) headers["X-ClickHouse-User"] = cfg.user;
  if (cfg.password) headers["X-ClickHouse-Key"] = cfg.password;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const resp = await fetch(`${cfg.url}/?${params.toString()}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(
      `ClickHouse insert into ${table} failed: ${resp.status} ${
        (await resp.text()).slice(0, 300)
      }`,
    );
  }
}

// The distinct media ids in a table. Used two ways: the ingest fetches metadata
// ONLY for score ids absent from anilist_metadata (mirrors fetch_metadata.py:628,
// so it never refetches thousands of unchanged titles and exhausts AniList's rate
// limit), and the refresh-metadata method reads user_scores to find the gap.
async function clickhouseDistinctMediaIds(
  cfg: ClickHouseConfig,
  table: string,
): Promise<Set<number>> {
  const query =
    `SELECT DISTINCT media_id FROM ${cfg.database}.${table} FORMAT TabSeparated`;
  const headers: Record<string, string> = {};
  if (cfg.user) headers["X-ClickHouse-User"] = cfg.user;
  if (cfg.password) headers["X-ClickHouse-Key"] = cfg.password;
  const resp = await fetch(`${cfg.url}/?${new URLSearchParams({ query })}`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(
      `ClickHouse read of media ids from ${table} failed: ${resp.status} ${
        (await resp.text()).slice(0, 300)
      }`,
    );
  }
  const ids = new Set<number>();
  for (const line of (await resp.text()).split("\n")) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

// Read-only SELECT against ClickHouse, parsing a JSONEachRow body. Values are
// bound as ClickHouse query parameters ({name:Type} placeholders) and NEVER
// interpolated into the statement, so a hostile title string cannot alter the
// query. Only the database name is interpolated — it comes from
// globalArguments (operator-controlled), same as the insert path above.
async function clickhouseSelect(
  cfg: ClickHouseConfig,
  sql: string,
  params: Record<string, string> = {},
): Promise<Array<Record<string, unknown>>> {
  const search = new URLSearchParams({ query: sql });
  for (const [k, v] of Object.entries(params)) search.set(`param_${k}`, v);
  const headers: Record<string, string> = {};
  if (cfg.user) headers["X-ClickHouse-User"] = cfg.user;
  if (cfg.password) headers["X-ClickHouse-Key"] = cfg.password;
  const resp = await fetch(`${cfg.url}/?${search}`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(
      `ClickHouse query failed: ${resp.status} ${
        (await resp.text()).slice(0, 300)
      }`,
    );
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of (await resp.text()).split("\n")) {
    const t = line.trim();
    if (t) rows.push(JSON.parse(t) as Record<string, unknown>);
  }
  return rows;
}

/** ClickHouse returns nullable numerics as null and may quote wide ints. */
function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type DateParts = {
  year?: number | null;
  month?: number | null;
  day?: number | null;
};

type RawMedia = {
  id: number;
  title?:
    | {
      romaji?: string | null;
      english?: string | null;
      native?: string | null;
    }
    | null;
  genres?: string[] | null;
  tags?:
    | Array<
      { name?: string | null; rank?: number | null; isMediaSpoiler?: unknown }
    >
    | null;
  startDate?: DateParts | null;
  endDate?: DateParts | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: number | null;
  averageScore?: number | null;
  popularity?: number | null;
  studios?: { nodes?: Array<{ name?: string | null }> | null } | null;
  coverImage?: { large?: string | null } | null;
};

/**
 * Format an AniList {year,month,day} to a ClickHouse Date string, or null.
 * Mirrors fetch_metadata.py:format_date (all three parts present, month/day
 * in range, a real calendar date) PLUS the ClickHouse Date floor of
 * 1970-01-01. Used for both start_date and end_date; a null result never
 * poisons a batch.
 */
export function formatDate(d: DateParts | null | undefined): string | null {
  if (!d) return null;
  const { year, month, day } = d;
  if (
    typeof year !== "number" || typeof month !== "number" ||
    typeof day !== "number"
  ) return null;
  if (
    !Number.isInteger(year) || !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through UTC to reject impossible dates (e.g. Feb 30).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) return null;
  if (year < 1970) return null; // ClickHouse Date floor
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}`;
}

/**
 * Build user_scores rows for one user. CRITICAL: user_name is byte-identical
 * to the caller's spelling (the usernames-file string) — never lowercased,
 * never AniList's canonical casing — because user_scores ORDER BY
 * (user_name, media_id) is case-sensitive and the charts filter user_name IN
 * <file strings>. Keeps numeric scores 0<=s<=10 INCLUDING zero (the
 * ReplacingMergeTree tombstone); drops null / out-of-range.
 */
export function buildScoreRows(
  userName: string,
  entries: Array<{ mediaId?: number | null; score?: number | null }>,
): Array<{ user_name: string; media_id: number; score: number }> {
  const rows: Array<{ user_name: string; media_id: number; score: number }> =
    [];
  for (const e of entries) {
    if (!e || typeof e.mediaId !== "number") continue;
    const s = e.score;
    if (typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 10) {
      rows.push({ user_name: userName, media_id: e.mediaId, score: s });
    }
  }
  return rows;
}

/**
 * All media ids in a user's list, regardless of score (metadata is fetched
 * for every entry seen, not just scored ones), deduped.
 */
export function collectMediaIds(
  entries: Array<{ mediaId?: number | null; score?: number | null }>,
): number[] {
  const ids = new Set<number>();
  for (const e of entries) {
    if (e && typeof e.mediaId === "number") ids.add(e.mediaId);
  }
  return [...ids];
}

/**
 * Map one AniList media object to an anilist_metadata JSONEachRow object.
 * Pre-validated per row: a bad start/end date becomes null (start_year still
 * set from the year alone), so one malformed date can never drop the batch.
 * tags is the named-tuple column: isMediaSpoiler is coerced to 0/1 (UInt8).
 */
export function buildMetadataRow(m: RawMedia): Record<string, unknown> {
  const studios = (m.studios?.nodes ?? [])
    .filter((s): s is { name: string } => !!s && typeof s.name === "string")
    .map((s) => s.name);
  const tags = (m.tags ?? [])
    .filter((t) =>
      !!t && typeof t.name === "string" && typeof t.rank === "number"
    )
    .map((t) => ({
      name: t.name as string,
      rank: t.rank as number,
      isMediaSpoiler: t.isMediaSpoiler ? 1 : 0,
    }));
  const start = m.startDate ?? null;
  return {
    media_id: m.id,
    title_romaji: m.title?.romaji ?? null,
    title_english: m.title?.english ?? null,
    title_native: m.title?.native ?? null,
    genres: m.genres ?? [],
    tags,
    start_year: start && typeof start.year === "number" ? start.year : null,
    start_date: formatDate(start),
    end_date: formatDate(m.endDate ?? null),
    format: m.format ?? null,
    status: m.status ?? null,
    episodes: m.episodes ?? null,
    duration: m.duration ?? null,
    average_score: m.averageScore ?? null,
    popularity: m.popularity ?? null,
    studios,
    cover_image_large: m.coverImage?.large ?? null,
  };
}

// Fetch metadata for a set of media ids (batched at AniList's 50/page cap) and
// upsert into anilist_metadata. Returns the number of rows written. Rows are
// validated by buildMetadataRow before assembly, so a single bad date never
// drops its 50-row batch. Takes the caller's `gql` client (already bound to
// whatever auth token that invocation needs) rather than a module-level one.
async function refreshMetadata(
  gql: Gql,
  cfg: ClickHouseConfig,
  mediaIds: number[],
  batchSize: number,
): Promise<number> {
  let written = 0;
  const sorted = [...mediaIds].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += batchSize) {
    const ids = sorted.slice(i, i + batchSize);
    const d = await gql(
      METADATA_INGEST_QUERY,
      { ids, page: 1, perPage: batchSize },
    );
    const media = (d?.Page?.media ?? []) as RawMedia[];
    const rows = media
      .filter((m) => m && typeof m.id === "number")
      .map((m) => buildMetadataRow(m));
    if (rows.length > 0) {
      await clickhouseInsert(
        cfg,
        "anilist_metadata",
        METADATA_COLUMNS,
        rows,
        { input_format_json_named_tuples_as_objects: "1" },
      );
      written += rows.length;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// recent-activity: pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Telegram's hard per-message character limit; formatActivityMessages
 * chunks output at this boundary. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** One normalized AniList list-activity event, after the raw GraphQL
 * response has been flattened and defaulted (see the mapper in
 * `recent-activity`'s execute). */
export type ActivityItem = {
  id: number;
  createdAt: number;
  userId: number;
  userName: string;
  status: string;
  progress: string | null;
  mediaId: number;
  title: string;
  siteUrl?: string | null;
  score: number | null;
};

/** Per-user dedupe cursor persisted across `recent-activity` runs: the
 * cached AniList userId plus the last delivered activity id / window
 * floor. */
export type ActivityCursor = {
  users: Record<string, {
    userId: number;
    lastSeenActivityId: number;
    lastSeenCreatedAt?: number;
  }>;
};

/**
 * Parse a usernames file: anilist.co profile URLs or bare usernames, one per
 * line. Blank lines and #-comments are skipped. A line that is neither a
 * valid AniList profile URL nor a bare username is REJECTED (reported with
 * its 1-based line number), never silently dropped — the caller logs
 * rejections so a partial parse failure (e.g. a ".../user/Foo/animelist" URL
 * that misses the anchored regex) is visible instead of quietly shrinking
 * the tracked set.
 */
export function parseUsernamesFile(
  text: string,
): { accepted: string[]; rejected: { line: number; text: string }[] } {
  const accepted: string[] = [];
  const rejected: { line: number; text: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^https?:\/\/anilist\.co\/user\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      accepted.push(m[1]);
      continue;
    }
    if (/^[A-Za-z0-9_-]+$/.test(line)) {
      accepted.push(line);
      continue;
    }
    rejected.push({ line: i + 1, text: line });
  }
  return { accepted, rejected };
}

// The notifier reports consumption (episodes watched, chapters read,
// completions) — list housekeeping like "plans to watch" / "paused" is noise.
const CONSUMPTION_STATUSES = [
  "watched episode",
  "rewatched episode",
  "read chapter",
  "reread chapter",
  "completed",
];

/** True when an activity's status is consumption (watched/read/completed),
 * not list housekeeping (planning/paused/dropped). */
export function isConsumptionActivity(a: ActivityItem): boolean {
  return CONSUMPTION_STATUSES.includes(a.status.toLowerCase());
}

// A list *verdict*: the user reached the end of a title or gave up on it.
// These are rare next to episode-by-episode progress and say something the
// progress lines cannot, so the digest pulls them into their own section
// instead of burying "dropped" as housekeeping or folding "completed" into a
// watch range. "completed" is deliberately in both sets — it is consumption
// AND a verdict; `partitionActivities` decides where it is rendered.
const STATUS_CHANGE_STATUSES = ["completed", "dropped"];

/** True when an activity is a list verdict — the user completed a title or
 * dropped it — as opposed to episode/chapter progress. */
export function isStatusChangeActivity(a: ActivityItem): boolean {
  return STATUS_CHANGE_STATUSES.includes(a.status.toLowerCase());
}

/** Everything the notifier delivers. Widens `isConsumptionActivity` by
 * exactly one status ("dropped") — the rest of the union already qualified. */
export function isReportableActivity(a: ActivityItem): boolean {
  return isConsumptionActivity(a) || isStatusChangeActivity(a);
}

/** Split a delivered batch into the progress rows (rendered per user) and the
 * status changes (rendered in their own section). Order is preserved within
 * each side, so both keep the caller's chronological ordering. */
export function partitionActivities(
  activities: ActivityItem[],
): { progress: ActivityItem[]; statusChanges: ActivityItem[] } {
  const progress: ActivityItem[] = [];
  const statusChanges: ActivityItem[] = [];
  for (const a of activities) {
    if (isStatusChangeActivity(a)) statusChanges.push(a);
    else progress.push(a);
  }
  return { progress, statusChanges };
}

/** Model names reach a `swamp` subprocess argv — must not look like a CLI
 * flag. */
export function isValidModelName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
}

/** Escape a string for safe interpolation into Telegram HTML parse-mode
 * text. */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Keep activities newer than the user's cursor. Users that never had a
 * delivered activity use their pinned window floor (lastSeenCreatedAt, set
 * when the user was first resolved and only moved forward after a
 * successful run) so a failed send cannot silently lose their items to a
 * shifting relative lookback; users with no entry at all fall back to the
 * lookback cutoff. Users are isolated: one user's cursor never filters
 * another.
 */
export function filterNewActivities(
  activities: ActivityItem[],
  cursor: ActivityCursor,
  lookbackCutoff: number,
): ActivityItem[] {
  return activities.filter((a) => {
    const entry = cursor.users[a.userName.toLowerCase()];
    if (entry && entry.lastSeenActivityId > 0) {
      return a.id > entry.lastSeenActivityId;
    }
    return a.createdAt > (entry?.lastSeenCreatedAt ?? lookbackCutoff);
  });
}

/**
 * Pagination stop condition: pages are sorted ID_DESC, so once the oldest
 * item on a page is below every user's lastSeenActivityId AND older than
 * the lookback cutoff, later pages cannot contain anything new.
 */
export function hasReachedOldActivities(
  pageActivities: ActivityItem[],
  cursor: ActivityCursor,
  lookbackCutoff: number,
): boolean {
  if (pageActivities.length === 0) return true;
  const oldest = pageActivities[pageActivities.length - 1];
  const lastSeenIds = Object.values(cursor.users)
    .map((u) => u.lastSeenActivityId)
    .filter((id) => id > 0);
  const minLastSeen = lastSeenIds.length ? Math.min(...lastSeenIds) : Infinity;
  return oldest.createdAt <= lookbackCutoff && oldest.id <= minLastSeen;
}

/**
 * Advance per-user cursors to the max delivered activity id. Never moves a
 * cursor backwards. Called ONLY with activities whose Telegram delivery was
 * confirmed (or that need no delivery) — a failed send holds the cursor so
 * the next run retries (at-least-once delivery).
 */
export function advanceCursor(
  cursor: ActivityCursor,
  sentActivities: ActivityItem[],
): ActivityCursor {
  const users = { ...cursor.users };
  for (const a of sentActivities) {
    const key = a.userName.toLowerCase();
    const prev = users[key];
    users[key] = {
      userId: prev?.userId ?? a.userId,
      lastSeenActivityId: Math.max(prev?.lastSeenActivityId ?? 0, a.id),
      lastSeenCreatedAt: Math.max(prev?.lastSeenCreatedAt ?? 0, a.createdAt),
    };
  }
  return { users };
}

/**
 * Hashtag stamped on every digest so the chat's posts are searchable by tag.
 * Telegram auto-detects a bare `#tag` in message text, so it needs no markup
 * — but it must sit in plain (non-linked) text to be picked up. It stands in
 * for the word in the digest heading ("#AniList activity") rather than
 * sitting in a second place, so the name is never repeated.
 */
export const ACTIVITY_HASHTAG = "#AniList";

/** The digest heading, tag included. Shared by both message formats. */
export const ACTIVITY_HEADING = `${ACTIVITY_HASHTAG} activity`;

/**
 * Render activities as Telegram HTML messages, grouped by user, chunked at
 * the Telegram limit. Every interpolated field is HTML-escaped; titles link
 * to their AniList page when known. Score is shown only when set (> 0).
 * ASCII-only chrome (no emoji, plain dashes) and compact lines so the
 * common case is a single chunk. The hashtag rides in the header, so it
 * survives chunking — every chunk is independently searchable. Status
 * changes, when present, follow the per-user blocks under their own heading.
 */
export function formatActivityMessages(
  activities: ActivityItem[],
  statusChanges: StatusChange[] = [],
): string[] {
  const byUser = new Map<string, ActivityItem[]>();
  for (const a of activities) {
    const list = byUser.get(a.userName) ?? [];
    list.push(a);
    byUser.set(a.userName, list);
  }

  const lines: string[] = [];
  for (const [user, acts] of byUser) {
    lines.push(`<b>${escapeHtml(user)}</b>`);
    for (const a of acts) {
      const verb = a.progress ? `${a.status} ${a.progress}` : a.status;
      const title = a.siteUrl
        ? `<a href="${escapeHtml(a.siteUrl)}">${escapeHtml(a.title)}</a>`
        : escapeHtml(a.title);
      const scoreSuffix = a.score && a.score > 0 ? ` (score ${a.score})` : "";
      lines.push(`- ${escapeHtml(verb)}: ${title}${scoreSuffix}`);
    }
    lines.push("");
  }

  // Verdicts last, under their own heading — one flat, user-attributed list
  // so a drop is never mistaken for a progress line.
  if (statusChanges.length > 0) {
    lines.push(`<b>${escapeHtml(STATUS_CHANGE_HEADING)}</b>`);
    for (const c of statusChanges) {
      const title = c.siteUrl
        ? `<a href="${escapeHtml(c.siteUrl)}">${escapeHtml(c.title)}</a>`
        : escapeHtml(c.title);
      const scoreSuffix = c.score && c.score > 0 ? ` (score ${c.score})` : "";
      lines.push(
        `- <b>${escapeHtml(c.userName)}</b> ${
          escapeHtml(c.status)
        }: ${title}${scoreSuffix}`,
      );
    }
    lines.push("");
  }

  const header = `<b>${ACTIVITY_HEADING}</b>`;
  const chunks: string[] = [];
  let current = header;
  for (const line of lines) {
    if (current.length + line.length + 1 > TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(current.trimEnd());
      current = `${header} (cont.)`;
    }
    current += `\n${line}`;
  }
  if (current.trimEnd().length > header.length) chunks.push(current.trimEnd());
  return chunks;
}

// ---------------------------------------------------------------------------
// Rich Message (Bot API 10.2 block) rendering
// ---------------------------------------------------------------------------

/** One display row per (user, show): the user's activity for that title in
 * this digest, collapsed. */
export type MergedShow = {
  userName: string;
  mediaId: number;
  title: string;
  siteUrl: string | null;
  score: number | null;
  // Human line describing what happened, e.g. "watched episodes 1-3" or
  // "completed, episodes 1-12". Title/score are appended by the renderer.
  line: string;
};

/** One display row per (user, show, verdict) for the status-changes
 * section. */
export type StatusChange = {
  userName: string;
  mediaId: number;
  // Lower-cased AniList status, used verbatim as the verb ("completed",
  // "dropped").
  status: string;
  title: string;
  siteUrl: string | null;
  score: number | null;
};

/**
 * Collapse status-change activities into one row per (user, show, verdict).
 * AniList can emit the same transition twice (an edit re-fires the
 * activity), and a re-watch can complete a title the user already completed
 * inside one window — both would otherwise print twice. The best known score
 * wins, since score enrichment is best-effort and may be null on some of the
 * duplicates. Preserves first-appearance order, so the section reads
 * chronologically.
 */
export function mergeStatusChanges(
  activities: ActivityItem[],
): StatusChange[] {
  const order: string[] = [];
  const rows = new Map<string, StatusChange>();
  for (const a of activities) {
    const status = a.status.toLowerCase();
    const key = `${a.userName} ${a.mediaId} ${status}`;
    const prev = rows.get(key);
    if (!prev) {
      order.push(key);
      rows.set(key, {
        userName: a.userName,
        mediaId: a.mediaId,
        status,
        title: a.title,
        siteUrl: a.siteUrl ?? null,
        score: a.score != null && a.score > 0 ? a.score : null,
      });
      continue;
    }
    if (a.score != null && a.score > 0) {
      prev.score = Math.max(prev.score ?? 0, a.score);
    }
    // A later duplicate may carry the siteUrl an earlier one lacked.
    if (!prev.siteUrl && a.siteUrl) prev.siteUrl = a.siteUrl;
  }
  return order.map((k) => rows.get(k)!);
}

/** Heading for the status-changes section, in both message formats. */
export const STATUS_CHANGE_HEADING = "Status changes";

// Parse an AniList progress string ("5", "1 - 12", "68 - 70") to the inclusive
// integer set it covers. Non-numeric progress yields nothing.
function progressNumbers(progress: string | null): number[] {
  if (!progress) return [];
  const m = progress.match(/(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return [];
  const lo = Number(m[1]);
  const hi = m[2] !== undefined ? Number(m[2]) : lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
}

/**
 * Compress a set of integers into a compact, HONEST range string:
 * contiguous runs collapse ("1,2,3" -> "1-3", "70,71,72,73" -> "70-73"),
 * gaps are kept ("1,2,3,7" -> "1-3, 7"). Never implies an episode that was
 * not watched.
 */
export function compressRanges(nums: number[]): string {
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.length === 0) return "";
  const runs: string[] = [];
  let start = uniq[0];
  let prev = uniq[0];
  for (let i = 1; i <= uniq.length; i++) {
    const n = uniq[i];
    if (i < uniq.length && n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return runs.join(", ");
}

// Derive the verb + unit ("watched"/"episode", "read"/"chapter", …) from a
// consumption status string. Unknown statuses fall back to the raw status.
function verbUnit(
  status: string,
): { verb: string; unit: string } | null {
  const s = status.toLowerCase();
  if (s.includes("episode")) {
    return { verb: s.split(" ")[0], unit: "episode" };
  }
  if (s.includes("chapter")) {
    return { verb: s.split(" ")[0], unit: "chapter" };
  }
  return null;
}

/**
 * Collapse a run of activities into one display row per (user, show):
 * consecutive episodes/chapters merge into a range, and a "completed" folds
 * into the same show's progress line. Preserves first-appearance order of
 * both users and shows. Operates on a COPY — the caller's list (which
 * drives the dedupe cursor) is never mutated or reordered.
 */
export function mergeActivities(activities: ActivityItem[]): MergedShow[] {
  const order: string[] = [];
  const groups = new Map<string, ActivityItem[]>();
  for (const a of activities) {
    const key = `${a.userName} ${a.mediaId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(a);
  }

  const merged: MergedShow[] = [];
  for (const key of order) {
    const acts = groups.get(key)!;
    const first = acts[0];
    let completed = false;
    const nums: number[] = [];
    let verb = "";
    let unit = "";
    let score: number | null = null;
    for (const a of acts) {
      if (a.score != null && a.score > 0) score = Math.max(score ?? 0, a.score);
      if (a.status.toLowerCase() === "completed") {
        completed = true;
        continue;
      }
      const vu = verbUnit(a.status);
      if (vu) {
        if (!verb) verb = vu.verb;
        unit = vu.unit;
      }
      nums.push(...progressNumbers(a.progress));
    }

    const range = compressRanges(nums);
    // Pluralise only for a multi-number range.
    const unitWord = range && (nums.length > 1 || range.includes("-") ||
        range.includes(","))
      ? `${unit}s`
      : unit;

    let line: string;
    if (completed && range) {
      line = `completed, ${unitWord} ${range}`;
    } else if (completed) {
      line = "completed";
    } else if (range) {
      line = `${verb || "watched"} ${unitWord} ${range}`;
    } else {
      // No parseable progress and not a completion — surface the raw status.
      line = first.status || "updated";
    }

    merged.push({
      userName: first.userName,
      mediaId: first.mediaId,
      title: first.title,
      siteUrl: first.siteUrl ?? null,
      score,
      line,
    });
  }
  return merged;
}

// A bold, AniList-linked username node. The link is wrapped in a bold node
// (the array form is the validated nesting shape for RichText).
function userNode(userName: string): Record<string, unknown> {
  return {
    type: "bold",
    text: [{
      type: "url",
      text: userName,
      url: `https://anilist.co/user/${encodeURIComponent(userName)}`,
    }],
  };
}

// The RichText fragment for one show's line: "<line>: <linked title> (score N)".
// Block text is a RichText TREE (bare string = plain, {type,text} = formatted
// node, array = concatenation) — NOT HTML and NOT an entities array, both of
// which Telegram silently ignores inside a block.
function showLine(show: MergedShow): unknown[] {
  const titleNode = show.siteUrl
    ? { type: "url", text: show.title, url: show.siteUrl }
    : show.title;
  const parts: unknown[] = [`${show.line}: `, titleNode];
  if (show.score != null && show.score > 0) {
    parts.push(` (score ${show.score})`);
  }
  return parts;
}

// The RichText fragment for one status change: "<user> <verb>: <title> (score
// N)". Unlike a progress row the user is named inline — the section is a flat
// chronological list, not grouped by user, so nothing is orphaned.
function statusChangeLine(change: StatusChange): unknown[] {
  const titleNode = change.siteUrl
    ? { type: "url", text: change.title, url: change.siteUrl }
    : change.title;
  const parts: unknown[] = [
    userNode(change.userName),
    ` ${change.status}: `,
    titleNode,
  ];
  if (change.score != null && change.score > 0) {
    parts.push(` (score ${change.score})`);
  }
  return parts;
}

/**
 * Build a Bot API 10.2 Rich Message (InputRichMessage) as a plain text
 * digest grouped by user — one paragraph per user holding the bold,
 * profile-linked username followed by their merged activity lines
 * (bulleted, titles linked). No imagery: the grouped heading keeps every
 * line attributed without banners splitting them. The heading carries
 * ACTIVITY_HASHTAG so the post is searchable by tag. Status changes, when
 * present, get their own trailing paragraph. Returns the InputRichMessage
 * object (caller stringifies it).
 */
export function buildRichMessage(
  merged: MergedShow[],
  statusChanges: StatusChange[] = [],
): Record<string, unknown> {
  // Group by user, first-appearance order.
  const byUser = new Map<string, MergedShow[]>();
  for (const s of merged) {
    const list = byUser.get(s.userName) ?? [];
    list.push(s);
    byUser.set(s.userName, list);
  }

  const blocks: Record<string, unknown>[] = [
    { type: "paragraph", text: { type: "bold", text: ACTIVITY_HEADING } },
  ];
  for (const [user, shows] of byUser) {
    const text: unknown[] = [userNode(user)];
    for (const show of shows) {
      text.push("\n• ", ...showLine(show));
    }
    blocks.push({ type: "paragraph", text });
  }

  // Verdicts get their own paragraph, shaped like a user block (bold heading,
  // then bulleted lines) so it reads as one more section rather than a
  // different kind of message.
  if (statusChanges.length > 0) {
    const text: unknown[] = [
      { type: "bold", text: STATUS_CHANGE_HEADING },
    ];
    for (const change of statusChanges) {
      text.push("\n• ", ...statusChangeLine(change));
    }
    blocks.push({ type: "paragraph", text });
  }

  // Users counted across both sections — a run can hold a drop from someone
  // with no progress rows at all.
  const users = new Set<string>([
    ...merged.map((m) => m.userName),
    ...statusChanges.map((c) => c.userName),
  ]);
  const userCount = users.size;
  const showCount = merged.length;
  const changeCount = statusChanges.length;
  const parts = [`${userCount} user${userCount === 1 ? "" : "s"}`];
  // Drop the titles clause only when there is nothing to count and the status
  // section is carrying the digest on its own.
  if (showCount > 0 || changeCount === 0) {
    parts.push(`${showCount} title${showCount === 1 ? "" : "s"}`);
  }
  if (changeCount > 0) {
    parts.push(
      `${changeCount} status change${changeCount === 1 ? "" : "s"}`,
    );
  }
  blocks.push({ type: "footer", text: parts.join(" · ") });

  return { blocks };
}

// Send one Rich Message via the given swamp @magistr/telegram/send instance.
// Reports success so the caller can hold the activity cursor on failure
// (at-least-once). Banners are https URLs, so no multipart `files` map.
async function sendRichTelegram(
  modelName: string,
  richMessage: Record<string, unknown>,
  chatId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const input = JSON.stringify({
      richMessage: JSON.stringify(richMessage),
      ...(chatId ? { chatId } : {}),
    });
    const cmd = new Deno.Command("swamp", {
      args: ["model", "method", "run", modelName, "sendRichMessage", "--stdin"],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const out = await proc.output();
    if (out.success) return { ok: true };
    const stderr = new TextDecoder().decode(out.stderr);
    return { ok: false, error: stderr.slice(-400) || `exit ${out.code}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Send one Telegram message via the given swamp model instance. Unlike the
// fire-and-forget anime-cron variant, this reports success so the caller can
// hold the activity cursor when delivery fails. Web-page previews are
// disabled — a digest full of AniList links must stay compact.
async function sendTelegram(
  modelName: string,
  text: string,
  chatId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const input = JSON.stringify({
      text,
      parseMode: "HTML",
      disableWebPagePreview: true,
      ...(chatId ? { chatId } : {}),
    });
    const cmd = new Deno.Command("swamp", {
      args: ["model", "method", "run", modelName, "sendMessage", "--stdin"],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const out = await proc.output();
    if (out.success) return { ok: true };
    const stderr = new TextDecoder().decode(out.stderr);
    return { ok: false, error: stderr.slice(-400) || `exit ${out.code}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const USER_ID_QUERY = `
query ($name: String!) {
  User(name: $name) { id name }
}`;

// NOTE: singular $userId, not userId_in — AniList silently broke the
// userId_in batch filter (2026-07-05: returns [] while userId works).
// One request per tracked user; gql() paces against the rate limit.
const ACTIVITIES_QUERY = `
query ($userId: Int, $createdAtGreater: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    activities(
      userId: $userId,
      type_in: [ANIME_LIST, MANGA_LIST],
      createdAt_greater: $createdAtGreater,
      sort: ID_DESC
    ) {
      ... on ListActivity {
        id createdAt status progress
        user { id name }
        media { id siteUrl title { romaji english } }
      }
    }
  }
}`;

const ACTIVITY_SCORES_QUERY = `
query ($userIds: [Int], $mediaIds: [Int], $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    mediaList(userId_in: $userIds, mediaId_in: $mediaIds) {
      userId mediaId score
    }
  }
}`;

const ActivityItemSchema = z.object({
  id: z.number(),
  createdAt: z.number(),
  userId: z.number(),
  userName: z.string(),
  status: z.string(),
  progress: z.string().nullable(),
  mediaId: z.number(),
  title: z.string(),
  siteUrl: z.string().nullable(),
  score: z.number().nullable(),
});

/**
 * The `@magistr/anilist` swamp model: a thin wrapper over the public AniList
 * GraphQL API (`search`, `get`, `userlist`, `trending`, `watching`,
 * `seasonal`, `update-progress`, `set-score`) plus two fan-out pipelines —
 * `recent-activity` (Telegram notifier) and `ingest-scores` /
 * `refresh-metadata` (ClickHouse charting sink).
 */
export const model = {
  type: "@magistr/anilist",
  version: "2026.08.30.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.02.1",
      description:
        "hostile-200 crash guards (null-data + non-JSON-body) + robust 429-in-body detection + per-invocation rate-limit state; no globalArguments schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.17.1",
      description:
        "reconciled the main-repo fork (#AniList hashtag, ClickHouse `lookup`) with the AL1-AL4 hardening, and added completed/dropped verdict detection: `includeStatusChanges` + a Status changes digest section + statusChanges on the activityFeed resource; no globalArguments schema change",
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
        "update-progress gained an optional `repeat` argument — AniList's rewatch counter, which is how a FINISHED rewatch is recorded (entry stays COMPLETED, counter goes up); setting status REPEATING instead means 'currently rewatching' and leaves repeat at 0. The mutation now declares and forwards $repeat and reads it back, and watchProgress carries a `repeat` field. No globalArguments schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    search: {
      description: "Anime/manga search results",
      schema: z.object({
        query: z.string(),
        totalResults: z.number(),
        page: z.number(),
        lastPage: z.number(),
        hasNextPage: z.boolean(),
        results: z.array(MediaSchema),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    media: {
      description: "Detailed media info",
      schema: MediaSchema.extend({
        endDate: z.object({
          year: z.number().nullable(),
          month: z.number().nullable(),
          day: z.number().nullable(),
        }).nullable(),
        studios: z.array(z.string()).nullable(),
        staff: z.array(z.string()).nullable(),
        tags: z.array(z.object({ name: z.string(), rank: z.number() }))
          .nullable(),
        nextAiringEpisode: z.object({
          airingAt: z.number(),
          episode: z.number(),
          timeUntilAiring: z.number(),
        }).nullable(),
      }).passthrough(),
      lifetime: "1h",
      garbageCollection: 5,
    },
    userlist: {
      description: "User anime/manga list",
      schema: z.object({
        userName: z.string(),
        listCount: z.number(),
        totalEntries: z.number(),
        lists: z.array(z.object({
          name: z.string(),
          status: z.string().nullable(),
          entryCount: z.number(),
          entries: z.array(MediaListEntrySchema),
        })),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    trending: {
      description: "Trending or popular media",
      schema: z.object({
        sortedBy: z.string(),
        totalResults: z.number(),
        page: z.number(),
        lastPage: z.number(),
        hasNextPage: z.boolean(),
        results: z.array(MediaSchema),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    watching: {
      description: "CURRENT list enriched with next airing episode info",
      schema: z.object({
        userName: z.string(),
        count: z.number(),
        entries: z.array(z.object({
          mediaId: z.number(),
          romaji: z.string(),
          english: z.string().nullable(),
          synonyms: z.array(z.string()),
          progress: z.number(),
          episodes: z.number().nullable(),
          mediaStatus: z.string().nullable(),
          nextAiringEp: z.number().nullable(),
          nextAiringAt: z.number().nullable(),
          timeUntilAiringHours: z.number().nullable(),
        })),
        timestamp: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    seasonal: {
      description: "Anime airing in a specific season/year",
      schema: z.object({
        season: z.string(),
        seasonYear: z.number(),
        totalResults: z.number(),
        page: z.number(),
        lastPage: z.number(),
        hasNextPage: z.boolean(),
        results: z.array(MediaSchema.extend({
          nextAiringEpisode: z.object({
            airingAt: z.number(),
            episode: z.number(),
            timeUntilAiring: z.number(),
          }).nullable().optional(),
        })),
      }),
      lifetime: "6h",
      garbageCollection: 5,
    },
    watchProgress: {
      description: "Result of update-progress or set-score mutation",
      schema: z.object({
        mediaId: z.number(),
        progress: z.number().nullable(),
        score: z.number().nullable(),
        status: z.string().nullable(),
        repeat: z.number().nullable(),
        updatedAt: z.number().nullable(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    activityFeed: {
      description:
        "Recent list activity across tracked users, with detected completed/dropped verdicts, formatted Telegram messages and delivery outcome",
      schema: z.object({
        checkedAt: z.string(),
        usernamesSource: z.string(),
        usersChecked: z.array(z.string()),
        usersFailed: z.array(z.object({
          name: z.string(),
          reason: z.string(),
        })),
        newCount: z.number(),
        activities: z.array(ActivityItemSchema),
        // Verdicts (completed / dropped) split out of `activities` for the
        // digest's status-changes section — queryable on their own so
        // "who dropped what" needs no re-derivation from raw statuses.
        statusChanges: z.array(z.object({
          userName: z.string(),
          mediaId: z.number(),
          status: z.string(),
          title: z.string(),
          siteUrl: z.string().nullable(),
          score: z.number().nullable(),
        })),
        statusChangeCount: z.number(),
        messages: z.array(z.string()),
        sent: z.boolean(),
        sendError: z.string().nullable(),
        pageCapHit: z.boolean(),
        dryRun: z.boolean(),
      }),
      lifetime: "7d",
      garbageCollection: 10,
    },
    activityCursor: {
      description:
        "Per-user dedupe cursor for recent-activity: last delivered activity id + cached AniList userId",
      schema: z.object({
        users: z.record(
          z.string(),
          z.object({
            userId: z.number(),
            lastSeenActivityId: z.number(),
            lastSeenCreatedAt: z.number().optional(),
          }),
        ),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    userlistScored: {
      description:
        "Per-user score-ingest summary (observability): rows written to user_scores, media ids seen, list-chunk pagination cap",
      schema: z.object({
        userName: z.string(),
        scoresWritten: z.number(),
        entriesSeen: z.number(),
        mediaIdsSeen: z.number(),
        chunksFetched: z.number(),
        chunkCapHit: z.boolean(),
        completedAt: z.string(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    ingestRun: {
      description:
        "Score-ingest run marker across all users (observability ONLY — not a provenance gate)",
      schema: z.object({
        usernamesSource: z.string(),
        usersIngested: z.array(z.object({
          userName: z.string(),
          scoresWritten: z.number(),
          mediaIdsSeen: z.number(),
          chunkCapHit: z.boolean(),
        })),
        totalScoresWritten: z.number(),
        uniqueMediaIds: z.number(),
        metadataRowsWritten: z.number(),
        completedAt: z.string(),
      }),
      lifetime: "90d",
      garbageCollection: 10,
    },
    metadataRefresh: {
      description:
        "Marker for a metadata-only backfill: how many score media ids lacked metadata and how many rows were written",
      schema: z.object({
        missing: z.number(),
        written: z.number(),
        completedAt: z.string(),
      }),
      lifetime: "90d",
      garbageCollection: 10,
    },
    lookupResult: {
      description:
        "Local title lookup against the ClickHouse mirror: which media matched and who scored them",
      schema: z.object({
        query: z.string(),
        userName: z.string().nullable(),
        matches: z.number(),
        results: z.array(z.object({
          mediaId: z.number(),
          romaji: z.string(),
          english: z.string(),
          native: z.string(),
          format: z.string(),
          startYear: z.number().nullable(),
          episodes: z.number().nullable(),
          averageScore: z.number().nullable(),
          userScore: z.number().nullable(),
          seenByUser: z.boolean().nullable(),
          scores: z.array(
            z.object({ userName: z.string(), score: z.number() }),
          ),
        })),
        timestamp: z.string(),
      }),
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    lookup: {
      description:
        "Answer 'have I seen X, and what did I score it' from the LOCAL ClickHouse mirror instead of the AniList API — works while AniList is down or rate-limiting. Matches a title substring case-insensitively across romaji/english/native. Only covers what ingest-scores has mirrored (COMPLETED + CURRENT entries that carry a score), so an unscored or never-ingested entry reads as not-found rather than not-watched.",
      arguments: z.object({
        title: z.string().min(1).describe(
          "Title substring, matched case-insensitively against romaji/english/native",
        ),
        userName: z.string().optional().describe(
          "Restrict scores to this user (case-sensitive — user_scores ORDER BY is). Omit to show every user who scored the match.",
        ),
        limit: z.number().min(1).max(100).default(10).describe(
          "Max distinct media to return, most popular first",
        ),
      }),
      execute: async (
        args: { title: string; userName?: string; limit: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const cfg = clickhouseConfig(context.globalArgs);
        const db = cfg.database;

        // Media first, capped by `limit`, so a title matched by many users
        // cannot crowd out other matches the way a joined LIMIT would.
        const media = await clickhouseSelect(
          cfg,
          `SELECT media_id, title_romaji, title_english, title_native,
                  format, start_year, episodes, average_score, popularity
             FROM ${db}.anilist_metadata FINAL
            WHERE positionCaseInsensitive(title_romaji, {q:String}) > 0
               OR positionCaseInsensitive(title_english, {q:String}) > 0
               OR positionCaseInsensitive(title_native, {q:String}) > 0
            ORDER BY popularity DESC
            LIMIT {n:UInt32}
           FORMAT JSONEachRow`,
          { q: args.title, n: String(args.limit) },
        );

        const ids = media.map((m) => asNum(m.media_id)).filter((
          n,
        ): n is number => n != null);

        // Scores for exactly those ids. Skipped entirely on no match so an
        // empty IN () never reaches ClickHouse.
        const scoreRows = ids.length
          ? await clickhouseSelect(
            cfg,
            `SELECT user_name, media_id, score
               FROM ${db}.user_scores FINAL
              WHERE media_id IN ({ids:Array(UInt32)})
                ${args.userName ? "AND user_name = {u:String}" : ""}
             FORMAT JSONEachRow`,
            {
              ids: `[${ids.join(",")}]`,
              ...(args.userName ? { u: args.userName } : {}),
            },
          )
          : [];

        const byMedia = new Map<
          number,
          Array<{ userName: string; score: number }>
        >();
        for (const r of scoreRows) {
          const id = asNum(r.media_id);
          const score = asNum(r.score);
          if (id == null || score == null) continue;
          const list = byMedia.get(id) ?? [];
          list.push({ userName: String(r.user_name ?? ""), score });
          byMedia.set(id, list);
        }

        const results = media.map((m) => {
          const id = asNum(m.media_id) ?? 0;
          const scores = (byMedia.get(id) ?? []).sort((a, b) =>
            b.score - a.score
          );
          const mine = args.userName
            ? scores.find((s) => s.userName === args.userName) ?? null
            : null;
          return {
            mediaId: id,
            romaji: String(m.title_romaji ?? ""),
            english: String(m.title_english ?? ""),
            native: String(m.title_native ?? ""),
            format: String(m.format ?? ""),
            startYear: asNum(m.start_year),
            episodes: asNum(m.episodes),
            averageScore: asNum(m.average_score),
            userScore: mine ? mine.score : null,
            // null (not false) when no user was named — absence of a score
            // for an unspecified user is not evidence of not having seen it.
            seenByUser: args.userName ? mine != null : null,
            scores,
          };
        });

        const handle = await context.writeResource(
          "lookupResult",
          args.title.slice(0, 60) || "lookup",
          {
            query: args.title,
            userName: args.userName ?? null,
            matches: results.length,
            results,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    search: {
      description:
        "Search for anime or manga by title. Set fetchAll to paginate through all results automatically.",
      arguments: z.object({
        query: z.string().describe("Search term"),
        type: z.enum(["ANIME", "MANGA"]).optional().describe(
          "Override default media type",
        ),
        perPage: z.number().min(1).max(50).default(10).describe(
          "Results per page (ignored when fetchAll is true)",
        ),
        page: z.number().min(1).default(1).describe(
          "Page number (ignored when fetchAll is true)",
        ),
        fetchAll: z.boolean().default(false).describe(
          "Fetch all pages automatically (max 5 pages / 250 results)",
        ),
      }),
      execute: async (
        args: {
          query: string;
          type?: "ANIME" | "MANGA";
          perPage: number;
          page: number;
          fetchAll: boolean;
        },
        context: ExecContext,
      ) => {
        const type = args.type || context.globalArgs.mediaType;
        const gql = makeGql();

        if (args.fetchAll) {
          const { media, pageInfo } = await fetchAllPages(
            gql,
            SEARCH_QUERY,
            { search: args.query, type },
            5,
          );
          const handle = await context.writeResource!("search", args.query, {
            query: args.query,
            totalResults: pageInfo.total,
            page: 1,
            lastPage: pageInfo.lastPage,
            hasNextPage: false,
            results: media,
          });
          return { dataHandles: [handle] };
        }

        const data = await gql(SEARCH_QUERY, {
          search: args.query,
          type,
          page: args.page,
          perPage: args.perPage,
        });

        const handle = await context.writeResource!("search", args.query, {
          query: args.query,
          totalResults: data.Page.pageInfo.total,
          page: data.Page.pageInfo.currentPage,
          lastPage: data.Page.pageInfo.lastPage,
          hasNextPage: data.Page.pageInfo.hasNextPage,
          results: data.Page.media,
        });
        return { dataHandles: [handle] };
      },
    },
    get: {
      description: "Get detailed info for a specific anime/manga by AniList ID",
      arguments: z.object({
        id: z.number().describe("AniList media ID"),
      }),
      execute: async (args: { id: number }, context: ExecContext) => {
        const gql = makeGql();
        const data = await gql(DETAILS_QUERY, { id: args.id });
        const media = data.Media;

        media.studios =
          media.studios?.nodes?.map((s: { name: string }) => s.name) || [];
        media.staff = media.staff?.nodes?.map(
          (s: { name?: { full?: string | null } }) => s.name?.full,
        ) || [];

        const handle = await context.writeResource!(
          "media",
          String(args.id),
          media,
        );
        return { dataHandles: [handle] };
      },
    },
    userlist: {
      description:
        "Get a user's public anime/manga list (returns all entries; AniList returns full lists in one response)",
      arguments: z.object({
        userName: z.string().describe("AniList username"),
        type: z.enum(["ANIME", "MANGA"]).optional().describe(
          "Override default media type",
        ),
        status: z.enum([
          "CURRENT",
          "PLANNING",
          "COMPLETED",
          "DROPPED",
          "PAUSED",
          "REPEATING",
        ]).optional().describe("Filter by list status"),
      }),
      execute: async (
        args: { userName: string; type?: "ANIME" | "MANGA"; status?: string },
        context: ExecContext,
      ) => {
        const type = args.type || context.globalArgs.mediaType;
        const variables: Record<string, unknown> = {
          userName: args.userName,
          type,
        };
        if (args.status) variables.status = args.status;

        const gql = makeGql();
        const data = await gql(USERLIST_QUERY, variables);
        const lists = (data.MediaListCollection.lists || []).map(
          (list: {
            name: string;
            status: string | null;
            entries: unknown[];
          }) => ({
            name: list.name,
            status: list.status,
            entryCount: list.entries.length,
            entries: list.entries,
          }),
        );

        const totalEntries = lists.reduce(
          (sum: number, l: { entryCount: number }) => sum + l.entryCount,
          0,
        );

        const handle = await context.writeResource!("userlist", args.userName, {
          userName: args.userName,
          listCount: lists.length,
          totalEntries,
          lists,
        });
        return { dataHandles: [handle] };
      },
    },
    trending: {
      description:
        "Get trending or popular anime/manga. Set fetchAll to paginate through all results automatically.",
      arguments: z.object({
        sort: z.enum(["TRENDING_DESC", "POPULARITY_DESC", "SCORE_DESC"])
          .default("TRENDING_DESC")
          .describe("Sort order"),
        type: z.enum(["ANIME", "MANGA"]).optional().describe(
          "Override default media type",
        ),
        perPage: z.number().min(1).max(50).default(10).describe(
          "Results per page (ignored when fetchAll is true)",
        ),
        page: z.number().min(1).default(1).describe(
          "Page number (ignored when fetchAll is true)",
        ),
        fetchAll: z.boolean().default(false).describe(
          "Fetch all pages automatically (max 5 pages / 250 results)",
        ),
      }),
      execute: async (
        args: {
          sort: "TRENDING_DESC" | "POPULARITY_DESC" | "SCORE_DESC";
          type?: "ANIME" | "MANGA";
          perPage: number;
          page: number;
          fetchAll: boolean;
        },
        context: ExecContext,
      ) => {
        const type = args.type || context.globalArgs.mediaType;
        const gql = makeGql();

        if (args.fetchAll) {
          const { media, pageInfo } = await fetchAllPages(
            gql,
            TRENDING_QUERY,
            { type, sort: [args.sort] },
            5,
          );
          const handle = await context.writeResource!(
            "trending",
            args.sort.toLowerCase(),
            {
              sortedBy: args.sort,
              totalResults: pageInfo.total,
              page: 1,
              lastPage: pageInfo.lastPage,
              hasNextPage: false,
              results: media,
            },
          );
          return { dataHandles: [handle] };
        }

        const data = await gql(TRENDING_QUERY, {
          type,
          sort: [args.sort],
          page: args.page,
          perPage: args.perPage,
        });

        const handle = await context.writeResource!(
          "trending",
          args.sort.toLowerCase(),
          {
            sortedBy: args.sort,
            totalResults: data.Page.pageInfo.total,
            page: data.Page.pageInfo.currentPage,
            lastPage: data.Page.pageInfo.lastPage,
            hasNextPage: data.Page.pageInfo.hasNextPage,
            results: data.Page.media,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    watching: {
      description:
        "Get CURRENT anime list enriched with nextAiringEpisode info — shows what's airing and when.",
      arguments: z.object({
        userName: z.string().describe("AniList username"),
      }),
      execute: async (
        args: { userName: string },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const gql = makeGql();
        const data = await gql(WATCHING_QUERY, { userName: args.userName });
        const collection = data.MediaListCollection as {
          lists: Array<{
            entries: Array<{
              progress: number;
              media: {
                id: number;
                title: { romaji: string | null; english: string | null };
                episodes: number | null;
                status: string | null;
                nextAiringEpisode: {
                  episode: number;
                  airingAt: number;
                  timeUntilAiring: number;
                } | null;
              };
            }>;
          }>;
        };

        const entries = (collection.lists ?? []).flatMap((l) =>
          l.entries.map((e) => ({
            mediaId: e.media.id,
            romaji: e.media.title.romaji ?? "",
            english: e.media.title.english ?? null,
            synonyms:
              (e.media as Record<string, unknown>).synonyms as string[] ?? [],
            progress: e.progress,
            episodes: e.media.episodes ?? null,
            mediaStatus: e.media.status ?? null,
            nextAiringEp: e.media.nextAiringEpisode?.episode ?? null,
            nextAiringAt: e.media.nextAiringEpisode?.airingAt ?? null,
            timeUntilAiringHours: e.media.nextAiringEpisode
              ? Math.round(e.media.nextAiringEpisode.timeUntilAiring / 3600)
              : null,
          }))
        );

        const handle = await context.writeResource!(
          "watching",
          args.userName,
          {
            userName: args.userName,
            count: entries.length,
            entries,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    seasonal: {
      description:
        "Browse anime for a specific season (WINTER/SPRING/SUMMER/FALL) and year. Defaults to current season.",
      arguments: z.object({
        season: z.enum(["WINTER", "SPRING", "SUMMER", "FALL"]).optional()
          .describe("Season (defaults to current based on current month)"),
        seasonYear: z.number().optional().describe(
          "Year (defaults to current year)",
        ),
        perPage: z.number().min(1).max(50).default(50).describe(
          "Results per page",
        ),
        page: z.number().min(1).default(1).describe("Page number"),
      }),
      execute: async (
        args: {
          season?: "WINTER" | "SPRING" | "SUMMER" | "FALL";
          seasonYear?: number;
          perPage: number;
          page: number;
        },
        context: ExecContext,
      ) => {
        const now = new Date();
        const month = now.getMonth() + 1;
        const defaultSeason = month <= 3
          ? "WINTER"
          : month <= 6
          ? "SPRING"
          : month <= 9
          ? "SUMMER"
          : "FALL";
        const season = args.season ?? defaultSeason;
        const seasonYear = args.seasonYear ?? now.getFullYear();
        const type = context.globalArgs.mediaType;
        const gql = makeGql();

        const data = await gql(SEASONAL_QUERY, {
          season,
          seasonYear,
          type,
          page: args.page,
          perPage: args.perPage,
        });

        const handle = await context.writeResource!(
          "seasonal",
          `${season}-${seasonYear}`,
          {
            season,
            seasonYear,
            totalResults: data.Page.pageInfo.total,
            page: data.Page.pageInfo.currentPage,
            lastPage: data.Page.pageInfo.lastPage,
            hasNextPage: data.Page.pageInfo.hasNextPage,
            results: data.Page.media,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "update-progress": {
      description:
        "Update episode progress (and optionally status) for a media entry on AniList. Requires accessToken in globalArguments.",
      arguments: z.object({
        mediaId: z.number().describe("AniList media ID"),
        progress: z.number().describe("Episode number to set as progress"),
        status: z.enum([
          "CURRENT",
          "PLANNING",
          "COMPLETED",
          "DROPPED",
          "PAUSED",
          "REPEATING",
        ]).optional().describe(
          "List status override (omit to keep existing status)",
        ),
        repeat: z.number().int().min(0).optional().describe(
          "Times REWATCHED. This is how AniList records a finished rewatch: the entry stays COMPLETED and this counter goes up. Setting status REPEATING instead means 'currently rewatching' and leaves this at 0. Absolute, not an increment — read the current value first and pass value+1.",
        ),
      }),
      execute: async (
        args: {
          mediaId: number;
          progress: number;
          status?: string;
          repeat?: number;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const token = context.globalArgs.accessToken;
        if (!token) {
          throw new Error(
            "accessToken is required for update-progress. Set it in globalArguments using your AniList personal access token.",
          );
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
        };
        const variables: Record<string, unknown> = {
          mediaId: args.mediaId,
          progress: args.progress,
        };
        if (args.status) variables.status = args.status;
        // 0 is meaningful (clears the rewatch count), so test for undefined
        // rather than falsiness.
        if (args.repeat !== undefined) variables.repeat = args.repeat;

        const resp = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers,
          body: JSON.stringify({ query: UPDATE_PROGRESS_MUTATION, variables }),
        });
        if (!resp.ok) {
          throw new Error(
            `AniList mutation failed: ${resp.status} ${
              (await resp.text()).slice(0, 200)
            }`,
          );
        }
        const json = await resp.json() as {
          data?: {
            SaveMediaListEntry?: {
              id: number;
              mediaId: number;
              status: string;
              progress: number;
              repeat?: number;
              updatedAt: number;
            };
          };
          errors?: Array<{ message: string }>;
        };
        if (json.errors?.length) {
          throw new Error(
            `AniList errors: ${json.errors.map((e) => e.message).join(", ")}`,
          );
        }
        const entry = json.data?.SaveMediaListEntry;
        const handle = await context.writeResource!(
          "watchProgress",
          String(args.mediaId),
          {
            mediaId: entry?.mediaId ?? args.mediaId,
            progress: entry?.progress ?? args.progress,
            score: null,
            status: entry?.status ?? null,
            repeat: entry?.repeat ?? args.repeat ?? null,
            updatedAt: entry?.updatedAt ?? null,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "set-score": {
      description:
        "Set your score/rating for an anime on AniList. Looks up by title if mediaId not provided. Requires accessToken.",
      arguments: z.object({
        mediaId: z.number().optional().describe(
          "AniList media ID (takes priority over title)",
        ),
        title: z.string().optional().describe(
          "Anime title to search for if mediaId not given",
        ),
        score: z.number().min(0).max(100).describe(
          "Score to set. Use 0–10 for standard 10-point scale or 0–100 for 100-point scale.",
        ),
        status: z.enum([
          "CURRENT",
          "PLANNING",
          "COMPLETED",
          "DROPPED",
          "PAUSED",
          "REPEATING",
        ]).optional().describe(
          "Optionally change list status at the same time (e.g. COMPLETED after finishing)",
        ),
      }),
      execute: async (
        args: {
          mediaId?: number;
          title?: string;
          score: number;
          status?: string;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const token = context.globalArgs.accessToken;
        if (!token) {
          throw new Error(
            "accessToken is required for set-score. Set it in globalArguments using your AniList personal access token.",
          );
        }

        // Resolve mediaId from title if not provided directly. Unauthenticated
        // — matches the mutation itself, which authenticates separately below
        // via the raw fetch + Bearer header (this lookup never sends auth).
        let mediaId = args.mediaId;
        if (!mediaId) {
          if (!args.title) {
            throw new Error("Either mediaId or title must be provided.");
          }
          const gql = makeGql();
          const searchResult = await gql(
            `query ($search: String!) { Media(search: $search, type: ANIME) { id title { romaji english } } }`,
            { search: args.title },
          );
          const media = (searchResult as {
            Media?: {
              id: number;
              title: { romaji: string; english: string | null };
            };
          }).Media;
          if (!media) {
            throw new Error(
              `No AniList result found for title: "${args.title}"`,
            );
          }
          mediaId = media.id;
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
        };
        const variables: Record<string, unknown> = {
          mediaId,
          score: args.score,
        };
        if (args.status) variables.status = args.status;

        const resp = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers,
          body: JSON.stringify({ query: SET_SCORE_MUTATION, variables }),
        });
        if (!resp.ok) {
          throw new Error(
            `AniList mutation failed: ${resp.status} ${
              (await resp.text()).slice(0, 200)
            }`,
          );
        }
        const json = await resp.json() as {
          data?: {
            SaveMediaListEntry?: {
              id: number;
              mediaId: number;
              status: string;
              score: number;
              updatedAt: number;
            };
          };
          errors?: Array<{ message: string }>;
        };
        if (json.errors?.length) {
          throw new Error(
            `AniList errors: ${json.errors.map((e) => e.message).join(", ")}`,
          );
        }
        const entry = json.data?.SaveMediaListEntry;
        const handle = await context.writeResource!(
          "watchProgress",
          `score-${mediaId}`,
          {
            mediaId: entry?.mediaId ?? mediaId,
            progress: null,
            score: entry?.score ?? args.score,
            status: entry?.status ?? null,
            repeat: null,
            updatedAt: entry?.updatedAt ?? null,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "recent-activity": {
      description:
        "Fan-out: fetch new list activity (episodes watched, plus completed/dropped verdicts) for a set of users since the last run, enrich with each user's list score, optionally post to Telegram via a @magistr/telegram/send model instance. Verdicts are reported in a dedicated 'Status changes' digest section and stored on the feed resource. Dedupe cursor advances ONLY after confirmed delivery (at-least-once); dryRun never advances it.",
      arguments: z.object({
        usernames: z.array(z.string()).default([]).describe(
          "AniList usernames to track (fallback when usernamesFile is absent/unreadable)",
        ),
        usernamesFile: z.string().optional().describe(
          "Path to a file with anilist.co profile URLs or usernames, one per line (preferred source)",
        ),
        lookbackMinutes: z.number().min(5).max(10080).default(120).describe(
          "First-run window: how far back to look for users without a cursor entry",
        ),
        maxPages: z.number().min(1).max(10).default(6).describe(
          "Max activity pages (50/page) per run",
        ),
        telegramModel: z.string().default("").describe(
          "Swamp model name for Telegram send (e.g. tg-bot). Empty string disables sending.",
        ),
        telegramChatId: z.string().default("").describe(
          "Override target chat (numeric id or @channelusername). Empty = the telegram model's defaultChatId.",
        ),
        format: z.enum(["rich", "html"]).default("rich").describe(
          "Message format: 'rich' = Bot API 10.2 block digest (bold profile-linked usernames + linked titles, via sendRichMessage); 'html' = the legacy plain HTML digest (via sendMessage)",
        ),
        includeStatusChanges: z.boolean().default(true).describe(
          "Detect list verdicts: report 'dropped' titles (otherwise filtered out) and lift 'completed' into a dedicated 'Status changes' digest section. Set false to restore the progress-only digest that folds completions inline.",
        ),
        dryRun: z.boolean().default(false).describe(
          "Compute and store the feed but never send or advance the cursor",
        ),
        floorReset: z.boolean().default(false).describe(
          "Recovery: lower pinned window floors of never-delivered users to the lookback cutoff — use after an upstream outage silently returned empty results and floors advanced past real activity",
        ),
      }),
      execute: async (
        args: {
          usernames: string[];
          usernamesFile?: string;
          lookbackMinutes: number;
          maxPages: number;
          telegramModel: string;
          telegramChatId: string;
          format: "rich" | "html";
          includeStatusChanges: boolean;
          dryRun: boolean;
          floorReset: boolean;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
          readResource?: (name: string) => Promise<unknown>;
          logger?: {
            info: (m: string) => void;
            warn: (m: string) => void;
          };
        },
      ) => {
        const warn = (m: string) => context.logger?.warn?.(m);
        // Authenticated reads survive AniList degraded mode (which returns
        // empty activity lists to anonymous clients) and can see
        // followers-only activity feeds.
        const auth = context.globalArgs.accessToken;
        const gql = makeGql(auth);
        if (args.telegramModel && !isValidModelName(args.telegramModel)) {
          throw new Error(
            `Invalid telegramModel "${args.telegramModel}": must match [A-Za-z0-9_][A-Za-z0-9_-]*`,
          );
        }
        if (
          args.telegramChatId &&
          !/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(args.telegramChatId)
        ) {
          throw new Error(
            `Invalid telegramChatId "${args.telegramChatId}": numeric id or @channelusername expected`,
          );
        }

        // Username source: file preferred, inline fallback (e.g. on swamp
        // serve where the local file does not exist).
        let usernames: string[] = [];
        let usernamesSource = "inline";
        if (args.usernamesFile) {
          try {
            const parsed = parseUsernamesFile(
              await Deno.readTextFile(args.usernamesFile),
            );
            usernames = parsed.accepted;
            for (const r of parsed.rejected) {
              warn(
                `usernamesFile line ${r.line} ignored (not an AniList username or profile URL): ${r.text}`,
              );
            }
            usernamesSource = args.usernamesFile;
          } catch (e) {
            warn(`usernamesFile unreadable (${e}), using inline fallback`);
          }
        }
        if (usernames.length === 0) usernames = args.usernames;
        if (usernames.length === 0) {
          throw new Error(
            "No usernames: provide usernamesFile or a non-empty usernames array",
          );
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const lookbackCutoff = nowSec - args.lookbackMinutes * 60;

        const stored = await context.readResource!(
          "activity-cursor",
        ) as ActivityCursor | null;
        const cursor: ActivityCursor = stored?.users
          ? { users: { ...stored.users } }
          : { users: {} };

        // Resolve AniList userIds (cached in the cursor after the first run).
        // A private/renamed user is recorded, never fails the fan-out.
        const usersFailed: { name: string; reason: string }[] = [];
        const tracked: { name: string; userId: number }[] = [];
        for (const name of usernames) {
          const key = name.toLowerCase();
          const cached = cursor.users[key]?.userId;
          if (cached) {
            tracked.push({ name, userId: cached });
            continue;
          }
          try {
            const d = await gql(USER_ID_QUERY, { name });
            if (!d.User?.id) throw new Error("user not found");
            tracked.push({ name, userId: d.User.id });
            cursor.users[key] = {
              userId: d.User.id,
              lastSeenActivityId: 0,
              // Pin the dedupe window at first sight so a failed send can be
              // retried even after the relative lookback has moved on.
              lastSeenCreatedAt: lookbackCutoff,
            };
          } catch (e) {
            usersFailed.push({ name, reason: String(e).slice(0, 200) });
            warn(`Could not resolve AniList user "${name}": ${e}`);
          }
        }
        if (tracked.length === 0) {
          throw new Error(
            `Could not resolve any AniList users (${usersFailed.length} failed)`,
          );
        }

        // Recovery: an upstream outage that silently returned empty results
        // lets the floors advance past real activity — floorReset re-opens
        // the window down to this run's lookback cutoff for users that have
        // never had a delivered activity (id-cursored users are unaffected).
        if (args.floorReset) {
          for (const { name } of tracked) {
            const key = name.toLowerCase();
            const e = cursor.users[key];
            if (e && e.lastSeenActivityId === 0) {
              cursor.users[key] = {
                ...e,
                lastSeenCreatedAt: Math.min(
                  e.lastSeenCreatedAt ?? lookbackCutoff,
                  lookbackCutoff,
                ),
              };
            }
          }
        }

        // Per-user activity fetch, newest first. AniList's userId_in batch
        // filter silently returns [] (2026-07-05), so each user gets their
        // own query bounded by their own window floor.
        const rawActivities: ActivityItem[] = [];
        let pageCapHit = false;
        for (const { name, userId } of tracked) {
          const userFloor =
            cursor.users[name.toLowerCase()]?.lastSeenCreatedAt ??
              lookbackCutoff;
          // Per-user try/catch (mirrors the user-id resolution step above):
          // a hostile/malformed activities response for ONE user (now a
          // typed Error from gql()'s null-data guard, not an uncaught
          // TypeError) is recorded in usersFailed and the fan-out continues
          // for every other tracked user, instead of aborting the whole run.
          try {
            for (let page = 1; page <= args.maxPages; page++) {
              const d = await gql(
                ACTIVITIES_QUERY,
                {
                  userId,
                  createdAtGreater: userFloor,
                  page,
                  perPage: 50,
                },
              );
              const items = (d.Page.activities ?? [])
                .filter((a: { id?: number }) => a && typeof a.id === "number")
                .map((a: {
                  id: number;
                  createdAt: number;
                  status: string | null;
                  progress: string | null;
                  user: { id: number; name: string } | null;
                  media: {
                    id: number;
                    siteUrl: string | null;
                    title: { romaji: string | null; english: string | null };
                  } | null;
                }): ActivityItem => ({
                  id: a.id,
                  createdAt: a.createdAt,
                  userId: a.user?.id ?? 0,
                  userName: a.user?.name ?? "",
                  status: a.status ?? "",
                  progress: a.progress ?? null,
                  mediaId: a.media?.id ?? 0,
                  title: a.media?.title?.romaji ?? a.media?.title?.english ??
                    "?",
                  siteUrl: a.media?.siteUrl ?? null,
                  score: null,
                }));
              rawActivities.push(...items);
              if (!d.Page.pageInfo.hasNextPage) break;
              if (hasReachedOldActivities(items, cursor, lookbackCutoff)) {
                break;
              }
              if (page === args.maxPages) {
                pageCapHit = true;
                warn(
                  `Activity page cap (${args.maxPages}) hit for ${name} with more pages remaining — older new activities may be skipped this run`,
                );
              }
            }
          } catch (e) {
            usersFailed.push({ name, reason: String(e).slice(0, 200) });
            warn(
              `Could not fetch activities for "${name}" (continuing with other tracked users): ${e}`,
            );
          }
        }

        // Oldest-first so the Telegram message reads chronologically. Only
        // reportable activity is delivered; filtered-out items still advance
        // the cursor via the id ordering of what remains new. With verdict
        // detection off, "dropped" is dropped again and the filter is exactly
        // the old consumption-only one.
        const keep = args.includeStatusChanges
          ? isReportableActivity
          : isConsumptionActivity;
        const fresh = filterNewActivities(rawActivities, cursor, lookbackCutoff)
          .filter(keep)
          .sort((x, y) => x.id - y.id);

        // Enrich with the user's list score for the media (best effort —
        // a failed score lookup never blocks the notification).
        if (fresh.length > 0) {
          try {
            const d = await gql(
              ACTIVITY_SCORES_QUERY,
              {
                userIds: [...new Set(fresh.map((a) => a.userId))],
                mediaIds: [...new Set(fresh.map((a) => a.mediaId))],
                perPage: 50,
              },
            );
            const scores = new Map<string, number | null>(
              (d.Page.mediaList ?? []).map((
                m: { userId: number; mediaId: number; score: number | null },
              ) => [`${m.userId}:${m.mediaId}`, m.score]),
            );
            for (const a of fresh) {
              a.score = scores.get(`${a.userId}:${a.mediaId}`) ?? null;
            }
          } catch (e) {
            warn(`Score enrichment failed (continuing without scores): ${e}`);
          }
        }

        // Split verdicts out of the progress rows before rendering, so a
        // completion is stated once (in its own section) rather than folded
        // into a watch range. With detection off nothing is split and
        // `mergeActivities` folds completions inline as before.
        const { progress, statusChanges } = args.includeStatusChanges
          ? partitionActivities(fresh)
          : { progress: fresh, statusChanges: [] as ActivityItem[] };
        const changes = mergeStatusChanges(statusChanges);

        // Render both formats: HTML chunks (legacy / fallback) and the Bot API
        // 10.2 block digest. The `format` arg picks which one is delivered;
        // both are stored on the feed resource for debugging and rollback.
        const messages = fresh.length
          ? formatActivityMessages(progress, changes)
          : [];
        const merged = progress.length ? mergeActivities(progress) : [];
        const richMessage = fresh.length
          ? buildRichMessage(merged, changes)
          : null;

        // Deliver, then decide cursor policy:
        // - nothing new            → keep ids, bump createdAt floors
        // - delivered (all chunks) → advance ids + bump floors
        // - failed / dryRun / no telegramModel → hold cursor (retry next run)
        let sent = false;
        let sendError: string | null = null;
        if (fresh.length > 0 && args.telegramModel && !args.dryRun) {
          const chatId = args.telegramChatId || undefined;
          if (args.format === "rich") {
            const r = await sendRichTelegram(
              args.telegramModel,
              richMessage!,
              chatId,
            );
            sent = r.ok;
            if (!r.ok) {
              sendError = r.error ?? "unknown send failure";
              warn(`Telegram rich send failed, holding cursor: ${sendError}`);
            }
          } else {
            sent = true;
            for (const m of messages) {
              const r = await sendTelegram(args.telegramModel, m, chatId);
              if (!r.ok) {
                sent = false;
                sendError = r.error ?? "unknown send failure";
                warn(`Telegram send failed, holding cursor: ${sendError}`);
                break;
              }
            }
          }
        }

        const bumpFloors = (c: ActivityCursor): ActivityCursor => {
          const users = { ...c.users };
          for (const { name } of tracked) {
            const key = name.toLowerCase();
            const e = users[key];
            if (!e) continue;
            users[key] = {
              ...e,
              lastSeenCreatedAt: Math.max(
                e.lastSeenCreatedAt ?? 0,
                lookbackCutoff,
              ),
            };
          }
          return { users };
        };

        let nextCursor = cursor;
        if (fresh.length === 0 && !args.dryRun) {
          nextCursor = bumpFloors(cursor);
        } else if (sent) {
          nextCursor = bumpFloors(advanceCursor(cursor, fresh));
        }

        const feedHandle = await context.writeResource!(
          "activityFeed",
          "current",
          {
            checkedAt: new Date().toISOString(),
            usernamesSource,
            usersChecked: tracked.map((t) => t.name),
            usersFailed,
            newCount: fresh.length,
            activities: fresh,
            statusChanges: changes,
            statusChangeCount: changes.length,
            messages,
            richMessage: richMessage ? JSON.stringify(richMessage) : "",
            format: args.format,
            sent,
            sendError,
            pageCapHit,
            dryRun: args.dryRun,
          },
        );
        const cursorHandle = await context.writeResource!(
          "activityCursor",
          "activity-cursor",
          nextCursor,
        );
        return { dataHandles: [feedHandle, cursorHandle] };
      },
    },

    "ingest-scores": {
      description:
        "Ingest fan-out (charting pipeline): for each username, paginate their COMPLETED+CURRENT scored list (sequential, maxChunks cap) and write score rows to ClickHouse user_scores, then refresh anilist_metadata for every media id seen (deduped across users). The user_name written is byte-identical to the usernames-file spelling — user_scores ORDER BY is case-sensitive. This is the ONLY writer of these tables. Requires clickhouseUrl in globalArguments.",
      arguments: z.object({
        usernames: z.array(z.string()).default([]).describe(
          "AniList usernames to ingest (fallback when usernamesFile is absent/unreadable). Casing is preserved verbatim into user_scores.user_name.",
        ),
        usernamesFile: z.string().optional().describe(
          "Path to a file with anilist.co profile URLs or usernames, one per line (preferred source)",
        ),
        perChunk: z.number().min(1).max(500).default(500).describe(
          "MediaListCollection entries per chunk",
        ),
        maxChunks: z.number().min(1).max(50).default(20).describe(
          "Max list chunks per user per run (sequential pagination cap)",
        ),
        metadataBatchSize: z.number().min(1).max(50).default(50).describe(
          "Media ids per metadata fetch/insert batch (AniList Page perPage cap is 50)",
        ),
      }),
      execute: async (
        args: {
          usernames: string[];
          usernamesFile?: string;
          perChunk: number;
          maxChunks: number;
          metadataBatchSize: number;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
          logger?: {
            info: (m: string) => void;
            warn: (m: string) => void;
          };
        },
      ) => {
        const warn = (m: string) => context.logger?.warn?.(m);
        const info = (m: string) => context.logger?.info?.(m);
        const auth = context.globalArgs.accessToken;
        const gql = makeGql(auth);
        const cfg = clickhouseConfig(context.globalArgs);

        // Username source: file preferred (accepted names only, casing
        // verbatim), inline fallback. Rejections are surfaced, not dropped.
        let usernames: string[] = [];
        let usernamesSource = "inline";
        if (args.usernamesFile) {
          try {
            const parsed = parseUsernamesFile(
              await Deno.readTextFile(args.usernamesFile),
            );
            usernames = parsed.accepted;
            for (const r of parsed.rejected) {
              warn(
                `usernamesFile line ${r.line} ignored (not an AniList username or profile URL): ${r.text}`,
              );
            }
            usernamesSource = args.usernamesFile;
          } catch (e) {
            warn(`usernamesFile unreadable (${e}), using inline fallback`);
          }
        }
        if (usernames.length === 0) usernames = args.usernames;
        if (usernames.length === 0) {
          throw new Error(
            "No usernames: provide usernamesFile or a non-empty usernames array",
          );
        }

        const dataHandles: unknown[] = [];
        const allMediaIds = new Set<number>();
        const perUser: Array<{
          userName: string;
          scoresWritten: number;
          mediaIdsSeen: number;
          chunkCapHit: boolean;
        }> = [];
        let totalScoresWritten = 0;

        for (const userName of usernames) {
          const scoreRows: Array<
            { user_name: string; media_id: number; score: number }
          > = [];
          const userMediaIds = new Set<number>();
          let entriesSeen = 0;
          let chunksFetched = 0;
          let chunkCapHit = false;
          let hasNext = true;
          for (
            let chunk = 1;
            chunk <= args.maxChunks && hasNext;
            chunk++
          ) {
            const d = await gql(
              LIST_INGEST_QUERY,
              { userName, chunk, perChunk: args.perChunk },
            );
            chunksFetched++;
            const collection = d?.MediaListCollection;
            const entries = (collection?.lists ?? []).flatMap(
              (l: { entries?: unknown[] }) => l.entries ?? [],
            ) as Array<{ mediaId?: number | null; score?: number | null }>;
            entriesSeen += entries.length;
            for (const id of collectMediaIds(entries)) userMediaIds.add(id);
            scoreRows.push(...buildScoreRows(userName, entries));
            hasNext = collection?.hasNextChunk ?? false;
            if (hasNext && chunk === args.maxChunks) {
              chunkCapHit = true;
              warn(
                `List chunk cap (${args.maxChunks}) hit for ${userName} with more chunks remaining — some scores may be skipped this run`,
              );
            }
          }

          // Scores → user_scores. OMIT last_updated so the DDL DEFAULT now()
          // wins as the ReplacingMergeTree version.
          if (scoreRows.length > 0) {
            await clickhouseInsert(
              cfg,
              "user_scores",
              SCORE_COLUMNS,
              scoreRows,
            );
          }
          totalScoresWritten += scoreRows.length;
          for (const id of userMediaIds) allMediaIds.add(id);

          const handle = await context.writeResource!(
            "userlistScored",
            `scored-${userName}`,
            {
              userName,
              scoresWritten: scoreRows.length,
              entriesSeen,
              mediaIdsSeen: userMediaIds.size,
              chunksFetched,
              chunkCapHit,
              completedAt: new Date().toISOString(),
            },
          );
          dataHandles.push(handle);
          perUser.push({
            userName,
            scoresWritten: scoreRows.length,
            mediaIdsSeen: userMediaIds.size,
            chunkCapHit,
          });
          info(
            `Ingested ${scoreRows.length} scores for ${userName} (${userMediaIds.size} media ids)`,
          );
        }

        // Metadata refresh: ONLY the media ids not already in the table, so we
        // don't refetch thousands of unchanged titles and exhaust AniList's
        // rate limit (fetch_metadata.py:628 does the same).
        const existingMeta = await clickhouseDistinctMediaIds(
          cfg,
          "anilist_metadata",
        );
        const missingMediaIds = [...allMediaIds].filter(
          (id) => !existingMeta.has(id),
        );
        const metadataRowsWritten = await refreshMetadata(
          gql,
          cfg,
          missingMediaIds,
          args.metadataBatchSize,
        );

        const runHandle = await context.writeResource!("ingestRun", "current", {
          usernamesSource,
          usersIngested: perUser,
          totalScoresWritten,
          uniqueMediaIds: allMediaIds.size,
          metadataRowsWritten,
          completedAt: new Date().toISOString(),
        });
        dataHandles.push(runHandle);
        return { dataHandles };
      },
    },
    "refresh-metadata": {
      description:
        "Backfill AniList metadata for media ids present in user_scores but absent from anilist_metadata. Companion to ingest-scores that fetches ONLY the gap and no user lists, so it never refetches unchanged titles or re-hammers the score endpoints. Requires clickhouseUrl.",
      arguments: z.object({
        metadataBatchSize: z.number().min(1).max(50).default(50).describe(
          "Media ids per metadata fetch/insert batch (AniList Page perPage cap is 50)",
        ),
      }),
      execute: async (
        args: { metadataBatchSize: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
          logger?: { info: (m: string) => void; warn: (m: string) => void };
        },
      ) => {
        const info = (m: string) => context.logger?.info(m);
        const cfg = clickhouseConfig(context.globalArgs);
        const auth = context.globalArgs.accessToken;
        const gql = makeGql(auth);
        const scoreIds = await clickhouseDistinctMediaIds(cfg, "user_scores");
        const haveMeta = await clickhouseDistinctMediaIds(
          cfg,
          "anilist_metadata",
        );
        const missing = [...scoreIds].filter((id) => !haveMeta.has(id));
        info(
          `refresh-metadata: ${missing.length} of ${scoreIds.size} score media ids lack metadata`,
        );
        const written = await refreshMetadata(
          gql,
          cfg,
          missing,
          args.metadataBatchSize,
        );
        const handle = await context.writeResource(
          "metadataRefresh",
          "current",
          {
            missing: missing.length,
            written,
            completedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
