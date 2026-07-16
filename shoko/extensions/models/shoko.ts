import { z } from "npm:zod@4";

// Shoko Server (anime metadata + library manager) — REST v3 API.
// Docs: https://docs.shokoanime.com/  | Local swagger at /swagger/v3/swagger.json
// Auth: POST /api/auth with {user, pass, device} → {apikey}; subsequent requests
// pass header `apikey: <key>` (Shoko-specific header, not standard Bearer).

const GlobalArgsSchema = z.object({
  host: z
    .string()
    .describe("Shoko base URL, e.g. http://203.0.113.10:8111"),
  apiKey: z
    .string()
    .meta({ sensitive: true })
    .describe(
      "Long-lived API key — use vault. Obtain via the `authenticate` method.",
    ),
  userAgent: z
    .string()
    .default("swamp-shoko/1.0")
    .describe("User-Agent string"),
});

// --- helpers ---

async function http(
  method: "GET" | "POST" | "DELETE",
  host: string,
  path: string,
  apiKey: string | null,
  ua: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${host.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": ua,
  };
  if (apiKey) headers["apikey"] = apiKey;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `Shoko ${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// --- resource schemas (loose: Shoko returns lots of fields, we passthrough) ---

const SeriesSchema = z.object({
  IDs: z.object({}).passthrough().optional(),
  Name: z.string().optional(),
  Sizes: z.object({}).passthrough().optional(),
}).passthrough();

const FileSchema = z.object({
  ID: z.number(),
  Size: z.number().optional(),
  CRC32: z.string().optional(),
  Locations: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

const EpisodeSchema = z.object({
  IDs: z.object({}).passthrough().optional(),
  Name: z.string().optional(),
}).passthrough();

const StatusSchema = z.object({
  State: z.union([z.string(), z.number()]).optional(),
  StartupMessage: z.string().nullable().optional(),
}).passthrough();

const DashboardSchema = z.object({}).passthrough();

const QueueItemSchema = z.object({
  Name: z.string().optional(),
  Status: z.union([z.string(), z.number()]).optional(),
  Type: z.string().optional(),
}).passthrough();

const ImportFolderSchema = z.object({
  ID: z.number().optional(),
  Path: z.string().optional(),
  Name: z.string().optional(),
}).passthrough();

const ActionSchema = z.object({
  Name: z.string(),
  Description: z.string().optional(),
}).passthrough();

const TaskResultSchema = z.object({
  message: z.string(),
  endpoint: z.string(),
  timestamp: z.string(),
});

const AuthResultSchema = z.object({
  apikey: z.string(),
  device: z.string(),
  timestamp: z.string(),
});

// --- model ---

/**
 * Shoko anime metadata server model — series, episodes, files, and metadata
 * over the Shoko Server REST v3 API (auth, dashboard, library, queue, actions).
 */
export const model = {
  type: "@magistr/shoko",
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Server init status (does not require auth)",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    dashboard: {
      description: "Dashboard stats (series count, missing episodes, etc.)",
      schema: DashboardSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    series: {
      description: "Series listing or single series detail",
      schema: z.object({
        items: z.array(SeriesSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    files: {
      description:
        "File listing (recognized, unrecognized, manually-linked, etc.)",
      schema: z.object({
        items: z.array(FileSchema),
        total: z.number(),
        category: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    episodes: {
      description:
        "Episode listing (e.g., missing episodes per release management)",
      schema: z.object({
        items: z.array(EpisodeSchema),
        total: z.number(),
        category: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    queue: {
      description: "Queue overview (general, hasher, image, AniDB)",
      schema: z.object({
        items: z.array(QueueItemSchema),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    importFolders: {
      description: "Configured import folders",
      schema: z.object({
        folders: z.array(ImportFolderSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    actions: {
      description: "Available action endpoints (Action/* in API)",
      schema: z.object({
        actions: z.array(ActionSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    task: {
      description: "Result of a triggered action",
      schema: TaskResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    auth: {
      description:
        "Result of authenticate (apikey is sensitive — store in vault)",
      schema: AuthResultSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
  },
  methods: {
    authenticate: {
      description:
        "Exchange username/password for a long-lived apikey. Stash the returned key in your vault and put it in the model's globalArgs.apiKey afterward.",
      arguments: z.object({
        user: z.string().min(1),
        pass: z.string(),
        device: z.string().default("swamp"),
      }),
      execute: async (
        args: { user: string; pass: string; device: string },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, userAgent } = context.globalArgs;
        const data = await http("POST", host, "/api/auth", null, userAgent, {
          user: args.user,
          pass: args.pass,
          device: args.device,
        }) as { apikey?: string };
        if (!data.apikey) {
          throw new Error(
            `auth response missing apikey: ${
              JSON.stringify(data).slice(0, 200)
            }`,
          );
        }
        const handle = await context.writeResource("auth", "current", {
          apikey: data.apikey,
          device: args.device,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Get server init status (no auth required)",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, userAgent } = context.globalArgs;
        const data = await http(
          "GET",
          host,
          "/api/v3/Init/Status",
          null,
          userAgent,
        ) as Record<string, unknown>;
        const handle = await context.writeResource("status", "init", data);
        return { dataHandles: [handle] };
      },
    },

    dashboard: {
      description:
        "Fetch dashboard stats (series count, file size on disk, queue health, etc.)",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const data = await http(
          "GET",
          host,
          "/api/v3/Dashboard/Stats",
          apiKey,
          userAgent,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "dashboard",
          "dashboard-stats",
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    "list-series": {
      description:
        "List series (paginated). Returns a single page; use page+pageSize to walk.",
      arguments: z.object({
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1000).optional().default(50),
        startsWith: z.string().optional().describe(
          "Filter to series whose name starts with this letter",
        ),
      }),
      execute: async (
        args: { page: number; pageSize: number; startsWith?: string },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const qs = new URLSearchParams({
          page: String(args.page),
          pageSize: String(args.pageSize),
        });
        if (args.startsWith) qs.set("startsWith", args.startsWith);
        const data = await http(
          "GET",
          host,
          `/api/v3/Series?${qs}`,
          apiKey,
          userAgent,
        ) as { Total?: number; List?: unknown[] };
        const items = (data.List ?? []) as Array<z.infer<typeof SeriesSchema>>;
        const handle = await context.writeResource(
          "series",
          `page-${args.page}`,
          {
            items,
            total: data.Total ?? items.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "search-series": {
      description: "Search series by name (server-side fuzzy match)",
      arguments: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().optional().default(20),
        fuzzy: z.boolean().optional().default(true),
      }),
      execute: async (
        args: { query: string; limit: number; fuzzy: boolean },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const qs = new URLSearchParams({
          limit: String(args.limit),
          fuzzy: String(args.fuzzy),
        });
        const data = await http(
          "GET",
          host,
          `/api/v3/Series/Search/${encodeURIComponent(args.query)}?${qs}`,
          apiKey,
          userAgent,
        ) as unknown[];
        const items = Array.isArray(data)
          ? data as Array<z.infer<typeof SeriesSchema>>
          : [];
        const handle = await context.writeResource(
          "series",
          `search-${args.query.slice(0, 30)}`,
          {
            items,
            total: items.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "find-unrecognized-files": {
      description:
        "List files Shoko hasn't been able to match to AniDB (manual link queue)",
      arguments: z.object({
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1000).optional().default(100),
      }),
      execute: async (
        args: { page: number; pageSize: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const qs = new URLSearchParams({
          page: String(args.page),
          pageSize: String(args.pageSize),
          include_only: "Unrecognized",
        });
        const data = await http(
          "GET",
          host,
          `/api/v3/File?${qs}`,
          apiKey,
          userAgent,
        ) as { Total?: number; List?: unknown[] };
        const items = (data.List ?? []) as Array<z.infer<typeof FileSchema>>;
        const handle = await context.writeResource("files", "unrecognized", {
          items,
          total: data.Total ?? items.length,
          category: "unrecognized",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "find-missing-episodes": {
      description:
        "Series with missing episodes (not yet downloaded). Returns series-level summary; for per-episode detail, set scope='episodes'.",
      arguments: z.object({
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1000).optional().default(100),
        collecting: z.boolean().optional().describe(
          "Only series the user has marked 'collecting'",
        ),
        scope: z.enum(["series", "episodes"]).optional().default("series"),
      }),
      execute: async (
        args: {
          page: number;
          pageSize: number;
          collecting?: boolean;
          scope: "series" | "episodes";
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const qs = new URLSearchParams({
          page: String(args.page),
          pageSize: String(args.pageSize),
        });
        if (args.collecting !== undefined) {
          qs.set("collecting", String(args.collecting));
        }
        const subPath = args.scope === "episodes" ? "Episodes" : "Series";
        const data = await http(
          "GET",
          host,
          `/api/v3/ReleaseManagement/MissingEpisodes/${subPath}?${qs}`,
          apiKey,
          userAgent,
        ) as { Total?: number; List?: unknown[] };
        const items = (data.List ?? []) as Array<z.infer<typeof EpisodeSchema>>;
        const handle = await context.writeResource(
          "episodes",
          `missing-${args.scope}`,
          {
            items,
            total: data.Total ?? items.length,
            category: `missing-${args.scope}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "find-duplicate-files": {
      description:
        "Episodes (or series) with multiple physical files. scope='series' is the summary; scope='episodes' for per-episode detail.",
      arguments: z.object({
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1000).optional().default(100),
        scope: z.enum(["series", "episodes"]).optional().default("series"),
      }),
      execute: async (
        args: { page: number; pageSize: number; scope: "series" | "episodes" },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const qs = new URLSearchParams({
          page: String(args.page),
          pageSize: String(args.pageSize),
        });
        const subPath = args.scope === "episodes" ? "Episodes" : "Series";
        const data = await http(
          "GET",
          host,
          `/api/v3/ReleaseManagement/DuplicateFiles/${subPath}?${qs}`,
          apiKey,
          userAgent,
        ) as { Total?: number; List?: unknown[] };
        const items = (data.List ?? []) as Array<z.infer<typeof FileSchema>>;
        const handle = await context.writeResource(
          "files",
          `duplicates-${args.scope}`,
          {
            items,
            total: data.Total ?? items.length,
            category: `duplicates-${args.scope}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "list-import-folders": {
      description: "Show all configured import folders",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const data = await http(
          "GET",
          host,
          "/api/v3/ImportFolder",
          apiKey,
          userAgent,
        ) as unknown[];
        const folders = (Array.isArray(data) ? data : []) as Array<
          z.infer<typeof ImportFolderSchema>
        >;
        const handle = await context.writeResource(
          "importFolders",
          "import-folders",
          {
            folders,
            total: folders.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "queue-status": {
      description:
        "Show queue depth + state across the (general, hasher, image) queues",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const data = await http(
          "GET",
          host,
          "/api/v3/Queue",
          apiKey,
          userAgent,
        ) as unknown;
        const items = (Array.isArray(data) ? data : [data]) as Array<
          z.infer<typeof QueueItemSchema>
        >;
        const handle = await context.writeResource("queue", "queue", {
          items,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "list-actions": {
      description:
        "List action endpoints by parsing the live OpenAPI spec at /swagger/v3/swagger.json (Shoko has no list endpoint — this discovers them from the spec).",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, userAgent } = context.globalArgs;
        const spec = await http(
          "GET",
          host,
          "/swagger/v3/swagger.json",
          null,
          userAgent,
        ) as {
          paths?: Record<
            string,
            Record<string, { summary?: string; tags?: string[] }>
          >;
        };
        const actions: Array<{ Name: string; Description?: string }> = [];
        for (const [path, methods] of Object.entries(spec.paths ?? {})) {
          if (!path.startsWith("/Action/")) continue;
          const get = methods["get"];
          if (!get) continue;
          const name = path.slice("/Action/".length);
          actions.push({ Name: name, Description: get.summary });
        }
        const handle = await context.writeResource("actions", "available", {
          actions,
          total: actions.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "run-action": {
      description:
        "Trigger a Shoko action by name (use list-actions to enumerate). E.g. action='RunImport' scans import folders, 'UpdateAllAniDBInfo' refreshes metadata, 'SyncMyList' syncs AniDB MyList.",
      arguments: z.object({
        action: z.string().min(1).describe(
          "Action name (e.g., RunImport, UpdateAllAniDBInfo, ImportNewFiles, RecreateAllGroups)",
        ),
      }),
      execute: async (
        args: { action: string },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const path = `/api/v3/Action/${encodeURIComponent(args.action)}`;
        await http("GET", host, path, apiKey, userAgent);
        const handle = await context.writeResource(
          "task",
          `action-${args.action}`,
          {
            message: `Triggered ${args.action}`,
            endpoint: path,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "remove-missing-files": {
      description:
        "Purge DB entries for files that no longer exist on disk. Use after deleting/renaming folders so Shoko's metadata catches up. Set removeFromMyList=true to also remove the AniDB MyList entry for each missing file.",
      arguments: z.object({
        removeFromMyList: z.boolean().default(false),
      }),
      execute: async (
        args: { removeFromMyList: boolean },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const path =
          `/api/v3/Action/RemoveMissingFiles/${args.removeFromMyList}`;
        await http("GET", host, path, apiKey, userAgent);
        const handle = await context.writeResource(
          "task",
          `remove-missing-files-${args.removeFromMyList}`,
          {
            message:
              `Triggered RemoveMissingFiles (removeFromMyList=${args.removeFromMyList})`,
            endpoint: path,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "rescan-folder": {
      description:
        "Rescan a single import folder by ID. Triggers Shoko to walk the folder, hash new files, and queue AniDB lookups.",
      arguments: z.object({
        importFolderId: z.number().int().positive(),
      }),
      execute: async (
        args: { importFolderId: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (n: string, k: string, v: unknown) => Promise<unknown>;
        },
      ) => {
        const { host, apiKey, userAgent } = context.globalArgs;
        const path = `/api/v3/ImportFolder/${args.importFolderId}/Scan`;
        await http("GET", host, path, apiKey, userAgent);
        const handle = await context.writeResource(
          "task",
          `rescan-folder-${args.importFolderId}`,
          {
            message: `Triggered rescan of import folder ${args.importFolderId}`,
            endpoint: path,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
