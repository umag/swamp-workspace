import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// @magistr/lastfm
//
// Read a user's scrobble history and listening statistics from the Last.fm 2.0
// web API. Every method here is an unauthenticated read — Last.fm requires an
// api_key but no session key or MD5 request signature for `user.*`, `artist.*`,
// `album.*` and `track.*` reads.
//
// Two things about this API shape the whole model:
//
//  1. The credential travels as a QUERY PARAMETER. There is no header-auth
//     alternative. So the base URL is pinned to https (the published docs give
//     an http:// root, which would put the key in cleartext on the wire), a
//     non-https override is refused rather than requested, and every URL passes
//     through redactKey() before it can reach an error, a log, or a fixture.
//
//  2. Failures arrive as HTTP 200 with an {error, message} body. A bare
//     response.ok check reads them as success. Codes are classified into
//     permanent (fail fast) and transient (retry with backoff) per
//     https://www.last.fm/api/errorcodes.
//
// The scrobble history is paged into one `scrobbles.<year>` resource per
// calendar year. Year chunks are a persistence partitioning of a single
// ScrobbleHistory aggregate, not separate aggregates: closed years never
// change, so only the current year is rewritten, which is what makes the sync
// idempotent.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "https://ws.audioscrobbler.com/2.0/";
const DEFAULT_UA =
  "swamp-lastfm/1.0 (+https://github.com/umag/swamp-workspace)";
const USERNAME = /^[A-Za-z0-9_-]{1,15}$/;

/** Last.fm error codes that will never succeed on retry. */
const PERMANENT = new Set([6, 10, 26]);
/** Last.fm error codes worth retrying with backoff. */
const TRANSIENT = new Set([8, 11, 16, 29]);

const PERIODS = [
  "overall",
  "7day",
  "1month",
  "3month",
  "6month",
  "12month",
] as const;

const usernameSchema = z
  .string()
  .regex(USERNAME, "must be 1-15 chars of A-Z, a-z, 0-9, _ or -");

const GlobalArgsSchema = z.object({
  user: usernameSchema.describe("Last.fm username whose data this model reads"),
  apiKey: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Last.fm API key — use vault: ${{ vault.get(lastfm, LASTFM_API_KEY) }}. " +
        "Register one at https://www.last.fm/api/account/create",
    ),
  baseUrl: z
    .string()
    .optional()
    .describe(
      "API root (default https://ws.audioscrobbler.com/2.0/). Must be https: — " +
        "the api_key travels as a query parameter, so plaintext would expose it.",
    ),
  userAgent: z
    .string()
    .optional()
    .describe("Override the identifiable User-Agent required by the API ToS"),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Per-request timeout in ms (default 15000)"),
  minIntervalMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum gap between requests in ms (default 200)"),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Retries for transient errors (default 3)"),
  retryBaseMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Base backoff in ms, doubled per attempt (default 250)"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * One play event, normalized out of the API's loose JSON. `uts` is the UNIX
 * second at which the track started playing; it is mandatory, because an entry
 * without one has no position in the history and is therefore not a scrobble.
 * The mbid fields are absent rather than `""` when Last.fm has no MusicBrainz
 * id — see {@link normalizeMbid}.
 */
export type Scrobble = {
  uts: number;
  artist: string;
  album?: string;
  track: string;
  artistMbid?: string;
  albumMbid?: string;
  trackMbid?: string;
};

/**
 * The currently-playing track. The API returns it inline with recent tracks
 * but gives it no timestamp, so it is modelled separately from
 * {@link Scrobble} precisely so it cannot be mistaken for history.
 */
export type NowPlaying = {
  artist: string;
  album?: string;
  track: string;
};

/**
 * The execution context swamp passes to a method. `readResource` is optional
 * because not every execution driver supplies it: `sync-history` resumes from
 * the stored cursor when it is present and falls back to a full walk when it
 * is not, which the dedup predicate makes harmless.
 */
export type Ctx = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warning?: (msg: string, data?: Record<string, unknown>) => void;
    error?: (msg: string, data?: Record<string, unknown>) => void;
  };
  readResource?: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// --- normalizers (the anti-corruption layer) -------------------------------

/**
 * Strip credential-bearing parameters from a URL so it is safe to log or throw.
 * Falls back to a textual scrub when the input is not a parsable URL — this is
 * called on error paths, where throwing again would mask the real failure.
 */
