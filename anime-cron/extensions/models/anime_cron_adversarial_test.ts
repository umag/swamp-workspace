/**
 * Adversarial suite: hostile/malformed Nyaa RSS and AniList payloads, title
 * path-traversal into the download-dir, the Transmission 409-without-session-id
 * throw, SeaDex's two distinct "not found" wire shapes (non-ok status vs an
 * empty `items[]`), a server-echoed-credential non-redaction pin (AniList)
 * contrasted with Transmission's non-leaking error path, the sendTg
 * fire-and-forget swallow of a throwing subprocess, an array-args-only
 * command-injection negative, and a mechanical fixtures-secret-scan over
 * anime-cron/fixtures/*.json.
 *
 * anime_cron.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so
 * explicitly. Some of these gaps are also tracked in the local
 * `anime-cron-accounting-quirks` issue-lifecycle bug model.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./anime_cron.ts";
import anilistWatching from "../../fixtures/anilist-watching.json" with {
  type: "json",
};
import anilistCompleted from "../../fixtures/anilist-completed.json" with {
  type: "json",
};
import anilistMediaSearch from "../../fixtures/anilist-media-search.json" with {
  type: "json",
};
import anilistSaveEntry from "../../fixtures/anilist-save-entry.json" with {
  type: "json",
};
import txTorrentGet from "../../fixtures/transmission-torrent-get.json" with {
  type: "json",
};
import txTorrentAdd from "../../fixtures/transmission-torrent-add.json" with {
  type: "json",
};
import seadexEntry from "../../fixtures/seadex-entry.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness (local copy — each suite file is independently runnable, mirrors
// the seanime/porkbun/victorialogs precedent of not sharing a harness module)
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  anilistUser: "fixture-user",
  anilistToken: "adv-fixture-anilist-token",
  transmissionRpcUrl: "http://tx.example.test:9091/transmission/rpc",
  transmissionUser: "fixture-tx-user",
  transmissionPass: "adv-fixture-tx-pass",
  animeContainerDir: "/anime/tv",
  archiveContainerDir: "/anime/kineko",
  preferredResolution: 1080,
  telegramModel: "",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (
  req: Request,
) => Response | Promise<Response | undefined> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

interface AniListHandlers {
  watching?: () => unknown;
  completed?: () => unknown;
  mediaSearch?: (search: string) => unknown;
  saveEntry?: (vars: Record<string, unknown>) => unknown;
}

function aniListRoute(handlers: AniListHandlers): Route {
  return async (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "graphql.anilist.co") return undefined;
    const body = await requestBody(req);
    const query = String(body.query ?? "");
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    if (query.includes("status: CURRENT") && handlers.watching) {
      return json(handlers.watching());
    }
    if (query.includes("status: COMPLETED") && handlers.completed) {
      return json(handlers.completed());
    }
    if (query.includes("SaveMediaListEntry") && handlers.saveEntry) {
      return json(handlers.saveEntry(variables));
    }
    if (query.includes("Media(search:") && handlers.mediaSearch) {
      return json(handlers.mediaSearch(String(variables.search ?? "")));
    }
    return undefined;
  };
}

interface RssHitSpec {
  title: string;
  infoHash: string;
  seeders?: number;
  link?: string;
}

function rss(hits: RssHitSpec[]): string {
  const items = hits.map((h, i) => {
    const link = h.link ?? `https://nyaa.si/view/${900000 + i}`;
    return `<item><title><![CDATA[${h.title}]]></title><link>${link}</link>` +
      `<nyaa:seeders>${h.seeders ?? 10}</nyaa:seeders>` +
      `<nyaa:infoHash>${h.infoHash}</nyaa:infoHash></item>`;
  }).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function nyaaRoute(byQuery: Record<string, RssHitSpec[]>): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "nyaa.si" || url.searchParams.get("page") !== "rss") {
      return undefined;
    }
    const q = url.searchParams.get("q") ?? "";
    const hits = byQuery[q];
    if (hits === undefined) return undefined;
    return new Response(rss(hits), { status: 200 });
  };
}

/** A raw-XML nyaa route for hand-crafted hostile RSS bodies (bypassing the
 * rss() builder, which always emits well-formed items). Any query NOT
 * explicitly overridden but reachable by the anilist-watching fixture's
 * romaji->english->synonym->baseTitle fallback chain defaults to an empty
 * (but well-formed) RSS body — this is what the fallback chain searches
 * with when the primary (romaji) query never satisfies needsEp(). */
