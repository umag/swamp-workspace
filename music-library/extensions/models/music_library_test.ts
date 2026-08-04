// Unit tests for the pure helpers in music_library.ts.
// Run: deno test --allow-all extensions/models/music_library_test.ts
//
// scan/probe hit SSH + sqlite3/ffprobe (covered by live runs); the
// unit-testable surface is encoding recovery, placeholder detection,
// directory/filename parsing, naming helpers, and cube construction.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bpmConfidenceBand,
  bpmHistogram,
  buildCube,
  classifyVerify,
  findDupes,
  fixEncoding,
  hash8,
  isPlaceholder,
  normDupeKey,
  parseAlbumDir,
  parseBpmLine,
  parseFfmpegVerifyOutput,
  parseTrackFilename,
  slugify,
} from "./music_library.ts";
import headphonesArtistsFixture from "../../fixtures/headphones_artists.json" with {
  type: "json",
};
import mbReleaseGroupsFixture from "../../fixtures/mb_release_groups.json" with {
  type: "json",
};
import mbReleaseGroupsEmptyFixture from "../../fixtures/mb_release_groups_empty.json" with {
  type: "json",
};

// --- fixEncoding ---

Deno.test("fixEncoding: cp1251-as-latin1 mojibake is recovered", () => {
  // "Клаудио Монтеверди" written as cp1251, decoded as latin1 by a tagger
  const r = fixEncoding("Êëàóäèî Ìîíòåâåðäè");
  assert(r.fixed, "should be fixed");
  assertEquals(r.value, "Клаудио Монтеверди");
  assertEquals(r.encoding, "windows-1251");
});

Deno.test("fixEncoding: mixed ASCII + cp1251 parenthetical", () => {
  const r = fixEncoding("Claudio Monteverdi (Êëàóäèî Ìîíòåâåðäè)");
  assert(r.fixed, "should be fixed");
  assertEquals(r.value, "Claudio Monteverdi (Клаудио Монтеверди)");
});

Deno.test("fixEncoding: double-encoded UTF-8 is unwrapped", () => {
  const r = fixEncoding("BÃ¶ses Erwachen");
  assert(r.fixed);
  assertEquals(r.value, "Böses Erwachen");
  assertEquals(r.encoding, "utf-8(double)");
});

Deno.test("fixEncoding: double-encoded UTF-8 Cyrillic", () => {
  // "Сплин" → UTF-8 bytes → decoded as latin1
  const mojibake = new TextDecoder("latin1").decode(
    new TextEncoder().encode("Сплин"),
  );
  const r = fixEncoding(mojibake);
  assert(r.fixed);
  assertEquals(r.value, "Сплин");
});

Deno.test("fixEncoding: proper UTF-8 Cyrillic is untouched", () => {
  const r = fixEncoding("Король и Шут");
  assertEquals(r.fixed, false);
  assertEquals(r.value, "Король и Шут");
});

Deno.test("fixEncoding: genuine latin1 umlauts are untouched", () => {
  // Real German umlaut text must NOT be corrupted to Cyrillic
  const r = fixEncoding("Böses Erwachen");
  assertEquals(r.fixed, false);
  assertEquals(r.value, "Böses Erwachen");
});

Deno.test("fixEncoding: plain ASCII is untouched", () => {
  const r = fixEncoding("Subway To Sally");
  assertEquals(r.fixed, false);
});

Deno.test("fixEncoding: koi8-r mojibake is recovered", () => {
  // "Аквариум - Русский альбом" in koi8-r bytes, latin1-decoded
  const koi8Bytes = [
    0xc1,
    0xcb,
    0xd7,
    0xc1,
    0xd2,
    0xc9,
    0xd5,
    0xcd,
    0x20,
    0xd2,
    0xd5,
    0xd3,
    0xd3,
    0xcb,
    0xc9,
    0xca,
    0x20,
    0xc1,
    0xcc,
    0xd8,
    0xc2,
    0xcf,
    0xcd,
  ];
  const mojibake = String.fromCharCode(...koi8Bytes);
  const r = fixEncoding(mojibake);
  assert(r.fixed, `expected fix, got ${JSON.stringify(r)}`);
  assertEquals(r.value.toLowerCase(), "аквариум русский альбом");
});

