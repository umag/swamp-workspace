/**
 * Contract-fixture suite: pins the CONCRETE wire shape of BOTH upstream
 * contracts `@magistr/seadex` speaks — the releases.moe Pocketbase list
 * envelope (`page`/`perPage`/`totalItems`/`totalPages`/`items[]` with
 * `expand.trs`) and the public AniList GraphQL envelope
 * (`{data:{Media}}` / `{errors,data:null}`) — directly from
 * `seadex/fixtures/*.json`, independent of the model's resource schemas.
 * seadex.ts never zod-parses raw upstream payloads (`fetchJson`/`resp.json()`
 * casts are trusted, not validated), so a suite that only asserted "the
 * written resource validates against SeadexResultSchema" would be toothless —
 * this suite hardcodes the expected keyset/value-types from the fixtures
 * directly (see STANDARD.md's contract-fixture role).
 *
 * Also pins the normalised-entry transform: isBest split into
 * bestReleases/alternativeReleases, totalSizeBytes summed from files[],
 * primaryFile picked by argmax(length), comparisonUrls split/trimmed from a
 * comma-joined string, and infoHash passed through byte-for-byte verbatim
 * (no case normalization — see PROVENANCE.md's entropy-escape note on why the
 * fixture's infoHash placeholders are low-entropy repeated characters).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made. seadex.ts is UNMODIFIED by this change — every test
 * here characterizes already-shipped behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./seadex.ts";
import pocketbaseEntry from "../../fixtures/pocketbase-entry.json" with {
  type: "json",
};
import pocketbaseEmpty from "../../fixtures/pocketbase-empty.json" with {
  type: "json",
};
import anilistMedia from "../../fixtures/anilist-media.json" with {
  type: "json",
};
import anilistNomatch from "../../fixtures/anilist-nomatch.json" with {
  type: "json",
};
import anilistGraphqlError from "../../fixtures/anilist-graphql-error.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://releases.moe",
  userAgent: "swamp-seadex-fixture/1.0",
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Cast via the UNKNOWN-BRIDGE (as unknown as typeof globalThis.fetch) per the
 * plan's toolchain note — never the direct `as typeof globalThis.fetch`
 * porkbun used. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
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

/** Route matching the Pocketbase `entries/records` list endpoint only. */
function pocketbaseRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/collections/entries/records"
      ? json(body, status)
      : undefined;
  };
}

/** Route matching the AniList GraphQL endpoint only. */
function anilistRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.hostname === "graphql.anilist.co"
      ? json(body, status)
      : undefined;
  };
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

// ---------------------------------------------------------------------------
// pocketbase-entry.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: pocketbase-entry.json — list envelope pinned, isBest split, totalSizeBytes summed, primaryFile argmax, comparisonUrls split+trimmed, infoHash verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pocketbaseEntry)],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "entry" && w.name === "al-1")!;
  assert(res, "expected a written entry keyed al-1");
  assertEquals(res.payload.found, true);
  assertEquals(res.payload.alID, 1);
  assertEquals(
    res.payload.notes,
    "Fixture notes: BD encode preferred once a batch is available.",
  );
  assertEquals(
    res.payload.theoreticalBest,
    "[Fixture-Raws] Fixture Voyager (BD 1080p)",
  );
  assertEquals(res.payload.incomplete, false);
  assertEquals(res.payload.comparisonUrls, [
    "https://slow.pics.example/c/fixtureVoyagerA",
    "https://slow.pics.example/c/fixtureVoyagerB",
  ]);
  assertEquals(res.payload.sourceUrl, "https://releases.moe/1");
  assert(typeof res.payload.timestamp === "string");

  const best = res.payload.bestReleases as Array<Record<string, unknown>>;
  const alt = res.payload.alternativeReleases as Array<Record<string, unknown>>;
  assertEquals(best.length, 1, "exactly 1 isBest:true torrent");
  assertEquals(alt.length, 1, "exactly 1 isBest:false torrent");

  assertEquals(best[0].releaseGroup, "SubsPlease");
  assertEquals(best[0].tracker, "Nyaa");
  assertEquals(
    best[0].infoHash,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "infoHash passed through verbatim, no case/format normalization",
  );
  assertEquals(best[0].dualAudio, false);
  assertEquals(best[0].tags, ["1080p", "AAC"]);
  assertEquals(best[0].fileCount, 2);
  assertEquals(best[0].totalSizeBytes, 734003200 + 728400000);
  assertEquals(
    best[0].primaryFile,
    "Fixture Voyager - 01 (1080p) [aaaaaaaa].mkv",
    "primaryFile is the argmax(length) file — 734003200 > 728400000",
  );

  assertEquals(alt[0].releaseGroup, "Judas");
  assertEquals(alt[0].tracker, "AnimeBytes");
  assertEquals(
    alt[0].infoHash,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assertEquals(alt[0].dualAudio, true);
  assertEquals(alt[0].fileCount, 1);
  assertEquals(alt[0].totalSizeBytes, 367000000);
  assertEquals(
    alt[0].primaryFile,
    "Fixture Voyager - 01 (720p) [bbbbbbbb].mkv",
  );
});