export function redactKey(url: string): string {
  try {
    const u = new URL(url);
    for (const param of ["api_key", "api_sig", "sk"]) {
      if (u.searchParams.has(param)) u.searchParams.set(param, "REDACTED");
    }
    return u.toString();
  } catch {
    return url.replace(
      /((?:api_key|api_sig|sk)=)[^&\s]+/gi,
      "$1REDACTED",
    );
  }
}

/**
 * Classify a Last.fm error code. Unknown codes are treated as permanent: an
 * unrecognised failure repeated at speed is how an API key gets suspended
 * (code 26), so the safe default is to stop rather than to hammer.
 */
export function classifyError(code: number): "permanent" | "transient" {
  if (TRANSIENT.has(code)) return "transient";
  if (PERMANENT.has(code)) return "permanent";
  return "permanent";
}

/** Last.fm sends absent MusicBrainz ids as "" rather than omitting them. */
export function normalizeMbid(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Numbers arrive as strings throughout the API. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Single-element lists arrive as a bare object instead of a one-item array. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// --- scrobble identity and partitioning ------------------------------------

/**
 * A play event is defined entirely by its values, so identity is
 * (uts, artist, track). Album is deliberately excluded: Last.fm frequently
 * revises or drops the album on an existing scrobble, and treating that as a
 * different play would double-count it on the next sync.
 *
 * The delimiter is NUL, written as an escape so the source stays plain text
 * (a raw NUL byte here makes `file` report "data" and silences grep). A
 * printable separator would be ambiguous: with a space, the artist/track pairs
 * ("a b", "c") and ("a", "b c") collide, so one real scrobble would silently
 * swallow another. NUL cannot occur in a Last.fm artist or track name.
 */
export function scrobbleKey(s: Scrobble): string {
  return `${s.uts}\u0000${s.artist}\u0000${s.track}`;
}

/**
 * Collapse repeated plays to one entry per {@link scrobbleKey}, preserving
 * first-seen order. Needed because a paged walk overlaps at page boundaries
 * and because a resumed sync deliberately re-fetches a range it may already
 * hold — this is what makes re-running the sync a no-op rather than a
 * double-count.
 */
export function dedupeScrobbles(rows: Scrobble[]): Scrobble[] {
  const seen = new Set<string>();
  const out: Scrobble[] = [];
  for (const row of rows) {
    const key = scrobbleKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Split a run of scrobbles into UTC calendar years, keyed by the year string.
 * This is the persistence partitioning of the single ScrobbleHistory
 * aggregate, not an aggregate boundary: a closed year never changes, so only
 * the current year is ever rewritten, which is what keeps the sync idempotent.
 */
export function partitionByYear(rows: Scrobble[]): Map<string, Scrobble[]> {
  const parts = new Map<string, Scrobble[]>();
  for (const row of rows) {
    const year = String(new Date(row.uts * 1000).getUTCFullYear());
    const bucket = parts.get(year);
    if (bucket) bucket.push(row);
    else parts.set(year, [row]);
  }
  return parts;
}

/**
 * Data instance names are keyed on the instance alone and are NOT scoped per
 * resource spec, so a bare "2007" would collide with any other spec writing
 * that instance. The kind suffix keeps the namespace disjoint.
 */
export function chunkName(year: string): string {
  return `scrobbles.${year}`;
}

// --- response parsing ------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Json = any;

/**
 * Parse one page of user.getRecentTracks.
 *
 * The currently-playing track is returned inside the same `track` array with
 * `@attr.nowplaying = "true"` and NO `date.uts`. It is not a scrobble: letting
 * it into the history would give it no position in time, corrupt the cursor,
 * and double-count it once it is actually scrobbled. It is surfaced separately
 * instead. A track that has no date and no nowplaying flag is malformed and is
 * dropped for the same reason.
 */
export function parseRecentTracksPage(json: unknown): {
  scrobbles: Scrobble[];
  nowPlaying?: NowPlaying;
  page: number;
  totalPages: number;
} {
  const root = (json as Json)?.recenttracks;
  if (!root) {
    throw new Error("Malformed response: no `recenttracks` object");
  }
  const attr = root["@attr"] ?? {};
  const page = toNumber(attr.page) ?? 1;
  const totalPages = toNumber(attr.totalPages) ?? 0;

  const scrobbles: Scrobble[] = [];
  let nowPlaying: NowPlaying | undefined;

  for (const t of asArray<Json>(root.track)) {
    const artist = t?.artist?.["#text"] ?? t?.artist?.name ?? t?.artist;
    const track = t?.name;
    const album = t?.album?.["#text"] ?? undefined;
    if (typeof artist !== "string" || typeof track !== "string") continue;

    if (t?.["@attr"]?.nowplaying === "true") {
      nowPlaying = {
        artist,
        track,
        album: album && album.length > 0 ? album : undefined,
      };
      continue;
    }

    const uts = toNumber(t?.date?.uts);
    if (uts === undefined) continue;

    scrobbles.push({
      uts,
      artist,
      track,
      album: album && album.length > 0 ? album : undefined,
      artistMbid: normalizeMbid(t?.artist?.mbid),
      albumMbid: normalizeMbid(t?.album?.mbid),
      trackMbid: normalizeMbid(t?.mbid),
    });
  }

  return { scrobbles, nowPlaying, page, totalPages };
}

/** The cursor is monotonic — a late-arriving older page can never rewind it. */
export function advanceCursor(prev: number, rows: Scrobble[]): number {
  let max = prev;
  for (const row of rows) if (row.uts > max) max = row.uts;
  return max;
}

// --- transport -------------------------------------------------------------

let lastCallAt = 0;

const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Serialize requests behind a minimum interval — the API suspends abusers. */
async function throttle(minIntervalMs: number): Promise<void> {
  const wait = lastCallAt + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function resolveBase(globalArgs: GlobalArgs): string {
  const base = globalArgs.baseUrl ?? DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Invalid baseUrl: ${base}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `baseUrl must use https: (got ${parsed.protocol}). The Last.fm api_key ` +
        `travels as a query parameter, so plaintext HTTP would expose it on ` +
        `the wire.`,
    );
  }
  return base;
}

class LastfmError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly kind: "permanent" | "transient" | "transport",
  ) {
    super(message);
    this.name = "LastfmError";
  }
}

