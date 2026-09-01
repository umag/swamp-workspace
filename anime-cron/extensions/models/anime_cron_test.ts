// Unit tests for the pure helper functions in anime_cron.ts.
// Run: deno test extensions/models/anime_cron_test.ts

import {
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  baseTitle,
  bracketGroups,
  buildMagnet,
  creditsGroup,
  decodeEntities,
  escapeHtml,
  extractShowTitle,
  groupScore,
  normGroup,
  type NyaaHit,
  parseEpisode,
  parseNyaaSize,
  parseResolution,
  pickBest,
  toFolderName,
} from "./anime_cron.ts";

// ─── parseEpisode ─────────────────────────────────────────────────────────────

Deno.test("parseEpisode: dash-separated episode number", () => {
  assertEquals(parseEpisode("[SubsPlease] Show - 01 [1080p].mkv"), 1);
  assertEquals(parseEpisode("[SubsPlease] Show - 12 [1080p].mkv"), 12);
  assertEquals(parseEpisode("[SubsPlease] Show - 01v2 [1080p].mkv"), 1);
});

Deno.test("parseEpisode: EP/E prefix format", () => {
  assertEquals(parseEpisode("Show EP01 1080p.mkv"), 1);
  assertEquals(parseEpisode("Show E12 1080p.mkv"), 12);
  assertEquals(parseEpisode("Show EP123 1080p.mkv"), 123);
});

// GITS 2026 ep 9 (2026-09-01): Erai-raws never posted, and all nine other
// 1080p releases used "S01E09" — which parsed as null, so the show sat in
// not-found for hours while VARYG/Judas were sitting on Nyaa.
Deno.test("parseEpisode: SxxExx season-episode format", () => {
  assertEquals(
    parseEpisode(
      "[Judas] Koukaku Kidoutai (2026) (The Ghost in the Shell) - S01E09 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Weekly)",
    ),
    9,
  );
  assertEquals(
    parseEpisode(
      "[DKB] The Ghost in the Shell - S01E09 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs][weekly]",
    ),
    9,
  );
  assertEquals(
    parseEpisode(
      "THE GHOST IN THE SHELL S01E09 EPISODE 09 BRAIN DRAIN ii 1080p AMZN WEB-DL DUAL DDP2.0 H.264-VARYG",
    ),
    9,
  );
  assertEquals(
    parseEpisode(
      "[ToonsHub] THE GHOST IN THE SHELL S01E09 1080p AMZN WEB-DL DUAL DDP2.0 H.265",
    ),
    9,
  );
  assertEquals(parseEpisode("Show S2E12 1080p.mkv"), 12);
  assertEquals(parseEpisode("Show s01e105 1080p.mkv"), 105);
});

Deno.test("parseEpisode: bracketed episode number", () => {
  assertEquals(parseEpisode("Show [01] 1080p.mkv"), 1);
  assertEquals(parseEpisode("Show (12) 1080p.mkv"), 12);
});

Deno.test("parseEpisode: returns null when no episode found", () => {
  assertStrictEquals(parseEpisode("[SubsPlease] Show [1080p].mkv"), null);
  assertStrictEquals(parseEpisode(""), null);
});

// ─── parseResolution ──────────────────────────────────────────────────────────

Deno.test("parseResolution: detects 2160p/4K", () => {
  assertEquals(parseResolution("[SubsPlease] Show - 01 [2160p].mkv"), 2160);
  assertEquals(parseResolution("Show 4K.mkv"), 2160);
});

Deno.test("parseResolution: detects 1080p", () => {
  assertEquals(parseResolution("[SubsPlease] Show - 01 [1080p].mkv"), 1080);
});

Deno.test("parseResolution: detects 720p", () => {
  assertEquals(parseResolution("[SubsPlease] Show - 01 [720p].mkv"), 720);
});

Deno.test("parseResolution: returns 0 for unknown", () => {
  assertEquals(parseResolution("Show - 01.mkv"), 0);
});

// ─── groupScore ───────────────────────────────────────────────────────────────

