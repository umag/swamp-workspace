// Unit tests for the pure triage logic in verify_triage.ts.
// Run: deno test extensions/reports/verify_triage_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { triageVerify } from "./verify_triage.ts";

function verifyContent(problems: unknown[]) {
  return {
    kind: "verify",
    mode: "full",
    startedAt: "2026-07-07T22:09:24.878Z",
    elapsedSec: 100,
    params: { path: "", pathPrefix: "" },
    checked: 100,
    ok: 100 - problems.length,
    failed: 0,
    errors: 0,
    truncated: 0,
    // deno-lint-ignore no-explicit-any
    problems: problems as any,
  };
}

function problem(over: Record<string, unknown>) {
  return {
    path: "A/B/01.mp3",
    status: "errors",
    rc: 0,
    expectedSec: 200,
    decodedSec: 200,
    errors: ["[mp3float @ 0x1] Header missing"],
    ...over,
  };
}

Deno.test("triageVerify: junk paths flagged on unreadable files", () => {
  const t = triageVerify(
    verifyContent([
      problem({
        path: "Ambient/Player/Plugins/avs/fyrewurx.ape",
        status: "failed",
      }),
      problem({ path: "Wagner/01 - Ride.mp3", status: "failed" }),
    ]),
    null,
  );
  assertEquals(t.unreadable.length, 2);
  assert(t.unreadable[0].suspectedJunk);
  assertEquals(t.unreadable[1].suspectedJunk, false);
});

Deno.test("triageVerify: truncation split by cause", () => {
  const t = triageVerify(
    verifyContent([
      problem({
        path: "youtube/mp3/Album-xyz.mp4.aac",
        status: "truncated",
        expectedSec: 3000,
        decodedSec: 2970,
      }),
      problem({
        path: "Radio/Nectarine/incomplete/x.ogg",
        status: "truncated",
        expectedSec: 300,
        decodedSec: 130,
      }),
      problem({
        path: "Band/Album/09 Track09.mp3",
        status: "truncated",
        expectedSec: 2160,
        decodedSec: 25,
      }),
      problem({
        path: "Band/Album/11-Brena.mp3",
        status: "truncated",
        expectedSec: 200,
        decodedSec: 178,
      }),
    ]),
    null,
  );
  assertEquals(t.truncated.knownIncomplete.length, 2);
  assertEquals(t.truncated.bigGapSuspect.length, 1);
  assertEquals(t.truncated.realLoss.length, 1);
  assertEquals(t.truncated.realLoss[0].missingSec, 22);
});

Deno.test("triageVerify: systematic dirs split from isolated glitches", () => {
  const systematic = Array.from(
    { length: 9 },
    (_, i) => problem({ path: `Bad Album/${i}.mp3` }),
  );
  const t = triageVerify(
    verifyContent([...systematic, problem({ path: "Fine Album/03.mp3" })]),
    null,
  );
  assertEquals(t.systematicDirs.length, 1);
  assertEquals(t.systematicDirs[0].dir, "Bad Album");
  assertEquals(t.systematicDirs[0].badFiles, 9);
  assertEquals(t.isolatedGlitchCount, 1);
});

Deno.test("triageVerify: lossless corruption gets duplicate hints", () => {
  const t = triageVerify(
    verifyContent([
      problem({
        path: "CBL - Derelicts (FLAC)/04 - Nattvasen.flac",
        errors: ["[flac @ 0x1] decode_frame() failed"],
      }),
    ]),
    {
      kind: "dupes",
      albumClusters: [
        {
          artist: "CBL",
          title: "Derelicts",
          keep: "CBL - Derelicts (FLAC)",
          albums: [
            { dir: "CBL - Derelicts (FLAC)" },
            { dir: "CBL/Albums/(2017) Derelicts" },
          ],
        },
      ],
    },
  );
  assertEquals(t.losslessCorrupt.length, 1);
  assertEquals(t.losslessCorrupt[0].duplicateDirs, [
    "CBL/Albums/(2017) Derelicts",
  ]);
});
