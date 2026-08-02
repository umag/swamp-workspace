/**
 * Adversarial suite: attacker's-perspective tests over the two upstream
 * contracts (hostile Pocketbase torrent payloads, AniList error-swallowing),
 * fan-out partial-write isolation, infoHash/tracker field passthrough, and a
 * mechanical fixtures-secret-scan.
 *
 * seadex.ts received a REAL (non-byte-frozen) fix for all 8 tracked latent
 * bugs (LB1–LB8) in this change. Tests below that used to PIN a bug are now
 * labeled "FIXED (LBn)" and assert the fixed behavior instead; tests that
 * still document a genuinely out-of-scope risk (hostile-content trust
 * boundary, non-array `tags` passthrough, files-entirely-absent) stay
 * labeled "PIN" — those are unaffected by this change and remain byte-frozen.
 *
 * HARNESS-FIDELITY NOTE (kept for the LB3 tests below): the fake
 * `writeResource` in this file's `makeCtx()` does NOT validate against
 * `SeadexResultSchema` the way the real swamp runtime does. Historically, a
 * hostile Pocketbase file whose `length` arrived as a STRING (the old BUG-6)
 * turned `totalSizeBytes` into a string via `0 + "999"` JS coercion, which
 * would have failed the real runtime's `TorrentEntrySchema.totalSizeBytes:
 * z.number()` validation — and because `lookup-many`'s entry-writing loop
 * used to run OUTSIDE the per-item try/catch, that rejection discarded the
 * ENTIRE batch (the old BUG-3). LB6's numeric coercion
 * (`Number(f.length) || 0`) now fixes `totalSizeBytes` at the source, so that
 * particular BUG-6→BUG-3 linkage can no longer occur — but `writeResource`
 * can still reject for OTHER real-runtime reasons (datastore lock
 * contention, I/O errors), so `makePoisonedCtx` is KEPT below to prove LB3's
 * per-item write isolation holds regardless of *why* a write rejects.
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
  userAgent: "swamp-seadex-adversarial/1.0",
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

/** A context whose writeResource REJECTS for one specific (spec,name) pair —
 * simulating a REAL runtime write rejection (schema validation, datastore
 * lock contention, I/O errors — the fake harness above cannot reproduce any
 * of these, since it never validates). Used to prove LB3's per-item write
 * isolation in lookup-many, never to demonstrate LB6's numeric coercion. */
function makePoisonedCtx(poisonSpec: string, poisonName: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        if (spec === poisonSpec && name === poisonName) {
          return Promise.reject(
            new Error(
              `simulated schema rejection: ${spec}/${name} failed validation`,
            ),
          );
        }
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

function pocketbaseTextRoute(text: string, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/collections/entries/records"
      ? new Response(text, { status })
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

function clonePocketbaseEntry(): typeof pocketbaseEntry {
  return JSON.parse(JSON.stringify(pocketbaseEntry));
}

// ---------------------------------------------------------------------------
// AniList HTTP-200-with-errors — FIXED (LB2, HIGH): now rejects, distinct
// from a legitimate no-match
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB2): an AniList HTTP-200-with-{errors,data:null} response now REJECTS with a message including the upstream errors[] text, and writes NO entry — no longer indistinguishable from a legitimate no-match", async () => {
  const { ctx: errCtx, written: errWritten } = makeCtx();
  await withFetchStub([anilistRoute(anilistGraphqlError, 200)], async () => {
    const err = await assertRejects(
      () => run("lookup-by-title", { title: "Errored Search" }, errCtx),
      Error,
    );
    assert(
      (err as Error).message.includes(
        "Something went wrong. Please contact support for more information.",
      ),
      `expected the graphql errors[] message to be embedded, got: ${
        (err as Error).message
      }`,
    );
  });
  assertEquals(
    errWritten.length,
    0,
    "no entry resource is written once the graphql errors[] array causes a rejection",
  );

  const { ctx: nomatchCtx, written: nomatchWritten } = makeCtx();
  await withFetchStub([anilistRoute(anilistNomatch, 200)], async () => {
    await run("lookup-by-title", { title: "Errored Search" }, nomatchCtx);
  });
  const nomatchRes = nomatchWritten.find((w) => w.name === "q-errored-search")!;
  assert(
    nomatchRes,
    "a legitimate no-match still writes a found:false entry, unaffected by LB2 — only the graphql-errors case now rejects",
  );
  assertEquals(nomatchRes.payload.found, false);
});