const CHRONICLES_FALLBACK_QUERIES = [
  "Fixture Chronicles",
  "Fixture Chronicles: English Cut",
  "FC",
  "Fixture-chan",
];
const WANDERERS_FALLBACK_QUERIES = ["Fixture Wanderers"];

function nyaaRawRoute(byQuery: Record<string, string>): Route {
  const knownQueries = [
    ...CHRONICLES_FALLBACK_QUERIES,
    ...WANDERERS_FALLBACK_QUERIES,
  ];
  return (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "nyaa.si" || url.searchParams.get("page") !== "rss") {
      return undefined;
    }
    const q = url.searchParams.get("q") ?? "";
    if (q in byQuery) {
      return new Response(byQuery[q], { status: 200 });
    }
    if (knownQueries.includes(q)) {
      return new Response(rss([]), { status: 200 });
    }
    return undefined;
  };
}

interface TxHandlers {
  torrentGet?: () => unknown[];
  torrentAdd?: (args: Record<string, unknown>) => unknown;
  torrentSet?: (args: Record<string, unknown>) => unknown;
  sid?: string;
}

function txRoute(handlers: TxHandlers): Route {
  const sid = handlers.sid ?? "fixture-tx-session-id";
  return async (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "tx.example.test") return undefined;
    const gotSid = req.headers.get("X-Transmission-Session-Id");
    if (!gotSid) {
      return new Response("", {
        status: 409,
        headers: { "X-Transmission-Session-Id": sid },
      });
    }
    const body = await requestBody(req);
    if (body.method === "torrent-get" && handlers.torrentGet) {
      return json({
        result: "success",
        arguments: { torrents: handlers.torrentGet() },
      });
    }
    if (body.method === "torrent-add" && handlers.torrentAdd) {
      return json({
        result: "success",
        arguments: handlers.torrentAdd(
          body.arguments as Record<string, unknown>,
        ),
      });
    }
    if (body.method === "torrent-set" && handlers.torrentSet) {
      return json({
        result: "success",
        arguments: handlers.torrentSet(
          body.arguments as Record<string, unknown>,
        ) ?? {},
      });
    }
    return undefined;
  };
}

function seadexRoute(handler: (anilistId: number) => unknown): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "releases.moe") return undefined;
    const filter = url.searchParams.get("filter") ?? "";
    const m = filter.match(/alID=(\d+)/);
    const anilistId = m ? Number(m[1]) : NaN;
    return json(handler(anilistId));
  };
}

type Invocation = { command: string; args: string[] };

function installSpawnCmdStub(
  opts: { throwOnSpawn?: boolean; throwOnOutput?: boolean } = {},
) {
  const invocations: Invocation[] = [];
  const stdinChunks: Uint8Array[] = [];
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, cmdOpts: { args: string[] }) {
      this.#cmd = cmd;
      this.#args = cmdOpts.args;
    }
    spawn() {
      invocations.push({ command: this.#cmd, args: this.#args });
      if (opts.throwOnSpawn) {
        throw new Error("spawn failed (simulated ENOENT)");
      }
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              stdinChunks.push(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          if (opts.throwOnOutput) {
            return Promise.reject(new Error("output failed (simulated)"));
          }
          return Promise.resolve({
            success: true,
            code: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          });
        },
      };
    }
  };
  return {
    invocations,
    stdin: stdinChunks,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

// ---------------------------------------------------------------------------
// Hostile Nyaa RSS payloads
// ---------------------------------------------------------------------------

Deno.test("pin: an RSS item missing <nyaa:infoHash> is silently dropped by parseRSS — the episode surfaces as not-found, not an error", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => anilistWatching }),
      txRoute({ torrentGet: () => [] }),
      nyaaRawRoute({
        "Fixture Chronicles":
          `<?xml version="1.0"?><rss><channel><item><title><![CDATA[[SubsPlease] Fixture Chronicles - 04 [1080p].mkv]]></title><link>https://nyaa.si/view/1</link><nyaa:seeders>5</nyaa:seeders></item></channel></rss>`,
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  const outcomes = res.payload.outcomes as Array<
    { title: string; status: string; episode: number }
  >;
  const chronicles = outcomes.find((o) => o.title === "Fixture Chronicles");
  assertEquals(
    chronicles?.status,
    "not-found",
    "the infoHash-less item never becomes a NyaaHit at all, so pickBest has nothing to match",
  );
});

