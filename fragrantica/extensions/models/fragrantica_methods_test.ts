/**
 * Method-level tests for @magistr/fragrantica — every one of the 6 methods
 * (search, get-perfume, similar, list-by-designer, list-by-note,
 * find-by-notes), happy path + the argument-branch variants each documents,
 * driven through `model.methods.<m>.arguments.parse()` + `.execute()` against
 * a MULTI-ROUTE stubbed `globalThis.fetch` (DuckDuckGo POST vs Fragrantica
 * page GET, routed separately) and a fake capturing context.
 *
 * fragrantica.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * All HTML bodies are inline SYNTHETIC strings (never captured from a live
 * fragrantica.com or DuckDuckGo response) — kept inline rather than reading
 * from fixtures/ to avoid widening this suite's permission footprint beyond
 * the contract-fixture file (see fixtures/PROVENANCE.md). Credential-surface
 * assertions run across every method: fragrantica.ts takes no credentials
 * (globalArguments = baseUrl + userAgent only) — this suite pins that no
 * Authorization or Cookie header is ever emitted, on any request.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./fragrantica.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BASE = "https://fragrantica.example";
const CUSTOM_UA = "fragrantica-test-agent/1.0";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown> = { baseUrl: BASE }) {
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

/** Same regex fragrantica.ts's private `instanceSlug` uses — duplicated here
 * (not imported; the helper is private/byte-frozen) purely to derive the
 * EXPECTED written-resource-name pin from a known input. */
function expectedSlug(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "result";
}

type Route = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

/** Install a multi-route fetch stub for the duration of `fn`; captures every
 * request made through it (across all routes). */
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

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Route: DuckDuckGo's POST /html/ endpoint. `pageFor(q)` returns the HTML
 * body given the raw `q` form field, so different scenarios (search vs.
 * note-resolve vs. designer-resolve) can be routed by query content. */
function duckDuckGoRoute(pageFor: (q: string) => string): Route {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.hostname === "html.duckduckgo.com") {
      const body = await req.clone().text();
      const q = new URLSearchParams(body).get("q") ?? "";
      return htmlResponse(pageFor(q));
    }
    return undefined;
  };
}

/** Route: a GET against one of a fixed set of pages, keyed by exact URL. */
function pageRoute(pages: Record<string, string>): Route {
  return (req) => {
    if (req.method === "GET" && req.url in pages) {
      return htmlResponse(pages[req.url]);
    }
    return undefined;
  };
}

