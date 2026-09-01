/**
 * Tests for the two reports @magistr/spotify-data ships.
 *
 * Both reports are pure derivations over a flat run of plays, so the pure
 * exports (`buildStats`, `latestPerName`, `foldTitle`, `matchPlays`,
 * `rankArtists`) are the whole surface worth testing — the swamp plumbing
 * around them is a thin read of year chunks.
 *
 * The load-bearing claims under test:
 *  - `total` and `listens` are NOT interchangeable (the 30s threshold)
 *  - `latestPerName` drops deleted handles rather than resurfacing an older
 *    live version of the same name
 *  - `matchPlays` is one-to-one, so repeated plays of one track in an evening
 *    cannot all match a single counterpart
 *  - `foldTitle` merges the diacritic variants that split an artist's real
 *    playcount across two Last.fm entries
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildStats, latestPerName, type StatStream } from "./spotify_stats.ts";
import {
  foldTitle,
  matchPlays,
  type Play,
  playKey,
  rankArtists,
} from "./listening_overlap.ts";

const s = (over: Partial<StatStream> = {}): StatStream => ({
  uts: 1_680_373_325, // 2023-04-01T18:22:05Z
  artist: "Japan",
  track: "Ghosts",
  msPlayed: 214000,
  ...over,
});

// ---------------------------------------------------------------------------
// latestPerName — shared by both reports
// ---------------------------------------------------------------------------

Deno.test("latestPerName: keeps the newest version per name", () => {
  const out = latestPerName([
    { name: "spotify.2023", version: 1, lifecycle: "active" },
    { name: "spotify.2023", version: 3, lifecycle: "active" },
    { name: "spotify.2023", version: 2, lifecycle: "active" },
    { name: "spotify.2024", version: 1, lifecycle: "active" },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out.find((h) => h.name === "spotify.2023")?.version, 3);
});

Deno.test("latestPerName: a name whose newest version is deleted does NOT fall back to an older live one", () => {
  // Falling back would resurrect a chunk the user deleted on purpose.
  const out = latestPerName([
    { name: "spotify.2023", version: 1, lifecycle: "active" },
    { name: "spotify.2023", version: 2, lifecycle: "deleted" },
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].version, 1);
});

Deno.test("latestPerName: a name with EVERY version deleted disappears entirely", () => {
  const out = latestPerName([
    { name: "spotify.2023", version: 1, lifecycle: "deleted" },
    { name: "spotify.2023", version: 2, lifecycle: "deleted" },
  ]);
  assertEquals(out, []);
});

// ---------------------------------------------------------------------------
// buildStats
// ---------------------------------------------------------------------------

Deno.test("buildStats: total counts every stream, listens only those past 30s, and the two sum with belowThreshold", () => {
  const stats = buildStats([
    s({ msPlayed: 214000 }),
    s({ msPlayed: 30000 }), // exactly the threshold — counts
    s({ msPlayed: 29999 }), // one ms short — does not
    s({ msPlayed: 4200 }),
  ]);
  assertEquals(stats.total, 4);
  assertEquals(stats.listens, 2);
  assertEquals(stats.belowThreshold, 2);
  assertEquals(
    stats.total as number,
    (stats.listens as number) + (stats.belowThreshold as number),
  );
});

Deno.test("buildStats: an empty run yields zeroed totals rather than NaN or undefined", () => {
  const stats = buildStats([]);
  assertEquals(stats.total, 0);
  assertEquals(stats.listens, 0);
  assertEquals(stats.skipRate, 0, "a 0/0 skip rate must not be NaN");
  assertEquals(stats.hoursPlayed, 0);
  assertEquals(stats.uniqueArtists, 0);
  assertEquals(stats.firstUts, undefined);
  assertEquals(stats.topArtists, []);
});

Deno.test("buildStats: skipRate is a percentage of ALL streams, to one decimal", () => {
  const stats = buildStats([
    s({ skipped: true }),
    s({ skipped: true }),
    s({ skipped: false }),
    s({ skipped: undefined }),
  ]);
  assertEquals(stats.skipped, 2);
  assertEquals(stats.skipRate, 50);
});

Deno.test("buildStats: byYear and byHour bucket in UTC", () => {
  const stats = buildStats([
    s({ uts: 1_680_373_325 }), // 2023-04-01T18:22:05Z
    s({ uts: 1_704_067_201 }), // 2024-01-01T00:00:01Z
  ]);
  assertEquals(stats.byYear, { "2023": 1, "2024": 1 });
  assertEquals(stats.byHour, { "18": 1, "0": 1 });
});

Deno.test("buildStats: uniqueTracks keys on artist AND track, so the same title by two artists is two tracks", () => {
  const stats = buildStats([
    s({ artist: "A", track: "Untitled" }),
    s({ artist: "B", track: "Untitled" }),
  ]);
  assertEquals(stats.uniqueTracks, 2);
  assertEquals(stats.uniqueArtists, 2);
});

Deno.test("buildStats: topArtists ranks by playcount, breaking ties alphabetically for a stable order", () => {
  const stats = buildStats([
    s({ artist: "B" }),
    s({ artist: "B" }),
    s({ artist: "C" }),
    s({ artist: "A" }),
  ]);
  assertEquals(stats.topArtists, [
    { name: "B", playcount: 2 },
    { name: "A", playcount: 1 },
    { name: "C", playcount: 1 },
  ]);
});

Deno.test("buildStats: topArtistsByTime ranks by listening TIME, which can disagree with playcount", () => {
  const stats = buildStats([
    s({ artist: "Shorty", msPlayed: 1000 }),
    s({ artist: "Shorty", msPlayed: 1000 }),
    s({ artist: "Epic", msPlayed: 3_600_000 }),
  ]);
  const byTime = stats.topArtistsByTime as Array<{ name: string }>;
  const byCount = stats.topArtists as Array<{ name: string }>;
  assertEquals(byTime[0].name, "Epic");
  assertEquals(byCount[0].name, "Shorty");
});

Deno.test("buildStats: byReasonEnd only tallies records that carry the field", () => {
  const stats = buildStats([
    s({ reasonEnd: "trackdone" }),
    s({ reasonEnd: "fwdbtn" }),
    s({ reasonEnd: undefined }),
  ]);
  assertEquals(stats.byReasonEnd, { trackdone: 1, fwdbtn: 1 });
});

Deno.test("buildStats: firstUts and lastUts bound the run regardless of input order", () => {
  const stats = buildStats([
    s({ uts: 300 }),
    s({ uts: 100 }),
    s({ uts: 200 }),
  ]);
  assertEquals(stats.firstUts, 100);
  assertEquals(stats.lastUts, 300);
});

// ---------------------------------------------------------------------------
// foldTitle / playKey
// ---------------------------------------------------------------------------

Deno.test("foldTitle: diacritic variants of one artist fold together — the split-playcount case this exists for", () => {
  assertEquals(foldTitle("Za Frûmi"), foldTitle("Za Frűmi"));
  assertEquals(foldTitle("Za Frûmi"), foldTitle("za frumi"));
});

Deno.test("foldTitle: parenthesised and bracketed suffixes are dropped", () => {
  assertEquals(foldTitle("Ghosts (Remastered)"), foldTitle("Ghosts"));
  assertEquals(foldTitle("Ghosts [Live]"), foldTitle("Ghosts"));
});

Deno.test("foldTitle: punctuation and spacing differences collapse, but distinct words do not", () => {
  assertEquals(foldTitle("Sunday - Bloody Sunday"), "sunday bloody sunday");
  assertEquals(foldTitle("  Ghosts!  "), "ghosts");
  // Folding normalizes separators, but never merges genuinely different words:
  // word boundaries survive, so "abc" and "a b c" stay distinct.
  assert(foldTitle("abc") !== foldTitle("a b c"));
  assert(foldTitle("Ghosts") !== foldTitle("Ghost"));
});

Deno.test("playKey: separates artist from track so a shared string cannot cross-match", () => {
  assert(
    playKey({ uts: 1, artist: "a b", track: "c" }) !==
      playKey({ uts: 1, artist: "a", track: "b c" }),
  );
});

// ---------------------------------------------------------------------------
// matchPlays
// ---------------------------------------------------------------------------

const p = (uts: number, artist = "A", track = "T"): Play => ({
  uts,
  artist,
  track,
});

Deno.test("matchPlays: a play inside the window matches its counterpart", () => {
  const r = matchPlays([p(1000)], [p(1100)]);
  assertEquals(r.matched, 1);
  assertEquals(r.spotifyOnly, 0);
  assertEquals(r.lastfmOnly, 0);
  assertEquals(r.deltas, [100]);
});

Deno.test("matchPlays: a play outside the window does not match, and is returned as unmatched", () => {
  const r = matchPlays([p(1000)], [p(99999)]);
  assertEquals(r.matched, 0);
  assertEquals(r.spotifyOnly, 1);
  assertEquals(r.lastfmOnly, 1);
  assertEquals(r.unmatchedSpotify.length, 1);
});

Deno.test("matchPlays is ONE-TO-ONE: three plays of one track cannot all match a single counterpart", () => {
  // A naive "does any counterpart exist" test would report matched=3 here and
  // silently claim the two extra plays were corroborated.
  const r = matchPlays([p(1000), p(1010), p(1020)], [p(1005)]);
  assertEquals(r.matched, 1);
  assertEquals(r.spotifyOnly, 2);
  assertEquals(r.lastfmOnly, 0);
  assertEquals(r.unmatchedSpotify.length, 2);
});

Deno.test("matchPlays: N plays match at most N counterparts, each consumed once", () => {
  const r = matchPlays([p(1000), p(1010)], [p(1001), p(1011), p(1021)]);
  assertEquals(r.matched, 2);
  assertEquals(r.lastfmOnly, 1);
});

Deno.test("matchPlays: the NEAREST unconsumed counterpart wins, not the first in the list", () => {
  const r = matchPlays([p(1000)], [p(1500), p(1001)]);
  assertEquals(r.matched, 1);
  assertEquals(
    r.deltas,
    [1],
    "the 1s-away counterpart must win over the 500s one",
  );
});

Deno.test("matchPlays: a differently-spelled artist still matches, because keys are folded", () => {
  const r = matchPlays(
    [p(1000, "Za Frûmi", "Sons of the Sea")],
    [p(1010, "Za Frűmi", "Sons of the Sea")],
  );
  assertEquals(r.matched, 1);
});

Deno.test("matchPlays: unmatchedSpotify holds exactly the plays that did not match, for a double-count-free combined tally", () => {
  const spotify = [p(1000), p(50_000, "B", "U")];
  const r = matchPlays(spotify, [p(1005)]);
  assertEquals(r.matched, 1);
  assertEquals(r.unmatchedSpotify.map((x) => x.artist), ["B"]);
  // The report's combined tally is (all lastfm) + (unmatched spotify);
  // concatenating both sources instead would count the matched play twice.
  assertEquals(1 + r.unmatchedSpotify.length, 2);
});

Deno.test("matchPlays: empty inputs on either side are handled without matching anything", () => {
  assertEquals(matchPlays([], []).matched, 0);
  assertEquals(matchPlays([p(1)], []).spotifyOnly, 1);
  assertEquals(matchPlays([], [p(1)]).lastfmOnly, 1);
});

// ---------------------------------------------------------------------------
// rankArtists
// ---------------------------------------------------------------------------

Deno.test("rankArtists: spelling variants merge into one entry, counted together and labelled with the commonest spelling", () => {
  const ranked = rankArtists([
    p(1, "Za Frûmi"),
    p(2, "Za Frûmi"),
    p(3, "Za Frűmi"),
  ], 10);
  assertEquals(ranked.length, 1);
  assertEquals(ranked[0].playcount, 3);
  assertEquals(ranked[0].variants, 2);
  assertEquals(ranked[0].name, "Za Frûmi", "the commonest spelling labels it");
});

Deno.test("rankArtists: an artist folding to an empty key is skipped rather than ranked as ''", () => {
  const ranked = rankArtists([p(1, "!!!"), p(2, "Real")], 10);
  assertEquals(ranked.map((r) => r.name), ["Real"]);
});

Deno.test("rankArtists: respects the limit and orders by playcount, tie-broken by folded key", () => {
  const ranked = rankArtists([
    p(1, "B"),
    p(2, "B"),
    p(3, "A"),
    p(4, "C"),
  ], 2);
  assertEquals(ranked.length, 2);
  assertEquals(ranked[0].name, "B");
  assertEquals(ranked[1].name, "A");
});
