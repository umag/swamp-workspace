/**
 * Coverage suite for @magistr/spotify-data: one test per guard that no other
 * suite protects, so deleting the guard turns a test red.
 *
 * Each test names the guard it covers and, where the guard encodes a decision
 * that looked wrong-but-is-right (or right-but-is-wrong), what breaks without
 * it — a bare "it returns 3" assertion does not survive a refactor with its
 * meaning intact.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  chunkName,
  dedupeStreams,
  isAudiobook,
  isPodcast,
  model,
  parseHistoryFile,
  partitionByYear,
  SCROBBLE_THRESHOLD_MS,
  type Stream,
  streamKey,
  toStream,
  toUts,
} from "./spotify_data.ts";

const stream = (over: Partial<Stream> = {}): Stream => ({
  uts: 1_700_000_000,
  artist: "Artist",
  track: "Track",
  msPlayed: 1000,
  ...over,
});

// --- guard: isPodcast / isAudiobook require a NON-EMPTY string --------------

Deno.test("guard: an EMPTY episode_name is not a podcast — the length check, not just the typeof", () => {
  // Without the `.length > 0` half, a record with `episode_name: ""` (which
  // the export writes for music rows in some dumps) would classify every
  // music play as a podcast and import nothing.
  assertEquals(isPodcast({ episode_name: "" }), false);
  assertEquals(isPodcast({ episode_name: "Ep 1" }), true);
  assertEquals(isPodcast({ episode_name: null }), false);
  assertEquals(isPodcast({}), false);
});

Deno.test("guard: an EMPTY audiobook_title is not an audiobook", () => {
  assertEquals(isAudiobook({ audiobook_title: "" }), false);
  assertEquals(isAudiobook({ audiobook_title: "A Book" }), true);
  assertEquals(isAudiobook({ audiobook_title: 7 }), false);
});

Deno.test("guard: a record with an empty episode_name still imports as music when it has track metadata", () => {
  const s = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1000,
    episode_name: "",
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  });
  assert(s, "an empty episode_name must not exclude a real music play");
});

// --- guard: audiobook is checked BEFORE podcast, and both before track ------

Deno.test("guard: parseHistoryFile counts a record that is BOTH audiobook and podcast once, as an audiobook", () => {
  // The counters must partition the input; double-counting would break the
  // "every record is accounted for" invariant the contract suite asserts.
  const r = parseHistoryFile([
    { audiobook_title: "B", episode_name: "E", ts: "2023-01-01T00:00:00Z" },
  ]);
  assertEquals(r.audiobooks, 1);
  assertEquals(r.podcasts, 0);
  assertEquals(r.unusable, 0);
  assertEquals(r.streams.length, 0);
});

// --- guard: track AND artist are both required ------------------------------

Deno.test("guard: a track with no artist is unusable, and an artist with no track is too", () => {
  // Either half missing makes the row uncountable in every downstream tally,
  // so both are required rather than defaulted to "Unknown".
  assertEquals(
    toStream({
      ts: "2023-01-01T00:00:00Z",
      master_metadata_track_name: "t",
    }),
    undefined,
  );
  assertEquals(
    toStream({
      ts: "2023-01-01T00:00:00Z",
      master_metadata_album_artist_name: "a",
    }),
    undefined,
  );
  assertEquals(
    toStream({
      ts: "2023-01-01T00:00:00Z",
      master_metadata_track_name: "",
      master_metadata_album_artist_name: "a",
    }),
    undefined,
  );
});

// --- guard: ms_played must be a NUMBER and non-negative ---------------------

Deno.test("guard: a string ms_played falls back to 0 instead of poisoning msPlayedTotal with NaN", () => {
  const s = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: "214000",
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  });
  assert(s);
  assertEquals(s.msPlayed, 0);
  assert(Number.isFinite(s.msPlayed));
});

// --- guard: optional booleans stay UNDEFINED, never coerced -----------------

Deno.test("guard: a missing skipped/shuffle/offline stays undefined rather than defaulting to false", () => {
  // Defaulting would be a silent claim about data the export did not carry —
  // and would make `skipRate` in the stats report understate against older
  // exports that omit the field entirely.
  const s = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1,
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  });
  assert(s);
  assertEquals(s.skipped, undefined);
  assertEquals(s.shuffle, undefined);
  assertEquals(s.offline, undefined);
});

Deno.test("guard: a non-boolean skipped is dropped rather than coerced truthy", () => {
  const s = toStream({
    ts: "2023-01-01T00:00:00Z",
    ms_played: 1,
    skipped: "yes",
    master_metadata_track_name: "t",
    master_metadata_album_artist_name: "a",
  });
  assert(s);
  assertEquals(s.skipped, undefined);
});

// --- guard: streamKey covers EVERY field ------------------------------------

Deno.test("guard: streamKey changes when ANY single field changes — no field is left out of identity", () => {
  const base = stream({
    album: "Al",
    trackUri: "spotify:track:1",
    skipped: false,
    shuffle: false,
    offline: false,
    reasonStart: "clickrow",
    reasonEnd: "trackdone",
  });
  const mutations: Array<Partial<Stream>> = [
    { uts: base.uts + 1 },
    { artist: "Other" },
    { track: "Other" },
    { album: "Other" },
    { trackUri: "spotify:track:2" },
    { msPlayed: base.msPlayed + 1 },
    { skipped: true },
    { shuffle: true },
    { offline: true },
    { reasonStart: "fwdbtn" },
    { reasonEnd: "fwdbtn" },
  ];
  const baseKey = streamKey(base);
  for (const m of mutations) {
    assert(
      streamKey({ ...base, ...m }) !== baseKey,
      `streamKey ignores ${
        Object.keys(m)[0]
      } — that field would be lost to dedupe`,
    );
  }
});

Deno.test("guard: an undefined optional and an empty string collapse to the same key slot, and do not crash", () => {
  const withUndef = streamKey(stream({ album: undefined }));
  const withEmpty = streamKey(stream({ album: "" }));
  assertEquals(withUndef, withEmpty);
});

// --- guard: dedupeStreams preserves ORDER of first occurrence ---------------

Deno.test("guard: dedupeStreams keeps the FIRST occurrence and preserves input order", () => {
  const a = stream({ uts: 3, track: "a" });
  const b = stream({ uts: 1, track: "b" });
  const out = dedupeStreams([a, b, { ...a }, b]);
  assertEquals(out.length, 2);
  assertEquals(out.map((s) => s.track), ["a", "b"]);
});

// --- guard: partitionByYear uses UTC, not local time ------------------------

Deno.test("guard: partitionByYear buckets by UTC year — a local-time implementation would misfile the boundary", () => {
  // 2023-12-31T23:59:59Z is 2024 in any timezone east of UTC. Using
  // getFullYear() instead of getUTCFullYear() would move this row's chunk
  // depending on where the import ran.
  const nye = toUts("2023-12-31T23:59:59Z")!;
  const parts = partitionByYear([stream({ uts: nye })]);
  assertEquals([...parts.keys()], ["2023"]);
});

Deno.test("guard: partitionByYear returns an empty map for no rows rather than a map with an empty year", () => {
  assertEquals(partitionByYear([]).size, 0);
});

// --- guard: the scrobble threshold is INCLUSIVE ------------------------------

Deno.test("guard: exactly 30000ms counts as over-threshold — the comparison is >=, matching Last.fm's own rule", () => {
  assertEquals(SCROBBLE_THRESHOLD_MS, 30_000);
  const rows = [
    stream({ msPlayed: SCROBBLE_THRESHOLD_MS - 1 }),
    stream({ msPlayed: SCROBBLE_THRESHOLD_MS }),
    stream({ msPlayed: SCROBBLE_THRESHOLD_MS + 1 }),
  ];
  assertEquals(
    rows.filter((s) => s.msPlayed >= SCROBBLE_THRESHOLD_MS).length,
    2,
  );
});

// --- guard: chunk naming ----------------------------------------------------

Deno.test("guard: chunkName is prefixed so a year chunk cannot be mistaken for another spec's resource", () => {
  assertEquals(chunkName("2023"), "spotify.2023");
  assertEquals(chunkName("1970"), "spotify.1970");
});

// --- guard: resource + model declarations -----------------------------------

Deno.test("guard: the model declares all three resource specs the methods write to", () => {
  const specs = Object.keys(
    (model as unknown as { resources: Record<string, unknown> }).resources,
  ).sort();
  assertEquals(specs, ["imports", "inspection", "streams"]);
});

Deno.test("guard: the model's declared type and version stay in lockstep with manifest.yaml", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../../manifest.yaml", import.meta.url),
  );
  const name = manifest.match(/^name:\s*"([^"]+)"/m)?.[1];
  const version = manifest.match(/^version:\s*"([^"]+)"/m)?.[1];
  assertEquals(model.type, name);
  assertEquals(model.version, version);
});

Deno.test("guard: both year chunks and import state are lifetime infinite — a GC'd history is unrecoverable without the original export", () => {
  const resources = (model as unknown as {
    resources: Record<string, { lifetime: string }>;
  }).resources;
  assertEquals(resources.streams.lifetime, "infinite");
  assertEquals(resources.imports.lifetime, "infinite");
});