Deno.test("fixEncoding: Icelandic accents are NOT corrupted to Cyrillic", () => {
  // regression: sparse accents in mostly-ASCII words must fail the
  // word-shape gate ("Blóð" = 2 of 4 letters high)
  for (const s of ["Blóð Ok Dýrð", "Mín móðir", "Sigur Rós - Ágætis byrjun"]) {
    const r = fixEncoding(s);
    assertEquals(r.fixed, false, `should not fix ${s}`);
    assertEquals(r.value, s);
  }
});

Deno.test("fixEncoding: short cp1251 word wins over Greek misdetection", () => {
  // "Бред" as cp1251 mojibake; jschardet's top guess may be iso-8859-7,
  // but the allowlist walks ranked candidates to windows-1251
  const r = fixEncoding("Áðåä");
  if (r.fixed) {
    assertEquals(r.value, "Бред");
    assertEquals(r.encoding, "windows-1251");
  } else {
    // acceptable fallback: left as-is, never corrupted to another script
    assertEquals(r.value, "Áðåä");
  }
});

Deno.test("fixEncoding: custom allowlist disables recovery", () => {
  const r = fixEncoding("Êëàóäèî Ìîíòåâåðäè", 0, new Set<string>());
  assertEquals(r.fixed, false);
});

Deno.test("fixEncoding: ASCII-heavy string with cp1251 words is recovered", () => {
  // detection must run on the high-byte words, not the diluted full string
  const r = fixEncoding("Îïåðà Îðôåé ( L'Orfeo ) (John Eliott Gardiner)");
  assert(r.fixed, `expected fix, got ${JSON.stringify(r)}`);
  assertEquals(r.value, "Опера Орфей ( L'Orfeo ) (John Eliott Gardiner)");
});

// --- isPlaceholder ---

Deno.test("isPlaceholder: tagger placeholders", () => {
  assert(isPlaceholder("Unknown Artist"));
  assert(isPlaceholder("Unknown Album"));
  assert(isPlaceholder("unknown"));
  assert(isPlaceholder("Track  1"));
  assert(isPlaceholder("track 07"));
  assert(isPlaceholder("AudioTrack 05"));
  assert(isPlaceholder("Неизвестный исполнитель"));
  assert(isPlaceholder(""));
  assert(isPlaceholder("   "));
  assert(isPlaceholder("----"));
  assert(isPlaceholder("???"));
});

Deno.test("isPlaceholder: real values are kept", () => {
  assertEquals(isPlaceholder("Various Artists"), false);
  assertEquals(isPlaceholder("The Tracks"), false);
  assertEquals(isPlaceholder("Кино"), false);
});

// --- parseAlbumDir ---

Deno.test("parseAlbumDir: year-dot artist-album with noise", () => {
  const r = parseAlbumDir(
    "1983. Mike Oldfield - Crises (2013) (Super Deluxe Edition) [24-96]",
  );
  assertEquals(r.year, 1983);
  assertEquals(r.artist, "Mike Oldfield");
  assertEquals(r.album, "Crises");
});

Deno.test("parseAlbumDir: artist-album-parenyear with catalog prefix", () => {
  const r = parseAlbumDir("(LFTFLD21) Carbon Based Lifeforms - ALT-02 (2020)");
  assertEquals(r.year, 2020);
  assertEquals(r.artist, "Carbon Based Lifeforms");
  assertEquals(r.album, "ALT-02");
});

Deno.test("parseAlbumDir: year-dash album only", () => {
  const r = parseAlbumDir("1996 - The Devil's Songs");
  assertEquals(r.year, 1996);
  assertEquals(r.artist, null);
  assertEquals(r.album, "The Devil's Songs");
});

Deno.test("parseAlbumDir: year space album", () => {
  const r = parseAlbumDir("1998 Oceanborn (Brasil version)");
  assertEquals(r.year, 1998);
  assertEquals(r.album, "Oceanborn (Brasil version)");
});