Deno.test("FIXED (LB2): a MULTI-message graphql errors[] array joins ALL messages into the rejection", async () => {
  const { ctx } = makeCtx();
  const multiError = {
    errors: [
      { message: "first problem" },
      { message: "second problem" },
    ],
    data: null,
  };
  await withFetchStub([anilistRoute(multiError, 200)], async () => {
    const err = await assertRejects(
      () => run("lookup-by-title", { title: "Multi Error" }, ctx),
      Error,
    );
    assert((err as Error).message.includes("first problem"));
    assert((err as Error).message.includes("second problem"));
  });
});

Deno.test("FIXED (LB2): the graphql-errors rejection message uses a prefix DISTINCT from the HTTP-failure 'anilist search failed:' mapping", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([anilistRoute(anilistGraphqlError, 200)], async () => {
    const err = await assertRejects(
      () => run("lookup-by-title", { title: "Errored Search" }, ctx),
      Error,
    );
    assert(
      !(err as Error).message.startsWith("anilist search failed:"),
      `expected a distinct graphql-errors prefix, got: ${
        (err as Error).message
      }`,
    );
  });
});

Deno.test("FIXED (LB2): Pocketbase is NEVER called once the AniList graphql errors[] array causes a rejection", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      anilistRoute(anilistGraphqlError, 200),
      (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/collections/entries/records") {
          throw new Error(
            "Pocketbase must not be called once the graphql errors[] array rejects",
          );
        }
        return undefined;
      },
    ],
    async () => {
      await assertRejects(
        () => run("lookup-by-title", { title: "Errored Search" }, ctx),
        Error,
      );
    },
  );
});

Deno.test("FIXED (LB6): an AniList Media object with NO `title` key at all (not merely empty) no longer crashes — `m.title ?? {}` guards the dereference before the `??` fallback chain runs, resolving to an empty string title", async () => {
  const { ctx, written } = makeCtx();
  const mediaNoTitleAtAll = { data: { Media: { id: 123 } } };
  await withFetchStub(
    [anilistRoute(mediaNoTitleAtAll), pocketbaseRoute(pocketbaseEntry)],
    async () => {
      await run("lookup-by-title", { title: "Whatever" }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-123")!;
  assert(
    res,
    "no crash — resolution proceeds to the Pocketbase hop keyed by the AniList id",
  );
  assertEquals(res.payload.found, true);
  assertEquals(res.payload.alID, 123);
  assertEquals(
    res.payload.title,
    "Whatever",
    "AniList resolved an empty title (m.title??{} -> {} -> '') which falls back to the caller's raw title via the already-pinned `||` semantics (see the methods suite's dedicated `||` pin)",
  );
});

Deno.test("FIXED (LB6): a Pocketbase response with NO `items` key at all (not merely empty []) no longer crashes — fetchSeadex now guards with Array.isArray(data.items), treating a malformed/hostile envelope as not-found — the SYMMETRIC Pocketbase-side parallel of the AniList title-absent fix above", async () => {
  const { ctx, written } = makeCtx();
  // A hostile/malformed Pocketbase list envelope missing `items` entirely.
  const noItemsKey = { page: 1, perPage: 30, totalItems: 0, totalPages: 0 };
  await withFetchStub([pocketbaseRoute(noItemsKey)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 70 }, ctx);
  });
  const res = written.find((w) => w.name === "al-70")!;
  assert(res, "expected a written entry keyed al-70");
  assertEquals(res.payload.found, false);
});

Deno.test("FIXED (LB6): a 200-OK response with a non-JSON body now rejects with a MAPPED Error (not an uncaught SyntaxError), on BOTH upstream contracts — resp.ok is still checked before .json() runs, but the .json() call itself is now try/catch-wrapped so a WAF/CDN error page served at HTTP 200 degrades into a normal rejection instead of an uncaught parse exception", async () => {
  const { ctx: pbCtx } = makeCtx();
  await withFetchStub(
    [pocketbaseTextRoute("<html>not json</html>", 200)],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-anilist-id", { anilistId: 71 }, pbCtx),
        Error,
      );
      assert(
        !(err instanceof SyntaxError),
        "the raw SyntaxError must be mapped, not surfaced uncaught",
      );
      assert((err as Error).message.startsWith("fetch "));
    },
  );

  const { ctx: alCtx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      return url.hostname === "graphql.anilist.co"
        ? new Response("<html>not json</html>", { status: 200 })
        : undefined;
    }],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-title", { title: "Whatever" }, alCtx),
        Error,
      );
      assert(
        !(err instanceof SyntaxError),
        "the raw SyntaxError must be mapped, not surfaced uncaught",
      );
      assert((err as Error).message.startsWith("anilist search failed:"));
    },
  );
});

