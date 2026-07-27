// Unit tests for the pure cadence-matching logic in running.ts.
// Run: deno test extensions/lib/running_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRunning, cadenceFor, type RunTrack } from "./running.ts";

function track(over: Partial<RunTrack>): RunTrack {
  return {
    path: "Rotting Christ - Theogonia (2007)/04 - Enuma Elish.flac",
    bpm: 152,
    beatsConfidence: 2.82,
    danceability: 1.1,
    key: "B",
    scale: "minor",
    lengthSec: 300,
    ...over,
  };
}

Deno.test("cadenceFor: native tempo matches at 1x", () => {
  assertEquals(cadenceFor(152), { spm: 152, mult: 1 });
  assertEquals(cadenceFor(166.44), { spm: 166.4, mult: 1 });
});

Deno.test("cadenceFor: half-time material doubles into cadence", () => {
  // Rotting Christ "Shadows Follow" — 90.9 bpm is a 181.8 spm run
  assertEquals(cadenceFor(90.9), { spm: 181.8, mult: 2 });
  assertEquals(cadenceFor(75), { spm: 150, mult: 2 });
});

Deno.test("cadenceFor: blast beats halve into cadence", () => {
  assertEquals(cadenceFor(340), { spm: 170, mult: 0.5 });
});

Deno.test("cadenceFor: 1x wins when several multiples fit", () => {
  // 180 is in range natively; 90 (½×) would be too, but footfall-on-beat wins
  assertEquals(cadenceFor(180), { spm: 180, mult: 1 });
});

Deno.test("cadenceFor: nothing in range, and junk input", () => {
  assertEquals(cadenceFor(120), null); // 120/240/60 all outside 150-190
  assertEquals(cadenceFor(null), null);
  assertEquals(cadenceFor(0), null);
  assertEquals(cadenceFor(NaN), null);
});

Deno.test("cadenceFor: a widened ceiling admits …Pir Threontai", () => {
  // 97.93 bpm doubles to 195.9 spm — six over the default 190 ceiling, so the
  // default rejects it and a raised one takes it. This is why the window is a
  // method argument and not a constant.
  assertEquals(cadenceFor(97.93), null);
  assertEquals(cadenceFor(97.93, 150, 200), { spm: 195.9, mult: 2 });
});

Deno.test("buildRunning: a bpm without a pulse never reaches the playlist", () => {
  // the 4h dungeon-synth wav: bpm 110.78 at confidence 0.0428. 110.78 is out
  // of range anyway, so use a tempo that WOULD match to prove the confidence
  // gate is what rejects it.
  const r = buildRunning([
    track({ bpm: 180, beatsConfidence: 0.0428, path: "Ambient/drone.wav" }),
    track({ bpm: 180, beatsConfidence: 2.5, path: "Metal/real.flac" }),
  ]);
  assertEquals(r.playlist.length, 1);
  assertEquals(r.playlist[0].path, "Metal/real.flac");
  assertEquals(r.excluded.noPulse, 1);
  assertEquals(r.excluded.outOfRange, 0);
});

Deno.test("buildRunning: a real beat at an unrunnable tempo is not 'no pulse'", () => {
  const r = buildRunning([track({ bpm: 120, beatsConfidence: 3.0 })]);
  assertEquals(r.playlist.length, 0);
  assertEquals(r.excluded.noPulse, 0);
  assertEquals(r.excluded.outOfRange, 1);
});

Deno.test("buildRunning: playlist ranks by confidence and sums duration", () => {
  const r = buildRunning([
    track({ bpm: 152, beatsConfidence: 1.6, lengthSec: 120, path: "a/1.flac" }),
    track({
      bpm: 90.9,
      beatsConfidence: 3.37,
      lengthSec: 240,
      path: "b/2.flac",
    }),
    track({
      bpm: 166,
      beatsConfidence: 2.07,
      lengthSec: 180,
      path: "c/3.flac",
    }),
  ]);
  assertEquals(r.playlist.map((p) => p.path), [
    "b/2.flac",
    "c/3.flac",
    "a/1.flac",
  ]);
  assertEquals(r.playlist[0].spm, 181.8);
  assertEquals(r.playlist[0].mult, 2);
  assertEquals(r.totalSec, 540);
});

