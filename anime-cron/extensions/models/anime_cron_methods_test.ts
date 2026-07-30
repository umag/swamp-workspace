/**
 * Method-level tests for @magistr/anime-cron — every one of the 4 methods
 * (fetch-airing, mark-watched, upgrade-bd, disk-stats), happy path + error
 * path, driven through `model.methods.<m>.arguments.parse()` + `.execute()`
 * against a stubbed `globalThis.fetch` (four hosts: AniList GraphQL, Nyaa
 * RSS, Transmission RPC, SeaDex), a stubbed `Deno.Command` (the `sendTg`
 * Telegram subprocess), and a fake context.
 *
 * anime_cron.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Wire-envelope pins live HERE rather than in the contract-fixture suite
 * (anime_cron_test.ts, kept byte-unchanged) because anime_cron.ts's wire
 * parsers (parseRSS, gqlRequest, txRpc, seadexLookup) are module-private —
 * only reachable through a method's execute(). See fixtures/PROVENANCE.md
 * for the full rationale and the fixture-provenance/live-capture ban.
 *
 * Credential-leak assertions cover both boundaries, in TWO separate tests:
 * the written-resource/logger sweep (below, across all four methods) and the
 * Deno.Command argv/stdin sweep (the dedicated "TG alert" test — sendTg is
 * only reachable from fetch-airing, so that is the one scenario needed to
 * exercise the subprocess boundary). anilistToken/transmissionPass sentinels
 * must never appear in a written resource, a logger call, a captured
 * Deno.Command argv, or a captured stdin payload.
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SENTINEL_ANILIST_TOKEN = "sntl_anilist_leak_check_do_not_log_1234567890";
const SENTINEL_TX_PASS = "sntl_transmission_leak_check_do_not_log_0987654321";

const GLOBAL_ARGS = {
  anilistUser: "fixture-user",
  anilistToken: SENTINEL_ANILIST_TOKEN,
  transmissionRpcUrl: "http://tx.example.test:9091/transmission/rpc",
  transmissionUser: "fixture-tx-user",
  transmissionPass: SENTINEL_TX_PASS,
  animeContainerDir: "/anime/tv",
  preferredResolution: 1080,
  telegramModel: "",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
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
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// fetch stub — no-cast idiom (victorialogs wave-2b precedent): the stub is
// written to globalThis through an `any`-cast assignment; the restore
// assigns back the ORIGINAL (already correctly typed) function.
// ---------------------------------------------------------------------------

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

/** Route graphql.anilist.co POST calls by inspecting the POST-body query
 * text — all four AniList operations (watching, completed, media search,
 * SaveMediaListEntry) share the same URL. */
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

/** Build a synthetic Nyaa RSS body from hit specs — mirrors parseRSS's exact
 * regex shapes (CDATA title, <link>, <nyaa:seeders>, <nyaa:infoHash>). Built
 * IN-TEST, never a committed fixture — see fixtures/PROVENANCE.md. */
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

/** Route nyaa.si RSS search calls, keyed by the exact `q` search term. A
 * query with no matching key is left unrouted (throws) — that is a signal
 * the test forgot to stub a fallback-chain search, not a silent empty. */
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

/** Route Transmission RPC calls, modeling the 409 X-Transmission-Session-Id
 * handshake on EVERY call (not just the first): each independent txRpc()
 * invocation starts with no session id, so a fresh 409+retry dance happens
 * per call — this stub's per-request header check reproduces that exactly. */
interface TxHandlers {
  torrentGet?: () => unknown[];
  torrentAdd?: (args: Record<string, unknown>) => unknown;
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
    return undefined;
  };
}

/** Route releases.moe SeaDex lookups, extracting the alID filter param. */
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

