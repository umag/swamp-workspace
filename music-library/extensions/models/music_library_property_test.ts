/**
 * Property-based tests (fast-check) for @magistr/music-library's pure
 * helpers, exported directly from music_library.ts — no Deno.Command stub
 * needed anywhere in this file.
 *
 * music_library.ts is UNMODIFIED — every property here characterizes
 * already-shipped behavior. Named invariants:
 *
 *  (a) slugify idempotence + output shape — slugify(slugify(s)) ==
 *      slugify(s) for ANY input (including Cyrillic/CJK/punctuation-heavy
 *      strings), and the output is always a non-empty, <=40-char string of
 *      [a-z0-9-] with no leading/trailing hyphen.
 *  (b) hash8 determinism + shape — same input always yields the same
 *      8-lowercase-hex-char output.
 *  (c) fixEncoding is a no-op on any pure-ASCII input (isLatin1Shaped
 *      requires at least one byte >= 0x80 to ever attempt a fix).
 *  (d) classifyVerify: a non-zero rc ALWAYS yields "failed", regardless of
 *      any other (arbitrary) parameter.
 *  (e) parseBpmLine: path/bpm round-trip verbatim through a well-formed
 *      JSON record, for arbitrary safe (control-char-free) path strings and
 *      arbitrary finite bpm values.
 *  (f) property-flow: buildCube's pathPrefix filters albums by directory
 *      prefix for an arbitrary set of generated album directories (ASCII
 *      only — deliberately NOT asserting on `cube.albums`' relative ORDER,
 *      since albums sort via `dir.localeCompare()`, which this repo's
 *      convention treats as locale-sensitive and therefore never a safe
 *      property target).
 *  (g) property-flow: buildCube -> findDupes referential integrity — every
 *      album cluster's `keep`/`albums[].dir` value corresponds to a REAL
 *      album buildCube actually produced, for an arbitrary set of distinct
 *      top-level album directories sharing one artist+title.
 */
import fc from "npm:fast-check@4.8.0";
import { assert } from "jsr:@std/assert@1";
import {
  buildCube,
  classifyVerify,
  findDupes,
  fixEncoding,
  hash8,
  parseBpmLine,
  slugify,
} from "./music_library.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// (a) slugify idempotence + shape
// ---------------------------------------------------------------------------

Deno.test("property: slugify(slugify(s)) === slugify(s) for ANY input, and the output is always a non-empty <=40-char [a-z0-9-] string with no leading/trailing hyphen", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      const g = slugify(s);
      const shapeOk = /^[a-z0-9-]{1,40}$/.test(g) &&
        !g.startsWith("-") && !g.endsWith("-");
      const idempotent = slugify(g) === g;
      return shapeOk && idempotent;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) hash8 determinism + shape
// ---------------------------------------------------------------------------

Deno.test("property: hash8 always returns 8 lowercase hex chars, deterministically, for any input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      const h1 = hash8(s);
      const h2 = hash8(s);
      return h1 === h2 && /^[0-9a-f]{8}$/.test(h1);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) fixEncoding is a no-op on pure ASCII
// ---------------------------------------------------------------------------

const arbAscii = fc.string({ maxLength: 100 }).filter((s) =>
  [...s].every((c) => c.codePointAt(0)! <= 0x7f)
);