Deno.test("groupScore: known preferred groups return high scores", () => {
  assertEquals(groupScore("[SubsPlease] Show - 01.mkv"), 10);
  assertEquals(groupScore("[Erai-raws] Show - 01.mkv"), 9);
  assertEquals(groupScore("[Ember] Show - 01.mkv"), 8);
  assertEquals(groupScore("[ASW] Show - 01.mkv"), 7);
  assertEquals(groupScore("[Judas] Show - 01.mkv"), 6);
});

Deno.test("groupScore: unknown group returns 1", () => {
  assertEquals(groupScore("[RandomGroup] Show - 01.mkv"), 1);
  assertEquals(groupScore("Show - 01.mkv"), 1);
});

// ─── buildMagnet ──────────────────────────────────────────────────────────────

Deno.test("buildMagnet: produces valid magnet URI", () => {
  const magnet = buildMagnet("abc123", "Test Show");
  assertEquals(magnet.startsWith("magnet:?xt=urn:btih:abc123"), true);
  assertEquals(magnet.includes("&dn=Test%20Show"), true);
  assertEquals(magnet.includes("&tr="), true);
});

Deno.test("buildMagnet: encodes special characters in title", () => {
  const magnet = buildMagnet("abc123", "Show: Season 2 & More");
  assertEquals(magnet.includes("dn="), true);
  assertNotEquals(magnet.includes("Show: Season 2 & More"), true);
});

// ─── baseTitle ────────────────────────────────────────────────────────────────

Deno.test("baseTitle: strips subtitle after colon", () => {
  assertEquals(
    baseTitle("Mushoku Tensei: Isekai Ittara Honki Dasu"),
    "Mushoku Tensei",
  );
  assertEquals(
    baseTitle("Shokugeki no Souma: San no Sara"),
    "Shokugeki no Souma",
  );
});

Deno.test("baseTitle: strips trailing roman numerals", () => {
  assertEquals(baseTitle("Mushoku Tensei III"), "Mushoku Tensei");
  assertEquals(baseTitle("Index II"), "Index");
});

Deno.test("baseTitle: strips trailing season labels", () => {
  assertEquals(baseTitle("Kaguya-sama 2nd Season"), "Kaguya-sama");
  assertEquals(baseTitle("Attack on Titan Season 3"), "Attack on Titan");
  assertEquals(baseTitle("One Punch Man S2"), "One Punch Man");
});

Deno.test("baseTitle: strips trailing plain number", () => {
  assertEquals(baseTitle("Overlord 4"), "Overlord");
  assertEquals(baseTitle("Oregairu 3"), "Oregairu");
});

Deno.test("baseTitle: returns null when title is unchanged", () => {
  assertStrictEquals(baseTitle("Cowboy Bebop"), null);
  assertStrictEquals(baseTitle("Steins;Gate"), null);
});

// ─── toFolderName ─────────────────────────────────────────────────────────────

Deno.test("toFolderName: strips forbidden filesystem characters", () => {
  const result = toFolderName('Show: A/B\\C*D?E"F<G>H|I');
  assertEquals(result.includes(":"), false);
  assertEquals(result.includes("/"), false);
  assertEquals(result.includes("\\"), false);
  assertEquals(result.includes("*"), false);
  assertEquals(result.includes("?"), false);
  assertEquals(result.includes('"'), false);
  assertEquals(result.includes("<"), false);
  assertEquals(result.includes(">"), false);
  assertEquals(result.includes("|"), false);
});

Deno.test("toFolderName: collapses multiple spaces", () => {
  assertEquals(toFolderName("Show   Title"), "Show Title");
});

Deno.test("toFolderName: trims leading and trailing space", () => {
  assertEquals(toFolderName("  Show  "), "Show");
});

Deno.test("toFolderName: truncates at 80 characters", () => {
  const long = "A".repeat(100);
  assertEquals(toFolderName(long).length, 80);
});

// ─── extractShowTitle ─────────────────────────────────────────────────────────

Deno.test("extractShowTitle: strips leading [Group] prefix", () => {
  assertEquals(
    extractShowTitle("[SubsPlease] Frieren - 28 [1080p].mkv"),
    "Frieren",
  );
});

Deno.test("extractShowTitle: strips ' - NN ...' episode segment", () => {
  assertEquals(
    extractShowTitle("Frieren - 28 [1080p].mkv"),
    "Frieren",
  );
});

