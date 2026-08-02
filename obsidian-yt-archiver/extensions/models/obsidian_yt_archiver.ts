import { z } from "npm:zod@4";
import { isAbsolute, relative, resolve } from "jsr:@std/path@1";

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

/** Every taApi caller passes a fixed-size, sequential id list -- this bounds
 * how large that list may be, so a huge vault/argument can never turn into
 * an unbounded run of sequential per-id HTTP calls (LB5). Enforced by
 * REJECTING (never silently slicing/dropping), before any fetch happens.
 *
 * Both this and the timeout below are module CONSTANTS, not global args:
 * test harnesses pass `globalArgs` raw, never through
 * `model.globalArguments.parse()`, so a zod `.default()` would never fire in
 * tests anyway -- keeping both as constants keeps `GlobalArgsSchema` at
 * exactly 3 keys. */
const MAX_VIDEO_IDS = 500;

function assertVideoIdCap(ids: string[]): void {
  if (ids.length > MAX_VIDEO_IDS) {
    throw new Error(
      `too many video ids: ${ids.length} exceeds the cap of ${MAX_VIDEO_IDS}`,
    );
  }
}

/** Every taApi call must complete within this long, or it is aborted and the
 * failure surfaces like any other transport error (LB4). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/** Thrown for any non-2xx (or redirect/host-mismatch/non-JSON) TubeArchivist
 * response. Carries `.status` so callers can distinguish a genuine "not
 * archived" 404 from every other failure mode (LB3). */
class TaHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TaHttpError";
  }
}

/** True ONLY for a genuine "not archived" signal. Every other taApi failure
 * -- auth/server/timeout/network/redirect/non-JSON -- is NOT "not archived"
 * and must surface (re-thrown), never silently re-queued (LB3). One shared
 * predicate, checked identically at all three per-id call sites. */
function isNotArchived(e: unknown): boolean {
  return e instanceof TaHttpError && e.status === 404;
}

/** Collapses whitespace runs and caps the result at 120 chars, so a
 * thrown-error message can never echo more than a short, greppable snippet
 * of a TubeArchivist response body (LB6). The auth token is never part of
 * this text at all (it is header-only) -- this only bounds body exposure. */
function redactBody(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Confines a caller-supplied videoId to a single, opaque
 * `/api/video/<id>/` path segment. `encodeURIComponent` percent-encodes any
 * `/`, `..`, or host-shaped id into inert characters within that one
 * segment, so it can never reach a different TubeArchivist endpoint (LB1).
 * Every benign id used across the suites (`[A-Za-z0-9_-]`) encodes to
 * itself, so this is IDENTITY for the common case -- one shared helper, used
 * at all three GET-path build sites. */
const taVideoPath = (id: string): string =>
  `/api/video/${encodeURIComponent(id)}/`;

async function taApi(
  host: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  expectJson = true,
): Promise<unknown> {
  const cleanHost = host.replace(/\/+$/, "");
  const url = `${cleanHost}${path}`;
  const expectedHost = new URL(cleanHost).host;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    // Never auto-follow a redirect to a possibly-different host -- handled
    // explicitly below instead (LB7).
    redirect: "manual",
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });

    // A 3xx is not followed (redirect: "manual" above); "opaqueredirect" is
    // what a real cross-origin manual-redirect fetch yields (LB7).
    if (
      res.type === "opaqueredirect" ||
      (res.status >= 300 && res.status < 400)
    ) {
      throw new TaHttpError(
        res.status,
        `TA ${method} ${path}: unexpected redirect (not followed)`,
      );
    }

    // Defense in depth: if the final response URL is ever populated (a real
    // fetch, not a test stub, which leaves it ""), it must still be the same
    // host the operator configured.
    if (res.url) {
      const responseHost = new URL(res.url).host;
      if (responseHost !== expectedHost) {
        throw new TaHttpError(
          res.status,
          `TA ${method} ${path}: response host ${responseHost} != ${expectedHost}`,
        );
      }
    }

    if (!res.ok) {
      const text = await res.text();
      const snippet = redactBody(text);
      throw new TaHttpError(
        res.status,
        `TA ${method} ${path}: ${res.status}${snippet ? ` - ${snippet}` : ""}`,
      );
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      // The two fire-and-forget POSTs don't need a JSON body back; every
      // GET metadata check does -- a non-JSON 2xx there is surfaced, never
      // silently treated as a blank "archived" record (LB8).
      if (!expectJson) return {};
      throw new TaHttpError(
        res.status,
        `TA ${method} ${path}: expected application/json, got "${
          ct || "(none)"
        }"`,
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- Vault filesystem helpers ---

/**
 * Confines a caller-supplied `folder` argument to the vault, LEXICALLY.
 * Rejects an absolute `folder`, or a folder whose vault-relative resolved
 * path is `..` or begins with `../` (i.e. escapes the vault root).
 *
 * Deliberately lexical (resolve/relative) and NOT Deno.realPath: the vault
 * commonly lives under a symlinked temp root (e.g. macOS `/var` resolves to
 * `/private/var`), and realPath would break every legitimate scan of such a
 * vault. Must be called before any filesystem access (readDir/readTextFile).
 */
function assertFolderWithinVault(vaultPath: string, folder: string): void {
  if (isAbsolute(folder)) {
    throw new Error(
      `folder must be relative to the vault, got an absolute path: ${folder}`,
    );
  }
  const rel = relative(resolve(vaultPath), resolve(vaultPath, folder));
  if (rel === ".." || rel.startsWith("../")) {
    throw new Error(`folder escapes the vault: ${folder}`);
  }
}

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
  version: "2026.08.02.1",
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
        if (args.folder) {
          assertFolderWithinVault(vaultPath, args.folder);
        }
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
        assertVideoIdCap(videoIds);

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
              taVideoPath(id),
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
          } catch (e) {
            if (isNotArchived(e)) {
              toQueue.push(id);
            } else {
              throw e;
            }
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
            false,
          );
          // Trigger download
          await taApi(
            tubearchivistUrl,
            tubearchivistToken,
            "POST",
            "/api/task/by-name/download_pending/",
            undefined,
            false,
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
        assertVideoIdCap(videoIds);

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
              taVideoPath(id),
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
          } catch (e) {
            if (isNotArchived(e)) {
              unresolvedIds.push(id);
            } else {
              throw e;
            }
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
        if (args.folder) {
          assertFolderWithinVault(vaultPath, args.folder);
        }
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
        assertVideoIdCap(uniqueIds);

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
              taVideoPath(id),
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
          } catch (e) {
            if (isNotArchived(e)) {
              toQueue.push(id);
            } else {
              throw e;
            }
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
            false,
          );
          await taApi(
            tubearchivistUrl,
            tubearchivistToken,
            "POST",
            "/api/task/by-name/download_pending/",
            undefined,
            false,
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
