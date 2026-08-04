import { z } from "npm:zod@4";
import { DOMParser } from "npm:linkedom@0.16.11";

const GlobalArgsSchema = z.object({
  userAgent: z
    .string()
    .describe(
      "User-Agent string (e.g., MyApp/1.0.0 (contact@example.com)) — required by MusicBrainz",
    ),
  maxPages: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Max release-group pages (100 per page) to walk in find-missing/seed-all-missing's pagination before stopping, even if every page was full. Defaults to 50.",
    ),
});

const BASE = "https://musicbrainz.org/ws/2";
const FETCH_TIMEOUT_MS = 30000;

// --- MusicBrainz rate limiting (enforced once, at the mbFetch boundary) ---
//
// MusicBrainz permits 1 request/second for the API as a whole, not per
// caller or per method. `mbFetch` is the ONLY function in this file that
// talks to musicbrainz.org (Bandcamp scraping goes through the separate
// `fetchPage` helper below and is not subject to this limit), so it is the
// single correct place to enforce spacing: every method that goes through
// `mbFetch` — including sync-artist-discographies' pagination loop below —
// gets it for free, and no caller can bypass it by forgetting to
// re-implement it locally (see `rateLimitDelayMs` further down for the pure
// delay math this reuses).
let lastRequest: number | null = null;

// Two `await mbFetch(...)` calls can be in flight concurrently (e.g. two
// methods invoked close together, or sync-artist-discographies firing its
// next page request while an earlier one is still settling). If each
// independently read `lastRequest`, computed its own delay, and updated the
// timestamp, both could observe the same stale value and fire together.
// `rateLimitQueue` is a module-level promise chain that serialises the
// "compute delay, wait it out, claim the slot" step: each call appends its
// own reservation onto the tail with `.then()` and reassigns the module
// variable *synchronously* (no `await` before the reassignment), so two
// concurrent callers can never race on read-then-write of the tail pointer
// — their reservations always run strictly one after another, each seeing
// the previous one's committed `lastRequest`. The actual `fetch()` call
// happens after a reservation resolves, outside the chain, so waiting for a
// slot never blocks on a prior call's network latency — only on its spacing
// delay.
let rateLimitQueue: Promise<void> = Promise.resolve();

function reserveRateLimitSlot(minIntervalMs: number): Promise<void> {
  const reservation = rateLimitQueue.then(async () => {
    const delay = rateLimitDelayMs(lastRequest, Date.now(), minIntervalMs);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastRequest = Date.now();
  });
  // Chain the next reservation after this one regardless of outcome, so a
  // rejected reservation can never wedge the queue for later callers.
  rateLimitQueue = reservation.catch(() => {});
  return reservation;
}

/** Runs one `fetch()` guarded by a per-call `AbortController` timeout —
 * factored out so mbFetch's initial request and its single 503 retry (see
 * below) share the exact same timeout behavior instead of duplicating it. */
async function fetchWithTimeout(
  url: URL,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Exported (not just module-private) so the test suite can exercise the
// real spacing/concurrency/backoff behaviour directly, the same way the
// pure helpers further down are exported rather than mirrored in tests.
export async function mbFetch(
  userAgent: string,
  path: string,
  params: Record<string, string> = {},
  minIntervalMs = 1100,
) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("fmt", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const headers = { "User-Agent": userAgent, Accept: "application/json" };

  await reserveRateLimitSlot(minIntervalMs);
  let response = await fetchWithTimeout(url, headers);

  if (response.status === 503) {
    // MusicBrainz asking us to back off — drain the body, wait out the
    // computed backoff, reserve a fresh rate-limit slot, and retry exactly
    // once rather than hammering the endpoint.
    const backoffMs = retryAfterBackoffMs(
      response.headers.get("Retry-After"),
      minIntervalMs,
    );
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    await reserveRateLimitSlot(minIntervalMs);
    response = await fetchWithTimeout(url, headers);
  }

  if (!response.ok) {
    const body = await response.text();
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(
      `MusicBrainz ${path} failed: ${response.status} - ${body.slice(0, 300)}${
        retryAfter ? ` (Retry-After: ${retryAfter})` : ""
      }`,
    );
  }
  return response.json();
}

// --- bandcamp scraping helpers ---

/**
 * SSRF guard (musicbrainz-ssrf-and-latent-bugs): require an https URL whose
 * host is exactly `bandcamp.com` or a `*.bandcamp.com` subdomain. Applied by
 * fetchPage before the initial request AND before following every redirect
 * hop, so neither a caller-supplied bandcampUrl nor a scraped second-order
 * albumUrl can reach an internal/loopback/metadata target — directly or via
 * a bandcamp-hosted redirect to one.
 */
function assertBandcampUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Bandcamp URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to fetch non-Bandcamp host: ${raw}`);
  }
  if (
    parsed.hostname !== "bandcamp.com" &&
    !parsed.hostname.endsWith(".bandcamp.com")
  ) {
    throw new Error(`Refusing to fetch non-Bandcamp host: ${raw}`);
  }
  return parsed;
}

const MAX_BANDCAMP_REDIRECTS = 5;

async function fetchPage(url: string) {
  let current = assertBandcampUrl(url);
  let redirects = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SwampBot/1.0)",
          Accept: "text/html",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      redirects++;
      if (redirects > MAX_BANDCAMP_REDIRECTS) {
        throw new Error(`Too many redirects fetching ${url}`);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `Failed to fetch ${current.toString()}: ${response.status} (redirect with no Location header)`,
        );
      }
      current = assertBandcampUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${current.toString()}: ${response.status}`,
      );
    }
    return response.text();
  }
}

