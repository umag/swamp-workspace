// Season-safety tests: a sequel's episode must never be satisfied by an older
// season's release.
//
// Regression: on 2026-10-02 "Kusuriya no Hitorigoto 3rd Season" ep 1 aired, no
// season-3 release existed yet, the base-title fallback searched plain
// "Kusuriya no Hitorigoto", and pickBest accepted a January 2025
// "[Half-Baked] … S02E01" because it only compared the episode number.
// SubsPlease meanwhile numbers that show continuously (S2 = 25–48), so the
// real season-3 ep 1 arrives as "- 49" and never matched at all.

import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  episodeKey,
  type NyaaHit,
  parseRSS,
  parseSeason,
  pickBest,
  renameToSeasonEpisode,
} from "./anime_cron.ts";
import { model } from "./anime_cron.ts";

const DAY = 86400;
// 2026-10-02T14:00:00Z — season 3 ep 1 broadcast.
const AIRED = Date.UTC(2026, 9, 2, 14, 0, 0) / 1000;

function hit(
  title: string,
  episode: number | null,
  pubDateSec: number | null,
  seeders = 50,
): NyaaHit {
  return {
    title,
    viewUrl: "https://nyaa.si/view/1",
    magnet: "magnet:?xt=urn:btih:abc",
    infoHash: title,
    seeders,
    episode,
    resolution: 1080,
    sizeBytes: 1024 ** 3,
    pubDateSec,
  };
}

// ─── parseSeason ──────────────────────────────────────────────────────────────

Deno.test("parseSeason: AniList ordinal and roman forms", () => {
  assertEquals(parseSeason("Kusuriya no Hitorigoto 3rd Season"), 3);
  assertEquals(parseSeason("Nige Jouzu no Wakagimi 2nd Season"), 2);
  assertEquals(
    parseSeason("Mushoku Tensei III: Isekai Ittara Honki Dasu"),
    3,
  );
  assertEquals(
    parseSeason("Clevatess II: Majuu no Ou to Itsuwari no Yuusha Denshou"),
    2,
  );
});

Deno.test("parseSeason: release-title forms", () => {
  assertEquals(
    parseSeason(
      "[Half-Baked] The Apothecary Diaries (Kusuriya no Hitorigoto) - S02E01 [WEB 1080p HEVC E-AC3].mkv",
    ),
    2,
  );
  assertEquals(parseSeason("[SubsPlease] Show S2 - 03 (1080p).mkv"), 2);
  assertEquals(parseSeason("[Group] Show Season 3 - 01 [1080p]"), 3);
  assertEquals(parseSeason("[Erai-raws] Clevatess II - 13 [1080p]"), 2);
});

Deno.test("parseSeason: no season marker → null", () => {
  assertStrictEquals(parseSeason("FX Senshi Kurumi-chan"), null);
  assertStrictEquals(
    parseSeason("[SubsPlease] Kusuriya no Hitorigoto - 49 (1080p) [A].mkv"),
    null,
  );
  // A bare "V" inside a title is not a season.
  assertStrictEquals(parseSeason("[G] V Rising - 01 [1080p]"), null);
});

// ─── parseRSS pubDate ─────────────────────────────────────────────────────────

Deno.test("parseRSS: reads pubDate into pubDateSec", () => {
  const xml = `<rss><channel><item>
    <title>[SubsPlease] Show - 01 (1080p) [A].mkv</title>
    <link>https://nyaa.si/download/2168037.torrent</link>
    <guid isPermaLink="true">https://nyaa.si/view/2168037</guid>
    <pubDate>Thu, 01 Oct 2026 12:32:15 -0000</pubDate>
    <nyaa:seeders>860</nyaa:seeders>
    <nyaa:infoHash>ABCDEF</nyaa:infoHash>
    <nyaa:size>1.4 GiB</nyaa:size>
  </item></channel></rss>`;
  const [h] = parseRSS(xml);
  assertEquals(h.pubDateSec, Date.UTC(2026, 9, 1, 12, 32, 15) / 1000);
});

// ─── pickBest: the regression ─────────────────────────────────────────────────

Deno.test("pickBest: rejects an old season's ep 1 released long before air", () => {
  const oldS2 = hit(
    "[Half-Baked] The Apothecary Diaries (Kusuriya no Hitorigoto) - S02E01 [WEB 1080p HEVC E-AC3].mkv",
    1,
    Date.UTC(2025, 0, 11) / 1000,
  );
  assertStrictEquals(
    pickBest([oldS2], 1, 1080, { season: 3, airedAtSec: AIRED, latest: true }),
    null,
  );
});

Deno.test("pickBest: season mismatch rejected even when recent", () => {
  const wrong = hit("[G] Show S02E01 [1080p]", 1, AIRED + 3600);
  assertStrictEquals(
    pickBest([wrong], 1, 1080, { season: 3, airedAtSec: AIRED }),
    null,
  );
});

