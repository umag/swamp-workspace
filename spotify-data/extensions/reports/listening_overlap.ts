// ---------------------------------------------------------------------------
// @magistr/listening-overlap
//
// A WORKFLOW-scope report that reconciles two listening histories which
// describe the same life from different sides:
//
//   @magistr/lastfm       scrobbles.<year>  — what Last.fm recorded
//   @magistr/spotify-data spotify.<year>    — what Spotify recorded
//
// Workflow scope is the point. A model-scope report can only read its own
// model, but `stepExecutions[]` names every model the workflow touched
// (modelType + modelId), and `dataRepository` takes those as parameters — so a
// workflow report is the sanctioned surface for reading across models.
//
// The matching problem is genuinely hard and the report is honest about it:
//
//  - Spotify's `ts` is when a stream ENDED; Last.fm's `date.uts` is when a
//    track STARTED. The same play therefore carries timestamps that differ by
//    roughly one track length, so equality never matches and the tolerance
//    window must be wide enough to cover a long track.
//  - Artist/track strings differ between services (diacritics, featured-artist
//    formatting, remaster suffixes), so matching is on a normalized form.
//  - A wider window trades false negatives for false positives. The window is
//    an argument, and the report states which one produced its numbers, so the
//    figure can be challenged rather than taken on faith.
// ---------------------------------------------------------------------------

/** Default tolerance, in seconds, between a Spotify end-stamp and a Last.fm
 * start-stamp for the same play. Ten minutes comfortably covers a long track
 * plus clock drift between the two services. */
const DEFAULT_WINDOW_S = 600;

/** A data handle as returned by `dataRepository.findAllForModel`. */
export type Handle = {
  name: string;
  version: number;
  lifecycle?: string;
  tags?: Record<string, string>;
};

/** A play from either source, reduced to what matching needs. */
export type Play = {
  uts: number;
  artist: string;
  track: string;
};

type StepExecution = {
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  status: string;
};

type WorkflowReportContext = {
  scope: "workflow";
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
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

/** One live handle per name, newest version, deleted dropped. */
export function latestPerName<T extends Handle>(handles: T[]): T[] {
  const best = new Map<string, T>();
  for (const h of handles) {
    if (h.lifecycle === "deleted") continue;
    const prior = best.get(h.name);
    if (!prior || h.version > prior.version) best.set(h.name, h);
  }
  return [...best.values()];
}

/**
 * Fold a title to a comparison key: lowercase, strip diacritics, drop
 * bracketed suffixes ("(Remastered 2011)", "[Live]"), collapse punctuation and
 * whitespace.
 *
 * This is what lets `Za Frûmi` and `Za Frűmi` — which Last.fm treats as two
 * artists and which split that artist's playcount across the real history —
 * compare equal.
 */
export function foldTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Comparison key for a play: folded artist + folded track. */
export function playKey(p: Play): string {
  return `${foldTitle(p.artist)}::${foldTitle(p.track)}`;
}

export type MatchResult = {
  matched: number;
  spotifyOnly: number;
  lastfmOnly: number;
  /** Matched pairs' absolute timestamp deltas, for reporting the spread. */
  deltas: number[];
  /** Spotify plays with no Last.fm counterpart. Returned so a combined tally
   * can be built as (all Last.fm) + (unmatched Spotify) without re-matching —
   * concatenating both sources instead would double-count every matched
   * play. */
  unmatchedSpotify: Play[];
};

/**
 * Greedy one-to-one match between two play lists within `windowS` seconds.
 *
 * One-to-one matters: a naive "does any counterpart exist" test double-counts
 * when a track is played several times in an evening. Candidates are consumed
 * as they are used, and the nearest unconsumed counterpart wins, so N plays of
 * one track match at most N counterparts.
 */
export function matchPlays(
  spotify: Play[],
  lastfm: Play[],
  windowS: number = DEFAULT_WINDOW_S,
): MatchResult {
  const byKey = new Map<string, number[]>();
  for (const p of lastfm) {
    const k = playKey(p);
    const arr = byKey.get(k);
    if (arr) arr.push(p.uts);
    else byKey.set(k, [p.uts]);
  }
  for (const arr of byKey.values()) arr.sort((a, b) => a - b);

  const used = new Map<string, Set<number>>();
  let matched = 0;
  const deltas: number[] = [];
  const unmatchedSpotify: Play[] = [];

  for (const s of [...spotify].sort((a, b) => a.uts - b.uts)) {
    const k = playKey(s);
    const candidates = byKey.get(k);
    if (!candidates) {
      unmatchedSpotify.push(s);
      continue;
    }
    const taken = used.get(k) ?? new Set<number>();

    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (taken.has(i)) continue;
      const d = Math.abs(candidates[i] - s.uts);
      if (d <= windowS && d < bestDelta) {
        bestDelta = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      taken.add(bestIdx);
      used.set(k, taken);
      matched++;
      deltas.push(bestDelta);
    } else {
      unmatchedSpotify.push(s);
    }
  }

  return {
    matched,
    spotifyOnly: spotify.length - matched,
    lastfmOnly: lastfm.length - matched,
    deltas,
    unmatchedSpotify,
  };
}

/**
 * Rank artists over a combined play list, merging spelling variants.
 *
 * Artists are grouped by {@link foldTitle}, so `Za Frûmi` and `Za Frűmi` —
 * which Last.fm records as two separate artists, splitting one artist's real
 * playcount across both — collapse into a single entry. The label shown is the
 * spelling that occurs most often, so the ranking reads naturally rather than
 * displaying a folded key.
 */
export function rankArtists(
  plays: Play[],
  limit: number,
): Array<{ name: string; playcount: number; variants: number }> {
  const counts = new Map<string, number>();
  const spellings = new Map<string, Map<string, number>>();
  for (const p of plays) {
    const k = foldTitle(p.artist);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const sp = spellings.get(k) ?? new Map<string, number>();
    sp.set(p.artist, (sp.get(p.artist) ?? 0) + 1);
    spellings.set(k, sp);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k, playcount]) => {
      const sp = spellings.get(k)!;
      const name = [...sp.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { name, playcount, variants: sp.size };
    });
}

