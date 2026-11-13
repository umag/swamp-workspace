// Batch fallback must not take an earlier season's batch, nor fire for an
// episode that only just aired.
//
// Regression: on 2026-11-13 the 14:10 run came before "Kusuriya no Hitorigoto
// 3rd Season" ep 7 was out. SubsPlease had re-uploaded the season 1 batch
// "(01-24)" on 2026-11-11 — after the season 3 premiere, so the upload-date
// check passed, and its title states no season. pickBatch took it and the
// season 1 ep 7 file was queued as season 3 ep 7.

import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type NyaaHit, parseBatchRange, pickBatch } from "./anime_cron.ts";

const DAY = 86400;
const PREMIERE = Date.UTC(2026, 9, 2, 14, 0, 0) / 1000;
const NOW = Date.UTC(2026, 10, 13, 14, 10, 0) / 1000;

const batch = (title: string, pubDateSec: number): NyaaHit => ({
  title,
  viewUrl: "https://nyaa.si/view/1",
  magnet: "magnet:?xt=urn:btih:abc",
  infoHash: title,
  seeders: 300,
  episode: null,
  resolution: 1080,
  sizeBytes: 20 * 1024 ** 3,
  pubDateSec,
  batch: parseBatchRange(title),
});

const S1_BATCH = batch(
  "[SubsPlease] Kusuriya no Hitorigoto (01-24) (1080p) [Batch]",
  Date.UTC(2026, 10, 11, 22, 8) / 1000,
);

Deno.test("pickBatch: season 3 never takes a season-less (season 1) batch", () => {
  assertStrictEquals(
    pickBatch([S1_BATCH], [7], 1080, {
      season: 3,
      startDateSec: PREMIERE,
      newestAiredSec: NOW - 10 * DAY,
      nowSec: NOW,
    }),
    null,
  );
});

Deno.test("pickBatch: a batch labelled with the right season is accepted", () => {
  const s3 = batch(
    "[Group] Kusuriya no Hitorigoto S3 (01-07) [1080p] [Batch]",
    NOW - 2 * DAY,
  );
  assertEquals(
    pickBatch([s3], [7], 1080, {
      season: 3,
      startDateSec: PREMIERE,
      newestAiredSec: NOW - 4 * DAY,
      nowSec: NOW,
    }),
    s3,
  );
});

Deno.test("pickBatch: no batch for an episode that aired under 3 days ago", () => {
  const s3 = batch(
    "[Group] Kusuriya no Hitorigoto S3 (01-07) [1080p] [Batch]",
    NOW - 3600,
  );
  assertStrictEquals(
    pickBatch([s3], [7], 1080, {
      season: 3,
      startDateSec: PREMIERE,
      newestAiredSec: NOW - 2 * 3600,
      nowSec: NOW,
    }),
    null,
  );
});

Deno.test("pickBatch: first seasons still accept plain-titled batches", () => {
  const plain = batch(
    "[SubsPlease] Some Show (01-12) (1080p) [Batch]",
    NOW - DAY,
  );
  assertEquals(
    pickBatch([plain], [3, 4], 1080, {
      season: null,
      startDateSec: NOW - 90 * DAY,
      newestAiredSec: NOW - 30 * DAY,
      nowSec: NOW,
      finished: true,
    }),
    plain,
  );
});
