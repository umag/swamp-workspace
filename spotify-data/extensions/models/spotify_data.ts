import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// @magistr/spotify-data
//
// Import a Spotify "Extended streaming history" GDPR export into swamp
// resources — one `spotify.<year>` chunk per calendar year, mirroring the
// partitioning @magistr/lastfm uses for scrobbles so the two sources sit
// alongside each other and stay comparable.
//
// This is an OFFLINE importer. It makes no network call and needs no
// credential: the export is a ZIP Spotify emails you from
// https://www.spotify.com/account/privacy/. The Web API cannot substitute for
// it — `recently-played` returns only the last 50 tracks, so the export is the
// single source for a lifetime history.
//
// Two decisions shape the whole model:
//
//  1. PRIVACY. Every record in the export carries `ip_addr`, and most carry
//     `conn_country`, `platform` and `incognito_mode`. That is a location and
//     device trail, not listening data. All four are dropped at the parse
//     boundary and never reach a resource — see `toStream`. The export file
//     itself stays wherever the user put it; this model only ever reads it.
//
//  2. FIDELITY. Podcast episodes are excluded (a different kind of thing from
//     a music play, and they pollute artist/track statistics), but every music
//     stream is kept regardless of how briefly it played. Last.fm only ever
//     recorded plays past its ~30s scrobble threshold, so the sub-threshold
//     tail is information Last.fm structurally could not hold — discarding it
//     at import would throw away the one thing this source adds. Filtering by
//     `msPlayed` is a read-time concern, applied by the report.
// ---------------------------------------------------------------------------

/** Spotify's own scrobble-equivalent threshold, in milliseconds. */
export const SCROBBLE_THRESHOLD_MS = 30_000;