/**
 * One API call, with the credential kept out of every diagnostic.
 * Retries only the transient error set, with exponential backoff.
 */
async function callApi(
  context: Ctx,
  method: string,
  params: Record<string, string | number | undefined>,
): Promise<Json> {
  const g = context.globalArgs;
  const base = resolveBase(g);
  const timeoutMs = g.timeoutMs ?? 15_000;
  const minIntervalMs = g.minIntervalMs ?? 200;
  const maxRetries = g.maxRetries ?? 3;
  const retryBaseMs = g.retryBaseMs ?? 250;

  const url = new URL(base);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", g.apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const safeUrl = redactKey(url.toString());

  let attempt = 0;
  for (;;) {
    await throttle(minIntervalMs);
    let payload: Json;
    try {
      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": g.userAgent ?? DEFAULT_UA,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new LastfmError(
          `${method} failed: HTTP ${response.status} for ${safeUrl}`,
          undefined,
          response.status >= 500 ? "transient" : "permanent",
        );
      }
      const text = await response.text();
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LastfmError(
          `${method} returned a non-JSON body for ${safeUrl}`,
          undefined,
          "transport",
        );
      }
    } catch (err) {
      if (err instanceof LastfmError && err.kind === "transient") {
        if (attempt < maxRetries) {
          attempt++;
          await sleep(retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
      }
      if (err instanceof LastfmError) throw err;
      // Network failure or AbortSignal timeout.
      throw new LastfmError(
        `${method} request failed for ${safeUrl}: ${
          redactKey(String((err as Error)?.message ?? err))
        }`,
        undefined,
        "transport",
      );
    }

    // Last.fm reports failures as HTTP 200 with an error body.
    const code = toNumber(payload?.error);
    if (code !== undefined) {
      const kind = classifyError(code);
      const message = String(payload?.message ?? "unknown error");
      if (kind === "transient" && attempt < maxRetries) {
        attempt++;
        context.logger.warning?.(
          `Last.fm ${method}: transient error ${code} (${message}), retry ${attempt}/${maxRetries}`,
        );
        await sleep(retryBaseMs * 2 ** (attempt - 1));
        continue;
      }
      throw new LastfmError(
        `Last.fm ${method} failed with error ${code}: ${message}`,
        code,
        kind,
      );
    }

    return payload;
  }
}

