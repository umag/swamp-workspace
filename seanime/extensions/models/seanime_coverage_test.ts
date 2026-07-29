/**
 * Coverage suite: sweeps every guard/branch in seanime.ts that the contract,
 * methods, and adversarial suites don't already exercise on BOTH sides, so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * Covers: the empty-PLANNING throw (both bulk methods, both sides), the
 * title `??`-fallback chain (all four levels), the torrents
 * Array.isArray/`.torrents`/`[]` normalization (every branch), the
 * json.data-vs-json unwrap (both sides, including the `data: null` pitfall),
 * the enhanced-scan flag body, and the validStatuses/includeFinished
 * membership guard for both bulk methods (including each method's distinct
 * skip-reason wording and the status-missing "unknown" fallback).
 *
 * seanime.ts is UNMODIFIED; every test PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./seanime.ts";

const GLOBAL_ARGS = {
  baseUrl: "http://seanime.example.com:3211",
  token: "coverage-fixture-token",
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

function collectionOf(entries: Array<Record<string, unknown> | null>) {
  return {
    data: {
      MediaListCollection: {
        lists: [
          {
            status: "PLANNING",
            entries: entries.map((media) => ({ media })),
          },
        ],
      },
    },
  };
}

/** A collection response with NO PLANNING list at all (only a CURRENT list). */
function collectionWithoutPlanning() {
  return {
    data: {
      MediaListCollection: {
        lists: [{ status: "CURRENT", entries: [] }],
      },
    },
  };
}

function withAniListStub(
  collection: unknown,
  ruleOrEntryRoute: Route,
  fn: () => Promise<void>,
) {
  return withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      return ruleOrEntryRoute(req);
    }],
    fn,
  );
}

const OK_POST: Route = () => json({ data: { success: true } });

// ---------------------------------------------------------------------------
// Guard: empty-PLANNING throw — both sides, both bulk methods
// ---------------------------------------------------------------------------