Deno.test("parseAlbumDir: bracketed artist with release noise", () => {
  const r = parseAlbumDir(
    "2008, [Ice Ages] Buried Silence (CD, Album) (CD 08-1488)",
  );
  assertEquals(r.year, 2008);
  assertEquals(r.artist, "Ice Ages");
  assertEquals(r.album, "Buried Silence");
});

Deno.test("parseAlbumDir: discography year range", () => {
  const r = parseAlbumDir(
    "(Dalriada) Echo Of Dalriada - Discography (2004-2011) 320",
  );
  assertEquals(r.year, 2004);
  assertEquals(r.artist, "Echo Of Dalriada");
  assertEquals(r.album, "Discography");
});

Deno.test("parseAlbumDir: quality suffixes stripped", () => {
  const r = parseAlbumDir("1000mods - Youth of Dissent (2020) [FLAC]");
  assertEquals(r.year, 2020);
  assertEquals(r.artist, "1000mods");
  assertEquals(r.album, "Youth of Dissent");
});

Deno.test("parseAlbumDir: collection index + trailing paren year", () => {
  const r = parseAlbumDir("01 House Of Pain - (1992)");
  assertEquals(r.year, 1992);
  assertEquals(r.album, "House Of Pain");
});

Deno.test("parseAlbumDir: multi-dash artist keeps album tail", () => {
  const r = parseAlbumDir("2013 - bvdub & Loscil - Erebus [320]");
  assertEquals(r.year, 2013);
  assertEquals(r.artist, "bvdub & Loscil");
  assertEquals(r.album, "Erebus");
});

// --- parseTrackFilename ---

Deno.test("parseTrackFilename: NN space Title", () => {
  const r = parseTrackFilename("02 Jump Around", "House Of Pain");
  assertEquals(r.trackNo, 2);
  assertEquals(r.title, "Jump Around");
});

Deno.test("parseTrackFilename: NN-dash-Title", () => {
  const r = parseTrackFilename("07 - Letters From The Past", null);
  assertEquals(r.trackNo, 7);
  assertEquals(r.title, "Letters From The Past");
});

Deno.test("parseTrackFilename: Artist - NN - Title", () => {
  const r = parseTrackFilename("Opeth - 04 - Hope Leaves", null);
  assertEquals(r.trackNo, 4);
  assertEquals(r.artist, "Opeth");
  assertEquals(r.title, "Hope Leaves");
});

Deno.test("parseTrackFilename: known artist prefix is stripped", () => {
  const r = parseTrackFilename("03 Burzum - Spell Of Destruction", "Burzum");
  assertEquals(r.trackNo, 3);
  assertEquals(r.title, "Spell Of Destruction");
});

Deno.test("parseTrackFilename: underscores become spaces", () => {
  const r = parseTrackFilename("01_Der_Ahnungsschauer", null);
  assertEquals(r.trackNo, 1);
  assertEquals(r.title, "Der Ahnungsschauer");
});

Deno.test("parseTrackFilename: DOS-mangled 8.3 name is flagged", () => {
  const r = parseTrackFilename("01-bos~1", null);
  assert(r.dosMangled);
});

// --- naming ---

Deno.test("slugify: ascii, cyrillic translit, cjk fallback", () => {
  assertEquals(slugify("Mike Oldfield"), "mike-oldfield");
  assertEquals(slugify("Король и Шут"), "korol-i-shut");
  assertEquals(slugify("!!!"), "x");
});

Deno.test("hash8: stable and hex", () => {
  assertEquals(hash8("a/b/c"), hash8("a/b/c"));
  assert(/^[0-9a-f]{8}$/.test(hash8("anything")));
});

// --- buildCube ---

