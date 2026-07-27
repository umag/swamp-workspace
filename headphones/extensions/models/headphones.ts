import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  host: z
    .string()
    .describe("Headphones URL (e.g., http://localhost:8181)"),
  apiKey: z
    .string()
    .describe(
      "API key - use vault: ${{ vault.get(my-vault, HEADPHONES_API_KEY) }}",
    ),
  sshHost: z
    .string()
    .optional()
    .describe("SSH host for direct DB/FS access (used by audit-library)"),
  sshUser: z
    .string()
    .default("root")
    .describe("SSH user (default: root)"),
  dbPath: z
    .string()
    .default("/config/headphones.db")
    .describe("Path to headphones.db on the SSH host"),
  musicDir: z
    .string()
    .default("/music")
    .describe("Music library root on the SSH host"),
});

// The 14 extra release types offered by the getExtras form, in form order.
const EXTRA_TYPES = [
  "single",
  "ep",
  "compilation",
  "soundtrack",
  "live",
  "remix",
  "spokenword",
  "audiobook",
  "other",
  "dj-mix",
  "mixtape/street",
  "broadcast",
  "interview",
  "demo",
] as const;

// Sensible default for a band: real releases, not interviews/audiobooks/broadcasts.
const DEFAULT_EXTRA_TYPES: readonly (typeof EXTRA_TYPES)[number][] = [
  "ep",
  "single",
  "live",
  "compilation",
  "demo",
];

// --- helpers ---

async function api(
  host: string,
  apiKey: string,
  cmd: string,
  params: Record<string, string> = {},
) {
  const url = new URL(`${host.replace(/\/+$/, "")}/api`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("cmd", cmd);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  // Bound every request so a stalled instance can't hang a method indefinitely
  // (the onboard-artists poll loop relies on this to honour timeoutSeconds).
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `API ${cmd} failed: ${response.status} - ${body.slice(0, 200)}`,
    );
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Headphones' JSON API has no command for per-artist extras; the only surface is
// the web UI's getExtras form (GET /getExtras?ArtistID=..&newstyle=true&<type>=1).
// It sets IncludeExtras + Extras on the artist, then re-imports it from MusicBrainz.
async function webUi(
  host: string,
  path: string,
  params: Record<string, string>,
) {
  const url = new URL(`${host.replace(/\/+$/, "")}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${path} failed: ${response.status} - ${body.slice(0, 200)}`,
    );
  }
  return await response.text();
}

// --- SSH helpers (for audit-library) ---

async function sshCommand(
  host: string,
  sshUser: string,
  command: string,
): Promise<string> {
  const cmd = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      `${sshUser}@${host}`,
      command,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    const real = stderr.split("\n").filter((l) =>
      !l.includes("Warning: Permanently added") && l.trim()
    ).join("\n");
    throw new Error(`SSH failed: ${real || stdout}`);
  }
  return stdout;
}

async function sshExecSql(
  host: string,
  sshUser: string,
  dbPath: string,
  sql: string,
): Promise<unknown[]> {
  const cmd = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      `${sshUser}@${host}`,
      `sqlite3 -json '${dbPath}'`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql + "\n"));
  await writer.close();
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    const real = stderr.split("\n").filter((l) =>
      !l.includes("Warning: Permanently added") && l.trim()
    ).join("\n");
    if (real) throw new Error(`sqlite3 failed: ${real}`);
  }
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as unknown[];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- resource schemas ---

const ArtistSchema = z.object({
  ArtistID: z.string(),
  ArtistName: z.string(),
  Status: z.string().optional(),
}).passthrough();

const AlbumSchema = z.object({
  AlbumID: z.string(),
  AlbumTitle: z.string(),
  ArtistName: z.string().optional(),
  ReleaseDate: z.string().optional(),
  Status: z.string().optional(),
}).passthrough();

const TrackSchema = z.object({
  TrackID: z.string().optional(),
  TrackTitle: z.string().optional(),
  TrackNumber: z.number().optional(),
}).passthrough();