// --- resource schemas ------------------------------------------------------

const ImageSchema = z.array(z.object({
  size: z.string().optional(),
  url: z.string().optional(),
})).optional();

const ProfileSchema = z.object({
  user: z.string(),
  realname: z.string().optional(),
  country: z.string().optional(),
  url: z.string().optional(),
  registeredAt: z.string().optional(),
  playcount: z.number().optional(),
  artistCount: z.number().optional(),
  albumCount: z.number().optional(),
  trackCount: z.number().optional(),
  images: ImageSchema,
  fetchedAt: z.string(),
});

const ChartEntrySchema = z.object({
  rank: z.number().optional(),
  name: z.string(),
  artist: z.string().optional(),
  playcount: z.number().optional(),
  mbid: z.string().optional(),
  url: z.string().optional(),
});

const ChartSchema = z.object({
  kind: z.enum(["artists", "albums", "tracks"]),
  period: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  user: z.string(),
  page: z.number().optional(),
  totalPages: z.number().optional(),
  entries: z.array(ChartEntrySchema),
  fetchedAt: z.string(),
});

const LovedSchema = z.object({
  user: z.string(),
  total: z.number().optional(),
  tracks: z.array(z.object({
    name: z.string(),
    artist: z.string().optional(),
    mbid: z.string().optional(),
    url: z.string().optional(),
    lovedAt: z.number().optional(),
  })),
  fetchedAt: z.string(),
});

const WeeklyListSchema = z.object({
  user: z.string(),
  ranges: z.array(z.object({ from: z.number(), to: z.number() })),
  fetchedAt: z.string(),
});

const EntitySchema = z.object({
  kind: z.enum(["artist", "album", "track"]),
  name: z.string(),
  artist: z.string().optional(),
  mbid: z.string().optional(),
  url: z.string().optional(),
  listeners: z.number().optional(),
  playcount: z.number().optional(),
  userPlaycount: z.number().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  fetchedAt: z.string(),
});

const ScrobbleSchema = z.object({
  uts: z.number(),
  artist: z.string(),
  album: z.string().optional(),
  track: z.string(),
  artistMbid: z.string().optional(),
  albumMbid: z.string().optional(),
  trackMbid: z.string().optional(),
});

/**
 * A year chunk carries NO wall-clock field. Its content is a pure function of
 * the scrobbles it holds, so re-syncing an unchanged year produces byte-
 * identical bytes. That is what keeps a closed year genuinely immutable —
 * an `updatedAt` here would mint a fresh data version on every sync, churn
 * through the garbageCollection budget, and make the immutability claim
 * cosmetic. Write time is already recorded by the data layer per version, and
 * mutable sync state lives in the `history` resource.
 */
const ScrobblesChunkSchema = z.object({
  user: z.string(),
  year: z.string(),
  count: z.number(),
  firstUts: z.number().optional(),
  lastUts: z.number().optional(),
  scrobbles: z.array(ScrobbleSchema),
});

const HistorySchema = z.object({
  user: z.string(),
  lastUts: z.number(),
  /**
   * True when the run stopped before exhausting the range (the maxPages cap).
   * The cursor is deliberately held in that case, so a caller seeing this can
   * simply run again to make further progress.
   */
  truncated: z.boolean().default(false),
  syncedThrough: z.number(),
  years: z.array(z.object({ year: z.string(), count: z.number() })),
  pagesWalked: z.number(),
  added: z.number(),
  nowPlaying: z.object({
    artist: z.string(),
    album: z.string().optional(),
    track: z.string(),
  }).optional(),
  updatedAt: z.string(),
});

// --- helpers shared by the methods -----------------------------------------

const nowIso = () => new Date().toISOString();

function targetUser(context: Ctx, override?: string): string {
  return override ?? context.globalArgs.user;
}

function images(v: unknown) {
  const arr = asArray<Json>(v);
  if (arr.length === 0) return undefined;
  return arr.map((i) => ({ size: i?.size, url: i?.["#text"] }));
}

function chartEntries(raw: unknown, artistField: boolean) {
  return asArray<Json>(raw).map((e) => ({
    rank: toNumber(e?.["@attr"]?.rank),
    name: String(e?.name ?? ""),
    artist: artistField
      ? (e?.artist?.name ?? e?.artist?.["#text"] ?? undefined)
      : undefined,
    playcount: toNumber(e?.playcount),
    mbid: normalizeMbid(e?.mbid),
    url: e?.url,
  }));
}

