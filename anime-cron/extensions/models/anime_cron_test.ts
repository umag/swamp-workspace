// Unit tests for the pure helper functions in anime_cron.ts.
// Run: deno test extensions/models/anime_cron_test.ts

import {
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  baseTitle,
  buildMagnet,
  extractShowTitle,
  groupScore,
  type NyaaHit,
  parseEpisode,
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