Deno.test("FIXED (LB6): a malformed `expand.trs` array element (e.g. `null`) no longer crashes — non-object elements are filtered out before normaliseTorrent runs, symmetric to the items-absent/title-absent fixes above", async () => {
  const { ctx, written } = makeCtx();
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 72;
  // deno-lint-ignore no-explicit-any
  hostile.items[0].expand!.trs = [null as any];
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 72 }, ctx);
  });
  const res = written.find((w) => w.name === "al-72")!;
  assert(res);
  assertEquals(res.payload.bestReleases, []);
  assertEquals(res.payload.alternativeReleases, []);
});

Deno.test("FIXED (LB6): a mixed array of a VALID torrent + a `null` expand.trs element SURVIVES — the null is dropped, the valid torrent is still normalised", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 73;
  const validTorrent = {
    id: "tr_valid",
    releaseGroup: "ValidGroup",
    tracker: "ValidTracker",
    url: "https://tracker.example/valid",
    infoHash: "3334567890123456789012345678901234567890",
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    files: [{ name: "valid.mkv", length: 100 }],
  };
  // deno-lint-ignore no-explicit-any
  hostile.items[0].expand!.trs = [validTorrent, null as any];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 73 }, ctx);
  });
  const res = written.find((w) => w.name === "al-73")!;
  assert(res);
  assertEquals((res.payload.bestReleases as unknown[]).length, 1);
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.releaseGroup, "ValidGroup");
});

// ---------------------------------------------------------------------------
// FIXED (LB3, HIGH, with an EXPLICIT poisoned writeResource): the
// entry-writing loop in lookup-many is now per-item try/catch ISOLATED
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB3): the entry writeResource loop is now individually try/catch-isolated — one poisoned write no longer discards the batch, and the summary is ALWAYS written", async () => {
  const { ctx, written } = makePoisonedCtx("entry", "al-2");
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-many", {
      items: [{ anilistId: 1 }, { anilistId: 2 }, { anilistId: 3 }],
    }, ctx);
  });
  const entryNames = written.filter((w) => w.spec === "entry").map((w) =>
    w.name
  );
  assert(
    entryNames.includes("al-1"),
    "al-1 lands despite al-2's poisoned write",
  );
  assert(
    entryNames.includes("al-3"),
    "al-3 lands despite al-2's poisoned write",
  );
  assert(
    !entryNames.includes("al-2"),
    "the poisoned al-2 write itself still fails — only its OWN write is lost, not the batch",
  );
  const summary = written.find((w) => w.spec === "summary");
  assert(
    summary,
    "the summary resource IS written even though one entry write rejected",
  );
  assertEquals(summary!.payload.total, 3);
});

Deno.test("FIXED (LB3): poisoning the SUMMARY write itself does not affect entry writes — all N entries still land", async () => {
  const { ctx, written } = makePoisonedCtx("summary", "lookup-many");
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-many", {
      items: [{ anilistId: 1 }, { anilistId: 2 }, { anilistId: 3 }],
    }, ctx);
  });
  const entries = written.filter((w) => w.spec === "entry");
  assertEquals(
    entries.length,
    3,
    "all 3 entries land even though the summary write rejects",
  );
  assertEquals(
    written.find((w) => w.spec === "summary"),
    undefined,
    "the poisoned summary write itself still fails to land (only its own write is lost)",
  );
});

