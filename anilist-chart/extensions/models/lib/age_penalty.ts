// Season-based age penalty, ported from anilist_chart_age_penalty.py.
//
// The /fresh chart penalizes older titles: a title loses `rate` (default 0.05)
// of its raw average per season of age. Age is measured in ANIME SEASONS, and
// since metadata only carries a start_year we assume the title aired in WINTER
// of that year (the conservative anchor, age_penalty.py:41-53).

export const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
export type Season = (typeof SEASONS)[number];

export const DEFAULT_PENALTY_RATE = 0.05;

/** Month (1-12) -> anime season (age_penalty.py:11-28). */
export function seasonFromMonth(month: number): Season {
  if (month >= 1 && month <= 3) return "WINTER";
  if (month >= 4 && month <= 6) return "SPRING";
  if (month >= 7 && month <= 9) return "SUMMER";
  return "FALL";
}

/** Current season + year from a Date (defaults to now). Explicit for determinism. */
export function currentSeasonInfo(
  now: Date = new Date(),
): { season: Season; year: number } {
  return {
    season: seasonFromMonth(now.getMonth() + 1),
    year: now.getFullYear(),
  };
}

/**
 * Number of anime seasons between a title's (assumed WINTER) start and the
 * current season (age_penalty.py:41-67).
 *
 * The `max(0, total)` clamp at age_penalty.py:67 is KEPT. With the WINTER
 * anchor (index 0) the adjustment is always >= 0, so the clamp is a defensive
 * no-op, but it is retained verbatim.
 */
export function seasonsDifference(
  startYear: number | null | undefined,
  currentSeason: Season,
  currentYear: number,
): number {
  if (!startYear || startYear > currentYear) return 0;
  const yearDiff = currentYear - startYear;
  const seasonsInYears = yearDiff * 4;
  const currentSeasonIndex = SEASONS.indexOf(currentSeason);
  const animeSeasonIndex = 0; // WINTER
  const seasonAdjustment = currentSeasonIndex - animeSeasonIndex;
  const total = seasonsInYears + seasonAdjustment;
  return Math.max(0, total); // age_penalty.py:67 — KEEP
}

/**
 * Linear age-penalty factor (age_penalty.py:235-241).
 *
 * Gate: only titles with a real, non-future start_year are penalized; anything
 * else returns 1.0. The factor is `1 - seasonsOld * rate` and is INTENTIONALLY
 * UNCLAMPED — the `max(0, ...)` at age_penalty.py:239 is dropped (the settled
 * decision), so a sufficiently old title yields a NEGATIVE factor and sinks
 * below unrated titles in the /fresh ranking.
 */
export function agePenaltyFactor(
  startYear: number | null | undefined,
  currentSeason: Season,
  currentYear: number,
  rate: number = DEFAULT_PENALTY_RATE,
): number {
  if (!startYear || startYear > currentYear) return 1.0;
  const seasonsOld = seasonsDifference(startYear, currentSeason, currentYear);
  return 1.0 - seasonsOld * rate; // UNCLAMPED
}

/** Raw average scaled by the (unclamped) age-penalty factor. */
export function penalizedScore(
  rawAvg: number,
  startYear: number | null | undefined,
  currentSeason: Season,
  currentYear: number,
  rate: number = DEFAULT_PENALTY_RATE,
): number {
  return rawAvg * agePenaltyFactor(startYear, currentSeason, currentYear, rate);
}