Deno.test("sync-planning-rules: no PLANNING list at all -> throws 'No anime found in PLANNING list'", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withAniListStub(collectionWithoutPlanning(), OK_POST, async () => {
    try {
      await run("sync-planning-rules", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assertEquals((threw as Error).message, "No anime found in PLANNING list");
});

Deno.test("sync-planning-rules: PLANNING list present but entries is an empty array -> throws", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withAniListStub(collectionOf([]), OK_POST, async () => {
    try {
      await run("sync-planning-rules", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assertEquals((threw as Error).message, "No anime found in PLANNING list");
});

Deno.test("sync-planning-rules: PLANNING list with >=1 entries does NOT throw", async () => {
  const { ctx } = makeCtx();
  await withAniListStub(
    collectionOf([{ id: 400001, status: "RELEASING", title: { romaji: "X" } }]),
    OK_POST,
    async () => {
      await run("sync-planning-rules", {}, ctx); // must not throw
    },
  );
});

Deno.test("set-planning-watching: no PLANNING list at all -> throws 'No anime found in PLANNING list'", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withAniListStub(collectionWithoutPlanning(), OK_POST, async () => {
    try {
      await run("set-planning-watching", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assertEquals((threw as Error).message, "No anime found in PLANNING list");
});

Deno.test("set-planning-watching: PLANNING list present but entries is an empty array -> throws", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withAniListStub(collectionOf([]), OK_POST, async () => {
    try {
      await run("set-planning-watching", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assertEquals((threw as Error).message, "No anime found in PLANNING list");
});

Deno.test("set-planning-watching: PLANNING list with >=1 entries does NOT throw", async () => {
  const { ctx } = makeCtx();
  await withAniListStub(
    collectionOf([{ id: 400002, status: "RELEASING", title: { romaji: "Y" } }]),
    OK_POST,
    async () => {
      await run("set-planning-watching", {}, ctx); // must not throw
    },
  );
});

// ---------------------------------------------------------------------------
// Guard: title `??`-fallback chain — all four levels
// ---------------------------------------------------------------------------

async function titleFor(titleObj: Record<string, unknown> | undefined) {
  const collection = collectionOf([
    { id: 400010, status: "RELEASING", title: titleObj },
  ]);
  const { ctx, written } = makeCtx();
  await withAniListStub(collection, OK_POST, async () => {
    await run("sync-planning-rules", {}, ctx);
  });
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  return (res.payload.created as Array<{ title: string }>)[0].title;
}

Deno.test("title fallback: romaji wins even when english and userPreferred are also present", async () => {
  assertEquals(
    await titleFor({
      romaji: "Romaji Title",
      english: "English Title",
      userPreferred: "Preferred Title",
    }),
    "Romaji Title",
  );
});

Deno.test("title fallback: romaji absent -> falls back to english", async () => {
  assertEquals(
    await titleFor({
      english: "English Title",
      userPreferred: "Preferred Title",
    }),
    "English Title",
  );
});

Deno.test("title fallback: romaji and english absent -> falls back to userPreferred", async () => {
  assertEquals(
    await titleFor({ userPreferred: "Preferred Title" }),
    "Preferred Title",
  );
});

Deno.test("title fallback: romaji, english, and userPreferred all absent -> literal 'Unknown'", async () => {
  assertEquals(await titleFor(undefined), "Unknown");
});

Deno.test("title fallback: an explicit falsy romaji ('') is skipped in favor of english (|| not ??)", async () => {
  assertEquals(
    await titleFor({ romaji: "", english: "English Title" }),
    "English Title",
  );
});

// ---------------------------------------------------------------------------
// Guard: torrents Array.isArray(data) ? data : (data?.torrents ?? [])
// ---------------------------------------------------------------------------

Deno.test("torrent-list: bare-array data is used AS-IS", async () => {
  const { ctx, written } = makeCtx();
  const torrents = [{ name: "a" }, { name: "b" }];
  await withFetchStub([() => json({ data: torrents })], async () => {
    await run("torrent-list", {}, ctx);
  });
  const res = written.find((w) => w.spec === "torrents")!;
  assertEquals(res.payload.torrents, torrents);
});

Deno.test("torrent-list: {torrents: [...]} object data extracts the .torrents array", async () => {
  const { ctx, written } = makeCtx();
  const torrents = [{ name: "c" }];
  await withFetchStub([() => json({ data: { torrents } })], async () => {
    await run("torrent-list", {}, ctx);
  });
  const res = written.find((w) => w.spec === "torrents")!;
  assertEquals(res.payload.torrents, torrents);
});

Deno.test("torrent-list: an object with no .torrents key falls back to []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ data: { unrelated: true } })], async () => {
    await run("torrent-list", {}, ctx);
  });
  const res = written.find((w) => w.spec === "torrents")!;
  assertEquals(res.payload.torrents, []);
});

Deno.test("torrent-list: data explicitly null falls back to []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ data: null })], async () => {
    await run("torrent-list", {}, ctx);
  });
  const res = written.find((w) => w.spec === "torrents")!;
  assertEquals(res.payload.torrents, []);
});

// ---------------------------------------------------------------------------
// Guard: json.data !== undefined ? json.data : json
// ---------------------------------------------------------------------------

Deno.test("json.data unwrap: data present (even null) is used — the whole envelope is NOT stored", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ data: null })], async () => {
    await run("status", {}, ctx);
  });
  const res = written.find((w) => w.spec === "status")!;
  // writeResource was called with `null` as the payload — our fake context
  // still records the call; assert it received exactly null, not the
  // wrapper object.
  assertEquals(res.payload, null);
});

Deno.test("json.data unwrap: data key absent entirely -> the WHOLE json object is used as data", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ os: "linux", version: "9.9.9" })],
    async () => {
      await run("status", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload, { os: "linux", version: "9.9.9" });
});

// ---------------------------------------------------------------------------
// Guard: library-scan's enhanced flag body
// ---------------------------------------------------------------------------

Deno.test("library-scan: enhanced omitted -> defaults to false via the schema, sent as {enhanced:false}", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ data: {} })], async (calls) => {
    await run("library-scan", {}, ctx);
    assertEquals((await requestBody(calls[0])).enhanced, false);
  });
});

Deno.test("library-scan: enhanced explicitly false -> sent as {enhanced:false}", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ data: {} })], async (calls) => {
    await run("library-scan", { enhanced: false }, ctx);
    assertEquals((await requestBody(calls[0])).enhanced, false);
  });
});

Deno.test("library-scan: enhanced explicitly true -> sent as {enhanced:true}", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ data: {} })], async (calls) => {
    await run("library-scan", { enhanced: true }, ctx);
    assertEquals((await requestBody(calls[0])).enhanced, true);
  });
});

// ---------------------------------------------------------------------------
// Guard: validStatuses membership + includeFinished, both bulk methods
// ---------------------------------------------------------------------------

async function syncSkipReasonFor(
  status: string | undefined,
  includeFinished = false,
) {
  const collection = collectionOf([{
    id: 400020,
    status,
    title: { romaji: "Z" },
  }]);
  const { ctx, written } = makeCtx();
  await withAniListStub(collection, OK_POST, async () => {
    await run("sync-planning-rules", { includeFinished }, ctx);
  });
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const created = res.payload.created as unknown[];
  const skipped = res.payload.skipped as Array<{ reason: string }>;
  return { created: created.length, reason: skipped[0]?.reason };
}

Deno.test("sync-planning-rules: RELEASING is always eligible", async () => {
  const r = await syncSkipReasonFor("RELEASING");
  assertEquals(r.created, 1);
});

