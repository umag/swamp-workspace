/**
 * Anime automation pipeline — fetch airing episodes, upgrade to BD releases,
 * and sync watch progress back to AniList.
 *
 * Replaces Seanime's auto-downloader, AniList sync, and BD upgrade features.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Extract episode number from a fansub torrent title. */
export function parseEpisode(title: string): number | null {
  const m1 = title.match(/\s-\s(\d{1,3})(?:v\d+)?\s/);
  if (m1) return parseInt(m1[1], 10);
  // "S01E09": the bare E-prefix below never matches it — a digit and the E
  // are both word chars, so `\b` before the E does not fire.
  const mS = title.match(/\bS\d{1,2}E(\d{1,3})\b/i);
  if (mS) return parseInt(mS[1], 10);
  const m2 = title.match(/\bE(?:P)?(\d{2,3})\b/i);
  if (m2) return parseInt(m2[1], 10);
  const m3 = title.match(/[\[(](\d{2,3})[\])](?:\s|$)/);
  if (m3) return parseInt(m3[1], 10);
  return null;
}

// ─── AniList helpers ──────────────────────────────────────────────────────────

const ANILIST_API = "https://graphql.anilist.co";

async function gqlRequest(
  query: string,
  variables: Record<string, unknown>,
  token?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(ANILIST_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(
      `AniList ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
    );
  }
  const json = await resp.json() as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string; status?: number }>;
  };
  if (json.errors?.length) {
    throw new Error(
      `AniList errors: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }
  return json.data ?? {};
}

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

const COMPLETED_QUERY = `
query ($userName: String!) {
  MediaListCollection(userName: $userName, type: ANIME, status: COMPLETED) {
    lists {
      entries {
        progress
        media {
          id
          title { romaji english }
          episodes
          status
          averageScore
        }
      }
    }
  }
}`;

const UPDATE_PROGRESS_MUTATION = `
mutation ($mediaId: Int!, $progress: Int!, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
    id mediaId status progress updatedAt
  }
}`;

interface WatchEntry {
  mediaId: number;
  romaji: string;
  english: string | null;
  synonyms: string[];
  progress: number;
  episodes: number | null;
  mediaStatus: string | null;
  nextAiringEp: number | null;
  nextAiringAt: number | null;
}

async function getCurrentList(userName: string): Promise<WatchEntry[]> {
  const data = await gqlRequest(WATCHING_QUERY, { userName });
  const collection = data.MediaListCollection as {
    lists: Array<{
      entries: Array<{
        progress: number;
        media: {
          id: number;
          title: { romaji: string | null; english: string | null };
          synonyms: string[] | null;
          episodes: number | null;
          status: string | null;
          nextAiringEpisode: { episode: number; airingAt: number } | null;
        };
      }>;
    }>;
  };
  return (collection.lists ?? []).flatMap((l) =>
    l.entries.map((e) => ({
      mediaId: e.media.id,
      romaji: e.media.title.romaji ?? "",
      english: e.media.title.english,
      synonyms: e.media.synonyms ?? [],
      progress: e.progress,
      episodes: e.media.episodes,
      mediaStatus: e.media.status,
      nextAiringEp: e.media.nextAiringEpisode?.episode ?? null,
      nextAiringAt: e.media.nextAiringEpisode?.airingAt ?? null,
    }))
  );
}

// ─── Nyaa helpers ─────────────────────────────────────────────────────────────

const NYAA_BASE = "https://nyaa.si";
const PREFERRED_GROUPS: Record<string, number> = {
  "subsplease": 10,
  "erai-raws": 9,
  "ember": 8,
  "asw": 7,
  "varyg": 7,
  "judas": 6,
};

/** Vertical resolution parsed out of a release title; 0 when absent. */
export function parseResolution(title: string): number {
  if (/4k|2160p/i.test(title)) return 2160;
  if (/1080p/i.test(title)) return 1080;
  if (/720p/i.test(title)) return 720;
  return 0;
}

/** Score a release title by its group credit; 1 when unrecognised.
 *
 *  Fansub releases lead with `[Group]`. Scene-style rips (VARYG, ToonsHub,
 *  FLUX …) instead hang the credit off the END with a dash: `H.264-VARYG`,
 *  `H.264-VARYG.mkv`, `H.264-VARYG (Romaji Title, Multi-Subs)`. The suffix is
 *  only consulted when there is no bracketed credit, and must be followed by
 *  `.mkv`, a parenthesised tail or the end of the title — so body dashes such
 *  as `WEB-DL DUAL` or `Dual-Audio]` never read as a group. */
export function groupScore(title: string): number {
  const lower = title.toLowerCase();
  const bracketed = lower.match(/^\[([^\]]+)\]/);
  if (bracketed) return PREFERRED_GROUPS[bracketed[1]] ?? 1;
  const suffixed = lower.match(/-([a-z0-9]+)(?:\.mkv|\s*\(|\s*$)/);
  return PREFERRED_GROUPS[suffixed?.[1] ?? ""] ?? 1;
}

/** Build a magnet URI from an infoHash plus a display name and the trackers
 *  nyaa releases rely on. */
export function buildMagnet(infoHash: string, title: string): string {
  return (
    `magnet:?xt=urn:btih:${infoHash}` +
    `&dn=${encodeURIComponent(title)}` +
    `&tr=${encodeURIComponent("http://nyaa.tracker.wf:7777/announce")}`
  );
}

/** One parsed nyaa RSS entry, normalised into the fields ranking needs. */
export interface NyaaHit {
  title: string;
  viewUrl: string;
  magnet: string;
  infoHash: string;
  seeders: number;
  episode: number | null;
  resolution: number;
  sizeBytes: number;
}

/** Parse nyaa's human-readable `<nyaa:size>` ("1.4 GiB") into bytes.
 *  Returns 0 for anything unparseable so a missing size never NaNs a total. */
export function parseNyaaSize(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*([KMGT]i?B)$/i);
  if (!m) return 0;
  const unit = m[2].toUpperCase().replace("IB", "B");
  const scale: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(parseFloat(m[1]) * (scale[unit] ?? 0));
}

function parseRSS(xml: string): NyaaHit[] {
  const hits: NyaaHit[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ??
      block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() ?? "";
    const link = (block.match(/<link>(.*?)<\/link>/) ??
      block.match(/<guid[^>]*>(.*?)<\/guid>/))?.[1]?.trim() ?? "";
    const seeders = parseInt(
      (block.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/) ?? [])[1] ?? "0",
    );
    const infoHash = (
      (block.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/) ?? [])[1] ?? ""
    ).toLowerCase();
    if (!title || !infoHash) continue;
    hits.push({
      title,
      viewUrl: link.includes("nyaa.si/view")
        ? link
        : `${NYAA_BASE}/view/${link.replace(/\D/g, "")}`,
      magnet: buildMagnet(infoHash, title),
      infoHash,
      seeders,
      episode: parseEpisode(title),
      resolution: parseResolution(title),
      sizeBytes: parseNyaaSize(
        (block.match(/<nyaa:size>(.*?)<\/nyaa:size>/) ?? [])[1] ?? "",
      ),
    });
  }
  return hits;
}

async function nyaaSearch(
  query: string,
  category = "1_2",
): Promise<NyaaHit[]> {
  const url = `${NYAA_BASE}/?page=rss&q=${
    encodeURIComponent(query)
  }&c=${category}&f=0`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "swamp-anime/1.0" },
  });
  if (!resp.ok) throw new Error(`Nyaa ${resp.status}: ${query}`);
  return parseRSS(await resp.text());
}

