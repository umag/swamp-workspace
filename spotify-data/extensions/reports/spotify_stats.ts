// ---------------------------------------------------------------------------
// @magistr/spotify-stats
//
// A model-scope report over the imported Spotify streams. Deliberately NOT a
// copy of @magistr/lastfm-stats: a Last.fm scrobble records only that a play
// happened, whereas a Spotify export records how long it played, whether it
// was skipped, whether shuffle was on, and why playback started and stopped.
// The statistics that matter here are the ones Last.fm structurally cannot
// answer — listening TIME, skip rate, and completion behaviour.
//
// Cross-source overlap with the Last.fm history is deliberately NOT computed
// here. A model-scope report can only see its own model's data
// (`findAllForModel` is called with this context's own modelType/modelId), and
// no precedent in this repo reads another model from a report. The sanctioned
// surface for that is a WORKFLOW-scope report, whose `stepExecutions[]` carry
// each step's own modelType/modelId/dataHandles — that is where the
// Spotify↔Last.fm match belongs.
// ---------------------------------------------------------------------------

/** Milliseconds a play must reach to count as a listen, per Last.fm's rule. */
const THRESHOLD_MS = 30_000;

/**
 * A data handle as returned by `dataRepository.findAllForModel` — one entry
 * per stored data VERSION, including versions whose `lifecycle` is
 * `"deleted"`. {@link latestPerName} exists to reduce that to one live handle
 * per name.
 */
export type Handle = {
  name: string;
  version: number;
  lifecycle?: string;
  tags?: Record<string, string>;
};

/** The subset of an imported stream this report reads. */
export type StatStream = {
  uts: number;
  artist: string;
  album?: string;
  track: string;
  msPlayed: number;
  skipped?: boolean;
  shuffle?: boolean;
  reasonEnd?: string;
};

type ReportContext = {
  modelType: string;
  modelId: string;
  methodName?: string;
  globalArgs?: Record<string, unknown>;
  methodArgs?: Record<string, unknown>;
  logger: { info: (m: string) => void; warning?: (m: string) => void };
  dataRepository: {
    findAllForModel: (type: string, modelId: string) => Promise<Handle[]>;
    getContent: (
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

/**
 * Collapse a handle list to one live handle per name, newest version. Deleted
 * handles are dropped first, so a name whose every version is deleted
 * disappears rather than resurfacing at an older version.
 */
export function latestPerName<T extends Handle>(handles: T[]): T[] {
  const best = new Map<string, T>();
  for (const h of handles) {
    if (h.lifecycle === "deleted") continue;
    const prior = best.get(h.name);
    if (!prior || h.version > prior.version) best.set(h.name, h);
  }
  return [...best.values()];
}

function tally(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function topN(counts: Map<string, number>, n: number) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, playcount]) => ({ name, playcount }));
}

function topMs(counts: Map<string, number>, n: number) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, ms]) => ({ name, hours: Math.round(ms / 36e5 * 10) / 10 }));
}

/**
 * Derive the statistics payload from a flat run of streams.
 *
 * Two totals are reported and they are NOT interchangeable: `total` counts
 * every stream in the export, while `listens` counts only those that reached
 * the 30s threshold. The second is the number comparable to a Last.fm
 * scrobble count; the first is what actually happened.
 */
export function buildStats(streams: StatStream[]): Record<string, unknown> {
  const byYear: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const byReasonEnd: Record<string, number> = {};

  const artists = new Map<string, number>();
  const tracks = new Map<string, number>();
  const artistMs = new Map<string, number>();

  let msTotal = 0;
  let listens = 0;
  let skipped = 0;
  let shuffled = 0;
  let firstUts: number | undefined;
  let lastUts: number | undefined;

  for (const s of streams) {
    const d = new Date(s.uts * 1000);
    tally(byYear, String(d.getUTCFullYear()));
    tally(byHour, String(d.getUTCHours()));
    if (s.reasonEnd) tally(byReasonEnd, s.reasonEnd);

    msTotal += s.msPlayed;
    if (s.msPlayed >= THRESHOLD_MS) listens++;
    if (s.skipped) skipped++;
    if (s.shuffle) shuffled++;

    artists.set(s.artist, (artists.get(s.artist) ?? 0) + 1);
    artistMs.set(s.artist, (artistMs.get(s.artist) ?? 0) + s.msPlayed);
    const t = `${s.artist} — ${s.track}`;
    tracks.set(t, (tracks.get(t) ?? 0) + 1);

    if (firstUts === undefined || s.uts < firstUts) firstUts = s.uts;
    if (lastUts === undefined || s.uts > lastUts) lastUts = s.uts;
  }

  const total = streams.length;
  return {
    total,
    listens,
    belowThreshold: total - listens,
    skipped,
    skipRate: total ? Math.round(skipped / total * 1000) / 10 : 0,
    shuffled,
    hoursPlayed: Math.round(msTotal / 36e5 * 10) / 10,
    firstUts,
    lastUts,
    uniqueArtists: artists.size,
    uniqueTracks: tracks.size,
    byYear,
    byHour,
    byReasonEnd,
    topArtists: topN(artists, 25),
    topTracks: topN(tracks, 25),
    topArtistsByTime: topMs(artistMs, 25),
  };
}