Deno.test("sync-planning-rules: NOT_YET_RELEASED is always eligible", async () => {
  const r = await syncSkipReasonFor("NOT_YET_RELEASED");
  assertEquals(r.created, 1);
});

Deno.test("sync-planning-rules: FINISHED is skipped by default", async () => {
  const r = await syncSkipReasonFor("FINISHED", false);
  assertEquals(r.created, 0);
  assertEquals(r.reason, "status is FINISHED");
});

Deno.test("sync-planning-rules: FINISHED becomes eligible with includeFinished:true", async () => {
  const r = await syncSkipReasonFor("FINISHED", true);
  assertEquals(r.created, 1);
});

Deno.test("sync-planning-rules: an arbitrary unknown status (e.g. HIATUS) is never eligible, includeFinished or not", async () => {
  const withoutFinished = await syncSkipReasonFor("HIATUS", false);
  const withFinished = await syncSkipReasonFor("HIATUS", true);
  assertEquals(withoutFinished.created, 0);
  assertEquals(withoutFinished.reason, "status is HIATUS");
  assertEquals(withFinished.created, 0);
});

Deno.test("sync-planning-rules: a missing/undefined status falls back to 'unknown' in the skip reason", async () => {
  const r = await syncSkipReasonFor(undefined);
  assertEquals(r.created, 0);
  assertEquals(r.reason, "status is unknown");
});

async function watchingSkipReasonFor(
  status: string | undefined,
  includeFinished = false,
) {
  const collection = collectionOf([{
    id: 400030,
    status,
    title: { romaji: "W" },
  }]);
  const { ctx, written } = makeCtx();
  await withAniListStub(collection, OK_POST, async () => {
    await run("set-planning-watching", { includeFinished }, ctx);
  });
  const res = written.find((w) => w.spec === "statusChangeResult")!;
  const updated = res.payload.updated as unknown[];
  const skipped = res.payload.skipped as Array<{ reason: string }>;
  return { updated: updated.length, reason: skipped[0]?.reason };
}

Deno.test("set-planning-watching: RELEASING is always eligible", async () => {
  const r = await watchingSkipReasonFor("RELEASING");
  assertEquals(r.updated, 1);
});

Deno.test("set-planning-watching: FINISHED is skipped by default with the 'airing status' wording (distinct from sync-planning-rules)", async () => {
  const r = await watchingSkipReasonFor("FINISHED", false);
  assertEquals(r.updated, 0);
  assertEquals(r.reason, "airing status is FINISHED");
});

Deno.test("set-planning-watching: FINISHED becomes eligible with includeFinished:true", async () => {
  const r = await watchingSkipReasonFor("FINISHED", true);
  assertEquals(r.updated, 1);
});

Deno.test("set-planning-watching: a missing/undefined status falls back to 'unknown' in the skip reason", async () => {
  const r = await watchingSkipReasonFor(undefined);
  assertEquals(r.updated, 0);
  assertEquals(r.reason, "airing status is unknown");
});

// ---------------------------------------------------------------------------
// Guard: !mediaId — both sides, mediaId=0 is a distinct falsy-but-defined case
// ---------------------------------------------------------------------------

Deno.test("sync-planning-rules: mediaId=0 (falsy but defined) is silently skipped — same as missing mediaId", async () => {
  const collection = collectionOf([{
    id: 0,
    status: "RELEASING",
    title: { romaji: "Zero" },
  }]);
  const { ctx, written } = makeCtx();
  await withAniListStub(collection, OK_POST, async () => {
    await run("sync-planning-rules", {}, ctx);
  });
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const total = (res.payload.created as unknown[]).length +
    (res.payload.skipped as unknown[]).length +
    (res.payload.failed as unknown[]).length;
  assertEquals(total, 0, "mediaId:0 must not land in any partition");
});

Deno.test("sync-planning-rules: a truthy mediaId is processed (contrast with mediaId=0 above)", async () => {
  const collection = collectionOf([
    { id: 400040, status: "RELEASING", title: { romaji: "Nonzero" } },
  ]);
  const { ctx, written } = makeCtx();
  await withAniListStub(collection, OK_POST, async () => {
    await run("sync-planning-rules", {}, ctx);
  });
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  assertEquals((res.payload.created as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// Sanity: assert import is exercised (keeps lint happy if future edits trim
// the assertEquals-only tests above)
// ---------------------------------------------------------------------------

Deno.test("sanity: model exposes exactly the 8 documented methods", () => {
  const methodNames = Object.keys(model.methods).sort();
  assert(methodNames.length === 8, "seanime.ts must expose exactly 8 methods");
  assertEquals(methodNames, [
    "auto-download",
    "library-collection",
    "library-scan",
    "missing-episodes",
    "set-planning-watching",
    "status",
    "sync-planning-rules",
    "torrent-list",
  ]);
});
