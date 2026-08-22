/**
 * Property-based tests (fast-check) for @magistr/anime-cron.
 *
 * Properties:
 *  (a) fetch-airing outcome-partition — stated PRECISELY per the round-1
 *      adversarial review finding: FetchResultSchema has NO error counter,
 *      so `queued + duplicates + notFound + skipped` does NOT generally
 *      equal `outcomes.length` (error-status outcomes are counted by none of
 *      the four fields). The property asserts each counter equals EXACTLY
 *      the count of outcomes carrying its matching status, never a naive sum.
 *  (b) pickBest's winner is invariant to input ORDER for any permutation of
 *      a non-tied candidate set (ties are skipped, not asserted either way).
 *  (c) fetch-airing dedup idempotency — feeding run-1's queued torrent names
 *      back as pre-existing Transmission entries makes run-2 all-duplicate.
 *  (d) disk-stats byte-level conservation — remainingBytes ==
 *      totalBytes - downloadedBytes EXACTLY. Stated at BYTES, not GB: the
 *      *GB fields are independently rounded (`gb(total) != gb(downloaded) +
 *      gb(remaining)` in general), per the round-1 adversarial finding.
 *  (e) buildMagnet injectivity over the canonical (non-collapsing) subset —
 *      infoHash constrained to 40 lowercase hex characters (so it can never
 *      contain the literal "&dn=" separator), title unconstrained.
 */
import fc from "npm:fast-check@4.8.0";
import {
  buildMagnet,
  groupScore,
  type NyaaHit,
  pickBest,
} from "./anime_cron.ts";
import { model } from "./anime_cron.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness (local copy)
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  anilistUser: "fixture-user",
  anilistToken: "property-fixture-anilist-token",
  transmissionRpcUrl: "http://tx.example.test:9091/transmission/rpc",
  transmissionUser: "fixture-tx-user",
  transmissionPass: "property-fixture-tx-pass",
  animeContainerDir: "/anime/tv",
  preferredResolution: 1080,
  telegramModel: "",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
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
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = stub;
  try {
    await fn();
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
}

function aniListRoute(handlers: AniListHandlers): Route {
  return async (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "graphql.anilist.co") return undefined;
    const body = await requestBody(req);
    const query = String(body.query ?? "");
    if (query.includes("status: CURRENT") && handlers.watching) {
      return json(handlers.watching());
    }
    return undefined;
  };
}

interface RssHitSpec {
  title: string;
  infoHash: string;
  seeders?: number;
}