function parseBandcampAlbumPage(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const ldScript = doc.querySelector('script[type="application/ld+json"]');
  // deno-lint-ignore no-explicit-any -- dynamic schema.org JSON-LD payload
  let ld: any = {};
  if (ldScript?.textContent) {
    try {
      ld = JSON.parse(ldScript.textContent);
    } catch { /* ignore */ }
  }

  const title = ld.name ||
    doc.querySelector(".trackTitle, #name-section h2")?.textContent?.trim() ||
    "";
  const artist = ld.byArtist?.name ||
    doc.querySelector("#band-name-location .title, span[itemprop='byArtist'] a")
      ?.textContent?.trim() ||
    "";
  const releaseDate = ld.datePublished || "";

  const tagEls = doc.querySelectorAll(".tralbumData.tralbum-tags a.tag");
  const tags = Array.from(tagEls).map(
    // deno-lint-ignore no-explicit-any -- linkedom DOM node, no global Element type
    (t: any) => t.textContent?.trim(),
  ).filter(
    Boolean,
  );

  // deno-lint-ignore no-explicit-any -- track entries assembled from dynamic JSON
  const tracks: any[] = [];
  const trackItems = ld.track?.itemListElement || [];
  for (const t of trackItems) {
    const item = t.item || t;
    tracks.push({
      position: t.position || 0,
      title: item.name || "",
      duration: item.duration || "",
    });
  }

  // fallback: parse tralbum data
  if (tracks.length === 0) {
    const scripts = doc.querySelectorAll("script");
    for (const s of scripts) {
      const text = s.textContent || "";
      const match = text.match(/var\s+TralbumData\s*=\s*(\{[\s\S]*?\});?\s*$/m);
      if (match) {
        // Try a direct parse first — real (valid) TralbumData is valid JSON
        // as-is, embedded https:// URLs included. Only on failure do we fall
        // back to a `://`-protected comment-strip (a negative lookbehind so
        // we never cut through the "//" inside "http(s)://") plus a
        // trailing-comma cleanup, matching the ORIGINAL cleanup's intent for
        // genuine trailing "// comment" text without corrupting embedded
        // URLs.
        // deno-lint-ignore no-explicit-any -- dynamic TralbumData JSON blob
        let tralbum: any;
        try {
          tralbum = JSON.parse(match[1]);
        } catch {
          try {
            const cleaned = match[1]
              .replace(/(?<!:)\/\/.*/g, "")
              .replace(/,\s*}/g, "}")
              .replace(/,\s*]/g, "]");
            tralbum = JSON.parse(cleaned);
          } catch { /* ignore */ }
        }
        if (tralbum) {
          for (const t of tralbum.trackinfo || []) {
            tracks.push({
              position: t.track_num || 0,
              title: t.title || "",
              duration: t.duration ? formatDuration(t.duration) : "",
              durationMs: t.duration
                ? Math.round(t.duration * 1000)
                : undefined,
            });
          }
        }
      }
    }
  } else {
    // parse ISO 8601 durations to ms
    for (const t of tracks) {
      if (t.duration && t.duration.startsWith("P")) {
        const m = t.duration.match(
          /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/,
        );
        if (m) {
          const totalSeconds = (parseInt(m[1] || "0") * 3600) +
            (parseInt(m[2] || "0") * 60) + parseFloat(m[3] || "0");
          t.durationMs = totalSeconds * 1000;
          t.duration = formatDuration(totalSeconds);
        }
      }
    }
  }

  return { title, artist, releaseDate, tags, tracks };
}

function parseBandcampArtistPage(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const name = doc.querySelector(
    "#band-name-location .title, p#band-name-location span.title",
  )?.textContent?.trim() || "";

  const ldScript = doc.querySelector('script[type="application/ld+json"]');
  // deno-lint-ignore no-explicit-any -- dynamic schema.org JSON-LD payload
  let ld: any = {};
  if (ldScript?.textContent) {
    try {
      ld = JSON.parse(ldScript.textContent);
    } catch { /* ignore */ }
  }

  // deno-lint-ignore no-explicit-any -- album entries from dynamic JSON-LD
  const discography = (ld.album || ld.discography || []).map((a: any) => ({
    title: a.name || "",
    url: a["@id"] || "",
    releaseDate: a.datePublished || "",
    numTracks: a.numTracks || a.track?.numberOfItems || 0,
  }));

  if (discography.length === 0) {
    const items = doc.querySelectorAll(
      "#music-grid .music-grid-item, .music-grid li",
    );
    for (const item of items) {
      const link = item.querySelector("a");
      const titleEl = item.querySelector(".title, p.title");
      discography.push({
        title: titleEl?.textContent?.trim() || "",
        url: link?.getAttribute("href") || "",
        releaseDate: "",
        numTracks: 0,
      });
    }
  }

  return { name: name || ld.name || "", discography };
}

function buildSeedUrl(
  // deno-lint-ignore no-explicit-any -- parsed Bandcamp album with dynamic fields
  album: any,
  artistMbid: string | undefined,
  bandcampUrl: string,
) {
  const params = new URLSearchParams();
  params.set("name", album.title);
  params.set("type", "album");
  params.set("status", "official");

  // artist credit
  if (artistMbid) {
    params.set("artist_credit.names.0.mbid", artistMbid);
  }
  params.set("artist_credit.names.0.artist.name", album.artist);

  // release date
  if (album.releaseDate) {
    const parts = album.releaseDate.split(/[-/]/);
    if (parts[0]) params.set("events.0.date.year", parts[0]);
    if (parts[1]) params.set("events.0.date.month", parts[1]);
    if (parts[2]) params.set("events.0.date.day", parts[2]);
  }

  // medium: Digital Media
  params.set("mediums.0.format", "Digital Media");

  // tracks
  for (let i = 0; i < album.tracks.length; i++) {
    const t = album.tracks[i];
    params.set(`mediums.0.track.${i}.name`, t.title);
    params.set(`mediums.0.track.${i}.number`, String(t.position || i + 1));
    if (t.durationMs) {
      params.set(
        `mediums.0.track.${i}.length`,
        String(Math.round(t.durationMs)),
      );
    }
  }

  // bandcamp URL as source
  params.set("urls.0.url", bandcampUrl);
  params.set("urls.0.link_type", "85"); // 85 = free streaming

  params.set("edit_note", `Seeded from Bandcamp: ${bandcampUrl}`);

  return `https://musicbrainz.org/release/add?${params.toString()}`;
}