/** Single-route stub returning the same body/status to every call — for
 * simple pre-loop-failure error-path tests. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

// ---------------------------------------------------------------------------
// Deno.Command stub (sendTg only) — no-cast idiom, models spawn() ->
// stdin.getWriter() -> write() -> close() -> output() EXACTLY as sendTg uses
// it, so a wrongly-shaped stub cannot accidentally spawn the real swamp
// binary.
// ---------------------------------------------------------------------------

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
    stdinText: () => {
      const total = stdinChunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of stdinChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(merged);
    },
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

// ---------------------------------------------------------------------------
// fetch-airing
// ---------------------------------------------------------------------------

Deno.test("fetch-airing: happy path — pre-loaded Transmission dedup catches both shows' next episode, one fresh episode gets queued", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => anilistWatching }),
      // txTorrentGet's two torrents are named so extractShowTitle+parseEpisode
      // reproduce the exact showKey the pre-load existingSet uses:
      // "fixture chronicles::4" and "fixture wanderers::11".
      txRoute({
        torrentGet: () => txTorrentGet.arguments.torrents,
        torrentAdd: () => txTorrentAdd.arguments,
      }),
      // Entry 1 (Fixture Chronicles, progress 3, nextAiringEp 5 -> ep4 due):
      // a romaji hit for ep4 satisfies needsEp immediately, so no
      // english/synonym/base fallback search fires for this show.
      nyaaRoute({
        "Fixture Chronicles": [{
          title: "[SubsPlease] Fixture Chronicles - 04 [1080p].mkv",
          infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
        // Entry 2 (Fixture Wanderers, progress 10, episodes 12, finished
        // airing -> eps 11 and 12 due): one search returns hits for both.
        "Fixture Wanderers": [
          {
            title: "[Erai-raws] Fixture Wanderers - 11 [1080p].mkv",
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
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.checked, 2);
  assertEquals(res.payload.skipped, 0);
  assertEquals(
    res.payload.duplicates,
    2,
    "ep4 (Chronicles) and ep11 (Wanderers) both already exist in Transmission per the pre-load",
  );
  assertEquals(res.payload.queued, 1, "only ep12 (Wanderers) is genuinely new");
  assertEquals(res.payload.notFound, 0);
  const outcomes = res.payload.outcomes as Array<
    { episode: number; status: string; mediaId: number }
  >;
  assertEquals(
    outcomes.filter((o) => o.status === "queued").map((o) => o.episode),
    [12],
  );
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("fetch-airing: dryRun=true never touches Transmission at all (no torrent-get pre-load, no torrent-add)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => anilistWatching }),
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
      // Deliberately NO txRoute — a torrent-get/torrent-add call here would
      // throw "unrouted request", failing the test loudly.
    ],
    async (calls) => {
      await run("fetch-airing", { dryRun: true }, ctx);
      const txCalls = calls.filter((c) =>
        new URL(c.url).hostname === "tx.example.test"
      );
      assertEquals(txCalls.length, 0, "dryRun must never call Transmission");
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(
    res.payload.queued,
    3,
    "ep4 + ep11 + ep12 all queued as dry-run — dryRun sets existingTorrents=[] " +
      "unconditionally, so the pre-load dedup never runs at all in dry-run mode, " +
      "even though both eps 4 and 11 already exist in Transmission per the " +
      "happy-path fixture (a characteristic worth knowing, not a bug)",
  );
  assertEquals(
    res.payload.duplicates,
    0,
    "dry-run performs NO dedup check whatsoever",
  );
  const outcomes = res.payload.outcomes as Array<{ reason?: string }>;
  assert(
    outcomes.some((o) => o.reason === "dry-run"),
    "dry-run outcomes are tagged with reason 'dry-run'",
  );
});

Deno.test("fetch-airing: error path — a failing AniList watching-list read rejects the whole method, writes NO result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("fetch-airing", {}, ctx), Error);
  });
  assertEquals(written.find((w) => w.spec === "fetchResult"), undefined);
});

Deno.test("fetch-airing: a per-show Nyaa search failure is caught locally — one 'error'/'nyaa-fetch-failed' outcome, the run still completes and writes a result", async () => {
  const { ctx, written } = makeCtx();
  const nyaaAlways500: Route = (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "nyaa.si") return undefined;
    return new Response("nyaa down", { status: 500 });
  };
  await withFetchStub(
    [
      aniListRoute({ watching: () => anilistWatching }),
      txRoute({ torrentGet: () => [] }),
      nyaaAlways500,
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  const outcomes = res.payload.outcomes as Array<
    { status: string; reason?: string }
  >;
  assertEquals(
    outcomes.filter((o) => o.reason === "nyaa-fetch-failed").length,
    2,
  );
  assert(
    outcomes.every((o) => o.status === "error"),
    "a Nyaa failure aborts the WHOLE show as a single error outcome, not a per-episode one",
  );
});

Deno.test("fetch-airing: TG alert on a queued episode — Deno.Command spawned with the fixed vector, stdin carries the message, no credential leaks into args or stdin", async () => {
  const cmdStub = installSpawnCmdStub();
  const { ctx, written } = makeCtx({
    ...GLOBAL_ARGS,
    telegramModel: "tg-instance",
  });
  try {
    await withFetchStub(
      [
        aniListRoute({
          watching: () => ({
            data: {
              MediaListCollection: {
                lists: [{
                  entries: [{
                    progress: 3,
                    media: {
                      id: 200401,
                      title: { romaji: "Fixture Signal", english: null },
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
          }),
        }),
        txRoute({
          torrentGet: () => [],
          torrentAdd: () => txTorrentAdd.arguments,
        }),
        nyaaRoute({
          "Fixture Signal": [{
            title: "[SubsPlease] Fixture Signal - 04 [1080p].mkv",
            infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }],
        }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(cmdStub.invocations.length, 1);
  assertEquals(cmdStub.invocations[0].command, "swamp");
  assertEquals(cmdStub.invocations[0].args, [
    "model",
    "method",
    "run",
    "tg-instance",
    "sendMessage",
    "--stdin",
  ]);
  const stdinPayload = JSON.parse(cmdStub.stdinText());
  assert(String(stdinPayload.text).includes("Fixture Signal"));
  assertEquals(stdinPayload.parseMode, "HTML");
  assert(
    !cmdStub.stdinText().includes(SENTINEL_ANILIST_TOKEN),
    "stdin payload must never carry the AniList token",
  );
  assert(
    !cmdStub.stdinText().includes(SENTINEL_TX_PASS),
    "stdin payload must never carry the Transmission password",
  );
  for (const arg of cmdStub.invocations[0].args) {
    assert(
      !arg.includes(SENTINEL_ANILIST_TOKEN) && !arg.includes(SENTINEL_TX_PASS),
      `spawned arg "${arg}" must never carry a credential`,
    );
  }
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.queued, 1);
});

// ---------------------------------------------------------------------------
// mark-watched
// ---------------------------------------------------------------------------

const nowSec = () => Math.floor(Date.now() / 1000);

/** A Transmission torrent shaped like the committed fixture's first entry,
 * but with `doneDate` computed relative to the REAL current time — the
 * sinceHours window is evaluated against `Date.now()`, which a static
 * committed JSON fixture cannot represent correctly (see PROVENANCE.md). */
