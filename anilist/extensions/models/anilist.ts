import { z } from "npm:zod@4";

const ANILIST_API = "https://graphql.anilist.co";

// Rate limiter: AniList allows 30 req/min (degraded) / 90 req/min (normal).
// We track remaining from response headers and sleep when needed.
const rateLimit = {
  remaining: 30,
  resetAt: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gql(query, variables = {}) {
  // Pre-flight: if we know we're out of budget, wait for reset
  if (rateLimit.remaining <= 1 && rateLimit.resetAt > Date.now()) {
    const waitMs = rateLimit.resetAt - Date.now() + 500;
    await sleep(waitMs);
  }

  const response = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
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
    const retryAfter = response.headers.get("Retry-After");
    const waitSec = retryAfter ? parseInt(retryAfter, 10) : 60;
    await sleep(waitSec * 1000);
    return gql(query, variables);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AniList API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  if (json.errors) {
    // AniList can return 200 with a 429 error in the body
    const rateLimitError = json.errors.find((e) => e.status === 429);
    if (rateLimitError) {
      await sleep(60_000);
      return gql(query, variables);
    }
    throw new Error(
      `AniList GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }
  return json.data;
}

const GlobalArgsSchema = z.object({
  mediaType: z.enum(["ANIME", "MANGA"]).default("ANIME").describe(
    "Default media type for queries",
  ),
});

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

const USERLIST_QUERY = `
query ($userName: String!, $type: MediaType, $status: MediaListStatus) {
  MediaListCollection(userName: $userName, type: $type, status: $status) {
    lists {
      name status
      entries {
        id status score progress
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
// Caps at maxPages to avoid runaway requests.
async function fetchAllPages(query, variables, maxPages) {
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

/** AniList GraphQL model: search and fetch anime/manga, media details, user lists, and trending. */
export const model = {
  type: "@magistr/anilist",
  version: "2026.05.25.1",
  globalArguments: GlobalArgsSchema,
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
  },
  methods: {
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
      execute: async (args, context) => {
        const type = args.type || context.globalArgs.mediaType;

        if (args.fetchAll) {
          const { media, pageInfo } = await fetchAllPages(
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
      execute: async (args, context) => {
        const data = await gql(DETAILS_QUERY, { id: args.id });
        const media = data.Media;

        media.studios = media.studios?.nodes?.map((s) => s.name) || [];
        media.staff = media.staff?.nodes?.map((s) => s.name?.full) || [];

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
      execute: async (args, context) => {
        const type = args.type || context.globalArgs.mediaType;
        const variables: Record<string, unknown> = {
          userName: args.userName,
          type,
        };
        if (args.status) variables.status = args.status;

        const data = await gql(USERLIST_QUERY, variables);
        const lists = (data.MediaListCollection.lists || []).map((list) => ({
          name: list.name,
          status: list.status,
          entryCount: list.entries.length,
          entries: list.entries,
        }));

        const totalEntries = lists.reduce((sum, l) => sum + l.entryCount, 0);

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
      execute: async (args, context) => {
        const type = args.type || context.globalArgs.mediaType;

        if (args.fetchAll) {
          const { media, pageInfo } = await fetchAllPages(
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
  },
};
