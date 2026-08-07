/**
 * Property-based tests (fast-check) for @magistr/dawarich.
 *
 * dawarich.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the written resource / captured request URL, per the approved plan.
 *
 * Properties:
 *  (a) parser round-trip — points/visits/tracks/photos preserve every
 *      generated element, in order, with count == length; absent and
 *      non-array bodies both yield [] with count 0.
 *  (b) request-builder injectivity for `points` over the CANONICAL query-arg
 *      subset (page/perPage restricted to undefined-or-positive, per the
 *      documented `if (args.page)` truthy-collapse pinned in
 *      dawarich_coverage_test.ts — page=0/perPage=0 are EXCLUDED from the
 *      canonical subset, mirroring tubearchivist's page=0 exclusion).
 *  (c) pagination-header round-trip — parseInt of an arbitrary non-negative
 *      integer string always recovers that integer.
 *
 * Coordinate-like fields generated below are EPHEMERAL property-test inputs
 * — never persisted to a fixture file, never logged, never committed — so
 * the doubled GPS fixture-leak discipline in fixtures/PROVENANCE.md (which
 * governs the COMMITTED corpus) does not apply to them; they exist only in
 * memory for the duration of a single fc.assert() run.
 *
 * FC_NUM_RUNS-gated (small in CI, large in `deno task test:soak`).
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./dawarich.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak). Needs
// `--allow-env=FC_NUM_RUNS` in the test task.
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://dawarich.example.com",
  apiKey: "dw_stub",
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

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

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// (a) parser round-trip — points / visits / tracks / photos
// ---------------------------------------------------------------------------

const arbPoint = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  latitude: fc.double({ min: -90, max: 90, noNaN: true }),
  longitude: fc.double({ min: -180, max: 180, noNaN: true }),
  timestamp: fc.stringMatching(
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/,
  ),
});

const METHOD_TABLE: Array<{ name: string; spec: string; field: string }> = [
  { name: "points", spec: "points", field: "points" },
  { name: "visits", spec: "visits", field: "visits" },
  { name: "tracks", spec: "tracks", field: "tracks" },
  { name: "photos", spec: "photos", field: "photos" },
];

for (const { name, spec, field } of METHOD_TABLE) {
  Deno.test(`property: ${name} preserves every generated element, in order, with count == length`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbPoint, { minLength: 0, maxLength: 20 }),
        async (records) => {
          const { ctx, written } = makeCtx();
          await withFetchStub([() => json(records)], async () => {
            await run(name, {}, ctx);
          });
          const res = written.find((w) => w.spec === spec)!;
          const stored = res.payload[field] as unknown[];
          if (JSON.stringify(stored) !== JSON.stringify(records)) return false;
          return res.payload.count === records.length;
        },
      ),
      FC_RUNS,
    );
  });
}

const arbNonArrayBody = fc.oneof(
  fc.record({ unexpected: fc.string() }),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

Deno.test("property: any non-array body (object/string/number/boolean/null) yields [] with count 0, across all four array-returning methods", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbNonArrayBody,
      fc.constantFrom(...METHOD_TABLE),
      async (body, { name, spec, field }) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([() => json(body)], async () => {
          await run(name, {}, ctx);
        });
        const res = written.find((w) => w.spec === spec)!;
        return (
          JSON.stringify(res.payload[field]) === "[]" &&
          res.payload.count === 0
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: tracked-months (no count field) also yields [] for any non-array body", async () => {
  await fc.assert(
    fc.asyncProperty(arbNonArrayBody, async (body) => {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(body)], async () => {
        await run("tracked-months", {}, ctx);
      });
      const res = written.find((w) => w.spec === "trackedMonths")!;
      return JSON.stringify(res.payload.months) === "[]";
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) request-builder injectivity — `points` over the CANONICAL query-arg
// subset (page/perPage restricted to positive integers, excluding the
// documented page=0/perPage=0 truthy-collapse)
// ---------------------------------------------------------------------------

const arbCanonicalPointsInput = fc.record({
  startAt: fc.option(
    fc.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    { nil: undefined },
  ),
  endAt: fc.option(
    fc.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    { nil: undefined },
  ),
  page: fc.option(fc.integer({ min: 1, max: 999999 }), { nil: undefined }),
  perPage: fc.option(fc.integer({ min: 1, max: 999999 }), { nil: undefined }),
  order: fc.option(fc.constantFrom("asc", "desc"), { nil: undefined }),
});

async function queryStringFor(
  args: Record<string, unknown>,
): Promise<string> {
  const { ctx } = makeCtx();
  let search = "";
  await withFetchStub([() => json([])], async (calls) => {
    await run("points", args, ctx);
    search = new URL(calls[0].url).search;
  });
  return search;
}

function canonicalSignature(input: Record<string, unknown>): string {
  return JSON.stringify([
    input.startAt,
    input.endAt,
    input.page,
    input.perPage,
    input.order,
  ]);
}

Deno.test("property: points' query string is deterministic — same canonical input -> same query string", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalPointsInput, async (input) => {
      const a = await queryStringFor(input);
      const b = await queryStringFor(input);
      return a === b;
    }),
    FC_RUNS,
  );
});

Deno.test("property: points' query string is INJECTIVE over the canonical (page/perPage != 0) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalPointsInput,
      arbCanonicalPointsInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const qA = await queryStringFor(a);
        const qB = await queryStringFor(b);
        return sigA === sigB ? qA === qB : qA !== qB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});

Deno.test("collapse: points' page=0 and page=undefined produce the IDENTICAL query string (both omit `page`) — EXCLUDED from the canonical subset above", async () => {
  const withZero = await queryStringFor({ page: 0 });
  const withUndefined = await queryStringFor({});
  assertEquals(withZero, withUndefined);
});

Deno.test("collapse: points' perPage=0 and perPage=undefined ALSO collapse identically", async () => {
  const withZero = await queryStringFor({ perPage: 0 });
  const withUndefined = await queryStringFor({});
  assertEquals(withZero, withUndefined);
});

// ---------------------------------------------------------------------------
// (c) pagination-header round-trip
// ---------------------------------------------------------------------------

Deno.test("property: parseInt round-trips any non-negative integer sent as X-Current-Page / X-Total-Pages", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      async (current, total) => {
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [() =>
            json([], 200, {
              "X-Current-Page": String(current),
              "X-Total-Pages": String(total),
            })],
          async () => {
            await run("points", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "points")!;
        return res.payload.currentPage === current &&
          res.payload.totalPages === total;
      },
    ),
    FC_RUNS,
  );
});