Deno.test("pin: an RSS item missing <title> is silently dropped the same way", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => anilistWatching }),
      txRoute({ torrentGet: () => [] }),
      nyaaRawRoute({
        "Fixture Chronicles":
          `<?xml version="1.0"?><rss><channel><item><link>https://nyaa.si/view/1</link><nyaa:infoHash>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</nyaa:infoHash></item></channel></rss>`,
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  const outcomes = res.payload.outcomes as Array<
    { title: string; status: string }
  >;
  const chronicles = outcomes.find((o) => o.title === "Fixture Chronicles");
  assertEquals(chronicles?.status, "not-found");
});

Deno.test("pin: malformed RSS with no <item> blocks at all yields zero hits — not-found, no throw", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => anilistWatching }),
      txRoute({ torrentGet: () => [] }),
      nyaaRawRoute({
        "Fixture Chronicles":
          `<?xml version="1.0"?><rss><channel></channel></rss>`,
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(
    res.payload.notFound,
    3,
    "all 3 due episodes (4, 11, 12) go not-found",
  );
});

// ---------------------------------------------------------------------------
// Hostile AniList payloads
// ---------------------------------------------------------------------------

Deno.test("pin: an AniList response with json.errors[] populated throws 'AniList errors: <message>' — the raw message text is embedded verbatim", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json(errorFixture)], async () => {
    await assertRejects(
      () => run("fetch-airing", {}, ctx),
      Error,
      "AniList errors: Invalid token",
    );
  });
});

Deno.test("pin: an AniList response with neither data nor errors (json.data ?? {} fallback) throws an UNMAPPED TypeError reading .lists of undefined", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await assertRejects(() => run("fetch-airing", {}, ctx), TypeError);
  });
});

Deno.test("pin: server-echoed credential surfaces VERBATIM in a thrown AniList error — the model performs no redaction", async () => {
  const SENTINEL = "sntl_server_echo_do_not_log_1122334455";
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => new Response(`Invalid token=${SENTINEL}`, { status: 401 })],
    async () => {
      const err = await assertRejects(() => run("fetch-airing", {}, ctx));
      assert(
        String(err).includes(SENTINEL),
        "sanity: the fixture actually echoes the token in the AniList error path",
      );
    },
  );
});

