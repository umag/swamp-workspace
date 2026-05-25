import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Dawarich instance URL (e.g. https://dawarich.example.com)",
  ),
  apiKey: z.string().describe(
    "API key from Account settings - use vault: ${{ vault.get(vault-name, KEY) }}",
  ),
});

type ApiResult = {
  data: unknown;
  headers: {
    currentPage?: string | null;
    totalPages?: string | null;
  };
};

async function apiRequest(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
  method = "GET",
  body: Record<string, unknown> | null = null,
): Promise<ApiResult> {
  const sep = endpoint.includes("?") ? "&" : "?";
  const url = `${baseUrl}${endpoint}${sep}api_key=${apiKey}`;

  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dawarich API error ${response.status}: ${text}`);
  }

  if (response.status === 204) return { data: null, headers: {} };

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return {
      data: await response.json(),
      headers: {
        currentPage: response.headers.get("X-Current-Page"),
        totalPages: response.headers.get("X-Total-Pages"),
      },
    };
  }
  return { data: await response.text(), headers: {} };
}

/**
 * Dawarich self-hosted location-tracking API model — wraps the `/api/v1/*`
 * endpoints for health, statistics, points, visits, tracks, settings, digests,
 * and geotagged photos, persisting each result as a swamp data resource.
 */
export const model = {
  type: "@magistr/dawarich",
  version: "2026.05.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "health": {
      description: "Service health status",
      schema: z.object({
        status: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    "stats": {
      description: "Monthly/yearly statistics",
      schema: z.object({
        year: z.number(),
        month: z.number().optional(),
        stats: z.unknown(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "points": {
      description: "Location points",
      schema: z.object({
        points: z.array(z.unknown()),
        count: z.number(),
        currentPage: z.number().optional(),
        totalPages: z.number().optional(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "trackedMonths": {
      description: "Months with tracking data",
      schema: z.object({
        months: z.array(z.unknown()),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "visits": {
      description: "Visit records",
      schema: z.object({
        visits: z.array(z.unknown()),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "tracks": {
      description: "Track data",
      schema: z.object({
        tracks: z.array(z.unknown()),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "settings": {
      description: "User settings",
      schema: z.object({
        settings: z.unknown(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "digests": {
      description: "Yearly/monthly digests",
      schema: z.object({
        digests: z.unknown(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "photos": {
      description: "Geotagged photos",
      schema: z.object({
        photos: z.array(z.unknown()),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    health: {
      description: "Check Dawarich service health",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const result = await apiRequest(baseUrl, apiKey, "/api/v1/health");

        const handle = await context.writeResource("health", "current", {
          status: typeof result.data === "object"
            ? JSON.stringify(result.data)
            : String(result.data),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stats: {
      description: "Get monthly statistics",
      arguments: z.object({
        year: z.number().describe("Year to get stats for"),
        month: z.number().optional().describe("Month (1-12), omit for yearly"),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        let endpoint = `/api/v1/stats?year=${args.year}`;
        if (args.month) endpoint += `&month=${args.month}`;

        const result = await apiRequest(baseUrl, apiKey, endpoint);

        const instanceName = args.month
          ? `${args.year}-${String(args.month).padStart(2, "0")}`
          : `${args.year}`;
        const handle = await context.writeResource("stats", instanceName, {
          year: args.year,
          month: args.month,
          stats: result.data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    points: {
      description: "Get location points with optional date filtering",
      arguments: z.object({
        startAt: z.string().optional().describe("Start date (ISO8601)"),
        endAt: z.string().optional().describe("End date (ISO8601)"),
        page: z.number().optional().describe("Page number"),
        perPage: z.number().optional().describe(
          "Points per page (default 100)",
        ),
        order: z.enum(["asc", "desc"]).optional().describe("Sort order"),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const params: string[] = [];
        if (args.startAt) params.push(`start_at=${args.startAt}`);
        if (args.endAt) params.push(`end_at=${args.endAt}`);
        if (args.page) params.push(`page=${args.page}`);
        if (args.perPage) params.push(`per_page=${args.perPage}`);
        if (args.order) params.push(`order=${args.order}`);

        const qs = params.length > 0 ? `?${params.join("&")}` : "";
        const result = await apiRequest(baseUrl, apiKey, `/api/v1/points${qs}`);

        const points = Array.isArray(result.data) ? result.data : [];
        const handle = await context.writeResource("points", "current", {
          points,
          count: points.length,
          currentPage: result.headers.currentPage
            ? parseInt(result.headers.currentPage)
            : undefined,
          totalPages: result.headers.totalPages
            ? parseInt(result.headers.totalPages)
            : undefined,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "tracked-months": {
      description: "Get list of months with tracking data",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const result = await apiRequest(
          baseUrl,
          apiKey,
          "/api/v1/points/tracked_months",
        );

        const handle = await context.writeResource("trackedMonths", "all", {
          months: Array.isArray(result.data) ? result.data : [],
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    visits: {
      description: "Get visit records with optional date filtering",
      arguments: z.object({
        startAt: z.string().optional().describe("Start date (ISO8601)"),
        endAt: z.string().optional().describe("End date (ISO8601)"),
        page: z.number().optional().describe("Page number"),
        perPage: z.number().optional().describe("Records per page"),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const params: string[] = [];
        if (args.startAt) params.push(`start_at=${args.startAt}`);
        if (args.endAt) params.push(`end_at=${args.endAt}`);
        if (args.page) params.push(`page=${args.page}`);
        if (args.perPage) params.push(`per_page=${args.perPage}`);

        const qs = params.length > 0 ? `?${params.join("&")}` : "";
        const result = await apiRequest(baseUrl, apiKey, `/api/v1/visits${qs}`);

        const visits = Array.isArray(result.data) ? result.data : [];
        const handle = await context.writeResource("visits", "current", {
          visits,
          count: visits.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    tracks: {
      description: "Get tracks with optional date filtering",
      arguments: z.object({
        startAt: z.string().optional().describe("Start date (ISO8601)"),
        endAt: z.string().optional().describe("End date (ISO8601)"),
        page: z.number().optional().describe("Page number"),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const params: string[] = [];
        if (args.startAt) params.push(`start_at=${args.startAt}`);
        if (args.endAt) params.push(`end_at=${args.endAt}`);
        if (args.page) params.push(`page=${args.page}`);

        const qs = params.length > 0 ? `?${params.join("&")}` : "";
        const result = await apiRequest(baseUrl, apiKey, `/api/v1/tracks${qs}`);

        const tracks = Array.isArray(result.data) ? result.data : [];
        const handle = await context.writeResource("tracks", "current", {
          tracks,
          count: tracks.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    settings: {
      description: "Get user settings",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const result = await apiRequest(baseUrl, apiKey, "/api/v1/settings");

        const handle = await context.writeResource("settings", "current", {
          settings: result.data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "update-settings": {
      description: "Update user settings",
      arguments: z.object({
        timezone: z.string().optional().describe(
          "Timezone (e.g. Europe/Amsterdam)",
        ),
        liveMapEnabled: z.boolean().optional().describe("Enable live map"),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const body: Record<string, unknown> = {};
        if (args.timezone) body.timezone = args.timezone;
        if (args.liveMapEnabled !== undefined) {
          body.live_map_enabled = args.liveMapEnabled;
        }

        const result = await apiRequest(
          baseUrl,
          apiKey,
          "/api/v1/settings",
          "PATCH",
          body,
        );

        const handle = await context.writeResource("settings", "current", {
          settings: result.data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    digests: {
      description: "Get yearly or monthly digests",
      arguments: z.object({
        year: z.number().describe("Digest year"),
        periodType: z.enum(["yearly", "monthly"]).optional().describe(
          "Period type (default: yearly)",
        ),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const params = [`year=${args.year}`];
        if (args.periodType) params.push(`period_type=${args.periodType}`);

        const result = await apiRequest(
          baseUrl,
          apiKey,
          `/api/v1/digests?${params.join("&")}`,
        );

        const handle = await context.writeResource("digests", `${args.year}`, {
          digests: result.data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    photos: {
      description: "Get geotagged photos",
      arguments: z.object({
        startAt: z.string().optional().describe("Start date (ISO8601)"),
        endAt: z.string().optional().describe("End date (ISO8601)"),
        page: z.number().optional().describe("Page number"),
      }),
      execute: async (args, context) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const params: string[] = [];
        if (args.startAt) params.push(`start_at=${args.startAt}`);
        if (args.endAt) params.push(`end_at=${args.endAt}`);
        if (args.page) params.push(`page=${args.page}`);

        const qs = params.length > 0 ? `?${params.join("&")}` : "";
        const result = await apiRequest(baseUrl, apiKey, `/api/v1/photos${qs}`);

        const photos = Array.isArray(result.data) ? result.data : [];
        const handle = await context.writeResource("photos", "current", {
          photos,
          count: photos.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