function ddgPage(urls: string[]): string {
  const items = urls
    .map((u, i) => {
      const encoded = encodeURIComponent(u);
      return `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encoded}&rut=r${i}">hit ${i}</a>`;
    })
    .join("\n");
  return `<!doctype html><html><body><div class="results">${items}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Synthetic page bodies
// ---------------------------------------------------------------------------

const PERFUME_URL = `${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`;
const PERFUME_HTML = `<!doctype html><html><head>
<meta property="og:title" content="Fakebloom Nova Testhouse for women and men"/>
<meta property="og:description" content="Fakebloom Nova by Testhouse."/>
</head><body>
<div itemprop="brand"><span itemprop="name">Testhouse</span></div>
<span itemprop="ratingValue">4.2</span>
<span itemprop="ratingCount">1,234</span>
<div style="background:#83C928;width:100%;">fresh spicy</div>
<div id="pyramid">
  <h4>Top Notes</h4><div class="pyramid-level-container"><a href="/notes/Bergamot-75.html">Bergamot</a></div>
  <h4>Middle Notes</h4><div class="pyramid-level-container"><a href="/notes/Rose-3.html">Rose</a></div>
  <h4>Base Notes</h4><div class="pyramid-level-container"><a href="/notes/Musk-99.html">Musk</a></div>
</div>
<a href="/noses/Jane-Testperfumer.html">Jane Testperfumer</a>
<div><h3>People who like this also like</h3><div class="also-like">
<a href="/perfume/Fakebloom/Nova-Extreme-102.html"><img/>Testhouse
Nova Extreme</a>
</div></div>
</body></html>`;

const DESIGNER_URL = `${BASE}/designers/Testhouse.html`;
const DESIGNER_HTML = `<!doctype html><html><body>
<a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova 1234</a>
<a href="/perfume/Testhouse/Nova-Extreme-102.html">Nova Extreme 567</a>
</body></html>`;

const NOTE_URL = `${BASE}/notes/Vetiver-4.html`;
const NOTE_HTML = `<!doctype html><html><body>
<a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova 88%</a>
<a href="/perfume/Otherhouse/Second-Bloom-103.html">Second Bloom 61%</a>
</body></html>`;

const NOTE2_URL = `${BASE}/notes/Agarwood-Oud-114.html`;
const NOTE2_HTML = `<!doctype html><html><body>
<a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova 40%</a>
<a href="/perfume/Thirdhouse/Third-Scent-105.html">Third Scent 30%</a>
</body></html>`;

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

Deno.test("search: happy path — POSTs 'fragrantica <query>' to DuckDuckGo, collapses locale domain, dedups, writes search", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute((_q) =>
        ddgPage([
          PERFUME_URL,
          // same perfume id, different (locale) domain -> collapsed onto BASE
          "https://www.fragrantica.es/perfume/Testhouse/Fakebloom-Nova-101.html",
          `${BASE}/perfume/Otherhouse/Second-Bloom-103.html`,
          "https://unrelated.example/not-a-perfume-page",
        ])
      ),
    ],
    async (calls) => {
      await run("search", { query: "Fakebloom Nova" }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].method, "POST");
      assertEquals(new URL(calls[0].url).hostname, "html.duckduckgo.com");
      const body = await calls[0].clone().text();
      assertEquals(
        new URLSearchParams(body).get("q"),
        "fragrantica Fakebloom Nova",
      );
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, expectedSlug("Fakebloom Nova"));
  assertEquals(res.payload.query, "Fakebloom Nova");
  const results = res.payload.results as Array<{ url: string; id?: number }>;
  assertEquals(results.length, 2, "the locale-domain dup is deduped by id");
  assertEquals(
    results[0].url,
    PERFUME_URL,
    "locale domain collapsed onto BASE",
  );
  assertEquals(results[0].id, 101);
  assertEquals(results[1].id, 103);
  assertEquals(res.payload.total, 2);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("search: limit truncates the result list", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute(() =>
        ddgPage([
          PERFUME_URL,
          `${BASE}/perfume/Otherhouse/Second-Bloom-103.html`,
          `${BASE}/perfume/Thirdhouse/Third-Scent-105.html`,
        ])
      ),
    ],
    async () => {
      await run("search", { query: "anything", limit: 2 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals((res.payload.results as unknown[]).length, 2);
  assertEquals(res.payload.total, 2);
});

// ---------------------------------------------------------------------------
// get-perfume
// ---------------------------------------------------------------------------

Deno.test("get-perfume: happy path — default UA, fetches the normalized URL, writes perfume", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [PERFUME_URL]: PERFUME_HTML })],
    async (calls) => {
      await run("get-perfume", { url: PERFUME_URL }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, PERFUME_URL);
      assertEquals(calls[0].headers.get("User-Agent"), DEFAULT_UA);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(res.name, expectedSlug(PERFUME_URL));
  assertEquals(res.payload.name, "Fakebloom Nova");
  assertEquals(res.payload.brand, "Testhouse");
  assertEquals(res.payload.id, 101);
  assert(Array.isArray(res.payload.perfumers));
  assert(Array.isArray(res.payload.accords));
  assert(typeof res.payload.notes === "object");
  assert(Array.isArray(res.payload.similar));
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("get-perfume: userAgent override is sent verbatim", async () => {
  const { ctx } = makeCtx({ baseUrl: BASE, userAgent: CUSTOM_UA });
  await withFetchStub(
    [pageRoute({ [PERFUME_URL]: PERFUME_HTML })],
    async (calls) => {
      await run("get-perfume", { url: PERFUME_URL }, ctx);
      assertEquals(calls[0].headers.get("User-Agent"), CUSTOM_UA);
    },
  );
});

Deno.test("get-perfume: a bare /perfume/... path (no scheme) is normalized against baseUrl before fetching", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [pageRoute({ [PERFUME_URL]: PERFUME_HTML })],
    async (calls) => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
      assertEquals(calls[0].url, PERFUME_URL);
    },
  );
});

// ---------------------------------------------------------------------------
// similar
// ---------------------------------------------------------------------------

Deno.test("similar: happy path — fetches the perfume page, writes just the also-like list", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [PERFUME_URL]: PERFUME_HTML })],
    async (calls) => {
      await run("similar", { url: PERFUME_URL }, ctx);
      assertEquals(calls[0].url, PERFUME_URL);
    },
  );
  const res = written.find((w) => w.spec === "similar")!;
  assertEquals(res.payload.perfumeUrl, PERFUME_URL);
  assertEquals(res.payload.perfumeName, "Fakebloom Nova");
  const results = res.payload.results as Array<{ name: string }>;
  assertEquals(results.length, 1);
  assertEquals(results[0].name, "Nova Extreme");
  assertEquals(res.payload.total, 1);
});

// ---------------------------------------------------------------------------
// list-by-designer
// ---------------------------------------------------------------------------

Deno.test("list-by-designer: slug branch — constructs /designers/<slug>.html directly, no DuckDuckGo call", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [DESIGNER_URL]: DESIGNER_HTML })],
    async (calls) => {
      await run("list-by-designer", { designer: "Testhouse" }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, DESIGNER_URL);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  assertEquals(res.name, `designer-${expectedSlug("Testhouse")}`);
  assertEquals(res.payload.source, "designer");
  assertEquals(res.payload.key, "Testhouse");
  assertEquals((res.payload.results as unknown[]).length, 2);
  assertEquals(res.payload.total, 2);
});

Deno.test("list-by-designer: plain-name branch — resolves via DuckDuckGo when the input isn't a bare slug", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute((q) => {
        assertEquals(q, "fragrantica designers Test House");
        return ddgPage([DESIGNER_URL]);
      }),
      pageRoute({ [DESIGNER_URL]: DESIGNER_HTML }),
    ],
    async (calls) => {
      await run("list-by-designer", { designer: "Test House" }, ctx);
      assertEquals(calls.length, 2);
      assertEquals(new URL(calls[0].url).hostname, "html.duckduckgo.com");
      assertEquals(calls[1].url, DESIGNER_URL);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  assertEquals(res.payload.key, "Testhouse");
});

// ---------------------------------------------------------------------------
// list-by-note
// ---------------------------------------------------------------------------

Deno.test("list-by-note: id-bearing slug branch — constructs /notes/<slug>.html directly, no DuckDuckGo call", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [NOTE_URL]: NOTE_HTML })],
    async (calls) => {
      await run("list-by-note", { note: "Vetiver-4" }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, NOTE_URL);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  assertEquals(res.name, `note-${expectedSlug("Vetiver-4")}`);
  assertEquals(res.payload.source, "note");
  assertEquals(res.payload.key, "Vetiver-4");
  assertEquals((res.payload.results as unknown[]).length, 2);
});

Deno.test("list-by-note: plain-name branch — resolves via DuckDuckGo when the input has no trailing -<id>", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute((q) => {
        assertEquals(q, "fragrantica notes Vetiver");
        return ddgPage([NOTE_URL]);
      }),
      pageRoute({ [NOTE_URL]: NOTE_HTML }),
    ],
    async (calls) => {
      await run("list-by-note", { note: "Vetiver" }, ctx);
      assertEquals(calls.length, 2);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  assertEquals(res.payload.key, "Vetiver-4");
});

// ---------------------------------------------------------------------------
// find-by-notes
// ---------------------------------------------------------------------------

Deno.test("find-by-notes: mode=all (default) — fans out one GET per note, intersects, writes noteIntersection", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [NOTE_URL]: NOTE_HTML, [NOTE2_URL]: NOTE2_HTML })],
    async (calls) => {
      await run(
        "find-by-notes",
        { notes: ["Vetiver-4", "Agarwood-Oud-114"] },
        ctx,
      );
      assertEquals(calls.length, 2, "one GET per requested note");
    },
  );
  const res = written.find((w) => w.spec === "noteIntersection")!;
  assertEquals(res.payload.mode, "all");
  const notesMeta = res.payload.notes as Array<
    { key: string; url: string; count: number }
  >;
  assertEquals(notesMeta.map((n) => n.key), ["Vetiver-4", "Agarwood-Oud-114"]);
  const results = res.payload.results as Array<
    { name: string; matchedNotes: number }
  >;
  // Only "Fakebloom Nova" appears on BOTH note pages.
  assertEquals(results.length, 1);
  assertEquals(results[0].name, "Fakebloom Nova");
  assertEquals(results[0].matchedNotes, 2);
  assertEquals(res.payload.total, 1);
});

Deno.test("find-by-notes: mode=any — unions and ranks by match count", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [NOTE_URL]: NOTE_HTML, [NOTE2_URL]: NOTE2_HTML })],
    async () => {
      await run(
        "find-by-notes",
        { notes: ["Vetiver-4", "Agarwood-Oud-114"], mode: "any" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "noteIntersection")!;
  assertEquals(res.payload.mode, "any");
  const results = res.payload.results as Array<
    { name: string; matchedNotes: number }
  >;
  // Union: Fakebloom Nova (both), Second Bloom (note 1 only), Third Scent (note 2 only)
  assertEquals(results.length, 3);
  assertEquals(results[0].name, "Fakebloom Nova");
  assertEquals(results[0].matchedNotes, 2);
});

// ---------------------------------------------------------------------------
// Credential-surface sweep — fragrantica.ts takes NO credentials at all
// ---------------------------------------------------------------------------

Deno.test("no method ever sends an Authorization or Cookie header (fragrantica.ts takes no credentials)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([PERFUME_URL])),
      pageRoute({
        [PERFUME_URL]: PERFUME_HTML,
        [DESIGNER_URL]: DESIGNER_HTML,
        [NOTE_URL]: NOTE_HTML,
        [NOTE2_URL]: NOTE2_HTML,
      }),
    ],
    async (calls) => {
      await run("search", { query: "x" }, ctx);
      await run("get-perfume", { url: PERFUME_URL }, ctx);
      await run("similar", { url: PERFUME_URL }, ctx);
      await run("list-by-designer", { designer: "Testhouse" }, ctx);
      await run("list-by-note", { note: "Vetiver-4" }, ctx);
      await run(
        "find-by-notes",
        { notes: ["Vetiver-4", "Agarwood-Oud-114"] },
        ctx,
      );
      assert(calls.length >= 6);
      for (const req of calls) {
        assertEquals(req.headers.get("Authorization"), null);
        assertEquals(req.headers.get("Cookie"), null);
      }
    },
  );
});
