import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Seanime base URL (e.g. http://203.0.113.10:3211)",
  ),
  token: z.string().optional().describe(
    "Server password hash for X-Seanime-Token header",
  ),
});

const StatusSchema = z.object({
  os: z.string().optional(),
  user: z.object({}).passthrough().optional(),
  settings: z.object({}).passthrough().optional(),
  version: z.string().optional(),
  themeSettings: z.object({}).passthrough().optional(),
  isOffline: z.boolean().optional(),
}).passthrough();

const AnimeEntrySchema = z.object({
  mediaId: z.number(),
  media: z.object({}).passthrough().optional(),
  listData: z.object({}).passthrough().optional(),
  libraryData: z.object({}).passthrough().optional(),
  currentEpisodeCount: z.number().optional(),
}).passthrough();

const CollectionSchema = z.object({
  lists: z.array(
    z.object({
      type: z.string().optional(),
      status: z.string().optional(),
      entries: z.array(AnimeEntrySchema).optional(),
    }).passthrough(),
  ).optional(),
  continueWatchingList: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

const MissingEpisodeSchema = z.object({
  episodes: z.array(
    z.object({
      episodeNumber: z.number().optional(),
      aniDBEpisode: z.string().optional(),
    }).passthrough(),
  ).optional(),
}).passthrough();

const TorrentSchema = z.object({
  name: z.string().optional(),
  hash: z.string().optional(),
  status: z.string().optional(),
  progress: z.number().optional(),
  contentPath: z.string().optional(),
}).passthrough();

const TorrentListSchema = z.object({
  torrents: z.array(TorrentSchema),
  timestamp: z.iso.datetime(),
});

const ScanResultSchema = z.object({
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const AutoDownloaderResultSchema = z.object({
  success: z.boolean(),
  timestamp: z.iso.datetime(),
});

const RuleSyncResultSchema = z.object({
  created: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    destination: z.string(),
  })),
  skipped: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    reason: z.string(),
  })),
  failed: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    error: z.string(),
  })),
  timestamp: z.iso.datetime(),
});

const StatusChangeResultSchema = z.object({
  updated: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    fromStatus: z.string(),
    toStatus: z.string(),
  })),
  skipped: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    reason: z.string(),
  })),
  failed: z.array(z.object({
    mediaId: z.number(),
    title: z.string(),
    error: z.string(),
  })),
  timestamp: z.iso.datetime(),
});

async function seanimeRequest(
  baseUrl: string,
  path: string,
  token?: string,
  method = "GET",
  body?: unknown,
) {
  const url = `${baseUrl}/api/v1${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["X-Seanime-Token"] = token;

  const opts: RequestInit = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Seanime API ${method} ${path} returned ${resp.status}: ${text}`,
    );
  }
  const json = await resp.json();
  return json.data !== undefined ? json.data : json;
}

/**
 * Seanime self-hosted anime server model — wraps the `/api/v1` REST surface for
 * library, AniList collection, search/downloads, and playback automation.
 */