function recentTorrent(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    name: "[SubsPlease] Fixture Chronicles - 04 [1080p].mkv",
    status: 6,
    percentDone: 1,
    isFinished: true,
    doneDate: nowSec() - 3600,
    downloadDir: "/anime/tv/Fixture Chronicles",
    totalSize: 734003200,
    hashString: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...overrides,
  };
}

Deno.test("mark-watched: happy path — a recently completed torrent updates AniList progress", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      txRoute({ torrentGet: () => [recentTorrent()] }),
      aniListRoute({
        mediaSearch: () => anilistMediaSearch,
        saveEntry: () => anilistSaveEntry,
      }),
    ],
    async () => {
      await run("mark-watched", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "markResult")!;
  assertEquals(res.payload.checked, 1);
  assertEquals(res.payload.updated, 1);
  assertEquals(res.payload.failed, 0);
  const outcomes = res.payload.outcomes as Array<
    { updated: boolean; anilistId: number; episode: number }
  >;
  assertEquals(outcomes[0].updated, true);
  assertEquals(outcomes[0].anilistId, 200301);
  assertEquals(outcomes[0].episode, 4);
});

Deno.test("mark-watched: error path — no anilistToken and dryRun=false throws before any network call", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, anilistToken: undefined });
  await assertRejects(
    () => run("mark-watched", {}, ctx),
    Error,
    "anilistToken is required for mark-watched",
  );
});

Deno.test("mark-watched: error path — a failing Transmission torrent-get rejects the WHOLE method (unlike fetch-airing's swallowed pre-load)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("mark-watched", {}, ctx), Error);
  });
  assertEquals(written.find((w) => w.spec === "markResult"), undefined);
});

// ---------------------------------------------------------------------------
// upgrade-bd
// ---------------------------------------------------------------------------

Deno.test("upgrade-bd: happy path — a COMPLETED show above minScore with a SeaDex best release gets queued", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
      txRoute({ torrentAdd: () => txTorrentAdd.arguments }),
    ],
    async () => {
      await run("upgrade-bd", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(
    res.payload.checked,
    1,
    "only mediaId 200201 (score 82) clears the default minScore:70 filter — 200202 (score 55) never enters the SeaDex loop at all",
  );
  assertEquals(res.payload.queued, 1);
  assertEquals(res.payload.notInSeadex, 0);
  assertEquals(res.payload.skippedOnDisk, 0);
  const outcomes = res.payload.outcomes as Array<
    { mediaId: number; status: string; releaseGroup?: string }
  >;
  assertEquals(outcomes[0].mediaId, 200201);
  assertEquals(outcomes[0].status, "queued");
  assertEquals(outcomes[0].releaseGroup, "SubsPlease");
});

Deno.test("upgrade-bd: dryRun=true never calls Transmission", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
    ],
    async (calls) => {
      await run("upgrade-bd", { dryRun: true }, ctx);
      assertEquals(
        calls.filter((c) => new URL(c.url).hostname === "tx.example.test")
          .length,
        0,
      );
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.queued, 1);
});

