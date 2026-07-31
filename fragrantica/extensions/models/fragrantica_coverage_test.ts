/**
 * Coverage suite: sweeps every remaining guard/branch in fragrantica.ts that
 * the methods and adversarial suites don't already exercise on both sides,
 * so deleting any one of these guards turns a test red (STANDARD.md's
 * coverage role — a behavioral regression guard, not a numeric percentage).
 *
 * fragrantica.ts is UNMODIFIED; every test PINS existing behavior. Private
 * helpers (normalizePerfumeUrl, resolveNoteUrl, collectPerfumeRefs, ...) are
 * swept THROUGH model.methods.<m>.execute() against a stubbed fetch — never
 * by exporting them (byte-freeze forbids new exports).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./fragrantica.ts";

const BASE = "https://fragrantica.example";

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

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

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
    headers: { "Content-Type": "text/html" },
  });
}

function pageRoute(pages: Record<string, string>): Route {
  return (req) => {
    if (req.method === "GET" && req.url in pages) {
      return htmlResponse(pages[req.url]);
    }
    return undefined;
  };
}

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

function ddgPage(urls: string[]): string {
  const items = urls
    .map((u, i) => {
      const encoded = encodeURIComponent(u);
      return `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encoded}&rut=r${i}">hit ${i}</a>`;
    })
    .join("\n");
  return `<!doctype html><html><body><div class="results">${items}</div></body></html>`;
}

const MINIMAL = "<html><body></body></html>";

// ---------------------------------------------------------------------------
// normalizePerfumeUrl (via get-perfume) — 3 branches
// ---------------------------------------------------------------------------

Deno.test("normalizePerfumeUrl branch 1: absolute http(s) URL passed through unchanged", async () => {
  const url = "https://other.example/perfume/Testhouse/Fakebloom-Nova-101.html";
  const { ctx } = makeCtx();
  await withFetchStub([pageRoute({ [url]: MINIMAL })], async (calls) => {
    await run("get-perfume", { url }, ctx);
    assertEquals(
      calls[0].url,
      url,
      "absolute URLs are never rewritten onto baseUrl",
    );
  });
});

Deno.test("normalizePerfumeUrl branch 2: a relative path containing /perfume/ is resolved against baseUrl", async () => {
  const { ctx } = makeCtx();
  const expected = `${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`;
  await withFetchStub([pageRoute({ [expected]: MINIMAL })], async (calls) => {
    await run("get-perfume", {
      url: "perfume/Testhouse/Fakebloom-Nova-101.html",
    }, ctx);
    assertEquals(calls[0].url, expected);
  });
});

Deno.test("normalizePerfumeUrl branch 3: a bare slug with no /perfume/ marker is still forced under baseUrl with a leading slash", async () => {
  const { ctx } = makeCtx();
  const expected = `${BASE}/some-bare-path`;
  await withFetchStub([pageRoute({ [expected]: MINIMAL })], async (calls) => {
    await run("get-perfume", { url: "some-bare-path" }, ctx);
    assertEquals(calls[0].url, expected);
  });
});

// ---------------------------------------------------------------------------
// resolveNoteUrl (via list-by-note / find-by-notes) — 3 branches + throw
// ---------------------------------------------------------------------------

Deno.test("resolveNoteUrl branch 1: an absolute URL or a path containing /notes/ is used directly", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/notes/Vetiver-4.html`;
  await withFetchStub([pageRoute({ [url]: MINIMAL })], async (calls) => {
    await run("list-by-note", { note: url }, ctx);
    assertEquals(calls[0].url, url);
  });
});

Deno.test("resolveNoteUrl branch 1b: a bare '/notes/x' relative path (no scheme) is absUrl'd against base", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/notes/Vetiver-4.html`;
  await withFetchStub([pageRoute({ [url]: MINIMAL })], async (calls) => {
    await run("list-by-note", { note: "/notes/Vetiver-4.html" }, ctx);
    assertEquals(calls[0].url, url);
  });
});

Deno.test("resolveNoteUrl branch 2: an id-bearing slug (trailing -<digits>) is constructed directly, no DuckDuckGo call", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/notes/Agarwood-Oud-114.html`;
  await withFetchStub([pageRoute({ [url]: MINIMAL })], async (calls) => {
    await run("list-by-note", { note: "Agarwood-Oud-114" }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, url);
  });
});

Deno.test("resolveNoteUrl branch 3: a plain name with no id resolves via DuckDuckGo, preferring an id-bearing hit over an id-less one", async () => {
  const { ctx } = makeCtx();
  const idLess = `${BASE}/notes/vetiver-overview.html`;
  const idBearing = `${BASE}/notes/Vetiver-4.html`;
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([idLess, idBearing])),
      pageRoute({ [idBearing]: MINIMAL, [idLess]: MINIMAL }),
    ],
    async (calls) => {
      await run("list-by-note", { note: "Vetiver" }, ctx);
      assertEquals(calls[1].url, idBearing, "the id-bearing hit is preferred");
    },
  );
});

Deno.test("resolveNoteUrl branch 3b: falls back to an id-less /notes/ hit when no id-bearing hit exists", async () => {
  const { ctx } = makeCtx();
  const idLess = `${BASE}/notes/vetiver-overview.html`;
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([idLess])),
      pageRoute({ [idLess]: MINIMAL }),
    ],
    async (calls) => {
      await run("list-by-note", { note: "Vetiver" }, ctx);
      assertEquals(calls[1].url, idLess);
    },
  );
});

Deno.test("resolveNoteUrl throw: DuckDuckGo returns nothing /notes/-shaped -> descriptive error", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([
    duckDuckGoRoute(() => ddgPage(["https://unrelated.example/blog"])),
  ], async () => {
    await assertRejects(
      () => run("list-by-note", { note: "totally unknown note" }, ctx),
      Error,
      'Could not resolve note "totally unknown note"',
    );
  });
});

Deno.test("resolveNoteUrl: a resolved hit's #fragment and ?query are stripped before use", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/notes/Vetiver-4.html`;
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([`${url}?utm_source=x#section`])),
      pageRoute({ [url]: MINIMAL }),
    ],
    async (calls) => {
      await run("list-by-note", { note: "Vetiver" }, ctx);
      assertEquals(
        calls[1].url,
        url,
        "query/fragment stripped from the resolved hit",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// list-by-designer — 3 branches + throw
// ---------------------------------------------------------------------------

Deno.test("list-by-designer branch 1: an absolute URL or /designers/ path is used directly", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/designers/Testhouse.html`;
  await withFetchStub([pageRoute({ [url]: MINIMAL })], async (calls) => {
    await run("list-by-designer", { designer: url }, ctx);
    assertEquals(calls[0].url, url);
  });
});

Deno.test("list-by-designer branch 2: a bare slug is constructed directly, no DuckDuckGo call", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/designers/Yves-Saint-Laurent.html`;
  await withFetchStub([pageRoute({ [url]: MINIMAL })], async (calls) => {
    await run("list-by-designer", { designer: "Yves-Saint-Laurent" }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, url);
  });
});

Deno.test("list-by-designer branch 3: a plain house name resolves via DuckDuckGo", async () => {
  const { ctx } = makeCtx();
  const url = `${BASE}/designers/Testhouse.html`;
  await withFetchStub(
    [duckDuckGoRoute(() => ddgPage([url])), pageRoute({ [url]: MINIMAL })],
    async (calls) => {
      await run("list-by-designer", { designer: "Test House" }, ctx);
      assertEquals(calls[1].url, url);
    },
  );
});

// ---------------------------------------------------------------------------
// parseNotes (via get-perfume) — container/heading permutations both sides
// ---------------------------------------------------------------------------

function perfumePage(pyramidInner: string): string {
  return `<!doctype html><html><body>
    <div itemprop="brand"><span itemprop="name">Testhouse</span></div>
    <div id="pyramid">${pyramidInner}</div>
  </body></html>`;
}

Deno.test("parseNotes: containers.length===1 (no heading pairing) -> general bucket", async () => {
  const html = perfumePage(
    `<div class="pyramid-level-container"><a href="/notes/Bergamot-75.html">Bergamot</a></div>`,
  );
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const notes = res.payload.notes as { general: string[]; top: string[] };
  assertEquals(notes.general, ["Bergamot"]);
  assertEquals(notes.top, []);
});

Deno.test("parseNotes: containers.length===2, no heading match -> positional top/middle fallback (order=[top,middle,base])", async () => {
  const html = perfumePage(`
    <div class="pyramid-level-container"><a href="/notes/Bergamot-75.html">Bergamot</a></div>
    <div class="pyramid-level-container"><a href="/notes/Rose-3.html">Rose</a></div>
  `);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const notes = res.payload.notes as {
    top: string[];
    middle: string[];
    base: string[];
  };
  assertEquals(notes.top, ["Bergamot"]);
  assertEquals(notes.middle, ["Rose"]);
  assertEquals(notes.base, []);
});

Deno.test("parseNotes: containers present but headings.length !== containers.length (mismatched) -> positional fallback, not heading-keyed", async () => {
  const html = perfumePage(`
    <h4>Top Notes</h4>
    <div class="pyramid-level-container"><a href="/notes/Bergamot-75.html">Bergamot</a></div>
    <div class="pyramid-level-container"><a href="/notes/Rose-3.html">Rose</a></div>
  `);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const notes = res.payload.notes as {
    top: string[];
    middle: string[];
  };
  // 1 heading vs 2 containers -> mismatch -> positional fallback: first two
  // containers become top/middle regardless of the (single, unmatched) heading.
  assertEquals(notes.top, ["Bergamot"]);
  assertEquals(notes.middle, ["Rose"]);
});

Deno.test("parseNotes: zero containers -> notes read directly off the #pyramid element into general", async () => {
  const html = perfumePage(`<a href="/notes/Bergamot-75.html">Bergamot</a>`);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals((res.payload.notes as { general: string[] }).general, [
    "Bergamot",
  ]);
});

Deno.test("classifyLevel: a 'Heart Notes' heading classifies as middle (heart is a middle-notes synonym)", async () => {
  const html = perfumePage(`
    <h4>Top Notes</h4>
    <div class="pyramid-level-container"><a href="/notes/Bergamot-75.html">Bergamot</a></div>
    <h4>Heart Notes</h4>
    <div class="pyramid-level-container"><a href="/notes/Rose-3.html">Rose</a></div>
    <h4>Base Notes</h4>
    <div class="pyramid-level-container"><a href="/notes/Musk-99.html">Musk</a></div>
  `);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const notes = res.payload.notes as { middle: string[] };
  assertEquals(notes.middle, ["Rose"]);
});

// ---------------------------------------------------------------------------
// parseAlsoLike — heading-present/absent + self-URL filter
// ---------------------------------------------------------------------------

Deno.test("parseAlsoLike: no 'also like'/'reminds' heading present -> empty similar list", async () => {
  const html = perfumePage("") +
    `<div><a href="/perfume/Other/Thing-2.html">Thing</a></div>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(res.payload.similar, []);
});

Deno.test("parseAlsoLike: 'reminds' wording also matches the heading (not just 'also like')", async () => {
  const html = `<!doctype html><html><body>
    <div itemprop="brand"><span itemprop="name">Testhouse</span></div>
    <h3>Reminds me of</h3>
    <div><a href="/perfume/Other/Thing-2.html">Thing</a></div>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/perfume/T/N-1.html`]: html })],
    async () => {
      await run("get-perfume", { url: "/perfume/T/N-1.html" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const similar = res.payload.similar as Array<{ name: string }>;
  assertEquals(similar.length, 1);
});

Deno.test("parseAlsoLike: the self-referencing perfume URL is filtered out of its own similar list", async () => {
  const selfUrl = "/perfume/T/N-1.html";
  const html = `<!doctype html><html><body>
    <div itemprop="brand"><span itemprop="name">Testhouse</span></div>
    <h3>People who like this also like</h3>
    <div><a href="${selfUrl}">Self link (must be filtered)</a><a href="/perfume/Other/Thing-2.html">Thing</a></div>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}${selfUrl}`]: html })],
    async () => {
      await run("get-perfume", { url: selfUrl }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const similar = res.payload.similar as Array<{ url: string }>;
  assertEquals(similar.length, 1);
  assertEquals(similar[0].url, `${BASE}/perfume/Other/Thing-2.html`);
});

// ---------------------------------------------------------------------------
// collectPerfumeRefs — cap(500)/dedup/non-perfume-href skip (via list-by-note)
// ---------------------------------------------------------------------------

Deno.test("collectPerfumeRefs: dedups identical hrefs and skips a non-/perfume/ link", async () => {
  const html = `<!doctype html><html><body>
    <a href="/perfume/Testhouse/Fakebloom-Nova-101.html">A</a>
    <a href="/perfume/Testhouse/Fakebloom-Nova-101.html">A dup</a>
    <a href="/designers/Testhouse.html">Not a perfume link</a>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/notes/Vetiver-4.html`]: html })],
    async () => {
      await run("list-by-note", { note: "Vetiver-4" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  assertEquals((res.payload.results as unknown[]).length, 1);
});

Deno.test("collectPerfumeRefs: caps at 500 results even when the page lists more", async () => {
  const links = Array.from(
    { length: 520 },
    (_, i) => `<a href="/perfume/House/Item-${1000 + i}.html">Item ${i}</a>`,
  ).join("\n");
  const html = `<!doctype html><html><body>${links}</body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/designers/Big.html`]: html })],
    async () => {
      await run("list-by-designer", { designer: "Big" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  assertEquals((res.payload.results as unknown[]).length, 500);
});

// ---------------------------------------------------------------------------
// search — locale-collapse + dedup + limit boundary + zero-match
// ---------------------------------------------------------------------------

Deno.test("search: a DuckDuckGo hit whose path doesn't match /perfume/.../…-<id>.html is silently skipped", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [duckDuckGoRoute(() => ddgPage(["https://unrelated.example/blog-post"]))],
    async () => {
      await run("search", { query: "x" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("search: default limit is 20 when omitted", async () => {
  const urls = Array.from(
    { length: 25 },
    (_, i) => `${BASE}/perfume/House/Item-${2000 + i}.html`,
  );
  const { ctx, written } = makeCtx();
  await withFetchStub([duckDuckGoRoute(() => ddgPage(urls))], async () => {
    await run("search", { query: "x" }, ctx);
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals((res.payload.results as unknown[]).length, 20);
});

// ---------------------------------------------------------------------------
// find-by-notes — need threshold + limit slice + sort order
// ---------------------------------------------------------------------------

Deno.test("find-by-notes: mode=all requires matching EVERY note (threshold == notes.length)", async () => {
  const noteA = `${BASE}/notes/A-1.html`;
  const noteB = `${BASE}/notes/B-2.html`;
  const noteC = `${BASE}/notes/C-3.html`;
  const htmlA =
    `<html><body><a href="/perfume/H/X-1.html">X</a><a href="/perfume/H/Y-2.html">Y</a></body></html>`;
  const htmlB = `<html><body><a href="/perfume/H/X-1.html">X</a></body></html>`;
  const htmlC = `<html><body><a href="/perfume/H/X-1.html">X</a></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [noteA]: htmlA, [noteB]: htmlB, [noteC]: htmlC })],
    async () => {
      await run(
        "find-by-notes",
        { notes: ["A-1", "B-2", "C-3"], mode: "all" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "noteIntersection")!;
  const results = res.payload.results as Array<{ name: string }>;
  assertEquals(results.length, 1, "only X matches all three notes");
  assertEquals(results[0].name, "X");
});

Deno.test("find-by-notes: results are sorted by matchedNotes desc, then name asc; limit slices after sorting", async () => {
  const noteA = `${BASE}/notes/A-1.html`;
  const noteB = `${BASE}/notes/B-2.html`;
  const htmlA =
    `<html><body><a href="/perfume/H/Zeta-1.html">Zeta</a><a href="/perfume/H/Alpha-2.html">Alpha</a></body></html>`;
  const htmlB =
    `<html><body><a href="/perfume/H/Alpha-2.html">Alpha</a></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [noteA]: htmlA, [noteB]: htmlB })],
    async () => {
      await run(
        "find-by-notes",
        { notes: ["A-1", "B-2"], mode: "any", limit: 1 },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "noteIntersection")!;
  const results = res.payload.results as Array<
    { name: string; matchedNotes: number }
  >;
  assertEquals(results.length, 1, "limit=1 slices AFTER sorting");
  assertEquals(
    results[0].name,
    "Alpha",
    "Alpha matches both notes, ranks first",
  );
  assertEquals(results[0].matchedNotes, 2);
});

// ---------------------------------------------------------------------------
// instanceSlug — symbol-only input + 80-char truncation (via search)
// ---------------------------------------------------------------------------

Deno.test("instanceSlug: an all-symbol query collapses to the literal fallback 'result'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([duckDuckGoRoute(() => ddgPage([]))], async () => {
    await run("search", { query: "!!!///???" }, ctx);
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "result");
});

Deno.test("instanceSlug: output is truncated to 80 characters", async () => {
  const longQuery = "word ".repeat(40); // far more than 80 chars once slugified
  const { ctx, written } = makeCtx();
  await withFetchStub([duckDuckGoRoute(() => ddgPage([]))], async () => {
    await run("search", { query: longQuery }, ctx);
  });
  const res = written.find((w) => w.spec === "search")!;
  assert(
    res.name.length <= 80,
    `slug must be <=80 chars, got ${res.name.length}`,
  );
});