/** Nyaa RSS caps a page at 75 items — walk pages until a short/empty one. */
async function nyaaSearchPaged(
  query: string,
  category: string,
  maxPages: number,
): Promise<NyaaHit[]> {
  const RSS_PAGE_SIZE = 75;
  const out: NyaaHit[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = `${NYAA_BASE}/?page=rss&q=${
      encodeURIComponent(query)
    }&c=${category}&f=0&p=${p}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "swamp-anime/1.0" },
    });
    if (!resp.ok) throw new Error(`Nyaa ${resp.status}: ${query} p${p}`);
    const hits = parseRSS(await resp.text());
    out.push(...hits);
    if (hits.length < RSS_PAGE_SIZE) break;
  }
  return out;
}

// ─── release-group helpers ────────────────────────────────────────────────────

/** Decode the XML entities nyaa emits inside `<title>`.
 *  `&amp;` must be decoded LAST or `&amp;lt;` would collapse to `<`. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#0?39);/g, "'")
    .replace(/&amp;/g, "&");
}

/** Escape for Telegram `parseMode=HTML`. Release titles routinely contain a
 *  bare `&` ("[LonelyChaser & Kineko Video]"), which breaks the message. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Groups credited in a title's leading bracket.
 *  "[LonelyChaser & Kineko Video] Foo" → ["LonelyChaser", "Kineko Video"] */
export function bracketGroups(title: string): string[] {
  const m = decodeEntities(title).match(/^\s*\[([^\]]+)\]/);
  if (!m) return [];
  return m[1].split(/\s*[&+,/]\s*/).map((g) => g.trim()).filter(Boolean);
}

/** Lowercase alnum-only form: "LonelyChaser-Raws" → "lonelychaserraws". */
export function normGroup(g: string): string {
  return g.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The wanted group credited by this title, or null.
 *  Prefix-matches in both directions so a wanted "LonelyChaser" catches the
 *  "LonelyChaser-Raws" alias and a wanted "Kineko Video" catches bare
 *  "Kineko". Both sides must be >= MIN_STEM chars so a short token like "a"
 *  cannot wildcard onto every group. */
export function creditsGroup(
  title: string,
  wanted: string[],
): string | null {
  const MIN_STEM = 5;
  const want = wanted.map(normGroup).filter((w) => w.length >= MIN_STEM);
  for (const credited of bracketGroups(title)) {
    const n = normGroup(credited);
    if (n.length < MIN_STEM) continue;
    for (const w of want) {
      if (n.startsWith(w) || w.startsWith(n)) return credited;
    }
  }
  return null;
}

/** Strip subtitle and season indicators to get a base title for fallback search.
 *  "Mushoku Tensei III: Isekai Ittara Honki Dasu" → "Mushoku Tensei"
 *  "Shokugeki no Souma: San no Sara" → "Shokugeki no Souma"
 *  "Kaguya-sama 2nd Season" → "Kaguya-sama"
 */
export function baseTitle(title: string): string | null {
  let t = title;
  // Strip subtitle after colon
  const colonIdx = t.indexOf(":");
  if (colonIdx > 0) t = t.slice(0, colonIdx).trim();
  // Strip trailing roman numerals (II–X)
  t = t.replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)$/i, "").trim();
  // Strip trailing season labels
  t = t.replace(/\s+(?:\d+(?:st|nd|rd|th)?\s+Season|Season\s+\d+|S\d+)$/i, "")
    .trim();
  // Strip trailing plain number season "Title 2", "Title 3"
  t = t.replace(/\s+\d+$/, "").trim();
  return t !== title && t.length > 0 ? t : null;
}

/** Choose the best release for an episode: hard resolution floor first, then
 *  rank by preferred group, seeders and an exact-resolution bonus. */
export function pickBest(
  hits: NyaaHit[],
  episode: number,
  targetRes = 1080,
): NyaaHit | null {
  // Resolution is a HARD floor, not a ranking bonus: a preferred group at
  // 720p must never beat an acceptable 1080p release. Soft-ranking it was
  // tried and rejected — below targetRes we would rather download nothing and
  // retry next hour than fill the library with the wrong master.
  const matching = hits.filter(
    (h) => h.episode === episode && h.resolution >= targetRes,
  );
  if (!matching.length) return null;
  return matching.sort((a, b) => {
    const sa = groupScore(a.title) * 10 +
      Math.min(a.seeders, 100) * 0.1 +
      (a.resolution === targetRes ? 5 : 0);
    const sb = groupScore(b.title) * 10 +
      Math.min(b.seeders, 100) * 0.1 +
      (b.resolution === targetRes ? 5 : 0);
    return sb - sa;
  })[0];
}

// ─── Transmission helpers ─────────────────────────────────────────────────────

interface TxTorrent {
  id: number;
  name: string;
  status: number;
  percentDone: number;
  isFinished: boolean;
  doneDate: number;
  downloadDir: string;
  totalSize: number;
  hashString: string;
}

async function txRpc(
  url: string,
  user: string,
  pass: string,
  method: string,
  args: Record<string, unknown> = {},
  sid?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": "Basic " + btoa(`${user}:${pass}`),
  };
  if (sid) headers["X-Transmission-Session-Id"] = sid;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ method, arguments: args }),
  });
  if (resp.status === 409) {
    const newSid = resp.headers.get("X-Transmission-Session-Id");
    if (!newSid) throw new Error("409 from transmission but no session id");
    return txRpc(url, user, pass, method, args, newSid);
  }
  if (!resp.ok) {
    throw new Error(`Transmission ${method} failed: ${resp.status}`);
  }
  return await resp.json() as Record<string, unknown>;
}

async function txListTorrents(
  url: string,
  user: string,
  pass: string,
): Promise<TxTorrent[]> {
  const res = await txRpc(url, user, pass, "torrent-get", {
    fields: [
      "id",
      "name",
      "status",
      "percentDone",
      "isFinished",
      "doneDate",
      "downloadDir",
      "totalSize",
      "hashString",
    ],
  });
  return (res.arguments as { torrents: TxTorrent[] }).torrents ?? [];
}

async function txAdd(
  url: string,
  user: string,
  pass: string,
  source: string,
  downloadDir: string,
): Promise<
  { added: boolean; duplicate: boolean; id: number | null; name: string | null }
> {
  let src = source;
  // Auto-convert nyaa view URL → torrent file URL
  const nyaaMatch = src.match(/^https?:\/\/(nyaa\.si)\/view\/(\d+)/);
  if (nyaaMatch) {
    src = `https://${nyaaMatch[1]}/download/${nyaaMatch[2]}.torrent`;
  }

  const res = await txRpc(url, user, pass, "torrent-add", {
    filename: src,
    "download-dir": downloadDir,
    paused: false,
  });
  const a = res.arguments as {
    "torrent-added"?: { id: number; name: string };
    "torrent-duplicate"?: { id: number; name: string };
  };
  if (a["torrent-added"]) {
    return {
      added: true,
      duplicate: false,
      id: a["torrent-added"].id,
      name: a["torrent-added"].name,
    };
  }
  if (a["torrent-duplicate"]) {
    return {
      added: false,
      duplicate: true,
      id: a["torrent-duplicate"].id,
      name: a["torrent-duplicate"].name,
    };
  }
  return { added: false, duplicate: false, id: null, name: null };
}

