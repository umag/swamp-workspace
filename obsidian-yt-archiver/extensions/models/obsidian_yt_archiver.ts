import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  vaultPath: z.string().describe("Absolute path to Obsidian vault"),
  tubearchivistUrl: z
    .string()
    .describe(
      "TubeArchivist base URL (e.g. https://tubearchivist.example.com)",
    ),
  tubearchivistToken: z
    .string()
    .describe("TubeArchivist API token"),
});

// --- YouTube URL parsing ---

const YT_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/g,
  /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/g,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/g,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/g,
];

function extractYoutubeIds(
  content: string,
): Array<{ videoId: string; url: string; line: number }> {
  const results: Array<{ videoId: string; url: string; line: number }> = [];
  const seen = new Set<string>();
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of YT_PATTERNS) {
      const regex = new RegExp(pattern.source, "g");
      let match;
      while ((match = regex.exec(lines[i])) !== null) {
        const videoId = match[1];
        if (!seen.has(videoId)) {
          seen.add(videoId);
          results.push({ videoId, url: match[0], line: i + 1 });
        }
      }
    }
  }
  return results;
}

// --- TubeArchivist API helpers ---

async function taApi(
  host: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${host.replace(/\/+$/, "")}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `TA ${method} ${path}: ${res.status} - ${text.slice(0, 200)}`,
    );
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return {};
}

// --- Vault filesystem helpers ---

async function* walkMd(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory && !entry.name.startsWith(".")) {
      yield* walkMd(path);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield path;
    }
  }
}

// --- Schemas ---

const LinkSchema = z.object({
  file: z.string(),
  videoId: z.string(),
  url: z.string(),
  line: z.number(),
});

const ScanResultSchema = z.object({
  links: z.array(LinkSchema),
  totalFiles: z.number(),
  totalLinks: z.number(),
  uniqueVideoIds: z.number(),
  timestamp: z.iso.datetime(),
});

const VideoInfoSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channel: z.string(),
  published: z.string(),
  taUrl: z.string(),
  archived: z.boolean(),
});

const ArchiveResultSchema = z.object({
  queued: z.array(z.string()),
  alreadyArchived: z.array(VideoInfoSchema),
  notFound: z.array(z.string()),
  timestamp: z.iso.datetime(),
});

const ResolvedSchema = z.object({
  videos: z.array(VideoInfoSchema),
  unresolvedIds: z.array(z.string()),
  timestamp: z.iso.datetime(),
});

