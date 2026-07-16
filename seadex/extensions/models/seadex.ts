import { z } from "npm:zod@4";

// SeaDex (releases.moe) — community-curated index of "best" anime releases.
// Backend is Pocketbase exposed at https://releases.moe/api/collections/<collection>/records.
// See https://releases.moe/about/

const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .default("https://releases.moe")
    .describe("SeaDex root URL (default: https://releases.moe)"),
  userAgent: z
    .string()
    .default("swamp-seadex/1.0")
    .describe("User-Agent string sent on requests"),
});

// --- raw API shapes ---

interface SeadexFile {
  name: string;
  length: number;
}

interface SeadexTorrent {
  id: string;
  releaseGroup: string;
  tracker: string;
  url: string;
  infoHash: string;
  isBest: boolean;
  dualAudio: boolean;
  tags: string[];
  files: SeadexFile[];
}

interface SeadexEntry {
  id: string;
  alID: number;
  notes: string;
  theoreticalBest: string;
  comparison: string;
  incomplete: boolean;
  trs: string[];
  expand?: { trs?: SeadexTorrent[] };
}

// --- helpers ---

async function fetchJson<T>(url: string, ua: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { "User-Agent": ua, "Accept": "application/json" },
  });
  if (!resp.ok) {
    throw new Error(
      `fetch ${url} → ${resp.status} ${await resp.text().then((t) =>
        t.slice(0, 200)
      )}`,
    );
  }
  return await resp.json() as T;
}

async function anilistFindIdByTitle(
  title: string,
  ua: string,
): Promise<{ id: number; title: string } | null> {
  const query =
    `query ($search: String) { Media(search: $search, type: ANIME) { id title { romaji english } } }`;
  const resp = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ua,
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables: { search: title } }),
  });
  if (!resp.ok) {
    throw new Error(
      `anilist search failed: ${resp.status} ${await resp.text().then((t) =>
        t.slice(0, 200)
      )}`,
    );
  }
  const data = await resp.json() as {
    data?: {
      Media?: { id: number; title: { romaji?: string; english?: string } };
    };
  };
  const m = data.data?.Media;
  if (!m) return null;
  return { id: m.id, title: m.title.english ?? m.title.romaji ?? "" };
}

interface PbList<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

async function fetchSeadex(
  baseUrl: string,
  ua: string,
  alID: number,
): Promise<SeadexEntry | null> {
  const url = `${
    baseUrl.replace(/\/+$/, "")
  }/api/collections/entries/records?filter=(alID=${alID})&expand=trs`;
  const data = await fetchJson<PbList<SeadexEntry>>(url, ua);
  return data.items[0] ?? null;
}

// --- normalised output ---

const TorrentEntrySchema = z.object({
  releaseGroup: z.string(),
  tracker: z.string(),
  url: z.string(),
  infoHash: z.string(),
  isBest: z.boolean(),
  dualAudio: z.boolean(),
  tags: z.array(z.string()),
  totalSizeBytes: z.number(),
  fileCount: z.number(),
  primaryFile: z.string().nullable(),
});

const SeadexResultSchema = z.object({
  alID: z.number(),
  title: z.string().nullable().describe(
    "Title resolved from AniList (when looked up by title)",
  ),
  found: z.boolean(),
  notes: z.string(),
  theoreticalBest: z.string(),
  comparisonUrls: z.array(z.string()),
  incomplete: z.boolean(),
  bestReleases: z.array(TorrentEntrySchema),
  alternativeReleases: z.array(TorrentEntrySchema),
  sourceUrl: z.string(),
  timestamp: z.string(),
  userScore: z.number().optional().describe(
    "User's score (e.g., AniList 0-100) — passed in by caller",
  ),
  userStatus: z.string().optional().describe(
    "User's list status (e.g., COMPLETED, DROPPED) — passed in by caller",
  ),
  userSeason: z.string().optional().describe(
    "Season (WINTER/SPRING/SUMMER/FALL) — passed in by caller",
  ),
  userYear: z.number().optional().describe("Season year — passed in by caller"),
  currentPath: z.string().optional().describe(
    "Current filesystem path of user's copy (from library)",
  ),
  currentSizeBytes: z.number().optional().describe(
    "Current on-disk size in bytes — used to compute upgrade delta",
  ),
  currentFileCount: z.number().optional().describe(
    "Current file count in user's copy",
  ),
});