function row(over = {}) {
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

Deno.test("buildCube: tagged track lands in album + artist + dims", () => {
  const cube = buildCube([row()], new Map([[1, ["Rock"]]]));
  assertEquals(cube.albums.length, 1);
  const alb = cube.albums[0];
  assertEquals(alb.title, "Album X");
  assertEquals(alb.artist, "Artist A");
  assertEquals(alb.year, 2001);
  assertEquals(alb.tracks[0].source, "tags");
  assertEquals(alb.tracks[0].genres, ["Rock"]);
  assertEquals(cube.artists.length, 1);
  assertEquals(cube.artists[0].name, "Artist A");
  assertEquals(cube.dims.genres[0].genre, "Rock");
  assertEquals(cube.dims.quality[0].bucket, "lossy-high");
  assertEquals(cube.summary.totals.tracks, 1);
});

Deno.test("buildCube: untagged track falls back to dir naming", () => {
  const cube = buildCube(
    [
      row({
        id: 2,
        filename: "02 Jump Around.mp3",
        tag_title: null,
        tag_track_artist: "Unknown Artist",
        track_number: null,
        tag_year: null,
        album_title: "Unknown Album",
        album_artist: "Unknown Artist",
        album_year: null,
        left_path: "01 House Of Pain/",
        right_path: "01 House Of Pain - (1992)",
      }),
    ],
    new Map(),
  );
  const t = cube.albums[0].tracks[0];
  assertEquals(t.title, "Jump Around");
  assertEquals(t.artist, "House Of Pain");
  assertEquals(t.trackNo, 2);
  assertEquals(t.year, 1992);
  assertEquals(t.source, "dirname");
  assert(t.fallbackFields.includes("title"));
  assertEquals(cube.albums[0].year, 1992);
  assertEquals(cube.summary.sources.dirname, 1);
});

Deno.test("buildCube: mojibake tags are fixed and recorded", () => {
  const cube = buildCube(
    [
      row({
        id: 3,
        tag_track_artist: "Êëàóäèî Ìîíòåâåðäè",
        album_artist: null,
      }),
    ],
    new Map(),
  );
  const t = cube.albums[0].tracks[0];
  assertEquals(t.artist, "Клаудио Монтеверди");
  assert(t.fixedFields.includes("artist"));
  assertEquals(cube.issues.encodingFixes.length, 1);
  assertEquals(cube.issues.encodingFixes[0].encoding, "windows-1251");
  assertEquals(cube.summary.encodingFixedTracks, 1);
});

Deno.test("buildCube: disc subdirs collapse into one album", () => {
  const cube = buildCube(
    [
      row({
        id: 4,
        left_path: "Artist A/Album X/",
        right_path: "CD1",
        filename: "01 - One.mp3",
        tag_title: "One",
      }),
      row({
        id: 5,
        left_path: "Artist A/Album X/",
        right_path: "CD2",
        filename: "01 - Two.mp3",
        tag_title: "Two",
      }),
    ],
    new Map(),
  );
  assertEquals(cube.albums.length, 1);
  assertEquals(cube.albums[0].trackCount, 2);
  assertEquals(cube.albums[0].discCount, 2);
  assertEquals(cube.albums[0].tracks.map((t) => t.discNo), [1, 2]);
});

Deno.test("buildCube: pathPrefix filters, maxAlbums caps + filters issues", () => {
  const rows = [
    row(),
    row({
      id: 6,
      right_path: "Artist B - Album Y (2005)",
      tag_track_artist: "Artist B",
      album_title: "Album Y",
      tag_title: null,
      filename: "??.mp3",
    }),
  ];
  const filtered = buildCube(rows, new Map(), {
    pathPrefix: "Artist A - Album X",
  });
  assertEquals(filtered.albums.length, 1);
  const capped = buildCube(rows, new Map(), { maxAlbums: 1 });
  assertEquals(capped.albums.length, 1);
  // issue entries for the dropped album must not leak into the capped cube
  for (const u of capped.issues.untagged) {
    assert(u.path.startsWith("Artist A - Album X"));
  }
});

Deno.test("buildCube: various artists album", () => {
  const cube = buildCube(
    [
      row({ id: 7, tag_track_artist: "A1", album_artist: null }),
      row({
        id: 8,
        filename: "02 - B.mp3",
        tag_track_artist: "A2",
        album_artist: null,
      }),
    ],
    new Map(),
  );
  assertEquals(cube.albums.length, 1);
  assertEquals(cube.albums[0].artist, "Various Artists");
  assertEquals(cube.artists.length, 2);
});

// --- dupes ---

Deno.test("normDupeKey: strips noise, brackets, punctuation, case", () => {
  assertEquals(normDupeKey("Crises (Remastered) [Deluxe Edition]"), "crises");
  assertEquals(normDupeKey("The Devil's Songs"), "the devil s songs");
  assertEquals(normDupeKey("ALT-02"), "alt 02");
});

Deno.test("normDupeKey: meaningful bracket content is kept", () => {
  // "(Part One)" vs "(Part Two)" must NOT normalize to the same key
  assert(
    normDupeKey("Fahrenheit Project (Part One)") !==
      normDupeKey("Fahrenheit Project (Part Two)"),
  );
});

Deno.test("findDupes: box-set sibling subdirs are not duplicates", () => {
  // discs of one box share album tags and a parent dir → variants, not dupes
  const cube = buildCube(
    [
      row({
        id: 30,
        left_path: "Artist A - Box (2020)/",
        right_path: "D1 Original Mix",
        album_title: "Box",
      }),
      row({
        id: 31,
        left_path: "Artist A - Box (2020)/",
        right_path: "D2 Remixed",
        album_title: "Box",
        filename: "01 - Intro Remix.mp3",
      }),
    ],
    new Map(),
  );
  const { albumClusters } = findDupes(cube.albums);
  assertEquals(albumClusters.length, 0);
});

Deno.test("findDupes: same album in two dirs clusters, best kept", () => {
  const cube = buildCube(
    [
      row({
        id: 20,
        right_path: "Artist A - Album X (2001) [FLAC]",
        filename: "01 - Intro.flac",
      }),
      row({ id: 21 }),
    ],
    new Map(),
  );
  const { albumClusters } = findDupes(cube.albums);
  assertEquals(albumClusters.length, 1);
  assertEquals(albumClusters[0].albums.length, 2);
  // FLAC copy wins the keep hint
  assert(albumClusters[0].keep.includes("[FLAC]"));
  assertEquals(
    albumClusters[0].reclaimableBytes,
    4000000,
    "mp3 copy is reclaimable",
  );
});

Deno.test("findDupes: different duration splits track clusters", () => {
  const cube = buildCube(
    [
      row({ id: 22 }),
      row({
        id: 23,
        right_path: "Artist A - Live (2005)",
        album_title: "Live",
        length: 300, // live version, not a dupe of the 100 s studio track
      }),
      row({
        id: 24,
        right_path: "VA - Compilation (2010)",
        album_title: "Compilation",
      }),
    ],
    new Map(),
  );
  const { trackClusters } = findDupes(cube.albums);
  assertEquals(trackClusters.length, 1);
  assertEquals(trackClusters[0].count, 2);
  assert(trackClusters[0].acrossAlbums);
});

// --- verify ---

Deno.test("parseFfmpegVerifyOutput: clean decode has time, no errors", () => {
  const raw =
    "size=N/A time=00:01:38.02 bitrate=N/A speed= 539x elapsed=0:00:00.18    \n";
  const r = parseFfmpegVerifyOutput(raw);
  assertEquals(r.decodedSec, 98.02);
  assertEquals(r.errorLines, []);
});

Deno.test("parseFfmpegVerifyOutput: error lines are collected", () => {
  const raw = [
    "[mp3float @ 0x7f] Header missing",
    "Error while decoding stream #0:0: Invalid data found when processing input",
    "size=N/A time=00:00:30.00 bitrate=N/A speed=100x",
  ].join("\n");
  const r = parseFfmpegVerifyOutput(raw);
  assertEquals(r.decodedSec, 30);
  assertEquals(r.errorLines.length, 2);
});

Deno.test("classifyVerify: verdicts", () => {
  // clean full decode
  assertEquals(classifyVerify(0, [], 200, 199, "full"), "ok");
  // non-zero exit → failed
  assertEquals(classifyVerify(1, [], 200, 10, "full"), "failed");
  // decode errors reported
  assertEquals(
    classifyVerify(0, ["Header missing"], 200, 200, "full"),
    "errors",
  );
  // full decode ends 60 s short → truncated
  assertEquals(classifyVerify(0, [], 200, 140, "full"), "truncated");
  // quick mode: healthy tail decode
  assertEquals(classifyVerify(0, [], 200, 15, "quick", 15), "ok");
  // quick mode: nothing decoded after seeking near the end → truncated
  assertEquals(classifyVerify(0, [], 200, null, "quick", 15), "truncated");
  assertEquals(classifyVerify(0, [], 200, 3, "quick", 15), "truncated");
  // quick mode: file shorter than the tail window → no verdict possible
  assertEquals(classifyVerify(0, [], 10, null, "quick", 15), "ok");
});

// --- bpm ---

const REL = (p: string) =>
  p.startsWith("/music/") ? p.slice("/music/".length) : p;

// verbatim analyzer output from a live run over Apocalyptica's Metallica covers
const SANDMAN =
  '{"path":"/music/Apocalyptica/1996_-_Plays Metallica By Four Cellos/01-Enter Sandman.mp3","lengthSec":220.87,"windowed":false,"analyzedSec":220.87,"bpm":135.14,"beatsConfidence":2.6899,"beatsCount":496,"ibiCv":0.0177,"estStd":2.112,"key":"E","scale":"major","keyStrength":0.8791,"danceability":1.1554,"ms":4600,"rc":0}';
const UNFORGIVEN =
  '{"path":"/music/Apocalyptica/1996_-_Plays Metallica By Four Cellos/04-The Unforgiven.mp3","lengthSec":322.38,"windowed":false,"analyzedSec":322.38,"bpm":150.29,"beatsConfidence":0.6995,"beatsCount":804,"ibiCv":0.0209,"estStd":2.653,"key":"A","scale":"minor","keyStrength":0.8384,"danceability":0.9221,"ms":6520,"rc":0}';

Deno.test("bpmConfidenceBand: essentia's 0–5.32 scale", () => {
  assertEquals(bpmConfidenceBand(0), "none");
  assertEquals(bpmConfidenceBand(0.6995), "very-low");
  assertEquals(bpmConfidenceBand(1.2), "low");
  assertEquals(bpmConfidenceBand(1.5), "good");
  assertEquals(bpmConfidenceBand(2.6899), "good");
  assertEquals(bpmConfidenceBand(3.5), "excellent");
  assertEquals(bpmConfidenceBand(5.32), "excellent");
  assertEquals(bpmConfidenceBand(null), "unknown");
  assertEquals(bpmConfidenceBand(NaN), "unknown");
});

Deno.test("parseBpmLine: a real record maps to a library-relative track", () => {
  const { track, failure } = parseBpmLine(SANDMAN, REL);
  assertEquals(failure, undefined);
  assert(track);
  assertEquals(
    track.path,
    "Apocalyptica/1996_-_Plays Metallica By Four Cellos/01-Enter Sandman.mp3",
  );
  assertEquals(track.bpm, 135.14);
  assertEquals(track.beatsConfidence, 2.6899);
  assertEquals(track.confidenceBand, "good");
  assertEquals(track.key, "E");
  assertEquals(track.scale, "major");
  assertEquals(track.danceability, 1.1554);
  assertEquals(track.windowed, false);
});

Deno.test("parseBpmLine: a metronomic ibiCv does not imply a real beat", () => {
  // The Unforgiven is rubato: essentia still lays down an even grid (ibiCv
  // 0.0209, as steady-looking as Enter Sandman's 0.0177) but reports it barely
  // detected a pulse. The band, not the interval spread, is the honest signal.
  const { track } = parseBpmLine(UNFORGIVEN, REL);
  assert(track);
  assert(track.ibiCv !== null && track.ibiCv < 0.03);
  assertEquals(track.confidenceBand, "very-low");
});

Deno.test("parseBpmLine: failure records carry the error, not a track", () => {
  const line =
    '{"path":"/music/x/broken.mp3","rc":1,"err":"too short to analyze: 4.00s"}';
  const { track, failure } = parseBpmLine(line, REL);
  assertEquals(track, undefined);
  assert(failure);
  assertEquals(failure.path, "x/broken.mp3");
  assert(failure.err.includes("too short"));
});

Deno.test("parseBpmLine: native essentia chatter on stdout is ignored", () => {
  // essentia's C++ side writes warnings that are not JSON; they must not kill
  // the batch or masquerade as results
  assertEquals(parseBpmLine("", REL), {});
  assertEquals(parseBpmLine("[WARNING] MonoLoader: sample rate", REL), {});
  assertEquals(parseBpmLine("{not json", REL), {});
  assertEquals(parseBpmLine('{"rc":0,"bpm":120}', REL), {}); // no path
});

Deno.test("bpmHistogram: buckets by 10 bpm", () => {
  const t = (bpm: number | null) =>
    parseBpmLine(
      JSON.stringify({ path: "/music/a.mp3", rc: 0, bpm }),
      REL,
    ).track!;
  const hist = bpmHistogram([t(135.14), t(139.9), t(140), t(99.95), t(null)]);
  assertEquals(hist["130-140"], 2);
  assertEquals(hist["140-150"], 1);
  assertEquals(hist["90-100"], 1);
  assertEquals(Object.keys(hist).length, 3);
});

// ---------------------------------------------------------------------------
// Contract fixtures for resolve-artists / wanted (RED phase — no method
// reads these yet; these tests pin the WIRE SHAPE the future
// context.readModelData(...) mock rows are built from in
// music_library_methods_test.ts / music_library_adversarial_test.ts).
// Static JSON imports only — there is no --allow-read on the test task, so
// a runtime Deno.readTextFile would fail; `with { type: "json" }` is
// resolved by the module loader, not the permission system.
// ---------------------------------------------------------------------------

Deno.test("contract: fixtures/headphones_artists.json shapes { artists: [{ArtistID, ArtistName, Status}], total, timestamp }", () => {
  const f = headphonesArtistsFixture as {
    artists: Array<{ ArtistID: string; ArtistName: string; Status: string }>;
    total: number;
    timestamp: string;
  };
  assertEquals(Object.keys(f).sort(), ["artists", "timestamp", "total"]);
  assert(Array.isArray(f.artists));
  assertEquals(f.total, f.artists.length);
  assertEquals(typeof f.timestamp, "string");
  for (const a of f.artists) {
    assertEquals(Object.keys(a).sort(), ["ArtistID", "ArtistName", "Status"]);
    assertEquals(typeof a.ArtistID, "string");
    assertEquals(typeof a.ArtistName, "string");
    assertEquals(typeof a.Status, "string");
  }
});

const BROWSE_KEYS = [
  "count",
  "entity",
  "linkedEntity",
  "linkedId",
  "offset",
  "results",
  "timestamp",
].sort();

Deno.test("contract: fixtures/mb_release_groups.json has EXACTLY the 7 browse-cache keys, results carry HYPHENATED MusicBrainz field names", () => {
  const f = mbReleaseGroupsFixture as {
    entity: string;
    linkedEntity: string;
    linkedId: string;
    results: Array<Record<string, unknown>>;
    count: number;
    offset: number;
    timestamp: string;
  };
  assertEquals(Object.keys(f).sort(), BROWSE_KEYS);
  assert(f.results.length > 0, "sanity: this fixture must carry real rows");
  assertEquals(f.count, f.results.length);
  for (const rg of f.results) {
    assert(Object.hasOwn(rg, "primary-type"), "must use hyphenated key");
    assert(Object.hasOwn(rg, "first-release-date"), "must use hyphenated key");
    assert(Object.hasOwn(rg, "secondary-types"), "must use hyphenated key");
    assert(!Object.hasOwn(rg, "primaryType"), "must NOT be camelCased");
    assert(!Object.hasOwn(rg, "firstReleaseDate"), "must NOT be camelCased");
    assert(!Object.hasOwn(rg, "secondaryTypes"), "must NOT be camelCased");
  }
});

Deno.test("contract: fixtures/mb_release_groups_empty.json has the SAME 7 keys as a populated browse cache, with results: [] and count: 0", () => {
  const f = mbReleaseGroupsEmptyFixture as {
    entity: string;
    linkedEntity: string;
    linkedId: string;
    results: unknown[];
    count: number;
    offset: number;
    timestamp: string;
  };
  assertEquals(Object.keys(f).sort(), BROWSE_KEYS);
  assertEquals(f.results, []);
  assertEquals(f.count, 0);
  assertEquals(typeof f.linkedId, "string");
});
