/**
 * Property suite for @magistr/ryot (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) letterboxdToRyotRating — every half-star 0.5..5 maps to stars×20,
 *      in 10..100, and is monotonic.
 *  (b) parseTmdbFromFilmPage — round-trips any id/type a page carries.
 *  (c) isLetterboxdUri — never accepts an option-looking or non-https
 *      string, so nothing hostile reaches curl's argv.
 *  (d) import_films flow — for any snapshot + owned set, the stored counts
 *      match the uploaded export, no seen film stays on the Watchlist, and a
 *      second non-forced real import is refused without any Ryot request.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import fc from "npm:fast-check@4.8.0";
import {
  isLetterboxdUri,
  letterboxdToRyotRating,
  model,
  parseTmdbFromFilmPage,
} from "./ryot.ts";
import {
  filmPage,
  importArgs,
  makeCtx,
  ryotRoute,
  withCurl,
  withFetch,
} from "./ryot_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");

Deno.test("property: half-star ratings map to stars×20 within 10..100", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 1, max: 10 }),
      (a, b) => {
        const ra = letterboxdToRyotRating(a / 2)!;
        const rb = letterboxdToRyotRating(b / 2)!;
        assertEquals(ra, a * 10);
        assert(ra >= 10 && ra <= 100);
        if (a <= b) assert(ra <= rb);
      },
    ),
    { numRuns },
  );
});

Deno.test("property: parseTmdbFromFilmPage round-trips id and type", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2_000_000_000 }),
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.string({ maxLength: 40 }).filter((s) => !s.includes("data-tmdb")),
      (id, type, noise) => {
        const html = `${noise}${filmPage(id, type)}${noise}`;
        assertEquals(parseTmdbFromFilmPage(html), {
          tmdbId: id,
          tmdbType: type,
        });
      },
    ),
    { numRuns },
  );
});

Deno.test("property: isLetterboxdUri rejects option-like and non-https input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), (s) => {
      assert(!isLetterboxdUri(`-${s}`));
      assert(!isLetterboxdUri(`http://boxd.it/${s}`));
      if (isLetterboxdUri(s)) {
        const u = new URL(s);
        assertEquals(u.protocol, "https:");
      }
    }),
    { numRuns },
  );
});

type Film = { name: string; year: null; uri: string; date: null };

// Small id space so lists overlap often (watched ∩ watchlist, duplicates).
const filmArb: fc.Arbitrary<Film> = fc.integer({ min: 1, max: 12 }).map((
  n,
) => ({ name: `F${n}`, year: null, uri: `https://boxd.it/f${n}`, date: null }));

const flowArb = fc.record({
  watched: fc.array(filmArb, { maxLength: 6 }),
  ratings: fc.array(
    fc.tuple(filmArb, fc.integer({ min: 1, max: 10 })).map(([f, r]) => ({
      ...f,
      rating: r / 2,
    })),
    { maxLength: 6 },
  ),
  watchlist: fc.array(filmArb, { maxLength: 6 }),
  owned: fc.array(
    fc.integer({ min: 1, max: 12 }).map((n) => ({ tmdbId: 1000 + n })),
    { maxLength: 4 },
  ),
  ownedAsSeen: fc.boolean(),
});

// Film fN → TMDB 1000+N for N ≤ 9 (shared with owned ids); N ≥ 10 is TV.
const curlRoute = (url: string) => {
  const n = Number(url.split("/f")[1]);
  return { body: filmPage(1000 + n, n >= 10 ? "tv" : "movie"), status: 200 };
};

type Meta = {
  identifier: string;
  seen_history: unknown[];
  reviews: unknown[];
  collections: { collection_name: string }[];
};

Deno.test("property: import_films counts match the export; guard blocks re-import", async () => {
  await fc.assert(
    fc.asyncProperty(flowArb, async (f) => {
      const { ctx, written } = makeCtx();
      await withCurl(curlRoute, () =>
        withFetch(ryotRoute(), async (calls) => {
          await model.methods.import_films.execute(
            importArgs({
              snapshot: {
                watched: f.watched,
                ratings: f.ratings,
                watchlist: f.watchlist,
              },
              owned: f.owned,
              ownedAsSeen: f.ownedAsSeen,
            }),
            ctx,
          );
          assertEquals(calls.length, 2);
          const meta = (calls[0].body as { metadata: Meta[] }).metadata;
          const res = written.find((w) => w.spec === "importResult")!
            .payload as Record<string, number>;
          const has = (m: Meta, c: string) =>
            m.collections.some((x) => x.collection_name === c);
          assertEquals(res.movies, meta.length);
          assertEquals(
            new Set(meta.map((m) => m.identifier)).size,
            meta.length,
          );
          assertEquals(
            res.seen,
            meta.filter((m) => m.seen_history.length > 0).length,
          );
          assertEquals(res.rated, meta.filter((m) => m.reviews.length).length);
          assertEquals(
            res.watchlist,
            meta.filter((m) => has(m, "Watchlist")).length,
          );
          assertEquals(res.owned, meta.filter((m) => has(m, "Owned")).length);
          for (const m of meta) {
            assert(!(m.seen_history.length > 0 && has(m, "Watchlist")));
          }

          const before = calls.length;
          await assertRejects(() =>
            model.methods.import_films.execute(importArgs(), ctx)
          );
          assertEquals(calls.length, before);
        }));
    }),
    { numRuns },
  );
});
