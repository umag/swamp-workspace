/**
 * Coverage suite: sweeps every guard/branch in seadex.ts that the contract,
 * methods, and adversarial suites don't already exercise on BOTH sides, so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * Covers: buildResult found/not-found: normaliseTorrent's files/tags `??`
 * defaults and primaryFile tie-breaking; the isBest partition at both
 * extremes (all-best, all-alternative); comparison split/trim/filter across
 * zero/one/many URLs; baseUrl trailing-slash stripping (single and multiple
 * slashes); the userMeta present-vs-absent STRUCTURAL difference between
 * lookup-by-anilist-id (buildResult's default `{}` — zero user* keys at all)
 * and lookup-many (always sets all 7 user* keys, even to `undefined`, when a
 * caller omits some); fetchSeadex's items[0] pick when Pocketbase returns
 * more than one match; the concurrency `Math.min(conc, items.length)` guard;
 * lookup-by-title's slug-key construction (case, special chars, length cap);
 * and model/resource shape sanity.
 *
 * seadex.ts is UNMODIFIED; every test here PINS existing behavior. seadex.ts
 * exports no pure helpers, so every guard is observed by driving
 * `model.methods.<m>.execute()` against a stubbed fetch, per the plan.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./seadex.ts";
import pocketbaseEntry from "../../fixtures/pocketbase-entry.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://releases.moe",
  userAgent: "swamp-seadex-coverage/1.0",
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

function pocketbaseRoute(body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/collections/entries/records"
      ? json(body, status)
      : undefined;
  };
}

function pbList(items: unknown[]) {
  return {
    page: 1,
    perPage: 30,
    totalItems: items.length,
    totalPages: items.length > 0 ? 1 : 0,
    items,
  };
}

function torrent(overrides: Record<string, unknown> = {}) {
  return {
    id: "tr_cov",
    releaseGroup: "CovGroup",
    tracker: "CovTracker",
    url: "https://tracker.example/cov",
    infoHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    files: [{ name: "a.mkv", length: 100 }],
    ...overrides,
  };
}

function entryWith(trs: unknown[]) {
  return {
    id: "rec_cov",
    alID: 900,
    notes: "",
    theoreticalBest: "",
    comparison: "",
    incomplete: false,
    trs: trs.map((_, i) => `tr_cov_${i}`),
    expand: { trs },
  };
}

// ---------------------------------------------------------------------------
// Guard: buildResult found / not-found — both sides
// ---------------------------------------------------------------------------

Deno.test("buildResult: entry present -> found:true, entry.alID/notes/theoreticalBest/incomplete carried through", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEntry)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
  });
  const res = written.find((w) => w.name === "al-1")!;
  assertEquals(res.payload.found, true);
});

Deno.test("buildResult: entry null (items:[]) -> found:false, all-empty defaults", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pbList([]))], async () => {
    await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
  });
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals(res.payload.found, false);
  assertEquals(res.payload.notes, "");
  assertEquals(res.payload.theoreticalBest, "");
  assertEquals(res.payload.incomplete, false);
  assertEquals(res.payload.bestReleases, []);
  assertEquals(res.payload.alternativeReleases, []);
});

// ---------------------------------------------------------------------------
// Guard: normaliseTorrent — files/tags `??` defaults, primaryFile tie-break
// ---------------------------------------------------------------------------

Deno.test("normaliseTorrent: files explicitly [] -> totalSizeBytes 0, fileCount 0, primaryFile null", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([entryWith([torrent({ files: [] })])]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.totalSizeBytes, 0);
  assertEquals(best.fileCount, 0);
  assertEquals(best.primaryFile, null);
});

Deno.test("normaliseTorrent: tags absent entirely -> defaults to [] via ??", async () => {
  const t = torrent();
  // deno-lint-ignore no-explicit-any
  delete (t as any).tags;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([entryWith([t])]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.tags, []);
});

Deno.test("normaliseTorrent: primaryFile TIE (equal lengths) picks the FIRST file in original order (stable sort)", async () => {
  const t = torrent({
    files: [
      { name: "first.mkv", length: 500 },
      { name: "second.mkv", length: 500 },
    ],
  });
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([entryWith([t])]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.primaryFile, "first.mkv");
  assertEquals(best.totalSizeBytes, 1000);
  assertEquals(best.fileCount, 2);
});

// ---------------------------------------------------------------------------
// Guard: isBest partition — both extremes
// ---------------------------------------------------------------------------

Deno.test("isBest partition: ALL torrents isBest:true -> bestReleases holds all, alternativeReleases empty", async () => {
  const trs = [
    torrent({ id: "t1", isBest: true }),
    torrent({ id: "t2", isBest: true }),
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([entryWith(trs)]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals((res.payload.bestReleases as unknown[]).length, 2);
  assertEquals((res.payload.alternativeReleases as unknown[]).length, 0);
});

Deno.test("isBest partition: ALL torrents isBest:false -> alternativeReleases holds all, bestReleases empty", async () => {
  const trs = [
    torrent({ id: "t1", isBest: false }),
    torrent({ id: "t2", isBest: false }),
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([entryWith(trs)]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals((res.payload.bestReleases as unknown[]).length, 0);
  assertEquals((res.payload.alternativeReleases as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// Guard: comparison split/trim/filter — zero, one, many URLs
// ---------------------------------------------------------------------------

async function comparisonUrlsFor(comparison: string): Promise<string[]> {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([{ ...entryWith([]), comparison }]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  return res.payload.comparisonUrls as string[];
}

Deno.test("comparisonUrls: empty string -> []", async () => {
  assertEquals(await comparisonUrlsFor(""), []);
});

Deno.test("comparisonUrls: single URL, no comma -> single-element array", async () => {
  assertEquals(await comparisonUrlsFor("https://a.example/1"), [
    "https://a.example/1",
  ]);
});

Deno.test("comparisonUrls: multiple URLs with surrounding whitespace are trimmed", async () => {
  assertEquals(
    await comparisonUrlsFor("  https://a.example/1 ,  https://b.example/2  "),
    ["https://a.example/1", "https://b.example/2"],
  );
});

Deno.test("comparisonUrls: a trailing comma produces an empty segment that is FILTERED out (Boolean filter)", async () => {
  assertEquals(
    await comparisonUrlsFor("https://a.example/1,"),
    ["https://a.example/1"],
  );
});

// ---------------------------------------------------------------------------
// Guard: baseUrl trailing-slash stripping — single and multiple slashes
// ---------------------------------------------------------------------------

Deno.test("baseUrl: a single trailing slash is stripped from both the Pocketbase URL and sourceUrl", async () => {
  const { ctx, written } = makeCtx({
    baseUrl: "https://releases.moe/",
    userAgent: "swamp-seadex-coverage/1.0",
  });
  await withFetchStub([pocketbaseRoute(pbList([]))], async (calls) => {
    await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    assertEquals(
      calls[0].url,
      "https://releases.moe/api/collections/entries/records?filter=(alID=900)&expand=trs",
    );
  });
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals(res.payload.sourceUrl, "https://releases.moe/900");
});

Deno.test("baseUrl: MULTIPLE trailing slashes are all stripped (the regex is /\\/+$/, not a single-slash replace)", async () => {
  const { ctx, written } = makeCtx({
    baseUrl: "https://releases.moe///",
    userAgent: "swamp-seadex-coverage/1.0",
  });
  await withFetchStub([pocketbaseRoute(pbList([]))], async (calls) => {
    await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    assertEquals(
      calls[0].url,
      "https://releases.moe/api/collections/entries/records?filter=(alID=900)&expand=trs",
    );
  });
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals(res.payload.sourceUrl, "https://releases.moe/900");
});

// ---------------------------------------------------------------------------
// Guard: userMeta present vs absent — a STRUCTURAL difference between methods
// ---------------------------------------------------------------------------

Deno.test("userMeta: lookup-by-anilist-id NEVER attaches any user*/current* key at all — buildResult's default {} omits them structurally", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pbList([]))], async () => {
    await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
  });
  const res = written.find((w) => w.name === "al-900")!;
  for (
    const key of [
      "userScore",
      "userStatus",
      "userSeason",
      "userYear",
      "currentPath",
      "currentSizeBytes",
      "currentFileCount",
    ]
  ) {
    assert(
      !(key in res.payload),
      `lookup-by-anilist-id must never attach "${key}" — its buildResult call passes no userMeta argument`,
    );
  }
});

