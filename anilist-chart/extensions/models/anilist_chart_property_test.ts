/**
 * Property-based tests (fast-check@4.8.0, pinned exactly per this repo's
 * "extension npm deps are bundled, not lockfile-tracked" rule) for
 * @magistr/anilist-chart's bayesian/ranking/formatting invariants and one
 * end-to-end fan-out FLOW property.
 *
 * anilist_chart.ts + every lib/*.ts file are UNMODIFIED — every property
 * here characterizes already-shipped, pure domain logic.
 *
 * PROPERTY DISCIPLINE: every arbitrary below is RESTRICTED to the domain
 * where its invariant actually holds (documented at each `fc.` call site),
 * per the round-1 adversarial-review finding that an unrestricted arbitrary
 * over this domain produces spurious failures (bayesianRating's bound
 * direction depends on sign(R-C); agePenaltyFactor's linearity holds only
 * for non-null, non-future start years; buildFinalChartData's dedup holds
 * only when media_ids are internally consistent across genres). Verified
 * green at `FC_NUM_RUNS=5000` before this suite was committed (see the
 * implementer's final report) — override via the same env var:
 * `FC_NUM_RUNS=5000 deno task test` or `deno task test:soak`.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { bayesianRating, globalAverageC } from "./lib/bayesian.ts";
import { agePenaltyFactor } from "./lib/age_penalty.ts";
import {
  buildFinalChartData,
  type ChartMode,
  type Rankable,
  rankGenre,
  SORT_KEYS,
} from "./lib/chart_rank.ts";
import { esc } from "./lib/format.ts";
import { buildRenderTasks, type RenderInputs } from "./anilist_chart.ts";
import { runFanOut } from "./lib/render_run.ts";
import type {
  RawBoardRow,
  RawChartMeta,
  RawChartScore,
} from "./lib/render_run.ts";
import type { LandingStats } from "./lib/render_landing.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ===========================================================================
// (a) bayesianRating: bounds + monotonicity + boundary cases
// ===========================================================================

// Restricted to the domain where the formula is actually used: scores are
// 0-100 (world/AniList scale), v is a non-negative vote count, m is a
// POSITIVE prior weight (the model always calls it with bayesMinVotes >= 1
// in practice; m=0 is a separate, explicitly-tested boundary case below).
const arbScore = fc.float({ min: 0, max: 100, noNaN: true });
const arbVotes = fc.integer({ min: 0, max: 100_000 });
const arbPositiveM = fc.integer({ min: 1, max: 50 });

Deno.test("property: bayesianRating is always a convex combination of R and C -- bounded within [min(R,C), max(R,C)]", () => {
  fc.assert(
    fc.property(arbScore, arbVotes, arbPositiveM, arbScore, (R, v, m, C) => {
      const rating = bayesianRating(R, v, m, C);
      const lo = Math.min(R, C);
      const hi = Math.max(R, C);
      // Float rounding tolerance.
      return rating >= lo - 1e-9 && rating <= hi + 1e-9;
    }),
    FC_RUNS,
  );
});

Deno.test("property: bayesianRating is non-decreasing in R, holding v/m/C fixed (v>=0, m>0 always gives a non-negative weight on R)", () => {
  fc.assert(
    fc.property(
      arbVotes,
      arbPositiveM,
      arbScore,
      arbScore,
      arbScore,
      (v, m, C, r1, r2) => {
        const [lowR, highR] = r1 <= r2 ? [r1, r2] : [r2, r1];
        return bayesianRating(lowR, v, m, C) <=
          bayesianRating(highR, v, m, C) + 1e-9;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: bayesianRating boundary cases -- v=0 collapses to EXACTLY C; m=0 (with v>0) collapses to EXACTLY R", () => {
  fc.assert(
    fc.property(arbPositiveM, arbScore, arbScore, (m, R, C) => {
      const atZeroVotes = bayesianRating(R, 0, m, C);
      return Math.abs(atZeroVotes - C) < 1e-9;
    }),
    FC_RUNS,
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      arbScore,
      arbScore,
      (v, R, C) => {
        const atZeroPrior = bayesianRating(R, v, 0, C);
        return Math.abs(atZeroPrior - R) < 1e-9;
      },
    ),
    FC_RUNS,
  );
});

// ===========================================================================
// (b) globalAverageC: population-mean bounds
// ===========================================================================

Deno.test("property: globalAverageC of a non-empty score array is bounded within [min, max] of that array; empty defaults to EXACTLY 50.0", () => {
  fc.assert(
    fc.property(
      fc.array(arbScore, { minLength: 1, maxLength: 200 }),
      (scores) => {
        const c = globalAverageC(scores);
        return c >= Math.min(...scores) - 1e-9 &&
          c <= Math.max(...scores) + 1e-9;
      },
    ),
    FC_RUNS,
  );
  assertEquals(globalAverageC([]), 50.0);
});

// ===========================================================================
// (c) rankGenre: sortedness + multiset-preservation + non-mutation + determinism
// ===========================================================================

// media_id drawn from a small bounded pool so ties on the primary/secondary
// keys are common (exercising the stable-tiebreak path), while votes/
// average_score/bayesian_rating/penalized_score stay small finite numbers.
const arbRankable: fc.Arbitrary<Rankable> = fc.record({
  media_id: fc.integer({ min: 1, max: 30 }),
  title: fc.constantFrom("Alpha", "Beta", "Gamma", "Delta"),
  votes: fc.integer({ min: 0, max: 1000 }),
  average_score: fc.float({ min: 0, max: 100, noNaN: true }),
  penalized_score: fc.float({ min: -50, max: 100, noNaN: true }),
  bayesian_rating: fc.float({ min: 0, max: 100, noNaN: true }),
});
const arbMode = fc.constantFrom<ChartMode>(
  "chart",
  "current",
  "fresh",
  "bayes",
);

function keyOf(row: Rankable, mode: ChartMode): [number, number] {
  const [p, s] = SORT_KEYS[mode];
  const num = (v: unknown) => typeof v === "number" ? v : Number(v);
  return [num(row[p]), num(row[s])];
}

Deno.test("property: rankGenre's output is fully sorted (primary desc, then secondary desc) for every mode", () => {
  fc.assert(
    fc.property(
      fc.array(arbRankable, { minLength: 0, maxLength: 20 }),
      arbMode,
      (rows, mode) => {
        const out = rankGenre(rows, mode);
        for (let i = 1; i < out.length; i++) {
          const [p0, s0] = keyOf(out[i - 1], mode);
          const [p1, s1] = keyOf(out[i], mode);
          if (p0 < p1) return false; // primary must be non-increasing
          if (p0 === p1 && s0 < s1) return false; // secondary must be non-increasing on ties
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

/** Reference-identity multiset equality — robust to duplicate media_ids
 * (two distinct row OBJECTS may legitimately share a media_id in this
 * arbitrary; sorting by media_id would then compare an arbitrary tie order
 * between two independently-sorted arrays, a false failure unrelated to
 * rankGenre itself). Every element of `a` must be found, by reference, in
 * `b`, one-for-one, with nothing left over. */
