/**
 * Property-based tests (fast-check) for @magistr/shoko.
 *
 * shoko.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the captured request URL / written resource, per the approved plan.
 *
 * Properties:
 *  (a) list-series's query-builder is injective over the canonical
 *      (non-collapsing) input subset: page a positive int, pageSize a
 *      positive int <= 1000, startsWith either undefined or a non-empty
 *      string — restricted per the round-1 review finding that naive
 *      injectivity is FALSE over the raw input space (startsWith '' vs
 *      undefined collapse to the same query string).
 *  (b) series-list round-trip — list-series's written `items` preserve every
 *      generated `List` entry, in order, with `total` following
 *      `data.Total ?? items.length`.
 *  (c) pagination resource-naming — the written resource name is exactly
 *      `page-${page}` for any positive page number; distinct pages produce
 *      distinct names, equal pages produce the identical name.
 *  (d) named collapse — startsWith '' and startsWith omitted produce an
 *      IDENTICAL query string for any page/pageSize.
 *  (e) named example (not a property) — search-series's
 *      `search-${query.slice(0, 30)}` resource name CLOBBERS across two
 *      distinct queries sharing the same 30-character prefix.
 *  (f) Array.isArray round-trip — queue-status/list-import-folders/
 *      search-series preserve any array body unchanged; for any non-array,
 *      non-null JSON scalar/object body, list-import-folders/search-series
 *      collapse to [] while queue-status wraps it as a single-element array.
 *      Stated as three INDEPENDENT properties (round-1 test-review MEDIUM
 *      finding), not one combined boolean, so a future regression in any one
 *      of the three methods shrinks to a counterexample in the specific test
 *      that diverged rather than an undifferentiated combined failure.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./shoko.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HOST = "http://203.0.113.10:8111";

const GLOBAL_ARGS = {
  host: HOST,
  apiKey: "fixture-shoko-key-0001",
  userAgent: "swamp-shoko-test/1.0",
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

type Route = (req: Request) => Response | undefined;

// Eager plain-object snapshot instead of `.clone()` — cloning a body-bearing
// Request tees its body into a ReadableStream that is never consumed or
// cancelled, leaking ~6KB per stubbed fetch call (see
// fix/soak-property-harness-heap-leak). The body is read ONCE via
// `await req.text()`; routes get a freshly reconstructed Request built from
// the captured text so existing route logic (which may itself read the
// body) keeps working.
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
    for (const r of routes) {
      const res = r(routable);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
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

/** Run list-series with the given args against a stubbed empty-list response
 * and return the exact request URL (query string + path). */
async function listSeriesUrlFor(
  args: Record<string, unknown>,
): Promise<URL> {
  const { ctx } = makeCtx();
  let url = new URL(HOST);
  await withFetchStub([() => json({ Total: 0, List: [] })], async (calls) => {
    await run("list-series", args, ctx);
    url = new URL(calls[0].url);
  });
  return url;
}

// ---------------------------------------------------------------------------
// (a) list-series query-builder injectivity, over the canonical subset
// ---------------------------------------------------------------------------

// Restricted to the CANONICAL subset: startsWith either undefined or a
// non-empty string (excludes the '' vs undefined collapse, pinned separately
// in (d) below). Within this subset the query builder is genuinely
// injective: distinct (page, pageSize, startsWith) tuples yield distinct
// query strings.
const arbCanonicalListSeriesInput = fc.record({
  page: fc.integer({ min: 1, max: 999999 }),
  pageSize: fc.integer({ min: 1, max: 1000 }),
  startsWith: fc.option(fc.stringMatching(/^[A-Za-z0-9]{1,10}$/), {
    nil: undefined,
  }),
});

function canonicalSignature(input: Record<string, unknown>): string {
  return JSON.stringify([input.page, input.pageSize, input.startsWith]);
}

