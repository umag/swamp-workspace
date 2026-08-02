/**
 * Method-level tests for @magistr/seadex — every one of the 4 methods
 * (lookup-by-anilist-id, render-upgrades, lookup-many, lookup-by-title),
 * happy path + failure path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` and a fake context.
 *
 * This repo's real-fix change addressed all 8 tracked latent bugs (LB1–LB8)
 * in `seadex.ts`. Most tests below stay byte-frozen characterizations of
 * already-shipped behavior; the render-upgrades tests are flipped (LB1, see
 * below) and a small set of lookup-many tests gained new assertions for
 * LB4/LB5 (see the adversarial suite for the full pin-flip narrative on those
 * two). It is not red-green TDD: most of this suite has no new behavior to
 * drive out.
 *
 * lookup-by-title is TWO-HOP (AniList resolve, then Pocketbase fetch) and has
 * THREE distinct outcomes, all three pinned here (the middle one is the
 * branch that most distinguishes the two-hop flow, per the round-1 plan
 * review finding):
 *   1. AniList hit + Pocketbase hit  -> found:true,  alID=<AniList id>, key al-<id>
 *   2. AniList hit + Pocketbase MISS -> found:false, alID=<AniList id> (NOT 0),
 *      key al-<id> (NOT q-<slug>), title = the AniList-resolved title
 *   3. AniList no match              -> found:false, alID=0, key q-<slug>
 *
 * render-upgrades WAS a no-op stub that wrote an identical all-zero
 * `summary` marker regardless of its filter arguments. LB1 (HIGH) fixes
 * this: it now writes a new `upgradeFilter` resource whose year/status/
 * minScore/title fields ECHO the caller's arguments (null when omitted) —
 * a non-vacuous, real effect a caller can observe.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://releases.moe",
  userAgent: "swamp-seadex-methods/1.0",
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

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

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

function pocketbaseRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/collections/entries/records"
      ? json(body, status)
      : undefined;
  };
}

function anilistRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.hostname === "graphql.anilist.co"
      ? json(body, status)
      : undefined;
  };
}

// ---------------------------------------------------------------------------
// lookup-by-anilist-id
// ---------------------------------------------------------------------------

Deno.test("lookup-by-anilist-id: happy path — writes entry/al-<id> with found:true", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEntry)], async () => {
    const out = await run(
      "lookup-by-anilist-id",
      { anilistId: 1, title: "Caller-Supplied Title" },
      ctx,
    ) as { dataHandles: unknown[] };
    assertEquals(out.dataHandles.length, 1);
  });
  const res = written.find((w) => w.name === "al-1")!;
  assert(res);
  assertEquals(res.payload.found, true);
  assertEquals(
    res.payload.title,
    "Caller-Supplied Title",
    "title arg is echoed back verbatim, never overwritten by any AniList/Pocketbase title field",
  );
});

Deno.test("lookup-by-anilist-id: title omitted -> title is null", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 99 }, ctx);
  });
  const res = written.find((w) => w.name === "al-99")!;
  assertEquals(res.payload.title, null);
});

Deno.test("lookup-by-anilist-id: not-found path — Pocketbase empty items[] writes found:false", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 5 }, ctx);
  });
  const res = written.find((w) => w.name === "al-5")!;
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.alID, 5);
});

Deno.test("lookup-by-anilist-id: failure path — a non-ok Pocketbase response rejects, writes NOTHING", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute("boom", 500)],
    async () => {
      await assertRejects(
        () => run("lookup-by-anilist-id", { anilistId: 5 }, ctx),
        Error,
      );
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("lookup-by-anilist-id: anilistId must be a positive integer (schema guard)", () => {
  const method = (model.methods as MethodMap)["lookup-by-anilist-id"];
  assertThrows(() => method.arguments.parse({ anilistId: -1 }));
  assertThrows(() => method.arguments.parse({ anilistId: 1.5 }));
});

// ---------------------------------------------------------------------------
// render-upgrades — FIXED (LB1, HIGH): now writes a real upgradeFilter
// marker whose fields echo the caller's filter arguments
// ---------------------------------------------------------------------------

Deno.test("render-upgrades: writes the upgradeFilter marker with all filters null when none are given", async () => {
  const { ctx, written } = makeCtx();
  const out = await run("render-upgrades", {}, ctx) as {
    dataHandles: unknown[];
  };
  assertEquals(out.dataHandles.length, 1);
  const res = written.find((w) => w.name === "render-upgrades")!;
  assert(res);
  assertEquals(res.spec, "upgradeFilter");
  assertEquals(res.payload, {
    year: null,
    status: null,
    minScore: null,
    title: null,
    timestamp: res.payload.timestamp,
  });
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("render-upgrades: FIXED (LB1) — year/status/minScore/title filter arguments are now ECHOED into the written upgradeFilter marker (non-vacuous: was a permanent no-op before)", async () => {
  const { ctx, written } = makeCtx();
  await run("render-upgrades", {
    year: 2026,
    status: "COMPLETED",
    minScore: 80,
    title: "note",
  }, ctx);
  const res = written.find((w) => w.name === "render-upgrades")!;
  assertEquals(res.spec, "upgradeFilter");
  assertEquals(res.payload.year, 2026);
  assertEquals(res.payload.status, "COMPLETED");
  assertEquals(res.payload.minScore, 80);
  assertEquals(res.payload.title, "note");
});

Deno.test("render-upgrades: partial filter (year only) -> year echoed, the rest stay null", async () => {
  const { ctx, written } = makeCtx();
  await run("render-upgrades", { year: 2025 }, ctx);
  const res = written.find((w) => w.name === "render-upgrades")!;
  assertEquals(res.spec, "upgradeFilter");
  assertEquals(res.payload.year, 2025);
  assertEquals(res.payload.status, null);
  assertEquals(res.payload.minScore, null);
  assertEquals(res.payload.title, null);
});

Deno.test("render-upgrades: makes NO network call at all", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([], async (calls) => {
    await run("render-upgrades", {}, ctx);
    assertEquals(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// lookup-many
// ---------------------------------------------------------------------------

Deno.test("lookup-many: happy path — 2 items yield 2 entry writes + 1 summary with correct counts", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/api/collections/entries/records") return undefined;
      return url.searchParams.get("filter") === "(alID=1)"
        ? json(pocketbaseEntry)
        : json(pocketbaseEmpty);
    }],
    async () => {
      await run(
        "lookup-many",
        { items: [{ anilistId: 1 }, { anilistId: 2 }] },
        ctx,
      );
    },
  );
  const entries = written.filter((w) => w.spec === "entry");
  assertEquals(entries.length, 2);
  assertEquals(entries.find((e) => e.name === "al-1")!.payload.found, true);
  assertEquals(entries.find((e) => e.name === "al-2")!.payload.found, false);

  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.name, "lookup-many");
  assertEquals(summary.payload.total, 2);
  assertEquals(summary.payload.found, 1);
  assertEquals(summary.payload.withBestReleases, 1);
  assertEquals(summary.payload.incomplete, 0);
  assertEquals(
    (summary.payload.notInSeadex as Array<{ alID: number }>).map((n) => n.alID),
    [2],
  );
});

Deno.test("lookup-many: user metadata fields are threaded through into each entry", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run(
      "lookup-many",
      {
        items: [{
          anilistId: 3,
          userScore: 90,
          userStatus: "COMPLETED",
          userSeason: "WINTER",
          userYear: 2026,
          currentPath: "/anime/tv/Fixture",
          currentSizeBytes: 123456,
          currentFileCount: 12,
        }],
      },
      ctx,
    );
  });
  const res = written.find((w) => w.name === "al-3")!;
  assertEquals(res.payload.userScore, 90);
  assertEquals(res.payload.userStatus, "COMPLETED");
  assertEquals(res.payload.userSeason, "WINTER");
  assertEquals(res.payload.userYear, 2026);
  assertEquals(res.payload.currentPath, "/anime/tv/Fixture");
  assertEquals(res.payload.currentSizeBytes, 123456);
  assertEquals(res.payload.currentFileCount, 12);
});

Deno.test("lookup-many: a per-item fetch failure is caught and folded into that item's result with an ERROR-prefixed note, other items unaffected", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.searchParams.get("filter") === "(alID=10)") {
        return new Response("server exploded", { status: 500 });
      }
      return json(pocketbaseEmpty);
    }],
    async () => {
      await run(
        "lookup-many",
        { items: [{ anilistId: 10 }, { anilistId: 11 }] },
        ctx,
      );
    },
  );
  const entries = written.filter((w) => w.spec === "entry");
  assertEquals(entries.length, 2, "the errored item still produces a result");
  const errored = entries.find((e) => e.name === "al-10")!;
  assertEquals(errored.payload.found, false);
  assert(
    (errored.payload.notes as string).startsWith("ERROR:"),
    "errored item's notes are prefixed ERROR:",
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 2);
});

Deno.test("lookup-many: concurrency defaults to 5 when omitted (schema default, not asserted via timing — just that it parses)", () => {
  const method = (model.methods as MethodMap)["lookup-many"];
  const parsed = method.arguments.parse({
    items: [{ anilistId: 1 }],
  }) as { concurrency?: number };
  assertEquals(
    parsed.concurrency,
    undefined,
    "no schema-level default is applied — undefined means the execute()-level `?? 5` fallback governs",
  );
});

Deno.test("lookup-many: items[] must have at least 1 entry (schema guard)", () => {
  const method = (model.methods as MethodMap)["lookup-many"];
  assertThrows(() => method.arguments.parse({ items: [] }));
});

// ---------------------------------------------------------------------------
// lookup-by-title — THREE distinct outcomes of the two-hop flow
// ---------------------------------------------------------------------------

Deno.test("lookup-by-title OUTCOME 1/3: AniList hit + Pocketbase hit -> found:true, alID=<AniList id>, key al-<id>", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [anilistRoute(anilistMedia), pocketbaseRoute(pocketbaseEntry)],
    async () => {
      await run("lookup-by-title", { title: "Fixture Voyager" }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-1")!;
  assert(res, "OUTCOME 1 writes entry keyed al-<AniList id>");
  assertEquals(res.payload.found, true);
  assertEquals(res.payload.alID, 1);
  assertEquals(res.payload.title, "Fixture Voyager");
});

Deno.test("lookup-by-title OUTCOME 2/3 (the load-bearing middle branch): AniList hit + Pocketbase MISS -> found:false, alID=<AniList id> (NOT 0), key al-<id> (NOT q-<slug>), title = AniList-resolved title", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [anilistRoute(anilistMedia), pocketbaseRoute(pocketbaseEmpty)],
    async () => {
      await run("lookup-by-title", { title: "fixture voyager" }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-1")!;
  assert(
    res,
    "OUTCOME 2 is keyed al-1 (the AniList id), NOT q-<slug> — this is the branch a two-outcome mental model misses",
  );
  assertEquals(
    written.find((w) => w.name.startsWith("q-")),
    undefined,
    "no q-<slug> key is EVER written once AniList resolves, even when Pocketbase has no entry",
  );
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.alID, 1, "alID is the resolved AniList id, NOT 0");
  assertEquals(
    res.payload.title,
    "Fixture Voyager",
    "title is the AniList-RESOLVED title (found.title), not the caller's raw input string",
  );
  assertEquals(res.payload.sourceUrl, "https://releases.moe/1");
});

Deno.test("lookup-by-title OUTCOME 3/3: AniList no match -> found:false, alID=0, key q-<slug>, title = the caller's raw input", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([anilistRoute(anilistNomatch)], async () => {
    await run("lookup-by-title", { title: "No Such Anime" }, ctx);
  });
  const res = written.find((w) => w.name === "q-no-such-anime")!;
  assert(res, "OUTCOME 3 is keyed q-<slug>, never al-0");
  assertEquals(
    written.find((w) => w.name === "al-0"),
    undefined,
    "alID 0 never appears as an al-0 resource key — only as content on the q-<slug> entry",
  );
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.alID, 0);
  assertEquals(
    res.payload.title,
    "No Such Anime",
    "title falls back to the caller's raw input when AniList has no match",
  );
  assertEquals(res.payload.sourceUrl, "https://releases.moe/0");
});

Deno.test("lookup-by-title: found.title empty string falls back to the caller's raw title (|| not ??)", async () => {
  const { ctx, written } = makeCtx();
  const mediaNoTitle = {
    data: { Media: { id: 1, title: { romaji: "", english: "" } } },
  };
  await withFetchStub(
    [anilistRoute(mediaNoTitle), pocketbaseRoute(pocketbaseEntry)],
    async () => {
      await run("lookup-by-title", { title: "Caller Title Fallback" }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-1")!;
  assertEquals(res.payload.title, "Caller Title Fallback");
});

// ---------------------------------------------------------------------------
// Joint error mapping — lookup-by-title's two-hop failure modes are DISTINCT
// ---------------------------------------------------------------------------

Deno.test("lookup-by-title: AniList-hop failure throws 'anilist search failed: <status>' — Pocketbase is NEVER called", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.hostname === "graphql.anilist.co") {
        return new Response("down", { status: 502 });
      }
      throw new Error(
        `Pocketbase must not be called when the AniList hop fails, got ${url}`,
      );
    }],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-title", { title: "X" }, ctx),
        Error,
      );
      assert(
        (err as Error).message.startsWith("anilist search failed: 502"),
      );
    },
  );
});

Deno.test("lookup-by-title: Pocketbase-hop failure (after a successful AniList resolve) throws 'fetch <url> →' — distinct prefix from the AniList-hop mapping", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [anilistRoute(anilistMedia), pocketbaseRoute("pb down", 500)],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-title", { title: "Fixture Voyager" }, ctx),
        Error,
      );
      assert(
        (err as Error).message.startsWith("fetch "),
        `expected the Pocketbase-hop message to start with "fetch ", got: ${
          (err as Error).message
        }`,
      );
      assert((err as Error).message.includes("→ 500"));
    },
  );
});

Deno.test("lookup-by-title: title must be a non-empty string (schema guard)", () => {
  const method = (model.methods as MethodMap)["lookup-by-title"];
  assertThrows(() => method.arguments.parse({ title: "" }));
});

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

Deno.test("sanity: model exposes exactly the 4 documented methods", () => {
  const methodNames = Object.keys(model.methods).sort();
  assertEquals(methodNames, [
    "lookup-by-anilist-id",
    "lookup-by-title",
    "lookup-many",
    "render-upgrades",
  ]);
});