function sameElementsByReference<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const remaining = b.slice();
  for (const item of a) {
    const idx = remaining.indexOf(item);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return remaining.length === 0;
}

Deno.test("property: rankGenre never adds, drops, or duplicates elements (output is a permutation of the input) and never mutates its input array", () => {
  fc.assert(
    fc.property(
      fc.array(arbRankable, { minLength: 0, maxLength: 20 }),
      arbMode,
      (rows, mode) => {
        const before = rows.slice(); // shallow copy to detect mutation
        const out = rankGenre(rows, mode);
        const sameMultiset = sameElementsByReference(out, rows);
        const notMutated = rows.length === before.length &&
          rows.every((r, i) => r === before[i]);
        return sameMultiset && notMutated;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: rankGenre is deterministic -- two calls on independent copies of the same input produce value-equal output", () => {
  fc.assert(
    fc.property(
      fc.array(arbRankable, { minLength: 0, maxLength: 20 }),
      arbMode,
      (rows, mode) => {
        const a = rankGenre(rows.slice(), mode);
        const b = rankGenre(rows.slice(), mode);
        return JSON.stringify(a) === JSON.stringify(b);
      },
    ),
    FC_RUNS,
  );
});

// ===========================================================================
// (d) buildFinalChartData: topK-slot-count + global cross-genre dedup + soundness
// ===========================================================================

// Restricted: each genre's own list has DISTINCT media_ids (matching the
// production invariant -- aggregateGenres groups by unique media id PER
// genre, so a genre's list never contains the same title twice; a
// within-genre duplicate is an unreachable shape the property need not
// cover). Cross-genre OVERLAP (the same media_id appearing in more than one
// genre's list) is exactly what buildFinalChartData's dedup logic exists
// to handle, so genres are allowed to share media_ids freely.
const arbGenreMap = fc
  .array(fc.constantFrom("Comedy", "Action", "Drama"), {
    minLength: 1,
    maxLength: 3,
  })
  .chain((genreNames) => {
    const uniqueGenres = [...new Set(genreNames)];
    const perGenreList = fc.uniqueArray(
      fc.record({
        media_id: fc.integer({ min: 1, max: 12 }),
        title: fc.constantFrom("Alpha", "Beta", "Gamma"),
        votes: fc.integer({ min: 0, max: 100 }),
        average_score: fc.float({ min: 0, max: 100, noNaN: true }),
      }),
      { selector: (r) => r.media_id, minLength: 0, maxLength: 8 },
    );
    return fc.tuple(
      fc.constant(uniqueGenres),
      fc.array(perGenreList, {
        minLength: uniqueGenres.length,
        maxLength: uniqueGenres.length,
      }),
    );
  })
  .map(([genreNames, lists]) => {
    const genreMap: Record<string, Rankable[]> = {};
    genreNames.forEach((g, i) => (genreMap[g] = lists[i]));
    return genreMap;
  });

Deno.test("property: buildFinalChartData always returns EXACTLY topK slots per genre", () => {
  fc.assert(
    fc.property(
      arbGenreMap,
      fc.integer({ min: 1, max: 6 }),
      (genreMap, topK) => {
        const final = buildFinalChartData(genreMap, topK);
        return Object.values(final).every((slots) => slots.length === topK);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: buildFinalChartData never places the SAME media_id in more than one slot across the whole output (global cross-genre dedup)", () => {
  fc.assert(
    fc.property(
      arbGenreMap,
      fc.integer({ min: 1, max: 6 }),
      (genreMap, topK) => {
        const final = buildFinalChartData(genreMap, topK);
        const seen = new Set<number>();
        for (const slots of Object.values(final)) {
          for (const slot of slots) {
            if (slot === null) continue;
            if (seen.has(slot.media_id)) return false;
            seen.add(slot.media_id);
          }
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: every non-null slot in buildFinalChartData's output actually existed somewhere in the input genreMap (soundness -- nothing fabricated)", () => {
  fc.assert(
    fc.property(
      arbGenreMap,
      fc.integer({ min: 1, max: 6 }),
      (genreMap, topK) => {
        const final = buildFinalChartData(genreMap, topK);
        const allInputIds = new Set<number>();
        for (const list of Object.values(genreMap)) {
          for (const r of list) allInputIds.add(r.media_id);
        }
        for (const slots of Object.values(final)) {
          for (const slot of slots) {
            if (slot !== null && !allInputIds.has(slot.media_id)) return false;
          }
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ===========================================================================
// (e) agePenaltyFactor: gate (future/null -> exactly 1.0) + monotonic-in-year
// ===========================================================================

const SEASONS_ORDER = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
const arbSeason = fc.constantFrom(...SEASONS_ORDER);
// Restricted to real, non-future, plausible years -- the gate that returns
// 1.0 unconditionally for null/future years is tested SEPARATELY below.
const arbPastYear = fc.integer({ min: 1950, max: 2026 });
const arbRate = fc.float({ min: 0, max: 1, noNaN: true });

Deno.test("property: agePenaltyFactor is exactly 1.0 for a null/undefined start year, or one strictly after the current year (the gate)", () => {
  fc.assert(
    fc.property(
      arbSeason,
      fc.integer({ min: 2027, max: 2100 }),
      arbRate,
      (season, futureYear, rate) => {
        return agePenaltyFactor(futureYear, season, 2026, rate) === 1.0 &&
          agePenaltyFactor(null, season, 2026, rate) === 1.0 &&
          agePenaltyFactor(undefined, season, 2026, rate) === 1.0 &&
          agePenaltyFactor(0, season, 2026, rate) === 1.0; // falsy start year
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: agePenaltyFactor is non-increasing as the start year gets OLDER, holding season/currentYear/rate>=0 fixed", () => {
  fc.assert(
    fc.property(
      arbPastYear,
      arbPastYear,
      arbSeason,
      arbRate,
      (y1, y2, season, rate) => {
        const currentYear = 2026;
        if (y1 > currentYear || y2 > currentYear) return true; // outside the linear domain
        const [olderYear, newerYear] = y1 <= y2 ? [y1, y2] : [y2, y1];
        const olderFactor = agePenaltyFactor(
          olderYear,
          season,
          currentYear,
          rate,
        );
        const newerFactor = agePenaltyFactor(
          newerYear,
          season,
          currentYear,
          rate,
        );
        return olderFactor <= newerFactor + 1e-9;
      },
    ),
    FC_RUNS,
  );
});

// ===========================================================================
// (f) esc: round-trip inverse + no bare metacharacter survives
// ===========================================================================

function unesc(s: string): string {
  return s
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

Deno.test("property: esc/unesc round-trip is the identity for ANY string (unrestricted domain -- this is exactly the invariant an escaping function must uphold)", () => {
  fc.assert(
    fc.property(fc.string(), (s) => unesc(esc(s)) === s),
    FC_RUNS,
  );
});

Deno.test("property: esc never leaves a bare (un-entity-encoded) <, >, &, \", or ' in its output", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const stripped = esc(s)
        .replaceAll("&amp;", "")
        .replaceAll("&lt;", "")
        .replaceAll("&gt;", "")
        .replaceAll("&quot;", "")
        .replaceAll("&#x27;", "");
      return !/[<>&"']/.test(stripped);
    }),
    FC_RUNS,
  );
});

// ===========================================================================
// (g) FLOW: buildRenderTasks -> runFanOut over randomized-but-valid inputs
// always publishes all 7, refusing/failing none.
//
// Restricted to a FIXED shape (3 users x 4 titles, all format:"TV", genres
// from a small fixed set, titles from a fixed non-reserved pool) so only the
// NUMERIC fields vary -- this keeps the property meaningful (exercising real
// arithmetic across the whole pipeline) while avoiding the title-collision /
// variable-array-size flakiness the round-1 adversarial review flagged. See
// the header comment on PROPERTY DISCIPLINE.
// ===========================================================================

const NUM_USERS = 3;
const NUM_TITLES = 4;
const TITLE_POOL = [
  "Fixture Alpha",
  "Fixture Beta",
  "Fixture Gamma",
  "Fixture Delta",
];
const GENRE_POOL = ["Comedy", "Action", "Drama"] as const;

const arbFlowInputs = fc.record({
  scores: fc.array(
    fc.array(fc.integer({ min: 1, max: 10 }), {
      minLength: NUM_TITLES,
      maxLength: NUM_TITLES,
    }),
    { minLength: NUM_USERS, maxLength: NUM_USERS },
  ),
  averages: fc.array(fc.integer({ min: 40, max: 95 }), {
    minLength: NUM_TITLES,
    maxLength: NUM_TITLES,
  }),
  popularity: fc.array(fc.integer({ min: 100, max: 5000 }), {
    minLength: NUM_TITLES,
    maxLength: NUM_TITLES,
  }),
  startYears: fc.array(fc.integer({ min: 2015, max: 2025 }), {
    minLength: NUM_TITLES,
    maxLength: NUM_TITLES,
  }),
  genres: fc.array(fc.constantFrom(...GENRE_POOL), {
    minLength: NUM_TITLES,
    maxLength: NUM_TITLES,
  }),
});

interface FlowSpec {
  scores: number[][];
  averages: number[];
  popularity: number[];
  startYears: number[];
  genres: (typeof GENRE_POOL)[number][];
}

function buildFlowInputs(spec: FlowSpec): RenderInputs {
  const users = ["fixtureUserA", "fixtureUserB", "fixtureUserC"];
  const boardRows: RawBoardRow[] = [];
  const chartMeta: RawChartMeta[] = [];
  for (let t = 0; t < NUM_TITLES; t++) {
    const mid = t + 1;
    chartMeta.push({
      media_id: mid,
      title_romaji: TITLE_POOL[t],
      title_english: TITLE_POOL[t],
      genres: [spec.genres[t]],
      format: "TV",
      start_year: spec.startYears[t],
      start_date: `${spec.startYears[t]}-07-05`,
      cover_image_large: `https://cdn.example.test/${mid}.jpg`,
    });
    users.forEach((u, ui) => {
      boardRows.push({
        user_name: u,
        media_id: mid,
        score: spec.scores[ui][t],
        title_romaji: TITLE_POOL[t],
        title_english: TITLE_POOL[t],
        genres: [spec.genres[t]],
        start_year: spec.startYears[t],
        format: "TV",
        episodes: 12,
        duration: 24,
        average_score: spec.averages[t],
        popularity: spec.popularity[t],
        cover_image_large: `https://cdn.example.test/${mid}.jpg`,
      });
    });
  }
  const chartScores: RawChartScore[] = boardRows.map((r) => ({
    user_name: r.user_name,
    media_id: r.media_id,
    score: r.score,
  }));
  const landing: LandingStats = {
    users: NUM_USERS,
    rows: boardRows.length,
    rated: boardRows.length,
    titles: NUM_TITLES,
    genres: new Set(spec.genres).size,
    cur_titles: 0,
    cur_users: 0,
    movies: 0,
    y_min: Math.min(...spec.startYears),
    y_max: Math.max(...spec.startYears),
    season: "лето 2026",
  };
  return {
    boardRows,
    boardNrows: boardRows.length,
    chartScores,
    chartMeta,
    landing,
    topK: 5,
    bayesMinVotes: 5,
    penaltyRate: 0.05,
    now: new Date("2026-07-21T12:00:00Z"),
  };
}

Deno.test("property FLOW: buildRenderTasks -> runFanOut over randomized-but-valid inputs always publishes all 7 artifacts, 0 refused, 0 failed", () => {
  fc.assert(
    fc.property(arbFlowInputs, (spec) => {
      const inputs = buildFlowInputs(spec);
      const { tasks } = buildRenderTasks(inputs);
      const result = runFanOut(tasks);
      return result.published.length === 7 && result.refused.length === 0 &&
        result.failed.length === 0;
    }),
    FC_RUNS,
  );
});