const HistoryItemSchema = z.object({
  Title: z.string().optional(),
  Status: z.string().optional(),
  DateAdded: z.string().optional(),
}).passthrough();

const VersionSchema = z.object({
  git_path: z.string().optional(),
  install_type: z.string().optional(),
  current_version: z.string().optional(),
  latest_version: z.string().optional(),
  commits_behind: z.number().optional(),
}).passthrough();

const SearchResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({}).passthrough()),
  total: z.number(),
  timestamp: z.string(),
});

const TaskResultSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});

/**
 * Headphones music-download automation model. Wraps the Headphones JSON API to
 * manage artists, albums, and the wanted queue, plus an optional SSH-backed
 * `audit-library` method that cross-checks the DB against the music filesystem.
 */
export const model = {
  type: "@magistr/headphones",
  version: "2026.07.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    artists: {
      description: "Artist listing",
      schema: z.object({
        artists: z.array(ArtistSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    onboarding: {
      description:
        "Result of onboarding artists: extras enabled and discographies queued",
      schema: z.object({
        artists: z.array(
          z.object({
            artistId: z.string(),
            artistName: z.string(),
            extras: z.array(z.string()),
            loaded: z.boolean(),
            totalAlbums: z.number(),
            queued: z.number(),
            alreadyActive: z.number(),
            failed: z.array(
              z.object({
                albumId: z.string(),
                title: z.string(),
                error: z.string(),
              }),
            ),
            // Set when the artist itself could not be onboarded (bad ID, import
            // failure); the rest of the batch still proceeds.
            error: z.string().optional(),
          }),
        ),
        totalQueued: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    artist: {
      description: "Single artist detail with albums",
      schema: z.object({
        artist: ArtistSchema,
        albums: z.array(AlbumSchema),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    album: {
      description: "Album detail with tracks",
      schema: z.object({
        album: AlbumSchema,
        tracks: z.array(TrackSchema),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    albums: {
      description: "Album listing (wanted/upcoming/snatched)",
      schema: z.object({
        albums: z.array(AlbumSchema),
        total: z.number(),
        category: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    history: {
      description: "Download history",
      schema: z.object({
        items: z.array(HistoryItemSchema),
        total: z.number(),
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
    version: {
      description: "Version information",
      schema: VersionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    task: {
      description: "Task/action result",
      schema: TaskResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    logs: {
      description: "Application logs",
      schema: z.object({
        logs: z.array(z.string()),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    audit: {
      description:
        "Library audit: albums marked Downloaded in headphones DB but absent from filesystem",
      schema: z.object({
        totalDownloaded: z.number(),
        presentOnDisk: z.number(),
        missingCount: z.number(),
        musicDir: z.string(),
        dbPath: z.string(),
        scannedDirs: z.number(),
        missing: z.array(z.object({
          AlbumID: z.string(),
          ArtistName: z.string(),
          AlbumTitle: z.string(),
          ReleaseDate: z.string().nullable().optional(),
        })),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // --- Artist methods ---

    "get-index": {
      description: "List all artists in the library",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getIndex");
        const artists = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("artists", "all", {
          artists,
          total: artists.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-artist": {
      description: "Get artist details and albums by MusicBrainz ID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getArtist", { id: args.id });
        const handle = await context.writeResource("artist", args.id, {
          artist: data.artist || data,
          albums: data.albums || [],
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "find-artist": {
      description: "Search for artists by name via MusicBrainz",
      arguments: z.object({
        name: z.string().describe("Artist name to search"),
        limit: z.number().optional().describe("Max results (default 50)"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const params: Record<string, string> = { name: args.name };
        if (args.limit) params.limit = String(args.limit);
        const data = await api(host, apiKey, "findArtist", params);
        const results = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("search", "find-artist", {
          query: args.name,
          results,
          total: results.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "add-artist": {
      description: "Add an artist to the library by MusicBrainz ID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "addArtist", { id: args.id });
        const handle = await context.writeResource("task", "add-artist", {
          message: `Added artist ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "set-extras": {
      description:
        "Enable extra release types (EPs, singles, live, etc.) for an artist and re-import its discography from MusicBrainz",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
        types: z
          .array(z.enum(EXTRA_TYPES))
          .optional()
          .describe(
            `Extra release types to include (default: ${
              DEFAULT_EXTRA_TYPES.join(", ")
            }). Valid: ${EXTRA_TYPES.join(", ")}`,
          ),
      }),
      execute: async (args, context) => {
        const { host } = context.globalArgs;
        const types = args.types?.length ? args.types : DEFAULT_EXTRA_TYPES;
        const params: Record<string, string> = {
          ArtistID: args.id,
          newstyle: "true",
        };
        // The form submits only the checked boxes; each checked type is "<type>=1".
        for (const t of types) params[t] = "1";
        await webUi(host, "getExtras", params);
        const handle = await context.writeResource("task", "set-extras", {
          message: `Enabled extras for artist ${args.id}: ${types.join(", ")}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "onboard-artists": {
      description:
        "Fan-out: add artists, enable extras, wait for the MusicBrainz import to settle, and queue every not-yet-active release. Idempotent — releases already Wanted/Snatched/Downloaded are left alone.",
      arguments: z.object({
        ids: z.array(z.string()).describe("MusicBrainz artist IDs"),
        types: z
          .array(z.enum(EXTRA_TYPES))
          .optional()
          .describe(
            `Extra release types to include (default: ${
              DEFAULT_EXTRA_TYPES.join(", ")
            })`,
          ),
        queue: z
          .boolean()
          .optional()
          .describe("Queue the releases after import (default: true)"),
        timeoutSeconds: z
          .number()
          .optional()
          .describe(
            "Max wait per artist for the import to settle (default: 240)",
          ),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const types = args.types?.length ? args.types : DEFAULT_EXTRA_TYPES;
        const doQueue = args.queue !== false;
        const timeoutMs = (args.timeoutSeconds ?? 240) * 1000;
        type AlbumFailure = { albumId: string; title: string; error: string };
        type ArtistSummary = {
          artistId: string;
          artistName: string;
          extras: string[];
          loaded: boolean;
          totalAlbums: number;
          queued: number;
          alreadyActive: number;
          failed: AlbumFailure[];
          error?: string;
        };
        const summaries: ArtistSummary[] = [];
        let totalQueued = 0;

        for (const id of args.ids) {
          // One bad ID (typo, deleted artist, transient failure) must not abort
          // the whole batch or discard the summaries already collected — record
          // a per-artist error and move on. Re-running is safe (idempotent).
          try {
            await api(host, apiKey, "addArtist", { id });

            const extrasParams: Record<string, string> = {
              ArtistID: id,
              newstyle: "true",
            };
            for (const t of types) extrasParams[t] = "1";
            await webUi(host, "getExtras", extrasParams);

            // Both addArtist and getExtras kick off async MusicBrainz imports;
            // querying before they settle returns a partial discography.
            const deadline = Date.now() + timeoutMs;
            let row: Record<string, unknown> = {};
            let albums: Record<string, unknown>[] = [];
            let loaded = false;
            while (Date.now() < deadline) {
              const data = await api(host, apiKey, "getArtist", { id });
              row =
                (Array.isArray(data.artist) ? data.artist[0] : data.artist) ??
                  {};
              albums = Array.isArray(data.albums) ? data.albums : [];
              if (row.Status !== "Loading") {
                loaded = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 5000));
            }

            // Only null/empty/Skipped are inert; Wanted/Snatched/Downloaded are
            // already in flight and must not be re-queued.
            const pending = albums.filter((a) => {
              const s = a.Status;
              return s === null || s === undefined || s === "" ||
                s === "Skipped";
            });

            const failed: AlbumFailure[] = [];
            let queued = 0;
            if (doQueue) {
              for (const a of pending) {
                const albumId = String(a.AlbumID ?? "");
                try {
                  await api(host, apiKey, "queueAlbum", { id: albumId });
                  queued++;
                } catch (e) {
                  failed.push({
                    albumId,
                    title: String(a.AlbumTitle ?? ""),
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }
            totalQueued += queued;

            summaries.push({
              artistId: id,
              artistName: String(row.ArtistName ?? ""),
              extras: [...types],
              loaded,
              totalAlbums: albums.length,
              queued,
              alreadyActive: albums.length - pending.length,
              failed,
            });
          } catch (e) {
            summaries.push({
              artistId: id,
              artistName: "",
              extras: [...types],
              loaded: false,
              totalAlbums: 0,
              queued: 0,
              alreadyActive: 0,
              failed: [],
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const handle = await context.writeResource(
          "onboarding",
          "onboard-artists",
          {
            artists: summaries,
            totalQueued,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "del-artist": {
      description: "Remove an artist from the library",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "delArtist", { id: args.id });
        const handle = await context.writeResource("task", "del-artist", {
          message: `Deleted artist ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "pause-artist": {
      description: "Pause monitoring an artist",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "pauseArtist", { id: args.id });
        const handle = await context.writeResource("task", "pause-artist", {
          message: `Paused artist ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "resume-artist": {
      description: "Resume monitoring a paused artist",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "resumeArtist", { id: args.id });
        const handle = await context.writeResource("task", "resume-artist", {
          message: `Resumed artist ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "refresh-artist": {
      description: "Refresh artist data from MusicBrainz",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "refreshArtist", { id: args.id });
        const handle = await context.writeResource("task", "refresh-artist", {
          message: `Refreshed artist ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Album methods ---

    "get-album": {
      description: "Get album details and tracks by MusicBrainz ID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz album/release-group ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getAlbum", { id: args.id });
        const handle = await context.writeResource("album", args.id, {
          album: data.album || data,
          tracks: data.tracks || [],
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "add-album": {
      description: "Add an album to the library",
      arguments: z.object({
        id: z.string().describe("MusicBrainz album/release-group ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "addAlbum", { id: args.id });
        const handle = await context.writeResource("task", "add-album", {
          message: `Added album ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "find-album": {
      description: "Search for albums by name via MusicBrainz",
      arguments: z.object({
        name: z.string().describe("Album name to search"),
        limit: z.number().optional().describe("Max results (default 50)"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const params: Record<string, string> = { name: args.name };
        if (args.limit) params.limit = String(args.limit);
        const data = await api(host, apiKey, "findAlbum", params);
        const results = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("search", "find-album", {
          query: args.name,
          results,
          total: results.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "queue-album": {
      description: "Mark album as wanted and search for it",
      arguments: z.object({
        id: z.string().describe("MusicBrainz album/release-group ID"),
        lossless: z.boolean().optional().describe("Search for lossless only"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const params: Record<string, string> = { id: args.id };
        if (args.lossless) params.lossless = "1";
        await api(host, apiKey, "queueAlbum", params);
        const handle = await context.writeResource("task", "queue-album", {
          message: `Queued album ${args.id} for download`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "unqueue-album": {
      description: "Skip/unqueue an album (set status to Skipped)",
      arguments: z.object({
        id: z.string().describe("MusicBrainz album/release-group ID"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "unqueueAlbum", { id: args.id });
        const handle = await context.writeResource("task", "unqueue-album", {
          message: `Unqueued album ${args.id}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- List methods ---

    "get-wanted": {
      description: "List all wanted albums",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getWanted");
        const albums = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("albums", "wanted", {
          albums,
          total: albums.length,
          category: "wanted",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-snatched": {
      description: "List all snatched albums",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getSnatched");
        const albums = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("albums", "snatched", {
          albums,
          total: albums.length,
          category: "snatched",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-upcoming": {
      description: "List albums with future release dates",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getUpcoming");
        const albums = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("albums", "upcoming", {
          albums,
          total: albums.length,
          category: "upcoming",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-history": {
      description: "Get download history",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getHistory");
        const items = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("history", "all", {
          items,
          total: items.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- System methods ---

    "force-search": {
      description: "Force an immediate search for all wanted albums",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "forceSearch");
        const handle = await context.writeResource("task", "force-search", {
          message: "Forced album search initiated",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "force-process": {
      description: "Force post-processing of a download directory",
      arguments: z.object({
        dir: z.string().optional().describe("Directory to process"),
      }),
      execute: async (args, context) => {
        const { host, apiKey } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.dir) params.dir = args.dir;
        await api(host, apiKey, "forceProcess", params);
        const handle = await context.writeResource("task", "force-process", {
          message: `Post-processing initiated${
            args.dir ? ` for ${args.dir}` : ""
          }`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "force-active-artists-update": {
      description: "Force update of all active artists from MusicBrainz",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "forceActiveArtistsUpdate");
        const handle = await context.writeResource("task", "force-update", {
          message: "Active artists update initiated",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-version": {
      description: "Get Headphones version information",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getVersion");
        const handle = await context.writeResource("version", "current", {
          ...data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "check-github": {
      description: "Check GitHub for available updates",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "checkGithub");
        const handle = await context.writeResource("version", "update-check", {
          ...data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-logs": {
      description: "Get application logs",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        const data = await api(host, apiKey, "getLogs");
        const logs = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("logs", "current", {
          logs,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "clear-logs": {
      description: "Clear application logs",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "clearLogs");
        const handle = await context.writeResource("task", "clear-logs", {
          message: "Logs cleared",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    restart: {
      description: "Restart Headphones",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "restart");
        const handle = await context.writeResource("task", "restart", {
          message: "Restart initiated",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Trigger Headphones application update",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, apiKey } = context.globalArgs;
        await api(host, apiKey, "update");
        const handle = await context.writeResource("task", "update", {
          message: "Update initiated",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Library audit ---

    "audit-library": {
      description:
        "Cross-check headphones DB (Status=Downloaded) against the music filesystem; report albums marked downloaded but absent from disk. Requires sshHost in globalArgs.",
      arguments: z.object({
        requireArtist: z.boolean().optional().describe(
          "Also require artist name to appear in folder path (default: true). Set false for looser matching.",
        ),
        maxDepth: z.number().optional().describe(
          "Filesystem search depth under musicDir (default: 4)",
        ),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, dbPath, musicDir } = context.globalArgs;
        if (!sshHost) {
          throw new Error(
            "sshHost must be set in globalArguments for audit-library",
          );
        }
        const requireArtist = args.requireArtist ?? true;
        const maxDepth = args.maxDepth ?? 4;

        const sql =
          `SELECT AlbumID, ArtistName, AlbumTitle, ReleaseDate FROM albums WHERE Status='Downloaded' ORDER BY ReleaseDate DESC;`;
        const downloaded = await sshExecSql(
          sshHost,
          sshUser,
          dbPath,
          sql,
        ) as Array<{
          AlbumID: string;
          ArtistName: string;
          AlbumTitle: string;
          ReleaseDate: string | null;
        }>;

        const dirsRaw = await sshCommand(
          sshHost,
          sshUser,
          `find '${musicDir}' -mindepth 1 -maxdepth ${maxDepth} -type d 2>/dev/null`,
        );
        const dirs = dirsRaw
          .split("\n")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((raw) => ({ raw, norm: normalize(raw) }));

        const missing: typeof downloaded = [];
        let presentCount = 0;
        for (const album of downloaded) {
          const titleNorm = normalize(album.AlbumTitle);
          const artistNorm = normalize(album.ArtistName);
          if (titleNorm.length < 2) continue;
          const found = dirs.some((d) =>
            d.norm.includes(titleNorm) &&
            (!requireArtist || artistNorm.length < 2 ||
              d.norm.includes(artistNorm))
          );
          if (found) {
            presentCount++;
          } else {
            missing.push(album);
          }
        }

        const handle = await context.writeResource("audit", "library", {
          totalDownloaded: downloaded.length,
          presentOnDisk: presentCount,
          missingCount: missing.length,
          musicDir,
          dbPath,
          scannedDirs: dirs.length,
          missing,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