Deno.test("pickBest: pre-air release within slack is still accepted", () => {
  const preAir = hit(
    "[Bizmillah] FX Senshi Kurumi-chan - 01 (Pre-Air) [1080p]",
    1,
    AIRED - 1 * DAY,
  );
  assertEquals(
    pickBest([preAir], 1, 1080, { season: null, airedAtSec: AIRED }),
    preAir,
  );
});

Deno.test("pickBest: no airing time → old releases stay eligible (backlog)", () => {
  const old = hit(
    "[SubsPlease] Show - 01 (1080p)",
    1,
    Date.UTC(2020, 0, 1) / 1000,
  );
  assertEquals(pickBest([old], 1), old);
  assertEquals(pickBest([old], 1, 1080, { airedAtSec: null }), old);
});

Deno.test("pickBest: matching season label is accepted", () => {
  const ok = hit("[G] Show S03E01 [1080p]", 1, AIRED + 3600);
  assertEquals(pickBest([ok], 1, 1080, { season: 3, airedAtSec: AIRED }), ok);
});

// ─── pickBest: continuous (absolute) numbering ────────────────────────────────

Deno.test("pickBest: maps SubsPlease continuous number for the latest ep", () => {
  const abs = hit(
    "[SubsPlease] Kusuriya no Hitorigoto - 49 (1080p) [AAAA].mkv",
    49,
    AIRED + 2 * 3600,
    900,
  );
  const oldS1 = hit(
    "[SubsPlease] Kusuriya no Hitorigoto - 01 (1080p) [BBBB].mkv",
    1,
    Date.UTC(2023, 9, 22) / 1000,
  );
  assertEquals(
    pickBest([abs, oldS1], 1, 1080, {
      season: 3,
      airedAtSec: AIRED,
      latest: true,
    }),
    abs,
  );
});

Deno.test("pickBest: absolute fallback off for non-latest eps", () => {
  const abs = hit("[SubsPlease] Show - 49 (1080p)", 49, AIRED + 3600);
  assertStrictEquals(
    pickBest([abs], 1, 1080, { airedAtSec: AIRED, latest: false }),
    null,
  );
});

Deno.test("pickBest: absolute fallback refuses ambiguous numbers", () => {
  const a = hit("[SubsPlease] Show - 49 (1080p)", 49, AIRED + 3600);
  const b = hit("[Other] Show - 50 (1080p)", 50, AIRED + 2 * 3600);
  assertStrictEquals(
    pickBest([a, b], 1, 1080, { airedAtSec: AIRED, latest: true }),
    null,
  );
});

Deno.test("pickBest: absolute fallback ignores releases outside this week", () => {
  const lastWeek = hit("[SubsPlease] Show - 48 (1080p)", 48, AIRED - 7 * DAY);
  assertStrictEquals(
    pickBest([lastWeek], 1, 1080, { airedAtSec: AIRED, latest: true }),
    null,
  );
});

Deno.test("pickBest: direct match wins over absolute candidate", () => {
  const direct = hit("[G] Show S03E01 [1080p]", 1, AIRED + 3600, 10);
  const abs = hit("[SubsPlease] Show - 49 (1080p)", 49, AIRED + 3600, 900);
  assertEquals(
    pickBest([direct, abs], 1, 1080, {
      season: 3,
      airedAtSec: AIRED,
      latest: true,
    }),
    direct,
  );
});

// ─── renameToSeasonEpisode ────────────────────────────────────────────────────

Deno.test("renameToSeasonEpisode: rewrites show + absolute episode", () => {
  assertEquals(
    renameToSeasonEpisode(
      "[SubsPlease] Kusuriya no Hitorigoto - 49 (1080p) [AAAA].mkv",
      49,
      1,
      "Kusuriya no Hitorigoto 3rd Season",
    ),
    "[SubsPlease] Kusuriya no Hitorigoto 3rd Season - 01 (1080p) [AAAA].mkv",
  );
  assertEquals(
    renameToSeasonEpisode(
      "[SubsPlease] Show - 50v2 (1080p).mkv",
      50,
      12,
      "Show 3rd Season",
    ),
    "[SubsPlease] Show 3rd Season - 12v2 (1080p).mkv",
  );
});

Deno.test("renameToSeasonEpisode: unrecognised layout → null", () => {
  assertStrictEquals(
    renameToSeasonEpisode("Show.S01E49.1080p.mkv", 49, 1, "Show 3rd Season"),
    null,
  );
});

// ─── episodeKey: dedup is scoped to the show's folder ─────────────────────────

Deno.test("episodeKey: same ep in different season folders does not collide", () => {
  const s1 = episodeKey("/anime/tv/Kusuriya no Hitorigoto", 1);
  const s3 = episodeKey("/anime/tv/Kusuriya no Hitorigoto 3rd Season/", 1);
  assertEquals(
    s3,
    episodeKey("/anime/tv/Kusuriya no Hitorigoto 3rd Season", 1),
  );
  assertEquals(s1 === s3, false);
});

// ─── fetch-airing end to end: the 2026-10-02 run, replayed ────────────────────

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

const rfc822 = (sec: number) => new Date(sec * 1000).toUTCString();