function normalizeTitle(s: string) {
  return s
    .normalize("NFKD")
    // strip combining diacritical marks (U+0300-U+036F) left behind by NFKD
    // decomposition, e.g. "é" -> "e" + U+0301 -> "e" — written as an escaped
    // range (never a literal combining character in source) so the file
    // stays greppable and editors don't misrender it.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Format a track duration (in seconds) as `H:MM:SS` when it runs an hour or
 * longer, else `M:SS` — used by both the Bandcamp JSON-LD (ISO-8601) and
 * TralbumData duration parsers so a track past the one-hour mark doesn't
 * silently lose its hours component in the display string (the underlying
 * `durationMs` value was always correct; only this display string dropped
 * hours). */
export function formatDuration(totalSeconds: number): string {
  const total = Math.floor(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const secondsStr = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secondsStr}`;
  }
  return `${minutes}:${secondsStr}`;
}

// --- sync-artist-discographies helpers (pure, no I/O) ---
//
// Back `sync-artist-discographies` below: a cursored, rate-limited,
// resumable fan-out that caches release-groups per artist by routing
// through the same fetch (`mbFetch`) and `browse` resource path
// (`rg-by-artist-<mbid>`) as `browse-release-groups` above. These are pure
// functions — no fetch, no clock reads — and are exported so the test suite
// exercises the real implementation instead of a mirrored copy.

/**
 * Shape of a cached `browse` resource entry for `rg-by-artist-<mbid>` (see
 * `browse-release-groups` above).
 */
export interface DiscographyCacheEntry {
  count: number;
  results: unknown[];
  timestamp: string;
}

export type DiscographyCacheStatus = "never-fetched" | "empty" | "populated";

/**
 * Classifies a cached discography entry as never fetched (no entry written
 * yet), legitimately empty (fetched, `count: 0`, `results: []`), or
 * populated. Conflating "empty" with "never fetched" causes infinite
 * re-fetch of artists that genuinely have no release groups.
 */
export function classifyDiscographyCache(
  entry: DiscographyCacheEntry | null | undefined,
): DiscographyCacheStatus {
  if (entry === null || entry === undefined) return "never-fetched";
  return entry.count === 0 ? "empty" : "populated";
}

/**
 * Pure TTL staleness predicate for an existing cache entry's timestamp.
 * `now` and `ttlMs` are both parameters — this never reads the clock
 * internally — so it is deterministic and testable without faking
 * `Date.now()`.
 */
export function isCacheStale(
  timestamp: string,
  now: number,
  ttlMs: number,
): boolean {
  const cachedAt = Date.parse(timestamp);
  return now - cachedAt > ttlMs;
}

/**
 * Progress marker for a resumable `sync-artist-discographies` run: the
 * offset of the next artist MBID to process in the input list.
 */
export interface SyncCursor {
  offset: number;
}

/** Outcome of one processed batch — how many artist MBIDs it covered. */
export interface SyncBatchOutcome {
  processedCount: number;
}

/**
 * Advances a resumable cursor by a batch's outcome. Resuming from the
 * returned cursor (instead of restarting at offset 0) must cover the
 * remaining input exactly once — no gap, no overlap.
 */
export function advanceSyncCursor(
  cursor: SyncCursor,
  outcome: SyncBatchOutcome,
): SyncCursor {
  return { offset: cursor.offset + outcome.processedCount };
}

/**
 * Pure rate-limit spacing calculator backing `mbFetch`'s queue above.
 * Returns the number of milliseconds to wait before the next request; 0 if
 * the minimum interval has already elapsed. `lastRequestAt` is `null` when
 * no request has been made yet — always 0 delay in that case.
 */
export function rateLimitDelayMs(
  lastRequestAt: number | null,
  now: number,
  minIntervalMs = 1000,
): number {
  if (lastRequestAt === null) return 0;
  const remaining = minIntervalMs - (now - lastRequestAt);
  return remaining > 0 ? remaining : 0;
}

/**
 * Pure backoff calculator for a MusicBrainz `503` response: honour
 * `Retry-After` (seconds, per HTTP semantics) when it parses to a finite
 * positive number; otherwise fall back to one more spacing interval so a
 * 503 without the header still backs off instead of retrying immediately.
 * No clock reads, no I/O — `mbFetch` (the impure boundary) is the only
 * caller and supplies the actual header value and interval.
 */
export function retryAfterBackoffMs(
  retryAfterHeader: string | null,
  minIntervalMs: number,
): number {
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : minIntervalMs;
}

// --- sync-artist-discographies method support ---

/** Instance name the resumable cursor state is written under. */
const DISCOGRAPHY_SYNC_CURSOR_INSTANCE = "discography-sync-cursor";

/**
 * Default page ceiling (100 release groups per page) for one artist's
 * discography per `sync-artist-discographies` run. At mbFetch's ~1100ms
 * default spacing this caps a single artist's pagination at ~22s and 2,000
 * release groups — generous for a real discography (including large
 * classical catalogues) while still bounding how much of one batched run a
 * single artist can consume.
 */
const DEFAULT_DISCOGRAPHY_MAX_PAGES = 20;

// --- resource schemas ---

const ArtistSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    "sort-name": z.string().optional(),
    type: z.string().optional(),
    country: z.string().optional(),
    disambiguation: z.string().optional(),
  })
  .passthrough();

const ReleaseGroupSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    "primary-type": z.string().optional(),
    "first-release-date": z.string().optional(),
  })
  .passthrough();

const ReleaseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string().optional(),
    date: z.string().optional(),
    country: z.string().optional(),
    barcode: z.string().optional(),
  })
  .passthrough();

const RecordingSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    length: z.number().optional(),
    "first-release-date": z.string().optional(),
  })
  .passthrough();

const LabelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    country: z.string().optional(),
    disambiguation: z.string().optional(),
  })
  .passthrough();

const SearchResultsSchema = z.object({
  query: z.string(),
  entity: z.string(),
  results: z.array(z.object({}).passthrough()),
  count: z.number(),
  offset: z.number(),
  timestamp: z.string(),
});

const EntityDetailSchema = z.object({
  entity: z.string(),
  data: z.object({}).passthrough(),
  timestamp: z.string(),
});

const BrowseResultsSchema = z.object({
  entity: z.string(),
  linkedEntity: z.string(),
  linkedId: z.string(),
  results: z.array(z.object({}).passthrough()),
  count: z.number(),
  offset: z.number(),
  // Only set (true/false) by sync-artist-discographies, which pages through
  // an artist's full discography and can hit its maxPages ceiling; the
  // single-page browse-* methods below don't paginate so leave it unset.
  // Explicit rather than inferred from count/results.length so a truncated
  // discography is visibly distinguishable from a complete one, never silent.
  truncated: z.boolean().optional(),
  timestamp: z.string(),
});

const DiscographySyncStateSchema = z.object({
  cursor: z.object({ offset: z.number() }),
  processed: z.array(z.string()),
  skipped: z.array(z.string()),
  updatedAt: z.string(),
});

/**
 * MusicBrainz metadata model — search and look up artists, release groups,
 * releases, recordings, and labels via the MusicBrainz Web Service v2, with
 * Bandcamp-to-MusicBrainz release-editor seeding helpers.
 */
export const model = {
  type: "@magistr/musicbrainz",
  version: "2026.08.04.1",
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.02.1",
      description:
        "Real-fix LB2-LB7 (musicbrainz-ssrf-and-latent-bugs): encodeURIComponent on all lookup MBIDs, TralbumData JSON.parse-first with a ://-protected fallback strip, bounded release-group pagination via a new optional maxPages global arg (default 50), NFKD+combining-mark-stripping normalizeTitle, an exported formatDuration() helper (H:MM:SS past one hour), and per-fetch AbortController timeouts + Retry-After surfacing + Array.isArray response guards on both mbFetch and fetchPage. No resource schema change; covers instances still at 2026.07.16.2 or 2026.07.31.1 (LB1 SSRF fix). globalArguments gains only the optional, defaulted maxPages field.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.02.1",
      toVersion: "2026.08.04.1",
      description:
        "Adds sync-artist-discographies: a cursored, resumable, rate-limited fan-out over a list of artist MBIDs that caches each one's full release-group discography, routed through the existing mbFetch + browse/rg-by-artist-<mbid> write path (same as browse-release-groups), bounded by a new maxPages method arg (default 20) with an explicit truncated flag on the cached entry so a ceiling-truncated discography is never mistaken for a complete one. New optional discographySyncState resource (resumable {cursor,processed,skipped,updatedAt} cursor state) and a new optional, defaulted truncated field on the existing browse resource schema — both additive; no existing resource shape changes, no globalArguments change. mbFetch's internal rate limiter also moves from a plain read-then-write timestamp check to a module-level promise-chain queue that reserves each call's slot synchronously before any await, closing a race where concurrent callers could read the same stale lastRequest and fire together; mbFetch also gains a single 503/Retry-After retry with backoff before throwing (previously the header was only surfaced, never acted on).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    search: {
      description: "Search results",
      schema: SearchResultsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    entity: {
      description: "Entity lookup detail",
      schema: EntityDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    browse: {
      description: "Browse results for linked entities",
      schema: BrowseResultsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    discographySyncState: {
      description: "Resumable cursor state for sync-artist-discographies",
      schema: DiscographySyncStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    artists: {
      description: "Artist results",
      schema: z.object({
        artists: z.array(ArtistSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    releaseGroups: {
      description: "Release group results",
      schema: z.object({
        releaseGroups: z.array(ReleaseGroupSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    releases: {
      description: "Release results",
      schema: z.object({
        releases: z.array(ReleaseSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    recordings: {
      description: "Recording results",
      schema: z.object({
        recordings: z.array(RecordingSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    labels: {
      description: "Label results",
      schema: z.object({
        labels: z.array(LabelSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    seedUrls: {
      description:
        "MusicBrainz release editor seed URLs generated from Bandcamp",
      schema: z.object({
        artist: z.string(),
        artistMbid: z.string().optional(),
        bandcampUrl: z.string(),
        releases: z.array(
          z.object({
            title: z.string(),
            bandcampUrl: z.string(),
            seedUrl: z.string(),
            trackCount: z.number(),
            releaseDate: z.string().optional(),
            status: z.string(),
          }),
        ),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    missingReleases: {
      description: "Releases found on Bandcamp but missing from MusicBrainz",
      schema: z.object({
        artist: z.string(),
        artistMbid: z.string().optional(),
        bandcampUrl: z.string(),
        mbReleaseCount: z.number(),
        bcReleaseCount: z.number(),
        missing: z.array(
          z.object({
            title: z.string(),
            bandcampUrl: z.string(),
            releaseDate: z.string().optional(),
            numTracks: z.number().optional(),
            seedUrl: z.string(),
          }),
        ),
        matched: z.array(
          z.object({
            bcTitle: z.string(),
            mbTitle: z.string(),
            mbId: z.string(),
          }),
        ),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // --- Search methods ---

    "search-artist": {
      description: "Search for artists by name or query",
      arguments: z.object({
        query: z.string().describe("Search query (Lucene syntax supported)"),
        limit: z.number().optional().describe(
          "Max results (1-100, default 25)",
        ),
        offset: z.number().optional().describe("Offset for pagination"),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/artist/", params);
        const artists = Array.isArray(data.artists) ? data.artists : [];
        const handle = await context.writeResource("artists", "search", {
          artists,
          count: data.count || artists.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-release-group": {
      description: "Search for release groups (albums/EPs/singles)",
      arguments: z.object({
        query: z.string().describe(
          "Search query (e.g., 'releasegroup:name AND artist:name')",
        ),
        limit: z.number().optional().describe(
          "Max results (1-100, default 25)",
        ),
        offset: z.number().optional().describe("Offset for pagination"),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/release-group/", params);
        const rgs = Array.isArray(data["release-groups"])
          ? data["release-groups"]
          : [];
        const handle = await context.writeResource("releaseGroups", "search", {
          releaseGroups: rgs,
          count: data.count || rgs.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-release": {
      description: "Search for releases",
      arguments: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/release/", params);
        const releases = Array.isArray(data.releases) ? data.releases : [];
        const handle = await context.writeResource("releases", "search", {
          releases,
          count: data.count || releases.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-recording": {
      description: "Search for recordings (tracks)",
      arguments: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/recording/", params);
        const recordings = Array.isArray(data.recordings)
          ? data.recordings
          : [];
        const handle = await context.writeResource("recordings", "search", {
          recordings,
          count: data.count || recordings.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-label": {
      description: "Search for record labels",
      arguments: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/label/", params);
        const labels = Array.isArray(data.labels) ? data.labels : [];
        const handle = await context.writeResource("labels", "search", {
          labels,
          count: data.count || labels.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Lookup methods ---

    "lookup-artist": {
      description: "Look up an artist by MBID with optional includes",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'releases+release-groups+recordings+aliases+tags+genres')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(
          userAgent,
          `/artist/${encodeURIComponent(args.id)}`,
          params,
        );
        const handle = await context.writeResource(
          "entity",
          `artist-${args.id}`,
          {
            entity: "artist",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-release-group": {
      description: "Look up a release group by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz release group ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'releases+artist-credits+tags+genres')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(
          userAgent,
          `/release-group/${encodeURIComponent(args.id)}`,
          params,
        );
        const handle = await context.writeResource("entity", `rg-${args.id}`, {
          entity: "release-group",
          data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "lookup-release": {
      description: "Look up a release by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz release ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'recordings+artist-credits+labels')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(
          userAgent,
          `/release/${encodeURIComponent(args.id)}`,
          params,
        );
        const handle = await context.writeResource(
          "entity",
          `release-${args.id}`,
          {
            entity: "release",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-recording": {
      description: "Look up a recording by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz recording ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'releases+artist-credits+isrcs+tags')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(
          userAgent,
          `/recording/${encodeURIComponent(args.id)}`,
          params,
        );
        const handle = await context.writeResource(
          "entity",
          `recording-${args.id}`,
          {
            entity: "recording",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-label": {
      description: "Look up a label by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz label ID"),
        inc: z.string().optional().describe(
          "Include params (e.g., 'releases+aliases+tags')",
        ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(
          userAgent,
          `/label/${encodeURIComponent(args.id)}`,
          params,
        );
        const handle = await context.writeResource(
          "entity",
          `label-${args.id}`,
          {
            entity: "label",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Browse methods ---

    "browse-release-groups": {
      description: "Browse release groups by artist MBID",
      arguments: z.object({
        artist: z.string().describe("Artist MBID"),
        type: z
          .string()
          .optional()
          .describe("Filter by type (album, single, ep, etc.)"),
        limit: z.number().optional().describe(
          "Max results (1-100, default 25)",
        ),
        offset: z.number().optional(),
        inc: z.string().optional().describe(
          "Include params (e.g., 'tags+genres')",
        ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { artist: args.artist };
        if (args.type) params.type = args.type;
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, "/release-group/", params);
        const rgs = Array.isArray(data["release-groups"])
          ? data["release-groups"]
          : [];
        const handle = await context.writeResource(
          "browse",
          `rg-by-artist-${args.artist}`,
          {
            entity: "release-group",
            linkedEntity: "artist",
            linkedId: args.artist,
            results: rgs,
            count: data["release-group-count"] || rgs.length,
            offset: data["release-group-offset"] || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "browse-releases": {
      description: "Browse releases by artist, label, or release-group MBID",
      arguments: z.object({
        artist: z.string().optional().describe("Artist MBID"),
        label: z.string().optional().describe("Label MBID"),
        releaseGroup: z.string().optional().describe("Release group MBID"),
        status: z.string().optional().describe(
          "Filter by status (official, bootleg, etc.)",
        ),
        type: z.string().optional().describe("Filter by type"),
        limit: z.number().optional(),
        offset: z.number().optional(),
        inc: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        let linkedEntity = "";
        let linkedId = "";
        if (args.artist) {
          params.artist = args.artist;
          linkedEntity = "artist";
          linkedId = args.artist;
        }
        if (args.label) {
          params.label = args.label;
          linkedEntity = "label";
          linkedId = args.label;
        }
        if (args.releaseGroup) {
          params["release-group"] = args.releaseGroup;
          linkedEntity = "release-group";
          linkedId = args.releaseGroup;
        }
        if (args.status) params.status = args.status;
        if (args.type) params.type = args.type;
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, "/release/", params);
        const releases = Array.isArray(data.releases) ? data.releases : [];
        const handle = await context.writeResource(
          "browse",
          `releases-by-${linkedEntity}-${linkedId}`,
          {
            entity: "release",
            linkedEntity,
            linkedId,
            results: releases,
            count: data["release-count"] || releases.length,
            offset: data["release-offset"] || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "browse-recordings": {
      description: "Browse recordings by artist or release MBID",
      arguments: z.object({
        artist: z.string().optional().describe("Artist MBID"),
        release: z.string().optional().describe("Release MBID"),
        limit: z.number().optional(),
        offset: z.number().optional(),
        inc: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        let linkedEntity = "";
        let linkedId = "";
        if (args.artist) {
          params.artist = args.artist;
          linkedEntity = "artist";
          linkedId = args.artist;
        }
        if (args.release) {
          params.release = args.release;
          linkedEntity = "release";
          linkedId = args.release;
        }
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, "/recording/", params);
        const recordings = Array.isArray(data.recordings)
          ? data.recordings
          : [];
        const handle = await context.writeResource(
          "browse",
          `recordings-by-${linkedEntity}-${linkedId}`,
          {
            entity: "recording",
            linkedEntity,
            linkedId,
            results: recordings,
            count: data["recording-count"] || recordings.length,
            offset: data["recording-offset"] || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Discography sync (cursored, resumable; rate-limited via mbFetch) ---

    "sync-artist-discographies": {
      description:
        "Fan out over a list of artist MBIDs and cache each one's full release-group discography, routed through the same mbFetch + `browse`/`rg-by-artist-<mbid>` write path as browse-release-groups, extended with pagination. 1 req/sec spacing is enforced once, at the mbFetch boundary — shared by every method in this model, not reimplemented here. Cursored and resumable: each run processes one batch starting at the persisted cursor, so an interrupted sync resumes rather than restarting, and repeated batches cover the artist list exactly once. A cached `count: 0` is treated as a legitimate empty discography (skipped like any other fresh cache), never re-fetched merely for being empty — only for being stale or never having been fetched at all. Per-artist pagination stops at `maxPages` and marks the cached entry `truncated: true` rather than silently returning a partial discography as if it were complete.",
      arguments: z.object({
        artistMbids: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit artist MBIDs to sync. Defaults to the artists cached by this instance's most recent search-artist run.",
          ),
        batchSize: z
          .number()
          .optional()
          .describe("Max number of artists to process this run (default 10)"),
        ttlMs: z
          .number()
          .optional()
          .describe(
            "Cache TTL in milliseconds before a populated/empty discography is re-fetched (default 7 days)",
          ),
        minIntervalMs: z
          .number()
          .optional()
          .describe(
            "Minimum milliseconds between MusicBrainz requests, enforced by mbFetch (default 1100, matching mbFetch's own default spacing — MusicBrainz allows ~1 req/sec)",
          ),
        maxPages: z
          .number()
          .optional()
          .describe(
            "Max release-group pages (100 per page) to fetch for a single artist before stopping and marking that artist's cached discography truncated (default 20, i.e. 2,000 release groups). Guards against one huge catalogue — e.g. a large classical composer — consuming an entire batched run at ~1 req/sec.",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const instanceName = context.definition.name;

        // Resolve the artist MBID list: explicit arg wins; otherwise fall
        // back to the artists cached by this instance's last search-artist
        // run (writeResource("artists", "search", ...) above). The generic
        // `search` method (below) writes instance name `<entity>-search`,
        // never bare "search", so it cannot collide with this read. NOTE:
        // search-release-group / search-release / search-recording /
        // search-label also write bare instance "search" (with their own,
        // incompatible shapes) — running one of those after search-artist
        // WOULD make this read return the wrong shape. That's a pre-existing
        // sibling-collision risk, not this method's bug to fix.
        let artistMbids = args.artistMbids;
        if (!artistMbids || artistMbids.length === 0) {
          const searchData = await context.readResource("search");
          artistMbids = (searchData?.artists ?? []).map((a) => a.id);
          if (artistMbids.length === 0) {
            throw new Error(
              `No artist list available on instance "${instanceName}". Run ` +
                `'swamp model method run ${instanceName} search-artist --query <name>' ` +
                `first, or pass artistMbids explicitly.`,
            );
          }
        }

        const batchSize = args.batchSize ?? 10;
        const ttlMs = args.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
        const minIntervalMs = args.minIntervalMs ?? 1100;
        const maxPages = args.maxPages ?? DEFAULT_DISCOGRAPHY_MAX_PAGES;

        // Resume from the persisted cursor rather than restarting at 0.
        const state = await context.readResource(
          DISCOGRAPHY_SYNC_CURSOR_INSTANCE,
        );
        let cursor: SyncCursor = state?.cursor ?? { offset: 0 };

        // A cursor at/past the end of the (possibly changed) input starts a
        // fresh pass instead of producing an empty batch forever.
        if (cursor.offset >= artistMbids.length) {
          cursor = { offset: 0 };
        }

        const batch = artistMbids.slice(
          cursor.offset,
          cursor.offset + batchSize,
        );
        const processed: string[] = [];
        const skipped: string[] = [];

        for (const mbid of batch) {
          const cached = await context.readResource(`rg-by-artist-${mbid}`);
          const status = classifyDiscographyCache(cached);
          if (
            status !== "never-fetched" &&
            cached &&
            !isCacheStale(cached.timestamp, Date.now(), ttlMs)
          ) {
            skipped.push(mbid);
            continue;
          }

          // Paginate this artist's full discography. Request spacing is
          // handled inside mbFetch itself (see the module-level rate
          // limiter above) — this loop just keeps calling it and stops at
          // maxPages so one huge catalogue can't consume the whole batch.
          const results: unknown[] = [];
          let count = 0;
          let offset = 0;
          let pagesFetched = 0;
          let truncated = false;
          while (true) {
            const data = await mbFetch(
              userAgent,
              "/release-group/",
              { artist: mbid, limit: "100", offset: String(offset) },
              minIntervalMs,
            );
            pagesFetched++;

            const rgs = Array.isArray(data["release-groups"])
              ? data["release-groups"]
              : [];
            results.push(...rgs);
            count = data["release-group-count"] ?? results.length;
            if (rgs.length < 100) break; // reached the real end of this artist's discography

            if (pagesFetched >= maxPages) {
              // Hit the page ceiling with a still-full page: more release
              // groups almost certainly remain (e.g. a large classical
              // catalogue). Stop rather than consuming the rest of the run
              // on one artist — but record the truncation so it's visible
              // instead of silently caching a partial discography as
              // complete.
              truncated = true;
              break;
            }
            offset += 100;
          }

          await context.writeResource("browse", `rg-by-artist-${mbid}`, {
            entity: "release-group",
            linkedEntity: "artist",
            linkedId: mbid,
            results,
            count,
            offset: 0,
            truncated,
            timestamp: new Date().toISOString(),
          });
          processed.push(mbid);
        }

        const nextCursor = advanceSyncCursor(cursor, {
          processedCount: batch.length,
        });

        const handle = await context.writeResource(
          "discographySyncState",
          DISCOGRAPHY_SYNC_CURSOR_INSTANCE,
          {
            cursor: nextCursor,
            processed,
            skipped,
            updatedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    // --- Bandcamp → MusicBrainz seeding ---

    "seed-from-bandcamp": {
      description:
        "Fetch a Bandcamp album and generate a MusicBrainz release editor seed URL",
      arguments: z.object({
        bandcampUrl: z.string().describe("Bandcamp album URL"),
        artistMbid: z.string().optional().describe(
          "MusicBrainz artist MBID to link",
        ),
      }),
      execute: async (args, context) => {
        const html = await fetchPage(args.bandcampUrl);
        const album = parseBandcampAlbumPage(html);
        const seedUrl = buildSeedUrl(album, args.artistMbid, args.bandcampUrl);
        const handle = await context.writeResource("seedUrls", `seed-single`, {
          artist: album.artist,
          artistMbid: args.artistMbid,
          bandcampUrl: args.bandcampUrl,
          releases: [{
            title: album.title,
            bandcampUrl: args.bandcampUrl,
            seedUrl,
            trackCount: album.tracks.length,
            releaseDate: album.releaseDate,
            status: "ready",
          }],
          total: 1,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "find-missing": {
      description:
        "Compare an artist's Bandcamp discography against MusicBrainz and find missing releases with seed URLs",
      arguments: z.object({
        bandcampUrl: z.string().describe(
          "Bandcamp artist URL (e.g., https://artist.bandcamp.com)",
        ),
        artistMbid: z.string().optional().describe(
          "MusicBrainz artist MBID (auto-searched if omitted)",
        ),
      }),
      execute: async (args, context) => {
        const { userAgent, maxPages: maxPagesArg } = context.globalArgs;
        const maxPages = maxPagesArg ?? 50;

        // 1. Get Bandcamp discography
        let bcUrl = args.bandcampUrl.replace(/\/$/, "");
        if (!bcUrl.endsWith("/music")) bcUrl += "/music";
        const bcHtml = await fetchPage(bcUrl);
        const bcArtist = parseBandcampArtistPage(bcHtml);

        // 2. Resolve artist MBID
        let artistMbid = args.artistMbid;
        let artistName = bcArtist.name;
        if (!artistMbid && artistName) {
          const searchData = await mbFetch(userAgent, "/artist/", {
            query: artistName,
            limit: "5",
          });
          const artists = searchData.artists || [];
          // try exact match first
          // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz artist record
          const exact = artists.find((a: any) =>
            normalizeTitle(a.name) === normalizeTitle(artistName)
          );
          if (exact) {
            artistMbid = exact.id;
            artistName = exact.name;
          }
        }

        // 3. Get MusicBrainz release groups (bounded by maxPages so a
        // hostile/misbehaving MusicBrainz endpoint that always returns a
        // full page can never loop forever)
        // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz release groups
        const mbReleases: any[] = [];
        if (artistMbid) {
          let offset = 0;
          for (let page = 0; page < maxPages; page++) {
            const data = await mbFetch(userAgent, "/release-group/", {
              artist: artistMbid,
              limit: "100",
              offset: String(offset),
            });
            const rgs = Array.isArray(data["release-groups"])
              ? data["release-groups"]
              : [];
            mbReleases.push(...rgs);
            if (rgs.length < 100) break;
            offset += 100;
          }
        }

        // 4. Match and find missing
        const mbTitlesNorm = mbReleases.map((r) => ({
          norm: normalizeTitle(r.title),
          title: r.title,
          id: r.id,
        }));

        // deno-lint-ignore no-explicit-any -- assembled missing-release records
        const missing: any[] = [];
        // deno-lint-ignore no-explicit-any -- assembled matched-release records
        const matched: any[] = [];

        for (const bc of bcArtist.discography) {
          const bcNorm = normalizeTitle(bc.title);
          const match = mbTitlesNorm.find((mb) => mb.norm === bcNorm);
          if (match) {
            matched.push({
              bcTitle: bc.title,
              mbTitle: match.title,
              mbId: match.id,
            });
          } else {
            // build seed URL — fetch album page for track data
            let seedUrl = "";
            let trackCount = bc.numTracks || 0;
            const albumUrl = bc.url.startsWith("http")
              ? bc.url
              : `${args.bandcampUrl.replace(/\/$/, "")}${bc.url}`;
            try {
              const albumHtml = await fetchPage(albumUrl);
              const albumData = parseBandcampAlbumPage(albumHtml);
              seedUrl = buildSeedUrl(albumData, artistMbid, albumUrl);
              trackCount = albumData.tracks.length || trackCount;
            } catch {
              // if fetch fails, build a minimal seed URL
              const params = new URLSearchParams();
              params.set("name", bc.title);
              params.set("type", "album");
              params.set("artist_credit.names.0.artist.name", artistName);
              if (artistMbid) {
                params.set("artist_credit.names.0.mbid", artistMbid);
              }
              if (bc.releaseDate) {
                const parts = bc.releaseDate.split(/[-/]/);
                if (parts[0]) params.set("events.0.date.year", parts[0]);
                if (parts[1]) params.set("events.0.date.month", parts[1]);
                if (parts[2]) params.set("events.0.date.day", parts[2]);
              }
              params.set("urls.0.url", albumUrl);
              params.set("urls.0.link_type", "85");
              params.set("edit_note", `Seeded from Bandcamp: ${albumUrl}`);
              seedUrl =
                `https://musicbrainz.org/release/add?${params.toString()}`;
            }

            missing.push({
              title: bc.title,
              bandcampUrl: albumUrl,
              releaseDate: bc.releaseDate || "",
              numTracks: trackCount,
              seedUrl,
            });
          }
        }

        const handle = await context.writeResource(
          "missingReleases",
          artistMbid || "unknown",
          {
            artist: artistName,
            artistMbid,
            bandcampUrl: args.bandcampUrl,
            mbReleaseCount: mbReleases.length,
            bcReleaseCount: bcArtist.discography.length,
            missing,
            matched,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "seed-all-missing": {
      description:
        "Generate MusicBrainz seed URLs for ALL missing releases of an artist (Bandcamp vs MusicBrainz)",
      arguments: z.object({
        bandcampUrl: z.string().describe("Bandcamp artist URL"),
        artistMbid: z.string().optional().describe("MusicBrainz artist MBID"),
      }),
      execute: async (args, context) => {
        const { userAgent, maxPages: maxPagesArg } = context.globalArgs;
        const maxPages = maxPagesArg ?? 50;

        // Fetch bandcamp discography
        let bcUrl = args.bandcampUrl.replace(/\/$/, "");
        if (!bcUrl.endsWith("/music")) bcUrl += "/music";
        const bcHtml = await fetchPage(bcUrl);
        const bcArtist = parseBandcampArtistPage(bcHtml);

        let artistMbid = args.artistMbid;
        let artistName = bcArtist.name;
        if (!artistMbid && artistName) {
          const searchData = await mbFetch(userAgent, "/artist/", {
            query: artistName,
            limit: "5",
          });
          // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz artist record
          const exact = (searchData.artists || []).find((a: any) =>
            normalizeTitle(a.name) === normalizeTitle(artistName)
          );
          if (exact) {
            artistMbid = exact.id;
            artistName = exact.name;
          }
        }

        // Get MB releases (bounded by maxPages — see find-missing's comment)
        // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz release groups
        const mbReleases: any[] = [];
        if (artistMbid) {
          let offset = 0;
          for (let page = 0; page < maxPages; page++) {
            const data = await mbFetch(userAgent, "/release-group/", {
              artist: artistMbid,
              limit: "100",
              offset: String(offset),
            });
            const rgs = Array.isArray(data["release-groups"])
              ? data["release-groups"]
              : [];
            mbReleases.push(...rgs);
            if (rgs.length < 100) break;
            offset += 100;
          }
        }

        const mbTitlesNorm = new Set(
          mbReleases.map((r) => normalizeTitle(r.title)),
        );
        // deno-lint-ignore no-explicit-any -- assembled seed-URL release records
        const releases: any[] = [];

        for (const bc of bcArtist.discography) {
          if (mbTitlesNorm.has(normalizeTitle(bc.title))) continue;

          const albumUrl = bc.url.startsWith("http")
            ? bc.url
            : `${args.bandcampUrl.replace(/\/$/, "")}${bc.url}`;
          let seedUrl = "";
          let trackCount = bc.numTracks || 0;
          let releaseDate = bc.releaseDate || "";

          try {
            const albumHtml = await fetchPage(albumUrl);
            const albumData = parseBandcampAlbumPage(albumHtml);
            seedUrl = buildSeedUrl(albumData, artistMbid, albumUrl);
            trackCount = albumData.tracks.length || trackCount;
            releaseDate = albumData.releaseDate || releaseDate;
          } catch {
            const params = new URLSearchParams();
            params.set("name", bc.title);
            params.set("type", "album");
            params.set("artist_credit.names.0.artist.name", artistName);
            if (artistMbid) {
              params.set("artist_credit.names.0.mbid", artistMbid);
            }
            params.set("urls.0.url", albumUrl);
            params.set("urls.0.link_type", "85");
            params.set("edit_note", `Seeded from Bandcamp: ${albumUrl}`);
            seedUrl =
              `https://musicbrainz.org/release/add?${params.toString()}`;
          }

          releases.push({
            title: bc.title,
            bandcampUrl: albumUrl,
            seedUrl,
            trackCount,
            releaseDate,
            status: "ready",
          });
        }

        const handle = await context.writeResource(
          "seedUrls",
          artistMbid || "all-missing",
          {
            artist: artistName,
            artistMbid,
            bandcampUrl: args.bandcampUrl,
            releases,
            total: releases.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Generic search ---

    search: {
      description:
        "Search any entity type (area, event, instrument, place, series, work, etc.)",
      arguments: z.object({
        entity: z
          .enum([
            "area",
            "artist",
            "event",
            "instrument",
            "label",
            "place",
            "recording",
            "release",
            "release-group",
            "series",
            "work",
            "tag",
          ])
          .describe("Entity type to search"),
        query: z.string().describe("Lucene search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, `/${args.entity}/`, params);
        // MusicBrainz returns results in a key that varies by entity type
        const keys = Object.keys(data).filter((k) =>
          k !== "count" && k !== "offset" && k !== "created"
        );
        const resultsKey = keys[0] || args.entity;
        const results = Array.isArray(data[resultsKey]) ? data[resultsKey] : [];
        const handle = await context.writeResource(
          "search",
          `${args.entity}-search`,
          {
            query: args.query,
            entity: args.entity,
            results,
            count: data.count || results.length,
            offset: data.offset || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
