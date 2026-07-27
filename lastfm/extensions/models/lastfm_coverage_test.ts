/**
 * Branch/line sweep over the pure helpers of @magistr/lastfm — no network, no
 * model context. These are the primitives every method composes, so their
 * branches are exercised here rather than indirectly through method tests.
 *
 * Covered: redactKey, classifyError, normalizeMbid, toNumber, asArray,
 * scrobbleKey, dedupeScrobbles, partitionByYear, chunkName,
 * parseRecentTracksPage, advanceCursor.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  advanceCursor,
  asArray,
  chunkName,
  classifyError,
  dedupeScrobbles,
  normalizeMbid,
  parseRecentTracksPage,
  partitionByYear,
  redactKey,
  type Scrobble,
  scrobbleKey,
  toNumber,
} from "./lastfm.ts";

const KEY = "0123456789abcdef0123456789abcdef";

// --- redactKey -------------------------------------------------------------

Deno.test("redactKey: removes the api_key value from a query string", () => {
  const out = redactKey(
    `https://ws.audioscrobbler.com/2.0/?method=user.getInfo&api_key=${KEY}&format=json`,
  );
  assert(!out.includes(KEY), `key leaked: ${out}`);
  assert(out.includes("method=user.getInfo"), "other params must survive");
});

Deno.test("redactKey: also redacts api_sig", () => {
  const sig = "fedcba9876543210fedcba9876543210";
  const out = redactKey(`https://ws.audioscrobbler.com/2.0/?api_sig=${sig}`);
  assert(!out.includes(sig), `signature leaked: ${out}`);
});

Deno.test("redactKey: a URL with no key passes through unchanged in substance", () => {
  const url = "https://ws.audioscrobbler.com/2.0/?method=user.getInfo";
  assert(redactKey(url).includes("method=user.getInfo"));
});

Deno.test("redactKey: failure path — a non-URL string does not throw", () => {
  assertEquals(typeof redactKey("not a url at all"), "string");
});

// --- classifyError ---------------------------------------------------------

Deno.test("classifyError: permanent codes are 6, 10, 26", () => {
  for (const code of [6, 10, 26]) {
    assertEquals(classifyError(code), "permanent", `code ${code}`);
  }
});

Deno.test("classifyError: transient codes are 8, 11, 16, 29", () => {
  for (const code of [8, 11, 16, 29]) {
    assertEquals(classifyError(code), "transient", `code ${code}`);
  }
});

Deno.test("classifyError: unknown codes default to permanent (fail fast, do not hammer)", () => {
  assertEquals(classifyError(2), "permanent");
  assertEquals(classifyError(999), "permanent");
});

// --- normalizeMbid ---------------------------------------------------------

Deno.test("normalizeMbid: empty string becomes undefined", () => {
  assertEquals(normalizeMbid(""), undefined);
  assertEquals(normalizeMbid("   "), undefined);
});

Deno.test("normalizeMbid: a real mbid survives", () => {
  const id = "b7ffd2af-418f-4be2-bdd1-22f8b48613da";
  assertEquals(normalizeMbid(id), id);
});

Deno.test("normalizeMbid: failure path — non-string input becomes undefined", () => {
  assertEquals(normalizeMbid(undefined), undefined);
  assertEquals(normalizeMbid(null), undefined);
  assertEquals(normalizeMbid(42), undefined);
});

// --- toNumber --------------------------------------------------------------

Deno.test("toNumber: Last.fm sends numbers as strings", () => {
  assertEquals(toNumber("17004"), 17004);
  assertEquals(toNumber(17004), 17004);
});

Deno.test("toNumber: failure path — junk becomes undefined, not NaN", () => {
  assertEquals(toNumber("abc"), undefined);
  assertEquals(toNumber(""), undefined);
  assertEquals(toNumber(null), undefined);
  assertEquals(toNumber(undefined), undefined);
});

// --- asArray ---------------------------------------------------------------

Deno.test("asArray: a single-element list arrives as a bare object", () => {
  assertEquals(asArray({ a: 1 }), [{ a: 1 }]);
});

Deno.test("asArray: an array passes through", () => {
  assertEquals(asArray([1, 2]), [1, 2]);
});

Deno.test("asArray: failure path — null/undefined become empty", () => {
  assertEquals(asArray(null), []);
  assertEquals(asArray(undefined), []);
});

// --- scrobbleKey / dedupeScrobbles ----------------------------------------

const s = (uts: number, artist: string, track: string): Scrobble => ({
  uts,
  artist,
  track,
});

Deno.test("scrobbleKey: identity is (uts, artist, track)", () => {
  assertEquals(scrobbleKey(s(1, "a", "t")), scrobbleKey(s(1, "a", "t")));
  assert(scrobbleKey(s(1, "a", "t")) !== scrobbleKey(s(2, "a", "t")));
  assert(scrobbleKey(s(1, "a", "t")) !== scrobbleKey(s(1, "b", "t")));
});

Deno.test("scrobbleKey: album is NOT part of identity", () => {
  const withAlbum: Scrobble = { ...s(1, "a", "t"), album: "X" };
  assertEquals(scrobbleKey(withAlbum), scrobbleKey(s(1, "a", "t")));
});

Deno.test("dedupeScrobbles: collapses duplicates across a page boundary", () => {
  const out = dedupeScrobbles([s(2, "a", "t"), s(1, "b", "u"), s(2, "a", "t")]);
  assertEquals(out.length, 2);
});

Deno.test("dedupeScrobbles: failure path — empty input yields empty output", () => {
  assertEquals(dedupeScrobbles([]), []);
});

// --- partitionByYear / chunkName ------------------------------------------

/** 2007-03-05T00:00:00Z and 2008-01-01T00:00:00Z */
const UTS_2007 = Date.UTC(2007, 2, 5) / 1000;
const UTS_2008 = Date.UTC(2008, 0, 1) / 1000;