const periodArg = z.enum(PERIODS).optional().describe(
  "Chart window (default overall). The API silently coerces anything outside " +
    "this set to overall, so it is rejected here instead.",
);
const limitArg = z.number().int().min(1).max(200).optional().describe(
  "Results per page, 1-200 (the API clamps above 200 rather than erroring)",
);
const pageArg = z.number().int().min(1).optional().describe("Page number");
const userArg = usernameSchema.optional().describe(
  "Override the model's user for this call",
);

/** Build the arguments schema for a top-* chart method. */
const chartArgs = z.object({
  period: periodArg,
  limit: limitArg,
  page: pageArg,
  user: userArg,
});

// --- model -----------------------------------------------------------------

/**
 * @magistr/lastfm — read-only Last.fm client.
 *
 * Lookups: `profile`, `loved-tracks`, `artist-info`, `album-info`,
 * `track-info`. Charts: `top-artists`, `top-albums`, `top-tracks` over the six
 * standard periods, plus `weekly-chart-list` and the three weekly range
 * charts. History: `sync-history`, an idempotent fan-out that pages
 * user.getRecentTracks into one `scrobbles.<year>` resource per calendar year.
 *
 * Listening statistics are NOT a method here — they are the
 * `@magistr/lastfm-stats` model-scope report, which reads the synced chunks.
 */