Deno.test("extractShowTitle: no-op when no group or episode segment", () => {
  assertEquals(
    extractShowTitle("Frieren [1080p].mkv"),
    "Frieren [1080p].mkv",
  );
});

Deno.test("extractShowTitle: full torrent name round-trip", () => {
  assertEquals(
    extractShowTitle("[SubsPlease] Dungeon Meshi - 07 [1080p].mkv"),
    "Dungeon Meshi",
  );
});

// ─── pickBest ─────────────────────────────────────────────────────────────────

function makeHit(
  partial: Partial<NyaaHit> & { episode: number | null },
): NyaaHit {
  return {
    title: "[Unknown] Show - 01 [1080p].mkv",
    viewUrl: "https://nyaa.si/view/1",
    magnet: "magnet:?xt=urn:btih:abc",
    infoHash: "abc",
    seeders: 10,
    resolution: 1080,
    sizeBytes: 1024 ** 3,
    ...partial,
  };
}

Deno.test("pickBest: returns null when no hit matches the episode", () => {
  const hits = [makeHit({ episode: 2 }), makeHit({ episode: 3 })];
  assertStrictEquals(pickBest(hits, 1), null);
});

Deno.test("pickBest: returns null for empty list", () => {
  assertStrictEquals(pickBest([], 1), null);
});

Deno.test("pickBest: prefers SubsPlease over unknown group", () => {
  const subsPlease = makeHit({
    episode: 1,
    title: "[SubsPlease] Show - 01 [1080p].mkv",
    seeders: 5,
    resolution: 1080,
  });
  const unknown = makeHit({
    episode: 1,
    title: "[RandomGroup] Show - 01 [1080p].mkv",
    seeders: 100,
    resolution: 1080,
  });
  assertEquals(pickBest([unknown, subsPlease], 1), subsPlease);
});

Deno.test("pickBest: prefers matching resolution over more seeders", () => {
  const correct = makeHit({
    episode: 1,
    title: "[SubsPlease] Show - 01 [1080p].mkv",
    seeders: 10,
    resolution: 1080,
  });
  const wrongRes = makeHit({
    episode: 1,
    title: "[SubsPlease] Show - 01 [720p].mkv",
    seeders: 50,
    resolution: 720,
  });
  assertEquals(pickBest([wrongRes, correct], 1, 1080), correct);
});

// ─── parseNyaaSize ────────────────────────────────────────────────────────────

Deno.test("parseNyaaSize: parses the GiB/MiB units nyaa actually emits", () => {
  assertStrictEquals(parseNyaaSize("1 GiB"), 1024 ** 3);
  assertStrictEquals(parseNyaaSize("2.5 GiB"), Math.round(2.5 * 1024 ** 3));
  assertStrictEquals(parseNyaaSize("512 MiB"), 512 * 1024 ** 2);
  assertStrictEquals(parseNyaaSize("1.0 TiB"), 1024 ** 4);
});

Deno.test("parseNyaaSize: treats the non-`i` spelling as the same power-of-two unit", () => {
  assertStrictEquals(parseNyaaSize("1 GB"), parseNyaaSize("1 GiB"));
});

Deno.test("parseNyaaSize: returns 0 for anything unparseable so a missing size never NaNs a running total", () => {
  for (const bad of ["", "   ", "unknown", "1.4 PiB", "GiB", "-3 GiB"]) {
    assertStrictEquals(parseNyaaSize(bad), 0, bad);
  }
});

// ─── decodeEntities / escapeHtml ──────────────────────────────────────────────

