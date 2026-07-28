/**
 * Property-based tests (fast-check) for @magistr/seanime.
 *
 * seanime.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the captured POST body / written resource, per the approved plan.
 *
 * Properties:
 *  (a) bulk partition invariant — for any generated PLANNING list, every
 *      entry with a truthy mediaId lands in exactly one of
 *      created/skipped/failed (holds even with duplicate mediaIds, since
 *      the loop counts array elements, not distinct ids). Stated for both
 *      bulk methods.
 *  (b1) sync-planning-rules re-run-no-double-apply — feeding run-1's
 *      creations back as existing rules yields created==[] on run-2.
 *  (b2) set-planning-watching re-run — over a fresh PLANNING list excluding
 *      departed entries, run-2 POSTs nothing; a paired named (non-property)
 *      test pins the same-list re-POST (non-idempotent in isolation).
 *  (c) rule-request-body injectivity, stated over the canonical
 *      (non-collapsing) subset — unique mediaIds, titles drawn only from the
 *      sanitizer's fixed-point charset (excludes `/[/:*?"<>|]/`) — plus a
 *      named collapse pin showing destination (sanitized) collapses while
 *      comparisonTitle (raw) does not, per the round-1 review finding.
 *  (d) torrent/list round-trip — array and {torrents:[...]} inputs both
 *      normalize losslessly to {torrents, timestamp}.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./seanime.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "http://seanime.example.com:3211",
  token: "property-fixture-token",
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

function collectionOf(
  entries: Array<{ id?: number; status?: string; title?: unknown } | null>,
) {
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

// ---------------------------------------------------------------------------
// (a) bulk partition invariant
// ---------------------------------------------------------------------------

const arbEntry = fc.record({
  // mediaId sometimes falsy (0 or absent), sometimes a real positive id —
  // both must be representable to exercise the `!mediaId` guard.
  id: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
  status: fc.constantFrom(
    "RELEASING",
    "NOT_YET_RELEASED",
    "FINISHED",
    "HIATUS",
    undefined,
  ),
  title: fc.constantFrom("Alpha", "Beta", "Gamma").map((t) => ({ romaji: t })),
});

Deno.test("property: sync-planning-rules partitions every truthy-mediaId entry into exactly one of created/skipped/failed, duplicates included", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbEntry, { minLength: 1, maxLength: 15 }),
      async (entries) => {
        const collection = collectionOf(entries);
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            if (url.pathname === "/api/v1/anilist/collection") {
              return json(collection);
            }
            if (url.pathname === "/api/v1/auto-downloader/rules") {
              return json({ data: [] });
            }
            return json({ data: { success: true } });
          }],
          async () => {
            await run("sync-planning-rules", { includeFinished: true }, ctx);
          },
        );
        const res = written.find((w) => w.spec === "ruleSyncResult")!;
        const partitioned = (res.payload.created as unknown[]).length +
          (res.payload.skipped as unknown[]).length +
          (res.payload.failed as unknown[]).length;
        const expectedCount = entries.filter((e) => e.id).length;
        return partitioned === expectedCount;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: set-planning-watching partitions every truthy-mediaId entry into exactly one of updated/skipped/failed, duplicates included", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbEntry, { minLength: 1, maxLength: 15 }),
      async (entries) => {
        const collection = collectionOf(entries);
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            if (url.pathname === "/api/v1/anilist/collection") {
              return json(collection);
            }
            return json({ data: { success: true } });
          }],
          async () => {
            await run("set-planning-watching", { includeFinished: true }, ctx);
          },
        );
        const res = written.find((w) => w.spec === "statusChangeResult")!;
        const partitioned = (res.payload.updated as unknown[]).length +
          (res.payload.skipped as unknown[]).length +
          (res.payload.failed as unknown[]).length;
        const expectedCount = entries.filter((e) => e.id).length;
        return partitioned === expectedCount;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b1) sync-planning-rules re-run-no-double-apply
// ---------------------------------------------------------------------------

const arbUniquePlanningIds = fc.uniqueArray(
  fc.integer({ min: 1, max: 100000 }),
  { minLength: 1, maxLength: 8 },
);

Deno.test("property: sync-planning-rules re-run — feeding run-1's creations back as existing rules yields created==[] on run-2", async () => {
  await fc.assert(
    fc.asyncProperty(arbUniquePlanningIds, async (ids) => {
      const entries = ids.map((id) => ({
        id,
        status: "RELEASING",
        title: { romaji: `Anime ${id}` },
      }));
      const collection = collectionOf(entries);

      // run-1: no existing rules -> every entry gets created.
      const { ctx: ctx1, written: written1 } = makeCtx();
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/anilist/collection") {
            return json(collection);
          }
          if (url.pathname === "/api/v1/auto-downloader/rules") {
            return json({ data: [] });
          }
          return json({ data: { success: true } });
        }],
        async () => {
          await run("sync-planning-rules", {}, ctx1);
        },
      );
      const created1 = written1.find((w) => w.spec === "ruleSyncResult")!
        .payload.created as Array<{ mediaId: number }>;

      // run-2: existing rules now include every run-1 creation.
      const { ctx: ctx2, written: written2 } = makeCtx();
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/anilist/collection") {
            return json(collection);
          }
          if (url.pathname === "/api/v1/auto-downloader/rules") {
            return json({
              data: created1.map((c) => ({ mediaId: c.mediaId })),
            });
          }
          throw new Error("run-2 must not POST any new rule");
        }],
        async () => {
          await run("sync-planning-rules", {}, ctx2);
        },
      );
      const res2 = written2.find((w) => w.spec === "ruleSyncResult")!;
      return (res2.payload.created as unknown[]).length === 0;
    }),
    { numRuns: NIGHT(100) },
  );
});

// ---------------------------------------------------------------------------
// (b2) set-planning-watching re-run — fresh exclude vs same-list negative pin
// ---------------------------------------------------------------------------

Deno.test("property: set-planning-watching re-run — a fresh PLANNING list excluding run-1's flips POSTs nothing on run-2", async () => {
  await fc.assert(
    fc.asyncProperty(arbUniquePlanningIds, async (ids) => {
      const entries = ids.map((id) => ({
        id,
        status: "RELEASING",
        title: { romaji: `Anime ${id}` },
      }));
      const collection = collectionOf(entries);

      const { ctx: ctx1 } = makeCtx();
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/anilist/collection") {
            return json(collection);
          }
          return json({ data: { success: true } });
        }],
        async () => {
          await run("set-planning-watching", {}, ctx1);
        },
      );

      // Fresh run-2: the departed entries are gone; keep one ineligible
      // "keeper" so the PLANNING list is never empty (avoids the
      // empty-PLANNING throw, which is a distinct, already-pinned guard).
      const freshCollection = collectionOf([
        { id: 999999, status: "FINISHED", title: { romaji: "Keeper" } },
      ]);
      const { ctx: ctx2, written: written2 } = makeCtx();
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/anilist/collection") {
            return json(freshCollection);
          }
          throw new Error("run-2 over a fresh (excluding) list must not POST");
        }],
        async () => {
          await run("set-planning-watching", {}, ctx2);
        },
      );
      const res2 = written2.find((w) => w.spec === "statusChangeResult")!;
      return (res2.payload.updated as unknown[]).length === 0;
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("NEGATIVE pin: the SAME PLANNING list run twice re-POSTs both times (set-planning-watching has no client-side idempotency guard)", async () => {
  const collection = collectionOf([
    { id: 500001, status: "RELEASING", title: { romaji: "Repeat Offender" } },
  ]);
  let posts = 0;
  const stub: Route = (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/anilist/collection") return json(collection);
    if (url.pathname === "/api/v1/anilist/list-entry") {
      posts++;
      return json({ data: { success: true } });
    }
    return undefined;
  };
  const { ctx: ctx1 } = makeCtx();
  await withFetchStub(
    [stub],
    async () => {
      await run("set-planning-watching", {}, ctx1);
    },
  );
  const { ctx: ctx2 } = makeCtx();
  await withFetchStub(
    [stub],
    async () => {
      await run("set-planning-watching", {}, ctx2);
    },
  );
  assertEquals(
    posts,
    2,
    "identical PLANNING list twice -> two independent POSTs",
  );
});

// ---------------------------------------------------------------------------
// (c) rule-request-body injectivity over the canonical (non-collapsing) subset
// ---------------------------------------------------------------------------

// Titles restricted to the sanitizer's FIXED-POINT charset — none of these
// characters are stripped by `title.replace(/[/:*?"<>|]/g, "")` — so the
// arbitrary never generates a title that collapses with another under
// sanitization. minLength 1 avoids the `||` falsy-title fallback chain.
const arbSafeTitle = fc.stringMatching(/^[A-Za-z0-9 _.,'-]{1,20}$/);

const arbCanonicalRuleInput = fc.record({
  mediaId: fc.integer({ min: 1, max: 999999 }),
  title: arbSafeTitle,
  libraryPath: fc.constantFrom("/anime/tv", "/media/anime"),
});

function canonicalSignature(input: Record<string, unknown>): string {
  return JSON.stringify([input.mediaId, input.title, input.libraryPath]);
}

/** Run sync-planning-rules for a single-entry PLANNING list and return the
 * exact parsed POST body sent to /auto-downloader/rule. */
