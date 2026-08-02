/**
 * Property-based tests (fast-check) for @magistr/seadex.
 *
 * seadex.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the written resource, per the approved plan (mirroring seanime).
 *
 * Properties, stated over CANONICAL (non-collapsing) subsets to avoid false
 * failures — duplicate-id collapse and primaryFile ties are pinned
 * separately as NAMED (non-property) tests in the adversarial/coverage
 * suites, not restated here:
 *  (a) lookup-many partition/summary invariant, over UNIQUE anilistIds —
 *      every result's alID is a member of the input id set and every input
 *      id appears in EXACTLY one of found/not-found, stated ORDER-
 *      INDEPENDENTLY (by Set membership / counts, never by array position),
 *      because concurrent workers push results in COMPLETION order, not
 *      input order (see the named pin below proving this concretely).
 *  (b) normaliseTorrent's totalSizeBytes == sum(file.length) and
 *      fileCount == files.length, over files with UNIQUE lengths (the tie
 *      case is pinned separately in the coverage suite) and primaryFile ==
 *      the name of the max-length file.
 *  (c) isBest partition total + disjoint — every torrent lands in exactly
 *      one of bestReleases/alternativeReleases, and the two counts always
 *      sum to the input torrent count.
 *  (d) normalise determinism (same input -> same output, timestamp aside)
 *      and injectivity over a canonical subset (infoHash varies, everything
 *      else fixed -> distinct infoHash in, distinct infoHash out — verbatim
 *      passthrough, never collapsed/hashed/case-folded).
 *  (e) NEW (LB8 fix): infoHash normalization (trim + lowercase) is
 *      idempotent and deterministic over a SEPARATE arb that varies case and
 *      surrounding whitespace — added alongside (d), which is left
 *      untouched (its arb is already lowercase/unpadded, so (d)'s
 *      determinism/injectivity claims hold unchanged post-fix).
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./seadex.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://releases.moe",
  userAgent: "swamp-seadex-property/1.0",
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
    id: "tr_prop",
    releaseGroup: "PropGroup",
    tracker: "PropTracker",
    url: "https://tracker.example/prop",
    infoHash: "1111111111111111111111111111111111111111".slice(0, 40),
    isBest: true,
    dualAudio: false,
    tags: ["1080p"],
    files: [{ name: "a.mkv", length: 100 }],
    ...overrides,
  };
}

function entryWith(alID: number, trs: unknown[]) {
  return {
    id: `rec_prop_${alID}`,
    alID,
    notes: "",
    theoreticalBest: "",
    comparison: "",
    incomplete: false,
    trs: trs.map((_, i) => `tr_prop_${alID}_${i}`),
    expand: { trs },
  };
}

// ---------------------------------------------------------------------------
// (a) lookup-many partition/summary invariant, over UNIQUE anilistIds,
//     asserted ORDER-INDEPENDENTLY
// ---------------------------------------------------------------------------

Deno.test("property: lookup-many — every unique input id lands in EXACTLY one of found/not-found, and summary.total/found match, order-independently", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
      async (foundFlags) => {
        const ids = Array.from(
          { length: foundFlags.length },
          (_, i) => 10000 + i,
        );
        const foundById = new Map(ids.map((id, i) => [id, foundFlags[i]]));
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            const m = url.searchParams.get("filter")?.match(/alID=(\d+)/);
            const id = m ? Number(m[1]) : -1;
            return json(
              pbList(foundById.get(id) ? [entryWith(id, [])] : []),
            );
          }],
          async () => {
            await run(
              "lookup-many",
              { items: ids.map((anilistId) => ({ anilistId })) },
              ctx,
            );
          },
        );
        const summary = written.find((w) => w.spec === "summary")!;
        const entries = written.filter((w) => w.spec === "entry");

        const idSet = new Set(ids);
        const writtenIdSet = new Set(
          entries.map((e) => e.payload.alID as number),
        );
        const setsMatch = idSet.size === writtenIdSet.size &&
          [...idSet].every((id) => writtenIdSet.has(id));

        const expectedFound = ids.filter((id) => foundById.get(id)).length;
        return (
          setsMatch &&
          summary.payload.total === ids.length &&
          summary.payload.found === expectedFound &&
          (summary.payload.notInSeadex as Array<{ alID: number }>).length ===
            ids.length - expectedFound
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// Named pin: completion order is NOT input order — a slower FIRST item
// completes after a faster SECOND item under real concurrency
// ---------------------------------------------------------------------------

Deno.test("NAMED PIN: lookup-many's written entry order follows COMPLETION order, not items[] input order — a delayed first item lands AFTER a faster second item", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [async (req) => {
      const url = new URL(req.url);
      const m = url.searchParams.get("filter")?.match(/alID=(\d+)/);
      const id = m ? Number(m[1]) : -1;
      if (id === 20001) {
        // The FIRST input item resolves slowest. A generous 150ms margin
        // (vs. the fast path's near-instant microtask resolution) keeps this
        // robust against CI runner contention/throttling.
        await new Promise((r) => setTimeout(r, 150));
      }
      return json(pbList([]));
    }],
    async () => {
      await run(
        "lookup-many",
        { items: [{ anilistId: 20001 }, { anilistId: 20002 }] },
        ctx,
      );
    },
  );
  const entries = written.filter((w) => w.spec === "entry");
  assertEquals(
    entries.map((e) => e.payload.alID),
    [20002, 20001],
    "the faster second item's result is PUSHED first — order is completion order, not input order",
  );
});

// ---------------------------------------------------------------------------
// (b) totalSizeBytes/fileCount/primaryFile over files with UNIQUE lengths
// ---------------------------------------------------------------------------

const arbUniqueFileSet = fc.uniqueArray(
  fc.integer({ min: 1, max: 5_000_000_000 }),
  { minLength: 1, maxLength: 8 },
).map((lengths) =>
  lengths.map((length, i) => ({ name: `file-${i}.mkv`, length }))
);

Deno.test("property: totalSizeBytes == sum(file.length), fileCount == files.length, primaryFile == argmax(length), over files with unique lengths", async () => {
  await fc.assert(
    fc.asyncProperty(arbUniqueFileSet, async (files) => {
      const { ctx, written } = makeCtx();
      await withFetchStub(
        [() => json(pbList([entryWith(30000, [torrent({ files })])]))],
        async () => {
          await run("lookup-by-anilist-id", { anilistId: 30000 }, ctx);
        },
      );
      const res = written.find((w) => w.name === "al-30000")!;
      const best = (res.payload.bestReleases as Array<Record<string, unknown>>)[
        0
      ];
      const expectedTotal = files.reduce((s, f) => s + f.length, 0);
      const expectedPrimary = files.slice().sort((a, b) =>
        b.length - a.length
      )[0].name;
      return (
        best.totalSizeBytes === expectedTotal &&
        best.fileCount === files.length &&
        best.primaryFile === expectedPrimary
      );
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) isBest partition — total + disjoint
// ---------------------------------------------------------------------------

const arbTorrentBoolList = fc.array(fc.boolean(), {
  minLength: 1,
  maxLength: 10,
});

Deno.test("property: isBest partition — every torrent lands in exactly one of bestReleases/alternativeReleases, counts sum to the total", async () => {
  await fc.assert(
    fc.asyncProperty(arbTorrentBoolList, async (isBestFlags) => {
      const trs = isBestFlags.map((isBest, i) =>
        torrent({ id: `t${i}`, isBest, url: `https://tracker.example/${i}` })
      );
      const { ctx, written } = makeCtx();
      await withFetchStub(
        [() => json(pbList([entryWith(40000, trs)]))],
        async () => {
          await run("lookup-by-anilist-id", { anilistId: 40000 }, ctx);
        },
      );
      const res = written.find((w) => w.name === "al-40000")!;
      const best = res.payload.bestReleases as Array<Record<string, unknown>>;
      const alt = res.payload.alternativeReleases as Array<
        Record<string, unknown>
      >;
      const expectedBest = isBestFlags.filter(Boolean).length;
      const expectedAlt = isBestFlags.length - expectedBest;
      return (
        best.length === expectedBest &&
        alt.length === expectedAlt &&
        best.length + alt.length === trs.length
      );
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) normalise determinism + injectivity over a canonical (non-collapsing)
//     subset — infoHash varies, everything else fixed
// ---------------------------------------------------------------------------

const arbInfoHash = fc.stringMatching(/^[a-f0-9]{40}$/);

async function normalisedInfoHashFor(infoHash: string): Promise<string> {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(pbList([entryWith(50000, [torrent({ infoHash })])]))],
    async () => {
      await run("lookup-by-anilist-id", { anilistId: 50000 }, ctx);
    },
  );
  const res = written.find((w) => w.name === "al-50000")!;
  return (res.payload.bestReleases as Array<{ infoHash: string }>)[0].infoHash;
}

Deno.test("property: normaliseTorrent is deterministic — the same infoHash input twice yields the same output", async () => {
  await fc.assert(
    fc.asyncProperty(arbInfoHash, async (infoHash) => {
      const a = await normalisedInfoHashFor(infoHash);
      const b = await normalisedInfoHashFor(infoHash);
      return a === b && a === infoHash;
    }),
    FC_RUNS,
  );
});

Deno.test("property: infoHash passthrough is INJECTIVE — distinct inputs always yield distinct outputs (verbatim, never hashed/case-folded/truncated)", async () => {
  await fc.assert(
    fc.asyncProperty(arbInfoHash, arbInfoHash, async (a, b) => {
      const outA = await normalisedInfoHashFor(a);
      const outB = await normalisedInfoHashFor(b);
      return a === b ? outA === outB : outA !== outB;
    }),
    { numRuns: NIGHT(150) },
  );
});

// ---------------------------------------------------------------------------
// (e) NEW (LB8 fix): infoHash normalization (trim + lowercase) is idempotent
//     and deterministic, over a SEPARATE arb that varies case + whitespace
// ---------------------------------------------------------------------------

const arbInfoHashMixedCaseWs = fc
  .stringMatching(/^[a-fA-F0-9]{40}$/)
  .chain((hex) =>
    fc.tuple(
      fc.constantFrom("", " ", "  ", "\t"),
      fc.constantFrom("", " ", "  ", "\t"),
    ).map(([pre, post]) => pre + hex + post)
  );

Deno.test("property: FIXED (LB8) — infoHash normalization is idempotent and always yields the trim+lowercase form, over mixed-case/whitespace-padded inputs", async () => {
  await fc.assert(
    fc.asyncProperty(arbInfoHashMixedCaseWs, async (raw) => {
      const once = await normalisedInfoHashFor(raw);
      const expected = raw.trim().toLowerCase();
      const twice = await normalisedInfoHashFor(once);
      return once === expected && twice === once;
    }),
    FC_RUNS,
  );
});