function normaliseTorrent(
  t: SeadexTorrent,
): z.infer<typeof TorrentEntrySchema> {
  const totalBytes = (t.files ?? []).reduce((s, f) => s + (f.length ?? 0), 0);
  const primary =
    (t.files ?? []).slice().sort((a, b) => (b.length ?? 0) - (a.length ?? 0))[0]
      ?.name ?? null;
  return {
    releaseGroup: t.releaseGroup,
    tracker: t.tracker,
    url: t.url,
    infoHash: t.infoHash,
    isBest: t.isBest,
    dualAudio: t.dualAudio,
    tags: t.tags ?? [],
    totalSizeBytes: totalBytes,
    fileCount: (t.files ?? []).length,
    primaryFile: primary,
  };
}

interface UserMeta {
  userScore?: number;
  userStatus?: string;
  userSeason?: string;
  userYear?: number;
  currentPath?: string;
  currentSizeBytes?: number;
  currentFileCount?: number;
}

function buildResult(
  entry: SeadexEntry | null,
  alID: number,
  title: string | null,
  baseUrl: string,
  userMeta: UserMeta = {},
): z.infer<typeof SeadexResultSchema> {
  const stamp = new Date().toISOString();
  if (!entry) {
    return {
      alID,
      title,
      found: false,
      notes: "",
      theoreticalBest: "",
      comparisonUrls: [],
      incomplete: false,
      bestReleases: [],
      alternativeReleases: [],
      sourceUrl: `${baseUrl.replace(/\/+$/, "")}/${alID}`,
      timestamp: stamp,
      ...userMeta,
    };
  }
  const trs = (entry.expand?.trs ?? []).map(normaliseTorrent);
  return {
    alID: entry.alID,
    title,
    found: true,
    notes: entry.notes ?? "",
    theoreticalBest: entry.theoreticalBest ?? "",
    comparisonUrls: (entry.comparison ?? "").split(",").map((s) => s.trim())
      .filter(Boolean),
    incomplete: !!entry.incomplete,
    bestReleases: trs.filter((t) => t.isBest),
    alternativeReleases: trs.filter((t) => !t.isBest),
    sourceUrl: `${baseUrl.replace(/\/+$/, "")}/${entry.alID}`,
    timestamp: stamp,
    ...userMeta,
  };
}

// --- model ---