function rss(hits: RssHitSpec[]): string {
  const items = hits.map((h, i) => {
    const link = `https://nyaa.si/view/${900000 + i}`;
    return `<item><title><![CDATA[${h.title}]]></title><link>${link}</link>` +
      `<nyaa:seeders>${h.seeders ?? 10}</nyaa:seeders>` +
      `<nyaa:infoHash>${h.infoHash}</nyaa:infoHash></item>`;
  }).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

interface TxHandlers {
  torrentGet?: () => unknown[];
  torrentAdd?: (args: Record<string, unknown>) => unknown;
}

function txRoute(handlers: TxHandlers): Route {
  return async (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "tx.example.test") return undefined;
    const gotSid = req.headers.get("X-Transmission-Session-Id");
    if (!gotSid) {
      return new Response("", {
        status: 409,
        headers: { "X-Transmission-Session-Id": "prop-fixture-sid" },
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

function hashFor(i: number): string {
  return (i.toString(16).padStart(4, "0") + "0".repeat(36)).slice(0, 40);
}

// ---------------------------------------------------------------------------
// (a) fetch-airing outcome-partition — PRECISE statement (no error counter)
// ---------------------------------------------------------------------------

type Kind =
  | "skip-unaired"
  | "all-downloaded"
  | "queued"
  | "duplicate"
  | "not-found"
  | "error";
const arbKind = fc.constantFrom<Kind>(
  "skip-unaired",
  "all-downloaded",
  "queued",
  "duplicate",
  "not-found",
  "error",
);

function buildEntry(id: number, kind: Kind) {
  // "ID<n>" (no whitespace before the digits) rather than a bare trailing
  // number — normalizeTitle's `.replace(/\s+\d+$/, "")` strips a
  // whitespace-then-digits suffix, which would collapse "Fixture Prop 1" and
  // "Fixture Prop 2" to the SAME normalized title ("fixture prop"). This is
  // the same class of normalization-collapse the porkbun/seanime property
  // suites found — restrict to the canonical non-collapsing subset instead.
  const title = `Fixture Prop ID${id}`;
  const base = {
    media: {
      id,
      title: { romaji: title, english: null },
      synonyms: [] as string[],
      episodes: 12,
    },
  };
  if (kind === "skip-unaired") {
    return {
      progress: 3, // startEp=4
      media: {
        ...base.media,
        status: "RELEASING",
        // nextAiringEp=4 -> lastAiredEp=3 < startEp(4) -> skip-unaired
        nextAiringEpisode: { episode: 4, airingAt: 0, timeUntilAiring: 0 },
      },
    };
  }
  if (kind === "all-downloaded") {
    return {
      progress: 12, // startEp=13 > episodes(12)
      media: { ...base.media, status: "FINISHED", nextAiringEpisode: null },
    };
  }
  // queued / duplicate / not-found / error all use the same startEp=4,
  // lastAiredEp=4 single-episode window.
  return {
    progress: 3,
    media: {
      ...base.media,
      status: "RELEASING",
      nextAiringEpisode: { episode: 5, airingAt: 0, timeUntilAiring: 0 },
    },
  };
}

Deno.test("property: fetch-airing's per-outcome status partition is EXACT — each counter equals exactly the count of outcomes with that status; error-status outcomes are counted by NONE of the four fields", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbKind, { minLength: 1, maxLength: 10 }),
      async (kinds) => {
        const entries = kinds.map((k, i) => buildEntry(500000 + i, k));
        const watching = {
          data: { MediaListCollection: { lists: [{ entries }] } },
        };
        const existing: unknown[] = [];
        const nyaaHandlers: Record<string, RssHitSpec[]> = {};
        const nyaaErrorTitles = new Set<string>();
        kinds.forEach((k, i) => {
          const title = `Fixture Prop ID${500000 + i}`;
          if (k === "queued") {
            nyaaHandlers[title] = [{
              title: `[SubsPlease] ${title} - 04 [1080p].mkv`,
              infoHash: hashFor(i),
            }];
          } else if (k === "duplicate") {
            nyaaHandlers[title] = [{
              title: `[SubsPlease] ${title} - 04 [1080p].mkv`,
              infoHash: hashFor(i),
            }];
            existing.push({
              id: i,
              name: `[SubsPlease] ${title} - 04 [1080p].mkv`,
              status: 6,
              percentDone: 1,
              isFinished: true,
              doneDate: 1000,
              downloadDir: "/anime/tv/x",
              totalSize: 100,
              hashString: hashFor(i),
            });
          } else if (k === "not-found") {
            nyaaHandlers[title] = [{
              title: `[SubsPlease] ${title} - 99 [1080p].mkv`,
              infoHash: hashFor(i),
            }];
          } else if (k === "error") {
            nyaaErrorTitles.add(title);
          }
        });
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [
            aniListRoute({ watching: () => watching }),
            txRoute({
              torrentGet: () => existing,
              torrentAdd: () => ({ "torrent-added": { id: 999, name: "x" } }),
            }),
            (req) => {
              const url = new URL(req.url);
              if (
                url.hostname !== "nyaa.si" ||
                url.searchParams.get("page") !== "rss"
              ) return undefined;
              const q = url.searchParams.get("q") ?? "";
              if (nyaaErrorTitles.has(q)) {
                return new Response("nyaa down", { status: 500 });
              }
              return new Response(rss(nyaaHandlers[q] ?? []), { status: 200 });
            },
          ],
          async () => {
            await run("fetch-airing", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "fetchResult")!;
        const outcomes = res.payload.outcomes as Array<{ status: string }>;
        const countOf = (s: string) =>
          outcomes.filter((o) => o.status === s).length;
        return (
          res.payload.checked === entries.length &&
          outcomes.length === entries.length &&
          res.payload.queued === countOf("queued") &&
          res.payload.duplicates === countOf("duplicate") &&
          res.payload.notFound === countOf("not-found") &&
          res.payload.skipped === countOf("skipped")
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) pickBest ordering/permutation-stability
// ---------------------------------------------------------------------------

interface HitSpec {
  group: string;
  seeders: number;
  resolution: number;
}

const arbHitSpec = fc.record({
  group: fc.constantFrom(
    "subsplease",
    "erai-raws",
    "ember",
    "asw",
    "judas",
    "unknown",
  ),
  seeders: fc.integer({ min: 0, max: 99 }),
  resolution: fc.constantFrom(2160, 1080, 720, 0),
});

function makeHitFromSpec(spec: HitSpec, idx: number): NyaaHit {
  return {
    title: `[${spec.group}] Show - 01 [placeholder].mkv`,
    viewUrl: `https://nyaa.si/view/${idx}`,
    magnet: `magnet:?xt=urn:btih:${hashFor(idx)}`,
    infoHash: hashFor(idx),
    seeders: spec.seeders,
    episode: 1,
    resolution: spec.resolution,
    sizeBytes: 1024 ** 3,
  };
}

function computeScore(h: NyaaHit, targetRes: number): number {
  return groupScore(h.title) * 10 + Math.min(h.seeders, 100) * 0.1 +
    (h.resolution === targetRes ? 5 : 0);
}

Deno.test("property: pickBest's winner is invariant to input ORDER for any permutation of a non-tied candidate set", () => {
  fc.assert(
    fc.property(
      fc.array(arbHitSpec, { minLength: 2, maxLength: 6 }),
      (specs) => {
        const hits = specs.map((s, i) => makeHitFromSpec(s, i));
        // pickBest applies a HARD resolution floor before ranking, so the
        // oracle must too — otherwise it nominates a winner pickBest already
        // discarded and the property fails for the wrong reason.
        const eligible = hits.filter((h) => h.resolution >= 1080);
        if (eligible.length === 0) return true;
        const scores = eligible.map((h) => computeScore(h, 1080));
        const maxScore = Math.max(...scores);
        if (scores.filter((s) => s === maxScore).length > 1) {
          return true; // tie — winner is order-dependent by design, skip
        }
        const winnerIdx = scores.indexOf(maxScore);
        const winnerHash = eligible[winnerIdx].infoHash;
        const forward = pickBest(hits, 1, 1080);
        const reversed = pickBest([...hits].reverse(), 1, 1080);
        return forward?.infoHash === winnerHash &&
          reversed?.infoHash === winnerHash;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) fetch-airing dedup idempotency — re-run all-duplicate
// ---------------------------------------------------------------------------

const arbUniqueIds = fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), {
  minLength: 1,
  maxLength: 6,
});

Deno.test("property: fetch-airing dedup idempotency — feeding run-1's queued torrent names back as existing Transmission entries makes run-2 all-duplicate", async () => {
  await fc.assert(
    fc.asyncProperty(arbUniqueIds, async (ids) => {
      const entries = ids.map((id) => buildEntry(id, "queued"));
      const watching = {
        data: { MediaListCollection: { lists: [{ entries }] } },
      };
      const nyaaHandlers: Record<string, RssHitSpec[]> = {};
      const torrentNames: Record<number, string> = {};
      ids.forEach((id, i) => {
        // "ID<n>" (no whitespace before the digits) rather than a bare trailing
        // number — normalizeTitle's `.replace(/\s+\d+$/, "")` strips a
        // whitespace-then-digits suffix, which would collapse "Fixture Prop 1" and
        // "Fixture Prop 2" to the SAME normalized title ("fixture prop"). This is
        // the same class of normalization-collapse the porkbun/seanime property
        // suites found — restrict to the canonical non-collapsing subset instead.
        const title = `Fixture Prop ID${id}`;
        const name = `[SubsPlease] ${title} - 04 [1080p].mkv`;
        torrentNames[id] = name;
        nyaaHandlers[title] = [{ title: name, infoHash: hashFor(i) }];
      });

      // Run 1: no existing torrents -> everything queued.
      const { ctx: ctx1, written: written1 } = makeCtx();
      await withFetchStub(
        [
          aniListRoute({ watching: () => watching }),
          txRoute({
            torrentGet: () => [],
            torrentAdd: () => ({ "torrent-added": { id: 1, name: "x" } }),
          }),
          (req) => {
            const url = new URL(req.url);
            if (
              url.hostname !== "nyaa.si" ||
              url.searchParams.get("page") !== "rss"
            ) return undefined;
            const q = url.searchParams.get("q") ?? "";
            return new Response(rss(nyaaHandlers[q] ?? []), { status: 200 });
          },
        ],
        async () => {
          await run("fetch-airing", {}, ctx1);
        },
      );
      const res1 = written1.find((w) => w.spec === "fetchResult")!;
      if (res1.payload.queued !== ids.length) return false;

      // Run 2: existing Transmission torrents now include every run-1 name.
      const existing = ids.map((id, i) => ({
        id: i,
        name: torrentNames[id],
        status: 6,
        percentDone: 1,
        isFinished: true,
        doneDate: 1000,
        downloadDir: "/anime/tv/x",
        totalSize: 100,
        hashString: hashFor(i),
      }));
      const { ctx: ctx2, written: written2 } = makeCtx();
      await withFetchStub(
        [
          aniListRoute({ watching: () => watching }),
          txRoute({ torrentGet: () => existing }),
          (req) => {
            const url = new URL(req.url);
            if (
              url.hostname !== "nyaa.si" ||
              url.searchParams.get("page") !== "rss"
            ) return undefined;
            const q = url.searchParams.get("q") ?? "";
            return new Response(rss(nyaaHandlers[q] ?? []), { status: 200 });
          },
        ],
        async () => {
          await run("fetch-airing", {}, ctx2);
        },
      );
      const res2 = written2.find((w) => w.spec === "fetchResult")!;
      return res2.payload.queued === 0 &&
        res2.payload.duplicates === ids.length;
    }),
    { numRuns: NIGHT(100) },
  );
});

// ---------------------------------------------------------------------------
// (d) disk-stats byte-level conservation
// ---------------------------------------------------------------------------

const arbDiskTorrent = fc.record({
  status: fc.integer({ min: 0, max: 8 }),
  percentDone: fc.float({
    min: Math.fround(0),
    max: Math.fround(1),
    noNaN: true,
  }),
  totalSize: fc.integer({ min: 0, max: 10_000_000_000 }),
});

Deno.test("property: disk-stats conserves bytes EXACTLY (remainingBytes == totalBytes - downloadedBytes) — the GB fields are independently rounded and do NOT generally sum this way", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbDiskTorrent, { minLength: 0, maxLength: 15 }),
      async (specs) => {
        const torrents = specs.map((s, i) => ({
          id: i,
          name: `t${i}`,
          status: s.status,
          percentDone: s.percentDone,
          isFinished: s.percentDone >= 1,
          doneDate: s.percentDone >= 1 ? 1000 : 0,
          downloadDir: "/anime/tv/x",
          totalSize: s.totalSize,
          hashString: hashFor(i),
        }));
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [txRoute({ torrentGet: () => torrents })],
          async () => {
            await run("disk-stats", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "diskStats")!;
        const total = res.payload.totalBytes as number;
        const downloaded = res.payload.downloadedBytes as number;
        const remaining = res.payload.remainingBytes as number;
        return remaining === total - downloaded;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) buildMagnet injectivity + determinism over the canonical subset
// ---------------------------------------------------------------------------

const arbHexHash = fc.stringMatching(/^[a-f0-9]{40}$/);
const arbTitle = fc.string({ minLength: 0, maxLength: 40 });
const arbMagnetInput = fc.tuple(arbHexHash, arbTitle);

Deno.test("property: buildMagnet is deterministic — same input always produces the same magnet URI", () => {
  fc.assert(
    fc.property(arbMagnetInput, ([hash, title]) => {
      return buildMagnet(hash, title) === buildMagnet(hash, title);
    }),
    FC_RUNS,
  );
});

Deno.test("property: buildMagnet is INJECTIVE over (infoHash, title) pairs when infoHash is constrained to the canonical 40-hex-char shape", () => {
  fc.assert(
    fc.property(
      arbMagnetInput,
      arbMagnetInput,
      ([hashA, titleA], [hashB, titleB]) => {
        const magnetA = buildMagnet(hashA, titleA);
        const magnetB = buildMagnet(hashB, titleB);
        const sameInput = hashA === hashB && titleA === titleB;
        return sameInput ? magnetA === magnetB : magnetA !== magnetB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});