// ---------------------------------------------------------------------------
// FIXED (LB6): hostile file.length as a string now coerces NUMERICALLY
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB6, ex BUG-6): a hostile file.length arriving as a STRING now coerces NUMERICALLY via Number(f.length)||0 — totalSizeBytes is 999 (a number), not the old '0999' string-concatenation", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 50;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile",
    releaseGroup: "HostileGroup",
    tracker: "HostileTracker",
    url: "https://tracker.example/hostile",
    infoHash: "cccccccccccccccccccccccccccccccccccccccc",
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    // deno-lint-ignore no-explicit-any
    files: [{ name: "hostile.mkv", length: "999" as any }],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 50 }, ctx);
  });
  const res = written.find((w) => w.name === "al-50")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(
    best.totalSizeBytes,
    999,
    "Number(f.length)||0 coerces the STRING '999' into the NUMBER 999 before summing",
  );
  assert(
    typeof best.totalSizeBytes === "number",
    "confirms the fix: totalSizeBytes is a NUMBER here, matching the z.number() the schema declares",
  );
});

Deno.test("FIXED (LB6): MULTIPLE hostile files with STRING lengths now sum NUMERICALLY (not string-concatenated)", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 53;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile4",
    releaseGroup: "HostileGroup",
    tracker: "HostileTracker",
    url: "https://tracker.example/hostile4",
    infoHash: "1234567890123456789012345678901234567890",
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    files: [
      // deno-lint-ignore no-explicit-any
      { name: "a.mkv", length: "500" as any },
      // deno-lint-ignore no-explicit-any
      { name: "b.mkv", length: "250" as any },
    ],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 53 }, ctx);
  });
  const res = written.find((w) => w.name === "al-53")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.totalSizeBytes, 750);
  assert(typeof best.totalSizeBytes === "number");
});

Deno.test("FIXED (LB6): a junk (non-numeric) file.length coerces to 0, not NaN and not string-concatenation", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 54;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile5",
    releaseGroup: "HostileGroup",
    tracker: "HostileTracker",
    url: "https://tracker.example/hostile5",
    infoHash: "2234567890123456789012345678901234567890",
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    // deno-lint-ignore no-explicit-any
    files: [{ name: "junk.mkv", length: "not-a-number" as any }],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 54 }, ctx);
  });
  const res = written.find((w) => w.name === "al-54")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.totalSizeBytes, 0);
});

Deno.test("PIN: a hostile non-array `tags` field passes through verbatim (?? only guards null/undefined, not wrong-type truthy values)", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 51;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile2",
    releaseGroup: "HostileGroup",
    tracker: "HostileTracker",
    url: "https://tracker.example/hostile2",
    infoHash: "dddddddddddddddddddddddddddddddddddddddd",
    isBest: true,
    dualAudio: false,
    // deno-lint-ignore no-explicit-any
    tags: "not-an-array" as any,
    files: [],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 51 }, ctx);
  });
  const res = written.find((w) => w.name === "al-51")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(
    best.tags,
    "not-an-array",
    "a truthy non-array `tags` value is NOT coerced to an array — `?? []` only substitutes for null/undefined",
  );
});

Deno.test("PIN: a torrent with files entirely absent -> totalSizeBytes 0, fileCount 0, primaryFile null (no crash)", async () => {
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 52;
  const trs = hostile.items[0].expand!.trs![0];
  // deno-lint-ignore no-explicit-any
  delete (trs as any).files;
  hostile.items[0].expand!.trs = [trs];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 52 }, ctx);
  });
  const res = written.find((w) => w.name === "al-52")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(best.totalSizeBytes, 0);
  assertEquals(best.fileCount, 0);
  assertEquals(best.primaryFile, null);
});