export const model = {
  type: "@magistr/seanime",
  version: "2026.05.25.1",
  upgrades: [
    {
      fromVersion: "2026.04.05.1",
      toVersion: "2026.04.05.2",
      description: "Add sync-planning-rules method and ruleSyncResult resource",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Server status",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    collection: {
      description: "Anime library collection",
      schema: CollectionSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    missingEpisodes: {
      description: "Missing episodes in library",
      schema: MissingEpisodeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    torrents: {
      description: "Active torrent list",
      schema: TorrentListSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    scanResult: {
      description: "Library scan result",
      schema: ScanResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    autoDownloaderResult: {
      description: "Auto-downloader run result",
      schema: AutoDownloaderResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    ruleSyncResult: {
      description: "Result of syncing planning list to auto-downloader rules",
      schema: RuleSyncResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    statusChangeResult: {
      description: "Result of bulk AniList status change",
      schema: StatusChangeResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description: "Get server status, version, and user info",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const data = await seanimeRequest(
          context.globalArgs.baseUrl,
          "/status",
          context.globalArgs.token,
        );
        const handle = await context.writeResource("status", "current", data);
        return { dataHandles: [handle] };
      },
    },
    "library-collection": {
      description: "Get anime library collection with watch status",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const data = await seanimeRequest(
          context.globalArgs.baseUrl,
          "/library/collection",
          context.globalArgs.token,
        );
        const handle = await context.writeResource(
          "collection",
          "current",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "missing-episodes": {
      description: "Get missing episodes across library",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const data = await seanimeRequest(
          context.globalArgs.baseUrl,
          "/library/missing-episodes",
          context.globalArgs.token,
        );
        const handle = await context.writeResource(
          "missingEpisodes",
          "current",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    "library-scan": {
      description: "Trigger a library scan",
      arguments: z.object({
        enhanced: z.boolean().default(false).describe("Run enhanced scan"),
      }),
      execute: async (args, context) => {
        await seanimeRequest(
          context.globalArgs.baseUrl,
          "/library/scan",
          context.globalArgs.token,
          "POST",
          { enhanced: args.enhanced },
        );
        const handle = await context.writeResource("scanResult", "result", {
          success: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    "torrent-list": {
      description: "List active torrents from torrent client",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const data = await seanimeRequest(
          context.globalArgs.baseUrl,
          "/torrent-client/list",
          context.globalArgs.token,
        );
        const torrents = Array.isArray(data) ? data : (data?.torrents ?? []);
        const handle = await context.writeResource("torrents", "current", {
          torrents,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    "auto-download": {
      description: "Run the auto-downloader to fetch new episodes",
      arguments: z.object({}),
      execute: async (_args, context) => {
        await seanimeRequest(
          context.globalArgs.baseUrl,
          "/auto-downloader/run",
          context.globalArgs.token,
          "POST",
        );
        const handle = await context.writeResource(
          "autoDownloaderResult",
          "result",
          {
            success: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "sync-planning-rules": {
      description:
        "Create auto-downloader rules for all PLANNING list anime that are RELEASING or NOT_YET_RELEASED",
      arguments: z.object({
        libraryPath: z.string().default("/anime/tv").describe(
          "Base library path for download destinations",
        ),
        releaseGroups: z.array(z.string()).default([
          "SubsPlease",
          "Judas",
          "Erai-raws",
        ]).describe("Preferred release groups"),
        resolutions: z.array(z.string()).default(["1080p"]).describe(
          "Preferred resolutions",
        ),
        includeFinished: z.boolean().default(false).describe(
          "Also create rules for FINISHED anime in planning list",
        ),
      }),
      execute: async (args, context) => {
        const { baseUrl, token } = context.globalArgs;

        // Get AniList collection
        const collection = await seanimeRequest(
          baseUrl,
          "/anilist/collection",
          token,
        );
        const lists = collection?.MediaListCollection?.lists ??
          collection?.lists ?? [];
        const planningList = lists.find((l: { status?: string }) =>
          l.status === "PLANNING"
        );
        if (!planningList?.entries?.length) {
          throw new Error("No anime found in PLANNING list");
        }

        // Get existing rules
        const existingRules = await seanimeRequest(
          baseUrl,
          "/auto-downloader/rules",
          token,
        );
        const existingMediaIds = new Set(
          (Array.isArray(existingRules) ? existingRules : []).map((
            r: { mediaId: number },
          ) => r.mediaId),
        );

        // Filter to eligible anime
        const validStatuses = new Set(["RELEASING", "NOT_YET_RELEASED"]);
        if (args.includeFinished) validStatuses.add("FINISHED");

        const created: {
          mediaId: number;
          title: string;
          destination: string;
        }[] = [];
        const skipped: { mediaId: number; title: string; reason: string }[] =
          [];
        const failed: { mediaId: number; title: string; error: string }[] = [];

        for (const entry of planningList.entries) {
          const media = entry.media;
          const mediaId = media?.id;
          const title = media?.title?.romaji || media?.title?.english ||
            media?.title?.userPreferred || "Unknown";
          const status = media?.status;

          if (!mediaId) continue;

          if (existingMediaIds.has(mediaId)) {
            skipped.push({ mediaId, title, reason: "rule already exists" });
            continue;
          }
          if (!status || !validStatuses.has(status)) {
            skipped.push({
              mediaId,
              title,
              reason: `status is ${status || "unknown"}`,
            });
            continue;
          }

          const destination = `${args.libraryPath}/${
            title.replace(/[/:*?"<>|]/g, "")
          }`;
          try {
            await seanimeRequest(
              baseUrl,
              "/auto-downloader/rule",
              token,
              "POST",
              {
                rule: {
                  enabled: true,
                  mediaId,
                  destination,
                  releaseGroups: args.releaseGroups,
                  resolutions: args.resolutions,
                  episodeType: "recent",
                  comparisonTitle: title,
                  titleComparisonType: "likely",
                  additionalTerms: [],
                  excludeTerms: [],
                  minSeeders: 0,
                  minSize: "",
                  maxSize: "",
                },
              },
            );
            created.push({ mediaId, title, destination });
          } catch (err) {
            failed.push({ mediaId, title, error: String(err) });
          }
        }

        const handle = await context.writeResource("ruleSyncResult", "result", {
          created,
          skipped,
          failed,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    "set-planning-watching": {
      description:
        "Move PLANNING anime that are RELEASING or NOT_YET_RELEASED to CURRENT (watching) on AniList",
      arguments: z.object({
        includeFinished: z.boolean().default(false).describe(
          "Also move FINISHED anime to watching",
        ),
      }),
      execute: async (args, context) => {
        const { baseUrl, token } = context.globalArgs;

        const collection = await seanimeRequest(
          baseUrl,
          "/anilist/collection",
          token,
        );
        const lists = collection?.MediaListCollection?.lists ??
          collection?.lists ?? [];
        const planningList = lists.find((l: { status?: string }) =>
          l.status === "PLANNING"
        );
        if (!planningList?.entries?.length) {
          throw new Error("No anime found in PLANNING list");
        }

        const validStatuses = new Set(["RELEASING", "NOT_YET_RELEASED"]);
        if (args.includeFinished) validStatuses.add("FINISHED");

        const updated: {
          mediaId: number;
          title: string;
          fromStatus: string;
          toStatus: string;
        }[] = [];
        const skipped: { mediaId: number; title: string; reason: string }[] =
          [];
        const failed: { mediaId: number; title: string; error: string }[] = [];

        for (const entry of planningList.entries) {
          const media = entry.media;
          const mediaId = media?.id;
          const title = media?.title?.romaji || media?.title?.english ||
            media?.title?.userPreferred || "Unknown";
          const airingStatus = media?.status;

          if (!mediaId) continue;

          if (!airingStatus || !validStatuses.has(airingStatus)) {
            skipped.push({
              mediaId,
              title,
              reason: `airing status is ${airingStatus || "unknown"}`,
            });
            continue;
          }

          try {
            await seanimeRequest(
              baseUrl,
              "/anilist/list-entry",
              token,
              "POST",
              {
                mediaId,
                status: "CURRENT",
                score: 0,
                progress: 0,
              },
            );
            updated.push({
              mediaId,
              title,
              fromStatus: "PLANNING",
              toStatus: "CURRENT",
            });
          } catch (err) {
            failed.push({ mediaId, title, error: String(err) });
          }
        }

        const handle = await context.writeResource(
          "statusChangeResult",
          "result",
          {
            updated,
            skipped,
            failed,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
