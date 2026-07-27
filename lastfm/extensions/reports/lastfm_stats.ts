// ---------------------------------------------------------------------------
// @magistr/lastfm-stats
//
// A model-scope report over the scrobble history synced by @magistr/lastfm.
// This is the StatsProjection domain service: it reads across every year
// partition and returns a report, so it belongs here rather than on a model
// method — CLAUDE.md Rule 8 assigns "transform, aggregate or analyze model
// output" to a report extension.
//
// It answers what the Last.fm API structurally cannot: the API offers six
// fixed chart periods, whereas the synced history supports arbitrary windows,
// per-hour and per-weekday distributions, and streaks.
//
// Two traps in the data layer drive the shape of readChunks():
//   - findAllForModel returns one handle per data VERSION, not per name. With
//     garbageCollection: 10 a chunk keeps up to 10 versions, so folding every
//     handle would multiply every statistic by the retained version count.
//   - it also returns handles whose lifecycle is "deleted".
// Both are filtered before any content is decoded.
// ---------------------------------------------------------------------------

export type Handle = {
  name: string;
  version: number;
  lifecycle?: string;
  tags?: Record<string, string>;
};

export type StatScrobble = {
  uts: number;
  artist: string;
  album?: string;
  track: string;
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
 * Collapse a handle list to one live handle per name, keeping the newest
 * version. Deleted handles are dropped first, so a name whose every version is
 * deleted disappears entirely rather than resurfacing at an older version.
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

// --- statistics ------------------------------------------------------------

/** Parts of a timestamp in a named timezone, falling back to UTC. */
function zonedParts(uts: number, timezone: string) {
  const date = new Date(uts * 1000);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
      hour12: false,
    });
  } catch {
    // An unknown zone must not take down the whole report.
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
      hour12: false,
    });
  }
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  // Intl renders midnight as "24" in hour12:false for some locales/zones.
  const hour = String(Number(parts.hour) % 24);
  return {
    year: parts.year,
    month: `${parts.year}-${parts.month}`,
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour,
  };
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