// ---------------------------------------------------------------------------
// FIXED (LB5): duplicate input IDs are now DEDUPED (first-wins) BEFORE fan-out
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB5): duplicate anilistId within one lookup-many call is now DEDUPED before fan-out — al-77 is written ONCE, summary.total is 1", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run(
      "lookup-many",
      { items: [{ anilistId: 77 }, { anilistId: 77 }] },
      ctx,
    );
  });
  const entryWrites = written.filter((w) =>
    w.spec === "entry" && w.name === "al-77"
  );
  assertEquals(
    entryWrites.length,
    1,
    "deduped before fan-out — the SAME anilistId no longer produces two writes",
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(
    summary.payload.total,
    1,
    "summary.total now reflects the DEDUPED count, not the raw array length",
  );
  assertEquals((summary.payload.notInSeadex as unknown[]).length, 1);
});

Deno.test("FIXED (LB5): FIRST-WINS dedup semantics — duplicate anilistId with differing metadata keeps the FIRST item's fields", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-many", {
      items: [
        { anilistId: 5, userScore: 10 },
        { anilistId: 5, userScore: 99 },
      ],
    }, ctx);
  });
  const entries = written.filter((w) =>
    w.spec === "entry" && w.name === "al-5"
  );
  assertEquals(entries.length, 1);
  assertEquals(
    entries[0].payload.userScore,
    10,
    "first-wins: the SECOND duplicate's userScore:99 is dropped",
  );
});

Deno.test("FIXED (LB5): [1,2,1,3] dedups to 3 unique ids -> summary.total is 3, not 4", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-many", {
      items: [
        { anilistId: 1 },
        { anilistId: 2 },
        { anilistId: 1 },
        { anilistId: 3 },
      ],
    }, ctx);
  });
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 3);
});

// ---------------------------------------------------------------------------
// FIXED (LB4): an errored item is now tallied SEPARATELY from not-found
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB4): an errored lookup-many item is now tallied SEPARATELY in summary.errors and EXCLUDED from notInSeadex — errors===1, notInSeadex===[2]", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.searchParams.get("filter") === "(alID=1)") {
        return new Response("boom", { status: 500 });
      }
      return json(pocketbaseEmpty);
    }],
    async () => {
      await run(
        "lookup-many",
        { items: [{ anilistId: 1 }, { anilistId: 2 }] },
        ctx,
      );
    },
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 2);
  assertEquals(summary.payload.found, 0);
  assertEquals(
    summary.payload.errors,
    1,
    "the errored al-1 item is now tallied in summary.errors",
  );
  const notInSeadex = summary.payload.notInSeadex as Array<{ alID: number }>;
  assertEquals(
    notInSeadex.map((n) => n.alID),
    [2],
    "the errored al-1 item is EXCLUDED from notInSeadex now that it has its own tally",
  );
});

Deno.test("lookup-many: happy path with no errors -> summary.errors is 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(pocketbaseEmpty)], async () => {
    await run("lookup-many", { items: [{ anilistId: 200 }] }, ctx);
  });
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.errors, 0);
});

Deno.test("lookup-many: mixed error + miss + found tallies correctly across summary.found/errors/notInSeadex", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      const filter = url.searchParams.get("filter");
      if (filter === "(alID=301)") {
        return new Response("boom", { status: 500 });
      }
      if (filter === "(alID=302)") return json(pocketbaseEntry);
      return json(pocketbaseEmpty);
    }],
    async () => {
      await run("lookup-many", {
        items: [
          { anilistId: 301 },
          { anilistId: 302 },
          { anilistId: 303 },
        ],
      }, ctx);
    },
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 3);
  assertEquals(summary.payload.found, 1);
  assertEquals(summary.payload.errors, 1);
  const notInSeadex = summary.payload.notInSeadex as Array<{ alID: number }>;
  assertEquals(notInSeadex.map((n) => n.alID), [303]);
});