async function ruleBodyFor(
  input: { mediaId: number; title: string; libraryPath: string },
): Promise<Record<string, unknown>> {
  const collection = collectionOf([
    { id: input.mediaId, status: "RELEASING", title: { romaji: input.title } },
  ]);
  const { ctx } = makeCtx();
  let body: Record<string, unknown> = {};
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        return requestBody(req).then((b) => {
          body = b;
          return json({ data: { success: true } });
        });
      }
      return undefined;
    }],
    async () => {
      await run("sync-planning-rules", { libraryPath: input.libraryPath }, ctx);
    },
  );
  return body;
}

Deno.test("property: sync-planning-rules' rule request body is deterministic — same canonical input -> same body", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalRuleInput, async (input) => {
      const a = await ruleBodyFor(input);
      const b = await ruleBodyFor(input);
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: sync-planning-rules' rule request body is INJECTIVE over the canonical (non-collapsing) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalRuleInput,
      arbCanonicalRuleInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const bodyA = JSON.stringify(await ruleBodyFor(a));
        const bodyB = JSON.stringify(await ruleBodyFor(b));
        return sigA === sigB ? bodyA === bodyB : bodyA !== bodyB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});

Deno.test("collapse: destination collapses for titles differing only in STRIPPED characters, but comparisonTitle (raw) does NOT", async () => {
  // Named per the round-1 review finding: title.replace(/[/:*?\"<>|]/g,\"\")
  // strips slashes/quotes/wildcards, so "My/Title" and "MyTitle" produce the
  // SAME destination — but comparisonTitle keeps the raw (unsanitized)
  // title, so the two bodies still differ overall. The request body is
  // injective on title, NOT on destination alone.
  const withSlash = await ruleBodyFor({
    mediaId: 600001,
    title: "My/Title",
    libraryPath: "/anime/tv",
  });
  const withoutSlash = await ruleBodyFor({
    mediaId: 600002,
    title: "MyTitle",
    libraryPath: "/anime/tv",
  });
  const ruleA = withSlash.rule as Record<string, unknown>;
  const ruleB = withoutSlash.rule as Record<string, unknown>;
  assertEquals(ruleA.destination, ruleB.destination, "destination collapses");
  assertEquals(ruleA.destination, "/anime/tv/MyTitle");
  assertEquals(
    ruleA.comparisonTitle !== ruleB.comparisonTitle,
    true,
    "comparisonTitle keeps the raw title — does NOT collapse",
  );
});