async function replay(rssItems: { title: string; pubSec: number }[]) {
  const nowSec = Math.floor(Date.now() / 1000);
  const airedSec = nowSec - 2 * 3600; // S3 ep 1 aired two hours ago
  const written: { spec: string; payload: Record<string, unknown> }[] = [];
  const txCalls: { method: string; args: Record<string, unknown> }[] = [];
  const ctx = {
    globalArgs: {
      anilistUser: "fixture-user",
      anilistToken: "fixture-token",
      transmissionRpcUrl: "http://tx.example.test:9091/transmission/rpc",
      transmissionUser: "u",
      transmissionPass: "p",
      animeContainerDir: "/anime/tv",
      preferredResolution: 1080,
      telegramModel: "",
    },
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, payload: payload as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
    logger: { info: () => {}, warning: () => {} },
  };
  const items = rssItems.map((h, i) =>
    `<item><title><![CDATA[${h.title}]]></title>` +
    `<link>https://nyaa.si/view/${700 + i}</link>` +
    `<pubDate>${rfc822(h.pubSec)}</pubDate>` +
    `<nyaa:seeders>500</nyaa:seeders>` +
    `<nyaa:infoHash>${"a".repeat(39)}${i}</nyaa:infoHash></item>`
  ).join("");
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "graphql.anilist.co") {
      return Response.json({
        data: {
          MediaListCollection: {
            lists: [{
              entries: [{
                progress: 0,
                media: {
                  id: 195516,
                  title: {
                    romaji: "Kusuriya no Hitorigoto 3rd Season",
                    english: "The Apothecary Diaries Season 3",
                  },
                  synonyms: [],
                  episodes: null,
                  status: "RELEASING",
                  nextAiringEpisode: {
                    episode: 2,
                    airingAt: airedSec + 7 * 86400,
                    timeUntilAiring: 0,
                  },
                },
              }],
            }],
          },
        },
      });
    }
    if (url.hostname === "nyaa.si") {
      return new Response(`<rss><channel>${items}</channel></rss>`);
    }
    if (url.hostname === "tx.example.test") {
      if (!req.headers.get("X-Transmission-Session-Id")) {
        return new Response("", {
          status: 409,
          headers: { "X-Transmission-Session-Id": "sid" },
        });
      }
      const body = await req.json();
      txCalls.push({ method: body.method, args: body.arguments });
      if (body.method === "torrent-get") {
        return Response.json({
          result: "success",
          arguments: { torrents: [] },
        });
      }
      if (body.method === "torrent-add") {
        const src = String(body.arguments.filename);
        const idx = Number(src.match(/(\d+)\.torrent$/)![1]) - 700;
        return Response.json({
          result: "success",
          arguments: {
            "torrent-added": { id: 42, name: rssItems[idx].title },
          },
        });
      }
      return Response.json({ result: "success", arguments: {} });
    }
    throw new Error(`unrouted ${req.url}`);
  };
  try {
    const m = (model.methods as MethodMap)["fetch-airing"];
    await m.execute(m.arguments.parse({}), ctx);
  } finally {
    globalThis.fetch = original;
  }
  const result = written.find((w) => w.spec === "fetchResult")!.payload;
  return { result, txCalls, airedSec };
}

Deno.test("fetch-airing: S3 ep 1 never takes a 2025 S02E01", async () => {
  const { result, txCalls } = await replay([{
    title:
      "[Half-Baked] The Apothecary Diaries (Kusuriya no Hitorigoto) - S02E01 [WEB 1080p HEVC E-AC3].mkv",
    pubSec: Date.UTC(2025, 0, 11) / 1000,
  }]);
  const outcomes = result.outcomes as { status: string }[];
  assertEquals(outcomes.map((o) => o.status), ["not-found"]);
  assertEquals(txCalls.some((c) => c.method === "torrent-add"), false);
});

Deno.test("fetch-airing: SubsPlease '- 49' queued as S3 ep 1 and renamed", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const name = "[SubsPlease] Kusuriya no Hitorigoto - 49 (1080p) [AAAA].mkv";
  const { result, txCalls } = await replay([
    {
      title:
        "[Half-Baked] The Apothecary Diaries (Kusuriya no Hitorigoto) - S02E01 [WEB 1080p HEVC E-AC3].mkv",
      pubSec: Date.UTC(2025, 0, 11) / 1000,
    },
    { title: name, pubSec: nowSec - 600 },
  ]);
  const [o] = result.outcomes as Record<string, unknown>[];
  assertEquals(o.status, "queued");
  assertEquals(o.episode, 1);
  assertEquals(o.reason, "absolute-episode-49-renamed");
  const add = txCalls.find((c) => c.method === "torrent-add")!;
  assertEquals(
    add.args["download-dir"],
    "/anime/tv/Kusuriya no Hitorigoto 3rd Season",
  );
  const rename = txCalls.find((c) => c.method === "torrent-rename-path")!;
  assertEquals(rename.args, {
    ids: [42],
    path: name,
    name:
      "[SubsPlease] Kusuriya no Hitorigoto 3rd Season - 01 (1080p) [AAAA].mkv",
  });
});
