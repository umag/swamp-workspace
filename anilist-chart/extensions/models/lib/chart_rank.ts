// The four genre charts share one aggregation shape but THREE different sort
// rules. Python's `list.sort()` is stable, so when the oracle sorts twice the
// LAST sort is the primary key. Ported here as a single comparator driven by a
// per-mode key table — same result, but the primary/secondary intent is
// explicit instead of hidden in sort ordering.
//
//   chart   (anilist_chart.py:178-180)               [votes desc, avg desc]
//   current (anilist_chart_current_season.py:183-184) [votes desc, avg desc]
//   fresh   (anilist_chart_age_penalty.py:261-262)    [penalized desc, votes desc]
//   bayes   (anilist_chart_bayesian.py:202)           [bayesian desc, votes desc]
//
// WARNING: age_penalty.py:258 comments "primarily by votes (desc)" — this is
// FALSE. The code sorts by votes first, THEN by penalized_score, so the stable
// last sort makes PENALIZED the primary key. Trust the code, not the comment.

export interface Rankable {
  media_id: number;
  title: string;
  votes: number;
  average_score: number;
  penalized_score?: number;
  bayesian_rating?: number;
  cover_url?: string | null;
}

export type ChartMode = "chart" | "current" | "fresh" | "bayes";

/** [primary, secondary] sort keys per mode — both compared descending. */
export const SORT_KEYS: Record<ChartMode, [keyof Rankable, keyof Rankable]> = {
  chart: ["votes", "average_score"],
  current: ["votes", "average_score"],
  fresh: ["penalized_score", "votes"],
  bayes: ["bayesian_rating", "votes"],
};

function keyNum(row: Rankable, key: keyof Rankable): number {
  const v = row[key];
  return typeof v === "number" ? v : Number(v);
}

/**
 * Return a NEW array sorted per `mode` (descending primary, then descending
 * secondary). Ties preserve input order — JS Array.sort is stable, matching
 * Python's stable sort, so identical rows keep their aggregation order.
 */
export function rankGenre(rows: Rankable[], mode: ChartMode): Rankable[] {
  const [primary, secondary] = SORT_KEYS[mode];
  return [...rows].sort((a, b) => {
    const pa = keyNum(a, primary);
    const pb = keyNum(b, primary);
    if (pb !== pa) return pb - pa; // primary desc
    const sa = keyNum(a, secondary);
    const sb = keyNum(b, secondary);
    if (sb !== sa) return sb - sa; // secondary desc
    return 0; // stable
  });
}

/**
 * Cross-genre de-duplication + backfill (bayesian.py:208-273).
 *
 * `genreMap` maps each genre to its FULL per-genre ranked list (already sorted
 * for the mode). Each title appears once across the whole chart, landing in the
 * genre where its rank is best (lowest index); ties keep the first genre seen.
 * A slot vacated by a title that moved elsewhere is backfilled from that
 * genre's own sorted tail, skipping already-placed titles. A slot with no
 * available filler stays `null` (an empty cell — never a "None"/"undefined"
 * string). A genre whose entire top-K was claimed elsewhere still appears in
 * the output, rendered as empty cells.
 */
export function buildFinalChartData(
  genreMap: Record<string, Rankable[]>,
  topK: number,
): Record<string, (Rankable | null)[]> {
  const genres = Object.keys(genreMap);
  const rankedLists: Record<string, Rankable[]> = {};
  const final: Record<string, (Rankable | null)[]> = {};
  const allPlaced = new Set<number>(); // media_id

  for (const g of genres) {
    rankedLists[g] = genreMap[g].slice(0, topK);
    final[g] = new Array(topK).fill(null);
  }

  // Best rank per title across genres (lower index = better). First genre seen
  // wins ties — Map preserves insertion order like Python's dict.
  const bestRank = new Map<number, { genre: string; rank: number }>();
  for (const g of genres) {
    rankedLists[g].forEach((anime, rank) => {
      const cur = bestRank.get(anime.media_id);
      if (cur === undefined || rank < cur.rank) {
        bestRank.set(anime.media_id, { genre: g, rank });
      }
    });
  }

  // Place each title in its best slot (bayesian.py:241-246 looks up the
  // original object across the full genre_map).
  for (const [id, { genre, rank }] of bestRank) {
    let orig: Rankable | undefined;
    for (const g of genres) {
      const found = genreMap[g].find((a) => a.media_id === id);
      if (found) {
        orig = found;
        break;
      }
    }
    if (orig) {
      final[genre][rank] = orig;
      allPlaced.add(id);
    }
  }

  // Fill empty slots from each genre's own sorted tail (bayesian.py:249-270).
  // One forward iterator per genre, shared across that genre's slots.
  for (const g of genres) {
    const list = final[g];
    const fillers = genreMap[g][Symbol.iterator]();
    for (let idx = 0; idx < topK; idx++) {
      if (list[idx] !== null) continue;
      let filler: Rankable | null = null;
      while (true) {
        const nx = fillers.next();
        if (nx.done) break;
        if (!allPlaced.has(nx.value.media_id)) {
          filler = nx.value;
          break;
        }
      }
      if (filler) {
        list[idx] = filler;
        allPlaced.add(filler.media_id);
      }
      // else: slot stays null (empty cell)
    }
  }

  return final;
}
