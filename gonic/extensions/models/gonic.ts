import { z } from "npm:zod@4";
import { crypto as stdCrypto } from "jsr:@std/crypto@1";

const GlobalArgsSchema = z.object({
  host: z.string().describe("Gonic host (IP or hostname)"),
  port: z.number().default(4747).describe("Gonic HTTP port"),
  username: z.string().describe("Subsonic API username"),
  password: z.string().meta({ sensitive: true }).describe(
    "Subsonic API password",
  ),
  sshUser: z.string().default("root").describe("SSH user for DB access"),
  dbPath: z.string().default("/data/gonic.db").describe(
    "Path to gonic.db on the host",
  ),
});

// --- Shared helpers ---

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Monotonic disambiguator for dbResult resource names: two calls within the
// same wall-clock second (or even the same millisecond, under a frozen
// Date in tests) get DISTINCT names — a bare timestamp alone is not
// sufficient. Kept alongside the full ms+Z timestamp (belt-and-suspenders).
let dbResultSeq = 0;
function dbResultTag(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${(dbResultSeq++).toString(36)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function md5Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await stdCrypto.subtle.digest("MD5", data);
  return bytesToHex(new Uint8Array(digest));
}

async function buildAuthParams(username: string, password: string) {
  // Subsonic TOKEN auth: t = md5hex(password + salt), s = salt. Never send
  // the password itself (or a trivially-reversible encoding of it) over the
  // wire — gonic's server (ctrlsubsonic/ctrl.go, checkCredsToken) supports
  // this scheme.
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToHex(saltBytes);
  const token = await md5Hex(password + salt);
  return new URLSearchParams({
    u: username,
    t: token,
    s: salt,
    v: "1.15.0",
    c: "swamp",
    f: "json",
  });
}

/**
 * Redact a password (and its hex encoding) from an arbitrary error-ish
 * value. `message` is `unknown` because a fetch rejection is not guaranteed
 * to be an `Error` with a string `.message` — it may be a `DOMException`, a
 * thrown string, or an arbitrary non-Error value; every shape is coerced to
 * a string before redaction. Redacts BOTH the raw password and its hex form
 * (the enc-hex string is what an error URL would embed), plus a generic
 * `enc:<hex>` backstop.
 */
export function redactSecret(message: unknown, password: string): string {
  const text = typeof message === "string"
    ? message
    : message instanceof Error
    ? message.message
    : String(message);
  const hex = bytesToHex(new TextEncoder().encode(password));
  let out = text;
  if (password) out = out.split(password).join("<redacted>");
  if (hex) out = out.split(hex).join("<redacted>");
  return out.replace(/enc:[0-9a-f]{16,}/gi, "enc:<redacted>");
}

/**
 * Build a redacted stand-in for `cause`. `cause` must NEVER be the raw
 * rejection: `Deno.inspect()`, `console.log`, and Deno's own uncaught-error
 * printer all walk and print the `cause` chain (including its `.stack`,
 * whose first line embeds the message), so attaching the original error
 * as-is would silently reopen the exact credential leak this mapper exists
 * to close. This preserves the error's `name` (and a redacted `.stack`, when
 * present) for downstream diagnostics without ever exposing the raw
 * credential.
 */
function redactedCause(err: unknown, password: string): unknown {
  if (err instanceof Error) {
    const r = new Error(redactSecret(err, password));
    r.name = err.name;
    if (typeof err.stack === "string") {
      r.stack = redactSecret(err.stack, password);
    }
    return r;
  }
  return redactSecret(err, password);
}

async function gonicApi(
  host: string,
  port: number,
  username: string,
  password: string,
  endpoint: string,
  extraParams?: Record<string, string | string[]>,
) {
  const params = await buildAuthParams(username, password);
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) {
      if (Array.isArray(v)) {
        for (const val of v) params.append(k, val);
      } else {
        params.append(k, v);
      }
    }
  }
  const url = `http://${host}:${port}/rest/${endpoint}?${params.toString()}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(redactSecret(err, password), {
      cause: redactedCause(err, password),
    });
  }
  if (!resp.ok) {
    throw new Error(
      `Gonic API ${endpoint} failed: ${resp.status} ${await resp.text()}`,
    );
  }
  const json = await resp.json();
  const sr = json["subsonic-response"];
  if (!sr) throw new Error(`Gonic API ${endpoint}: unexpected response format`);
  if (sr.status === "failed") {
    const err = sr.error || {};
    throw new Error(
      `Gonic API ${endpoint}: ${
        err.message || "unknown error"
      } (code ${err.code})`,
    );
  }
  return sr;
}

// --- Schemas ---

const PodcastEpisodeSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  publishDate: z.string().optional(),
  size: z.number().optional(),
  duration: z.number().optional(),
  path: z.string().optional(),
});

const PodcastChannelSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  errorMessage: z.string().optional(),
  episode: z.array(PodcastEpisodeSchema).optional(),
});

const PodcastsSchema = z.object({
  channels: z.array(PodcastChannelSchema),
  timestamp: z.iso.datetime(),
});

const ScanStatusSchema = z.object({
  scanning: z.boolean(),
  count: z.number(),
  timestamp: z.iso.datetime(),
});

const PlaylistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string().optional(),
  songCount: z.number(),
  duration: z.number(),
  created: z.string().optional(),
  changed: z.string().optional(),
});

const PlaylistsSchema = z.object({
  playlists: z.array(PlaylistSummarySchema),
  timestamp: z.iso.datetime(),
});

const ServerStatusSchema = z.object({
  status: z.string(),
  version: z.string(),
  type: z.string().optional(),
  serverVersion: z.string().optional(),
  openSubsonic: z.boolean().optional(),
  timestamp: z.iso.datetime(),
});

const DbResultSchema = z.object({
  query: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
  timestamp: z.iso.datetime(),
});

// --- SSH helper ---

async function sshCommand(host: string, sshUser: string, command: string) {
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
    throw new Error(`SSH command failed: ${stderr || stdout}`);
  }
  return stdout;
}

async function sshExecSql(
  host: string,
  sshUser: string,
  dbPath: string,
  sql: string,
  jsonMode: boolean,
  readOnly = false,
) {
  const flags = [jsonMode ? "-json" : null, readOnly ? "-readonly" : null]
    .filter(Boolean).join(" ");
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
      `sqlite3 ${flags} ${shellEsc(dbPath)}`,
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
    // Filter SSH warnings from real errors; if nothing real remains, fall
    // back to the raw stderr/stdout so a warning-only failure is never
    // silently swallowed.
    const realErrors = stderr.split("\n").filter((l) =>
      !l.includes("Warning: Permanently added") && l.trim()
    ).join("\n");
    throw new Error(
      `sqlite3 failed: ${
        realErrors || stderr.trim() || stdout.trim() || "unknown error"
      }`,
    );
  }
  return stdout;
}

// --- Model ---

/**
 * Gonic Subsonic-compatible music server model: browse, search, stream, and
 * scrobble via the Subsonic REST API, manage podcasts and library scans, plus
 * direct SQLite maintenance helpers over SSH.
 */
export const model = {
  type: "@magistr/gonic",
  version: "2026.08.02.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.02.1",
      description:
        "Real-fix LB3-LB9 (read-only db-query, connection-scoped db-exec " +
        "change count, network-error redaction, dbResult name " +
        "disambiguation, surfaced warning-only SSH failures). No " +
        "globalArguments/schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    podcasts: {
      description: "Podcast channels with episodes",
      schema: PodcastsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    scanStatus: {
      description: "Library scan status",
      schema: ScanStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    playlists: {
      description: "Playlist summaries",
      schema: PlaylistsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    serverStatus: {
      description: "Server status info",
      schema: ServerStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dbResult: {
      description: "Database query result",
      schema: DbResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ping: {
      description: "Test connectivity to the Gonic server",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, port, username, password } = context.globalArgs;
        const sr = await gonicApi(host, port, username, password, "ping");
        const handle = await context.writeResource("serverStatus", "current", {
          status: sr.status,
          version: sr.version,
          type: sr.type,
          serverVersion: sr.serverVersion,
          openSubsonic: sr.openSubsonic,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-podcasts": {
      description: "List all podcast channels with episodes",
      arguments: z.object({
        includeEpisodes: z
          .boolean()
          .default(true)
          .describe("Include episodes in response"),
      }),
      execute: async (args, context) => {
        const { host, port, username, password } = context.globalArgs;
        const sr = await gonicApi(
          host,
          port,
          username,
          password,
          "getPodcasts",
          {
            includeEpisodes: String(args.includeEpisodes),
          },
        );
        const channels = sr.podcasts?.channel || [];
        const handle = await context.writeResource("podcasts", "current", {
          channels: channels.map((ch) => ({
            id: ch.id,
            url: ch.url,
            title: ch.title || "",
            description: ch.description,
            status: ch.status || "unknown",
            errorMessage: ch.errorMessage,
            episode: (ch.episode || []).map((ep) => ({
              id: ep.id,
              channelId: ep.channelId || ch.id,
              title: ep.title || "",
              description: ep.description,
              status: ep.status || "unknown",
              publishDate: ep.publishDate,
              size: ep.size,
              duration: ep.duration,
              path: ep.path,
            })),
          })),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "refresh-podcasts": {
      description: "Refresh all podcast feeds (admin only)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, port, username, password } = context.globalArgs;
        await gonicApi(host, port, username, password, "refreshPodcasts");
        return { dataHandles: [] };
      },
    },

    "delete-podcast-channel": {
      description: "Delete a podcast channel by ID (admin only)",
      arguments: z.object({
        id: z.string().describe("Podcast channel ID (e.g. pd-5)"),
      }),
      execute: async (args, context) => {
        const { host, port, username, password } = context.globalArgs;
        await gonicApi(host, port, username, password, "deletePodcastChannel", {
          id: args.id,
        });
        return { dataHandles: [] };
      },
    },

    "delete-podcast-episode": {
      description: "Delete a podcast episode by ID (admin only)",
      arguments: z.object({
        id: z.string().describe("Podcast episode ID (e.g. pe-42)"),
      }),
      execute: async (args, context) => {
        const { host, port, username, password } = context.globalArgs;
        await gonicApi(host, port, username, password, "deletePodcastEpisode", {
          id: args.id,
        });
        return { dataHandles: [] };
      },
    },

    "download-podcast-episode": {
      description: "Trigger download of a podcast episode (admin only)",
      arguments: z.object({
        id: z.string().describe("Podcast episode ID (e.g. pe-42)"),
      }),
      execute: async (args, context) => {
        const { host, port, username, password } = context.globalArgs;
        await gonicApi(
          host,
          port,
          username,
          password,
          "downloadPodcastEpisode",
          { id: args.id },
        );
        return { dataHandles: [] };
      },
    },

    "scan-status": {
      description: "Get current library scan status",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, port, username, password } = context.globalArgs;
        const sr = await gonicApi(
          host,
          port,
          username,
          password,
          "getScanStatus",
        );
        const scan = sr.scanStatus || {};
        const handle = await context.writeResource("scanStatus", "current", {
          scanning: scan.scanning || false,
          count: scan.count || 0,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "start-scan": {
      description: "Trigger a library rescan",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, port, username, password } = context.globalArgs;
        const sr = await gonicApi(host, port, username, password, "startScan");
        const scan = sr.scanStatus || {};
        const handle = await context.writeResource("scanStatus", "current", {
          scanning: scan.scanning || false,
          count: scan.count || 0,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-playlists": {
      description: "List all playlists",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, port, username, password } = context.globalArgs;
        const sr = await gonicApi(
          host,
          port,
          username,
          password,
          "getPlaylists",
        );
        const lists = sr.playlists?.playlist || [];
        const handle = await context.writeResource("playlists", "current", {
          playlists: lists.map((pl) => ({
            id: pl.id,
            name: pl.name || "",
            owner: pl.owner,
            songCount: pl.songCount || 0,
            duration: pl.duration || 0,
            created: pl.created,
            changed: pl.changed,
          })),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "ensure-podcast-dirs": {
      description:
        "Create missing podcast directories on the host for all channels",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { host, sshUser, dbPath } = context.globalArgs;
        const stdout = await sshExecSql(
          host,
          sshUser,
          dbPath,
          "SELECT id, title, root_dir FROM podcasts",
          true,
        );
        const podcasts: Array<Record<string, unknown>> = stdout.trim()
          ? JSON.parse(stdout)
          : [];
        // Get the base podcast mount from the container config
        // root_dir is a container path like /podcasts/Foo, host path is derived from mount
        // We need to find the host mount for /podcasts — read it from docker inspect
        const dockerOut = await sshCommand(
          host,
          sshUser,
          `docker inspect gonic --format '{{range .Mounts}}{{if eq .Destination "/podcasts"}}{{.Source}}{{end}}{{end}}'`,
        );
        const hostBase = dockerOut.trim();
        if (!hostBase) {
          throw new Error("Could not find /podcasts mount on gonic container");
        }

        const created: Array<Record<string, unknown>> = [];
        for (const p of podcasts) {
          // root_dir = /podcasts/SubDir → hostDir = hostBase/SubDir
          const subdir = String(p.root_dir).replace(/^\/podcasts\/?/, "");
          if (!subdir) continue;
          const hostDir = `${hostBase}/${subdir}`;
          await sshCommand(host, sshUser, `mkdir -p ${shellEsc(hostDir)}`);
          created.push({ id: p.id, title: p.title, dir: hostDir });
        }

        const ts = dbResultTag();
        const handle = await context.writeResource("dbResult", `dirs-${ts}`, {
          query: "ensure-podcast-dirs",
          rows: created,
          rowCount: created.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "db-query": {
      description: "Run a read-only SQL query on the gonic database",
      arguments: z.object({
        sql: z.string().describe("SQL SELECT query to run"),
      }),
      execute: async (args, context) => {
        const { host, sshUser, dbPath } = context.globalArgs;
        const stdout = await sshExecSql(
          host,
          sshUser,
          dbPath,
          args.sql,
          true,
          true,
        );
        const rows = stdout.trim() ? JSON.parse(stdout) : [];
        const ts = dbResultTag();
        const handle = await context.writeResource("dbResult", `query-${ts}`, {
          query: args.sql,
          rows,
          rowCount: rows.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "db-exec": {
      description:
        "Run a write SQL statement on the gonic database (DELETE, UPDATE, INSERT)",
      arguments: z.object({
        sql: z.string().describe("SQL statement to execute"),
      }),
      execute: async (args, context) => {
        const { host, sshUser, dbPath } = context.globalArgs;
        // Run the write and `SELECT changes()` on the SAME sqlite3
        // connection (single sshExecSql session) so the reported count is
        // actually derived from this statement's own effect, not a fresh,
        // structurally-disconnected connection.
        const combined = `${args.sql};\nSELECT changes();`;
        const out = await sshExecSql(host, sshUser, dbPath, combined, false);
        const lines = out.trim().split("\n").filter((l) => l.trim());
        const changes = parseInt(lines[lines.length - 1]?.trim() ?? "", 10) ||
          0;
        const ts = dbResultTag();
        const handle = await context.writeResource("dbResult", `exec-${ts}`, {
          query: args.sql,
          rows: [{ changes }],
          rowCount: 1,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