/** Seed without end: mode 2 is "unlimited", overriding the global ratio/idle
 *  limits per torrent, so an archive keeps seeding regardless of what the
 *  session defaults are set to later. Idempotent — re-setting is a no-op. */
async function txSeedForever(
  url: string,
  user: string,
  pass: string,
  ids: number[],
): Promise<void> {
  if (!ids.length) return;
  await txRpc(url, user, pass, "torrent-set", {
    ids,
    seedRatioMode: 2,
    seedIdleMode: 2,
  });
}

// ─── SeaDex helpers ───────────────────────────────────────────────────────────

interface SeadexTorrent {
  releaseGroup: string;
  tracker: string;
  infoHash: string;
  isBest: boolean;
  url: string;
}

async function seadexLookup(
  anilistId: number,
): Promise<SeadexTorrent[] | null> {
  const url =
    `https://releases.moe/api/collections/entries/records?filter=(alID=${anilistId})&expand=trs&perPage=1`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "swamp-anime/1.0", "Accept": "application/json" },
  });
  if (!resp.ok) return null;
  const data = await resp.json() as {
    items: Array<{
      expand?: { trs?: SeadexTorrent[] };
    }>;
  };
  return data.items[0]?.expand?.trs ?? null;
}

// ─── folder name helpers ──────────────────────────────────────────────────────

/** Sanitize a show title to a safe folder name. */
export function toFolderName(title: string): string {
  return title
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Extract probable show title from a torrent name. */
export function extractShowTitle(torrentName: string): string {
  let t = torrentName.replace(/^\[[^\]]+\]\s*/, ""); // strip [Group]
  t = t.replace(/\s-\s\d{1,3}(?:v\d+)?\s.*$/, ""); // strip " - NN ..."
  t = t.replace(/\s*[\[(][^\]]*[\])]\s*$/, ""); // strip trailing [tag]
  return t.trim();
}

// ─── watchlist cache ──────────────────────────────────────────────────────────
//
// AniList goes down. Its 403/429 outages are routine and self-healing, but
// `fetch-airing` queried it FIRST, so an outage stopped every download for its
// duration — on 2026-08-22 three consecutive hourly runs failed and nothing was
// fetched for three hours. Nothing about downloading actually needs AniList to
// be reachable: it needs to know WHAT is being watched, which barely changes.
//
// So every successful fetch caches the CURRENT list, and a failed one falls
// back to that cache.
//
// A raw snapshot is not enough. `lastAiredEp` is derived as `nextAiringEp - 1`,
// so replaying yesterday's snapshot would conclude that nothing new has aired
// and download nothing — the exact failure it is meant to fix. The cache is
// therefore PROJECTED forward: TV anime airs weekly, so from the cached
// `nextAiringAt` the number of episodes since is simply the number of whole
// weeks elapsed, plus the one airing at that instant.

/** One cached watch entry plus how it was derived. */
const CachedEntrySchema = z.object({
  mediaId: z.number(),
  romaji: z.string(),
  english: z.string().nullable(),
  synonyms: z.array(z.string()),
  progress: z.number(),
  episodes: z.number().nullable(),
  mediaStatus: z.string().nullable(),
  nextAiringEp: z.number().nullable(),
  nextAiringAt: z.number().nullable(),
});

const WatchlistCacheSchema = z.object({
  user: z.string(),
  capturedAt: z.string().describe("ISO time this list came from AniList"),
  seeded: z.boolean().default(false).describe(
    "True when reconstructed from a past fetchResult rather than read from AniList — airing times are INFERRED, not observed",
  ),
  entries: z.array(CachedEntrySchema),
});

/** Seconds in the weekly cadence essentially all airing TV anime follows. */
export const WEEK_SECONDS = 604800;

/**
 * Advance one cached entry's airing pointer to now.
 *
 * `nextAiringEp` airs AT `nextAiringAt`, so once that instant has passed the
 * episode is out: episodes aired since = whole weeks elapsed + 1. Capped at the
 * season's total so a finished show is never projected past its last episode.
 *
 * Entries with no airing data (finished shows) are returned untouched — their
 * `episodes` total already tells the caller everything.
 */
export function projectEntry<
  T extends {
    episodes: number | null;
    nextAiringEp: number | null;
    nextAiringAt: number | null;
  },
>(entry: T, nowSec: number, weekSeconds = WEEK_SECONDS): T {
  const { nextAiringEp, nextAiringAt } = entry;
  if (nextAiringEp == null || nextAiringAt == null) return entry;
  if (nowSec < nextAiringAt) return entry;
  if (weekSeconds <= 0) return entry;
  const airedSince = Math.floor((nowSec - nextAiringAt) / weekSeconds) + 1;
  let projectedEp = nextAiringEp + airedSince;
  // episodes+1 is the correct ceiling: it makes lastAiredEp === episodes.
  if (entry.episodes != null && projectedEp > entry.episodes + 1) {
    projectedEp = entry.episodes + 1;
  }
  return {
    ...entry,
    nextAiringEp: projectedEp,
    nextAiringAt: nextAiringAt + airedSince * weekSeconds,
  };
}

/**
 * Rebuild a watch list from a past `fetchResult`.
 *
 * A stopgap for the case the cache cannot cover: AniList went down BEFORE any
 * successful run had cached anything, so there is nothing to fall back to. A
 * previous fetchResult still records which shows were being watched and which
 * episode each was up to, which is enough to keep downloading.
 *
 * What it cannot recover is the airing SCHEDULE — `nextAiringAt` is inferred as
 * the capture time, i.e. "assume the pending episode was due then". The result
 * is marked `seeded` so this guess is never mistaken for observed data, and the
 * first successful AniList read overwrites it with the real thing.
 *
 * Progress is derived per show from the strongest signal available:
 *   `duplicate` — that episode is already in Transmission, so progress >= it
 *   anything else — it was not obtained, so progress is one below
 * taking the highest across every outcome for that show.
 */
export function seedEntriesFromOutcomes(
  outcomes: ReadonlyArray<
    { mediaId: number; title: string; episode: number; status: string }
  >,
  capturedAtSec: number,
): Array<z.infer<typeof CachedEntrySchema>> {
  const byShow = new Map<number, { title: string; progress: number }>();
  for (const o of outcomes) {
    if (typeof o.mediaId !== "number" || typeof o.episode !== "number") {
      continue;
    }
    if (!Number.isFinite(o.episode) || o.episode < 1) continue;
    const progress = o.status === "duplicate" ? o.episode : o.episode - 1;
    const prev = byShow.get(o.mediaId);
    if (prev === undefined || progress > prev.progress) {
      byShow.set(o.mediaId, { title: o.title ?? "", progress });
    } else if (prev.title === "" && o.title) {
      prev.title = o.title;
    }
  }
  return [...byShow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mediaId, v]) => ({
      mediaId,
      romaji: v.title,
      english: null,
      synonyms: [],
      progress: Math.max(0, v.progress),
      // Unknown from a fetchResult. Left null deliberately rather than guessed:
      // a wrong total would either cap projection early or trigger the
      // "all-eps-downloaded" skip on a show that is still airing.
      episodes: null,
      mediaStatus: "RELEASING",
      nextAiringEp: v.progress + 1,
      nextAiringAt: capturedAtSec,
    }));
}

/** Age of a cache capture in seconds; Infinity when unparseable. */
export function cacheAgeSeconds(capturedAt: string, nowSec: number): number {
  const ms = Date.parse(capturedAt);
  if (Number.isNaN(ms)) return Infinity;
  return nowSec - Math.floor(ms / 1000);
}

