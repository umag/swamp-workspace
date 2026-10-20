// Batch releases: whole-season drops reach Nyaa only as batches.
//
// Regression: on 2026-10-20 Netflix released all of "Cyberpunk: Edgerunners 2"
// at once. Every 1080p release was a batch ("- 01 ~ 10", "S02 … Batch"), so
// eps 3–10 never matched a single-episode pick and alerted hourly.

import { assertEquals } from "jsr:@std/assert@1";
import {
  formatEpisodes,
  fuzzyDateSec,
  type NyaaHit,
  parseBatchRange,
  parseEpisode,
  pickBatch,
  unwantedBatchFiles,
} from "./anime_cron.ts";

const DAY = 86400;
const PREMIERE = Date.UTC(2026, 9, 15) / 1000;

function hit(title: string, pubDateSec: number | null, seeders = 50): NyaaHit {
  return {
    title,
    viewUrl: "https://nyaa.si/view/1",
    magnet: "magnet:?xt=urn:btih:abc",
    infoHash: title,
    seeders,
    episode: parseEpisode(title),
    batch: parseBatchRange(title),
    resolution: /2160p/.test(title) ? 2160 : /1080p/.test(title) ? 1080 : 720,
    sizeBytes: 0,
    pubDateSec,
  };
}

Deno.test("parseBatchRange: explicit ranges", () => {
  assertEquals(
    parseBatchRange(
      "[Erai-raws] Cyberpunk: Edgerunners 2 - 01 ~ 10 [1080p NF WEB-DL HEVC EAC3][MultiSub] [BATCH]",
    ),
    { from: 1, to: 10 },
  );
  assertEquals(
    parseBatchRange(
      "[Erai-raws] Cyberpunk - Edgerunners 2 - 01 ~ 10 [1080p NF WEB-DL HEVC EAC3][MultiSub]",
    ),
    { from: 1, to: 10 },
  );
  assertEquals(
    parseBatchRange("[DBD-Raws][Cyberpunk: Edgerunners][01-10TV全集][1080P]"),
    { from: 1, to: 10 },
  );
});

Deno.test("parseBatchRange: season packs without a range", () => {
  assertEquals(
    parseBatchRange(
      "Cyberpunk Edgerunners S02 1080p NF WEB-DL DUAL DDP5.1 H.264-VARYG (Cyberpunk: Edgerunners 2, Dual-Audio, Multi-Subs, Batch)",
    ),
    { from: 1, to: null },
  );
  assertEquals(
    parseBatchRange("[Judas] Cyberpunk Edgerunners (Season 1) [1080p]"),
    { from: 1, to: null },
  );
});

Deno.test("parseBatchRange: single episodes and codec dashes are not batches", () => {
  for (
    const t of [
      "[SubsPlease] Fixture Show - 04 (1080p) [ABCD1234].mkv",
      "[ToonsHub] Cyberpunk Edgerunners S02E01 1080p TWITCH WEB-DL ENG AAC2.0 H.264",
      "Cyberpunk Edgerunners 2 - 03 (1080p x265 10-bit)",
      "Show S2 - 03 [1080p]",
      "[Group] Show - 12 [1080p HEVC x264-10bit]",
    ]
  ) {
    assertEquals(parseBatchRange(t), null, t);
  }
});

Deno.test("parseEpisode: a batch has no single episode — '- 01 ~ 10' is not ep 1", () => {
  assertEquals(
    parseEpisode(
      "[Erai-raws] Cyberpunk: Edgerunners 2 - 01 ~ 10 [1080p NF WEB-DL HEVC EAC3][MultiSub] [BATCH]",
    ),
    null,
  );
  assertEquals(parseEpisode("[SubsPlease] Fixture - 04 (1080p).mkv"), 4);
});

Deno.test("pickBatch: prefers the ranked group among season-2 batches, rejects the 2022 season-1 pack", () => {
  const hits = [
    hit(
      "[Judas] Cyberpunk Edgerunners (Season 1) [1080p] (Batch)",
      Date.UTC(2022, 8, 14) / 1000,
      113,
    ),
    hit(
      "Cyberpunk Edgerunners S02 1080p NF WEB-DL DUAL DDP5.1 H.264-VARYG (Batch)",
      PREMIERE + 5 * DAY,
      4632,
    ),
    hit(
      "[Erai-raws] Cyberpunk: Edgerunners 2 - 01 ~ 10 [1080p NF WEB-DL HEVC] [BATCH]",
      PREMIERE + 5 * DAY,
      616,
    ),
  ];
  const ctx = { startDateSec: PREMIERE, finished: true };
  assertEquals(
    pickBatch(hits, [3, 4, 5, 6, 7, 8, 9, 10], 1080, ctx)?.title,
    hits[2].title,
  );
  assertEquals(pickBatch([hits[0]], [3, 10], 1080, ctx), null);
});

Deno.test("pickBatch: fails closed — no premiere date, a short range, 720p, or an open pack mid-season", () => {
  const ranged = hit(
    "[Erai-raws] Show - 01 ~ 06 [1080p] [BATCH]",
    PREMIERE + DAY,
  );
  const pack = hit("Show S01 1080p WEB-DL (Batch)", PREMIERE + DAY);
  const low = hit("[Erai-raws] Show - 01 ~ 12 [720p] [BATCH]", PREMIERE + DAY);
  assertEquals(pickBatch([ranged], [3, 4], 1080, {}), null, "no premiere");
  assertEquals(
    pickBatch([ranged], [3, 8], 1080, { startDateSec: PREMIERE }),
    null,
    "range ends before ep 8",
  );
  assertEquals(
    pickBatch([ranged], [3, 6], 1080, { startDateSec: PREMIERE })?.title,
    ranged.title,
  );
  assertEquals(pickBatch([low], [3], 1080, { startDateSec: PREMIERE }), null);
  assertEquals(
    pickBatch([pack], [3], 1080, { startDateSec: PREMIERE, finished: false }),
    null,
    "a pack uploaded mid-season holds only what had aired",
  );
  assertEquals(
    pickBatch([pack], [3], 1080, { startDateSec: PREMIERE, finished: true })
      ?.title,
    pack.title,
  );
});

Deno.test("unwantedBatchFiles: deselects episode files outside the wanted set, keeps extras", () => {
  const files = [
    { name: "Pack/[Erai-raws] Show - 01 [1080p].mkv" },
    { name: "Pack/[Erai-raws] Show - 02 [1080p].mkv" },
    { name: "Pack/[Erai-raws] Show - 03 [1080p].mkv" },
    { name: "Pack/NCOP.mkv" },
  ];
  assertEquals(unwantedBatchFiles(files, [3]), [0, 1]);
});

Deno.test("formatEpisodes and fuzzyDateSec", () => {
  assertEquals(formatEpisodes([5, 3, 4]), "3–5");
  assertEquals(formatEpisodes([3, 4]), "3, 4");
  assertEquals(formatEpisodes([3, 7]), "3, 7");
  assertEquals(formatEpisodes([10]), "10");
  assertEquals(fuzzyDateSec({ year: 2026, month: 10, day: 15 }), PREMIERE);
  assertEquals(
    fuzzyDateSec({ year: 2026, month: 10, day: null }),
    Date.UTC(2026, 9, 1) / 1000,
  );
  assertEquals(fuzzyDateSec({ year: 2026, month: null, day: null }), null);
  assertEquals(fuzzyDateSec(null), null);
});