Deno.test("contract: lookup-by-anilist-id — Pocketbase request URL/headers pinned exactly", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pocketbaseEntry)],
    async (calls) => {
      await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
      assertEquals(
        calls[0].url,
        "https://releases.moe/api/collections/entries/records?filter=(alID=1)&expand=trs",
      );
      assertEquals(calls[0].method, "GET");
      assertEquals(
        calls[0].headers.get("User-Agent"),
        "swamp-seadex-fixture/1.0",
      );
      assertEquals(calls[0].headers.get("Accept"), "application/json");
    },
  );
});

// ---------------------------------------------------------------------------
// pocketbase-empty.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: pocketbase-empty.json — items:[] yields a not-found result keyed to the REQUESTED id", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pocketbaseEmpty)],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 42 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "entry" && w.name === "al-42")!;
  assert(res);
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.alID, 42);
  assertEquals(res.payload.bestReleases, []);
  assertEquals(res.payload.alternativeReleases, []);
  assertEquals(res.payload.comparisonUrls, []);
  assertEquals(res.payload.sourceUrl, "https://releases.moe/42");
});

// ---------------------------------------------------------------------------
// fetchJson error mapping (Pocketbase side) — the "→" arrow character is pinned
// ---------------------------------------------------------------------------

Deno.test("contract: a non-ok Pocketbase response throws 'fetch <url> → <status> <body>' verbatim", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      return url.pathname === "/api/collections/entries/records"
        ? new Response("boom from pocketbase", { status: 500 })
        : undefined;
    }],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-anilist-id", { anilistId: 7 }, ctx),
        Error,
      );
      assertEquals(
        (err as Error).message,
        "fetch https://releases.moe/api/collections/entries/records?filter=(alID=7)&expand=trs → 500 boom from pocketbase",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// anilist-media.json contract — GraphQL {data:{Media}} envelope + POST body
// ---------------------------------------------------------------------------

Deno.test("contract: anilist-media.json + pocketbase-entry.json — full two-hop happy path, AniList POST body pinned", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [anilistRoute(anilistMedia), pocketbaseRoute(pocketbaseEntry)],
    async (calls) => {
      await run("lookup-by-title", { title: "Fixture Voyager" }, ctx);
      const anilistCall = calls.find((c) =>
        new URL(c.url).hostname === "graphql.anilist.co"
      )!;
      assertEquals(anilistCall.method, "POST");
      assertEquals(
        anilistCall.headers.get("Content-Type"),
        "application/json",
      );
      assertEquals(
        anilistCall.headers.get("User-Agent"),
        "swamp-seadex-fixture/1.0",
      );
      const body = await requestBody(anilistCall);
      assertEquals(
        (body.variables as Record<string, unknown>).search,
        "Fixture Voyager",
      );
      assert(
        (body.query as string).includes(
          "Media(search: $search, type: ANIME)",
        ),
        "GraphQL query pinned to search-by-title on the Media root field",
      );
    },
  );
  const res = written.find((w) => w.spec === "entry" && w.name === "al-1")!;
  assert(res, "two-hop resolution writes the entry keyed by the AniList id");
  assertEquals(res.payload.found, true);
  assertEquals(res.payload.alID, 1);
  assertEquals(res.payload.title, "Fixture Voyager");
});

// ---------------------------------------------------------------------------
// AniList error mapping — distinct message prefix from the Pocketbase side
// ---------------------------------------------------------------------------

Deno.test("contract: a non-ok AniList response throws 'anilist search failed: <status> <body>' verbatim (distinct from the Pocketbase 'fetch <url> →' mapping)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      return url.hostname === "graphql.anilist.co"
        ? new Response("boom from anilist", { status: 503 })
        : undefined;
    }],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-title", { title: "Whatever" }, ctx),
        Error,
      );
      assertEquals(
        (err as Error).message,
        "anilist search failed: 503 boom from anilist",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// anilist-nomatch.json contract — {data:{Media:null}}
// ---------------------------------------------------------------------------

Deno.test("contract: anilist-nomatch.json — {data:{Media:null}} yields a q-<slug> keyed not-found result, alID 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [anilistRoute(anilistNomatch)],
    async () => {
      await run("lookup-by-title", { title: "No Such Anime" }, ctx);
    },
  );
  const res = written.find((w) =>
    w.spec === "entry" && w.name === "q-no-such-anime"
  )!;
  assert(res, "expected a written entry keyed q-no-such-anime");
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.alID, 0);
  assertEquals(res.payload.title, "No Such Anime");
  assertEquals(res.payload.sourceUrl, "https://releases.moe/0");
});

// ---------------------------------------------------------------------------
// anilist-graphql-error.json contract — {errors,data:null} at HTTP 200
// ---------------------------------------------------------------------------

Deno.test("contract: anilist-graphql-error.json — a GraphQL-level error at HTTP 200 does not throw (not an HTTP error); full narrative pin lives in the adversarial suite", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [anilistRoute(anilistGraphqlError, 200)],
    async () => {
      // Must not throw: resp.ok is true (200), so the !resp.ok branch never
      // fires — the GraphQL errors[] array is never inspected.
      await run("lookup-by-title", { title: "Errored Search" }, ctx);
    },
  );
  const res = written.find((w) =>
    w.spec === "entry" && w.name === "q-errored-search"
  )!;
  assert(res);
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.alID, 0);
});