const GlobalArgsSchema = z.object({
  exportPath: z
    .string()
    .min(1)
    .describe(
      "Path to the Spotify export — either the .zip Spotify emailed you or a " +
        "directory it was extracted into. Read-only; never modified.",
    ),
  label: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default("spotify")
    .describe(
      "Identifies this export/account, so two exports can coexist in one repo",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * One music stream, normalized out of a Spotify export record. `uts` is the
 * UNIX second the stream ENDED (Spotify's `ts` is an end timestamp, unlike
 * Last.fm's `date.uts`, which is a start timestamp) — see
 * {@link SPOTIFY_TS_IS_END_TIME} for why that matters when comparing sources.
 *
 * The privacy-bearing fields of the source record (`ip_addr`, `conn_country`,
 * `platform`, `incognito_mode`) are deliberately absent.
 */
export type Stream = {
  uts: number;
  artist: string;
  album?: string;
  track: string;
  trackUri?: string;
  msPlayed: number;
  skipped?: boolean;
  shuffle?: boolean;
  offline?: boolean;
  reasonStart?: string;
  reasonEnd?: string;
};

/**
 * Spotify's `ts` marks when a stream STOPPED; Last.fm's `date.uts` marks when
 * a track STARTED. Any cross-source match must therefore allow at least one
 * track length of drift — which is why the overlap analysis uses a tolerance
 * window rather than timestamp equality.
 */
export const SPOTIFY_TS_IS_END_TIME = true;

/** The execution context swamp passes to a method. */
export type Ctx = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warning?: (msg: string, data?: Record<string, unknown>) => void;
    error?: (msg: string, data?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// deno-lint-ignore no-explicit-any
type Json = any;

// --- parsing ---------------------------------------------------------------

/**
 * Convert an ISO-8601 instant to UNIX seconds, or undefined when it is absent
 * or unparseable. Spotify writes `ts` as `2023-04-01T18:22:05Z`.
 */
export function toUts(ts: unknown): number | undefined {
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** True when a record is a podcast episode rather than a music track. */
export function isPodcast(raw: Json): boolean {
  return typeof raw?.episode_name === "string" && raw.episode_name.length > 0;
}

/** True when a record is an audiobook chapter rather than a music track. */
export function isAudiobook(raw: Json): boolean {
  return typeof raw?.audiobook_title === "string" &&
    raw.audiobook_title.length > 0;
}

/**
 * Normalize one export record into a {@link Stream}, or return undefined when
 * it is not a usable music play.
 *
 * Drops, in order: audiobook chapters, podcast episodes, and any record with
 * no track name or no parseable timestamp. Deliberately never copies
 * `ip_addr`, `conn_country`, `platform` or `incognito_mode` — the privacy
 * boundary is here, at the single point every record must pass through, rather
 * than in a later filter that could be forgotten.
 */
export function toStream(raw: Json): Stream | undefined {
  if (isAudiobook(raw) || isPodcast(raw)) return undefined;

  const track = raw?.master_metadata_track_name;
  const artist = raw?.master_metadata_album_artist_name;
  if (typeof track !== "string" || track.length === 0) return undefined;
  if (typeof artist !== "string" || artist.length === 0) return undefined;

  const uts = toUts(raw?.ts);
  if (uts === undefined) return undefined;

  const album = raw?.master_metadata_album_album_name;
  const msPlayed = typeof raw?.ms_played === "number" && raw.ms_played >= 0
    ? raw.ms_played
    : 0;

  return {
    uts,
    artist,
    track,
    album: typeof album === "string" && album.length > 0 ? album : undefined,
    trackUri: typeof raw?.spotify_track_uri === "string"
      ? raw.spotify_track_uri
      : undefined,
    msPlayed,
    skipped: typeof raw?.skipped === "boolean" ? raw.skipped : undefined,
    shuffle: typeof raw?.shuffle === "boolean" ? raw.shuffle : undefined,
    offline: typeof raw?.offline === "boolean" ? raw.offline : undefined,
    reasonStart: typeof raw?.reason_start === "string"
      ? raw.reason_start
      : undefined,
    reasonEnd: typeof raw?.reason_end === "string" ? raw.reason_end : undefined,
  };
}

/**
 * Identity of a stream: the WHOLE normalized record, not (uts, artist, track).
 *
 * That coarser key looked right and is wrong on real data. A 15,607-record
 * export contains 546 groups sharing (ts, artist, track); 469 of those are
 * byte-identical records -- genuine export artifacts, correct to collapse --
 * but 77 DIFFER, almost always in `ms_played` and sometimes in
 * `reason_start`/`reason_end`. Spotify evidently emits some plays as more than
 * one segment stamped with the same end second. Keying on the triple would
 * discard those as duplicates and silently lose real playback data.
 *
 * Keying on the full record is safe here precisely because `import` rewrites
 * each year chunk FROM the export rather than merging into a prior chunk:
 * dedup is within-export only, so the same export always yields the same rows.
 *
 * The delimiter is NUL, written as an escape so the source stays plain text. A
 * printable separator would be ambiguous: with a space, ("a b","c") and
 * ("a","b c") collide and one real play silently swallows another.
 */
export function streamKey(s: Stream): string {
  return [
    s.uts,
    s.artist,
    s.track,
    s.album ?? "",
    s.trackUri ?? "",
    s.msPlayed,
    s.skipped ?? "",
    s.shuffle ?? "",
    s.offline ?? "",
    s.reasonStart ?? "",
    s.reasonEnd ?? "",
  ].join("\u0000");
}

export function dedupeStreams(rows: Stream[]): Stream[] {
  const seen = new Set<string>();
  const out: Stream[] = [];
  for (const row of rows) {
    const key = streamKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Split streams into UTC calendar years, keyed by year string. */
export function partitionByYear(rows: Stream[]): Map<string, Stream[]> {
  const parts = new Map<string, Stream[]>();
  for (const row of rows) {
    const year = String(new Date(row.uts * 1000).getUTCFullYear());
    const bucket = parts.get(year);
    if (bucket) bucket.push(row);
    else parts.set(year, [row]);
  }
  return parts;
}

/** Kind-suffixed so a chunk cannot collide with another spec's instance. */
export function chunkName(year: string): string {
  return `spotify.${year}`;
}

/**
 * Parse one `Streaming_History_Audio_*.json` payload into streams, reporting
 * what was dropped and why so an import can never silently lose records.
 */
export function parseHistoryFile(json: unknown): {
  streams: Stream[];
  podcasts: number;
  audiobooks: number;
  unusable: number;
} {
  if (!Array.isArray(json)) {
    throw new Error(
      "Malformed history file: expected a JSON array of stream records",
    );
  }
  const streams: Stream[] = [];
  let podcasts = 0;
  let audiobooks = 0;
  let unusable = 0;
  for (const raw of json as Json[]) {
    if (isAudiobook(raw)) {
      audiobooks++;
      continue;
    }
    if (isPodcast(raw)) {
      podcasts++;
      continue;
    }
    const s = toStream(raw);
    if (s) streams.push(s);
    else unusable++;
  }
  return { streams, podcasts, audiobooks, unusable };
}

// --- filesystem ------------------------------------------------------------

const AUDIO_FILE = /Streaming_History_Audio_.*\.json$/i;

/** Recursively collect audio-history JSON files under a directory. */
export async function findHistoryFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for await (const entry of Deno.readDir(d)) {
      const path = `${d}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (AUDIO_FILE.test(entry.name)) out.push(path);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Resolve the export path to a directory of history files. A `.zip` is
 * extracted into a throwaway temp directory (returned as `cleanup`); a
 * directory is used in place and never modified.
 */
export async function resolveExportDir(
  exportPath: string,
): Promise<{ dir: string; cleanup?: string }> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(exportPath);
  } catch {
    throw new Error(`Export path not found: ${exportPath}`);
  }
  if (info.isDirectory) return { dir: exportPath };

  if (!/\.zip$/i.test(exportPath)) {
    throw new Error(
      `Export path must be a directory or a .zip archive: ${exportPath}`,
    );
  }
  const tmp = await Deno.makeTempDir({ prefix: "spotify_export_" });
  const cmd = new Deno.Command("unzip", {
    args: ["-q", "-o", exportPath, "-d", tmp],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw new Error(
      `Failed to extract ${exportPath}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return { dir: tmp, cleanup: tmp };
}

// --- resource schemas ------------------------------------------------------

const StreamSchema = z.object({
  uts: z.number(),
  artist: z.string(),
  album: z.string().optional(),
  track: z.string(),
  trackUri: z.string().optional(),
  msPlayed: z.number(),
  skipped: z.boolean().optional(),
  shuffle: z.boolean().optional(),
  offline: z.boolean().optional(),
  reasonStart: z.string().optional(),
  reasonEnd: z.string().optional(),
});

/**
 * A year chunk carries NO wall-clock field: its content is a pure function of
 * the streams it holds, so re-importing an unchanged export produces
 * byte-identical bytes rather than minting a new data version every run.
 */
const StreamsChunkSchema = z.object({
  label: z.string(),
  year: z.string(),
  count: z.number(),
  firstUts: z.number().optional(),
  lastUts: z.number().optional(),
  msPlayedTotal: z.number(),
  streams: z.array(StreamSchema),
});

const YearCountSchema = z.object({
  year: z.string(),
  count: z.number(),
  msPlayedTotal: z.number(),
});

const ImportStateSchema = z.object({
  label: z.string(),
  sourcePath: z.string(),
  filesRead: z.number(),
  streamsImported: z.number(),
  duplicatesCollapsed: z.number(),
  podcastsSkipped: z.number(),
  audiobooksSkipped: z.number(),
  unusableSkipped: z.number(),
  years: z.array(YearCountSchema),
  firstUts: z.number().optional(),
  lastUts: z.number().optional(),
  importedAt: z.string(),
});

const InspectionSchema = z.object({
  sourcePath: z.string(),
  filesFound: z.array(z.string()),
  totalRecords: z.number(),
  musicStreams: z.number(),
  podcasts: z.number(),
  audiobooks: z.number(),
  unusable: z.number(),
  overThresholdStreams: z.number(),
  years: z.array(YearCountSchema),
  firstUts: z.number().optional(),
  lastUts: z.number().optional(),
  inspectedAt: z.string(),
});

// --- shared read path ------------------------------------------------------

type Gathered = {
  streams: Stream[];
  files: string[];
  totalRecords: number;
  podcasts: number;
  audiobooks: number;
  unusable: number;
};

/** Read and normalize every history file under the resolved export dir. */
async function gather(dir: string, context: Ctx): Promise<Gathered> {
  const files = await findHistoryFiles(dir);
  if (files.length === 0) {
    throw new Error(
      `No Streaming_History_Audio_*.json files under ${dir} — is this an ` +
        `"Extended streaming history" export? The plain "Account data" ` +
        `package holds only one year and uses different filenames.`,
    );
  }
  const streams: Stream[] = [];
  let totalRecords = 0;
  let podcasts = 0;
  let audiobooks = 0;
  let unusable = 0;
  for (const file of files) {
    const json = JSON.parse(await Deno.readTextFile(file));
    const parsed = parseHistoryFile(json);
    totalRecords += Array.isArray(json) ? json.length : 0;
    podcasts += parsed.podcasts;
    audiobooks += parsed.audiobooks;
    unusable += parsed.unusable;
    streams.push(...parsed.streams);
    context.logger.info(
      `${file.split("/").pop()}: ${parsed.streams.length} music stream(s)`,
    );
  }
  return { streams, files, totalRecords, podcasts, audiobooks, unusable };
}

function yearCounts(parts: Map<string, Stream[]>) {
  return [...parts.entries()].sort().map(([year, rows]) => ({
    year,
    count: rows.length,
    msPlayedTotal: rows.reduce((a, r) => a + r.msPlayed, 0),
  }));
}

const bounds = (rows: Stream[]) => ({
  firstUts: rows.length ? Math.min(...rows.map((r) => r.uts)) : undefined,
  lastUts: rows.length ? Math.max(...rows.map((r) => r.uts)) : undefined,
});

// --- model -----------------------------------------------------------------

/**
 * @magistr/spotify-data — offline importer for a Spotify "Extended streaming
 * history" export.
 *
 * `inspect` reports what an export contains without writing any chunk (a
 * dry run); `import` writes one `spotify.<year>` resource per calendar year
 * plus an `import.<label>` state resource. Both are idempotent and neither
 * makes a network call.
 */
export const model = {
  type: "@magistr/spotify-data",
  version: "2026.08.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    streams: {
      description: "One calendar year of Spotify music streams",
      schema: StreamsChunkSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    imports: {
      description: "State of the most recent import for a label",
      schema: ImportStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    inspection: {
      description: "Dry-run summary of an export's contents",
      schema: InspectionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    inspect: {
      description:
        "Report what the export contains — record counts, the music/podcast " +
        "split, per-year distribution and date range — WITHOUT writing any " +
        "year chunk. Use before import to confirm you have the Extended " +
        "history rather than the one-year Account data package.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const { exportPath } = context.globalArgs;
        const { dir, cleanup } = await resolveExportDir(exportPath);
        try {
          const g = await gather(dir, context);
          const deduped = dedupeStreams(g.streams);
          const parts = partitionByYear(deduped);
          const payload = InspectionSchema.parse({
            sourcePath: exportPath,
            filesFound: g.files.map((f) => f.split("/").pop() ?? f),
            totalRecords: g.totalRecords,
            musicStreams: deduped.length,
            podcasts: g.podcasts,
            audiobooks: g.audiobooks,
            unusable: g.unusable,
            overThresholdStreams: deduped.filter((s) =>
              s.msPlayed >= SCROBBLE_THRESHOLD_MS
            ).length,
            years: yearCounts(parts),
            ...bounds(deduped),
            inspectedAt: new Date().toISOString(),
          });
          context.logger.info(
            `inspect: ${deduped.length} music stream(s) across ` +
              `${parts.size} year(s); ${g.podcasts} podcast(s) skipped`,
          );
          const handle = await context.writeResource(
            "inspection",
            `inspection.${context.globalArgs.label}`,
            payload,
          );
          return { dataHandles: [handle] };
        } finally {
          if (cleanup) {
            await Deno.remove(cleanup, { recursive: true }).catch(() => {});
          }
        }
      },
    },

    import: {
      description:
        "Import the export into one `spotify.<year>` resource per calendar " +
        "year, plus an `import.<label>` state resource. Idempotent: " +
        "re-importing the same export rewrites identical bytes. Podcast " +
        "episodes are excluded; every music stream is kept regardless of " +
        "play time, since sub-threshold plays are the one thing a Last.fm " +
        "history structurally cannot hold.",
      arguments: z.object({
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe("Import only this calendar year"),
      }),
      execute: async (args: { year?: string }, context: Ctx) => {
        const { exportPath, label } = context.globalArgs;
        const { dir, cleanup } = await resolveExportDir(exportPath);
        try {
          const g = await gather(dir, context);
          const deduped = dedupeStreams(g.streams);
          const duplicates = g.streams.length - deduped.length;

          let parts = partitionByYear(deduped);
          if (args.year) {
            const only = parts.get(args.year);
            parts = new Map(only ? [[args.year, only]] : []);
          }

          const handles: Array<{ name: string }> = [];
          for (const [year, rows] of [...parts.entries()].sort()) {
            const sorted = [...rows].sort((a, b) => a.uts - b.uts);
            const payload = StreamsChunkSchema.parse({
              label,
              year,
              count: sorted.length,
              firstUts: sorted[0]?.uts,
              lastUts: sorted[sorted.length - 1]?.uts,
              msPlayedTotal: sorted.reduce((a, r) => a + r.msPlayed, 0),
              streams: sorted,
            });
            handles.push(
              await context.writeResource("streams", chunkName(year), payload),
            );
          }

          const imported = [...parts.values()].reduce(
            (a, r) => a + r.length,
            0,
          );
          const state = ImportStateSchema.parse({
            label,
            sourcePath: exportPath,
            filesRead: g.files.length,
            streamsImported: imported,
            duplicatesCollapsed: duplicates,
            podcastsSkipped: g.podcasts,
            audiobooksSkipped: g.audiobooks,
            unusableSkipped: g.unusable,
            years: yearCounts(parts),
            ...bounds([...parts.values()].flat()),
            importedAt: new Date().toISOString(),
          });
          handles.push(
            await context.writeResource("imports", `import.${label}`, state),
          );

          context.logger.info(
            `import: ${imported} stream(s) across ${parts.size} year(s) from ` +
              `${g.files.length} file(s); ${duplicates} duplicate(s) collapsed, ` +
              `${g.podcasts} podcast(s) skipped`,
          );
          return { dataHandles: handles };
        } finally {
          if (cleanup) {
            await Deno.remove(cleanup, { recursive: true }).catch(() => {});
          }
        }
      },
    },
  },
};