// ─── schemas ──────────────────────────────────────────────────────────────────

const FetchResultSchema = z.object({
  checked: z.number().describe("Shows checked on AniList CURRENT list"),
  skipped: z.number().describe("Shows skipped (not yet aired, or completed)"),
  queued: z.number().describe("Torrents added to Transmission"),
  duplicates: z.number().describe("Already present in Transmission"),
  notFound: z.number().describe("No Nyaa result found"),
  outcomes: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    episode: z.number(),
    status: z.enum(["queued", "duplicate", "not-found", "skipped", "error"]),
    torrentName: z.string().optional(),
    reason: z.string().optional(),
  })),
  // Where the watch list came from. "cache" means AniList was unreachable and
  // the run proceeded from the last good list, so every airing time below is
  // projected rather than observed.
  listSource: z.enum(["anilist", "cache"]).default("anilist"),
  listAgeSeconds: z.number().default(0).describe(
    "Age of the cached list in seconds; 0 when AniList answered directly",
  ),
  alertsSuppressed: z.number().default(0).describe(
    "Overdue not-found alerts withheld because the airing time was inferred from a cached list rather than read from AniList",
  ),
  timestamp: z.string(),
});

const MarkWatchedSchema = z.object({
  checked: z.number(),
  updated: z.number(),
  failed: z.number(),
  outcomes: z.array(z.object({
    torrentName: z.string(),
    showTitle: z.string(),
    episode: z.number().nullable(),
    anilistId: z.number().nullable(),
    updated: z.boolean(),
    reason: z.string().optional(),
  })),
  timestamp: z.string(),
});

const UpgradeBdSchema = z.object({
  checked: z.number(),
  queued: z.number(),
  skippedOnDisk: z.number(),
  notInSeadex: z.number(),
  outcomes: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    status: z.enum([
      "queued",
      "duplicate",
      "on-disk",
      "not-in-seadex",
      "no-best",
      "error",
    ]),
    releaseGroup: z.string().optional(),
    reason: z.string().optional(),
  })),
  timestamp: z.string(),
});

const ArchiveResultSchema = z.object({
  groups: z.array(z.string()).describe("Release groups swept this run"),
  downloadDir: z.string().describe("Container path everything was queued into"),
  found: z.number().describe(
    "Distinct releases credited to the groups on Nyaa",
  ),
  queued: z.number().describe("Torrents added to Transmission"),
  duplicates: z.number().describe("Already present in Transmission"),
  skipped: z.number().describe("Below the seeder floor"),
  seedForeverApplied: z.number().describe(
    "Torrents switched to unlimited ratio + idle seeding",
  ),
  queuedGB: z.number().describe("Disk the queued releases will occupy"),
  catalogGB: z.number().describe("Disk the groups' whole catalogue occupies"),
  searchErrors: z.array(z.string()),
  outcomes: z.array(z.object({
    title: z.string(),
    group: z.string(),
    infoHash: z.string(),
    seeders: z.number(),
    sizeGB: z.number(),
    status: z.enum(["queued", "duplicate", "skipped", "error"]),
    reason: z.string().optional(),
  })),
  timestamp: z.string(),
});

const DiskStatsSchema = z.object({
  totalBytes: z.number(),
  downloadedBytes: z.number(),
  remainingBytes: z.number(),
  totalGB: z.number(),
  downloadedGB: z.number(),
  remainingGB: z.number(),
  byStatus: z.record(
    z.string(),
    z.object({ count: z.number(), bytes: z.number() }),
  ),
  torrents: z.array(z.object({
    name: z.string(),
    status: z.string(),
    totalGB: z.number(),
    percentDone: z.number(),
  })),
  timestamp: z.string(),
});

const TX_STATUS: Record<number, string> = {
  0: "stopped",
  1: "check-pending",
  2: "checking",
  3: "download-pending",
  4: "downloading",
  5: "seed-pending",
  6: "seeding",
};

const GlobalArgsSchema = z.object({
  anilistUser: z.string().describe("AniList username"),
  maxCacheAgeDays: z.number().default(14).describe(
    "How stale the cached watch list may be before fetch-airing fails instead of falling back to it",
  ),
  anilistToken: z.string().meta({ sensitive: true }).optional().describe(
    "AniList personal access token — required for update-progress. Get at: https://anilist.co/settings/developer",
  ),
  transmissionRpcUrl: z.string().describe(
    "Transmission RPC URL (e.g. http://host:9091/transmission/rpc)",
  ),
  transmissionUser: z.string().describe("Transmission RPC username"),
  transmissionPass: z.string().meta({ sensitive: true }).describe(
    "Transmission RPC password",
  ),
  archiveContainerDir: z.string().default("/anime/kineko").describe(
    "Download dir for fetch-archive preservation rips, as the Transmission CONTAINER sees it (e.g. /anime/kineko) — not the host path it is bind-mounted from",
  ),
  animeContainerDir: z.string().default("/anime/tv").describe(
    "Download dir prefix INSIDE the Transmission container for anime (e.g. /anime/tv)",
  ),
  preferredResolution: z.number().default(1080).describe(
    "Preferred resolution: 720/1080/2160",
  ),
  telegramModel: z.string().default("").describe(
    "Swamp model name for Telegram send (@magistr/telegram-send instance). Set to empty string to disable notifications.",
  ),
});