Deno.test("contrast: a Transmission RPC failure's thrown message NEVER embeds the response body (unlike AniList's verbatim echo above)", async () => {
  // disk-stats' txListTorrents call is NOT wrapped in a try/catch (unlike
  // fetch-airing's pre-load, which swallows a Transmission failure via
  // `.catch(() => [])`) — its failure propagates directly, so it is the
  // right vehicle to observe txRpc's actual error-message shape.
  const SENTINEL = "sntl_tx_body_do_not_log_5544332211";
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      // Transmission responds 500 with a body containing the sentinel, but
      // txRpc's error branch only ever embeds `resp.status`, never the body.
      (req) => {
        const url = new URL(req.url);
        if (url.hostname !== "tx.example.test") return undefined;
        return new Response(`leaked: ${SENTINEL}`, { status: 500 });
      },
    ],
    async () => {
      const err = await assertRejects(() => run("disk-stats", {}, ctx));
      assert(
        !String(err).includes(SENTINEL),
        "Transmission's error message must never embed the response body",
      );
      assert(
        String(err).includes("500"),
        "Transmission's error message embeds only the status code",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Title path-traversal into the download-dir
// ---------------------------------------------------------------------------

Deno.test("pin: a romaji title of '..' survives toFolderName untouched and traverses the download-dir sent to Transmission", async () => {
  // toFolderName strips /\:*?\"<>| but NOT dots — a title of exactly ".."
  // (no forbidden characters) passes through unchanged, so
  // `${animeContainerDir}/${folderName}` becomes a traversal segment.
  // Documented gap, not fixed here (anime_cron.ts is byte-frozen).
  const hostileWatching = {
    data: {
      MediaListCollection: {
        lists: [{
          entries: [{
            progress: 3,
            media: {
              id: 200501,
              title: { romaji: "..", english: null },
              synonyms: [],
              episodes: 12,
              status: "RELEASING",
              nextAiringEpisode: {
                episode: 5,
                airingAt: 1751500000,
                timeUntilAiring: 3600,
              },
            },
          }],
        }],
      },
    },
  };
  const { ctx } = makeCtx();
  let capturedDownloadDir: string | undefined;
  await withFetchStub(
    [
      aniListRoute({ watching: () => hostileWatching }),
      txRoute({
        torrentGet: () => [],
        torrentAdd: (args) => {
          capturedDownloadDir = args["download-dir"] as string;
          return txTorrentAdd.arguments;
        },
      }),
      nyaaRoute({
        "..": [{
          title: "[SubsPlease] .. - 04 [1080p].mkv",
          infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  assertEquals(capturedDownloadDir, "/anime/tv/..");
});

// ---------------------------------------------------------------------------
// Transmission 409 session-id handshake — positive + negative
// ---------------------------------------------------------------------------

Deno.test("Transmission 409 handshake: the retried request carries the EXACT X-Transmission-Session-Id issued on the first 409", async () => {
  const { ctx, written } = makeCtx();
  let sidOnRetry: string | null = null;
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.hostname !== "tx.example.test") return undefined;
      const gotSid = req.headers.get("X-Transmission-Session-Id");
      if (!gotSid) {
        return new Response("", {
          status: 409,
          headers: { "X-Transmission-Session-Id": "issued-sid-99887766" },
        });
      }
      sidOnRetry = gotSid;
      return json({
        result: "success",
        arguments: { torrents: txTorrentGet.arguments.torrents },
      });
    }],
    async () => {
      await run("disk-stats", {}, ctx);
    },
  );
  assertEquals(sidOnRetry, "issued-sid-99887766");
  assert(written.find((w) => w.spec === "diskStats"));
});

Deno.test("pin: a 409 response WITHOUT an X-Transmission-Session-Id header throws '409 from transmission but no session id'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.hostname !== "tx.example.test") return undefined;
      return new Response("", { status: 409 }); // no header at all
    }],
    async () => {
      await assertRejects(
        () => run("disk-stats", {}, ctx),
        Error,
        "409 from transmission but no session id",
      );
    },
  );
});

Deno.test("pin: txRpc's 409 retry has NO depth cap — a server that keeps re-issuing a fresh session id eventually still succeeds after many retries", async () => {
  // txRpc(url, user, pass, method, args, sid?) recurses with no attempt
  // counter or max-depth guard. This test proves there is no artificial cap
  // (e.g. "give up after 3 tries") by forcing 15 consecutive 409s, each with
  // a DIFFERENT freshly-issued session id, before finally succeeding — a
  // hard-coded low retry cap would fail this test.
  const RETRIES_BEFORE_SUCCESS = 15;
  let call = 0;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.hostname !== "tx.example.test") return undefined;
      call++;
      if (call <= RETRIES_BEFORE_SUCCESS) {
        return new Response("", {
          status: 409,
          headers: { "X-Transmission-Session-Id": `sid-round-${call}` },
        });
      }
      return json({
        result: "success",
        arguments: { torrents: [] },
      });
    }],
    async () => {
      await run("disk-stats", {}, ctx);
    },
  );
  assertEquals(call, RETRIES_BEFORE_SUCCESS + 1);
  assert(written.find((w) => w.spec === "diskStats"));
});

// ---------------------------------------------------------------------------
// SeaDex's two distinct "not found" wire shapes
// ---------------------------------------------------------------------------

Deno.test("SeaDex non-ok status (500) resolves to null -> 'not-in-seadex', no throw", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      (req) => {
        const url = new URL(req.url);
        if (url.hostname !== "releases.moe") return undefined;
        return new Response("seadex down", { status: 500 });
      },
    ],
    async () => {
      await run("upgrade-bd", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.notInSeadex, 1);
  const outcomes = res.payload.outcomes as Array<{ status: string }>;
  assertEquals(outcomes[0].status, "not-in-seadex");
});

Deno.test("SeaDex 200 OK with an empty items[] ALSO resolves to null -> the SAME 'not-in-seadex' outcome", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => ({ items: [] })),
    ],
    async () => {
      await run("upgrade-bd", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.notInSeadex, 1);
});

Deno.test("pin: an uncaught seadexLookup() exception (malformed JSON, resp.ok but unparseable body) aborts the WHOLE upgrade-bd run — unlike fetch-airing's per-show-isolated Nyaa failure", async () => {
  // seadexLookup only maps !resp.ok -> null; it never catches a resp.json()
  // parse failure, and upgrade-bd's call site has no try/catch around it
  // either (`const trs = await seadexLookup(show.mediaId);`). This is a real
  // asymmetry with fetch-airing's Nyaa search, which IS wrapped in a
  // per-show try/catch — documented here, not fixed (source is byte-frozen).
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      (req) => {
        const url = new URL(req.url);
        if (url.hostname !== "releases.moe") return undefined;
        // resp.ok is true, but the body is not valid JSON -> resp.json() rejects.
        return new Response("not valid json {{{", { status: 200 });
      },
    ],
    async () => {
      await assertRejects(() => run("upgrade-bd", {}, ctx));
    },
  );
  assertEquals(
    written.find((w) => w.spec === "upgradeResult"),
    undefined,
    "the whole run aborts before writing any result — no per-show isolation here",
  );
});