const decode = (bytes: Uint8Array | null): Record<string, unknown> | null => {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

/** Read every year chunk of one model, flattened to comparable plays. */
async function readPlays(
  context: WorkflowReportContext,
  modelType: string,
  modelId: string,
  prefix: string,
  arrayField: string,
): Promise<{ plays: Play[]; years: Set<string> }> {
  const all = await context.dataRepository.findAllForModel(modelType, modelId);
  const chunks = latestPerName(all).filter((h) => h.name.startsWith(prefix));
  const plays: Play[] = [];
  const years = new Set<string>();
  for (const h of chunks) {
    const content = decode(
      await context.dataRepository.getContent(
        modelType,
        modelId,
        h.name,
        h.version,
      ),
    );
    const rows = content?.[arrayField];
    if (!Array.isArray(rows)) continue;
    years.add(h.name.slice(prefix.length));
    for (const r of rows as Array<Record<string, unknown>>) {
      if (
        typeof r.uts === "number" && typeof r.artist === "string" &&
        typeof r.track === "string"
      ) {
        plays.push({ uts: r.uts, artist: r.artist, track: r.track });
      }
    }
  }
  return { plays, years };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export const report = {
  name: "@magistr/listening-overlap",
  description:
    "Reconcile the Last.fm scrobble history against the Spotify streaming " +
    "export: how many plays both sources saw, how many each holds alone, and " +
    "a combined total that counts a matched play once.",
  scope: "workflow" as const,
  labels: ["music", "lastfm", "spotify", "listening", "overlap"],

  execute: async (context: WorkflowReportContext): Promise<{
    markdown: string;
    json: Record<string, unknown>;
  }> => {
    const windowS = typeof context.methodArgs?.windowSeconds === "number"
      ? context.methodArgs.windowSeconds as number
      : DEFAULT_WINDOW_S;

    // stepExecutions names every model the workflow touched. That is what
    // makes cross-model reading legitimate here rather than a reach into
    // someone else's data.
    const seen = new Map<string, { type: string; id: string }>();
    for (const step of context.stepExecutions ?? []) {
      if (step.modelType && step.modelId) {
        seen.set(step.modelType, { type: step.modelType, id: step.modelId });
      }
    }
    const lastfm = seen.get("@magistr/lastfm");
    const spotify = seen.get("@magistr/spotify-data");

    if (!lastfm || !spotify) {
      const have = [...seen.keys()].join(", ") || "none";
      return {
        markdown:
          `# Listening overlap\n\nSkipped — this report needs a workflow that ` +
          `runs BOTH \`@magistr/lastfm\` and \`@magistr/spotify-data\`. ` +
          `Models seen in this run: ${have}.`,
        json: { status: "skipped", modelsSeen: [...seen.keys()] },
      };
    }

    const l = await readPlays(
      context,
      lastfm.type,
      lastfm.id,
      "scrobbles.",
      "scrobbles",
    );
    const s = await readPlays(
      context,
      spotify.type,
      spotify.id,
      "spotify.",
      "streams",
    );

    // Only years BOTH sources cover can overlap; comparing across the whole
    // range would report Last.fm's 2007-2016 as "lastfm only" and imply a
    // disagreement where there is simply no Spotify account yet.
    const shared = [...l.years].filter((y) => s.years.has(y)).sort();
    const inShared = (p: Play) =>
      shared.includes(String(new Date(p.uts * 1000).getUTCFullYear()));

    const lShared = l.plays.filter(inShared);
    const sShared = s.plays.filter(inShared);
    const m = matchPlays(sShared, lShared, windowS);

    // The combined history counts a play once: every Last.fm play, plus the
    // Spotify plays that had no Last.fm counterpart. Spotify plays outside the
    // shared years cannot overlap by construction, so they all carry over.
    const outsideShared = s.plays.filter((p) => !inShared(p));
    const combinedPlays = [...l.plays, ...outsideShared, ...m.unmatchedSpotify];
    const combined = combinedPlays.length;
    // Store a deeper ranking than the terminal render shows: the markdown
    // stays readable at 50, while the JSON carries 200 so a caller can ask
    // for the tail without re-running the workflow.
    const topArtists = rankArtists(combinedPlays, 200);
    const json = {
      status: "ok",
      windowSeconds: windowS,
      lastfmTotal: l.plays.length,
      spotifyTotal: s.plays.length,
      sharedYears: shared,
      inSharedYears: { lastfm: lShared.length, spotify: sShared.length },
      matched: m.matched,
      spotifyOnlyInShared: m.spotifyOnly,
      lastfmOnlyInShared: m.lastfmOnly,
      medianDeltaSeconds: median(m.deltas),
      combinedTotal: combined,
      doubleCountAvoided: m.matched,
      topArtists,
    };

    const pct = (n: number, d: number) =>
      d ? `${Math.round(n / d * 1000) / 10}%` : "—";

    const markdown = [
      "# Listening overlap",
      "",
      `**${combined.toLocaleString()}** distinct plays across both sources ` +
      `(${l.plays.length.toLocaleString()} Last.fm + ` +
      `${s.plays.length.toLocaleString()} Spotify − ${m.matched} matched).`,
      "",
      `Shared years: ${shared.join(", ") || "none"} — only these can overlap.`,
      `Match window: ±${windowS}s (Spotify stamps stream END, Last.fm stamps ` +
      `track START, so the same play differs by about one track length).`,
      "",
      "| | Last.fm | Spotify |",
      "|---|---:|---:|",
      `| Total plays | ${l.plays.length} | ${s.plays.length} |`,
      `| In shared years | ${lShared.length} | ${sShared.length} |`,
      `| Matched to the other source | ${m.matched} ` +
      `(${pct(m.matched, lShared.length)}) | ${m.matched} ` +
      `(${pct(m.matched, sShared.length)}) |`,
      `| Unmatched in shared years | ${m.lastfmOnly} | ${m.spotifyOnly} |`,
      "",
      `Median timestamp gap on matched pairs: ${median(m.deltas)}s.`,
      "",
      "Unmatched plays are not errors: Last.fm also scrobbles from sources " +
      "other than Spotify, Spotify keeps sub-30s plays Last.fm never " +
      "recorded, and either service can drop a play.",
      "",
      "## Top 50 artists (both sources, matched plays counted once)",
      "",
      `_Ranked ${topArtists.length} artists in total; the full list is in this report's JSON._`,
      "",
      ...topArtists.slice(0, 50).map((a, i) =>
        `${String(i + 1).padStart(2)}. ${
          a.playcount
            .toString()
            .padStart(5)
        }  ${a.name}` +
        (a.variants > 1 ? `  _(${a.variants} spellings merged)_` : "")
      ),
      "",
    ].join("\n");

    context.logger.info(
      `listening-overlap: ${m.matched} matched, combined ${combined}`,
    );
    return { markdown, json };
  },
};
