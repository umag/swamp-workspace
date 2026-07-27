import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildFinalChartData,
  type Rankable,
  rankGenre,
  SORT_KEYS,
} from "./chart_rank.ts";

function r(partial: Partial<Rankable> & { media_id: number }): Rankable {
  return {
    title: "t" + partial.media_id,
    votes: 0,
    average_score: 0,
    ...partial,
  };
}

const ids = (list: (Rankable | null)[]) =>
  list.map((x) => (x ? x.media_id : null));

// ══════════════════════════════════════════════════════════════════════════
// THE CRITICAL TEST: votes and score DISAGREE, so a "list is sorted" assertion
// cannot fail. A: votes=2 avg=9.0 ; B: votes=5 avg=7.0.
//   /chart  (votes primary)     => [B, A]
//   /fresh  (penalized primary) => [A, B]   (penalized == avg here, factor 1.0)
//   /bayes  (bayesian primary)  => [A, B]
// If the three rules were collapsed into one, at least one of these fails.
// ══════════════════════════════════════════════════════════════════════════
Deno.test("rankGenre: three DIFFERENT rules on a disagreeing fixture", () => {
  const A = r({
    media_id: 1,
    votes: 2,
    average_score: 9.0,
    penalized_score: 9.0,
    bayesian_rating: 9.0,
  });
  const B = r({
    media_id: 2,
    votes: 5,
    average_score: 7.0,
    penalized_score: 7.0,
    bayesian_rating: 7.0,
  });
  const rows = [A, B];

  // chart & current: [votes desc, avg desc] -> B (5 votes) then A
  assertEquals(ids(rankGenre(rows, "chart")), [2, 1]);
  assertEquals(ids(rankGenre(rows, "current")), [2, 1]);

  // fresh: [penalized desc, votes desc] -> A (9.0) then B  (INVERTS chart)
  assertEquals(ids(rankGenre(rows, "fresh")), [1, 2]);

  // bayes: [bayesian desc, votes desc] -> A (9.0) then B
  assertEquals(ids(rankGenre(rows, "bayes")), [1, 2]);
});

Deno.test("rankGenre does not mutate its input", () => {
  const rows = [
    r({ media_id: 1, votes: 2, average_score: 9 }),
    r({ media_id: 2, votes: 5, average_score: 7 }),
  ];
  const before = rows.map((x) => x.media_id);
  rankGenre(rows, "chart");
  assertEquals(rows.map((x) => x.media_id), before);
});

Deno.test("rankGenre secondary key breaks ties (chart: avg desc within equal votes)", () => {
  const rows = [
    r({ media_id: 1, votes: 5, average_score: 7 }),
    r({ media_id: 2, votes: 5, average_score: 9 }),
    r({ media_id: 3, votes: 2, average_score: 10 }),
  ];
  // votes 5 group first (avg desc: 2 then 1), then votes 2 (id 3)
  assertEquals(ids(rankGenre(rows, "chart")), [2, 1, 3]);
});

Deno.test("SORT_KEYS encodes the rule table (last Python sort = primary)", () => {
  assertEquals(SORT_KEYS.chart, ["votes", "average_score"]);
  assertEquals(SORT_KEYS.current, ["votes", "average_score"]);
  assertEquals(SORT_KEYS.fresh, ["penalized_score", "votes"]);
  assertEquals(SORT_KEYS.bayes, ["bayesian_rating", "votes"]);
});

// ══════════════════════════════════════════════════════════════════════════
// build_final_chart_data (bayesian.py:208-273): cross-genre dedup + backfill.
// topK = 2. `s` (media_id 1) tops both A and B.
//   - s lands in A[0] (best rank, A scanned first); B[0] is vacated
//   - B[0] backfills from B's own tail (b2, media_id 5)
//   - genre C's whole top-K is claimed elsewhere -> renders as [null, null]
//   - an unfillable slot stays null (empty cell), never "None"/"undefined"
// ══════════════════════════════════════════════════════════════════════════
Deno.test("buildFinalChartData: dedup across genres, backfill vacated slots", () => {
  const s = r({ media_id: 1, title: "s" });
  const a1 = r({ media_id: 2, title: "a1" });
  const b1 = r({ media_id: 3, title: "b1" });
  const b2 = r({ media_id: 5, title: "b2" });

  const genreMap: Record<string, Rankable[]> = {
    A: [s, a1],
    B: [s, b1, b2],
    C: [s, a1],
  };
  const final = buildFinalChartData(genreMap, 2);

  // s appears exactly ONCE across the whole chart, and it is in A[0]
  const flat = [...final.A, ...final.B, ...final.C].filter(
    Boolean,
  ) as Rankable[];
  assertEquals(flat.filter((x) => x.media_id === 1).length, 1);
  assertEquals(final.A[0]!.media_id, 1);

  // B[0] was vacated (s went to A) and backfilled from B's tail with b2
  assertEquals(ids(final.B), [5, 3]);

  // C's entire top-K was claimed elsewhere, yet C still renders — as empty cells
  assert("C" in final, "genre C must still be present in the output");
  assertEquals(ids(final.C), [null, null]);

  // no slot is a string sentinel; empties are null
  for (const g of Object.values(final)) {
    for (const cell of g) {
      assert(cell === null || typeof cell === "object");
    }
  }
});

Deno.test("buildFinalChartData: every genre list has exactly topK slots", () => {
  const final = buildFinalChartData(
    { A: [r({ media_id: 1 })], B: [r({ media_id: 2 }), r({ media_id: 3 })] },
    3,
  );
  assertEquals(final.A.length, 3);
  assertEquals(final.B.length, 3);
  assertEquals(ids(final.A), [1, null, null]); // short genre -> trailing empties
});