Deno.test("property: fixEncoding never touches a pure-ASCII string (isLatin1Shaped requires a byte >= 0x80)", () => {
  fc.assert(
    fc.property(arbAscii, (s) => {
      const r = fixEncoding(s);
      return r.fixed === false && r.value === s && r.encoding === null;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) classifyVerify: rc !== 0 always yields "failed"
// ---------------------------------------------------------------------------

const arbErrorLines = fc.array(fc.string({ maxLength: 30 }), {
  minLength: 0,
  maxLength: 5,
});
const arbSecOrNull = fc.option(fc.double({ min: 0, max: 10000, noNaN: true }), {
  nil: null,
});
const arbMode = fc.constantFrom("full", "quick");

Deno.test("property: any non-zero rc ALWAYS classifies as 'failed', regardless of errorLines/expectedSec/decodedSec/mode", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 255 }),
      arbErrorLines,
      arbSecOrNull,
      arbSecOrNull,
      arbMode,
      (rc, errorLines, expectedSec, decodedSec, mode) => {
        return (
          classifyVerify(rc, errorLines, expectedSec, decodedSec, mode) ===
            "failed"
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) parseBpmLine: path/bpm round-trip
// ---------------------------------------------------------------------------

const arbSafePath = fc.stringMatching(/^[A-Za-z0-9 ._/-]{1,40}$/);
const arbBpm = fc.double({ min: 40, max: 220, noNaN: true });

Deno.test("property: parseBpmLine's path and bpm round-trip verbatim through a well-formed JSON record", () => {
  fc.assert(
    fc.property(arbSafePath, arbBpm, (path, bpm) => {
      const line = JSON.stringify({ path, rc: 0, bpm });
      const { track, failure } = parseBpmLine(line, (p) => p);
      return failure === undefined && track !== undefined &&
        track.path === path && track.bpm === bpm;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) property-flow: buildCube's pathPrefix directory filter
// ---------------------------------------------------------------------------

const arbDirName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,10}$/);

function rowFor(dir: string, id: number) {
  return {
    id,
    filename: "01 - Track.mp3",
    tag_title: "Track",
    tag_track_artist: "Artist",
    track_number: 1,
    disc_number: null,
    tag_year: 2000,
    length: 100,
    bitrate: 128,
    size: 1000,
    left_path: "",
    right_path: dir,
    album_title: "Album",
    album_artist: "Artist",
    album_year: 2000,
    compilation: 0,
  };
}

Deno.test("property-flow: buildCube's pathPrefix keeps exactly the albums whose directory starts with the prefix (order not asserted — dir sort is localeCompare)", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbDirName, { minLength: 1, maxLength: 6 }),
      fc.boolean(),
      (dirs, usePrefix) => {
        const rows = dirs.map((dir, i) => rowFor(dir, i + 1));
        const prefix = usePrefix ? dirs[0] : "";
        const cube = buildCube(rows, new Map(), { pathPrefix: prefix });
        if (prefix) {
          const expected = dirs.filter((d) => d.startsWith(prefix)).length;
          return cube.albums.every((a) => a.dir.startsWith(prefix)) &&
            cube.albums.length === expected;
        }
        return cube.albums.length === dirs.length;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (g) property-flow: buildCube -> findDupes referential integrity
// ---------------------------------------------------------------------------

function sharedRowFor(dir: string, id: number) {
  return {
    id,
    filename: "01 - Track.mp3",
    tag_title: "Track",
    tag_track_artist: "Shared Artist",
    track_number: 1,
    disc_number: null,
    tag_year: 2000,
    length: 100,
    bitrate: 128,
    size: 1000,
    left_path: "",
    right_path: dir,
    album_title: "Shared Album",
    album_artist: "Shared Artist",
    album_year: 2000,
    compilation: 0,
  };
}

Deno.test("property-flow: every findDupes album cluster's keep/dir values reference a REAL album buildCube produced", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbDirName, { minLength: 2, maxLength: 8 }),
      (dirs) => {
        const rows = dirs.map((dir, i) => sharedRowFor(dir, i + 1));
        const cube = buildCube(rows, new Map());
        const { albumClusters } = findDupes(cube.albums);
        const realDirs = new Set(cube.albums.map((a) => a.dir));
        return albumClusters.every((c) =>
          realDirs.has(c.keep) && c.albums.every((a) => realDirs.has(a.dir))
        );
      },
    ),
    FC_RUNS,
  );
});

// Anti-vacuity: confirm the referential-integrity property above actually
// exercises a NON-EMPTY albumClusters at least once for a representative
// input (fast-check properties that always short-circuit true on an empty
// collection would silently prove nothing).
Deno.test("property-flow sanity: the shared-artist/title fixture actually produces at least one album cluster", () => {
  const dirs = ["AlphaDir", "BetaDir", "GammaDir"];
  const rows = dirs.map((dir, i) => sharedRowFor(dir, i + 1));
  const cube = buildCube(rows, new Map());
  const { albumClusters } = findDupes(cube.albums);
  assert(albumClusters.length > 0, "sanity: a real cluster must form");
});