/** Obsidian YouTube archiver model: scans a vault for YouTube links, queues them in TubeArchivist, and resolves video metadata. */
export const model = {
  type: "@magistr/obsidian-yt-archiver",
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    scan: {
      description: "YouTube links found in vault",
      schema: ScanResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    archive: {
      description: "Archive operation result",
      schema: ArchiveResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    resolved: {
      description: "Resolved video metadata from TubeArchivist",
      schema: ResolvedSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description: "Scan vault for YouTube links",
      arguments: z.object({
        folder: z.string().optional().describe(
          "Subfolder to scan (relative to vault root)",
        ),
      }),
      execute: async (args, context) => {
        const { vaultPath } = context.globalArgs;
        const scanDir = args.folder ? `${vaultPath}/${args.folder}` : vaultPath;
        const links: Array<
          { file: string; videoId: string; url: string; line: number }
        > = [];
        let totalFiles = 0;

        for await (const filePath of walkMd(scanDir)) {
          totalFiles++;
          const relPath = filePath.slice(vaultPath.length + 1);
          const content = await Deno.readTextFile(filePath);
          const found = extractYoutubeIds(content);
          for (const f of found) {
            links.push({
              file: relPath,
              videoId: f.videoId,
              url: f.url,
              line: f.line,
            });
          }
        }

        const uniqueIds = new Set(links.map((l) => l.videoId));

        const handle = await context.writeResource("scan", "main", {
          links,
          totalFiles,
          totalLinks: links.length,
          uniqueVideoIds: uniqueIds.size,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    archive: {
      description: "Queue YouTube videos in TubeArchivist for download",
      arguments: z.object({
        videoIds: z
          .array(z.string())
          .optional()
          .describe("Specific video IDs to archive (omit to use scan results)"),
      }),
      execute: async (args, context) => {
        const { vaultPath, tubearchivistUrl, tubearchivistToken } =
          context.globalArgs;
        let videoIds = args.videoIds;

        // If no IDs provided, scan the vault first
        if (!videoIds || videoIds.length === 0) {
          const links: Array<{ videoId: string }> = [];
          for await (const filePath of walkMd(vaultPath)) {
            const content = await Deno.readTextFile(filePath);
            for (const f of extractYoutubeIds(content)) {
              links.push({ videoId: f.videoId });
            }
          }
          const unique = new Set(links.map((l) => l.videoId));
          videoIds = [...unique];
        }

        const alreadyArchived: Array<{
          videoId: string;
          title: string;
          channel: string;
          published: string;
          taUrl: string;
          archived: boolean;
        }> = [];
        const toQueue: string[] = [];
        const notFound: string[] = [];

        // Check which are already archived
        for (const id of videoIds) {
          try {
            const data = await taApi(
              tubearchivistUrl,
              tubearchivistToken,
              "GET",
              `/api/video/${id}/`,
            ) as Record<string, unknown>;
            const channel = data.channel as Record<string, unknown> | undefined;
            alreadyArchived.push({
              videoId: id,
              title: (data.title as string) || "",
              channel: (channel?.channel_name as string) || "",
              published: (data.published as string) || "",
              taUrl: `${tubearchivistUrl}/video/${id}`,
              archived: true,
            });
          } catch {
            toQueue.push(id);
          }
        }

        // Queue the ones not yet archived
        if (toQueue.length > 0) {
          await taApi(
            tubearchivistUrl,
            tubearchivistToken,
            "POST",
            "/api/download/",
            {
              data: toQueue.map((id) => ({
                youtube_id: id,
                status: "pending",
              })),
            },
          );
          // Trigger download
          await taApi(
            tubearchivistUrl,
            tubearchivistToken,
            "POST",
            "/api/task/by-name/download_pending/",
          );
        }

        const handle = await context.writeResource("archive", "main", {
          queued: toQueue,
          alreadyArchived,
          notFound,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    resolve: {
      description: "Fetch metadata for archived videos from TubeArchivist",
      arguments: z.object({
        videoIds: z
          .array(z.string())
          .optional()
          .describe("Specific video IDs to resolve (omit to use scan results)"),
      }),
      execute: async (args, context) => {
        const { vaultPath, tubearchivistUrl, tubearchivistToken } =
          context.globalArgs;
        let videoIds = args.videoIds;

        if (!videoIds || videoIds.length === 0) {
          const ids = new Set<string>();
          for await (const filePath of walkMd(vaultPath)) {
            const content = await Deno.readTextFile(filePath);
            for (const f of extractYoutubeIds(content)) {
              ids.add(f.videoId);
            }
          }
          videoIds = [...ids];
        }

        const videos: Array<{
          videoId: string;
          title: string;
          channel: string;
          published: string;
          taUrl: string;
          archived: boolean;
        }> = [];
        const unresolvedIds: string[] = [];

        for (const id of videoIds) {
          try {
            const data = await taApi(
              tubearchivistUrl,
              tubearchivistToken,
              "GET",
              `/api/video/${id}/`,
            ) as Record<string, unknown>;
            const channel = data.channel as Record<string, unknown> | undefined;
            videos.push({
              videoId: id,
              title: (data.title as string) || "",
              channel: (channel?.channel_name as string) || "",
              published: (data.published as string) || "",
              taUrl: `${tubearchivistUrl}/video/${id}`,
              archived: true,
            });
          } catch {
            unresolvedIds.push(id);
          }
        }

        const handle = await context.writeResource("resolved", "main", {
          videos,
          unresolvedIds,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Scan vault, archive new videos, resolve metadata — all in one pass",
      arguments: z.object({
        folder: z.string().optional().describe("Subfolder to scan"),
      }),
      execute: async (args, context) => {
        const { vaultPath, tubearchivistUrl, tubearchivistToken } =
          context.globalArgs;
        const scanDir = args.folder ? `${vaultPath}/${args.folder}` : vaultPath;

        // 1. Scan
        const links: Array<
          { file: string; videoId: string; url: string; line: number }
        > = [];
        let totalFiles = 0;
        for await (const filePath of walkMd(scanDir)) {
          totalFiles++;
          const relPath = filePath.slice(vaultPath.length + 1);
          const content = await Deno.readTextFile(filePath);
          for (const f of extractYoutubeIds(content)) {
            links.push({
              file: relPath,
              videoId: f.videoId,
              url: f.url,
              line: f.line,
            });
          }
        }
        const uniqueIds = [...new Set(links.map((l) => l.videoId))];

        await context.writeResource("scan", "main", {
          links,
          totalFiles,
          totalLinks: links.length,
          uniqueVideoIds: uniqueIds.length,
          timestamp: new Date().toISOString(),
        });

        // 2. Check archive status and queue missing
        const videos: Array<{
          videoId: string;
          title: string;
          channel: string;
          published: string;
          taUrl: string;
          archived: boolean;
        }> = [];
        const toQueue: string[] = [];

        for (const id of uniqueIds) {
          try {
            const data = await taApi(
              tubearchivistUrl,
              tubearchivistToken,
              "GET",
              `/api/video/${id}/`,
            ) as Record<string, unknown>;
            const channel = data.channel as Record<string, unknown> | undefined;
            videos.push({
              videoId: id,
              title: (data.title as string) || "",
              channel: (channel?.channel_name as string) || "",
              published: (data.published as string) || "",
              taUrl: `${tubearchivistUrl}/video/${id}`,
              archived: true,
            });
          } catch {
            toQueue.push(id);
          }
        }

        if (toQueue.length > 0) {
          await taApi(
            tubearchivistUrl,
            tubearchivistToken,
            "POST",
            "/api/download/",
            {
              data: toQueue.map((id) => ({
                youtube_id: id,
                status: "pending",
              })),
            },
          );
          await taApi(
            tubearchivistUrl,
            tubearchivistToken,
            "POST",
            "/api/task/by-name/download_pending/",
          );
        }

        await context.writeResource("archive", "main", {
          queued: toQueue,
          alreadyArchived: videos,
          notFound: [],
          timestamp: new Date().toISOString(),
        });

        // 3. Add unresolved entries for queued videos
        for (const id of toQueue) {
          videos.push({
            videoId: id,
            title: "",
            channel: "",
            published: "",
            taUrl: `${tubearchivistUrl}/video/${id}`,
            archived: false,
          });
        }

        const handle = await context.writeResource("resolved", "main", {
          videos,
          unresolvedIds: toQueue,
          timestamp: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