Deno.test("buildRunning: cadence buckets follow the tuned window", () => {
  const tracks = [
    track({ bpm: 152, lengthSec: 300, path: "a/1.flac" }),
    track({ bpm: 155, lengthSec: 300, path: "a/2.flac" }),
    track({ bpm: 90.9, lengthSec: 600, path: "b/1.flac" }), // 181.8 spm
  ];
  const r = buildRunning(tracks);
  const b150 = r.buckets.find((b) => b.range === "150-160");
  assert(b150);
  assertEquals(b150.tracks, 2);
  assertEquals(b150.minutes, 10);
  assertEquals(r.buckets.find((b) => b.range === "180-190")?.tracks, 1);
  // empty buckets are dropped
  assertEquals(r.buckets.find((b) => b.range === "160-170"), undefined);

  // narrowing the window drops the 181.8 track and its bucket entirely
  const narrow = buildRunning(tracks, { minSpm: 150, maxSpm: 160 });
  assertEquals(narrow.playlist.length, 2);
  assertEquals(narrow.buckets.map((b) => b.range), ["150-160"]);
});

Deno.test("buildRunning: albums rank by mean confidence, low-pulse ones included", () => {
  const r = buildRunning([
    track({ path: "Triarchy/1.flac", bpm: 90.9, beatsConfidence: 3.37 }),
    track({ path: "Triarchy/2.flac", bpm: 94.8, beatsConfidence: 2.79 }),
    track({ path: "Triarchy/3.flac", bpm: 120, beatsConfidence: 2.0 }),
    track({ path: "Ballads/1.flac", bpm: 150, beatsConfidence: 0.7 }),
    track({ path: "Ballads/2.flac", bpm: 150, beatsConfidence: 0.6 }),
    track({ path: "Ballads/3.flac", bpm: 150, beatsConfidence: 0.5 }),
    track({ path: "Tiny/1.flac", bpm: 152, beatsConfidence: 5.0 }),
  ]);
  // Tiny has < 3 tracks so it is not ranked despite the best confidence
  assertEquals(r.albums.map((a) => a.dir), ["Triarchy", "Ballads"]);
  assertEquals(r.albums[0].meanConfidence, 2.72);
  assertEquals(r.albums[0].tracks, 3);
  // only 2 of Triarchy's 3 are runnable (120 bpm is out of range)
  assertEquals(r.albums[0].runnable, 2);
  assertEquals(r.albums[1].runnable, 0);
});

Deno.test("buildRunning: cadence window and confidence floor are tunable", () => {
  const t = [track({ bpm: 152, beatsConfidence: 1.0 })];
  assertEquals(buildRunning(t).playlist.length, 0);
  assertEquals(buildRunning(t, { minConfidence: 0.9 }).playlist.length, 1);
  assertEquals(
    buildRunning(t, { minSpm: 100, maxSpm: 140, minConfidence: 0.9 })
      .playlist.length,
    0,
  );
});

Deno.test("buildRunning: targetMin keeps the strongest beats, not the first", () => {
  const r = buildRunning([
    track({
      bpm: 152,
      beatsConfidence: 1.6,
      lengthSec: 300,
      path: "weak.flac",
    }),
    track({
      bpm: 152,
      beatsConfidence: 3.3,
      lengthSec: 300,
      path: "strong.flac",
    }),
    track({ bpm: 152, beatsConfidence: 2.5, lengthSec: 300, path: "mid.flac" }),
  ], { targetMin: 10 });
  assertEquals(r.playlist.map((p) => p.path), ["strong.flac", "mid.flac"]);
  assertEquals(r.totalSec, 600);
  // eligible reports the pre-trim pool so the trim is visible, not silent
  assertEquals(r.eligible, 3);
});

Deno.test("buildRunning: targetMin overshoots rather than undershoots a run", () => {
  // a 5-minute target with 4-minute tracks yields 8 minutes: better to have
  // music left over at the end of a run than to run out mid-stride
  const r = buildRunning([
    track({ beatsConfidence: 3.3, lengthSec: 240, path: "a.flac" }),
    track({ beatsConfidence: 3.2, lengthSec: 240, path: "b.flac" }),
    track({ beatsConfidence: 3.1, lengthSec: 240, path: "c.flac" }),
  ], { targetMin: 5 });
  assertEquals(r.playlist.length, 2);
  assertEquals(r.totalSec, 480);
});

Deno.test("buildRunning: limit caps the playlist", () => {
  const r = buildRunning([
    track({ beatsConfidence: 3.3, path: "a.flac" }),
    track({ beatsConfidence: 3.2, path: "b.flac" }),
    track({ beatsConfidence: 3.1, path: "c.flac" }),
  ], { limit: 2 });
  assertEquals(r.playlist.map((p) => p.path), ["a.flac", "b.flac"]);
  assertEquals(r.eligible, 3);
});

Deno.test("buildRunning: empty analysis degrades to an empty playlist", () => {
  const r = buildRunning([]);
  assertEquals(r.playlist.length, 0);
  assertEquals(r.buckets.length, 0);
  assertEquals(r.albums.length, 0);
  assertEquals(r.totalSec, 0);
  assertEquals(r.eligible, 0);
});
