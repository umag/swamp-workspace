// Running-playlist report for @magistr/music-library.
//
// Renders the latest `bpm` resource into a cadence-matched playlist at the
// default cadence — it never touches audio or essentia itself (rule 3: use the
// data model). The matching logic lives in ../lib/running.ts, shared with the
// `running` method; run that method instead when you want to tune the cadence
// window or confidence floor, since a report takes no arguments.

import {
  buildRunning,
  CADENCE_MAX,
  CADENCE_MIN,
  MIN_CONFIDENCE,
} from "../lib/running.ts";

interface Handle {
  name: string;
  version: number;
  tags?: Record<string, string>;
  lifecycle?: string;
}

interface DataRepo {
  findAllForModel(type: string, modelId: string): Promise<Handle[]>;
  getContent(
    type: string,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

interface ReportContext {
  modelType: string;
  modelId: string;
  methodArgs?: Record<string, unknown>;
  dataRepository: DataRepo;
}

interface BpmTrack {
  path: string;
  bpm: number | null;
  beatsConfidence: number | null;
  confidenceBand: string;
  danceability: number | null;
  key: string | null;
  scale: string | null;
  lengthSec: number | null;
}

interface BpmContent {
  kind: string;
  startedAt: string;
  elapsedSec: number;
  params: { path: string; pathPrefix: string };
  analyzed: number;
  carriedOver: number;
  failed: number;
  tracks: BpmTrack[];
}

const PLAYLIST_MAX = 40;

function decode(bytes: Uint8Array | null): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function fmtMin(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function renderMarkdown(
  bpm: BpmContent,
  r: ReturnType<typeof buildRunning>,
): string {
  const scope = bpm.params.path || bpm.params.pathPrefix || "whole library";
  const lines: string[] = [];
  lines.push(`# Running playlist — ${scope}`);
  lines.push("");
  lines.push(
    `${r.playlist.length} of ${bpm.tracks.length} analyzed tracks hold a ` +
      `steady enough pulse to run to at ${CADENCE_MIN}-${CADENCE_MAX} spm — ` +
      `**${fmtMin(r.totalSec)}** of running music.`,
  );

  if (r.playlist.length === 0) {
    lines.push("");
    lines.push(
      `Nothing qualified: ${r.excluded.noPulse} tracks scored below ` +
        `${MIN_CONFIDENCE} confidence (no beat essentia could lock onto) and ` +
        `${r.excluded.outOfRange} had a real beat at a tempo no multiple of ` +
        `which lands in the cadence window.`,
    );
    return lines.join("\n");
  }

  if (r.buckets.length > 0) {
    lines.push("");
    lines.push("## Cadence buckets");
    lines.push("");
    lines.push("| Cadence (spm) | Tracks | Music |");
    lines.push("| --- | --- | --- |");
    for (const b of r.buckets) {
      lines.push(`| ${b.range} | ${b.tracks} | ${b.minutes}m |`);
    }
  }

  lines.push("");
  const shown = r.playlist.slice(0, PLAYLIST_MAX);
  lines.push(
    `## The playlist (${shown.length}${
      r.playlist.length > PLAYLIST_MAX ? ` of ${r.playlist.length}` : ""
    }, strongest beat first)`,
  );
  lines.push("");
  lines.push("| spm | Match | bpm | Conf | Key | Len | Track |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const m of shown) {
    const mult = m.mult === 1 ? "1×" : m.mult === 2 ? "2× half-time" : "½× ";
    const key = m.key ? `${m.key} ${m.scale ?? ""}`.trim() : "—";
    lines.push(
      `| ${m.spm} | ${mult} | ${m.bpm} | ${
        m.confidence.toFixed(2)
      } | ${key} | ${fmtMin(m.lengthSec)} | ${m.path} |`,
    );
  }

  const topAlbums = r.albums.slice(0, 8);
  if (topAlbums.length > 0) {
    lines.push("");
    lines.push("## Most metronomic albums (mean beat confidence)");
    lines.push("");
    lines.push("| Mean conf | Runnable / tracks | Album |");
    lines.push("| --- | --- | --- |");
    for (const a of topAlbums) {
      lines.push(
        `| ${a.meanConfidence} | ${a.runnable} / ${a.tracks} | ${a.dir} |`,
      );
    }
  }

  lines.push("");
  lines.push("## Excluded");
  lines.push("");
  lines.push(
    `- **${r.excluded.noPulse}** below ${MIN_CONFIDENCE} confidence — essentia ` +
      `reported a bpm for these, but it is a grid laid over rubato or ambient ` +
      `material rather than a pulse. Running to them means running to nothing.`,
  );
  lines.push(
    `- **${r.excluded.outOfRange}** have a real beat, but no 1×/2×/½× multiple ` +
      `lands between ${CADENCE_MIN} and ${CADENCE_MAX} spm.`,
  );
  return lines.join("\n");
}

export const report = {
  name: "@magistr/music-bpm-running",
  description:
    "Cadence-matched running playlist from the latest tempo analysis: tracks whose beat essentia actually locked onto, matched to a 150-190 spm cadence at 1×, 2× or ½×, bucketed by cadence and ranked by beat confidence, plus the most metronomic albums and what was excluded and why.",
  scope: "model" as const,
  labels: ["music", "bpm", "tempo", "running", "playlist"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const { modelType, modelId, dataRepository: repo } = context;
    const empty = {
      markdown: "# Running playlist\n\nNo bpm resource found — run the " +
        "`bpm` method first.",
      json: { status: "no-data" },
    };
    try {
      const all = await repo.findAllForModel(modelType, modelId);
      const live = all.filter((h) => h.lifecycle !== "deleted");

      // newest bpm artifact; when this run IS a bpm run, prefer the artifact
      // whose params match the triggering arguments
      const wantPath = typeof context.methodArgs?.path === "string"
        ? context.methodArgs.path
        : null;
      const wantPrefix = typeof context.methodArgs?.pathPrefix === "string"
        ? context.methodArgs.pathPrefix
        : null;
      let best: BpmContent | null = null;
      let bestScore = -1;
      for (const h of live.filter((x) => x.tags?.specName === "bpm")) {
        const c = decode(
          await repo.getContent(modelType, modelId, h.name, h.version),
        ) as BpmContent | null;
        if (!c || c.kind !== "bpm" || !Array.isArray(c.tracks)) continue;
        const ts = Date.parse(c.startedAt) || 0;
        const matchesRun = wantPath !== null && wantPrefix !== null &&
          c.params.path === wantPath && c.params.pathPrefix === wantPrefix;
        // params match outranks recency
        const score = (matchesRun ? 1e15 : 0) + ts;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) return empty;

      const running = buildRunning(best.tracks);
      return {
        markdown: renderMarkdown(best, running),
        json: {
          status: "ok",
          scope: best.params.path || best.params.pathPrefix || "whole-library",
          startedAt: best.startedAt,
          cadence: { min: CADENCE_MIN, max: CADENCE_MAX },
          minConfidence: MIN_CONFIDENCE,
          analyzed: best.tracks.length,
          runnable: running.playlist.length,
          runnableSec: running.totalSec,
          buckets: running.buckets,
          excluded: running.excluded,
          albums: running.albums.slice(0, 20),
          playlist: running.playlist.slice(0, PLAYLIST_MAX),
        },
      };
    } catch (e) {
      return {
        markdown: `# Running playlist\n\nReport degraded: ${
          e instanceof Error ? e.message : String(e)
        }`,
        json: { status: "degraded", error: String(e) },
      };
    }
  },
};
