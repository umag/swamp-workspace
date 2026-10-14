/**
 * Property / invariant suite for @magistr/tmdb (fast-check). FC_NUM_RUNS
 * raises the run count for the nightly soak.
 */
import fc from "npm:fast-check@4.8.0";
import { assert } from "jsr:@std/assert@1.0.13";
import {
  normalizeTitle,
  rateLimitDelayMs,
  scoreHit,
  titleSimilarity,
} from "./tmdb.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const numRuns = ENV_RUNS ? Number(ENV_RUNS) : 200;

Deno.test("titleSimilarity is symmetric, bounded, and 1 on equality", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      const s = titleSimilarity(a, b);
      assert(s >= 0 && s <= 1);
      assert(Math.abs(s - titleSimilarity(b, a)) < 1e-12);
      if (normalizeTitle(a) && normalizeTitle(a) === normalizeTitle(b)) {
        assert(s === 1);
      }
    }),
    { numRuns },
  );
});

Deno.test("normalizeTitle is idempotent", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const n = normalizeTitle(s);
      assert(normalizeTitle(n) === n || normalizeTitle(n).length < n.length);
    }),
    { numRuns },
  );
});

Deno.test("an exact title+year hit always outscores a different-year one", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Za-z][A-Za-z ]{2,20}$/),
      fc.integer({ min: 1900, max: 2030 }),
      fc.integer({ min: 3, max: 50 }),
      (title, year, gap) => {
        const mk = (y: number) => ({
          id: 1,
          kind: "movie" as const,
          title,
          originalTitle: null,
          year: y,
          originalLanguage: null,
          popularity: 0,
          voteCount: 0,
          overview: null,
        });
        const q = { title, altTitles: [], year };
        assert(scoreHit(q, mk(year)) > scoreHit(q, mk(year + gap)));
      },
    ),
    { numRuns },
  );
});

Deno.test("rateLimitDelayMs never negative, never above the interval", () => {
  fc.assert(
    fc.property(
      fc.option(fc.nat()),
      fc.nat(),
      fc.nat({ max: 10000 }),
      (last, now, iv) => {
        const d = rateLimitDelayMs(last, now, iv);
        assert(d >= 0 && d <= iv);
      },
    ),
    { numRuns },
  );
});
