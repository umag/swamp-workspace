/**
 * Property-based tests (fast-check) for @magistr/juick.
 *
 * juick.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the written resource, per the approved plan.
 *
 * Properties:
 *  (a) feed round-trip — getMessages' written `messages` array preserves
 *      every generated message, in order, with count == messages.length.
 *  (b) Obsidian-builder determinism — the SAME (uname, body) input produces
 *      the IDENTICAL obsidianContent/obsidianPath across repeated runs.
 *  (c) title/obsidianPath injectivity, stated MODULO the documented
 *      normalization (the `/[\/\\:*?"<>|#%\[\]{}]/g` strip, the trailing
 *      dot/whitespace trim, and the slice(0,80) truncation) — the arbitrary
 *      is restricted to a CANONICAL body subset (alnum+space, 1-79 chars,
 *      first/last char alnum) where the title-extraction pipeline is
 *      genuinely the identity function, per the round-1 review finding that
 *      naive injectivity is FALSE over the raw input space (porkbun/juick-v2
 *      plan precedent).
 *  (d) pagination termination — for any bounded sequence of page sizes
 *      (followed by an empty page), getUserPosts terminates and collects
 *      exactly the sum of all page sizes, in fetch order. This directly
 *      exercises the "pagination/feed-cursor edges" plan risk with stubs
 *      that are deliberately bounded so the property test itself cannot hang
 *      (the source's own `while(true)` loop has no such bound).
 *
 * Property iteration count is overridable via FC_NUM_RUNS for the nightly
 * soak (e.g. FC_NUM_RUNS=10000 deno task test:soak). The fetch stub is cast
 * `as unknown as typeof globalThis.fetch` (deno 2.8.3 toolchain pin).
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./juick.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { apiUrl: "https://api.juick.com" };

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
      logger: { info: () => {}, warn: () => {} },
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
  globalThis.fetch = ((
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = route(req);
      if (res) return res;
    }
    throw new Error(`unrouted ${req.url}`);
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

// ---------------------------------------------------------------------------
// (a) feed round-trip
// ---------------------------------------------------------------------------

const arbMessage = fc.record({
  mid: fc.integer({ min: 1, max: 99_999_999 }),
  body: fc.string({ maxLength: 100 }),
  user: fc.record({
    uid: fc.integer({ min: 1, max: 999_999 }),
    uname: fc.stringMatching(/^[a-z0-9_-]{1,20}$/),
  }),
  likes: fc.nat({ max: 10_000 }),
  replies: fc.constant(0),
});

Deno.test("property: getMessages preserves every generated message, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbMessage, { minLength: 0, maxLength: 15 }),
      async (msgs) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([() => json(msgs)], async () => {
          await run("getMessages", {}, ctx);
        });
        const res = written.find((w) => w.spec === "messages")!;
        return (
          JSON.stringify(res.payload.messages) === JSON.stringify(msgs) &&
          res.payload.count === msgs.length
        );
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

// ---------------------------------------------------------------------------
// (b) Obsidian-builder determinism
// ---------------------------------------------------------------------------

async function obsidianOutputFor(
  uname: string,
  body: string,
  mid: number,
): Promise<{ path: string; content: string }> {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (!url.search.includes("before_mid")) {
        return json([{ mid, body, replies: 0 }]);
      }
      return json([]);
    }],
    async () => {
      await run("getUserPosts", { uname, withComments: false }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const post = (res.payload.posts as Array<Record<string, unknown>>)[0];
  return {
    path: post.obsidianPath as string,
    content: post.obsidianContent as string,
  };
}

const arbUname = fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/);
const arbBody = fc.string({ maxLength: 100 });
const arbMid = fc.integer({ min: 1, max: 99_999_999 });

Deno.test("property: getUserPosts' Obsidian output is deterministic — same (uname, body, mid) input twice produces identical output", async () => {
  await fc.assert(
    fc.asyncProperty(arbUname, arbBody, arbMid, async (uname, body, mid) => {
      const a = await obsidianOutputFor(uname, body, mid);
      const b = await obsidianOutputFor(uname, body, mid);
      return a.path === b.path && a.content === b.content;
    }),
    { numRuns: NIGHT(50) },
  );
});

// ---------------------------------------------------------------------------
// (c) title/obsidianPath injectivity, MODULO the documented normalization
// ---------------------------------------------------------------------------

// Canonical subset: alnum + space only (no chars the strip regex touches, no
// backslash/dot ambiguity), 1-79 characters (slice(0,80) never truncates),
// first AND last character alnum (so .trim() and the trailing-dot/whitespace
// replaces are all no-ops). Within this subset, title === body EXACTLY.
const arbCanonicalBody = fc.stringMatching(
  /^[a-zA-Z0-9]([a-zA-Z0-9 ]{0,77}[a-zA-Z0-9])?$/,
);

Deno.test("property: within the canonical body subset, the extracted title equals the body EXACTLY (identity)", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalBody, async (body) => {
      const { path } = await obsidianOutputFor("prop-user", body, 1);
      return path === `juick/${body}`;
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: obsidianPath is INJECTIVE over the canonical (non-collapsing) body subset — different canonical bodies never collide, identical ones always match", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalBody,
      arbCanonicalBody,
      async (bodyA, bodyB) => {
        const a = await obsidianOutputFor("prop-user", bodyA, 1);
        const b = await obsidianOutputFor("prop-user", bodyB, 1);
        return bodyA === bodyB ? a.path === b.path : a.path !== b.path;
      },
    ),
    { numRuns: NIGHT(100) },
  );
});

// --- Explicit named collapse examples (the normalization this property
// deliberately EXCLUDES from its canonical domain) ---

Deno.test("collapse: bodies differing only by trailing whitespace produce the IDENTICAL title (trim collapses them)", async () => {
  const a = await obsidianOutputFor("prop-user", "Same Title", 1);
  const b = await obsidianOutputFor("prop-user", "Same Title   ", 2);
  assertEquals(a.path, b.path);
});

Deno.test("collapse: bodies differing only by a stripped special character produce the IDENTICAL title", async () => {
  const a = await obsidianOutputFor("prop-user", "Report: Q3", 1);
  const b = await obsidianOutputFor("prop-user", "Report- Q3", 2);
  assertEquals(a.path, b.path, "both ':' and '-' normalize identically ('-')");
});

// ---------------------------------------------------------------------------
// (d) pagination termination — bounded page-size sequences always terminate
// ---------------------------------------------------------------------------

Deno.test("property: getUserPosts terminates for any bounded sequence of page sizes, collecting exactly the sum in fetch order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 5 }),
      async (pageSizes) => {
        // Build strictly-descending mids across all pages so `before_mid`
        // advances coherently: highest mid first (page 1), lowest last.
        const totalPosts = pageSizes.reduce((a, b) => a + b, 0);
        let nextMid = 1_000_000;
        const pages: Array<Array<Record<string, unknown>>> = [];
        for (const size of pageSizes) {
          const page: Array<Record<string, unknown>> = [];
          for (let i = 0; i < size; i++) {
            page.push({ mid: nextMid--, replies: 0 });
          }
          pages.push(page);
        }
        let callIndex = 0;
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [() => {
            const page = callIndex < pages.length ? pages[callIndex] : [];
            callIndex++;
            return json(page);
          }],
          async () => {
            await run(
              "getUserPosts",
              { uname: "pagination-prop-user", withComments: false },
              ctx,
            );
          },
        );
        const res = written.find((w) => w.spec === "userPosts")!;
        const posts = res.payload.posts as Array<Record<string, unknown>>;
        return (
          posts.length === totalPosts &&
          callIndex === pages.length + 1 &&
          posts.map((p) => p.mid).every((mid, i, arr) =>
            i === 0 || (arr[i - 1] as number) > (mid as number)
          )
        );
      },
    ),
    { numRuns: NIGHT(100) },
  );
});