Deno.test("upgrade-bd: error path — a failing AniList COMPLETED-list read rejects the whole method, writes NO result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("upgrade-bd", {}, ctx), Error);
  });
  assertEquals(written.find((w) => w.spec === "upgradeResult"), undefined);
});

// ---------------------------------------------------------------------------
// disk-stats
// ---------------------------------------------------------------------------

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

Deno.test("disk-stats: happy path — totals/byStatus/per-torrent rows computed from the Transmission torrent list", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [txRoute({ torrentGet: () => txTorrentGet.arguments.torrents })],
    async () => {
      await run("disk-stats", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "diskStats")!;
  const totalBytes = 734003200 + 900000000;
  const downloadedBytes = Math.floor(734003200 * 1) +
    Math.floor(900000000 * 0.42);
  const remainingBytes = totalBytes - downloadedBytes;
  assertEquals(res.payload.totalBytes, totalBytes);
  assertEquals(res.payload.downloadedBytes, downloadedBytes);
  assertEquals(res.payload.remainingBytes, remainingBytes);
  assertEquals(res.payload.totalGB, gb(totalBytes));
  assertEquals(res.payload.downloadedGB, gb(downloadedBytes));
  assertEquals(res.payload.remainingGB, gb(remainingBytes));
  const byStatus = res.payload.byStatus as Record<
    string,
    { count: number; bytes: number }
  >;
  assertEquals(byStatus["seeding"], { count: 1, bytes: 734003200 });
  assertEquals(byStatus["downloading"], { count: 1, bytes: 900000000 });
  const torrents = res.payload.torrents as Array<
    { name: string; status: string; percentDone: number }
  >;
  assertEquals(torrents.length, 2);
  assertEquals(torrents[0].status, "seeding");
  assertEquals(torrents[0].percentDone, 100);
  assertEquals(torrents[1].status, "downloading");
  assertEquals(torrents[1].percentDone, 42);
});

Deno.test("disk-stats: error path — a failing Transmission torrent-get rejects the whole method, writes NO result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("disk-stats", {}, ctx), Error);
  });
  assertEquals(written.find((w) => w.spec === "diskStats"), undefined);
});

// ---------------------------------------------------------------------------
// Credential-leak sweep across all four methods + the sendTg subprocess
// ---------------------------------------------------------------------------

Deno.test("neither anilistToken nor transmissionPass ever leaks into a written resource or a log call, across all four methods", async () => {
  const scenarios: Array<[string, Record<string, unknown>, Route[]]> = [
    [
      "fetch-airing",
      {},
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
          "Fixture Wanderers": [{
            title: "[SubsPlease] Fixture Wanderers - 11 [1080p].mkv",
            infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          }],
        }),
      ],
    ],
    [
      "mark-watched",
      {},
      [
        txRoute({ torrentGet: () => [recentTorrent()] }),
        aniListRoute({
          mediaSearch: () => anilistMediaSearch,
          saveEntry: () => anilistSaveEntry,
        }),
      ],
    ],
    [
      "upgrade-bd",
      {},
      [
        aniListRoute({ completed: () => anilistCompleted }),
        seadexRoute(() => seadexEntry),
        txRoute({ torrentAdd: () => txTorrentAdd.arguments }),
      ],
    ],
    [
      "disk-stats",
      {},
      [txRoute({ torrentGet: () => txTorrentGet.arguments.torrents })],
    ],
  ];
  for (const [name, args, routes] of scenarios) {
    const { ctx, written, logs } = makeCtx();
    await withFetchStub(routes, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(
        !s.includes(SENTINEL_ANILIST_TOKEN),
        `${name}: AniList token leaked into ${w.spec}`,
      );
      assert(
        !s.includes(SENTINEL_TX_PASS),
        `${name}: Transmission password leaked into ${w.spec}`,
      );
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(
        !s.includes(SENTINEL_ANILIST_TOKEN),
        `${name}: AniList token leaked into a log call`,
      );
      assert(
        !s.includes(SENTINEL_TX_PASS),
        `${name}: Transmission password leaked into a log call`,
      );
    }
  }
});

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withFetchStub(
    [txRoute({ torrentGet: () => txTorrentGet.arguments.torrents })],
    async () => {
      await run("disk-stats", {}, ctx);
    },
  );
  assertEquals(logs.length, 0);
});

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

Deno.test("sanity: model exposes exactly the 4 documented methods", () => {
  const methodNames = Object.keys(model.methods).sort();
  assertEquals(methodNames, [
    "disk-stats",
    "fetch-airing",
    "mark-watched",
    "upgrade-bd",
  ]);
});