/** SeaDex (releases.moe) model: best-release recommendations for anime, with lookups by AniList ID, by title, and fan-out batch lookups. */
export const model = {
  type: "@magistr/seadex",
  version: "2026.07.16.2",
  reports: ["@magistr/seadex-upgrades"],
  globalArguments: GlobalArgsSchema,
  resources: {
    entry: {
      description:
        "SeaDex entry for an anime, with best + alternative releases",
      schema: SeadexResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Summary of a fan-out lookup-many call",
      schema: z.object({
        total: z.number(),
        found: z.number(),
        withBestReleases: z.number(),
        incomplete: z.number(),
        notInSeadex: z.array(
          z.object({ alID: z.number(), title: z.string().nullable() }),
        ),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    "lookup-by-anilist-id": {
      description:
        "Fetch the SeaDex entry for an anime by its AniList ID. Returns best + alternative releases (release group, tracker, infoHash, files).",
      arguments: z.object({
        anilistId: z.number().int().positive().describe(
          "AniList anime ID (e.g., 1)",
        ),
        title: z.string().optional().describe(
          "Optional human-readable title (echoed back in the result; not used for lookup)",
        ),
      }),
      execute: async (
        args: { anilistId: number; title?: string },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { baseUrl, userAgent } = context.globalArgs;
        const entry = await fetchSeadex(baseUrl, userAgent, args.anilistId);
        const result = buildResult(
          entry,
          args.anilistId,
          args.title ?? null,
          baseUrl,
        );
        const handle = await context.writeResource(
          "entry",
          `al-${args.anilistId}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    "render-upgrades": {
      description:
        "Trigger the seadex-upgrades report with optional filters (year, status, minScore). Doesn't fetch new data — just sets methodArgs the report reads to scope which entries to render.",
      arguments: z.object({
        year: z.number().int().optional().describe(
          "Filter to entries with userYear == this value",
        ),
        status: z.string().optional().describe(
          "Filter to entries with userStatus == this (e.g., COMPLETED)",
        ),
        minScore: z.number().int().optional().describe(
          "Filter to entries with userScore >= this (0-100)",
        ),
        title: z.string().optional().describe(
          "Free-form note for the marker resource",
        ),
      }),
      execute: async (
        _args: {
          year?: number;
          status?: string;
          minScore?: number;
          title?: string;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const handle = await context.writeResource(
          "summary",
          "render-upgrades",
          {
            total: 0,
            found: 0,
            withBestReleases: 0,
            incomplete: 0,
            notInSeadex: [],
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-many": {
      description:
        "Fan-out: look up an array of AniList IDs in a single execution. Produces one entry resource per input ID plus a summary. Avoids per-call lock contention versus calling lookup-by-anilist-id N times.",
      arguments: z.object({
        items: z
          .array(
            z.object({
              anilistId: z.number().int().positive(),
              title: z.string().optional(),
              userScore: z.number().optional(),
              userStatus: z.string().optional(),
              userSeason: z.string().optional(),
              userYear: z.number().optional(),
              currentPath: z.string().optional(),
              currentSizeBytes: z.number().optional(),
              currentFileCount: z.number().optional(),
            }),
          )
          .min(1),
        concurrency: z.number().int().positive().max(20).optional().describe(
          "Parallel HTTP requests (default 5)",
        ),
      }),
      execute: async (
        args: {
          items: Array<
            {
              anilistId: number;
              title?: string;
              userScore?: number;
              userStatus?: string;
              userSeason?: string;
              userYear?: number;
              currentPath?: string;
              currentSizeBytes?: number;
              currentFileCount?: number;
            }
          >;
          concurrency?: number;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { baseUrl, userAgent } = context.globalArgs;
        const conc = args.concurrency ?? 5;
        const results: z.infer<typeof SeadexResultSchema>[] = [];
        const queue = [...args.items];
        async function worker() {
          while (queue.length > 0) {
            const it = queue.shift();
            if (!it) return;
            const userMeta: UserMeta = {
              userScore: it.userScore,
              userStatus: it.userStatus,
              userSeason: it.userSeason,
              userYear: it.userYear,
              currentPath: it.currentPath,
              currentSizeBytes: it.currentSizeBytes,
              currentFileCount: it.currentFileCount,
            };
            try {
              const entry = await fetchSeadex(baseUrl, userAgent, it.anilistId);
              results.push(
                buildResult(
                  entry,
                  it.anilistId,
                  it.title ?? null,
                  baseUrl,
                  userMeta,
                ),
              );
            } catch (e) {
              results.push({
                ...buildResult(
                  null,
                  it.anilistId,
                  it.title ?? null,
                  baseUrl,
                  userMeta,
                ),
                notes: `ERROR: ${(e as Error).message}`,
              });
            }
          }
        }
        await Promise.all(
          Array.from(
            { length: Math.min(conc, args.items.length) },
            () => worker(),
          ),
        );

        const handles: unknown[] = [];
        for (const r of results) {
          handles.push(await context.writeResource("entry", `al-${r.alID}`, r));
        }
        const summary = {
          total: results.length,
          found: results.filter((r) => r.found).length,
          withBestReleases:
            results.filter((r) => r.bestReleases.length > 0).length,
          incomplete: results.filter((r) => r.found && r.incomplete).length,
          notInSeadex: results.filter((r) => !r.found).map((r) => ({
            alID: r.alID,
            title: r.title,
          })),
          timestamp: new Date().toISOString(),
        };
        handles.push(
          await context.writeResource("summary", "lookup-many", summary),
        );
        return { dataHandles: handles };
      },
    },

    "lookup-by-title": {
      description:
        "Resolve a title to an AniList ID via the public AniList GraphQL, then fetch the SeaDex entry. One round-trip per call.",
      arguments: z.object({
        title: z.string().min(1).describe(
          "Anime title (English or Romaji); first AniList match is used",
        ),
      }),
      execute: async (
        args: { title: string },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { baseUrl, userAgent } = context.globalArgs;
        const found = await anilistFindIdByTitle(args.title, userAgent);
        if (!found) {
          const result = buildResult(null, 0, args.title, baseUrl);
          const handle = await context.writeResource(
            "entry",
            `q-${
              args.title.replace(/[^a-z0-9]/gi, "-").slice(0, 40).toLowerCase()
            }`,
            result,
          );
          return { dataHandles: [handle] };
        }
        const entry = await fetchSeadex(baseUrl, userAgent, found.id);
        const result = buildResult(
          entry,
          found.id,
          found.title || args.title,
          baseUrl,
        );
        const handle = await context.writeResource(
          "entry",
          `al-${found.id}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
