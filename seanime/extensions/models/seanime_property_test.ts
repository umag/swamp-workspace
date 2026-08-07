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
import { assert, assertEquals } from "jsr:@std/assert@1";
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

// Eager plain-object snapshot instead of `.clone()` — cloning a body-bearing
// Request tees its body into a ReadableStream that is never consumed or
// cancelled, leaking ~6KB per stubbed fetch call (see
// fix/soak-property-harness-heap-leak, and the heap-leak regression pin
// further down this file). The body is read ONCE via `await req.text()`;
// routes get a freshly reconstructed Request built from the captured text
// so existing route logic (which may itself read the body) keeps working.
type CapturedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
};

async function withFetchStub(
  routes: Route[],
  fn: (calls: CapturedRequest[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const body = await req.text();
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    const routable = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    for (const route of routes) {
      const res = await route(routable);
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

// ---------------------------------------------------------------------------
// Heap-leak regression pin (fix/soak-property-harness-heap-leak)
// ---------------------------------------------------------------------------

// withFetchStub's `calls.push(req.clone())` above tees each stubbed
// Request's body into a ReadableStream that is never consumed or cancelled.
// This pin drives sync-planning-rules' heaviest fixed shape (15 unique,
// all-eligible PLANNING entries -> 2 baseline reads + 15 POSTs = 17
// body-bearing fetch calls/iteration, the most of any property in this
// file) IN-PROCESS for a FIXED iteration count -- deterministic, no
// subprocess, no extra deno.json permissions beyond the --v8-flags runtime
// flag below.
//
// Measuring `Deno.memoryUsage().heapUsed` without forcing a GC cycle
// conflates uncollected garbage with genuinely retained memory: an early
// (unforced-GC) round of this pin measured 100.7/85.2/100.4MB for a faithful
// eager-snapshot fix against a 100MB bound -- flaky, 2 of 3 runs over
// bound. Forcing a full GC immediately before *and* after the timing window
// separates the two regimes cleanly. `gc` is only defined when the process
// is launched with `--v8-flags=--expose-gc` (wired into this extension's
// `test` and `test:soak` tasks in deno.json); under a plain `deno test`
// (e.g. a contributor running the file directly) `gc` is undefined and the
// pin is marked `ignore` instead of silently passing or throwing, so the
// rest of the file still runs clean. Deno's test runner has no separate
// ignore-reason field — `deno test` only ever prints a bare `ignored (0ms)`
// for a skipped test, regardless of `ignore`'s value, so the reason is
// appended to the test NAME itself instead; that's the only place it is
// actually surfaced in `deno test` output.
//
// This pin is also SKIPPED when FC_NUM_RUNS is set above HEAP_PIN_ITERS
// (e.g. the nightly soak's FC_NUM_RUNS=1000000, or `test:soak`'s 10000).
// It exists as a regression guard for the ordinary CI suite (`deno task
// test`, no FC_NUM_RUNS, default 200 property runs) — in the soak this same
// process has already run every OTHER property in this file at up to
// 1,000,000 iterations before reaching this test, which measurably shifts
// GC-timing margins (14-26% swings were observed between a filtered
// single-test run and a full-file run even WITH forced GC). At soak scale
// the static `.clone()`-ban gate (check_property_harness.ts) is the actual
// safety net, not this fixed-iteration pin — running it there would only
// add flake, not coverage.
//
// Measured directly on this branch (forced GC before/after,
// Deno 2.7.13 x86_64-apple-darwin macOS, idle laptop, `deno test
// --v8-flags=--expose-gc --allow-env=FC_NUM_RUNS extensions/models/`,
// 8 runs per figure — see fix/soak-property-harness-heap-leak PR
// description for the full spread):
//   - WITH req.clone() (today, this branch): heapUsed grows 112-132MB over
//     6,000 iterations, worst (lowest) observed run 112.21MB.
//   - WITHOUT it (a faithful eager-snapshot prototype of the planned fix —
//     snapshot {method,url,body}, reconstruct a Request only when a body
//     exists): heapUsed grows 0.1-0.8MB over the same 6,000 iterations —
//     ordinary GC-reclaimable per-iteration garbage, not a leak.
// These are indicative, not contractual — expect different absolute numbers
// on different hardware/Deno versions, but the same order-of-magnitude
// separation (the leaky regime clears the bound by >=22x on every run
// observed here; the snapshot regime never comes close to it). BOUND_MB=5
// gives the snapshot prototype's worst observed reading (0.8MB) a >=6x
// margin below the bound, while the leakiest-code worst reading (112.21MB)
// clears the bound by >=22x and the typical reading by >=23x.
const HEAP_PIN_ITERS = 6000;
const HEAP_PIN_BOUND_MB = 5;

const exposedGc = (globalThis as { gc?: () => void }).gc;
const heapPinSkipReason = exposedGc
  ? (ENV_RUNS && Number(ENV_RUNS) > HEAP_PIN_ITERS
    ? `FC_NUM_RUNS=${ENV_RUNS} exceeds HEAP_PIN_ITERS=${HEAP_PIN_ITERS} — ` +
      "this is a soak-scale run; the fixed-iteration heap pin is redundant " +
      "with the static .clone() gate there and would only add flake"
    : undefined)
  : "gc() is not exposed — run via `deno task test`/`test:soak` " +
    "(--v8-flags=--expose-gc) to exercise this pin";

const HEAP_PIN_NAME =
  "heap pin: sync-planning-rules bulk partition keeps heap growth under 5MB over 6,000 in-process iterations (forced GC)";

Deno.test({
  name: heapPinSkipReason
    ? `${HEAP_PIN_NAME} [SKIPPED: ${heapPinSkipReason}]`
    : HEAP_PIN_NAME,
  ignore: heapPinSkipReason !== undefined,
  fn: async () => {
    const gc = exposedGc!;
    const entries = Array.from({ length: 15 }, (_, i) => ({
      id: 9_000_000 + i,
      status: "RELEASING",
      title: { romaji: `Heap Pin Anime ${i}` },
    }));
    const collection = collectionOf(entries);
    // Positive control (see HIGH-1 finding): a plain number, incremented
    // once per stubbed fetch call. Deliberately NOT an array/object
    // accumulator — this counter must stay allocation-light itself so it
    // cannot distort the heap-delta measurement below.
    let totalFetchCalls = 0;
    const routes: Route[] = [(req) => {
      totalFetchCalls++;
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(collection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json({ data: [] });
      }
      return json({ data: { success: true } });
    }];

    // Force GC before the baseline sample too — a warm/cold heap from
    // whatever ran earlier in this process shifts the "before" reading just
    // as much as it shifts "after" if left unforced.
    gc();
    const before = Deno.memoryUsage().heapUsed;
    for (let i = 0; i < HEAP_PIN_ITERS; i++) {
      const { ctx } = makeCtx();
      await withFetchStub(routes, async () => {
        await run("sync-planning-rules", { includeFinished: true }, ctx);
      });
    }
    gc();
    const after = Deno.memoryUsage().heapUsed;

    // Positive control: prove the intended workload actually ran BEFORE
    // trusting the heap-delta assertion below. Every iteration drives 2
    // baseline reads (GET collection, GET rules) + 15 rule-creation POSTs
    // (all 15 fixed entries above are truthy-mediaId, unique, RELEASING,
    // and never pre-existing in the empty `rules` response, so all 15
    // always land in `created`) = 17 fetch calls, fixed and deterministic
    // across every iteration. Without this, a future change that silently
    // shrank the entry list, gutted the loop body, or changed the
    // created/skipped/failed routing would still pass the heap-delta
    // assertion below — measuring nothing.
    const expectedFetchCalls = HEAP_PIN_ITERS * 17;
    assertEquals(
      totalFetchCalls,
      expectedFetchCalls,
      `expected exactly ${expectedFetchCalls} fetch calls (${HEAP_PIN_ITERS} ` +
        "iterations x 17 calls/iteration: 2 baseline reads + 15 rule-" +
        `creation POSTs), got ${totalFetchCalls} — the pin's workload did ` +
        "not run as intended, so the heap-delta assertion below would be " +
        "measuring nothing",
    );

    const deltaMB = (after - before) / (1024 * 1024);
    assert(
      deltaMB < HEAP_PIN_BOUND_MB,
      `heap grew by ${
        deltaMB.toFixed(1)
      }MB over ${HEAP_PIN_ITERS} iterations (bound ${HEAP_PIN_BOUND_MB}MB) — ` +
        "withFetchStub's req.clone() leaks per stubbed call (see " +
        "fix/soak-property-harness-heap-leak)",
    );
  },
});