function bar(count: number, max: number, width = 24): string {
  if (max <= 0) return "";
  return "#".repeat(Math.max(1, Math.round((count / max) * width)));
}

function distribution(title: string, dist: Record<string, number>): string[] {
  const keys = Object.keys(dist).sort((a, b) =>
    /^\d+$/.test(a) && /^\d+$/.test(b)
      ? Number(a) - Number(b)
      : a.localeCompare(b)
  );
  if (keys.length === 0) return [];
  const max = Math.max(...keys.map((k) => dist[k]));
  return [
    `### ${title}`,
    "",
    ...keys.map((k) => `- \`${k.padEnd(10)}\` ${bar(dist[k], max)} ${dist[k]}`),
    "",
  ];
}

function renderMarkdown(stats: Record<string, unknown>): string {
  const total = stats.total as number;
  if (total === 0) {
    return "# Spotify listening\n\nNo streams imported yet — run `import`.";
  }
  const day = (u: unknown) =>
    u ? new Date((u as number) * 1000).toISOString().slice(0, 10) : "?";
  const top = (key: string) =>
    (stats[key] as Array<{ name: string; playcount: number }>)
      .slice(0, 10)
      .map((e, i) => `${i + 1}. ${e.name} — ${e.playcount}`);

  return [
    "# Spotify listening",
    "",
    `**${total.toLocaleString()}** streams from ${day(stats.firstUts)} to ` +
    `${day(stats.lastUts)}, **${stats.hoursPlayed} hours** played.`,
    "",
    `- Reached the 30s listen threshold: ${stats.listens} ` +
    `(${stats.belowThreshold} fell short)`,
    `- Skipped: ${stats.skipped} (${stats.skipRate}%)`,
    `- Unique artists: ${stats.uniqueArtists}`,
    `- Unique tracks: ${stats.uniqueTracks}`,
    "",
    ...distribution("By year", stats.byYear as Record<string, number>),
    ...distribution("By hour (UTC)", stats.byHour as Record<string, number>),
    ...distribution(
      "How playback ended",
      stats.byReasonEnd as Record<string, number>,
    ),
    "### Top artists (by plays)",
    "",
    ...top("topArtists"),
    "",
    "### Top artists (by hours listened)",
    "",
    ...(stats.topArtistsByTime as Array<{ name: string; hours: number }>)
      .slice(0, 10)
      .map((e, i) => `${i + 1}. ${e.name} — ${e.hours}h`),
    "",
    "### Top tracks",
    "",
    ...top("topTracks"),
    "",
  ].join("\n");
}

const decode = (bytes: Uint8Array | null): Record<string, unknown> | null => {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

/**
 * The `@magistr/spotify-stats` model-scope report.
 *
 * Runs after an `import` and short-circuits for any other method — a
 * model-scope report fires after EVERY method on the model, and recomputing
 * the whole history behind a dry-run `inspect` would be waste.
 *
 * Must be required in the model instance YAML to run at all:
 * ```yaml
 * reports:
 *   require:
 *     - name: '@magistr/spotify-stats'
 *       methods: [import]
 * ```
 */
export const report = {
  name: "@magistr/spotify-stats",
  description:
    "Listening statistics from the imported Spotify streaming history: hours " +
    "played, skip rate, completion reasons, per-year and per-hour " +
    "distributions, and top artists by both play count and time listened.",
  scope: "model" as const,
  labels: ["music", "spotify", "listening", "statistics"],

  execute: async (context: ReportContext): Promise<{
    markdown: string;
    json: Record<string, unknown>;
  }> => {
    const method = context.methodName;
    if (method && method !== "import") {
      return {
        markdown: `# Spotify listening\n\nSkipped — this report runs after ` +
          `\`import\`, not \`${method}\`.`,
        json: { status: "skipped", methodName: method },
      };
    }

    const all = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );
    const chunks = latestPerName(all).filter((h) =>
      h.name.startsWith("spotify.")
    );

    if (chunks.length === 0) {
      return {
        markdown:
          "# Spotify listening\n\nNo streams found — run the `import` method " +
          "first.",
        json: { status: "no-data", total: 0 },
      };
    }

    const streams: StatStream[] = [];
    const unreadable: string[] = [];
    for (const handle of chunks.sort((a, b) => a.name.localeCompare(b.name))) {
      const content = decode(
        await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          handle.name,
          handle.version,
        ),
      );
      const rows = content?.streams;
      if (!Array.isArray(rows)) {
        unreadable.push(handle.name);
        context.logger.warning?.(
          `spotify-stats: could not read ${handle.name} v${handle.version}`,
        );
        continue;
      }
      streams.push(...(rows as StatStream[]));
    }

    const stats = buildStats(streams);
    const json: Record<string, unknown> = {
      status: "ok",
      chunks: chunks.length,
      ...stats,
    };
    if (unreadable.length > 0) json.unreadable = unreadable;

    context.logger.info(
      `spotify-stats: ${streams.length} stream(s) across ${chunks.length} ` +
        `year chunk(s)`,
    );

    return { markdown: renderMarkdown(stats), json };
  },
};
