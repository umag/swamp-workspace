/**
 * Coverage suite: sweeps both sides of every guard in anime_cron.ts that the
 * methods and adversarial suites don't already exercise on BOTH sides, so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * Covers: skipUnaired (both sides, including the "no outcome at all" side
 * effect), the all-eps-downloaded boundary, existingSet dedup hit/miss,
 * mark-watched's no-token-throw vs dryRun-bypass, the sinceHours doneDate
 * window boundary, the downloadDir.startsWith prefix-match quirk (pinned,
 * NOT fixed — see the local anime-cron-accounting-quirks bug model),
 * mark-watched's could-not-parse-episode NOT incrementing `failed` (the same
 * bug model), upgrade-bd's on-disk-skip vs different-release-group
 * fallthrough, the unknown-Transmission-status "status-N" fallback label,
 * an empty torrent list, and the 30-minute overdue-alert grace boundary.
 *
 * anime_cron.ts is UNMODIFIED; every test PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cacheAgeSeconds,
  model,
  projectEntry,
  seedEntriesFromOutcomes,
} from "./anime_cron.ts";
import anilistCompleted from "../../fixtures/anilist-completed.json" with {
  type: "json",
};
import seadexEntry from "../../fixtures/seadex-entry.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness (local copy)
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  anilistUser: "fixture-user",
  anilistToken: "coverage-fixture-anilist-token",
  transmissionRpcUrl: "http://tx.example.test:9091/transmission/rpc",
  transmissionUser: "fixture-tx-user",
  transmissionPass: "coverage-fixture-tx-pass",
  animeContainerDir: "/anime/tv",
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

function installSpawnCmdStub() {
  const invocations: Invocation[] = [];
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
      return {
        stdin: {
          getWriter: () => ({
            write: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () =>
          Promise.resolve({
            success: true,
            code: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          }),
      };
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

function watchingWith(entry: Record<string, unknown>) {
  return { data: { MediaListCollection: { lists: [{ entries: [entry] }] } } };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Guard: skipUnaired — both sides, plus the "no outcome at all" side effect
// ---------------------------------------------------------------------------

Deno.test("skipUnaired=true (default): an unaired show is skipped with reason 'airs-in-Nh'", async () => {
  const entry = {
    progress: 3,
    media: {
      id: 300001,
      title: { romaji: "Fixture Skip", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: {
        episode: 4,
        airingAt: nowSec() + 3600,
        timeUntilAiring: 3600,
      },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => watchingWith(entry) }),
      txRoute({ torrentGet: () => [] }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.skipped, 1);
  const outcomes = res.payload.outcomes as Array<
    { status: string; reason?: string }
  >;
  assertEquals(outcomes[0].status, "skipped");
  assert(outcomes[0].reason?.startsWith("airs-in-"));
});

Deno.test("skipUnaired=false: an unaired show produces NO outcome at all — not a 'skipped' record, not a 'not-found' one either", async () => {
  // The skip-check is bypassed entirely, but the per-episode loop's range
  // (startEp..lastAiredEp) is EMPTY when the show hasn't aired yet (startEp >
  // lastAiredEp), so the for-loop body never executes even once — the show
  // contributes zero outcomes, a subtle characteristic worth pinning.
  const entry = {
    progress: 3,
    media: {
      id: 300002,
      title: { romaji: "Fixture NoSkip", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: {
        episode: 4,
        airingAt: nowSec() + 3600,
        timeUntilAiring: 3600,
      },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => watchingWith(entry) }),
      txRoute({ torrentGet: () => [] }),
      nyaaRoute({ "Fixture NoSkip": [] }),
    ],
    async () => {
      await run("fetch-airing", { skipUnaired: false }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.skipped, 0);
  assertEquals(res.payload.queued, 0);
  assertEquals(res.payload.notFound, 0);
  assertEquals(
    (res.payload.outcomes as unknown[]).length,
    0,
    "an unaired show with skipUnaired:false contributes NO outcome record",
  );
});

// ---------------------------------------------------------------------------
// Guard: all-eps-downloaded boundary (startEp > episodes)
// ---------------------------------------------------------------------------

Deno.test("all-eps-downloaded: startEp > episodes -> skipped 'all-eps-downloaded'", async () => {
  const entry = {
    progress: 12, // startEp = 13 > episodes(12)
    media: {
      id: 300003,
      title: { romaji: "Fixture Done", english: null },
      synonyms: [],
      episodes: 12,
      status: "FINISHED",
      nextAiringEpisode: null,
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => watchingWith(entry) }),
      txRoute({ torrentGet: () => [] }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  const outcomes = res.payload.outcomes as Array<
    { status: string; reason?: string }
  >;
  assertEquals(outcomes[0].status, "skipped");
  assertEquals(outcomes[0].reason, "all-eps-downloaded");
});

Deno.test("boundary: startEp == episodes does NOT trigger all-eps-downloaded — the final episode is still processed", async () => {
  const entry = {
    progress: 11, // startEp = 12 == episodes(12)
    media: {
      id: 300004,
      title: { romaji: "Fixture Final", english: null },
      synonyms: [],
      episodes: 12,
      status: "FINISHED",
      nextAiringEpisode: null,
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => watchingWith(entry) }),
      txRoute({ torrentGet: () => [] }),
      nyaaRoute({ "Fixture Final": [] }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  const outcomes = res.payload.outcomes as Array<
    { status: string; episode: number }
  >;
  assertEquals(outcomes.length, 1);
  assertEquals(outcomes[0].episode, 12);
  assertEquals(
    outcomes[0].status,
    "not-found",
    "ep12 IS attempted, just has no Nyaa hit",
  );
});

// ---------------------------------------------------------------------------
// Guard: existingSet dedup — hit vs miss, isolated from the full pipeline
// ---------------------------------------------------------------------------

Deno.test("dedup: a pre-loaded Transmission torrent whose (normalized title, episode) matches is a 'duplicate'", async () => {
  const entry = {
    progress: 3, // startEp = 4
    media: {
      id: 300005,
      title: { romaji: "Fixture Dedup", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: {
        episode: 5,
        airingAt: nowSec() + 3600,
        timeUntilAiring: 3600,
      },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => watchingWith(entry) }),
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "[SubsPlease] Fixture Dedup - 04 [1080p].mkv",
          status: 6,
          percentDone: 1,
          isFinished: true,
          doneDate: nowSec() - 3600,
          downloadDir: "/anime/tv/Fixture Dedup",
          totalSize: 100,
          hashString: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
      }),
      nyaaRoute({
        "Fixture Dedup": [{
          title: "[SubsPlease] Fixture Dedup - 04 [1080p].mkv",
          infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
});

Deno.test("dedup: a DIFFERENT existing torrent (unrelated show) does not suppress a genuinely new episode", async () => {
  const entry = {
    progress: 3,
    media: {
      id: 300006,
      title: { romaji: "Fixture Miss", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: {
        episode: 5,
        airingAt: nowSec() + 3600,
        timeUntilAiring: 3600,
      },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ watching: () => watchingWith(entry) }),
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "[SubsPlease] Some Other Show - 04 [1080p].mkv",
          status: 6,
          percentDone: 1,
          isFinished: true,
          doneDate: nowSec() - 3600,
          downloadDir: "/anime/tv/Some Other Show",
          totalSize: 100,
          hashString: "cccccccccccccccccccccccccccccccccccccccc",
        }],
        torrentAdd: () => ({ "torrent-added": { id: 2, name: "queued" } }),
      }),
      nyaaRoute({
        "Fixture Miss": [{
          title: "[SubsPlease] Fixture Miss - 04 [1080p].mkv",
          infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
      }),
    ],
    async () => {
      await run("fetch-airing", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "fetchResult")!;
  assertEquals(res.payload.duplicates, 0);
  assertEquals(res.payload.queued, 1);
});

// ---------------------------------------------------------------------------
// mark-watched: no-token-throw vs dryRun-bypass — both sides of the guard
// ---------------------------------------------------------------------------

Deno.test("mark-watched guard: no anilistToken + dryRun=true BYPASSES the throw entirely", async () => {
  const { ctx, written } = makeCtx({ ...GLOBAL_ARGS, anilistToken: undefined });
  await withFetchStub(
    [txRoute({ torrentGet: () => [] })],
    async () => {
      await run("mark-watched", { dryRun: true }, ctx);
    },
  );
  assert(
    written.find((w) => w.spec === "markResult"),
    "dryRun bypasses the token guard and completes normally",
  );
});

// ---------------------------------------------------------------------------
// mark-watched: could-not-parse-episode does NOT increment `failed`
// (pinned characterization — see the local anime-cron-accounting-quirks
// bug model; source is byte-frozen, this is deliberately not "fixed")
// ---------------------------------------------------------------------------

Deno.test("pin: mark-watched's could-not-parse-episode branch increments NEITHER updated NOR failed — checked can exceed updated+failed", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [txRoute({
      torrentGet: () => [{
        id: 1,
        name: "no-parseable-episode-number-here.mkv",
        status: 6,
        percentDone: 1,
        isFinished: true,
        doneDate: nowSec() - 3600,
        downloadDir: "/anime/tv/Unparseable",
        totalSize: 100,
        hashString: "dddddddddddddddddddddddddddddddddddddddd",
      }],
    })],
    async () => {
      await run("mark-watched", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "markResult")!;
  assertEquals(res.payload.checked, 1);
  assertEquals(res.payload.updated, 0);
  assertEquals(
    res.payload.failed,
    0,
    "the accounting quirk: an unparseable-episode torrent is counted in " +
      "`checked` but in NEITHER `updated` NOR `failed` — checked can exceed " +
      "updated+failed (tracked in the local anime-cron-accounting-quirks bug model)",
  );
  const outcomes = res.payload.outcomes as Array<
    { updated: boolean; reason?: string; episode: number | null }
  >;
  assertEquals(outcomes[0].reason, "could-not-parse-episode");
  assertEquals(outcomes[0].updated, false);
  assertEquals(outcomes[0].episode, null);
});

// ---------------------------------------------------------------------------
// mark-watched: sinceHours doneDate window boundary
// ---------------------------------------------------------------------------

Deno.test("sinceHours window: a torrent done just INSIDE the window is included", async () => {
  const sinceHours = 25;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "no-episode-marker-for-simplicity.mkv",
          status: 6,
          percentDone: 1,
          isFinished: true,
          doneDate: nowSec() - (sinceHours * 3600 - 5),
          downloadDir: "/anime/tv/Boundary",
          totalSize: 100,
          hashString: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        }],
      }),
    ],
    async () => {
      await run("mark-watched", { sinceHours }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "markResult")!;
  assertEquals(res.payload.checked, 1);
});

Deno.test("sinceHours window: a torrent done EXACTLY at the window edge is EXCLUDED (strict less-than, not less-or-equal)", async () => {
  const sinceHours = 25;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "no-episode-marker-for-simplicity.mkv",
          status: 6,
          percentDone: 1,
          isFinished: true,
          doneDate: nowSec() - sinceHours * 3600,
          downloadDir: "/anime/tv/Boundary",
          totalSize: 100,
          hashString: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        }],
      }),
    ],
    async () => {
      await run("mark-watched", { sinceHours }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "markResult")!;
  assertEquals(res.payload.checked, 0);
});

// ---------------------------------------------------------------------------
// pin: downloadDir.startsWith(prefix) has no path-separator boundary check
// (tracked in the local anime-cron-accounting-quirks bug model)
// ---------------------------------------------------------------------------

Deno.test("pin: a sibling directory /anime/tv-extra spuriously matches the configured prefix /anime/tv (naive startsWith, no separator boundary)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "[SubsPlease] Fixture Sibling - 01 [1080p].mkv",
          status: 6,
          percentDone: 1,
          isFinished: true,
          doneDate: nowSec() - 3600,
          downloadDir: "/anime/tv-extra/Fixture Sibling",
          totalSize: 500,
          hashString: "ffffffffffffffffffffffffffffffffffffffff",
        }],
      }),
    ],
    async () => {
      await run("disk-stats", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "diskStats")!;
  assertEquals(
    (res.payload.torrents as unknown[]).length,
    1,
    "/anime/tv-extra/... spuriously counts toward the /anime/tv prefix filter",
  );
});

// ---------------------------------------------------------------------------
// upgrade-bd: on-disk skip vs different-release-group fallthrough
// ---------------------------------------------------------------------------

Deno.test("upgrade-bd: library already has the SAME release group (lowercase) as SeaDex's best -> skippedOnDisk, no queue", async () => {
  // seadexGroup is compared as `best.releaseGroup?.toLowerCase()`, but
  // libraryGroup is used AS-IS (not lowercased) — the caller's library scan
  // must already supply a lowercase releaseGroup for this guard to ever
  // match. See the sibling "case-sensitivity asymmetry" pin below.
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
    ],
    async () => {
      await run("upgrade-bd", {
        libraryEntries: [{ anilistId: 200201, releaseGroup: "subsplease" }],
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.skippedOnDisk, 1);
  assertEquals(res.payload.queued, 0);
  const outcomes = res.payload.outcomes as Array<{ status: string }>;
  assertEquals(outcomes[0].status, "on-disk");
});

Deno.test("pin: case-sensitivity asymmetry — a library releaseGroup of 'SubsPlease' (same group, mixed case) does NOT match SeaDex's lowercased 'subsplease' and falls through to re-queue", async () => {
  // Only seadexGroup is lowercased (`best.releaseGroup?.toLowerCase()`);
  // libraryGroup is compared verbatim. A library scan that stores release
  // groups in their original mixed case (as SeaDex/Nyaa titles do) can never
  // satisfy this guard, so upgrade-bd re-queues a show it already has on
  // disk under the "correct" release group. Documented gap, not fixed here
  // (anime_cron.ts is byte-frozen).
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
      txRoute({
        torrentAdd: () => ({ "torrent-added": { id: 9, name: "queued" } }),
      }),
    ],
    async () => {
      await run("upgrade-bd", {
        libraryEntries: [{ anilistId: 200201, releaseGroup: "SubsPlease" }],
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(
    res.payload.skippedOnDisk,
    0,
    "mixed-case 'SubsPlease' never equals lowercased 'subsplease' -> the on-disk guard never fires",
  );
  assertEquals(res.payload.queued, 1, "falls through and re-queues instead");
});

Deno.test("upgrade-bd: library has a DIFFERENT release group than SeaDex's best -> falls through to queue anyway", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      aniListRoute({ completed: () => anilistCompleted }),
      seadexRoute(() => seadexEntry),
      txRoute({
        torrentAdd: () => ({ "torrent-added": { id: 9, name: "queued" } }),
      }),
    ],
    async () => {
      await run("upgrade-bd", {
        libraryEntries: [{ anilistId: 200201, releaseGroup: "Judas" }],
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "upgradeResult")!;
  assertEquals(res.payload.skippedOnDisk, 0);
  assertEquals(res.payload.queued, 1);
});

// ---------------------------------------------------------------------------
// disk-stats: unknown Transmission status -> "status-N" fallback label
// ---------------------------------------------------------------------------

Deno.test("disk-stats: a status code outside TX_STATUS's 0-6 map falls back to 'status-N'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      txRoute({
        torrentGet: () => [{
          id: 1,
          name: "[SubsPlease] Fixture Unknown - 01 [1080p].mkv",
          status: 99,
          percentDone: 0.1,
          isFinished: false,
          doneDate: 0,
          downloadDir: "/anime/tv/Fixture Unknown",
          totalSize: 1000,
          hashString: "1111111111111111111111111111111111111111",
        }],
      }),
    ],
    async () => {
      await run("disk-stats", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "diskStats")!;
  const byStatus = res.payload.byStatus as Record<string, unknown>;
  assert(
    "status-99" in byStatus,
    "unknown status 99 falls back to the label 'status-99'",
  );
});

// ---------------------------------------------------------------------------
// disk-stats: empty torrent list
// ---------------------------------------------------------------------------

Deno.test("disk-stats: an empty Transmission torrent list yields all-zero totals and empty collections", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([txRoute({ torrentGet: () => [] })], async () => {
    await run("disk-stats", {}, ctx);
  });
  const res = written.find((w) => w.spec === "diskStats")!;
  assertEquals(res.payload.totalBytes, 0);
  assertEquals(res.payload.downloadedBytes, 0);
  assertEquals(res.payload.remainingBytes, 0);
  assertEquals(res.payload.byStatus, {});
  assertEquals(res.payload.torrents, []);
});

// ---------------------------------------------------------------------------
// fetch-airing: 30-minute overdue-alert grace boundary
// ---------------------------------------------------------------------------

function overdueEntry(secondsAgoAired: number) {
  const airedAtSec = nowSec() - secondsAgoAired;
  const nextAiringAt = airedAtSec + 7 * 24 * 3600; // + WEEK_SECS
  return {
    progress: 3, // startEp = 4 = lastAiredEp (nextAiringEp=5)
    media: {
      id: 300007,
      title: { romaji: "Fixture Overdue", english: null },
      synonyms: [],
      episodes: 12,
      status: "RELEASING",
      nextAiringEpisode: {
        episode: 5,
        airingAt: nextAiringAt,
        timeUntilAiring: 3600,
      },
    },
  };
}

Deno.test("overdue grace: aired 16 minutes ago (< 30min grace) -> NOT overdue, no TG alert sent", async () => {
  const cmdStub = installSpawnCmdStub();
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, telegramModel: "tg-instance" });
  try {
    await withFetchStub(
      [
        aniListRoute({ watching: () => watchingWith(overdueEntry(16 * 60)) }),
        txRoute({ torrentGet: () => [] }),
        nyaaRoute({ "Fixture Overdue": [] }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(
    cmdStub.invocations.length,
    0,
    "under the 30-minute grace period -> no alert",
  );
});

Deno.test("overdue grace: aired 34 minutes ago (> 30min grace) -> OVERDUE, TG alert sent", async () => {
  const cmdStub = installSpawnCmdStub();
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, telegramModel: "tg-instance" });
  try {
    await withFetchStub(
      [
        aniListRoute({ watching: () => watchingWith(overdueEntry(34 * 60)) }),
        txRoute({ torrentGet: () => [] }),
        nyaaRoute({ "Fixture Overdue": [] }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(
    cmdStub.invocations.length,
    1,
    "past the 30-minute grace period -> one alert",
  );
});

Deno.test("overdue grace: no nextAiringEp/nextAiringAt at all (episodes-fallback path) -> airedAtSec is null -> ALWAYS overdue", async () => {
  const entry = {
    progress: 11, // startEp = 12 = lastAiredEp (episodes fallback, finished airing)
    media: {
      id: 300008,
      title: { romaji: "Fixture Finished Overdue", english: null },
      synonyms: [],
      episodes: 12,
      status: "FINISHED",
      nextAiringEpisode: null,
    },
  };
  const cmdStub = installSpawnCmdStub();
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, telegramModel: "tg-instance" });
  try {
    await withFetchStub(
      [
        aniListRoute({ watching: () => watchingWith(entry) }),
        txRoute({ torrentGet: () => [] }),
        nyaaRoute({ "Fixture Finished Overdue": [] }),
      ],
      async () => {
        await run("fetch-airing", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(
    cmdStub.invocations.length,
    1,
    "airedAtSec==null unconditionally counts as overdue",
  );
});

// ─── watchlist cache / airing projection ──────────────────────────────────────
// The consumer derives `lastAiredEp = nextAiringEp - 1`, so every off-by-one
// here is either a missed episode or a download of something not yet aired.

Deno.test("projection: at the exact airing instant, that episode counts as aired", () => {
  const at = 1_700_000_000;
  const e = { episodes: 12, nextAiringEp: 5, nextAiringAt: at };
  const p = projectEntry(e, at);
  // nextAiringEp becomes 6, so lastAiredEp = 5 = the episode that just aired.
  assertEquals(p.nextAiringEp, 6);
});

Deno.test("projection: before the airing instant nothing changes", () => {
  const at = 1_700_000_000;
  const e = { episodes: 12, nextAiringEp: 5, nextAiringAt: at };
  assertEquals(projectEntry(e, at - 1).nextAiringEp, 5);
  assertEquals(projectEntry(e, at - 86400).nextAiringAt, at);
});

Deno.test("projection: six days later is still one episode, eight days is two", () => {
  const at = 1_700_000_000;
  const e = { episodes: 24, nextAiringEp: 5, nextAiringAt: at };
  assertEquals(projectEntry(e, at + 6 * 86400).nextAiringEp, 6);
  assertEquals(projectEntry(e, at + 8 * 86400).nextAiringEp, 7);
  assertEquals(projectEntry(e, at + 21 * 86400).nextAiringEp, 9);
});

Deno.test("projection: never runs past the end of the season", () => {
  const at = 1_700_000_000;
  const e = { episodes: 12, nextAiringEp: 11, nextAiringAt: at };
  // A year later it must still stop at 12 aired, not invent episode 60.
  const p = projectEntry(e, at + 365 * 86400);
  assertEquals(p.nextAiringEp, 13);
  assertEquals((p.nextAiringEp as number) - 1, 12);
});

Deno.test("projection: an entry with no airing data is returned untouched", () => {
  const e = { episodes: 12, nextAiringEp: null, nextAiringAt: null };
  assertEquals(projectEntry(e, 1_700_000_000), e);
  const e2 = { episodes: null, nextAiringEp: 3, nextAiringAt: null };
  assertEquals(projectEntry(e2, 1_700_000_000), e2);
});

Deno.test("projection: an unknown episode count is projected without a ceiling", () => {
  const at = 1_700_000_000;
  const e = { episodes: null, nextAiringEp: 5, nextAiringAt: at };
  assertEquals(projectEntry(e, at + 14 * 86400).nextAiringEp, 8);
});

Deno.test("projection: a zero or negative week cannot divide by zero or loop", () => {
  const at = 1_700_000_000;
  const e = { episodes: 12, nextAiringEp: 5, nextAiringAt: at };
  assertEquals(projectEntry(e, at + 86400, 0).nextAiringEp, 5);
  assertEquals(projectEntry(e, at + 86400, -7).nextAiringEp, 5);
});

Deno.test("cacheAgeSeconds: unparseable capture time is infinitely old", () => {
  // Must be Infinity, not 0 or NaN: a NaN comparison is false, so a corrupt
  // timestamp would silently pass the max-age guard and be used forever.
  assertEquals(cacheAgeSeconds("not a date", 1_700_000_000), Infinity);
  assertEquals(
    cacheAgeSeconds(
      new Date(1_699_999_000 * 1000).toISOString(),
      1_700_000_000,
    ),
    1000,
  );
});

// ─── seed-watchlist ───────────────────────────────────────────────────────────

Deno.test("seed: duplicate means we HAVE that episode, anything else means we do not", () => {
  const [e] = seedEntriesFromOutcomes(
    [{ mediaId: 1, title: "S", episode: 8, status: "duplicate" }],
    1_700_000_000,
  );
  assertEquals(e.progress, 8);
  const [s] = seedEntriesFromOutcomes(
    [{ mediaId: 1, title: "S", episode: 8, status: "skipped" }],
    1_700_000_000,
  );
  // skipped = not yet aired, so episode 8 is still owed.
  assertEquals(s.progress, 7);
});

Deno.test("seed: a show with several outcomes collapses to its furthest episode", () => {
  // Real data: Tenmaku no Jaadugar appeared three times as duplicate 6, 7, 8.
  const out = seedEntriesFromOutcomes([
    {
      mediaId: 190569,
      title: "Tenmaku no Jaadugar",
      episode: 6,
      status: "duplicate",
    },
    {
      mediaId: 190569,
      title: "Tenmaku no Jaadugar",
      episode: 8,
      status: "duplicate",
    },
    {
      mediaId: 190569,
      title: "Tenmaku no Jaadugar",
      episode: 7,
      status: "duplicate",
    },
  ], 1_700_000_000);
  assertEquals(out.length, 1);
  assertEquals(out[0].progress, 8);
  assertEquals(out[0].nextAiringEp, 9);
});

Deno.test("seed: episodes total is left null rather than guessed", () => {
  // A wrong total either caps projection early or trips the
  // all-eps-downloaded skip on a show that is still airing.
  const [e] = seedEntriesFromOutcomes(
    [{ mediaId: 1, title: "S", episode: 3, status: "skipped" }],
    1_700_000_000,
  );
  assertEquals(e.episodes, null);
  assertEquals(e.mediaStatus, "RELEASING");
});

Deno.test("seed: nextAiringEp is always one past progress, so the owed episode is fetched", () => {
  for (const status of ["duplicate", "skipped", "not-found", "queued"]) {
    const [e] = seedEntriesFromOutcomes(
      [{ mediaId: 1, title: "S", episode: 5, status }],
      1_700_000_000,
    );
    assertEquals(e.nextAiringEp, e.progress + 1, `status=${status}`);
  }
});

Deno.test("seed: malformed outcomes are dropped, not turned into episode 0 entries", () => {
  const out = seedEntriesFromOutcomes(
    [
      { mediaId: 1, title: "ok", episode: 4, status: "skipped" },
      { mediaId: 2, title: "bad", episode: 0, status: "skipped" },
      { mediaId: 3, title: "nan", episode: NaN, status: "skipped" },
    ],
    1_700_000_000,
  );
  assertEquals(out.map((e) => e.mediaId), [1]);
});

Deno.test("seed: progress never goes negative", () => {
  const [e] = seedEntriesFromOutcomes(
    [{ mediaId: 1, title: "S", episode: 1, status: "skipped" }],
    1_700_000_000,
  );
  assertEquals(e.progress, 0);
  assertEquals(e.nextAiringEp, 1);
});

Deno.test("seed: a seeded cache projected forward one week owes the next episode too", () => {
  const at = 1_700_000_000;
  const [e] = seedEntriesFromOutcomes(
    [{ mediaId: 1, title: "S", episode: 8, status: "duplicate" }],
    at,
  );
  // Same day: episode 9 is owed. Eight days on: 9 and 10.
  assertEquals((projectEntry(e, at).nextAiringEp as number) - 1, 9);
  assertEquals(
    (projectEntry(e, at + 8 * 86400).nextAiringEp as number) - 1,
    10,
  );
});
