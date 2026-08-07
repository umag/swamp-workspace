/**
 * Property-based tests (fast-check) for @magistr/victorialogs.
 *
 * victorialogs.ts exports no pure helpers — every property here is observed
 * by driving `model.methods.<m>.execute()` against a stubbed fetch (+
 * stubbed Deno.Command for container-log-status) and reading back the
 * written resource, per the approved plan.
 *
 * FIXED (2026.08.01.1): P6 (compare-periods now guards empty windows and
 * non-numeric totals, throwing instead of silently collapsing) and P13 (the
 * sort comparator's `?? 9` no longer falsy-collapses GONE's priority). The
 * non-degenerate totality property's `arbWindow` is now constrained to
 * `minKeys: 1` so it never trips the new empty-window guard, and its
 * `STATUS_ORDER` reflects GONE's now-correct priority of 0. The two named
 * degenerate-collapse examples below are now GREEN tests proving the
 * rejections.
 *
 * Properties:
 *  (a) query round-trip — `entries.length == totalEntries` for any generated
 *      NDJSON, and every entry's message is truncated to <=500 chars while
 *      preserving `time`/`container` verbatim.
 *  (b) compare-periods classification is a TOTAL function (exactly one of
 *      the 5 statuses per container) and rows are sorted by the defined
 *      status priority — stated over the NON-DEGENERATE subset (positive
 *      integer totals only, at least one key per window). The NaN/garbled-
 *      total collapse and the empty-window guard are excluded here and
 *      pinned as explicit named examples instead (and more fully in the
 *      coverage suite), per the porkbun injectivity-modulo precedent.
 *  (c) container-log-status invariant: `notLogging == running \ loggingSet`
 *      for arbitrary running/logging subsets, including either side empty.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./victorialogs.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { host: "vlogs.example.test", port: 9428 };

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

function ndjson(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

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
  fn: (calls: CapturedRequest[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
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
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function queueRoute(bodies: Array<{ text: string; status?: number }>): Route {
  const queue = [...bodies];
  return () => {
    const item = queue.shift() ?? { text: "", status: 200 };
    return new Response(item.text, { status: item.status ?? 200 });
  };
}

type CmdResp = { success: boolean; stdout: string; stderr: string };

function installCmdStub(queue: CmdResp[]) {
  const original = Deno.Command;
  const enc = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    output() {
      const r = queue.shift() ?? { success: true, stdout: "", stderr: "" };
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        signal: null,
        stdout: enc.encode(r.stdout),
        stderr: enc.encode(r.stderr),
      });
    }
  };
  return {
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

// ---------------------------------------------------------------------------
// (a) query round-trip
// ---------------------------------------------------------------------------

const arbEntry = fc.record({
  _time: fc.string({ maxLength: 30 }),
  _msg: fc.string({ maxLength: 800 }),
  container_name: fc.stringMatching(/^svc-[a-z]{1,10}$/),
  _stream: fc.string({ maxLength: 30 }),
});

Deno.test("property: query — totalEntries == entries.length, message truncated to <=500, time/container preserved verbatim", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(arbEntry, { maxLength: 20 }), async (rows) => {
      const { ctx, written } = makeCtx();
      await withFetchStub(
        [queueRoute([{ text: ndjson(rows) }])],
        () => run("query", {}, ctx),
      );
      const res = written.find((w) => w.spec === "queryResult")!;
      const entries = res.payload.entries as Array<
        { time: unknown; container: unknown; message: string }
      >;
      if (res.payload.totalEntries !== rows.length) return false;
      if (entries.length !== rows.length) return false;
      for (let i = 0; i < rows.length; i++) {
        if (entries[i].time !== rows[i]._time) return false;
        if (entries[i].container !== rows[i].container_name) return false;
        if (entries[i].message.length > 500) return false;
        if (entries[i].message !== rows[i]._msg.slice(0, 500)) return false;
      }
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) compare-periods — totality + sort order, over the non-degenerate
// (positive-integer-total) subset. NAME_POOL keeps names distinct via
// fc.dictionary's unique keys, so classification per name is unambiguous.
// ---------------------------------------------------------------------------

const NAME_POOL = ["svc-a", "svc-b", "svc-c", "svc-d", "svc-e", "svc-f"];

// minKeys: 1 — an empty window (0 keys on either side) now throws (P6 fix),
// and this property is stated over the non-degenerate subset; the empty-
// window guard is pinned separately as an explicit named example below.
const arbWindow = fc.dictionary(
  fc.constantFrom(...NAME_POOL),
  fc.integer({ min: 1, max: 100000 }),
  { minKeys: 1, maxKeys: NAME_POOL.length },
);

// P13 FIXED — the model's sort comparator is now
// `(order[a.status] ?? 9) - (order[b.status] ?? 9)` with order.GONE = 0.
// Nullish coalescing no longer collapses that 0 to the unmapped-status
// fallback of 9, so GONE now correctly sorts FIRST. This constant reflects
// the model's actual (fixed) runtime priority.
const STATUS_ORDER: Record<string, number> = {
  GONE: 0,
  MOSTLY_SILENT: 1,
  NEW: 2,
  MUCH_MORE_ACTIVE: 3,
  NORMAL: 4,
};

Deno.test("property: compare-periods classification is a TOTAL function (exactly one of 5 statuses per container), rows sorted by the fixed status priority — non-degenerate subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbWindow,
      arbWindow,
      async (baselineDict, compareDict) => {
        const baseline = Object.entries(baselineDict).map(([name, total]) => ({
          container_name: name,
          total: String(total),
        }));
        const compare = Object.entries(compareDict).map(([name, total]) => ({
          container_name: name,
          total: String(total),
        }));
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
          () => run("compare-periods", {}, ctx),
        );
        const rows = written.find((w) => w.spec === "stats")!.payload
          .stats as Array<{ name: string; status: string }>;
        const expectedNames = new Set([
          ...Object.keys(baselineDict),
          ...Object.keys(compareDict),
        ]);
        if (rows.length !== expectedNames.size) return false;
        let lastOrder = -1;
        for (const row of rows) {
          const o = STATUS_ORDER[row.status];
          if (o === undefined) return false; // not one of the 5 valid statuses
          if (o < lastOrder) return false; // must be non-decreasing priority
          lastOrder = o;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// --- Explicit named degenerate collapse (excluded from the property above) -

Deno.test("collapse: P6 FIXED — a non-numeric total (parseInt -> NaN) now REJECTS instead of collapsing to baseline 0/NORMAL — full characterization lives in the coverage suite", async () => {
  // compare MUST be non-empty — an empty comparison window trips the P6
  // empty-window guard before the NaN check ever runs, which would make
  // this test pass for the wrong reason (found in review).
  const baseline = [{ container_name: "svc-a", total: "garbled" }];
  const compare = [{ container_name: "svc-a", total: "5" }];
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    async () => {
      const err = await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
      );
      assert(
        err.message.includes("non-numeric baseline total"),
        "must reject via the NaN guard specifically, not the empty-window guard",
      );
    },
  );
});

Deno.test("collapse: P13 FIXED — GONE's sort-order value (0) is no longer falsy-collapsed by `?? 9`, so a GONE row sorts FIRST among GONE/NEW/NORMAL", async () => {
  const baseline = [
    { container_name: "svc-a", total: "10" }, // -> GONE (absent from compare)
  ];
  const compare = [
    { container_name: "svc-b", total: "5" }, // -> NEW (absent from baseline)
    { container_name: "svc-c", total: "5" }, // paired below to force a NORMAL row
  ];
  const baselineWithNormal = [...baseline, {
    container_name: "svc-c",
    total: "5",
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      queueRoute([
        { text: ndjson(baselineWithNormal) },
        { text: ndjson(compare) },
      ]),
    ],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as Array<{ name: string; status: string }>;
  assertEquals(rows.map((r) => r.status), ["GONE", "NEW", "NORMAL"]);
});

// ---------------------------------------------------------------------------
// (c) container-log-status invariant: notLogging == running \ loggingSet
// ---------------------------------------------------------------------------

const arbSubset = fc.subarray(NAME_POOL);

Deno.test("property: container-log-status — notLogging == running \\ loggingSet for arbitrary subsets, either side possibly empty", async () => {
  await fc.assert(
    fc.asyncProperty(arbSubset, arbSubset, async (running, loggingNames) => {
      const cmdStub = installCmdStub([
        { success: true, stdout: running.join("\n"), stderr: "" },
      ]);
      const statsRows = loggingNames.map((name) => ({
        container_name: name,
        total: "1",
      }));
      const { ctx, written } = makeCtx();
      try {
        await withFetchStub(
          [queueRoute([{ text: ndjson(statsRows) }])],
          () => run("container-log-status", {}, ctx),
        );
      } finally {
        cmdStub.restore();
      }
      const res = written.find((w) => w.spec === "containerStatus")!;
      const expected = running.filter((c) => !loggingNames.includes(c));
      return (
        JSON.stringify(res.payload.notLogging) === JSON.stringify(expected)
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: container-log-status — empty running list always yields empty notLogging, regardless of the logging set", async () => {
  await fc.assert(
    fc.asyncProperty(arbSubset, async (loggingNames) => {
      const cmdStub = installCmdStub([{
        success: true,
        stdout: "",
        stderr: "",
      }]);
      const statsRows = loggingNames.map((name) => ({
        container_name: name,
        total: "1",
      }));
      const { ctx, written } = makeCtx();
      try {
        await withFetchStub(
          [queueRoute([{ text: ndjson(statsRows) }])],
          () => run("container-log-status", {}, ctx),
        );
      } finally {
        cmdStub.restore();
      }
      const res = written.find((w) => w.spec === "containerStatus")!;
      return Array.isArray(res.payload.notLogging) &&
        (res.payload.notLogging as unknown[]).length === 0;
    }),
    FC_RUNS,
  );
});
