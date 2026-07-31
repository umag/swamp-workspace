/**
 * Coverage suite for @magistr/music-library: regression guards for branches
 * NOT already exercised by the contract-fixture suite (`music_library_test.ts`)
 * or by `extensions/lib/running_test.ts` — STANDARD.md's coverage role:
 * "if someone deletes this guard, does a test go red?"
 *
 * Every helper exercised here is PURE (no I/O), so unlike the methods/
 * adversarial suites this file needs no `Deno.Command` stub at all — it
 * drives `fixEncoding`/`isPlaceholder`/`buildCube`/`findDupes`/
 * `classifyVerify`/`parseBpmLine`/`bpmResourceName` directly, mirroring
 * `music_library_test.ts`'s own style.
 *
 * Specifically owns (not duplicated elsewhere):
 *  - `fixEncoding`'s empty-string guard and its depth>2 recursion cutoff.
 *  - `isPlaceholder`'s "new artist"/"new title"/Cyrillic "дорожка N"/bare
 *    "va" alternatives (the contract suite only exercises "Unknown *",
 *    "Track N", "AudioTrack N" and the "исполнитель" alternative).
 *  - `buildCube`'s quality-bucket assignment across ALL FOUR buckets
 *    (contract only ever hits lossy-high via the row() helper's default
 *    320kbps); the artist fallback when NO track in an album carries any
 *    artist information at all (tag, filename, AND directory all empty);
 *    the disc-subdir guard requiring a truthy `leftPath` (a bare `right_path`
 *    that LOOKS like "CD1" at the library root is NOT treated as a disc
 *    subdirectory); and `dosMangledNames`/`encodingFixes` being filtered by
 *    `maxAlbums`' `inKept` gate (the contract suite only exercises this gate
 *    for `issues.untagged`).
 *  - `findDupes`'s two "normalizes to empty" skip guards — an album title
 *    that is pure release noise, and a track artist that is pure noise.
 *  - `classifyVerify`'s full-mode branch where NOTHING was ever decoded
 *    (`decodedSec === null`): the truncated check is skipped entirely and
 *    the file falls through to "ok" — a real, documented behavior, not a
 *    security pin (see the adversarial suite for the RS-framing-driven
 *    variant of this same fall-through).
 *  - `parseBpmLine`'s "unknown error" fallback when a failure record omits
 *    `err`, its rejection of a non-string `path`, and its strict `=== true`
 *    check on `windowed` (a truthy-but-not-`true` value reads as `false`).
 *  - `bpmResourceName`'s three branches (explicit file / pathPrefix scope /
 *    whole-library) — currently exercised nowhere else, even though
 *    `running()`'s resource lookup depends on this naming holding exactly.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bpmResourceName,
  buildCube,
  classifyVerify,
  findDupes,
  fixEncoding,
  isPlaceholder,
  parseBpmLine,
} from "./music_library.ts";

// ---------------------------------------------------------------------------
// fixEncoding
// ---------------------------------------------------------------------------

Deno.test("fixEncoding: empty string is untouched (falsy-input guard)", () => {
  const r = fixEncoding("");
  assertEquals(r, { value: "", fixed: false, encoding: null });
});

Deno.test("fixEncoding: depth > 2 recursion cutoff returns unchanged even for legacy-shaped input", () => {
  const r = fixEncoding("Êëàóäèî Ìîíòåâåðäè", 3);
  assertEquals(r, {
    value: "Êëàóäèî Ìîíòåâåðäè",
    fixed: false,
    encoding: null,
  });
});

// ---------------------------------------------------------------------------
// isPlaceholder
// ---------------------------------------------------------------------------

Deno.test("isPlaceholder: 'New Artist'/'New Title' tagger defaults", () => {
  assert(isPlaceholder("New Artist"));
  assert(isPlaceholder("new title"));
});

Deno.test("isPlaceholder: bare 'va' (Various Artists shorthand) is a placeholder; the spelled-out form is not", () => {
  assert(isPlaceholder("va"));
  assert(isPlaceholder("VA"));
  assertEquals(isPlaceholder("Various Artists"), false);
});

Deno.test("isPlaceholder: Cyrillic 'дорожка N' (track N) is a placeholder", () => {
  assert(isPlaceholder("дорожка 5"));
  assert(isPlaceholder("Дорожка"));
});

// ---------------------------------------------------------------------------
// buildCube — row() helper mirrors music_library_test.ts's own
// ---------------------------------------------------------------------------

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    filename: "01 - Intro.mp3",
    tag_title: "Intro",
    tag_track_artist: "Artist A",
    track_number: 1,
    disc_number: null,
    tag_year: 2001,
    length: 100,
    bitrate: 320,
    size: 4000000,
    left_path: "",
    right_path: "Artist A - Album X (2001)",
    album_title: "Album X",
    album_artist: "Artist A",
    album_year: 2001,
    compilation: 0,
    ...over,
  };
}

Deno.test("buildCube: quality buckets — lossy-mid (160-255 kbps), lossy-low (<160), and unknown (no bitrate, lossy format)", () => {
  const cube = buildCube(
    [
      row({ id: 1, bitrate: 200 }),
      row({
        id: 2,
        filename: "02.mp3",
        bitrate: 128,
        right_path: "Artist A - Album X (2001)",
      }),
      row({
        id: 3,
        filename: "03.mp3",
        bitrate: null,
        right_path: "Artist A - Album X (2001)",
      }),
    ],
    new Map(),
  );
  const buckets = new Map(cube.dims.quality.map((q) => [q.bucket, q]));
  assert(buckets.has("lossy-mid"));
  assertEquals(buckets.get("lossy-mid")!.trackCount, 1);
  assert(buckets.has("lossy-low"));
  assertEquals(buckets.get("lossy-low")!.trackCount, 1);
  assert(buckets.has("unknown"));
  assertEquals(buckets.get("unknown")!.trackCount, 1);
});

Deno.test("buildCube: album artist falls back to null when NO track carries any artist info at all (tag, filename, and dir all empty)", () => {
  const cube = buildCube(
    [
      row({
        tag_track_artist: null,
        album_artist: null,
        filename: "01.mp3",
        left_path: "",
        right_path: "###", // parseAlbumDir yields no artist from pure noise
      }),
    ],
    new Map(),
  );
  assertEquals(cube.albums[0].artist, null);
});

Deno.test("buildCube: a right_path shaped like a disc dir ('CD1') at the LIBRARY ROOT (no leftPath) is NOT collapsed as a disc subdirectory", () => {
  const cube = buildCube(
    [row({ left_path: "", right_path: "CD1" })],
    new Map(),
  );
  assertEquals(cube.albums.length, 1);
  assertEquals(cube.albums[0].dir, "CD1");
  assertEquals(cube.albums[0].tracks[0].discNo, null);
});

Deno.test("buildCube: dosMangledNames and encodingFixes are filtered by maxAlbums' inKept gate, same as untagged", () => {
  const rows = [
    row({ id: 1 }), // kept album
    row({
      id: 2,
      filename: "01-bos~1.mp3", // DOS-mangled name, dropped album
      tag_track_artist: "Êëàóäèî Ìîíòåâåðäè", // encoding fix, dropped album
      right_path: "Artist B - Album Y (2005)",
      album_title: "Album Y",
      album_artist: null,
    }),
  ];
  const capped = buildCube(rows, new Map(), { maxAlbums: 1 });
  assertEquals(capped.albums.length, 1);
  assertEquals(
    capped.issues.dosMangledNames.length,
    0,
    "the dropped album's DOS-mangled name must not leak into issues",
  );
  assertEquals(
    capped.issues.encodingFixes.length,
    0,
    "the dropped album's encoding fix must not leak into issues",
  );
  // sanity: without the cap, both appear
  const uncapped = buildCube(rows, new Map());
  assertEquals(uncapped.issues.dosMangledNames.length, 1);
  assertEquals(uncapped.issues.encodingFixes.length, 1);
});

// ---------------------------------------------------------------------------
// findDupes
// ---------------------------------------------------------------------------

Deno.test("findDupes: an album title that normalizes to EMPTY (pure release noise) is skipped from clustering entirely", () => {
  const cube = buildCube(
    [
      row({
        id: 1,
        right_path: "Artist A - Remastered (2001)",
        album_title: "(Remastered)",
      }),
      row({
        id: 2,
        filename: "02.mp3",
        right_path: "Artist A - Remastered Redux (2002)",
        album_title: "[Deluxe Edition]",
      }),
    ],
    new Map(),
  );
  const { albumClusters } = findDupes(cube.albums);
  assertEquals(
    albumClusters.length,
    0,
    "both albums' titles normalize to '' (pure noise words) and are excluded before clustering",
  );
});

Deno.test("findDupes: a track TITLE that normalizes to EMPTY is skipped from track clustering (the key's 'k.endsWith(\"|\")' guard checks the TITLE half, not the artist half)", () => {
  const cube = buildCube(
    [
      row({
        id: 1,
        tag_track_artist: "Real Artist",
        tag_title: "(Remastered)",
      }),
      row({
        id: 2,
        filename: "02.mp3",
        tag_track_artist: "Real Artist",
        tag_title: "(Remastered)",
        right_path: "Some Other Album (2002)",
        album_title: "Some Other Album",
        album_artist: "Real Artist",
      }),
    ],
    new Map(),
  );
  const { trackClusters } = findDupes(cube.albums);
  assertEquals(
    trackClusters.length,
    0,
    "both tracks share the same real artist and would otherwise cluster, " +
      "but their title '(Remastered)' normalizes to '' (pure release " +
      "noise) — the key ends with the '|' separator and the guard skips " +
      "them before they ever reach byTrack",
  );
});

// ---------------------------------------------------------------------------
// classifyVerify
// ---------------------------------------------------------------------------

Deno.test("classifyVerify: full mode with NOTHING decoded (decodedSec === null) falls through to 'ok' — the truncated check requires a non-null decodedSec", () => {
  assertEquals(classifyVerify(0, [], 200, null, "full"), "ok");
});

// ---------------------------------------------------------------------------
// parseBpmLine
// ---------------------------------------------------------------------------

Deno.test("parseBpmLine: a failure record with NO `err` field falls back to 'unknown error'", () => {
  const { failure } = parseBpmLine(
    '{"path":"/music/x.mp3","rc":1}',
    (p) => p,
  );
  assert(failure);
  assertEquals(failure.err, "unknown error");
});

Deno.test("parseBpmLine: a non-string `path` field is rejected (treated as no record at all)", () => {
  assertEquals(
    parseBpmLine('{"path":42,"rc":0,"bpm":120}', (p) => p),
    {},
  );
});

Deno.test("parseBpmLine: `windowed` is a STRICT `=== true` check — a truthy-but-not-boolean value (1) reads as false", () => {
  const { track } = parseBpmLine(
    '{"path":"/music/x.mp3","rc":0,"bpm":120,"windowed":1}',
    (p) => p,
  );
  assert(track);
  assertEquals(track.windowed, false);
});

// ---------------------------------------------------------------------------
// bpmResourceName
// ---------------------------------------------------------------------------

Deno.test("bpmResourceName: three branches — whole library, pathPrefix scope, explicit file", () => {
  assertEquals(bpmResourceName("", ""), "bpm-library");
  const prefixName = bpmResourceName("", "Some Artist");
  assert(prefixName.startsWith("bpm-some-artist-"));
  const fileName = bpmResourceName("Some Artist/Album/01 - Track.mp3", "");
  assert(fileName.startsWith("bpm-file-01-track-mp3-"));
  // a path takes priority over a pathPrefix when both happen to be set
  const both = bpmResourceName("a/b.mp3", "prefix");
  assert(both.startsWith("bpm-file-"));
});