// ---------------------------------------------------------------------------
// (d) torrent/list round-trip
// ---------------------------------------------------------------------------

const arbTorrent = fc.record({
  name: fc.stringMatching(/^[a-zA-Z0-9. -]{1,30}$/),
  hash: fc.stringMatching(/^[a-f0-9]{1,40}$/),
  status: fc.constantFrom("downloading", "seeding", "paused", "completed"),
  progress: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
});

Deno.test("property: torrent-list round-trips a bare array losslessly into {torrents, timestamp}", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbTorrent, { minLength: 0, maxLength: 10 }),
      async (torrents) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([() => json({ data: torrents })], async () => {
          await run("torrent-list", {}, ctx);
        });
        const res = written.find((w) => w.spec === "torrents")!;
        return (
          JSON.stringify(res.payload.torrents) === JSON.stringify(torrents) &&
          typeof res.payload.timestamp === "string"
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: torrent-list round-trips an {torrents:[...]} object losslessly into {torrents, timestamp}", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbTorrent, { minLength: 0, maxLength: 10 }),
      async (torrents) => {
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [() => json({ data: { torrents } })],
          async () => {
            await run("torrent-list", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "torrents")!;
        return (
          JSON.stringify(res.payload.torrents) === JSON.stringify(torrents) &&
          typeof res.payload.timestamp === "string"
        );
      },
    ),
    FC_RUNS,
  );
});