Deno.test("decodeEntities: decodes &amp; LAST so an escaped entity is not double-decoded", () => {
  assertStrictEquals(decodeEntities("A &amp; B"), "A & B");
  // If &amp; were decoded first, this would collapse to "<b>".
  assertStrictEquals(decodeEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
});

Deno.test("decodeEntities: handles the apostrophe spellings nyaa emits", () => {
  assertStrictEquals(decodeEntities("Let&#39;s Go"), "Let's Go");
  assertStrictEquals(decodeEntities("Let&apos;s Go"), "Let's Go");
});

Deno.test("escapeHtml: escapes & before < and > so the result is stable under re-parse", () => {
  assertStrictEquals(
    escapeHtml("[LonelyChaser & Kineko Video]"),
    "[LonelyChaser &amp; Kineko Video]",
  );
  assertStrictEquals(escapeHtml("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
});

// ─── bracketGroups / normGroup / creditsGroup ─────────────────────────────────

Deno.test("bracketGroups: splits a collab credit on every separator nyaa uses", () => {
  assertEquals(bracketGroups("[LonelyChaser & Kineko Video] Foo"), [
    "LonelyChaser",
    "Kineko Video",
  ]);
  assertEquals(bracketGroups("[A + B] Foo"), ["A", "B"]);
  assertEquals(bracketGroups("[A, B] Foo"), ["A", "B"]);
  assertEquals(bracketGroups("[A / B] Foo"), ["A", "B"]);
});

Deno.test("bracketGroups: decodes entities before splitting so an encoded collab still splits", () => {
  assertEquals(bracketGroups("[LonelyChaser &amp; Kineko Video] Foo"), [
    "LonelyChaser",
    "Kineko Video",
  ]);
});

Deno.test("bracketGroups: returns empty for a title with no leading bracket", () => {
  assertEquals(bracketGroups("Kineko video presents something"), []);
});

Deno.test("normGroup: strips punctuation and case", () => {
  assertStrictEquals(normGroup("LonelyChaser-Raws"), "lonelychaserraws");
  assertStrictEquals(normGroup("Kineko Video"), "kinekovideo");
});

Deno.test("creditsGroup: matches the exact credit, a suffixed alias, and a collab member", () => {
  const want = ["Kineko Video", "LonelyChaser"];
  assertStrictEquals(
    creditsGroup("[Kineko Video] Foo", want),
    "Kineko Video",
  );
  assertStrictEquals(
    creditsGroup("[LonelyChaser-Raws] Foo", want),
    "LonelyChaser-Raws",
  );
  assertStrictEquals(
    creditsGroup("[LonelyChaser & Kineko Video] Foo", want),
    "LonelyChaser",
  );
  // Bare "Kineko" is the shorter side of the wanted "Kineko Video".
  assertStrictEquals(creditsGroup("[Kineko] Foo", want), "Kineko");
});

Deno.test("creditsGroup: does NOT match a title that merely mentions the group outside the credit bracket", () => {
  const want = ["Kineko Video", "LonelyChaser"];
  assertStrictEquals(
    creditsGroup("Kineko video presents pokemon the first movie", want),
    null,
  );
  assertStrictEquals(
    creditsGroup("[SomeoneElse] A tribute to Kineko Video", want),
    null,
  );
});

Deno.test("creditsGroup: a below-MIN_STEM token cannot wildcard onto every group", () => {
  // "K" normalizes to 1 char — under the 5-char stem floor on BOTH sides, so
  // it must neither match as a wanted term nor as a credited group.
  assertStrictEquals(creditsGroup("[Kineko Video] Foo", ["K"]), null);
  assertStrictEquals(creditsGroup("[K] Foo", ["Kineko Video"]), null);
});

Deno.test("pickBest: a below-target resolution is rejected outright, not ranked down", () => {
  // The hard floor is the point: a top-scoring group at 720p must lose to
  // nothing at all, so the run reports not-found and retries next hour rather
  // than permanently filling the library with the wrong master.
  const only720 = makeHit({
    episode: 1,
    title: "[SubsPlease] Show - 01 [720p].mkv",
    seeders: 100,
    resolution: 720,
  });
  assertStrictEquals(pickBest([only720], 1, 1080), null);
});

Deno.test("pickBest: a resolution ABOVE the target is still eligible", () => {
  // The floor is >=, not ==: 2160p must remain downloadable when 1080p is asked
  // for, or every 4K-only release would silently never be fetched.
  const uhd = makeHit({
    episode: 1,
    title: "[SubsPlease] Show - 01 [2160p].mkv",
    seeders: 10,
    resolution: 2160,
  });
  assertEquals(pickBest([uhd], 1, 1080), uhd);
});
