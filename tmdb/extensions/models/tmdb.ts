// @magistr/tmdb — The Movie Database (TMDB) v3 API for swamp.
//
// Read-only metadata lookups: free-text search, full details for one movie or
// TV show, and `match` — an idempotent fan-out that resolves a whole batch of
// parsed titles (title + alternative titles + year) to TMDB ids in ONE method
// run, embedding normalized details (genres, countries, languages, directors,
// cast, keywords, collection, runtime, ratings, poster) for every match.
//
// `match` persists its own output as a reusable cache: an entry whose query
// fingerprint is unchanged and whose verdict is younger than `ttlDays` is
// carried over without a request, so a converged re-run costs zero requests.
//
// Auth: a v4 "API Read Access Token" (JWT, sent as a Bearer header) or a v3
// API key (32 hex chars, sent as the `api_key` query parameter). The value is
// marked sensitive, never written into a resource, and redacted from every
// error message.

import { z } from "npm:zod@4";

// --- Global arguments ---

const GlobalArgsSchema = z.object({
  apiToken: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "TMDB v4 API Read Access Token (Bearer) or v3 API key (32 hex chars) — " +
        "use vault: ${{ vault.get(tmdb, TMDB_API_TOKEN) }}. " +
        "Get one at https://www.themoviedb.org/settings/api",
    ),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "must look like en-US or ru")
    .default("en-US")
    .describe("Language for titles/overviews/genres (ISO 639-1, e.g. en-US)"),
  region: z
    .string()
    .regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 code like NL")
    .default("NL")
    .describe("Region whose certification (age rating) is extracted"),
  includeAdult: z
    .boolean()
    .default(false)
    .describe("Include adult titles in search results"),
  minIntervalMs: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(100)
    .describe(
      "Minimum spacing between requests (TMDB tolerates ~40 req/s; 100ms keeps a whole-library match polite)",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(20000)
    .describe("Per-request timeout"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;

// --- HTTP: auth, rate limiting, retries ---

/** A v3 API key is 32 lowercase hex chars; anything else is treated as a v4
 * read-access token and sent as a Bearer header. */
export function isV3Key(token: string): boolean {
  return /^[0-9a-f]{32}$/i.test(token.trim());
}

/** Replace the token (and any api_key query value) with *** in a string. */
export function redact(s: string, token: string): string {
  let out = s.replace(/(api_key=)[^&\s"']+/gi, "$1***");
  const t = token.trim();
  if (t.length >= 8) out = out.split(t).join("***");
  return out;
}

/** Pure delay math for request spacing: how long to wait before the next
 * request given the timestamp of the previous one. */
export function rateLimitDelayMs(
  last: number | null,
  now: number,
  minIntervalMs: number,
): number {
  if (last === null || minIntervalMs <= 0) return 0;
  // Clamped to the interval: a clock that steps backwards must not stall.
  return Math.min(minIntervalMs, Math.max(0, last + minIntervalMs - now));
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into a bounded
 * millisecond backoff; unparseable or missing → 1s per attempt. */
export function retryAfterMs(
  header: string | null,
  attempt: number,
  now = Date.now(),
): number {
  let ms = NaN;
  if (header !== null && header.trim() !== "") {
    const secs = Number(header.trim());
    if (Number.isFinite(secs)) ms = secs * 1000;
    else {
      const at = Date.parse(header);
      if (Number.isFinite(at)) ms = at - now;
    }
  }
  if (!Number.isFinite(ms) || ms < 0) ms = 1000 * (attempt + 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

let lastRequest: number | null = null;
let rateLimitQueue: Promise<void> = Promise.resolve();

function reserveSlot(minIntervalMs: number): Promise<void> {
  const reservation = rateLimitQueue.then(async () => {
    const delay = rateLimitDelayMs(lastRequest, Date.now(), minIntervalMs);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    lastRequest = Date.now();
  });
  rateLimitQueue = reservation.catch(() => {});
  return reservation;
}

/** Thrown for a non-retryable TMDB error; `status` is the HTTP status. */
export class TmdbError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TmdbError";
    this.status = status;
  }
}

/** Counts requests made by one method run, so `match` can honour a budget. */
type Counter = { requests: number };

async function tmdbGet(
  g: GlobalArgs,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  counter?: Counter,
): Promise<Record<string, unknown>> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isV3Key(g.apiToken)) url.searchParams.set("api_key", g.apiToken.trim());
  else headers.Authorization = `Bearer ${g.apiToken.trim()}`;

  for (let attempt = 0;; attempt++) {
    await reserveSlot(g.minIntervalMs);
    if (counter) counter.requests++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), g.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers, signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES) continue;
      throw new TmdbError(
        0,
        redact(
          `TMDB request ${path} failed: ${(e as Error).message}`,
          g.apiToken,
        ),
      );
    }
    clearTimeout(timer);
    if (res.status === 429 || res.status >= 500) {
      const wait = retryAfterMs(res.headers.get("Retry-After"), attempt);
      await res.body?.cancel();
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new TmdbError(
        res.status,
        `TMDB ${path} still failing after ${MAX_RETRIES} retries (HTTP ${res.status})`,
      );
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new TmdbError(
        res.status,
        `TMDB ${path} returned non-JSON (HTTP ${res.status}): ${
          redact(text.slice(0, 200), g.apiToken)
        }`,
      );
    }
    if (!res.ok) {
      const msg = (body as { status_message?: unknown } | null)
        ?.status_message;
      throw new TmdbError(
        res.status,
        redact(
          `TMDB ${path} HTTP ${res.status}: ${
            typeof msg === "string" ? msg : text.slice(0, 200)
          }`,
          g.apiToken,
        ),
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TmdbError(res.status, `TMDB ${path} returned a non-object`);
    }
    return body as Record<string, unknown>;
  }
}

// --- Normalization ---

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Year of an ISO date string ("1994-07-06" → 1994), or null. */
export function yearOf(date: unknown): number | null {
  const s = str(date);
  if (!s) return null;
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Full image URL for a TMDB image path at the given size. */
export function imageUrl(path: unknown, size = "w500"): string | null {
  const p = str(path);
  return p && p.startsWith("/") ? `${IMAGE_BASE}/${size}${p}` : null;
}

/** One TMDB search result, normalised across movie and tv. */
export type SearchHit = {
  id: number;
  kind: "movie" | "tv";
  title: string;
  originalTitle: string | null;
  year: number | null;
  originalLanguage: string | null;
  popularity: number;
  voteCount: number;
  overview: string | null;
};

/** Normalize one /search/movie or /search/tv (or multi) result row. */
export function normalizeHit(
  raw: unknown,
  fallbackKind: "movie" | "tv",
): SearchHit | null {
  const r = obj(raw);
  const id = num(r.id);
  const mt = str(r.media_type);
  if (mt && mt !== "movie" && mt !== "tv") return null;
  const kind = (mt as "movie" | "tv" | null) ?? fallbackKind;
  const title = str(kind === "tv" ? r.name : r.title) ?? str(r.title) ??
    str(r.name);
  if (id === null || !title) return null;
  return {
    id,
    kind,
    title,
    originalTitle: str(kind === "tv" ? r.original_name : r.original_title),
    year: yearOf(kind === "tv" ? r.first_air_date : r.release_date),
    originalLanguage: str(r.original_language),
    popularity: num(r.popularity) ?? 0,
    voteCount: num(r.vote_count) ?? 0,
    overview: str(r.overview),
  };
}

const TitleDetailsSchema = z.object({
  id: z.number(),
  kind: z.enum(["movie", "tv"]),
  imdbId: z.string().nullable(),
  wikidataId: z.string().nullable(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  originalLanguage: z.string().nullable(),
  year: z.number().nullable(),
  releaseDate: z.string().nullable(),
  runtime: z.number().nullable(),
  genres: z.array(z.string()),
  countries: z.array(z.string()),
  spokenLanguages: z.array(z.string()),
  overview: z.string().nullable(),
  tagline: z.string().nullable(),
  voteAverage: z.number().nullable(),
  voteCount: z.number().nullable(),
  popularity: z.number().nullable(),
  certification: z.string().nullable(),
  directors: z.array(z.string()),
  writers: z.array(z.string()),
  cast: z.array(z.object({ name: z.string(), character: z.string() })),
  keywords: z.array(z.string()),
  collection: z.object({ id: z.number(), name: z.string() }).nullable(),
  seasons: z.number().nullable(),
  episodes: z.number().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  tmdbUrl: z.string(),
});

/** Normalised TMDB details for one movie or tv title. */
export type TitleDetails = z.infer<typeof TitleDetailsSchema>;

function uniq(xs: (string | null)[]): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}

/** Extract the region's certification from movie release_dates or tv
 * content_ratings. */
function certificationFor(
  raw: Record<string, unknown>,
  kind: "movie" | "tv",
  region: string,
): string | null {
  if (kind === "movie") {
    const row = arr(obj(raw.release_dates).results).map(obj).find((r) =>
      r.iso_3166_1 === region
    );
    for (const rd of arr(row?.release_dates).map(obj)) {
      const c = str(rd.certification);
      if (c) return c;
    }
    return null;
  }
  const row = arr(obj(raw.content_ratings).results).map(obj).find((r) =>
    r.iso_3166_1 === region
  );
  return row ? str(row.rating) : null;
}

/** Normalize a /movie/{id} or /tv/{id} body (with appended credits,
 * keywords, external_ids, release_dates/content_ratings). */
export function normalizeDetails(
  raw: Record<string, unknown>,
  kind: "movie" | "tv",
  region: string,
): TitleDetails {
  const id = num(raw.id);
  if (id === null) throw new TmdbError(200, "TMDB details without an id");
  const credits = obj(raw.credits);
  const crew = arr(credits.crew).map(obj);
  const ext = obj(raw.external_ids);
  const kwRoot = obj(raw.keywords);
  const kwList = arr(kind === "tv" ? kwRoot.results : kwRoot.keywords);
  const coll = obj(raw.belongs_to_collection);
  const collId = num(coll.id);
  const collName = str(coll.name);
  const runtime = kind === "movie"
    ? num(raw.runtime)
    : (num(arr(raw.episode_run_time)[0]) ?? null);
  const title = str(kind === "tv" ? raw.name : raw.title) ?? `#${id}`;
  return {
    id,
    kind,
    imdbId: str(raw.imdb_id) ?? str(ext.imdb_id),
    wikidataId: str(ext.wikidata_id),
    title,
    originalTitle: str(kind === "tv" ? raw.original_name : raw.original_title),
    originalLanguage: str(raw.original_language),
    year: yearOf(kind === "tv" ? raw.first_air_date : raw.release_date),
    releaseDate: str(kind === "tv" ? raw.first_air_date : raw.release_date),
    runtime: runtime && runtime > 0 ? runtime : null,
    genres: uniq(arr(raw.genres).map((g) => str(obj(g).name))),
    countries: uniq([
      ...arr(raw.production_countries).map((c) => str(obj(c).iso_3166_1)),
      ...arr(raw.origin_country).map(str),
    ]),
    spokenLanguages: uniq(
      arr(raw.spoken_languages).map((l) => str(obj(l).iso_639_1)),
    ),
    overview: str(raw.overview),
    tagline: str(raw.tagline),
    voteAverage: num(raw.vote_average),
    voteCount: num(raw.vote_count),
    popularity: num(raw.popularity),
    certification: certificationFor(raw, kind, region),
    directors: kind === "tv"
      ? uniq(arr(raw.created_by).map((c) => str(obj(c).name)))
      : uniq(crew.filter((c) => c.job === "Director").map((c) => str(c.name))),
    writers: uniq(
      crew
        .filter((c) => c.department === "Writing")
        .map((c) => str(c.name)),
    ).slice(0, 10),
    cast: arr(credits.cast)
      .map(obj)
      .sort((a, b) => (num(a.order) ?? 999) - (num(b.order) ?? 999))
      .slice(0, 10)
      .flatMap((c) => {
        const name = str(c.name);
        return name ? [{ name, character: str(c.character) ?? "" }] : [];
      }),
    keywords: uniq(kwList.map((k) => str(obj(k).name))).slice(0, 30),
    collection: collId !== null && collName
      ? { id: collId, name: collName }
      : null,
    seasons: kind === "tv" ? num(raw.number_of_seasons) : null,
    episodes: kind === "tv" ? num(raw.number_of_episodes) : null,
    posterUrl: imageUrl(raw.poster_path),
    backdropUrl: imageUrl(raw.backdrop_path, "w1280"),
    tmdbUrl: `https://www.themoviedb.org/${kind}/${id}`,
  };
}

// --- Title matching (pure) ---

const ARTICLES = new Set(["the", "a", "an", "le", "la", "les", "der", "die"]);

/** Fold a title for comparison: NFKD, strip combining marks, lowercase,
 * ё→е, "&"→"and", punctuation → space, collapse whitespace, drop a leading
 * article. Unicode letters/digits of every script are kept. */
export function normalizeTitle(s: string): string {
  const folded = s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const words = folded.split(" ");
  if (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.join(" ");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Similarity in [0,1] of two titles: 1 on normalized equality, otherwise
 * the max of the Sørensen–Dice bigram coefficient and the token-set
 * containment ratio (so "Alien" vs "Alien Director's Cut" scores well but
 * "Alien" vs "Aliens" does not reach 1). Symmetric. */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ga = bigrams(x);
  const gb = bigrams(y);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [g, v] of ga) inter += Math.min(v, gb.get(g) ?? 0);
  const dice = na + nb > 0 ? (2 * inter) / (na + nb) : 0;
  const ta = new Set(x.split(" "));
  const tb = new Set(y.split(" "));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const containment = common / Math.max(ta.size, tb.size);
  return Math.min(0.99, Math.max(dice, containment));
}

/** Year agreement in [0,1]: unknown query year is neutral (0.5). */
export function yearScore(query: number | null, hit: number | null): number {
  if (query === null) return 0.5;
  if (hit === null) return 0.3;
  const d = Math.abs(query - hit);
  return d === 0 ? 1 : d === 1 ? 0.7 : d === 2 ? 0.3 : 0;
}

/** The title, alternate titles and year to match against TMDB. */
export type MatchQuery = {
  title: string;
  altTitles: string[];
  year: number | null;
};

/** Score a hit against a query: 0.75 × best title similarity over every
 * (query title × hit title/original title) pair + 0.25 × year agreement,
 * plus a sub-0.01 popularity tiebreak. */
export function scoreHit(q: MatchQuery, hit: SearchHit): number {
  const qTitles = [q.title, ...q.altTitles].filter((t) => t.trim());
  const hTitles = [hit.title, hit.originalTitle].filter((t): t is string =>
    !!t
  );
  let best = 0;
  for (const a of qTitles) {
    for (const b of hTitles) best = Math.max(best, titleSimilarity(a, b));
  }
  const tiebreak = Math.min(0.009, Math.log10(1 + hit.voteCount) / 1000);
  return Math.round(
    (0.75 * best + 0.25 * yearScore(q.year, hit.year) +
      tiebreak) * 10000,
  ) / 10000;
}

/** Outcome of matching a query against TMDB search hits. */
export type Verdict = "matched" | "ambiguous" | "unmatched";

/** Rank hits (deduped by kind+id, best score first) and classify: matched
 * when the best clears `minScore` AND leads the runner-up by `minMargin`
 * (a runner-up with the SAME title and year — remakes are not, a re-listing
 * is — does not count against the lead); ambiguous when it clears minScore
 * but the lead is too thin; unmatched otherwise. */
export function classifyHits(
  q: MatchQuery,
  hits: SearchHit[],
  minScore: number,
  minMargin = 0.05,
): {
  verdict: Verdict;
  ranked: (SearchHit & { score: number })[];
} {
  const seen = new Set<string>();
  const ranked: (SearchHit & { score: number })[] = [];
  for (const h of hits) {
    const k = `${h.kind}:${h.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ranked.push({ ...h, score: scoreHit(q, h) });
  }
  ranked.sort((a, b) => b.score - a.score || b.voteCount - a.voteCount);
  const top = ranked[0];
  if (!top || top.score < minScore) return { verdict: "unmatched", ranked };
  const second = ranked[1];
  if (!second || top.score - second.score >= minMargin) {
    return { verdict: "matched", ranked };
  }
  return { verdict: "ambiguous", ranked };
}

/** Stable fingerprint of a match item's query, so a cached verdict is
 * reused only while the question asked is unchanged. */
export function queryFingerprint(item: {
  title: string;
  altTitles?: string[];
  year?: number | null;
  kind?: string;
  tmdbId?: number | null;
}): string {
  return JSON.stringify([
    normalizeTitle(item.title),
    (item.altTitles ?? []).map(normalizeTitle).sort(),
    item.year ?? null,
    item.kind ?? "movie",
    item.tmdbId ?? null,
  ]);
}

/** True when a cached entry must be re-resolved. */
export function needsRefresh(
  prior: { fingerprint?: string; status?: string; checkedAt?: string } | null,
  fingerprint: string,
  now: number,
  ttlMs: number,
): boolean {
  if (!prior) return true;
  if (prior.fingerprint !== fingerprint) return true;
  if (prior.status === "error" || prior.status === "pending") return true;
  const at = prior.checkedAt ? Date.parse(prior.checkedAt) : NaN;
  if (!Number.isFinite(at)) return true;
  return now - at > ttlMs;
}

// --- Resource schemas ---

const HitSchema = z.object({
  id: z.number(),
  kind: z.enum(["movie", "tv"]),
  title: z.string(),
  originalTitle: z.string().nullable(),
  year: z.number().nullable(),
  originalLanguage: z.string().nullable(),
  popularity: z.number(),
  voteCount: z.number(),
  overview: z.string().nullable(),
  score: z.number().optional(),
});

const SearchSchema = z.object({
  kind: z.literal("search"),
  query: z.string(),
  year: z.number().nullable(),
  mediaType: z.enum(["movie", "tv", "multi"]),
  totalResults: z.number(),
  results: z.array(HitSchema),
  fetchedAt: z.string(),
});

const TitleSchema = TitleDetailsSchema.extend({ fetchedAt: z.string() });

const MatchEntrySchema = z.object({
  key: z.string(),
  query: z.object({
    title: z.string(),
    altTitles: z.array(z.string()),
    year: z.number().nullable(),
    kind: z.enum(["movie", "tv"]),
    tmdbId: z.number().nullable(),
  }),
  fingerprint: z.string(),
  status: z.enum(["matched", "pinned", "ambiguous", "unmatched", "error"]),
  score: z.number().nullable(),
  tmdbId: z.number().nullable(),
  candidates: z.array(HitSchema),
  details: TitleDetailsSchema.nullable(),
  error: z.string().nullable(),
  checkedAt: z.string(),
});

/** One stored match result for a query. */
export type MatchEntry = z.infer<typeof MatchEntrySchema>;

const MatchSchema = z.object({
  kind: z.literal("match"),
  name: z.string(),
  language: z.string(),
  entries: z.array(MatchEntrySchema),
  pending: z.array(z.string()),
  stats: z.object({
    requested: z.number(),
    reused: z.number(),
    resolved: z.number(),
    matched: z.number(),
    pinned: z.number(),
    ambiguous: z.number(),
    unmatched: z.number(),
    errors: z.number(),
    pending: z.number(),
    carriedOutsideInput: z.number(),
    requests: z.number(),
  }),
  stopReason: z.enum(["complete", "maxQueries"]),
  updatedAt: z.string(),
});

const MatchItemSchema = z.object({
  key: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  altTitles: z.array(z.string().max(500)).max(8).default([]),
  year: z.number().int().min(1870).max(2100).nullable().optional(),
  kind: z.enum(["movie", "tv"]).default("movie"),
  tmdbId: z.number().int().positive().nullable().optional(),
});

type MatchItem = z.infer<typeof MatchItemSchema>;

const TitlesSchema = z.object({
  kind: z.literal("titles"),
  name: z.string(),
  language: z.string(),
  /** Keyed "<movie|tv>:<id>". */
  titles: z.record(z.string(), TitleSchema),
  failed: z.array(z.object({ ref: z.string(), error: z.string() })),
  pending: z.array(z.string()),
  stats: z.object({
    requested: z.number(),
    reused: z.number(),
    fetched: z.number(),
    failed: z.number(),
    pending: z.number(),
    carriedOutsideInput: z.number(),
    requests: z.number(),
  }),
  updatedAt: z.string(),
});

/** True when a cached title must be refetched (missing, or older than
 * ttlMs). */
export function titleIsStale(
  cached: { fetchedAt?: string } | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (!cached) return true;
  const at = cached.fetchedAt ? Date.parse(cached.fetchedAt) : NaN;
  return !Number.isFinite(at) || now - at > ttlMs;
}

/** Resource-name safe slug (ASCII, transliteration-free: non-ASCII becomes
 * part of the hash suffix only). */
function slug(s: string, max = 40): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "x";
}

/** 8-hex FNV-1a hash of a string. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(s)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// --- Core operations (shared by methods) ---

async function searchRaw(
  g: GlobalArgs,
  query: string,
  year: number | null,
  mediaType: "movie" | "tv" | "multi",
  counter?: Counter,
): Promise<{ total: number; hits: SearchHit[] }> {
  const params: Record<string, string | number | boolean | undefined> = {
    query,
    language: g.language,
    include_adult: g.includeAdult,
    page: 1,
  };
  if (year !== null) {
    if (mediaType === "movie") params.year = year;
    else if (mediaType === "tv") params.first_air_date_year = year;
  }
  const body = await tmdbGet(g, `/search/${mediaType}`, params, counter);
  const fallback = mediaType === "tv" ? "tv" : "movie";
  const hits = arr(body.results)
    .map((r) => normalizeHit(r, fallback))
    .filter((h): h is SearchHit => h !== null);
  return { total: num(body.total_results) ?? hits.length, hits };
}

async function fetchDetails(
  g: GlobalArgs,
  kind: "movie" | "tv",
  id: number,
  counter?: Counter,
): Promise<TitleDetails> {
  const append = kind === "movie"
    ? "credits,keywords,external_ids,release_dates"
    : "credits,keywords,external_ids,content_ratings";
  const body = await tmdbGet(
    g,
    `/${kind}/${id}`,
    { language: g.language, append_to_response: append },
    counter,
  );
  return normalizeDetails(body, kind, g.region);
}

/** Resolve one item: search every distinct query title with the year, fall
 * back to a yearless search when nothing came back, then classify. */
async function resolveItem(
  g: GlobalArgs,
  item: MatchItem,
  opts: { minScore: number; details: boolean },
  counter: Counter,
): Promise<Omit<MatchEntry, "key" | "query" | "fingerprint" | "checkedAt">> {
  const kind = item.kind;
  if (item.tmdbId) {
    const details = await fetchDetails(g, kind, item.tmdbId, counter);
    return {
      status: "pinned",
      score: null,
      tmdbId: details.id,
      candidates: [],
      details,
      error: null,
    };
  }
  const year = item.year ?? null;
  const titles = [...new Set([item.title, ...item.altTitles])].filter((t) =>
    normalizeTitle(t)
  );
  const hits: SearchHit[] = [];
  for (const t of titles) {
    hits.push(...(await searchRaw(g, t, year, kind, counter)).hits);
  }
  if (hits.length === 0 && year !== null) {
    for (const t of titles) {
      hits.push(...(await searchRaw(g, t, null, kind, counter)).hits);
    }
  }
  const q = { title: item.title, altTitles: item.altTitles, year };
  const { verdict, ranked } = classifyHits(q, hits, opts.minScore);
  const top = ranked[0] ?? null;
  const details = verdict === "matched" && top && opts.details
    ? await fetchDetails(g, top.kind, top.id, counter)
    : null;
  return {
    status: verdict,
    score: top?.score ?? null,
    tmdbId: verdict === "matched" && top ? top.id : null,
    candidates: ranked.slice(0, 5),
    details,
    error: null,
  };
}

/** Parsed content of a readResource result (handles both raw objects and
 * DataRecord-shaped rows). */
function resourceContent(r: unknown): Record<string, unknown> | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (o.attributes && typeof o.attributes === "object") {
    return o.attributes as Record<string, unknown>;
  }
  if (o.content && typeof o.content === "object") {
    return o.content as Record<string, unknown>;
  }
  if (typeof o.content === "string") {
    try {
      return JSON.parse(o.content);
    } catch {
      return null;
    }
  }
  return o;
}

// --- Model ---

/** @magistr/tmdb model: search, details, and batch title matching against
 * The Movie Database. */
export const model = {
  type: "@magistr/tmdb",
  version: "2026.10.15.8",
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.4",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.5",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.6",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.7",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.8",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    search: {
      description: "Raw search results for one query",
      schema: SearchSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    title: {
      description: "Normalized details of one movie or TV show",
      schema: TitleSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    titles: {
      description:
        "Batch details cache: normalized details for many movies/shows, keyed kind:id",
      schema: TitlesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    match: {
      description:
        "Batch title→TMDB resolution cache: verdict, candidates and embedded details per item key",
      schema: MatchSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    search: {
      description: "Search TMDB for a movie, TV show, or both (multi)",
      arguments: z.object({
        query: z.string().min(1).max(500).describe("Free-text title query"),
        year: z
          .number()
          .int()
          .min(1870)
          .max(2100)
          .optional()
          .describe("Release / first-air year filter (movie and tv only)"),
        mediaType: z
          .enum(["movie", "tv", "multi"])
          .default("movie")
          .describe("Which search endpoint to use"),
      }),
      execute: async (args, context) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const year = args.year ?? null;
        const { total, hits } = await searchRaw(
          g,
          args.query,
          year,
          args.mediaType,
        );
        const q = { title: args.query, altTitles: [], year };
        const results = hits
          .map((h) => ({ ...h, score: scoreHit(q, h) }))
          .sort((a, b) => b.score - a.score);
        const name = `search-${args.mediaType}-${slug(args.query)}-${
          hash8(`${args.query}|${year}|${args.mediaType}`)
        }`;
        const handle = await context.writeResource("search", name, {
          kind: "search",
          query: args.query,
          year,
          mediaType: args.mediaType,
          totalResults: total,
          results,
          fetchedAt: new Date().toISOString(),
        });
        context.logger?.info?.(
          `search "${args.query}": ${results.length} result(s), best ${
            results[0] ? `${results[0].title} (${results[0].year})` : "none"
          }`,
        );
        return { dataHandles: [handle] };
      },
    },
    details: {
      description:
        "Fetch full details (credits, keywords, external ids, certification) for one movie or TV show",
      arguments: z.object({
        id: z.number().int().positive().describe("TMDB id"),
        kind: z.enum(["movie", "tv"]).default("movie"),
      }),
      execute: async (args, context) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const details = await fetchDetails(g, args.kind, args.id);
        const handle = await context.writeResource(
          "title",
          `${args.kind}-${args.id}`,
          { ...details, fetchedAt: new Date().toISOString() },
        );
        return { dataHandles: [handle] };
      },
    },
    enrich: {
      description:
        "Fetch details for many TMDB ids in one run (fan-out) into one titles resource; idempotent via a TTL cache",
      arguments: z.object({
        ids: z
          .array(
            z.object({
              id: z.number().int().positive(),
              kind: z.enum(["movie", "tv"]).default("movie"),
            }),
          )
          .max(20000)
          .describe("TMDB ids to enrich"),
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
          .default("titles")
          .describe("Name of the titles resource (one cache per name)"),
        ttlDays: z
          .number()
          .min(0)
          .default(90)
          .describe("Refetch a cached title older than this"),
        refresh: z.boolean().default(false).describe("Refetch everything"),
        maxRequests: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Stop after this many requests (0 = no cap)"),
        prune: z
          .boolean()
          .default(false)
          .describe("Drop cached titles not in this run's ids"),
      }),
      execute: async (args, context) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const now = Date.now();
        const ttlMs = args.ttlDays * 86400000;
        const prior: Record<string, z.infer<typeof TitleSchema>> = {};
        try {
          const content = resourceContent(
            await context.readResource?.(args.name),
          );
          for (const [k, v] of Object.entries(obj(content?.titles))) {
            const p = TitleSchema.safeParse(v);
            if (p.success) prior[k] = p.data;
          }
        } catch {
          // no prior cache
        }
        const counter: Counter = { requests: 0 };
        const out: Record<string, z.infer<typeof TitleSchema>> = {};
        const failed: { ref: string; error: string }[] = [];
        const pending: string[] = [];
        const wanted = new Set<string>();
        let reused = 0;
        let fetched = 0;
        for (const { id, kind } of args.ids) {
          const ref = `${kind}:${id}`;
          if (wanted.has(ref)) continue;
          wanted.add(ref);
          if (!args.refresh && !titleIsStale(prior[ref], now, ttlMs)) {
            out[ref] = prior[ref];
            reused++;
            continue;
          }
          if (args.maxRequests > 0 && counter.requests >= args.maxRequests) {
            pending.push(ref);
            if (prior[ref]) out[ref] = prior[ref];
            continue;
          }
          try {
            const d = await fetchDetails(g, kind, id, counter);
            out[ref] = { ...d, fetchedAt: new Date().toISOString() };
            fetched++;
          } catch (e) {
            if (e instanceof TmdbError && e.status === 401) {
              throw new Error(
                `TMDB rejected the API token (401) — check the tmdb vault secret: ${e.message}`,
              );
            }
            failed.push({
              ref,
              error: redact((e as Error).message, g.apiToken).slice(0, 300),
            });
            if (prior[ref]) out[ref] = prior[ref];
          }
        }
        let carriedOutsideInput = 0;
        if (!args.prune) {
          for (const [k, v] of Object.entries(prior)) {
            if (!wanted.has(k)) {
              out[k] = v;
              carriedOutsideInput++;
            }
          }
        }
        const stats = {
          requested: wanted.size,
          reused,
          fetched,
          failed: failed.length,
          pending: pending.length,
          carriedOutsideInput,
          requests: counter.requests,
        };
        const handle = await context.writeResource("titles", args.name, {
          kind: "titles",
          name: args.name,
          language: g.language,
          titles: out,
          failed,
          pending,
          stats,
          updatedAt: new Date(now).toISOString(),
        });
        context.logger?.info?.(`enrich ${args.name}: ${JSON.stringify(stats)}`);
        return { dataHandles: [handle] };
      },
    },
    match: {
      description:
        "Resolve a batch of parsed titles to TMDB ids in one run (fan-out), embedding details; idempotent via a TTL cache of prior verdicts",
      arguments: z.object({
        items: z
          .array(MatchItemSchema)
          .max(20000)
          .describe(
            "Items to resolve: {key, title, altTitles?, year?, kind?, tmdbId?}. A tmdbId pins the item (details only, no search)",
          ),
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
          .default("matches")
          .describe("Name of the match resource (one cache per name)"),
        ttlDays: z
          .number()
          .min(0)
          .default(30)
          .describe("Reuse a cached verdict younger than this"),
        refresh: z
          .boolean()
          .default(false)
          .describe("Ignore the cache and re-resolve every item"),
        refreshKeys: z
          .array(z.string())
          .default([])
          .describe("Re-resolve just these item keys (resolved first)"),
        maxQueries: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Stop issuing requests after this many (0 = no cap); the rest are listed as pending and resolved on the next run",
          ),
        minScore: z
          .number()
          .min(0)
          .max(1)
          .default(0.72)
          .describe("Minimum score for a candidate to count as a match"),
        details: z
          .boolean()
          .default(false)
          .describe(
            "Also fetch and embed full details for each match (the enrich method is the batch way to do this)",
          ),
        prune: z
          .boolean()
          .default(false)
          .describe(
            "Drop cached entries whose key is not in this run's items (default keeps them)",
          ),
      }),
      execute: async (args, context) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const ttlMs = args.ttlDays * 86400000;

        const keys = new Set<string>();
        for (const it of args.items) {
          if (keys.has(it.key)) {
            throw new Error(`match: duplicate item key "${it.key}"`);
          }
          keys.add(it.key);
        }

        const prior = new Map<string, MatchEntry>();
        try {
          const raw = await context.readResource?.(args.name);
          const content = resourceContent(raw);
          for (const e of arr(content?.entries)) {
            const p = MatchEntrySchema.safeParse(e);
            if (p.success) prior.set(p.data.key, p.data);
          }
        } catch {
          // no prior cache — start empty
        }

        const refreshKeys = new Set(args.refreshKeys);
        const ordered = [
          ...args.items.filter((i) => refreshKeys.has(i.key)),
          ...args.items.filter((i) => !refreshKeys.has(i.key)),
        ];

        const counter: Counter = { requests: 0 };
        const out = new Map<string, MatchEntry>();
        const pending: string[] = [];
        let reused = 0;
        let resolved = 0;
        let stopReason: "complete" | "maxQueries" = "complete";

        for (const item of ordered) {
          const query = {
            title: item.title,
            altTitles: item.altTitles,
            year: item.year ?? null,
            kind: item.kind,
            tmdbId: item.tmdbId ?? null,
          };
          const fp = queryFingerprint(query);
          const old = prior.get(item.key) ?? null;
          const force = args.refresh || refreshKeys.has(item.key);
          if (!force && !needsRefresh(old, fp, now, ttlMs)) {
            out.set(item.key, old!);
            reused++;
            continue;
          }
          if (args.maxQueries > 0 && counter.requests >= args.maxQueries) {
            stopReason = "maxQueries";
            pending.push(item.key);
            if (old) out.set(item.key, old);
            continue;
          }
          try {
            const r = await resolveItem(
              g,
              item,
              { minScore: args.minScore, details: args.details },
              counter,
            );
            out.set(item.key, {
              key: item.key,
              query,
              fingerprint: fp,
              ...r,
              checkedAt: nowIso,
            });
            resolved++;
          } catch (e) {
            if (e instanceof TmdbError && e.status === 401) {
              throw new Error(
                `TMDB rejected the API token (401) — check the tmdb vault secret: ${e.message}`,
              );
            }
            out.set(item.key, {
              key: item.key,
              query,
              fingerprint: fp,
              status: "error",
              score: null,
              tmdbId: null,
              candidates: [],
              details: null,
              error: redact((e as Error).message, g.apiToken).slice(0, 500),
              checkedAt: nowIso,
            });
            resolved++;
          }
        }

        let carriedOutsideInput = 0;
        if (!args.prune) {
          for (const [k, e] of prior) {
            if (!keys.has(k)) {
              out.set(k, e);
              carriedOutsideInput++;
            }
          }
        }

        const entries = [...out.values()].sort((a, b) =>
          a.key.localeCompare(b.key)
        );
        const inInput = entries.filter((e) => keys.has(e.key));
        const count = (s: MatchEntry["status"]) =>
          inInput.filter((e) => e.status === s).length;
        const stats = {
          requested: args.items.length,
          reused,
          resolved,
          matched: count("matched"),
          pinned: count("pinned"),
          ambiguous: count("ambiguous"),
          unmatched: count("unmatched"),
          errors: count("error"),
          pending: pending.length,
          carriedOutsideInput,
          requests: counter.requests,
        };
        const handle = await context.writeResource("match", args.name, {
          kind: "match",
          name: args.name,
          language: g.language,
          entries,
          pending,
          stats,
          stopReason,
          updatedAt: nowIso,
        });
        context.logger?.info?.(
          `match ${args.name}: ${stats.matched} matched, ${stats.pinned} pinned, ${stats.ambiguous} ambiguous, ${stats.unmatched} unmatched, ${stats.errors} errors, ${stats.pending} pending (${stats.reused} reused, ${stats.requests} requests)`,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