Deno.test("userMeta: lookup-many ALWAYS attaches all 7 user*/current* keys — even ones the caller omitted come through as an EXPLICIT key with value undefined (structurally different from the fully-absent case above)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pbList([]))], async () => {
    await run("lookup-many", { items: [{ anilistId: 900 }] }, ctx);
  });
  const res = written.find((w) => w.name === "al-900")!;
  for (
    const key of [
      "userScore",
      "userStatus",
      "userSeason",
      "userYear",
      "currentPath",
      "currentSizeBytes",
      "currentFileCount",
    ]
  ) {
    assert(
      key in res.payload,
      `lookup-many's userMeta object always sets "${key}" as an explicit key, even when the caller omitted it`,
    );
    assertEquals(res.payload[key], undefined);
  }
});

Deno.test("userMeta: lookup-many with a fully-populated item carries every value through", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pbList([]))], async () => {
    await run("lookup-many", {
      items: [{
        anilistId: 900,
        userScore: 77,
        userStatus: "CURRENT",
        userSeason: "FALL",
        userYear: 2025,
        currentPath: "/anime/tv/Cov",
        currentSizeBytes: 42,
        currentFileCount: 3,
      }],
    }, ctx);
  });
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals(res.payload.userScore, 77);
  assertEquals(res.payload.userStatus, "CURRENT");
  assertEquals(res.payload.userSeason, "FALL");
  assertEquals(res.payload.userYear, 2025);
  assertEquals(res.payload.currentPath, "/anime/tv/Cov");
  assertEquals(res.payload.currentSizeBytes, 42);
  assertEquals(res.payload.currentFileCount, 3);
});

