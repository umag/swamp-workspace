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
  "judas": 6,
};

export function parseResolution(title: string): number {
  if (/4k|2160p/i.test(title)) return 2160;
  if (/1080p/i.test(title)) return 1080;
  if (/720p/i.test(title)) return 720;
  return 0;
}

export function groupScore(title: string): number {
  const m = title.toLowerCase().match(/^\[([^\]]+)\]/);
  return PREFERRED_GROUPS[m?.[1] ?? ""] ?? 1;
}

export function buildMagnet(infoHash: string, title: string): string {
  return (
    `magnet:?xt=urn:btih:${infoHash}` +
    `&dn=${encodeURIComponent(title)}` +
    `&tr=${encodeURIComponent("http://nyaa.tracker.wf:7777/announce")}`
  );
}

export interface NyaaHit {
  title: string;
  viewUrl: string;
  magnet: string;
  infoHash: string;
  seeders: number;
  episode: number | null;
  resolution: number;
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

export function pickBest(
  hits: NyaaHit[],
  episode: number,
  targetRes = 1080,
): NyaaHit | null {
  const matching = hits.filter((h) => h.episode === episode);
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
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    fetchResult: {
      description: "Outcome of fetch-airing: what was found and queued",
      schema: FetchResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
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
    diskStats: {
      description: "Disk usage summary for all anime torrents in Transmission",
      schema: DiskStatsSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
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
        },
      ) => {
        const {
          anilistUser,
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

        const watching = await getCurrentList(anilistUser);
        const nowSec = Math.floor(Date.now() / 1000);
        const outcomes: z.infer<typeof FetchResultSchema>["outcomes"] = [];
        let queued = 0, duplicates = 0, notFound = 0, skipped = 0;

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
              if (tg && isOverdue) {
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
