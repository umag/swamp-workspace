/**
 * Property-based tests (fast-check) for @magistr/tubearchivist.
 *
 * tubearchivist.ts exports no pure helpers — every property here is observed
 * by driving `model.methods.<m>.execute()` against a stubbed fetch and
 * reading back the captured POST body / written resource, per the approved
 * plan.
 *
 * Properties:
 *  (a) parser round-trip — `list-videos`/`list-channels`/`list-queue`'s
 *      written items preserve every generated item, in order, with
 *      count == length; absent and empty both yield [].
 *  (b) request-builder injectivity for `add-to-queue`/`subscribe` over
 *      distinct ID-array inputs — these builders apply no falsy-collapse
 *      normalization (unlike porkbun's ttl/subdomain), so injectivity holds
 *      over the FULL input space, not a restricted canonical subset.
 *  (c) URLSearchParams determinism for `list-videos` filters, stated MODULO
 *      the documented `page=0` collapse (page=0 and page=undefined produce
 *      the identical query string, per the round-1/v2 coverage-suite pin).
 *
 * FC_NUM_RUNS-gated (small in CI, large in `deno task test:soak`).
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./tubearchivist.ts";

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
  host: "https://tubearchivist.example.com",
  token: "ta_stub",
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

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
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

/** Run `add-to-queue` (or `subscribe`) with the given ids and return the
 * exact parsed POST body sent. */
async function bodyFor(
  method: "add-to-queue" | "subscribe",
  ids: string[],
): Promise<Record<string, unknown>> {
  const { ctx } = makeCtx();
  let body: Record<string, unknown> = {};
  await withFetchStub([() => json({ task_id: "t" })], async (calls) => {
    const args = method === "add-to-queue"
      ? { youtube_ids: ids }
      : { channel_ids: ids };
    await run(method, args, ctx);
    body = JSON.parse(await calls[0].text());
  });
  return body;
}

// ---------------------------------------------------------------------------
// (a) parser round-trip
// ---------------------------------------------------------------------------

const arbVideo = fc.record({
  youtube_id: fc.stringMatching(/^[A-Za-z0-9_-]{11}$/),
  title: fc.string({ maxLength: 40 }),
  channel: fc.record({
    channel_name: fc.string({ maxLength: 20 }),
  }),
  published: fc.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  vid_type: fc.constantFrom("videos", "streams", "shorts"),
  active: fc.boolean(),
});

Deno.test("property: list-videos preserves every generated video, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbVideo, { minLength: 1, maxLength: 15 }),
      async (records) => {
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [() => json({ data: records, paginate: {} })],
          async () => {
            await run("list-videos", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "videos")!;
        const videos = res.payload.videos as Array<Record<string, unknown>>;
        if (videos.length !== records.length) return false;
        for (let i = 0; i < records.length; i++) {
          if (videos[i].youtube_id !== records[i].youtube_id) return false;
          if (videos[i].title !== records[i].title) return false;
          if (videos[i].channel_name !== records[i].channel.channel_name) {
            return false;
          }
          if (videos[i].published !== records[i].published) return false;
          if (videos[i].vid_type !== records[i].vid_type) return false;
          if (videos[i].active !== records[i].active) return false;
        }
        return res.payload.total === records.length;
      },
    ),
    FC_RUNS,
  );
});

const arbChannel = fc.record({
  channel_id: fc.stringMatching(/^UC[A-Za-z0-9_-]{10}$/),
  channel_name: fc.string({ maxLength: 20 }),
  channel_subs: fc.nat(1_000_000),
  channel_subscribed: fc.boolean(),
});

Deno.test("property: list-channels preserves every generated channel, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbChannel, { minLength: 1, maxLength: 15 }),
      async (records) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([() => json({ data: records })], async () => {
          await run("list-channels", {}, ctx);
        });
        const res = written.find((w) => w.spec === "channels")!;
        const channels = res.payload.channels as Array<
          Record<string, unknown>
        >;
        return (
          JSON.stringify(channels) === JSON.stringify(records) &&
          res.payload.total === records.length
        );
      },
    ),
    FC_RUNS,
  );
});

const arbQueueItem = fc.record({
  youtube_id: fc.stringMatching(/^[A-Za-z0-9_-]{11}$/),
  status: fc.constantFrom("pending", "downloading", "ignore"),
});