Deno.test("pin: fetch-airing's LIVE Transmission torrent-add returning 'torrent-duplicate' is counted as duplicate (distinct from the pre-load existingSet dedup)", async () => {
  const entry = {
    progress: 3,
    media: {
      id: 300201,
      title: { romaji: "Fixture Live Duplicate", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: { episode: 5, airingAt: 0, timeUntilAiring: 0 },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({
        watching: () => ({
          data: { MediaListCollection: { lists: [{ entries: [entry] }] } },
        }),
      }),
      txRoute({
        torrentGet: () => [], // pre-load empty -> NOT caught by existingSet
        torrentAdd: () => ({
          "torrent-duplicate": { id: 42, name: "already-there.mkv" },
        }),
      }),
      nyaaRoute({
        "Fixture Live Duplicate": [{
          title: "[SubsPlease] Fixture Live Duplicate - 04 [1080p].mkv",
          infoHash: "1111111111111111111111111111111111111a",
        }],
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.duplicates, 1);
  assertEquals(res.payload.queued, 0);
  const outcomes = res.payload.outcomes as Array<
    { status: string; torrentName?: string }
  >;
  assertEquals(outcomes[0].status, "duplicate");
  assertEquals(outcomes[0].torrentName, "already-there.mkv");
});

Deno.test("pin: fetch-airing's torrent-add returning NEITHER added nor duplicate is an 'error'/'transmission-add-failed' outcome, counted by no counter", async () => {
  const entry = {
    progress: 3,
    media: {
      id: 300202,
      title: { romaji: "Fixture Add Failed", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: { episode: 5, airingAt: 0, timeUntilAiring: 0 },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({
        watching: () => ({
          data: { MediaListCollection: { lists: [{ entries: [entry] }] } },
        }),
      }),
      txRoute({
        torrentGet: () => [],
        torrentAdd: () => ({}), // neither torrent-added nor torrent-duplicate
      }),
      nyaaRoute({
        "Fixture Add Failed": [{
          title: "[SubsPlease] Fixture Add Failed - 04 [1080p].mkv",
          infoHash: "2222222222222222222222222222222222222b",
        }],
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.queued, 0);
  assertEquals(res.payload.duplicates, 0);
  assertEquals(res.payload.notFound, 0);
  const outcomes = res.payload.outcomes as Array<
    { status: string; reason?: string }
  >;
  assertEquals(outcomes[0].status, "error");
  assertEquals(outcomes[0].reason, "transmission-add-failed");
});

Deno.test("pin: upgrade-bd's LIVE torrent-add returning 'torrent-duplicate' is recorded as a 'duplicate' outcome, counted by no counter (not queued, not skippedOnDisk, not notInSeadex)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
      txRoute({
        torrentAdd: () => ({
          "torrent-duplicate": { id: 43, name: "already-on-disk.mkv" },
        }),
      }),
    ],
    async () => {
      await run("upgrade-bd", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.queued, 0);
  assertEquals(res.payload.skippedOnDisk, 0);
  assertEquals(res.payload.notInSeadex, 0);
  const outcomes = res.payload.outcomes as Array<{ status: string }>;
  assertEquals(outcomes[0].status, "duplicate");
});

Deno.test("pin: upgrade-bd's torrent-add returning NEITHER added nor duplicate is an 'error'/'transmission-add-failed' outcome, counted by no counter", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
      txRoute({ torrentAdd: () => ({}) }),
    ],
    async () => {
      await run("upgrade-bd", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.queued, 0);
  const outcomes = res.payload.outcomes as Array<
    { status: string; reason?: string }
  >;
  assertEquals(outcomes[0].status, "error");
  assertEquals(outcomes[0].reason, "transmission-add-failed");
});

// ---------------------------------------------------------------------------
// mark-watched: the AniList mutation-failure path (distinct from
// could-not-parse-episode and anilist-not-found — this one DOES increment
// `failed`, unlike the pinned accounting quirk)
// ---------------------------------------------------------------------------

Deno.test("mark-watched: a failing SaveMediaListEntry mutation increments `failed` and records the sliced error message", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "[SubsPlease] Fixture Mutation Fail - 04 [1080p].mkv",
          status: 6,
          percentDone: 1,
          isFinished: true,
          doneDate: Math.floor(Date.now() / 1000) - 3600,
          downloadDir: "/anime/tv/Fixture Mutation Fail",
          totalSize: 100,
          hashString: "3333333333333333333333333333333333333c",
        }],
      }),
      // Custom route (not the shared aniListRoute helper, which always
      // wraps a handler's return value as a 200 JSON body): the mutation
      // must actually return a NON-ok status so gqlRequest's real
      // `!resp.ok` branch throws a proper Error, matching what mark-watched's
      // catch block actually expects ((e as Error).message).
      async (req) => {
        const url = new URL(req.url);
        if (url.hostname !== "graphql.anilist.co") return undefined;
        const body = await requestBody(req);
        const query = String(body.query ?? "");
        if (query.includes("Media(search:")) return json(anilistMediaSearch);
        if (query.includes("SaveMediaListEntry")) {
          return new Response("mutation rejected", { status: 500 });
        }
        return undefined;
      },
    ],
    async () => {
      await run("mark-watched", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "markResult")!;
  assertEquals(res.payload.updated, 0);
  assertEquals(
    res.payload.failed,
    1,
    "a genuine mutation failure DOES increment failed — unlike the could-not-parse-episode quirk",
  );
  const outcomes = res.payload.outcomes as Array<
    { updated: boolean; reason?: string }
  >;
  assertEquals(outcomes[0].updated, false);
  assert(
    outcomes[0].reason,
    "a reason string is recorded for the failed mutation",
  );
});

// ---------------------------------------------------------------------------
// fetch-airing: the swallowed pre-load Transmission failure actually verified
// (not just asserted by comment) — the method still completes with an
// effectively empty existingSet rather than rejecting
// ---------------------------------------------------------------------------

Deno.test("fetch-airing: a failing pre-load Transmission torrent-get is swallowed via .catch(() => []) — the episode still gets queued normally (existingSet was just empty, not an error)", async () => {
  const entry = {
    progress: 3,
    media: {
      id: 300203,
      title: { romaji: "Fixture Preload Failure", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: { episode: 5, airingAt: 0, timeUntilAiring: 0 },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({
        watching: () => ({
          data: { MediaListCollection: { lists: [{ entries: [entry] }] } },
        }),
      }),
      nyaaRoute({
        "Fixture Preload Failure": [{
          title: "[SubsPlease] Fixture Preload Failure - 04 [1080p].mkv",
          infoHash: "4444444444444444444444444444444444444d",
        }],
      }),
      // A hand-rolled Transmission route that fails ONLY torrent-get (the
      // pre-load) while torrent-add (the later live add) succeeds normally
      // — isolates the pre-load failure from the rest of the pipeline.
      async (req) => {
        const url = new URL(req.url);
        if (url.hostname !== "tx.example.test") return undefined;
        const gotSid = req.headers.get("X-Transmission-Session-Id");
        const body = await requestBody(req);
        if (body.method === "torrent-get") {
          return new Response("transmission unreachable", { status: 500 });
        }
        if (!gotSid) {
          return new Response("", {
            status: 409,
            headers: { "X-Transmission-Session-Id": "preload-fail-sid" },
          });
        }
        return json({
          result: "success",
          arguments: { "torrent-added": { id: 1, name: "queued.mkv" } },
        });
      },
    ],
    async () => {
      // Must NOT reject, despite the pre-load 500 — contrast with
      // mark-watched/disk-stats, whose (unguarded) torrent-get DOES reject.
      await run("fetch-airing", { dryRun: false }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.checked, 1);
  assertEquals(
    res.payload.queued,
    1,
    "the episode is genuinely queued despite the pre-load 500 — the swallow left existingSet empty, not an error state",
  );
});

// ---------------------------------------------------------------------------
// sendTg fire-and-forget swallow
// ---------------------------------------------------------------------------

Deno.test("pin: sendTg swallows a rejecting output() — the main pipeline still completes and reports success", async () => {
  const cmdStub = installSpawnCmdStub({ throwOnOutput: true });
  const { ctx, written } = makeCtx({
    ...GLOBAL_ARGS,
    telegramModel: "tg-instance",
  });
  try {
    await withFetchStub(
      [
        aniListRoute({ watching: () => anilistWatching }),
        txRoute({
          torrentGet: () => [],
          torrentAdd: () => txTorrentAdd.arguments,
        }),
        nyaaRoute({
          "Fixture Chronicles": [{
            title: "[SubsPlease] Fixture Chronicles - 04 [1080p].mkv",
            infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }],
          "Fixture Wanderers": [
            {
              title: "[SubsPlease] Fixture Wanderers - 11 [1080p].mkv",
              infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            {
              title: "[SubsPlease] Fixture Wanderers - 12 [1080p].mkv",
              infoHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
          ],
        }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(
    cmdStub.invocations.length >= 1,
    true,
    "sendTg was invoked at least once despite always failing",
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assert(
    (res.payload.queued as number) >= 1,
    "the pipeline's queued count is unaffected by the TG subprocess failure",
  );
});

Deno.test("pin: sendTg swallows a THROWING spawn() (ENOENT-style) exactly the same way", async () => {
  const cmdStub = installSpawnCmdStub({ throwOnSpawn: true });
  const { ctx, written } = makeCtx({
    ...GLOBAL_ARGS,
    telegramModel: "tg-instance",
  });
  try {
    await withFetchStub(
      [
        aniListRoute({ watching: () => anilistWatching }),
        txRoute({
          torrentGet: () => [],
          torrentAdd: () => txTorrentAdd.arguments,
        }),
        nyaaRoute({
          "Fixture Chronicles": [{
            title: "[SubsPlease] Fixture Chronicles - 04 [1080p].mkv",
            infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }],
          "Fixture Wanderers": [
            {
              title: "[SubsPlease] Fixture Wanderers - 11 [1080p].mkv",
              infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            {
              title: "[SubsPlease] Fixture Wanderers - 12 [1080p].mkv",
              infoHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
          ],
        }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "fetchResult")!;
  assert((res.payload.queued as number) >= 1);
});

// ---------------------------------------------------------------------------
// Array-args-only command-injection negative
// ---------------------------------------------------------------------------

Deno.test("array-args-only negative: a hostile telegramModel value (shell metacharacters) is passed as ONE opaque array element, never shell-interpolated", async () => {
  const HOSTILE_MODEL = "victim; rm -rf / #$(whoami)`id`";
  const cmdStub = installSpawnCmdStub();
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, telegramModel: HOSTILE_MODEL });
  try {
    await withFetchStub(
      [
        aniListRoute({ watching: () => anilistWatching }),
        txRoute({
          torrentGet: () => [],
          torrentAdd: () => txTorrentAdd.arguments,
        }),
        nyaaRoute({
          "Fixture Chronicles": [{
            title: "[SubsPlease] Fixture Chronicles - 04 [1080p].mkv",
            infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }],
          "Fixture Wanderers": [
            {
              title: "[SubsPlease] Fixture Wanderers - 11 [1080p].mkv",
              infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            {
              title: "[SubsPlease] Fixture Wanderers - 12 [1080p].mkv",
              infoHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
          ],
        }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assert(cmdStub.invocations.length >= 1);
  const args = cmdStub.invocations[0].args;
  assertEquals(
    args,
    ["model", "method", "run", HOSTILE_MODEL, "sendMessage", "--stdin"],
    "the hostile string is ONE array element at index 3, byte-for-byte, never split or expanded",
  );
  assertEquals(
    args.length,
    6,
    "no extra args were introduced by the metacharacters",
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over anime-cron/fixtures/*.json
// ---------------------------------------------------------------------------

function distinctCharCount(s: string): number {
  return new Set(s).size;
}

const SECRET_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  { name: "vault key name TOKEN", test: (s) => /\bTOKEN\b/.test(s) },
  { name: "vault key name PASS", test: (s) => /\bPASS(WORD)?\b/i.test(s) },
  // A JWT-shaped value (three dot-separated base64url segments) — the shape
  // a real AniList OAuth access token or personal access token would carry.
  {
    name: "JWT-shaped value (three dot-separated segments)",
    test: (s) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s),
  },
  // Generic high-entropy blob: 32+ alnum/base64url characters with no
  // separators AND meaningful character diversity (>=10 distinct chars) —
  // this second condition is what lets the torrent-hash fixtures' 40
  // repeated hex characters (1-4 distinct chars, a deliberate low-entropy
  // placeholder) pass cleanly while still catching anything shaped like a
  // real random token or hash.
  {
    name: "high-entropy token-shaped value",
    test: (s) =>
      /^[A-Za-z0-9+/_=-]{32,}$/.test(s) && distinctCharCount(s) >= 10,
  },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "anilist-watching.json": anilistWatching,
  "anilist-completed.json": anilistCompleted,
  "anilist-media-search.json": anilistMediaSearch,
  "anilist-save-entry.json": anilistSaveEntry,
  "transmission-torrent-get.json": txTorrentGet,
  "transmission-torrent-add.json": txTorrentAdd,
  "seadex-entry.json": seadexEntry,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, test } of SECRET_PATTERNS) {
        if (test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — each of the four patterns is independently proven to fire on its own tailored poison value", () => {
  const perPatternPoison: Record<string, string> = {
    "vault key name TOKEN": "TOKEN=abc123",
    "vault key name PASS": "PASSWORD=hunter2",
    "JWT-shaped value (three dot-separated segments)":
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "high-entropy token-shaped value": "aB3xQ9zL2mK7pR4nT6wY1cV8sD5fH0gJ",
  };
  for (const { name, test } of SECRET_PATTERNS) {
    const poison = perPatternPoison[name];
    assert(poison, `no tailored poison value defined for pattern "${name}"`);
    assert(
      test(poison),
      `pattern "${name}" failed to flag its own tailored poison value "${poison}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// fetch-archive — hostile release titles
// ---------------------------------------------------------------------------

Deno.test("fetch-archive: a release title carrying HTML is escaped before it reaches the Telegram subprocess", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, telegramModel: "tg-bot" });
  const cmd = installSpawnCmdStub();
  const hostile =
    "[Kineko Video] <script>alert(1)</script> & <b>bold</b> [1080p]";
  try {
    await withFetchStub([
      nyaaRoute({
        "Kineko Video": [{ title: hostile, infoHash: "d".repeat(40) }],
        "LonelyChaser": [],
      }),
      txRoute({
        torrentGet: () => [],
        torrentAdd: () => ({ "torrent-added": { id: 7, name: "x" } }),
        torrentSet: () => ({}),
      }),
    ], async () => {
      await run("fetch-archive", {}, ctx);
    });
  } finally {
    cmd.restore();
  }

  assertEquals(cmd.invocations.length, 1);
  const payload = JSON.parse(
    new TextDecoder().decode(cmd.stdin[0]),
  ) as { text: string; parseMode: string };
  assertEquals(payload.parseMode, "HTML");
  // The title's own markup must arrive inert...
  assert(
    payload.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
    payload.text,
  );
  assert(payload.text.includes("&amp;"), payload.text);
  // ...while the message's OWN formatting tags survive.
  assert(payload.text.includes("<b>Archive sweep queued"), payload.text);
  // No raw <script> anywhere — an unescaped title would break the send with a
  // 400 from Telegram's HTML parser at best, and inject markup at worst.
  assert(!payload.text.includes("<script>"), payload.text);
});

Deno.test("fetch-archive: a title impersonating the group outside its credit bracket is NOT swept", async () => {
  const { ctx, written } = makeCtx();
  let addCalls = 0;

  await withFetchStub([
    nyaaRoute({
      "Kineko Video": [
        // Mentions the group only in prose, and credits someone else.
        {
          title: "[TotallyNotUs] A Kineko Video tribute reupload",
          infoHash: "e".repeat(40),
        },
        // No credit bracket at all.
        {
          title: "Kineko video presents a bootleg",
          infoHash: "f".repeat(40),
        },
      ],
      "LonelyChaser": [],
    }),
    txRoute({
      torrentGet: () => [],
      torrentAdd: () => {
        addCalls++;
        return { "torrent-added": { id: 1, name: "x" } };
      },
      torrentSet: () => ({}),
    }),
  ], async () => {
    await run("fetch-archive", {}, ctx);
  });

  const r = written.find((w) => w.spec === "archiveResult")!.payload;
  assertEquals(r.found, 0);
  assertEquals(r.queued, 0);
  assertEquals(addCalls, 0);
});

Deno.test("fetch-archive: credentials never reach the written resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    nyaaRoute({
      "Kineko Video": [{
        title: "[Kineko Video] Foo",
        infoHash: "a".repeat(40),
      }],
      "LonelyChaser": [],
    }),
    txRoute({
      torrentGet: () => [],
      torrentAdd: () => ({ "torrent-added": { id: 1, name: "x" } }),
      torrentSet: () => ({}),
    }),
  ], async () => {
    await run("fetch-archive", {}, ctx);
  });
  const blob = JSON.stringify(written);
  assert(!blob.includes("adv-fixture-tx-pass"), "transmissionPass leaked");
  assert(!blob.includes("adv-fixture-anilist-token"), "anilistToken leaked");
});
