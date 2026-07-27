// Cadence-matching domain logic, shared by the `running` method (which stores
// a tuned playlist) and the @magistr/music-bpm-running report (which renders
// the default view). Pure — no I/O, no zod, no essentia.
//
// Two ideas carry the whole thing:
//
//   1. Confidence gates everything. Essentia's beat tracker lays an even grid
//      over rubato ballads and ambient drone and still reports a bpm, so bpm
//      alone will happily put a 4-hour dark-ambient piece in a running
//      playlist at "110 bpm". Only beatsConfidence separates a real pulse from
//      an imposed one, so tracks below the threshold are excluded and counted,
//      never silently ranked low.
//   2. Cadence is not bpm. Footfalls land on the beat at 1×, but half-time
//      material (a 90 bpm track under a 180 spm cadence) runs just as well —
//      so each track is matched at 1×, 2× or ½× and reported with the
//      multiplier that put it in range.

/** Recreational-to-fast running cadence, in steps per minute. */
export const CADENCE_MIN = 150;
export const CADENCE_MAX = 190;
/**
 * The "good" band floor — see bpmConfidenceBand in the model. Anything under
 * this is a grid essentia imposed, not a beat it found.
 */
export const MIN_CONFIDENCE = 1.5;
const BUCKET_WIDTH = 10;
const ALBUM_MIN_TRACKS = 3;

/** The fields of a `bpm` resource track this logic needs. */
export interface RunTrack {
  path: string;
  bpm: number | null;
  beatsConfidence: number | null;
  danceability: number | null;
  key: string | null;
  scale: string | null;
  lengthSec: number | null;
}

export interface PlaylistEntry {
  path: string;
  bpm: number;
  spm: number;
  mult: number;
  confidence: number;
  danceability: number | null;
  key: string | null;
  scale: string | null;
  lengthSec: number;
}

export interface RunningOpts {
  minSpm?: number;
  maxSpm?: number;
  minConfidence?: number;
  /** Stop once the playlist reaches this many minutes (0 = no target). */
  targetMin?: number;
  /** Cap the number of tracks (0 = no cap). */
  limit?: number;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

/**
 * Steps-per-minute this track supports, matching at 1× first (footfall on the
 * beat), then 2× (half-time material under a quick cadence), then ½× (blast
 * beats and drum'n'bass, where every other beat is a step). Null when no
 * multiple lands in the cadence window.
 */
export function cadenceFor(
  bpm: number | null,
  min = CADENCE_MIN,
  max = CADENCE_MAX,
): { spm: number; mult: number } | null {
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return null;
  for (const mult of [1, 2, 0.5]) {
    const spm = bpm * mult;
    if (spm >= min && spm <= max) {
      return { spm: Math.round(spm * 10) / 10, mult };
    }
  }
  return null;
}

/**
 * Build the running view from `bpm` resource tracks. `targetMin` trims the
 * playlist to a run's length, keeping the strongest beats — so a 40-minute run
 * gets the 40 best minutes rather than the first 40 that happen to sort high.
 */
export function buildRunning(tracks: RunTrack[], opts: RunningOpts = {}) {
  const minConf = opts.minConfidence ?? MIN_CONFIDENCE;
  const min = opts.minSpm ?? CADENCE_MIN;
  const max = opts.maxSpm ?? CADENCE_MAX;

  const steady = tracks.filter((t) =>
    t.beatsConfidence !== null && t.beatsConfidence >= minConf
  );
  const noPulse = tracks.length - steady.length;

  let matched: PlaylistEntry[] = [];
  for (const t of steady) {
    const c = cadenceFor(t.bpm, min, max);
    if (!c) continue;
    matched.push({
      path: t.path,
      bpm: t.bpm as number,
      spm: c.spm,
      mult: c.mult,
      confidence: t.beatsConfidence as number,
      danceability: t.danceability,
      key: t.key,
      scale: t.scale,
      lengthSec: t.lengthSec ?? 0,
    });
  }
  const outOfRange = steady.length - matched.length;
  matched.sort((a, b) => b.confidence - a.confidence);

  const eligible = matched.length;
  if (opts.targetMin && opts.targetMin > 0) {
    const targetSec = opts.targetMin * 60;
    const kept: PlaylistEntry[] = [];
    let sec = 0;
    for (const m of matched) {
      if (sec >= targetSec) break;
      kept.push(m);
      sec += m.lengthSec;
    }
    matched = kept;
  }
  if (opts.limit && opts.limit > 0) matched = matched.slice(0, opts.limit);

  const totalSec = matched.reduce((s, m) => s + m.lengthSec, 0);

  const buckets: Array<{ range: string; tracks: number; minutes: number }> = [];
  for (
    let lo = Math.floor(min / BUCKET_WIDTH) * BUCKET_WIDTH;
    lo < max;
    lo += BUCKET_WIDTH
  ) {
    const hi = lo + BUCKET_WIDTH;
    const inBucket = matched.filter((m) => m.spm >= lo && m.spm < hi);
    if (inBucket.length === 0) continue;
    buckets.push({
      range: `${lo}-${hi}`,
      tracks: inBucket.length,
      minutes: Math.round(inBucket.reduce((s, m) => s + m.lengthSec, 0) / 60),
    });
  }

  // Which albums hold a steady pulse — the ones worth running to end to end.
  const byAlbum = new Map<string, { conf: number[]; runnable: number }>();
  for (const t of tracks) {
    const d = dirOf(t.path);
    if (!byAlbum.has(d)) byAlbum.set(d, { conf: [], runnable: 0 });
    const e = byAlbum.get(d)!;
    if (t.beatsConfidence !== null) e.conf.push(t.beatsConfidence);
  }
  for (const m of matched) {
    const e = byAlbum.get(dirOf(m.path));
    if (e) e.runnable += 1;
  }
  const albums = [...byAlbum.entries()]
    .filter(([, e]) => e.conf.length >= ALBUM_MIN_TRACKS)
    .map(([dir, e]) => ({
      dir,
      tracks: e.conf.length,
      runnable: e.runnable,
      meanConfidence: Math.round(
        (e.conf.reduce((s, c) => s + c, 0) / e.conf.length) * 100,
      ) / 100,
    }))
    .sort((a, b) => b.meanConfidence - a.meanConfidence);

  return {
    playlist: matched,
    buckets,
    albums,
    excluded: { noPulse, outOfRange },
    totalSec,
    /** Matched the cadence window before targetMin/limit trimming. */
    eligible,
  };
}