// ---------------------------------------------------------------------------
// Guard: fetchSeadex items[0] pick when Pocketbase returns >1 item
// ---------------------------------------------------------------------------

Deno.test("fetchSeadex: when Pocketbase (hostilely) returns more than one item, ONLY items[0] is used — the rest are silently ignored", async () => {
  const first = entryWith([]);
  const second = { ...entryWith([]), id: "rec_second", notes: "SECOND" };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pocketbaseRoute(pbList([first, second]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 900 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-900")!;
  assertEquals(res.payload.notes, "", "items[0] (the first entry) wins");
});

// ---------------------------------------------------------------------------
// Guard: concurrency Math.min(conc, items.length)
// ---------------------------------------------------------------------------

Deno.test("concurrency: default (omitted) with 1 item still processes exactly that 1 item (Math.min(5,1)=1 worker)", async () => {
  const { ctx, written } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [(req) => {
      calls++;
      const url = new URL(req.url);
      return url.pathname === "/api/collections/entries/records"
        ? json(pbList([]))
        : undefined;
    }],
    async () => {
      await run("lookup-many", { items: [{ anilistId: 900 }] }, ctx);
    },
  );
  assertEquals(calls, 1);
  assertEquals(written.filter((w) => w.spec === "entry").length, 1);
});

Deno.test("concurrency: explicit concurrency:1 with 3 items still processes ALL 3 (a single worker drains the whole queue sequentially)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pbList([]))], async () => {
    await run("lookup-many", {
      items: [{ anilistId: 901 }, { anilistId: 902 }, { anilistId: 903 }],
      concurrency: 1,
    }, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "entry").length, 3);
});

Deno.test("concurrency: a value greater than items.length does not throw or skip any item", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pbList([]))], async () => {
    await run("lookup-many", {
      items: [{ anilistId: 904 }],
      concurrency: 20,
    }, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "entry").length, 1);
});

// ---------------------------------------------------------------------------
// Guard: lookup-by-title slug key construction
// ---------------------------------------------------------------------------

async function slugKeyFor(title: string): Promise<string> {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ data: { Media: null } })],
    async () => {
      await run("lookup-by-title", { title }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "entry")!;
  return res.name;
}

Deno.test("slug key: uppercase + special characters are lowercased and replaced with '-'", async () => {
  assertEquals(await slugKeyFor("Hello, World!!"), "q-hello--world--");
});

Deno.test("slug key: a title longer than 40 characters is truncated to exactly 40", async () => {
  const longTitle = "A".repeat(60);
  const key = await slugKeyFor(longTitle);
  assertEquals(key.length, "q-".length + 40);
  assertEquals(key, `q-${"a".repeat(40)}`);
});

// ---------------------------------------------------------------------------
// Sanity: model / resource shape
// ---------------------------------------------------------------------------

Deno.test("sanity: model.resources exposes exactly entry + summary", () => {
  assertEquals(Object.keys(model.resources).sort(), ["entry", "summary"]);
});

Deno.test("sanity: every method has a non-empty description", () => {
  for (const [name, m] of Object.entries(model.methods)) {
    assert(
      typeof (m as { description: string }).description === "string" &&
        (m as { description: string }).description.length > 0,
      `method ${name} must have a non-empty description`,
    );
  }
});

Deno.test("sanity: globalArguments schema defaults baseUrl and userAgent when omitted", () => {
  const parsed = model.globalArguments.parse({}) as {
    baseUrl: string;
    userAgent: string;
  };
  assertEquals(parsed.baseUrl, "https://releases.moe");
  assertEquals(parsed.userAgent, "swamp-seadex/1.0");
});

Deno.test("sanity: lookup-by-anilist-id's anilistId argument is a positive integer (zod schema introspection)", () => {
  const schema = (model.methods as MethodMap)["lookup-by-anilist-id"]
    .arguments as unknown as {
      shape: { anilistId: { safeParse: (v: unknown) => { success: boolean } } };
    };
  assertEquals(schema.shape.anilistId.safeParse(5).success, true);
  assertEquals(schema.shape.anilistId.safeParse(-5).success, false);
  assertEquals(schema.shape.anilistId.safeParse(1.5).success, false);
});