/** Longest run of consecutive listening days, in the report's timezone. */
function longestStreak(days: Set<string>): number {
  if (days.size === 0) return 0;
  const sorted = [...days].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = Date.parse(`${sorted[i - 1]}T00:00:00Z`);
    const curr = Date.parse(`${sorted[i]}T00:00:00Z`);
    if (curr - prev === 86_400_000) {
      run++;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

export function buildStats(
  scrobbles: StatScrobble[],
  timezone: string,
): Record<string, unknown> {
  const byYear: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  const byWeekday: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const days = new Set<string>();

  const artists = new Map<string, number>();
  const albums = new Map<string, number>();
  const tracks = new Map<string, number>();

  let firstUts: number | undefined;
  let lastUts: number | undefined;

  for (const s of scrobbles) {
    const p = zonedParts(s.uts, timezone);
    tally(byYear, p.year);
    tally(byMonth, p.month);
    tally(byWeekday, p.weekday);
    tally(byHour, p.hour);
    days.add(p.day);

    artists.set(s.artist, (artists.get(s.artist) ?? 0) + 1);
    tracks.set(
      `${s.artist} — ${s.track}`,
      (tracks.get(`${s.artist} — ${s.track}`) ?? 0) + 1,
    );
    if (s.album) {
      albums.set(
        `${s.artist} — ${s.album}`,
        (albums.get(`${s.artist} — ${s.album}`) ?? 0) + 1,
      );
    }

    if (firstUts === undefined || s.uts < firstUts) firstUts = s.uts;
    if (lastUts === undefined || s.uts > lastUts) lastUts = s.uts;
  }

  return {
    total: scrobbles.length,
    timezone,
    firstUts,
    lastUts,
    uniqueArtists: artists.size,
    uniqueAlbums: albums.size,
    uniqueTracks: tracks.size,
    listeningDays: days.size,
    longestStreakDays: longestStreak(days),
    byYear,
    byMonth,
    byWeekday,
    byHour,
    topArtists: topN(artists, 25),
    topAlbums: topN(albums, 25),
    topTracks: topN(tracks, 25),
  };
}

// --- markdown rendering ----------------------------------------------------

function bar(count: number, max: number, width = 24): string {
  if (max <= 0) return "";
  return "█".repeat(Math.max(1, Math.round((count / max) * width)));
}

function distribution(title: string, dist: Record<string, number>): string[] {
  const keys = Object.keys(dist).sort();
  if (keys.length === 0) return [];
  const max = Math.max(...keys.map((k) => dist[k]));
  return [
    `### ${title}`,
    "",
    ...keys.map((k) => `- \`${k.padEnd(7)}\` ${bar(dist[k], max)} ${dist[k]}`),
    "",
  ];
}

function renderMarkdown(stats: Record<string, unknown>): string {
  const total = stats.total as number;
  if (total === 0) {
    return "# Listening statistics\n\nNo scrobbles in the synced history yet.";
  }
  const first = stats.firstUts
    ? new Date((stats.firstUts as number) * 1000).toISOString().slice(0, 10)
    : "?";
  const last = stats.lastUts
    ? new Date((stats.lastUts as number) * 1000).toISOString().slice(0, 10)
    : "?";
  const top = (key: string) =>
    (stats[key] as Array<{ name: string; playcount: number }>)
      .slice(0, 10)
      .map((e, i) => `${i + 1}. ${e.name} — ${e.playcount}`);

  return [
    "# Listening statistics",
    "",
    `**${total.toLocaleString()}** scrobbles from ${first} to ${last} ` +
    `(timezone ${stats.timezone}).`,
    "",
    `- Unique artists: ${stats.uniqueArtists}`,
    `- Unique albums: ${stats.uniqueAlbums}`,
    `- Unique tracks: ${stats.uniqueTracks}`,
    `- Days with listening: ${stats.listeningDays}`,
    `- Longest daily streak: ${stats.longestStreakDays} days`,
    "",
    ...distribution("By year", stats.byYear as Record<string, number>),
    ...distribution("By weekday", stats.byWeekday as Record<string, number>),
    ...distribution("By hour", stats.byHour as Record<string, number>),
    "### Top artists",
    "",
    ...top("topArtists"),
    "",
    "### Top albums",
    "",
    ...top("topAlbums"),
    "",
    "### Top tracks",
    "",
    ...top("topTracks"),
    "",
  ].join("\n");
}

// --- report ----------------------------------------------------------------

const decode = (bytes: Uint8Array | null): Record<string, unknown> | null => {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

export const report = {
  name: "@magistr/lastfm-stats",
  description:
    "Listening statistics derived from the synced scrobble history: " +
    "per-year/month/weekday/hour distributions, unique counts, streaks, and " +
    "top artists/albums/tracks over the whole history.",
  scope: "model" as const,
  labels: ["music", "lastfm", "listening", "statistics"],

  execute: async (context: ReportContext): Promise<{
    markdown: string;
    json: Record<string, unknown>;
  }> => {
    // A model-scope report fires after EVERY method on the model. Recomputing
    // the full history after a cheap lookup would be pure waste, so anything
    // but a history sync short-circuits.
    const method = context.methodName;
    if (method && method !== "sync-history") {
      return {
        markdown:
          `# Listening statistics\n\nSkipped — this report runs after ` +
          `\`sync-history\`, not \`${method}\`.`,
        json: { status: "skipped", methodName: method },
      };
    }

    const timezone = (context.methodArgs?.timezone as string | undefined) ??
      (context.globalArgs?.timezone as string | undefined) ??
      "UTC";

    const all = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );
    const chunks = latestPerName(all).filter((h) =>
      h.name.startsWith("scrobbles.")
    );

    if (chunks.length === 0) {
      return {
        markdown:
          "# Listening statistics\n\nNo scrobble history found — run the " +
          "`sync-history` method first.",
        json: { status: "no-data", total: 0 },
      };
    }

    const scrobbles: StatScrobble[] = [];
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
      const rows = content?.scrobbles;
      if (!Array.isArray(rows)) {
        unreadable.push(handle.name);
        context.logger.warning?.(
          `lastfm-stats: could not read ${handle.name} v${handle.version}`,
        );
        continue;
      }
      scrobbles.push(...(rows as StatScrobble[]));
    }

    const stats = buildStats(scrobbles, timezone);
    const json: Record<string, unknown> = {
      status: "ok",
      chunks: chunks.length,
      ...stats,
    };
    if (unreadable.length > 0) json.unreadable = unreadable;

    context.logger.info(
      `lastfm-stats: ${scrobbles.length} scrobbles across ${chunks.length} ` +
        `year chunk(s)`,
    );

    return { markdown: renderMarkdown(stats), json };
  },
};