Deno.test("property: list-queue preserves every generated item, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbQueueItem, { minLength: 1, maxLength: 15 }),
      async (records) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([() => json({ data: records })], async () => {
          await run("list-queue", {}, ctx);
        });
        const res = written.find((w) => w.spec === "download")!;
        const items = res.payload.items as Array<Record<string, unknown>>;
        return (
          JSON.stringify(items) === JSON.stringify(records) &&
          res.payload.total === records.length
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: absent and empty data.data both yield [] across list-videos/list-channels/list-queue", async () => {
  for (
    const method of ["list-videos", "list-channels", "list-queue"] as const
  ) {
    for (const response of [{}, { data: [] }]) {
      const { ctx, written } = makeCtx();
      await withFetchStub([() => json(response)], async () => {
        await run(method, {}, ctx);
      });
      const specByMethod: Record<string, string> = {
        "list-videos": "videos",
        "list-channels": "channels",
        "list-queue": "download",
      };
      const fieldByMethod: Record<string, string> = {
        "list-videos": "videos",
        "list-channels": "channels",
        "list-queue": "items",
      };
      const res = written.find((w) => w.spec === specByMethod[method])!;
      assertEquals(
        res.payload[fieldByMethod[method]],
        [],
        `${method} with response ${JSON.stringify(response)} must yield []`,
      );
      assertEquals(res.payload.total, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// (b) request-builder injectivity — add-to-queue / subscribe
// ---------------------------------------------------------------------------

// No falsy-collapse normalization exists in either builder (both are plain
// `.map(id => ({...}))` over the id array) — injectivity holds over the FULL
// arbitrary input space, unlike porkbun's ttl/subdomain case.
const arbIdArray = fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,11}$/), {
  minLength: 0,
  maxLength: 8,
});

Deno.test("property: add-to-queue's request body is deterministic — same input -> same body", async () => {
  await fc.assert(
    fc.asyncProperty(arbIdArray, async (ids) => {
      const a = await bodyFor("add-to-queue", ids);
      const b = await bodyFor("add-to-queue", ids);
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    FC_RUNS,
  );
});

Deno.test("property: add-to-queue's request body is INJECTIVE over the full id-array input space", async () => {
  await fc.assert(
    fc.asyncProperty(arbIdArray, arbIdArray, async (a, b) => {
      const sigA = JSON.stringify(a);
      const sigB = JSON.stringify(b);
      const bodyA = JSON.stringify(await bodyFor("add-to-queue", a));
      const bodyB = JSON.stringify(await bodyFor("add-to-queue", b));
      return sigA === sigB ? bodyA === bodyB : bodyA !== bodyB;
    }),
    { numRuns: NIGHT(300) },
  );
});

Deno.test("property: subscribe's request body is INJECTIVE over the full id-array input space", async () => {
  await fc.assert(
    fc.asyncProperty(arbIdArray, arbIdArray, async (a, b) => {
      const sigA = JSON.stringify(a);
      const sigB = JSON.stringify(b);
      const bodyA = JSON.stringify(await bodyFor("subscribe", a));
      const bodyB = JSON.stringify(await bodyFor("subscribe", b));
      return sigA === sigB ? bodyA === bodyB : bodyA !== bodyB;
    }),
    { numRuns: NIGHT(300) },
  );
});

// ---------------------------------------------------------------------------
// (c) URLSearchParams determinism for list-videos filters, MODULO the
// documented page=0 collapse
// ---------------------------------------------------------------------------

// Restricted to the CANONICAL subset: page either undefined or a positive
// integer (excludes the page=0 -> dropped collapse, pinned separately in
// tubearchivist_coverage_test.ts). Within this subset, the query-string
// builder is genuinely injective.
const arbCanonicalListVideosInput = fc.record({
  page: fc.option(fc.integer({ min: 1, max: 999999 }), { nil: undefined }),
  channel: fc.option(fc.stringMatching(/^UC[A-Za-z0-9_-]{6}$/), {
    nil: undefined,
  }),
  watch: fc.option(fc.constantFrom("watched", "unwatched"), {
    nil: undefined,
  }),
  type: fc.option(fc.constantFrom("videos", "streams", "shorts"), {
    nil: undefined,
  }),
});

async function queryStringFor(
  args: Record<string, unknown>,
): Promise<string> {
  const { ctx } = makeCtx();
  let search = "";
  await withFetchStub(
    [() => json({ data: [], paginate: {} })],
    async (calls) => {
      await run("list-videos", args, ctx);
      search = new URL(calls[0].url).search;
    },
  );
  return search;
}

function canonicalSignature(input: Record<string, unknown>): string {
  return JSON.stringify([
    input.page,
    input.channel,
    input.watch,
    input.type,
  ]);
}

Deno.test("property: list-videos's query string is deterministic — same canonical input -> same query string", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalListVideosInput, async (input) => {
      const a = await queryStringFor(input);
      const b = await queryStringFor(input);
      return a === b;
    }),
    FC_RUNS,
  );
});

Deno.test("property: list-videos's query string is INJECTIVE over the canonical (page != 0) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalListVideosInput,
      arbCanonicalListVideosInput,
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

Deno.test("collapse: list-videos page=0 and page=undefined produce the IDENTICAL query string (both omit `page`)", async () => {
  const withZero = await queryStringFor({ page: 0 });
  const withUndefined = await queryStringFor({});
  assertEquals(withZero, withUndefined);
});
