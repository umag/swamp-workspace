// Fallback Nyaa queries for long titles.
//
// Regression: on 2026-10-18 "Mezametara Saikyou Soubi to Uchuusen-mochi datta
// node, Ikkodate Mezashite Youhei to shite Jiyuu ni Ikitai" ep 3 was
// not-found although Erai-raws, VARYG and ToonsHub had it. Releases write a
// shorter romaji ("… Uchuusenmochi Datta node") and drop the English title's
// ":" and "!", and Nyaa matches every query word literally, so neither full
// title found a 1080p release.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model, shortTitleQueries } from "./anime_cron.ts";

Deno.test("shortTitleQueries: the Mezametara case", () => {
  assertEquals(
    shortTitleQueries(
      "Mezametara Saikyou Soubi to Uchuusen-mochi datta node, Ikkodate Mezashite Youhei to shite Jiyuu ni Ikitai",
      "Reborn as a Space Mercenary: I Woke Up Piloting the Strongest Starship!",
    ),
    [
      "Reborn as a Space Mercenary I Woke Up Piloting the Strongest Starship",
      "Reborn as a Space Mercenary",
      "Mezametara Saikyou Soubi to Uchuusen-mochi datta node",
      "Mezametara Saikyou Soubi to Uchuusen-mochi datta node Ikkodate Mezashite Youhei to shite Jiyuu ni Ikitai",
      "Mezametara Saikyou Soubi",
    ],
  );
});

Deno.test("shortTitleQueries: short plain titles add nothing", () => {
  assertEquals(shortTitleQueries("Sayonara Lara", null), []);
  assertEquals(shortTitleQueries("Kyoufu Collector", "Kyoufu Collector"), []);
});

Deno.test("shortTitleQueries: never repeats the full titles", () => {
  const q = shortTitleQueries("Tempal: Item no Chikara", "Overgeared");
  assertEquals(q, ["Tempal Item no Chikara", "Tempal Item no"]);
});

Deno.test("shortTitleQueries: no duplicates", () => {
  const q = shortTitleQueries(
    "Sekai Saikyou no Majo, Hajimemashita",
    "Sekai Saikyou no Majo, Hajimemashita",
  );
  assertEquals(new Set(q).size, q.length);
  assertEquals(q, [
    "Sekai Saikyou no Majo Hajimemashita",
    "Sekai Saikyou no Majo",
    "Sekai Saikyou no",
  ]);
});

// ─── fetch-airing end to end: the 2026-10-18 run, replayed ────────────────────

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

const ROMAJI =
  "Mezametara Saikyou Soubi to Uchuusen-mochi datta node, Ikkodate Mezashite Youhei to shite Jiyuu ni Ikitai";
const ENGLISH =
  "Reborn as a Space Mercenary: I Woke Up Piloting the Strongest Starship!";

Deno.test("fetch-airing: a 720p dub on the English title does not stop the search", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const airedSec = nowSec - 1800;
  const item = (title: string, id: number) =>
    `<item><title><![CDATA[${title}]]></title>` +
    `<link>https://nyaa.si/view/${id}</link>` +
    `<pubDate>${new Date((nowSec - 600) * 1000).toUTCString()}</pubDate>` +
    `<nyaa:seeders>50</nyaa:seeders>` +
    `<nyaa:infoHash>${String(id).padStart(40, "0")}</nyaa:infoHash></item>`;
  const byQuery: Record<string, string> = {
    [ENGLISH]: item(
      `[Yameii] ${ENGLISH} - S01E03 [English Dub] [CR WEB-DL 720p H264 AAC]`,
      1,
    ),
    "Mezametara Saikyou Soubi": item(
      "[Erai-raws] Mezametara Saikyou Soubi to Uchuusenmochi Datta node - 03 [1080p CR WEB-DL AVC AAC][MultiSub][671360F2]",
      2,
    ),
  };
  const queries: string[] = [];
  const added: string[] = [];
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
                progress: 2,
                media: {
                  id: 186541,
                  title: { romaji: ROMAJI, english: ENGLISH },
                  synonyms: ["Saikyosoubi"],
                  episodes: 13,
                  status: "RELEASING",
                  nextAiringEpisode: {
                    episode: 4,
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
      const q = url.searchParams.get("q") ?? "";
      queries.push(q);
      return new Response(`<rss><channel>${byQuery[q] ?? ""}</channel></rss>`);
    }
    if (url.hostname === "tx.example.test") {
      if (!req.headers.get("X-Transmission-Session-Id")) {
        return new Response("", {
          status: 409,
          headers: { "X-Transmission-Session-Id": "sid" },
        });
      }
      const body = await req.json();
      if (body.method === "torrent-get") {
        return Response.json({
          result: "success",
          arguments: { torrents: [] },
        });
      }
      if (body.method === "torrent-add") {
        added.push(String(body.arguments.filename));
        return Response.json({
          result: "success",
          arguments: { "torrent-added": { id: 9, name: "x" } },
        });
      }
      return Response.json({ result: "success", arguments: {} });
    }
    throw new Error(`unrouted ${req.url}`);
  };
  const written: { spec: string; payload: Record<string, unknown> }[] = [];
  try {
    const m = (model.methods as MethodMap)["fetch-airing"];
    await m.execute(m.arguments.parse({}), {
      globalArgs: {
        anilistUser: "u",
        anilistToken: "t",
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
    });
  } finally {
    globalThis.fetch = original;
  }
  const result = written.find((w) => w.spec === "fetchResult")!.payload;
  const [o] = result.outcomes as Record<string, unknown>[];
  assertEquals(o.status, "queued");
  assertEquals(o.episode, 3);
  assertEquals(added, ["https://nyaa.si/download/2.torrent"]);
  assertEquals(queries.includes("Mezametara Saikyou Soubi"), true);
});
