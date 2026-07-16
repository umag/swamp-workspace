import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  host: z
    .string()
    .describe("TubeArchivist URL (e.g., https://tubearchivist.example.com)"),
  token: z
    .string()
    .describe(
      "API token - use vault: ${{ vault.get(my-vault, TA_TOKEN) }}",
    ),
});

// --- helpers ---

async function api(
  host: string,
  token: string,
  path: string,
  options: Record<string, unknown> = {},
) {
  const url = `${host.replace(/\/+$/, "")}${path}`;
  const headers = {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, unknown> | undefined),
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${options.method || "GET"} ${path} failed: ${response.status} - ${
        body.slice(0, 200)
      }`,
    );
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const body = await response.text();
    throw new Error(
      `${options.method || "GET"} ${path} returned non-JSON (${contentType}): ${
        body.slice(0, 200)
      }`,
    );
  }
  return response.json();
}

function apiGet(host: string, token: string, path: string) {
  return api(host, token, path);
}

function apiPost(
  host: string,
  token: string,
  path: string,
  body: Record<string, unknown> = {},
) {
  return api(host, token, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function apiDelete(host: string, token: string, path: string) {
  return api(host, token, path, { method: "DELETE" });
}

// --- resource schemas ---

const VideoSummarySchema = z.object({
  youtube_id: z.string(),
  title: z.string(),
  channel_name: z.string(),
  published: z.string(),
  vid_type: z.string(),
  active: z.boolean(),
}).passthrough();

const ChannelSummarySchema = z.object({
  channel_id: z.string(),
  channel_name: z.string(),
  channel_subs: z.number(),
  channel_subscribed: z.boolean(),
}).passthrough();

const StatsSchema = z.object({
  doc_count: z.number(),
  media_size: z.number(),
  duration: z.number(),
  duration_str: z.string(),
}).passthrough();

const TaskResultSchema = z.object({
  task_id: z.string(),
  message: z.string().optional(),
  status: z.string().optional(),
  timestamp: z.string(),
});

const DownloadItemSchema = z.object({
  youtube_id: z.string(),
  status: z.string().optional(),
});

const SearchResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({}).passthrough()),
  total: z.number(),
  timestamp: z.string(),
});

const SnapshotSchema = z.object({
  snapshot_name: z.string().optional(),
  snapshots: z.array(z.object({}).passthrough()).optional(),
  timestamp: z.string(),
});

const BackupSchema = z.object({
  backups: z.array(z.object({}).passthrough()).optional(),
  task_id: z.string().optional(),
  timestamp: z.string(),
});

/** TubeArchivist model: manage videos, channels, downloads, and search via the API. */
export const model = {
  type: "@magistr/tubearchivist",
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    videos: {
      description: "Video listing results",
      schema: z.object({
        videos: z.array(VideoSummarySchema),
        total: z.number(),
        page: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    channels: {
      description: "Channel listing results",
      schema: z.object({
        channels: z.array(ChannelSummarySchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    stats: {
      description: "Video statistics",
      schema: StatsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    task: {
      description: "Task trigger result",
      schema: TaskResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    download: {
      description: "Download queue operation result",
      schema: z.object({
        task_id: z.string().optional(),
        message: z.string().optional(),
        items: z.array(DownloadItemSchema).optional(),
        total: z.number().optional(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    search: {
      description: "Search results",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    snapshot: {
      description: "Snapshot operation result",
      schema: SnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    backup: {
      description: "Backup operation result",
      schema: BackupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "list-videos": {
      description: "List videos with optional filters",
      arguments: z.object({
        page: z.number().optional().describe("Page number (default 0)"),
        channel: z.string().optional().describe("Filter by channel ID"),
        watch: z
          .enum(["watched", "unwatched"])
          .optional()
          .describe("Filter by watch status"),
        type: z
          .enum(["videos", "streams", "shorts"])
          .optional()
          .describe("Filter by video type"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const params = new URLSearchParams();
        if (args.page) params.set("page", String(args.page));
        if (args.channel) params.set("channel", args.channel);
        if (args.watch) params.set("watch", args.watch);
        if (args.type) params.set("type", args.type);
        const qs = params.toString();
        const data = await apiGet(
          host,
          token,
          `/api/video/${qs ? "?" + qs : ""}`,
        );
        const videos = (data.data || []).map((v) => ({
          youtube_id: v.youtube_id,
          title: v.title,
          channel_name: v.channel?.channel_name || "",
          published: v.published,
          vid_type: v.vid_type,
          active: v.active,
        }));
        await context.writeResource("videos", "videos", {
          videos,
          total: data.paginate?.total_hits || videos.length,
          page: data.paginate?.current_page || 0,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "get-video": {
      description: "Get a single video by YouTube ID",
      arguments: z.object({
        youtube_id: z.string().describe("YouTube video ID"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiGet(
          host,
          token,
          `/api/video/${args.youtube_id}/`,
        );
        await context.writeResource("videos", args.youtube_id, {
          videos: [data],
          total: 1,
          page: 0,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "delete-video": {
      description: "Delete a video by YouTube ID",
      arguments: z.object({
        youtube_id: z.string().describe("YouTube video ID"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        await apiDelete(host, token, `/api/video/${args.youtube_id}/`);
        await context.writeResource("task", "delete", {
          task_id: "",
          message: `Deleted video ${args.youtube_id}`,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "list-channels": {
      description: "List subscribed channels",
      arguments: z.object({
        filter: z
          .enum(["subscribed", "unsubscribed"])
          .optional()
          .describe("Filter by subscription status"),
        page: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const params = new URLSearchParams();
        if (args.filter) params.set("filter", args.filter);
        if (args.page) params.set("page", String(args.page));
        const qs = params.toString();
        const data = await apiGet(
          host,
          token,
          `/api/channel/${qs ? "?" + qs : ""}`,
        );
        const channels = (data.data || []).map((c) => ({
          channel_id: c.channel_id,
          channel_name: c.channel_name,
          channel_subs: c.channel_subs,
          channel_subscribed: c.channel_subscribed,
        }));
        await context.writeResource("channels", "channels", {
          channels,
          total: data.paginate?.total_hits || channels.length,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "subscribe": {
      description: "Subscribe to YouTube channels",
      arguments: z.object({
        channel_ids: z
          .array(z.string())
          .describe("List of YouTube channel IDs to subscribe to"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(host, token, "/api/channel/", {
          data: args.channel_ids.map((id) => ({
            channel_id: id,
            channel_subscribed: true,
          })),
        });
        await context.writeResource("task", "subscribe", {
          task_id: data.task_id || "",
          message: data.message ||
            `Subscribed to ${args.channel_ids.length} channels`,
          status: data.status,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "add-to-queue": {
      description: "Add videos to the download queue",
      arguments: z.object({
        youtube_ids: z
          .array(z.string())
          .describe("YouTube video or playlist IDs to download"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(host, token, "/api/download/", {
          data: args.youtube_ids.map((id) => ({
            youtube_id: id,
            status: "pending",
          })),
        });
        await context.writeResource("download", "queue-add", {
          task_id: data.task_id || "",
          message: data.message,
          items: args.youtube_ids.map((id) => ({
            youtube_id: id,
            status: "pending",
          })),
          total: args.youtube_ids.length,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "list-queue": {
      description: "List download queue",
      arguments: z.object({
        page: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const params = new URLSearchParams();
        if (args.page) params.set("page", String(args.page));
        const qs = params.toString();
        const data = await apiGet(
          host,
          token,
          `/api/download/${qs ? "?" + qs : ""}`,
        );
        const items = (data.data || []).map((d) => ({
          youtube_id: d.youtube_id,
          status: d.status,
        }));
        await context.writeResource("download", "queue-list", {
          items,
          total: data.paginate?.total_hits || items.length,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "start-download": {
      description: "Trigger downloading pending videos from queue",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(
          host,
          token,
          "/api/task/by-name/download_pending/",
        );
        await context.writeResource("task", "download", {
          task_id: data.task_id || "",
          message: data.message,
          status: data.status,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "rescan": {
      description: "Rescan filesystem for new or removed videos",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(
          host,
          token,
          "/api/appsettings/rescan-filesystem/",
        );
        await context.writeResource("task", "rescan", {
          task_id: data.task_id || "",
          message: data.message,
          status: data.status,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "refresh": {
      description: "Reindex videos, channels, or playlists from YouTube",
      arguments: z.object({
        video: z.array(z.string()).optional().describe("Video IDs to refresh"),
        channel: z.array(z.string()).optional().describe(
          "Channel IDs to refresh",
        ),
        playlist: z.array(z.string()).optional().describe(
          "Playlist IDs to refresh",
        ),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const body: Record<string, unknown> = {};
        if (args.video) body.video = args.video;
        if (args.channel) body.channel = args.channel;
        if (args.playlist) body.playlist = args.playlist;
        const data = await apiPost(host, token, "/api/refresh/", body);
        await context.writeResource("task", "refresh", {
          task_id: data.task_id || "",
          message: data.message,
          status: data.status,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "update-subscribed": {
      description: "Check for new videos from subscribed channels",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(
          host,
          token,
          "/api/task/by-name/update_subscribed/",
        );
        await context.writeResource("task", "update-subscribed", {
          task_id: data.task_id || "",
          message: data.message,
          status: data.status,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    search: {
      description: "Search across all indexes",
      arguments: z.object({
        query: z.string().describe("Search query"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        const params = new URLSearchParams({ q: args.query });
        const data = await apiGet(host, token, `/api/search/?${params}`);
        const results = data.results || data.data || [];
        await context.writeResource("search", "search", {
          query: args.query,
          results,
          total: Array.isArray(results) ? results.length : 0,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "mark-watched": {
      description: "Mark a video as watched or unwatched",
      arguments: z.object({
        youtube_id: z.string().describe("YouTube video ID"),
        is_watched: z.boolean().describe("true=watched, false=unwatched"),
      }),
      execute: async (args, context) => {
        const { host, token } = context.globalArgs;
        await apiPost(host, token, "/api/watched/", {
          id: args.youtube_id,
          is_watched: args.is_watched,
        });
        await context.writeResource("task", "watched", {
          task_id: "",
          message: `Marked ${args.youtube_id} as ${
            args.is_watched ? "watched" : "unwatched"
          }`,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    stats: {
      description: "Get video library statistics",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiGet(host, token, "/api/stats/video/");
        await context.writeResource("stats", "stats", {
          ...data,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    backup: {
      description: "Trigger a new backup",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(host, token, "/api/appsettings/backup/");
        await context.writeResource("backup", "backup", {
          task_id: data.task_id || "",
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "list-backups": {
      description: "List available backup files",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiGet(host, token, "/api/appsettings/backup/");
        await context.writeResource("backup", "list", {
          backups: data.data || data || [],
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "create-snapshot": {
      description: "Create an Elasticsearch snapshot",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiPost(host, token, "/api/appsettings/snapshot/");
        await context.writeResource("snapshot", "create", {
          snapshot_name: data.snapshot_name,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    "list-snapshots": {
      description: "List available Elasticsearch snapshots",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiGet(host, token, "/api/appsettings/snapshot/");
        await context.writeResource("snapshot", "list", {
          snapshots: data.data || data || [],
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },

    ping: {
      description: "Health check - ping the API",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, token } = context.globalArgs;
        const data = await apiGet(host, token, "/api/ping/");
        await context.writeResource("task", "ping", {
          task_id: "",
          message: JSON.stringify(data),
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
  },
};