// ---------------------------------------------------------------------------
// FIXED (LB8): infoHash is now trimmed + lowercased (length is still NOT
// validated)
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB8): infoHash is now TRIMMED and LOWERCASED — whitespace padding and case are normalized (the wrong-length value itself is still NOT validated)", async () => {
  const raw = "  AABBCCDDEEFF00112233445566778899AABBCC  ";
  const hostile = clonePocketbaseEntry();
  hostile.items[0].alID = 60;
  hostile.items[0].expand!.trs = [{
    id: "tr_hostile3",
    releaseGroup: "G",
    tracker: "T",
    url: "https://tracker.example/x",
    infoHash: raw,
    isBest: true,
    dualAudio: false,
    tags: [],
    files: [],
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 60 }, ctx);
  });
  const res = written.find((w) => w.name === "al-60")!;
  const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[0];
  assertEquals(
    best.infoHash,
    raw.trim().toLowerCase(),
    "trimmed + lowercased — the (wrong, 36-char) length itself is still never validated",
  );
});

Deno.test("FIXED (LB8): infoHash normalization handles pure-uppercase and whitespace-only values", async () => {
  async function infoHashFor(raw: string, alID: number): Promise<string> {
    const hostile = clonePocketbaseEntry();
    hostile.items[0].alID = alID;
    hostile.items[0].expand!.trs = [{
      id: `tr_hash_${alID}`,
      releaseGroup: "G",
      tracker: "T",
      url: `https://tracker.example/${alID}`,
      infoHash: raw,
      isBest: true,
      dualAudio: false,
      tags: [],
      files: [],
    }];
    const { ctx, written } = makeCtx();
    await withFetchStub([pocketbaseRoute(hostile)], async () => {
      await run("lookup-by-anilist-id", { anilistId: alID }, ctx);
    });
    const res = written.find((w) => w.name === `al-${alID}`)!;
    return (res.payload.bestReleases as Array<{ infoHash: string }>)[0]
      .infoHash;
  }
  assertEquals(
    await infoHashFor("AABBCCDDEEFF00112233445566778899AABBCC", 61),
    "aabbccddeeff00112233445566778899aabbcc",
    "pure uppercase, no padding -> lowercased",
  );
  assertEquals(
    await infoHashFor("   ", 62),
    "",
    "whitespace-only -> trimmed to an empty string",
  );
});

// ---------------------------------------------------------------------------
// FIXED (LB7): a divergent server-returned alID no longer leaks into content
// ---------------------------------------------------------------------------

Deno.test("FIXED (LB7): a hostile Pocketbase response whose alID field DIVERGES from the requested filter no longer leaks into content — both the resource KEY and content.alID now use the REQUESTED id", async () => {
  const divergent = clonePocketbaseEntry();
  divergent.items[0].alID = 999999;
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(divergent)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
  });
  const res = written.find((w) => w.name === "al-1")!;
  assert(
    res,
    "the resource key is derived from the REQUESTED anilistId (args.anilistId), not the server's response",
  );
  assertEquals(
    res.payload.alID,
    1,
    "content.alID now uses buildResult's REQUESTED alID parameter, aligning with the al-1 key — the server's divergent 999999 value is ignored",
  );
  assertEquals(
    written.find((w) => w.name === "al-999999"),
    undefined,
    "no resource is ever written under the server's divergent id",
  );
});

// ---------------------------------------------------------------------------
// Trust boundary — hostile upstream content echoes verbatim, no redaction
// ---------------------------------------------------------------------------

Deno.test("PIN: hostile upstream `notes` content is stored VERBATIM — seadex is credential-less (no vault secret exists to leak), so this is a hostile-CONTENT trust-boundary concern, not a credential leak", async () => {
  const hostile = clonePocketbaseEntry();
  const SENTINEL = "internal-tracker-invite-code-9f8e7d6c5b4a";
  hostile.items[0].notes = `See invite thread — code: ${SENTINEL}`;
  const { ctx, written } = makeCtx();
  await withFetchStub([pocketbaseRoute(hostile)], async () => {
    await run("lookup-by-anilist-id", { anilistId: 1 }, ctx);
  });
  const res = written.find((w) => w.name === "al-1")!;
  assert(
    (res.payload.notes as string).includes(SENTINEL),
    "seadex.ts performs NO redaction of upstream content — whatever releases.moe returns in `notes` is stored verbatim",
  );
});