Deno.test("property: list-series's request URL is deterministic — same canonical input -> same URL", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalListSeriesInput, async (input) => {
      const a = await listSeriesUrlFor(input);
      const b = await listSeriesUrlFor(input);
      return a.toString() === b.toString();
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: list-series's request URL is INJECTIVE over the canonical (non-collapsing) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalListSeriesInput,
      arbCanonicalListSeriesInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const urlA = (await listSeriesUrlFor(a)).toString();
        const urlB = (await listSeriesUrlFor(b)).toString();
        return sigA === sigB ? urlA === urlB : urlA !== urlB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});

// ---------------------------------------------------------------------------
// (b) series-list round-trip
// ---------------------------------------------------------------------------

const arbSeriesItem = fc.record({
  IDs: fc.record({ ID: fc.integer({ min: 1, max: 999999 }) }),
  Name: fc.stringMatching(/^[A-Za-z0-9 ]{1,30}$/),
});

Deno.test("property: list-series preserves every generated List entry, in order, with total following Total ?? items.length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbSeriesItem, { minLength: 0, maxLength: 12 }),
      fc.option(fc.integer({ min: 0, max: 999999 }), { nil: undefined }),
      async (list, total) => {
        const { ctx, written } = makeCtx();
        const body: Record<string, unknown> = { List: list };
        if (total !== undefined) body.Total = total;
        await withFetchStub([() => json(body)], async () => {
          await run("list-series", {}, ctx);
        });
        const res = written.find((w) => w.spec === "series")!;
        const expectedTotal = total ?? list.length;
        return (
          JSON.stringify(res.payload.items) === JSON.stringify(list) &&
          res.payload.total === expectedTotal
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) pagination resource-naming
// ---------------------------------------------------------------------------

Deno.test("property: list-series's written resource name is exactly 'page-<page>' for any positive page", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 999999 }), async (page) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json({ Total: 0, List: [] })], async () => {
        await run("list-series", { page }, ctx);
      });
      const res = written.find((w) => w.spec === "series")!;
      return res.name === `page-${page}`;
    }),
    FC_RUNS,
  );
});

Deno.test("property: distinct page numbers produce distinct resource names; equal page numbers produce the identical name", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 999999 }),
      fc.integer({ min: 1, max: 999999 }),
      async (pageA, pageB) => {
        const { ctx: ctxA, written: writtenA } = makeCtx();
        await withFetchStub([() => json({ Total: 0, List: [] })], async () => {
          await run("list-series", { page: pageA }, ctxA);
        });
        const { ctx: ctxB, written: writtenB } = makeCtx();
        await withFetchStub([() => json({ Total: 0, List: [] })], async () => {
          await run("list-series", { page: pageB }, ctxB);
        });
        const nameA = writtenA.find((w) => w.spec === "series")!.name;
        const nameB = writtenB.find((w) => w.spec === "series")!.name;
        return pageA === pageB ? nameA === nameB : nameA !== nameB;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("list-series: page omitted defaults to 1, resource name 'page-1'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ Total: 0, List: [] })], async () => {
    await run("list-series", {}, ctx);
  });
  assertEquals(written.find((w) => w.spec === "series")!.name, "page-1");
});

// ---------------------------------------------------------------------------
// (d) named collapse — startsWith '' and undefined, for ANY page/pageSize
// ---------------------------------------------------------------------------

Deno.test("property: startsWith '' and startsWith omitted produce an IDENTICAL request URL for any page/pageSize", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 999999 }),
      fc.integer({ min: 1, max: 1000 }),
      async (page, pageSize) => {
        const withEmpty = await listSeriesUrlFor({
          page,
          pageSize,
          startsWith: "",
        });
        const withUndefined = await listSeriesUrlFor({ page, pageSize });
        return withEmpty.toString() === withUndefined.toString();
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) named example: search-series's 30-char resource-name clobber
// ---------------------------------------------------------------------------