Deno.test("partitionByYear: splits on the UTC calendar year", () => {
  const parts = partitionByYear([
    s(UTS_2007, "a", "t"),
    s(UTS_2008, "b", "u"),
    s(UTS_2007 + 60, "c", "v"),
  ]);
  assertEquals(parts.get("2007")?.length, 2);
  assertEquals(parts.get("2008")?.length, 1);
});

Deno.test("partitionByYear: a year boundary inside one page splits correctly", () => {
  const lastSecondOf2007 = Date.UTC(2007, 11, 31, 23, 59, 59) / 1000;
  const firstSecondOf2008 = Date.UTC(2008, 0, 1, 0, 0, 0) / 1000;
  const parts = partitionByYear([
    s(lastSecondOf2007, "a", "t"),
    s(firstSecondOf2008, "b", "u"),
  ]);
  assertEquals(parts.get("2007")?.length, 1);
  assertEquals(parts.get("2008")?.length, 1);
});

Deno.test("partitionByYear: failure path — empty input yields an empty map", () => {
  assertEquals(partitionByYear([]).size, 0);
});

Deno.test("chunkName: kind-suffixed so it cannot collide with another spec's instance", () => {
  assertEquals(chunkName("2007"), "scrobbles.2007");
});

// --- parseRecentTracksPage -------------------------------------------------

Deno.test("parseRecentTracksPage: extracts scrobbles and pagination", () => {
  const out = parseRecentTracksPage({
    recenttracks: {
      "@attr": { user: "u3BpaT", page: "1", perPage: "200", totalPages: "86" },
      track: [
        {
          artist: { "#text": "Fief", mbid: "" },
          album: { "#text": "II", mbid: "abc" },
          name: "I",
          date: { uts: "1200000000" },
        },
      ],
    },
  });
  assertEquals(out.page, 1);
  assertEquals(out.totalPages, 86);
  assertEquals(out.scrobbles.length, 1);
  assertEquals(out.scrobbles[0].artist, "Fief");
  assertEquals(out.scrobbles[0].album, "II");
  assertEquals(out.scrobbles[0].uts, 1200000000);
  assertEquals(out.scrobbles[0].artistMbid, undefined, "empty mbid normalized");
  assertEquals(out.scrobbles[0].albumMbid, "abc");
});

Deno.test("parseRecentTracksPage: the now-playing entry has no uts and is NOT a scrobble", () => {
  const out = parseRecentTracksPage({
    recenttracks: {
      "@attr": { page: "1", totalPages: "1" },
      track: [
        {
          "@attr": { nowplaying: "true" },
          artist: { "#text": "Eldamar" },
          name: "Akt III",
        },
        {
          artist: { "#text": "Fief" },
          name: "I",
          date: { uts: "1200000000" },
        },
      ],
    },
  });
  assertEquals(out.scrobbles.length, 1, "now-playing must not enter history");
  assertEquals(out.scrobbles[0].track, "I");
  assertEquals(out.nowPlaying?.track, "Akt III");
});

Deno.test("parseRecentTracksPage: a single track arrives as an object, not an array", () => {
  const out = parseRecentTracksPage({
    recenttracks: {
      "@attr": { page: "1", totalPages: "1" },
      track: {
        artist: { "#text": "Fief" },
        name: "I",
        date: { uts: "1200000000" },
      },
    },
  });
  assertEquals(out.scrobbles.length, 1);
});

Deno.test("parseRecentTracksPage: failure path — empty history yields no scrobbles", () => {
  const out = parseRecentTracksPage({
    recenttracks: { "@attr": { page: "1", totalPages: "0" }, track: [] },
  });
  assertEquals(out.scrobbles.length, 0);
  assertEquals(out.totalPages, 0);
});

Deno.test("parseRecentTracksPage: failure path — a track missing its album still parses", () => {
  const out = parseRecentTracksPage({
    recenttracks: {
      "@attr": { page: "1", totalPages: "1" },
      track: [{
        artist: { "#text": "Fief" },
        name: "I",
        date: { uts: "1200000000" },
      }],
    },
  });
  assertEquals(out.scrobbles[0].album, undefined);
});

// --- advanceCursor ---------------------------------------------------------

Deno.test("advanceCursor: moves to the newest uts seen", () => {
  assertEquals(advanceCursor(0, [s(5, "a", "t"), s(9, "b", "u")]), 9);
});

Deno.test("advanceCursor: never moves backwards", () => {
  assertEquals(advanceCursor(100, [s(5, "a", "t")]), 100);
});

Deno.test("advanceCursor: failure path — no scrobbles leaves the cursor alone", () => {
  assertEquals(advanceCursor(42, []), 42);
});