Deno.test("PIN: a hostile Pocketbase error body is embedded verbatim (up to 200 chars) into the thrown error — no redaction", async () => {
  const SENTINEL = "leak-marker-4b3c2a1f9e8d7c6b5a4938271605f4e3";
  const { ctx } = makeCtx();
  await withFetchStub(
    [pocketbaseTextRoute(`upstream failure, ref=${SENTINEL}`, 502)],
    async () => {
      const err = await assertRejects(
        () => run("lookup-by-anilist-id", { anilistId: 1 }, ctx),
        Error,
      );
      assert(
        (err as Error).message.includes(SENTINEL),
        "the thrown error embeds the upstream response body verbatim, no redaction of any kind",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — seadex-specific patterns + per-pattern poisoned
// sanity backstop
// ---------------------------------------------------------------------------

/** Count of DISTINCT characters in a string — a cheap proxy for entropy that
 * cleanly tells a real random-looking secret/hash (near-full alphabet usage)
 * apart from a repeated-character placeholder like our infoHash fixtures'
 * 40 lowercase 'a's / 'b's (1 distinct character), without pulling in a real
 * Shannon-entropy library for a test-only heuristic. */
function distinctCharCount(s: string): number {
  return new Set(s).size;
}

const SECRET_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  {
    name: "generic secret/credential keyword",
    test: (s) => /\b(SECRET|PASSWORD|API[_-]?KEY|BEARER)\b/i.test(s),
  },
  // A real-looking 40-hex SHA-1-shaped infoHash. Our own fixtures use 40
  // REPEATED characters ('a's / 'b's / 'c's / 'd's) as placeholders — 1
  // distinct character each — so the entropy escape (>= 10 distinct chars)
  // is required directly on THIS pattern (unlike a generic hash-shape check,
  // seadex's own committed fixtures are hex-shaped-and-40-chars-long by
  // design, so the pattern must actively distinguish real from placeholder).
  {
    name: "real-looking 40-hex infoHash",
    test: (s) => /^[a-f0-9]{40}$/i.test(s) && distinctCharCount(s) >= 10,
  },
  // Generic high-entropy blob backstop: 32+ alnum/base64url characters with
  // meaningful character diversity — catches anything token/secret-shaped
  // that doesn't match the two patterns above.
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

// SCOPE NOTE (security review, test-review round 1): this scan covers only
// the 5 committed fixture JSON files below — it does NOT scan this file's
// (or the other suites') own inline hostile-payload string literals (e.g.
// SENTINEL constants, inline infoHash placeholders). Those are reviewed
// manually; a future test author adding a new inline "realistic" secret-like
// literal is not caught by this mechanical gate. Prefer adding new hostile
// wire-shape corpora to fixtures/ (where this scan protects them) over
// inline literals when the value could plausibly resemble a real secret.
const FIXTURES: Record<string, unknown> = {
  "pocketbase-entry.json": pocketbaseEntry,
  "pocketbase-empty.json": pocketbaseEmpty,
  "anilist-media.json": anilistMedia,
  "anilist-nomatch.json": anilistNomatch,
  "anilist-graphql-error.json": anilistGraphqlError,
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

Deno.test("fixtures-secret-scan: the LOW-entropy infoHash placeholders (40 repeated chars) pass cleanly — the entropy escape works both ways", () => {
  const placeholders = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  for (const p of placeholders) {
    assertEquals(distinctCharCount(p), 1);
    for (const { name, test } of SECRET_PATTERNS) {
      assert(
        !test(p),
        `placeholder "${p}" incorrectly matched pattern "${name}"`,
      );
    }
  }
});

Deno.test("fixtures-secret-scan: sanity — each of the three patterns is independently proven to fire against its OWN tailored poison (not just aggregate non-emptiness)", () => {
  const perPatternPoison: Record<string, string> = {
    "generic secret/credential keyword": "API_KEY=abc123def456",
    "real-looking 40-hex infoHash": "1a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d",
    "high-entropy token-shaped value": "Qx7Lm2Zp9Kv4Tn6Wy1Cs8Dg5Fh0Jr3Ub",
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
