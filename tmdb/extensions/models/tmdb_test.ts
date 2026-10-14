/**
 * Contract-fixture suite for @magistr/tmdb: pins normalization of the TMDB
 * v3 wire format (search rows, movie/tv details with appended responses,
 * error envelope) against hand-written fixtures — no network.
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  normalizeDetails,
  normalizeHit,
  type SearchHit,
  yearOf,
} from "./tmdb.ts";
import { fixture } from "./tmdb_test_helpers.ts";

Deno.test("search/movie rows normalize; malformed and person rows drop", () => {
  const body = JSON.parse(fixture("search-movie.json"));
  const hits = body.results
    .map((r: unknown) => normalizeHit(r, "movie"))
    .filter((h: SearchHit | null) => h !== null);
  assertEquals(hits.length, 2);
  assertEquals(hits[0], {
    id: 13,
    kind: "movie",
    title: "Forrest Gump",
    originalTitle: "Forrest Gump",
    year: 1994,
    originalLanguage: "en",
    popularity: 70.1,
    voteCount: 27000,
    overview: "A man with a low IQ has accomplished great things in his life.",
  });
});

Deno.test("search/tv rows use name / first_air_date", () => {
  const body = JSON.parse(fixture("search-tv.json"));
  const h = normalizeHit(body.results[0], "tv")!;
  assertEquals([h.kind, h.title, h.year], ["tv", "Sherlock", 2010]);
});

Deno.test("movie details normalize with credits, keywords, certification", () => {
  const d = normalizeDetails(
    JSON.parse(fixture("movie-13.json")),
    "movie",
    "NL",
  );
  assertEquals(d.imdbId, "tt0109830");
  assertEquals(d.wikidataId, "Q134773");
  assertEquals(d.year, 1994);
  assertEquals(d.runtime, 142);
  assertEquals(d.genres, ["Comedy", "Drama", "Romance"]);
  assertEquals(d.countries, ["US"]);
  assertEquals(d.spokenLanguages, ["en"]);
  assertEquals(d.directors, ["Robert Zemeckis"]);
  assertEquals(d.writers, ["Eric Roth", "Winston Groom"]);
  assertEquals(d.cast[0], { name: "Tom Hanks", character: "Forrest Gump" });
  assertEquals(d.keywords, ["vietnam war", "based on novel or book"]);
  assertEquals(d.certification, "12");
  assertEquals(d.collection, null);
  assertEquals(d.posterUrl, "https://image.tmdb.org/t/p/w500/poster.jpg");
  assertEquals(d.tmdbUrl, "https://www.themoviedb.org/movie/13");
});

Deno.test("tv details: creators as directors, runtime from episode_run_time", () => {
  const d = normalizeDetails(JSON.parse(fixture("tv-19885.json")), "tv", "NL");
  assertEquals(d.title, "Sherlock");
  assertEquals(d.directors, ["Mark Gatiss", "Steven Moffat"]);
  assertEquals(d.runtime, 90);
  assertEquals([d.seasons, d.episodes], [4, 13]);
  assertEquals(d.keywords, ["detective"]);
  assertEquals(d.certification, "12");
});

Deno.test("yearOf parses ISO dates and rejects junk", () => {
  assertEquals(yearOf("1994-06-23"), 1994);
  assertEquals(yearOf(""), null);
  assertEquals(yearOf(null), null);
  assertEquals(yearOf("unknown"), null);
});