/** Send a Telegram message via the installed tg-bot model instance. Fire-and-forget. */
async function sendTg(modelName: string, text: string): Promise<void> {
  if (!modelName) return;
  try {
    const input = JSON.stringify({ text, parseMode: "HTML" });
    const cmd = new Deno.Command("swamp", {
      args: ["model", "method", "run", modelName, "sendMessage", "--stdin"],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    await proc.output();
  } catch {
    // Non-fatal — don't break the main pipeline if TG fails
  }
}

/** Anime automation pipeline: fetch airing episodes, BD upgrades, AniList sync. */
export const model = {
  type: "@magistr/anime-cron",
  version: "2026.09.01.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    fetchResult: {
      description: "Outcome of fetch-airing: what was found and queued",
      schema: FetchResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    watchlist: {
      description:
        "Last CURRENT list successfully read from AniList, used to keep downloading while AniList is unreachable",
      schema: WatchlistCacheSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    markResult: {
      description:
        "Outcome of mark-watched: which episodes were synced to AniList",
      schema: MarkWatchedSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    upgradeResult: {
      description: "Outcome of upgrade-bd: which BD releases were queued",
      schema: UpgradeBdSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    archiveResult: {
      description:
        "Outcome of fetch-archive: which preservation-group releases were queued and set to seed forever",
      schema: ArchiveResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    diskStats: {
      description: "Disk usage summary for all anime torrents in Transmission",
      schema: DiskStatsSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    "seed-watchlist": {
      description:
        "Reconstruct the watch-list cache from the most recent fetch-airing result, so downloads can continue when AniList went down before any run had cached the real list. Airing times are INFERRED; the next successful AniList read replaces this.",
      arguments: z.object({
        force: z.boolean().default(false).describe(
          "Overwrite an existing cache. Refused by default so a real AniList capture is never replaced by an inferred one.",
        ),
      }),
      execute: async (
        args: { force: boolean },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
          readResource?: (name: string) => Promise<unknown>;
        },
      ) => {
        const { anilistUser } = context.globalArgs;
        const nowSec = Math.floor(Date.now() / 1000);

        const existing =
          await context.readResource?.("watchlist-current").catch(() => null) ??
            null;
        const ex = existing as z.infer<typeof WatchlistCacheSchema> | null;
        if (ex && Array.isArray(ex.entries) && ex.entries.length > 0) {
          // A real capture outranks anything reconstructed. Refusing keeps this
          // method safe to re-run without silently downgrading good data.
          if (!args.force) {
            throw new Error(
              `a watchlist cache already exists (${ex.entries.length} entries, captured ${ex.capturedAt}${
                ex.seeded ? ", seeded" : ", from AniList"
              }) — pass force:true to overwrite it`,
            );
          }
        }

        const prior =
          // readResource keys on the INSTANCE name, not the spec: fetch-airing
          // writes its result as instance "current".
          await context.readResource?.("current").catch(() => null) ?? null;
        const p = prior as
          | {
            timestamp?: string;
            outcomes?: Array<
              {
                mediaId: number;
                title: string;
                episode: number;
                status: string;
              }
            >;
          }
          | null;
        if (!p || !Array.isArray(p.outcomes) || p.outcomes.length === 0) {
          throw new Error(
            "no previous fetch-airing result to seed from — nothing records what was being watched",
          );
        }
        const capturedAtSec =
          p.timestamp && !Number.isNaN(Date.parse(p.timestamp))
            ? Math.floor(Date.parse(p.timestamp) / 1000)
            : nowSec;
        const entries = seedEntriesFromOutcomes(p.outcomes, capturedAtSec);
        if (entries.length === 0) {
          throw new Error("previous result contained no usable show outcomes");
        }
        const payload = {
          user: anilistUser,
          capturedAt: new Date(capturedAtSec * 1000).toISOString(),
          seeded: true,
          entries,
        };
        await context.writeResource("watchlist", "watchlist-current", payload);
        return {
          seeded: entries.length,
          capturedAt: payload.capturedAt,
          shows: entries.map((e) => `${e.romaji} @ep${e.progress}`),
        };
      },
    },
    "fetch-airing": {
      description:
        "Check AniList CURRENT list → search Nyaa for next episode of each airing show → add to Transmission. Skips episodes not yet aired.",
      arguments: z.object({
        dryRun: z.boolean().default(false).describe(
          "If true, find torrents but do not add to Transmission",
        ),
        skipUnaired: z.boolean().default(true).describe(
          "Skip shows where next episode has not aired yet (default: true)",
        ),
      }),
      execute: async (
        args: { dryRun: boolean; skipUnaired: boolean },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
          readResource?: (name: string) => Promise<unknown>;
        },
      ) => {
        const {
          anilistUser,
          maxCacheAgeDays,
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
          animeContainerDir,
          preferredResolution,
          telegramModel,
        } = context.globalArgs;

        const tg = telegramModel
          ? (text: string) => sendTg(telegramModel, text)
          : null;

        const nowSec = Math.floor(Date.now() / 1000);

        // AniList first; its list is authoritative when reachable.
        let watching: WatchEntry[];
        let listSource: "anilist" | "cache" = "anilist";
        let listAgeSeconds = 0;
        try {
          watching = await getCurrentList(anilistUser);
          await context.writeResource("watchlist", "watchlist-current", {
            user: anilistUser,
            capturedAt: new Date(nowSec * 1000).toISOString(),
            entries: watching,
          });
        } catch (err) {
          // Downloading does not need AniList reachable, only knowing WHAT is
          // watched — so fall back rather than losing the hour entirely.
          const cached =
            await context.readResource?.("watchlist-current").catch(() =>
              null
            ) ?? null;
          const c = cached as z.infer<typeof WatchlistCacheSchema> | null;
          if (!c || !Array.isArray(c.entries) || c.entries.length === 0) {
            throw err;
          }
          listAgeSeconds = cacheAgeSeconds(c.capturedAt, nowSec);
          // Past this the projection is guesswork: shows end, new ones start,
          // and silently downloading against a month-old list is worse than
          // failing loudly.
          if (listAgeSeconds > maxCacheAgeDays * 86400) throw err;
          watching = c.entries.map((e) => projectEntry(e, nowSec));
          listSource = "cache";
        }
        const outcomes: z.infer<typeof FetchResultSchema>["outcomes"] = [];
        let queued = 0, duplicates = 0, notFound = 0, skipped = 0;
        let alertsSuppressed = 0;

        // Pre-load Transmission torrent list once. Build a set of (title, episode)
        // pairs already present so we never re-queue an episode whose torrent was
        // removed before mark-watched could update AniList progress.
        const existingTorrents = args.dryRun ? [] : await txListTorrents(
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
        ).catch(() => []);
        // Normalize a show title for dedup: strip season markers so that
        // "Youjo Senki S2" and "Youjo Senki II" both collapse to "Youjo Senki".
        const normalizeTitle = (t: string): string => {
          let s = t.toLowerCase().replace(/\s+/g, " ").trim();
          // Strip ": subtitle" (e.g. "Koukaku Kidoutai: THE GHOST IN THE SHELL")
          s = s.replace(/\s*:.*$/, "");
          // Strip trailing parenthesized year (e.g. "Koukaku Kidoutai (2026)")
          s = s.replace(/\s*\(\d{4}\)\s*$/, "");
          s = s.replace(/\s+(?:ii|iii|iv|v|vi|vii|viii|ix|x)$/i, "");
          s = s.replace(
            /\s+(?:s\d+|\d+(?:st|nd|rd|th)?\s+season|season\s+\d+)$/i,
            "",
          );
          s = s.replace(/\s+\d+$/, "");
          return s.trim();
        };
        const existingKey = (title: string, ep: number) =>
          `${normalizeTitle(title)}::${ep}`;
        const existingSet = new Set(
          existingTorrents.map((t) => {
            const ep = parseEpisode(t.name);
            const show = extractShowTitle(t.name);
            return ep != null ? `${normalizeTitle(show)}::${ep}` : null;
          }).filter((k): k is string => k != null),
        );

        for (const entry of watching) {
          const startEp = entry.progress + 1;
          const title = entry.romaji || (entry.english ?? "");

          // Determine the last episode that has aired.
          // nextAiringEp is the NEXT episode to air → everything before it is already out.
          // If no nextAiringEp (finished airing), use total episode count.
          const lastAiredEp = entry.nextAiringEp != null
            ? entry.nextAiringEp - 1
            : (entry.episodes ?? startEp);

          // Skip if all episodes already downloaded
          if (entry.episodes != null && startEp > entry.episodes) {
            skipped++;
            outcomes.push({
              mediaId: entry.mediaId,
              title,
              episode: startEp,
              status: "skipped",
              reason: "all-eps-downloaded",
            });
            continue;
          }

          // Skip if next episode hasn't aired yet
          if (args.skipUnaired && lastAiredEp < startEp) {
            skipped++;
            const hoursUntil = entry.nextAiringAt != null
              ? Math.round((entry.nextAiringAt - nowSec) / 3600)
              : null;
            outcomes.push({
              mediaId: entry.mediaId,
              title,
              episode: startEp,
              status: "skipped",
              reason: hoursUntil != null
                ? `airs-in-${hoursUntil}h`
                : "not-aired",
            });
            continue;
          }

          // Search Nyaa once per show — romaji → english → synonyms → base title
          // Fetch enough results to cover all pending episodes.
          let hits: NyaaHit[] = [];
          try {
            hits = await nyaaSearch(title);
            const needsEp = (ep: number) => !hits.some((h) => h.episode === ep);
            if (needsEp(startEp) && entry.english && entry.english !== title) {
              hits = [...hits, ...await nyaaSearch(entry.english)];
            }
            if (needsEp(startEp)) {
              for (const syn of entry.synonyms) {
                if (syn === title || syn === entry.english) continue;
                const synHits = await nyaaSearch(syn);
                hits = [...hits, ...synHits];
                if (!needsEp(startEp)) break;
              }
            }
            if (needsEp(startEp)) {
              const base = baseTitle(title);
              if (base) hits = [...hits, ...await nyaaSearch(base)];
            }
          } catch {
            outcomes.push({
              mediaId: entry.mediaId,
              title,
              episode: startEp,
              status: "error",
              reason: "nyaa-fetch-failed",
            });
            continue;
          }

          const folderName = toFolderName(entry.romaji || title);
          const downloadDir = `${
            animeContainerDir.replace(/\/$/, "")
          }/${folderName}`;

          // Queue each available episode from startEp up to lastAiredEp
          for (let ep = startEp; ep <= lastAiredEp; ep++) {
            // Name-based dedup: catch re-downloads when a torrent was removed from
            // Transmission before mark-watched updated AniList progress.
            const showKey = existingKey(entry.romaji || title, ep);
            if (existingSet.has(showKey)) {
              duplicates++;
              outcomes.push({
                mediaId: entry.mediaId,
                title,
                episode: ep,
                status: "duplicate",
              });
              continue;
            }

            const pick = pickBest(hits, ep, preferredResolution);
            if (!pick) {
              notFound++;
              outcomes.push({
                mediaId: entry.mediaId,
                title,
                episode: ep,
                status: "not-found",
              });

              // Alert if episode has been aired for more than 30 minutes.
              // For the most recently aired ep, estimate air time from nextAiringAt minus one week.
              // For older backlogged eps, they're always overdue.
              const GRACE_SECS = 30 * 60;
              const WEEK_SECS = 7 * 24 * 3600;
              let airedAtSec: number | null = null;
              if (entry.nextAiringEp != null && entry.nextAiringAt != null) {
                const epsBehind = entry.nextAiringEp - ep;
                airedAtSec = entry.nextAiringAt - epsBehind * WEEK_SECS;
              }
              const isOverdue = airedAtSec == null ||
                (nowSec - airedAtSec) > GRACE_SECS;
              // An INFERRED airing time must never drive an alert. When the
              // watch list came from the cache, nextAiringAt is either the
              // capture instant (a seeded list, which knows no real schedule)
              // or a weekly projection from one — so `airedAtSec` measures the
              // age of the CACHE, not of the episode. Left ungated this fires
              // for every show on every run: a seeded list produced identical
              // "Aired 298min ago" alerts hourly across 13 shows, 298min being
              // simply how old the seed was.
              //
              // The not-found outcome is still recorded either way, so the run
              // report shows exactly what was missing; only the page is held
              // back until AniList is answering and the times are real again.
              const airingTimeIsReal = listSource === "anilist";
              if (isOverdue && !airingTimeIsReal) alertsSuppressed++;
              if (tg && isOverdue && airingTimeIsReal) {
                const agoMin = airedAtSec
                  ? Math.round((nowSec - airedAtSec) / 60)
                  : null;
                await tg(
                  `<b>${title} ep${ep} not found</b>\n` +
                    `Aired ${
                      agoMin != null ? `${agoMin}min ago` : "earlier"
                    } — not yet on Nyaa`,
                );
              }
              continue;
            }

            if (args.dryRun) {
              queued++;
              outcomes.push({
                mediaId: entry.mediaId,
                title,
                episode: ep,
                status: "queued",
                torrentName: pick.title,
                reason: "dry-run",
              });
              continue;
            }

            try {
              const result = await txAdd(
                transmissionRpcUrl,
                transmissionUser,
                transmissionPass,
                pick.viewUrl,
                downloadDir,
              );
              if (result.duplicate) {
                duplicates++;
                outcomes.push({
                  mediaId: entry.mediaId,
                  title,
                  episode: ep,
                  status: "duplicate",
                  torrentName: result.name ?? pick.title,
                });
              } else if (result.added) {
                queued++;
                existingSet.add(showKey);
                outcomes.push({
                  mediaId: entry.mediaId,
                  title,
                  episode: ep,
                  status: "queued",
                  torrentName: result.name ?? pick.title,
                });
                if (tg) {
                  await tg(
                    `<b>${title} ep${ep} queued</b>\n<code>${
                      (result.name ?? pick.title).slice(0, 120)
                    }</code>`,
                  );
                }
              } else {
                outcomes.push({
                  mediaId: entry.mediaId,
                  title,
                  episode: ep,
                  status: "error",
                  reason: "transmission-add-failed",
                });
              }
            } catch (e) {
              outcomes.push({
                mediaId: entry.mediaId,
                title,
                episode: ep,
                status: "error",
                reason: (e as Error).message.slice(0, 100),
              });
            }
          }
        }

        const handle = await context.writeResource("fetchResult", "current", {
          listSource,
          alertsSuppressed,
          listAgeSeconds,
          checked: watching.length,
          skipped,
          queued,
          duplicates,
          notFound,
          outcomes,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "mark-watched": {
      description:
        "Check recently completed anime torrents in Transmission → update AniList progress. Requires anilistToken in globalArguments.",
      arguments: z.object({
        sinceHours: z.number().default(25).describe(
          "Window for 'recently completed' torrents in hours (default: 25 to safely cover daily runs)",
        ),
        dryRun: z.boolean().default(false).describe(
          "Find completed torrents and AniList matches but do not mutate AniList",
        ),
      }),
      execute: async (
        args: { sinceHours: number; dryRun: boolean },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const {
          anilistToken,
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
          animeContainerDir,
        } = context.globalArgs;

        if (!anilistToken && !args.dryRun) {
          throw new Error(
            "anilistToken is required for mark-watched. Add your AniList personal access token to globalArguments.",
          );
        }

        const torrents = await txListTorrents(
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
        );
        const nowSec = Math.floor(Date.now() / 1000);
        const windowSec = args.sinceHours * 3600;
        const animeDirPrefix = animeContainerDir.replace(/\/$/, "");

        const recentDone = torrents.filter(
          (t) =>
            t.isFinished &&
            t.doneDate > 0 &&
            nowSec - t.doneDate < windowSec &&
            t.downloadDir.startsWith(animeDirPrefix),
        );

        const outcomes: z.infer<typeof MarkWatchedSchema>["outcomes"] = [];
        let updated = 0, failed = 0;

        for (const torrent of recentDone) {
          const showTitle = extractShowTitle(torrent.name);
          const episode = parseEpisode(torrent.name);

          if (!episode) {
            outcomes.push({
              torrentName: torrent.name,
              showTitle,
              episode: null,
              anilistId: null,
              updated: false,
              reason: "could-not-parse-episode",
            });
            continue;
          }

          // Search AniList for the show to get mediaId
          let anilistId: number | null = null;
          try {
            const searchQuery = `
              query ($search: String!) {
                Media(search: $search, type: ANIME) { id title { romaji english } }
              }`;
            const data = await gqlRequest(searchQuery, { search: showTitle });
            anilistId = (data.Media as { id: number } | null)?.id ?? null;
          } catch {
            // AniList search failed — continue without update
          }

          if (!anilistId) {
            outcomes.push({
              torrentName: torrent.name,
              showTitle,
              episode,
              anilistId: null,
              updated: false,
              reason: "anilist-not-found",
            });
            failed++;
            continue;
          }

          if (args.dryRun) {
            outcomes.push({
              torrentName: torrent.name,
              showTitle,
              episode,
              anilistId,
              updated: false,
              reason: "dry-run",
            });
            continue;
          }

          try {
            await gqlRequest(
              UPDATE_PROGRESS_MUTATION,
              { mediaId: anilistId, progress: episode },
              anilistToken,
            );
            updated++;
            outcomes.push({
              torrentName: torrent.name,
              showTitle,
              episode,
              anilistId,
              updated: true,
            });
          } catch (e) {
            failed++;
            outcomes.push({
              torrentName: torrent.name,
              showTitle,
              episode,
              anilistId,
              updated: false,
              reason: (e as Error).message.slice(0, 100),
            });
          }
        }

        const handle = await context.writeResource("markResult", "current", {
          checked: recentDone.length,
          updated,
          failed,
          outcomes,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "upgrade-bd": {
      description:
        "Check AniList COMPLETED list against SeaDex → queue BD release downloads for shows that have a 'best' release but are not yet upgraded. Safe to run repeatedly — Transmission deduplicates.",
      arguments: z.object({
        minScore: z.number().default(70).describe(
          "Minimum AniList average score to consider for BD upgrade (0 = all)",
        ),
        dryRun: z.boolean().default(false).describe(
          "Find BD releases but do not add to Transmission",
        ),
        libraryEntries: z.array(z.object({
          anilistId: z.number(),
          releaseGroup: z.string().nullable(),
        })).optional().default([]).describe(
          "Per-show library entries from anime-library.scan — used to skip shows already on disk as the SeaDex best release. Pass data.latest('anime-library','current').attributes.entries.",
        ),
      }),
      execute: async (
        args: {
          minScore: number;
          dryRun: boolean;
          libraryEntries: Array<
            { anilistId: number; releaseGroup: string | null }
          >;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const {
          anilistUser,
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
          animeContainerDir,
        } = context.globalArgs;

        // Get COMPLETED list
        const data = await gqlRequest(COMPLETED_QUERY, {
          userName: anilistUser,
        });
        const collection = data.MediaListCollection as {
          lists: Array<{
            entries: Array<{
              progress: number;
              media: {
                id: number;
                title: { romaji: string | null; english: string | null };
                averageScore: number | null;
              };
            }>;
          }>;
        };

        const completed = (collection.lists ?? []).flatMap((l) =>
          l.entries
            .filter(
              (e) =>
                args.minScore === 0 ||
                (e.media.averageScore ?? 0) >= args.minScore,
            )
            .map((e) => ({
              mediaId: e.media.id,
              romaji: e.media.title.romaji ?? "",
              english: e.media.title.english,
              score: e.media.averageScore ?? 0,
            }))
        );

        const outcomes: z.infer<typeof UpgradeBdSchema>["outcomes"] = [];
        const libraryMap = new Map<number, string | null>(
          (args.libraryEntries ?? []).map((e) => [e.anilistId, e.releaseGroup]),
        );
        let queued = 0, notInSeadex = 0, skippedOnDisk = 0;

        for (const show of completed) {
          const trs = await seadexLookup(show.mediaId);
          if (!trs || !trs.length) {
            notInSeadex++;
            outcomes.push({
              mediaId: show.mediaId,
              title: show.romaji || (show.english ?? ""),
              status: "not-in-seadex",
            });
            continue;
          }

          // Prefer isBest=true entries on nyaa tracker
          const best = trs.find((t) => t.isBest && t.tracker === "nyaa") ??
            trs.find((t) => t.isBest) ??
            trs[0];

          if (!best?.infoHash) {
            outcomes.push({
              mediaId: show.mediaId,
              title: show.romaji || (show.english ?? ""),
              status: "no-best",
            });
            continue;
          }

          // Skip if library already has this show with the SeaDex-recommended release group
          if (libraryMap.has(show.mediaId)) {
            const libraryGroup = libraryMap.get(show.mediaId) ?? null;
            const seadexGroup = best.releaseGroup?.toLowerCase() ?? null;
            if (libraryGroup && seadexGroup && libraryGroup === seadexGroup) {
              skippedOnDisk++;
              outcomes.push({
                mediaId: show.mediaId,
                title: show.romaji || (show.english ?? ""),
                status: "on-disk",
                releaseGroup: best.releaseGroup,
              });
              continue;
            }
            // Library has a different release group → fall through to queue BD upgrade
          }

          const folderName = toFolderName(show.romaji || (show.english ?? ""));
          const downloadDir = `${
            animeContainerDir.replace(/\/$/, "")
          }/${folderName}`;
          const magnet = `magnet:?xt=urn:btih:${best.infoHash.toLowerCase()}` +
            `&dn=${encodeURIComponent(show.romaji || (show.english ?? ""))}` +
            `&tr=${encodeURIComponent("http://nyaa.tracker.wf:7777/announce")}`;

          if (args.dryRun) {
            queued++;
            outcomes.push({
              mediaId: show.mediaId,
              title: show.romaji || (show.english ?? ""),
              status: "queued",
              releaseGroup: best.releaseGroup,
              reason: "dry-run",
            });
            continue;
          }

          try {
            const result = await txAdd(
              transmissionRpcUrl,
              transmissionUser,
              transmissionPass,
              magnet,
              downloadDir,
            );
            if (result.duplicate) {
              outcomes.push({
                mediaId: show.mediaId,
                title: show.romaji || (show.english ?? ""),
                status: "duplicate",
                releaseGroup: best.releaseGroup,
              });
            } else if (result.added) {
              queued++;
              outcomes.push({
                mediaId: show.mediaId,
                title: show.romaji || (show.english ?? ""),
                status: "queued",
                releaseGroup: best.releaseGroup,
              });
            } else {
              outcomes.push({
                mediaId: show.mediaId,
                title: show.romaji || (show.english ?? ""),
                status: "error",
                reason: "transmission-add-failed",
              });
            }
          } catch (e) {
            outcomes.push({
              mediaId: show.mediaId,
              title: show.romaji || (show.english ?? ""),
              status: "error",
              reason: (e as Error).message.slice(0, 100),
            });
          }
        }

        const handle = await context.writeResource("upgradeResult", "current", {
          checked: completed.length,
          queued,
          skippedOnDisk,
          notInSeadex,
          outcomes,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "fetch-archive": {
      description:
        "Sweep Nyaa for every release credited to a set of preservation groups (default Kineko Video + LonelyChaser), queue them into the archive dir, and switch them to unlimited ratio/idle seeding so they seed forever. Idempotent: releases already in Transmission are reported as duplicates, and the seed-forever setting is re-applied to everything already in the archive dir.",
      arguments: z.object({
        groups: z.array(z.string()).default(["Kineko Video", "LonelyChaser"])
          .describe(
            "Release-group names matched against the leading [..] credit in each torrent title. Suffixed aliases (LonelyChaser-Raws) and collabs ([LonelyChaser & Kineko Video]) both match.",
          ),
        category: z.string().default("0_0").describe(
          "Nyaa category filter. Default 0_0 (all) — these groups also post live-action scans outside the anime categories.",
        ),
        maxPages: z.number().default(10).describe(
          "Max Nyaa RSS pages per group (75 releases per page)",
        ),
        minSeeders: z.number().default(1).describe(
          "Skip releases with fewer seeders than this (0 = take dead torrents too)",
        ),
        seedForeverExisting: z.boolean().default(true).describe(
          "Also apply unlimited seeding to torrents already in the archive dir",
        ),
        dryRun: z.boolean().default(false).describe(
          "Resolve what would be queued but do not touch Transmission",
        ),
      }),
      execute: async (
        args: {
          groups: string[];
          category: string;
          maxPages: number;
          minSeeders: number;
          seedForeverExisting: boolean;
          dryRun: boolean;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const {
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
          archiveContainerDir,
          telegramModel,
        } = context.globalArgs;

        const downloadDir = archiveContainerDir.replace(/\/$/, "");
        const groups = args.groups.filter((g) => g.trim().length > 0);
        if (!groups.length) {
          throw new Error("fetch-archive needs at least one group");
        }

        // Discover: one paged search per group, then keep only titles that
        // actually credit a wanted group — a plain text search also matches
        // releases that merely mention the name in the description.
        const byHash = new Map<string, { hit: NyaaHit; group: string }>();
        const searchErrors: string[] = [];
        for (const g of groups) {
          let hits: NyaaHit[];
          try {
            hits = await nyaaSearchPaged(g, args.category, args.maxPages);
          } catch (e) {
            searchErrors.push(`${g}: ${(e as Error).message.slice(0, 120)}`);
            continue;
          }
          for (const hit of hits) {
            const credited = creditsGroup(hit.title, groups);
            // Collabs surface under both group searches — first hash wins.
            if (credited && !byHash.has(hit.infoHash)) {
              byHash.set(hit.infoHash, { hit, group: credited });
            }
          }
        }

        // Read Transmission state before mutating anything.
        const existing = await txListTorrents(
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
        );
        const existingHashes = new Set(
          existing.map((t) => t.hashString.toLowerCase()),
        );
        const inArchiveDir = existing.filter(
          (t) => t.downloadDir.replace(/\/$/, "") === downloadDir,
        );

        const outcomes: z.infer<typeof ArchiveResultSchema>["outcomes"] = [];
        const touchedIds = new Set<number>();
        let queued = 0, duplicates = 0, skipped = 0;
        let queuedBytes = 0, catalogBytes = 0;
        const gb = (b: number) => Math.round((b / 1024 ** 3) * 100) / 100;

        for (const { hit, group } of byHash.values()) {
          catalogBytes += hit.sizeBytes;
          const base = {
            title: decodeEntities(hit.title),
            group,
            infoHash: hit.infoHash,
            seeders: hit.seeders,
            sizeGB: gb(hit.sizeBytes),
          };

          if (hit.seeders < args.minSeeders) {
            skipped++;
            outcomes.push({
              ...base,
              status: "skipped",
              reason: `seeders-${hit.seeders}`,
            });
            continue;
          }
          if (existingHashes.has(hit.infoHash)) {
            duplicates++;
            outcomes.push({ ...base, status: "duplicate" });
            continue;
          }
          if (args.dryRun) {
            queued++;
            queuedBytes += hit.sizeBytes;
            outcomes.push({ ...base, status: "queued", reason: "dry-run" });
            continue;
          }

          try {
            const result = await txAdd(
              transmissionRpcUrl,
              transmissionUser,
              transmissionPass,
              hit.viewUrl,
              downloadDir,
            );
            if (result.id != null) touchedIds.add(result.id);
            if (result.duplicate) {
              duplicates++;
              outcomes.push({ ...base, status: "duplicate" });
            } else if (result.added) {
              queued++;
              queuedBytes += hit.sizeBytes;
              existingHashes.add(hit.infoHash);
              outcomes.push({ ...base, status: "queued" });
            } else {
              outcomes.push({
                ...base,
                status: "error",
                reason: "transmission-add-failed",
              });
            }
          } catch (e) {
            outcomes.push({
              ...base,
              status: "error",
              reason: (e as Error).message.slice(0, 100),
            });
          }
        }

        // Seed forever: everything just added, plus (by default) everything
        // already parked in the archive dir from earlier runs.
        let seedForeverApplied = 0;
        if (!args.dryRun) {
          if (args.seedForeverExisting) {
            for (const t of inArchiveDir) touchedIds.add(t.id);
          }
          if (touchedIds.size) {
            await txSeedForever(
              transmissionRpcUrl,
              transmissionUser,
              transmissionPass,
              [...touchedIds],
            );
            seedForeverApplied = touchedIds.size;
          }
        }

        if (telegramModel && !args.dryRun && queued > 0) {
          // Telegram caps a message at 4096 chars — list what was snatched but
          // keep the tail bounded so a large first sweep still delivers.
          const LIST_CAP = 20;
          const snatched = outcomes.filter((o) => o.status === "queued");
          const listed = snatched.slice(0, LIST_CAP).map((o) =>
            `• <code>${
              escapeHtml(o.title).slice(0, 110)
            }</code> — ${o.sizeGB} GB`
          );
          const overflow = snatched.length - listed.length;
          await sendTg(
            telegramModel,
            `<b>Archive sweep queued ${queued} release${
              queued === 1 ? "" : "s"
            }</b>\n` +
              `${groups.join(", ")} → <code>${downloadDir}</code>\n` +
              `${gb(queuedBytes)} GB incoming, ${duplicates} already held, ` +
              `${seedForeverApplied} seeding unlimited\n\n` +
              listed.join("\n") +
              (overflow > 0 ? `\n… and ${overflow} more` : ""),
          );
        }

        const handle = await context.writeResource("archiveResult", "current", {
          groups,
          downloadDir,
          found: byHash.size,
          queued,
          duplicates,
          skipped,
          seedForeverApplied,
          queuedGB: gb(queuedBytes),
          catalogGB: gb(catalogBytes),
          searchErrors,
          outcomes,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "disk-stats": {
      description:
        "Query Transmission for all anime torrents and return total/downloaded/remaining disk usage grouped by status.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const {
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
          animeContainerDir,
        } = context.globalArgs;

        const allTorrents = await txListTorrents(
          transmissionRpcUrl,
          transmissionUser,
          transmissionPass,
        );

        const animeDirPrefix = animeContainerDir.replace(/\/$/, "");
        const torrents = allTorrents.filter((t) =>
          t.downloadDir.startsWith(animeDirPrefix)
        );

        const byStatus: Record<string, { count: number; bytes: number }> = {};
        let totalBytes = 0;
        let downloadedBytes = 0;

        const torrentList: z.infer<typeof DiskStatsSchema>["torrents"] = [];

        for (const t of torrents) {
          const statusLabel = TX_STATUS[t.status] ?? `status-${t.status}`;
          if (!byStatus[statusLabel]) {
            byStatus[statusLabel] = { count: 0, bytes: 0 };
          }
          byStatus[statusLabel].count++;
          byStatus[statusLabel].bytes += t.totalSize;
          totalBytes += t.totalSize;
          downloadedBytes += Math.floor(t.totalSize * t.percentDone);
          torrentList.push({
            name: t.name,
            status: statusLabel,
            totalGB: Math.round((t.totalSize / 1024 ** 3) * 100) / 100,
            percentDone: Math.round(t.percentDone * 1000) / 10,
          });
        }

        const remainingBytes = totalBytes - downloadedBytes;
        const gb = (b: number) => Math.round((b / 1024 ** 3) * 100) / 100;

        const handle = await context.writeResource("diskStats", "current", {
          totalBytes,
          downloadedBytes,
          remainingBytes,
          totalGB: gb(totalBytes),
          downloadedGB: gb(downloadedBytes),
          remainingGB: gb(remainingBytes),
          byStatus,
          torrents: torrentList,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
