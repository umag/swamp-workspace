// IMDB-style Bayesian rating, ported from anilist_chart_bayesian.py.
//
// The /bayes chart smooths per-title averages toward the global mean C, so a
// title with one 10 does not outrank a title with twenty 8s. The prior weight
// m (minimum votes) defaults to 5.

export const DEFAULT_MIN_VOTES = 5;

/**
 * Bayesian weighted rating (bayesian.py:50-66).
 *   R = the item's average, v = its vote count,
 *   m = prior weight (min votes), C = the global mean.
 * Returns C when v + m == 0 (avoids division by zero).
 */
export function bayesianRating(
  R: number,
  v: number,
  m: number,
  C: number,
): number {
  if (v + m === 0) return C;
  return (v / (v + m)) * R + (m / (v + m)) * C;
}

/**
 * Global mean vote C (bayesian.py:115). Mean of every score in the corpus;
 * defaults to 50.0 when there are no scores (the 0-100 midpoint prior).
 */
export function globalAverageC(scores: number[]): number {
  if (scores.length === 0) return 50.0;
  let sum = 0;
  for (const s of scores) sum += s;
  return sum / scores.length;
}

/**
 * Null-safe reproduction of the SQL `format != 'MOVIE'` filter used to assemble
 * the /bayes corpus (bayesian.py:128).
 *
 * IMPORTANT: the movie exclusion for /bayes STAYS IN SQL. `format` is Nullable,
 * so in SQL `NULL != 'MOVIE'` evaluates to NULL and the row is excluded — a
 * null-format title is NOT eligible. If this predicate is ever reproduced in
 * TS, it MUST be written null-first as below; the naive `f !== 'MOVIE'` would
 * INCLUDE null-format titles (`null !== 'MOVIE'` is `true`), silently expanding
 * the corpus beyond what the oracle ranks.
 */
export function bayesFormatEligible(
  format: string | null | undefined,
): boolean {
  return format != null && format !== "MOVIE";
}