Deno.test("collapse: search-series resource names CLOBBER when two distinct queries share the same 30-character prefix", async () => {
  const prefix = "a".repeat(30);
  const queryA = prefix + "-first-suffix";
  const queryB = prefix + "-second-suffix-differs";

  const { ctx: ctxA, written: writtenA } = makeCtx();
  await withFetchStub([() => json([])], async () => {
    await run("search-series", { query: queryA }, ctxA);
  });
  const { ctx: ctxB, written: writtenB } = makeCtx();
  await withFetchStub([() => json([])], async () => {
    await run("search-series", { query: queryB }, ctxB);
  });

  const nameA = writtenA.find((w) => w.spec === "series")!.name;
  const nameB = writtenB.find((w) => w.spec === "series")!.name;
  assertEquals(nameA, `search-${prefix}`);
  assertEquals(nameB, `search-${prefix}`);
  assertEquals(
    nameA,
    nameB,
    "two distinct queries sharing a 30-char prefix write the IDENTICAL resource name — the second clobbers the first in a real instance",
  );
});

// ---------------------------------------------------------------------------
// (f) Array.isArray round-trip / collapse — queue-status vs
// list-import-folders/search-series
// ---------------------------------------------------------------------------

const arbJsonArray = fc.array(
  fc.oneof(
    fc.integer(),
    fc.string({ maxLength: 20 }),
    fc.boolean(),
    fc.dictionary(fc.string({ maxLength: 10 }), fc.integer()),
  ),
  { minLength: 0, maxLength: 8 },
);

Deno.test("property: queue-status preserves any array body unchanged", async () => {
  await fc.assert(
    fc.asyncProperty(arbJsonArray, async (arr) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(arr)], async () => {
        await run("queue-status", {}, ctx);
      });
      const res = written.find((w) => w.spec === "queue")!;
      return JSON.stringify(res.payload.items) === JSON.stringify(arr);
    }),
    FC_RUNS,
  );
});

Deno.test("property: list-import-folders preserves any array body unchanged", async () => {
  await fc.assert(
    fc.asyncProperty(arbJsonArray, async (arr) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(arr)], async () => {
        await run("list-import-folders", {}, ctx);
      });
      const res = written.find((w) => w.spec === "importFolders")!;
      return (
        JSON.stringify(res.payload.folders) === JSON.stringify(arr) &&
        res.payload.total === arr.length
      );
    }),
    FC_RUNS,
  );
});

// Non-array, non-null JSON values: an integer, a string, a boolean, or a
// plain object — the domain Array.isArray reliably rejects.
const arbNonArrayJsonValue = fc.oneof(
  fc.integer(),
  fc.string({ maxLength: 20 }),
  fc.boolean(),
  fc.dictionary(fc.string({ maxLength: 10 }), fc.integer()),
);

// Split into three independent properties (round-1 test-review MEDIUM
// finding) rather than one combined boolean AND: a future regression in any
// single one of these three methods now shrinks to a counterexample in the
// SPECIFIC test that diverged, instead of an undifferentiated failure that
// requires manually re-running the input against all three methods to
// localize which one actually broke.

Deno.test("property: for any non-array JSON body, list-import-folders collapses to []", async () => {
  await fc.assert(
    fc.asyncProperty(arbNonArrayJsonValue, async (value) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(value)], async () => {
        await run("list-import-folders", {}, ctx);
      });
      const res = written.find((w) => w.spec === "importFolders")!;
      return JSON.stringify(res.payload.folders) === "[]";
    }),
    FC_RUNS,
  );
});

Deno.test("property: for any non-array JSON body, search-series collapses to []", async () => {
  await fc.assert(
    fc.asyncProperty(arbNonArrayJsonValue, async (value) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(value)], async () => {
        await run("search-series", { query: "x" }, ctx);
      });
      const res = written.find((w) => w.spec === "series")!;
      return JSON.stringify(res.payload.items) === "[]";
    }),
    FC_RUNS,
  );
});

Deno.test("property: for any non-array JSON body, queue-status wraps it as [value]", async () => {
  await fc.assert(
    fc.asyncProperty(arbNonArrayJsonValue, async (value) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(value)], async () => {
        await run("queue-status", {}, ctx);
      });
      const res = written.find((w) => w.spec === "queue")!;
      return JSON.stringify(res.payload.items) === JSON.stringify([value]);
    }),
    FC_RUNS,
  );
});