export const model = {
  type: "@magistr/lastfm",
  version: "2026.07.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    profile: {
      description: "Last.fm user profile and lifetime totals",
      schema: ProfileSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    chart: {
      description: "Top artists/albums/tracks for a period or weekly range",
      schema: ChartSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    loved: {
      description: "Tracks the user has loved",
      schema: LovedSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    weekly: {
      description: "Available weekly chart ranges",
      schema: WeeklyListSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    entity: {
      description: "Artist, album, or track detail",
      schema: EntitySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    scrobbles: {
      description: "One calendar year of scrobbles (partition of the history)",
      schema: ScrobblesChunkSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    history: {
      description: "Sync cursor and per-year counts for the scrobble history",
      schema: HistorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    profile: {
      description:
        "Fetch the user's profile: playcount, artist/album/track counts, " +
        "registration date, country.",
      arguments: z.object({ user: userArg }),
      execute: async (args: { user?: string }, context: Ctx) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "user.getInfo", { user });
        const u = data?.user ?? {};
        const payload = ProfileSchema.parse({
          user: String(u.name ?? user),
          realname: u.realname || undefined,
          country: u.country || undefined,
          url: u.url || undefined,
          registeredAt: u.registered?.unixtime
            ? new Date(Number(u.registered.unixtime) * 1000).toISOString()
            : undefined,
          playcount: toNumber(u.playcount),
          artistCount: toNumber(u.artist_count),
          albumCount: toNumber(u.album_count),
          trackCount: toNumber(u.track_count),
          images: images(u.image),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "profile",
          `profile.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "loved-tracks": {
      description: "List the tracks the user has marked as loved.",
      arguments: z.object({ limit: limitArg, page: pageArg, user: userArg }),
      execute: async (
        args: { limit?: number; page?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "user.getLovedTracks", {
          user,
          limit: args.limit,
          page: args.page,
        });
        const root = data?.lovedtracks ?? {};
        const payload = LovedSchema.parse({
          user,
          total: toNumber(root["@attr"]?.total),
          tracks: asArray<Json>(root.track).map((t) => ({
            name: String(t?.name ?? ""),
            artist: t?.artist?.name ?? undefined,
            mbid: normalizeMbid(t?.mbid),
            url: t?.url,
            lovedAt: toNumber(t?.date?.uts),
          })),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "loved",
          `loved.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "artist-info": {
      description:
        "Fetch artist detail — listeners, global playcount, the user's own " +
        "playcount for that artist, tags, and the wiki summary.",
      arguments: z.object({
        artist: z.string().min(1).describe("Artist name"),
        user: userArg,
      }),
      execute: async (
        args: { artist: string; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "artist.getInfo", {
          artist: args.artist,
          username: user,
        });
        const a = data?.artist ?? {};
        const payload = EntitySchema.parse({
          kind: "artist",
          name: String(a.name ?? args.artist),
          mbid: normalizeMbid(a.mbid),
          url: a.url,
          listeners: toNumber(a.stats?.listeners),
          playcount: toNumber(a.stats?.playcount),
          userPlaycount: toNumber(a.stats?.userplaycount),
          tags: asArray<Json>(a.tags?.tag).map((t) => String(t?.name ?? "")),
          summary: a.bio?.summary || undefined,
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "entity",
          `entity.artist.${args.artist}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "album-info": {
      description: "Fetch album detail including the user's own playcount.",
      arguments: z.object({
        artist: z.string().min(1),
        album: z.string().min(1),
        user: userArg,
      }),
      execute: async (
        args: { artist: string; album: string; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "album.getInfo", {
          artist: args.artist,
          album: args.album,
          username: user,
        });
        const a = data?.album ?? {};
        const payload = EntitySchema.parse({
          kind: "album",
          name: String(a.name ?? args.album),
          artist: a.artist ?? args.artist,
          mbid: normalizeMbid(a.mbid),
          url: a.url,
          listeners: toNumber(a.listeners),
          playcount: toNumber(a.playcount),
          userPlaycount: toNumber(a.userplaycount),
          tags: asArray<Json>(a.tags?.tag).map((t) => String(t?.name ?? "")),
          summary: a.wiki?.summary || undefined,
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "entity",
          `entity.album.${args.artist}.${args.album}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "track-info": {
      description: "Fetch track detail including the user's own playcount.",
      arguments: z.object({
        artist: z.string().min(1),
        track: z.string().min(1),
        user: userArg,
      }),
      execute: async (
        args: { artist: string; track: string; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "track.getInfo", {
          artist: args.artist,
          track: args.track,
          username: user,
        });
        const t = data?.track ?? {};
        const payload = EntitySchema.parse({
          kind: "track",
          name: String(t.name ?? args.track),
          artist: t.artist?.name ?? args.artist,
          mbid: normalizeMbid(t.mbid),
          url: t.url,
          listeners: toNumber(t.listeners),
          playcount: toNumber(t.playcount),
          userPlaycount: toNumber(t.userplaycount),
          tags: asArray<Json>(t.toptags?.tag).map((x) => String(x?.name ?? "")),
          summary: t.wiki?.summary || undefined,
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "entity",
          `entity.track.${args.artist}.${args.track}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "top-artists": {
      description: "Top artists over one of the six standard periods " +
        "(overall|7day|1month|3month|6month|12month).",
      arguments: chartArgs,
      execute: async (
        args: { period?: string; limit?: number; page?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const period = args.period ?? "overall";
        const data = await callApi(context, "user.getTopArtists", {
          user,
          period,
          limit: args.limit,
          page: args.page,
        });
        const root = data?.topartists ?? {};
        const payload = ChartSchema.parse({
          kind: "artists",
          period,
          user,
          page: toNumber(root["@attr"]?.page),
          totalPages: toNumber(root["@attr"]?.totalPages),
          entries: chartEntries(root.artist, false),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "chart",
          `chart.artists.${period}.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "top-albums": {
      description: "Top albums over one of the six standard periods.",
      arguments: chartArgs,
      execute: async (
        args: { period?: string; limit?: number; page?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const period = args.period ?? "overall";
        const data = await callApi(context, "user.getTopAlbums", {
          user,
          period,
          limit: args.limit,
          page: args.page,
        });
        const root = data?.topalbums ?? {};
        const payload = ChartSchema.parse({
          kind: "albums",
          period,
          user,
          page: toNumber(root["@attr"]?.page),
          totalPages: toNumber(root["@attr"]?.totalPages),
          entries: chartEntries(root.album, true),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "chart",
          `chart.albums.${period}.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "top-tracks": {
      description: "Top tracks over one of the six standard periods.",
      arguments: chartArgs,
      execute: async (
        args: { period?: string; limit?: number; page?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const period = args.period ?? "overall";
        const data = await callApi(context, "user.getTopTracks", {
          user,
          period,
          limit: args.limit,
          page: args.page,
        });
        const root = data?.toptracks ?? {};
        const payload = ChartSchema.parse({
          kind: "tracks",
          period,
          user,
          page: toNumber(root["@attr"]?.page),
          totalPages: toNumber(root["@attr"]?.totalPages),
          entries: chartEntries(root.track, true),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "chart",
          `chart.tracks.${period}.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "weekly-chart-list": {
      description:
        "List the from/to timestamp ranges for which weekly charts exist.",
      arguments: z.object({ user: userArg }),
      execute: async (args: { user?: string }, context: Ctx) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "user.getWeeklyChartList", {
          user,
        });
        const payload = WeeklyListSchema.parse({
          user,
          ranges: asArray<Json>(data?.weeklychartlist?.chart)
            .map((c) => ({ from: toNumber(c?.from), to: toNumber(c?.to) }))
            .filter((r): r is { from: number; to: number } =>
              r.from !== undefined && r.to !== undefined
            ),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "weekly",
          `weekly.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "weekly-artist-chart": {
      description:
        "Weekly artist chart for a from/to range (see weekly-chart-list).",
      arguments: z.object({
        from: z.number().int().min(0).optional(),
        to: z.number().int().min(0).optional(),
        user: userArg,
      }),
      execute: async (
        args: { from?: number; to?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "user.getWeeklyArtistChart", {
          user,
          from: args.from,
          to: args.to,
        });
        const root = data?.weeklyartistchart ?? {};
        const payload = ChartSchema.parse({
          kind: "artists",
          from: args.from,
          to: args.to,
          user,
          entries: chartEntries(root.artist, false),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "chart",
          `chart.weekly.artists.${args.from ?? "latest"}.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "weekly-album-chart": {
      description: "Weekly album chart for a from/to range.",
      arguments: z.object({
        from: z.number().int().min(0).optional(),
        to: z.number().int().min(0).optional(),
        user: userArg,
      }),
      execute: async (
        args: { from?: number; to?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "user.getWeeklyAlbumChart", {
          user,
          from: args.from,
          to: args.to,
        });
        const root = data?.weeklyalbumchart ?? {};
        const payload = ChartSchema.parse({
          kind: "albums",
          from: args.from,
          to: args.to,
          user,
          entries: chartEntries(root.album, true),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "chart",
          `chart.weekly.albums.${args.from ?? "latest"}.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "weekly-track-chart": {
      description: "Weekly track chart for a from/to range.",
      arguments: z.object({
        from: z.number().int().min(0).optional(),
        to: z.number().int().min(0).optional(),
        user: userArg,
      }),
      execute: async (
        args: { from?: number; to?: number; user?: string },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const data = await callApi(context, "user.getWeeklyTrackChart", {
          user,
          from: args.from,
          to: args.to,
        });
        const root = data?.weeklytrackchart ?? {};
        const payload = ChartSchema.parse({
          kind: "tracks",
          from: args.from,
          to: args.to,
          user,
          entries: chartEntries(root.track, true),
          fetchedAt: nowIso(),
        });
        const handle = await context.writeResource(
          "chart",
          `chart.weekly.tracks.${args.from ?? "latest"}.${user}`,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    "sync-history": {
      description:
        "Page the full scrobble history into one `scrobbles.<year>` resource " +
        "per calendar year. Idempotent: re-running adds only what is new. " +
        "Resumes from the stored cursor unless `from` is given; pass " +
        "`resyncYear` to rebuild one year from scratch (the only way to shed " +
        "scrobbles deleted upstream).",
      arguments: z
        .object({
          from: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Start UNIX timestamp; defaults to the stored cursor"),
          to: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("End UNIX timestamp; defaults to now"),
          resyncYear: z
            .string()
            .regex(/^\d{4}$/)
            .optional()
            .describe("Rebuild this calendar year from scratch"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Page size, 1-200 (default 200)"),
          maxPages: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Safety cap on pages walked in one run"),
          user: userArg,
        })
        .refine(
          (a) => a.to === undefined || a.to <= Math.floor(Date.now() / 1000),
          { message: "`to` must not be in the future", path: ["to"] },
        )
        .refine(
          (a) => a.from === undefined || a.to === undefined || a.from <= a.to,
          {
            message: "`from` must not be after `to`",
            path: ["from"],
          },
        ),
      execute: async (
        args: {
          from?: number;
          to?: number;
          resyncYear?: string;
          limit?: number;
          maxPages?: number;
          user?: string;
        },
        context: Ctx,
      ) => {
        const user = targetUser(context, args.user);
        const limit = args.limit ?? 200;

        // Pin the upper bound for the whole walk. getRecentTracks pages
        // newest-first, so without a fixed `to` a scrobble arriving mid-walk
        // shifts every page boundary and silently drops a track.
        const to = args.to ?? Math.floor(Date.now() / 1000);

        // Resume from the stored cursor when the driver offers readResource.
        // Its absence is not fatal — a full walk is still correct, just
        // slower, because the dedup predicate makes re-fetching a no-op.
        let cursor = 0;
        if (args.from !== undefined) {
          cursor = args.from;
        } else if (args.resyncYear) {
          cursor = Math.floor(Date.UTC(Number(args.resyncYear), 0, 1) / 1000);
        } else if (context.readResource) {
          const prior = await context
            .readResource(`history.${user}`)
            .catch(() => null);
          const priorUts = toNumber(prior?.lastUts);
          if (priorUts !== undefined) cursor = priorUts;
        }

        const collected: Scrobble[] = [];
        let nowPlaying: NowPlaying | undefined;
        let page = 1;
        let pagesWalked = 0;
        let totalPages = 1;
        // Set when the walk stops before exhausting the range. Because
        // getRecentTracks pages newest-first, a truncated walk has a hole at
        // the OLD end, so the cursor must not move past it.
        let truncated = false;

        for (;;) {
          const data = await callApi(context, "user.getRecentTracks", {
            user,
            limit,
            page,
            from: cursor > 0 ? cursor + 1 : undefined,
            to,
          });
          const parsed = parseRecentTracksPage(data);
          pagesWalked++;
          if (parsed.nowPlaying) nowPlaying = parsed.nowPlaying;
          collected.push(...parsed.scrobbles);

          // totalPages can shrink mid-walk (page drift). Trust the smallest
          // value seen rather than the first, and stop when we reach it.
          totalPages = page === 1
            ? parsed.totalPages
            : Math.min(totalPages, parsed.totalPages);

          context.logger.info(
            `sync-history: page ${page}/${totalPages || 1}, ` +
              `${parsed.scrobbles.length} scrobbles (${collected.length} so far)`,
          );

          if (page >= totalPages) break;
          if (args.maxPages !== undefined && pagesWalked >= args.maxPages) {
            truncated = true;
            context.logger.warning?.(
              `sync-history: stopping at the maxPages cap (${args.maxPages}) ` +
                `with ${
                  totalPages - page
                } page(s) unread; the cursor is held ` +
                `so the next run re-walks this range instead of skipping it`,
            );
            break;
          }
          page++;
        }

        const deduped = dedupeScrobbles(collected);
        const parts = partitionByYear(deduped);
        const handles: Array<{ name: string }> = [];
        const years: Array<{ year: string; count: number }> = [];

        // Write chunks BEFORE the cursor. If the run dies between the two, the
        // next run re-fetches a range already on disk and dedup absorbs it —
        // whereas advancing the cursor first would skip those scrobbles
        // permanently.
        for (const [year, rows] of [...parts.entries()].sort()) {
          const sorted = [...rows].sort((a, b) => a.uts - b.uts);
          const payload = ScrobblesChunkSchema.parse({
            user,
            year,
            count: sorted.length,
            firstUts: sorted[0]?.uts,
            lastUts: sorted[sorted.length - 1]?.uts,
            scrobbles: sorted,
          });
          handles.push(
            await context.writeResource("scrobbles", chunkName(year), payload),
          );
          years.push({ year, count: sorted.length });
        }

        const history = HistorySchema.parse({
          user,
          // Only advance the cursor when the whole range was actually read.
          // getRecentTracks pages newest-first, so a truncated walk holds only
          // the newest pages and leaves a gap below them. Advancing to the
          // newest uts would put that gap permanently behind the cursor and
          // those scrobbles would never be fetched again. Holding the cursor
          // costs a repeated fetch of pages dedup already absorbs.
          lastUts: truncated ? cursor : advanceCursor(cursor, deduped),
          truncated,
          syncedThrough: to,
          years,
          pagesWalked,
          added: deduped.length,
          nowPlaying,
          updatedAt: nowIso(),
        });
        handles.push(
          await context.writeResource("history", `history.${user}`, history),
        );

        context.logger.info(
          `sync-history: ${deduped.length} scrobbles across ${years.length} ` +
            `year(s) in ${pagesWalked} page(s)`,
        );

        return { dataHandles: handles };
      },
    },
  },
};
