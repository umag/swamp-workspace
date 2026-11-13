// Dub-only releases are never picked.
//
// Regression: on 2026-10-25 "Mezametara …" ep 4 was queued as
// "[Yameii] Reborn as a Space Mercenary: … - S01E04 [English Dub] [CR WEB-DL
// 1080p]" — an English-audio-only release. It and AnoZu's Dual-Audio release
// were both unranked groups, so seeders decided and the dub won.

import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isDubOnly, type NyaaHit, pickBest } from "./anime_cron.ts";

const hit = (title: string, seeders: number): NyaaHit => ({
  title,
  viewUrl: "https://nyaa.si/view/1",
  magnet: "magnet:?xt=urn:btih:abc",
  infoHash: title,
  seeders,
  episode: 4,
  resolution: 1080,
  sizeBytes: 1024 ** 3,
});

const YAMEII =
  "[Yameii] Reborn as a Space Mercenary: I Woke Up Piloting the Strongest Starship! - S01E04 [English Dub] [CR WEB-DL 1080p H264 AAC] [2A5AEA5E] (Mezametara Saikyou Soubi to Uchuusen Mochi Datta no de)";
const ANOZU =
  "[AnoZu] Reborn as a Space Mercenary: I Woke Up Piloting the Strongest Starship! S01E04 1080p CR WEB-DL Dual-Audio DDP 2.0 H.264 | Mezametara Saikyou Soubi";

Deno.test("isDubOnly: English-dub-only titles", () => {
  assertEquals(isDubOnly(YAMEII), true);
  assertEquals(isDubOnly("[G] Show - 01 [Dub] [1080p]"), true);
  assertEquals(isDubOnly("[G] Show - 01 (English Dubbed) [1080p]"), true);
});

Deno.test("isDubOnly: dual/multi audio and subbed releases are kept", () => {
  assertEquals(isDubOnly(ANOZU), false);
  assertEquals(
    isDubOnly(
      "Overgeared S01E04 1080p CR WEB-DL DUAL AAC2.0 H.264-VARYG (Dual-Audio, Multi-Subs)",
    ),
    false,
  );
  assertEquals(
    isDubOnly("[ToonsHub] Show S01E04 1080p CR WEB-DL MULTi AAC2.0 H.264"),
    false,
  );
  assertEquals(
    isDubOnly("[G] Show - 01 [English Dub + Japanese] [Dual Audio] [1080p]"),
    false,
  );
  assertEquals(isDubOnly("[SubsPlease] Dubai Detective - 01 (1080p)"), false);
});

Deno.test("pickBest: the 2026-10-25 case picks AnoZu, not the dub", () => {
  assertEquals(pickBest([hit(YAMEII, 99), hit(ANOZU, 70)], 4)?.title, ANOZU);
});

Deno.test("pickBest: only a dub available → nothing", () => {
  assertStrictEquals(pickBest([hit(YAMEII, 99)], 4), null);
});
