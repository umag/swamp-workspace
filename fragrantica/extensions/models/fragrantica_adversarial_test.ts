/**
 * Adversarial suite: hostile/boundary inputs, tampered/malformed responses,
 * SSRF surfaces, redirect handling, and injection-inert output.
 *
 * Tests are labeled "fixed:" when they assert CLOSED behavior (the fix is
 * live in fragrantica.ts, LB4–LB9/LB11) and "pin:" when they characterize a
 * residual, accepted-by-decision risk that is intentionally NOT fixed
 * (LB10's false-positive selector, LB12's lossless-storage contract — both
 * documented inline at the test and in CHANGELOG.md).
 *
 * Every test here corresponds to a latent bug tracked in the LOCAL
 * `fragrantica-latent-bugs` @magistr/issue-lifecycle model (never the
 * swamp.club Lab — see CLAUDE.md's Anti-Bypass rule and the plan's
 * potentialChallenges). Hostile hosts/IPs stay inside RFC 5737
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) or RFC 2606 (`.example`,
 * `.invalid`) ranges; the real-world cloud-metadata target
 * 169.254.169.254 is named only in a comment, never fetched.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";
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

function htmlResponse(body: string, status = 200, contentType = "text/html") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
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

const MINIMAL_PERFUME_HTML =
  `<!doctype html><html><body><div itemprop="brand"><span itemprop="name">Testhouse</span></div></body></html>`;

// ---------------------------------------------------------------------------
// Bug 1 — SSRF via unvalidated absolute URL / foreign-path args (HIGH)
// ---------------------------------------------------------------------------

Deno.test("fixed: get-perfume rejects a caller-supplied hostile absolute URL BEFORE fetching (SSRF closed, HIGH)", async () => {
  // fragrantica-latent-bugs #1, closed. normalizePerfumeUrl now enforces a
  // host allowlist (the configured base host, or fragrantica.com/
  // *.fragrantica.com) before get-perfume ever calls fetch. Real-world
  // equivalent target: 169.254.169.254 (cloud metadata) — never fetched
  // here, only named.
  const hostileUrl = "http://198.51.100.9/perfume/Anything/Name-1.html";
  const { ctx } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileUrl]: MINIMAL_PERFUME_HTML })],
    async (calls) => {
      await assertRejects(
        () => run("get-perfume", { url: hostileUrl }, ctx),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0, "the hostile host must never be fetched");
    },
  );
});

Deno.test("fixed: similar / list-by-designer / list-by-note / find-by-notes ALSO reject a hostile absolute URL before fetching (SSRF closed across all 5 URL-taking methods)", async () => {
  const hostileUrl = "http://198.51.100.9/perfume/Anything/Name-1.html";
  const hostileDesignerUrl = "http://203.0.113.7/designers/Anything.html";
  const hostileNoteUrl = "http://203.0.113.8/notes/Anything-1.html";
  const { ctx: ctx1 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileUrl]: MINIMAL_PERFUME_HTML })],
    async (calls) => {
      await assertRejects(
        () => run("similar", { url: hostileUrl }, ctx1),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0);
    },
  );
  const { ctx: ctx2 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileDesignerUrl]: "<html><body></body></html>" })],
    async (calls) => {
      await assertRejects(
        () => run("list-by-designer", { designer: hostileDesignerUrl }, ctx2),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0);
    },
  );
  const { ctx: ctx3 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileNoteUrl]: "<html><body></body></html>" })],
    async (calls) => {
      await assertRejects(
        () => run("list-by-note", { note: hostileNoteUrl }, ctx3),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0);
    },
  );
  const { ctx: ctx4 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileNoteUrl]: "<html><body></body></html>" })],
    async (calls) => {
      await assertRejects(
        () => run("find-by-notes", { notes: [hostileNoteUrl] }, ctx4),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0);
    },
  );
});

Deno.test("fixed: a host that merely ends with 'fragrantica.com' without the dot boundary, or merely STARTS with it, is still rejected (allowlist must be exact-match or dot-suffixed, never a substring check)", async () => {
  // Guards the allowlist IMPLEMENTATION itself against the classic
  // suffix-check bug: `host.endsWith("fragrantica.com")` with no leading dot
  // would wrongly allow "evilfragrantica.com"; `host.includes("fragrantica.com")`
  // would wrongly allow "fragrantica.com.example" (fragrantica.com as a
  // PREFIX — the attacker actually controls the real registrable domain).
  // Both are attack literals used only as REJECTED inputs, never fetched.
  const noDotBoundary =
    "https://evilfragrantica.com/perfume/Anything/Name-1.html";
  const prefixTrick =
    "https://fragrantica.com.example/perfume/Anything/Name-1.html";
  const { ctx: ctx1 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [noDotBoundary]: MINIMAL_PERFUME_HTML })],
    async (calls) => {
      await assertRejects(
        () => run("get-perfume", { url: noDotBoundary }, ctx1),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0);
    },
  );
  const { ctx: ctx2 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [prefixTrick]: MINIMAL_PERFUME_HTML })],
    async (calls) => {
      await assertRejects(
        () => run("get-perfume", { url: prefixTrick }, ctx2),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// Bug 2 — URIError crash on malformed percent-encoding (HIGH)
// ---------------------------------------------------------------------------

Deno.test("fixed: get-perfume with a malformed percent-escape URL falls back to the raw slug instead of throwing (HIGH closed)", async () => {
  // fragrantica-latent-bugs #2, closed. slugToText now wraps
  // decodeURIComponent in try/catch and falls back to the raw (still
  // percent-encoded) slug text instead of throwing, so a malformed
  // %-escape in the REQUESTED url no longer aborts the whole get-perfume
  // call. The malformed escape is placed in the NAME segment (not the
  // brand segment) because `name` is always URL-derived and unconditional
  // in the written payload — unlike `brand`, which a page-derived
  // itemprop would otherwise shadow, this directly observes the
  // raw-slug-fallback value with no ambiguity.
  const badUrl = `${BASE}/perfume/Testhouse/Bad%zzName-1.html`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [badUrl]: MINIMAL_PERFUME_HTML })],
    async () => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Bad%zzName-1.html" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(
    res.payload.name,
    "Bad%zzName",
    "name falls back to the raw, undecoded slug rather than throwing",
  );
  assertEquals(res.payload.id, 1);
});

Deno.test("fixed: a poisoned %-href in a designer listing no longer denies the whole page — the good link still resolves (HIGH closed)", async () => {
  // fragrantica-latent-bugs #2 (continued, closed). A malformed href among
  // otherwise-valid perfume links no longer throws for the whole
  // collectPerfumeRefs call — every link resolves (the bad one via the raw-
  // slug fallback).
  const html = `<!doctype html><html><body>
    <a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova</a>
    <a href="/perfume/Bad%zzBrand/Broken-2.html">Broken link</a>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/designers/Testhouse.html`]: html })],
    async () => {
      await run("list-by-designer", { designer: "Testhouse" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "listing")!;
  const results = res.payload.results as Array<
    { name: string; id?: number }
  >;
  assertEquals(
    results.length,
    2,
    "both links resolve — the malformed one falls back instead of throwing",
  );
  assertEquals(results[0].id, 101);
  assertEquals(results[1].id, 2);
});

// ---------------------------------------------------------------------------
// Bug 3 — silent-empty SUCCESS on structural drift / non-HTML 200 (HIGH)
// ---------------------------------------------------------------------------

Deno.test("fixed: a non-HTML 200 body (e.g. a JSON error page) now throws instead of silently writing an empty perfume (HIGH closed)", async () => {
  // fragrantica-latent-bugs #3, closed. get-perfume now requires
  // page-derived substance (itemprop brand, accords, notes, perfumers,
  // rating, gender, year, or description) before writeResource — a JSON
  // body carries none of these, so the call throws instead of "succeeding"
  // with an empty-ish perfume built only from the URL's own shape.
  const jsonBody = JSON.stringify({ error: "not html" });
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({
      [`${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`]: jsonBody,
    })],
    async () => {
      await assertRejects(
        () =>
          run(
            "get-perfume",
            { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
            ctx,
          ),
        Error,
        "No recognizable perfume content",
      );
    },
  );
  assertEquals(
    written.find((w) => w.spec === "perfume"),
    undefined,
    "no perfume resource is written when the page carries no recognizable content",
  );
});

Deno.test("fixed: a redesigned page with none of the expected selectors now throws instead of 'succeeding' with an empty perfume (HIGH closed)", async () => {
  const html =
    `<!doctype html><html><body><p>Page redesigned, nothing recognizable.</p></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({
      [`${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`]: html,
    })],
    async () => {
      await assertRejects(
        () =>
          run(
            "get-perfume",
            { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
            ctx,
          ),
        Error,
        "No recognizable perfume content",
      );
    },
  );
  assertEquals(written.find((w) => w.spec === "perfume"), undefined);
});

// ---------------------------------------------------------------------------
// Bug 4 — redirect-follow bypasses host intent (MEDIUM, closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: fetchPage issues fetch() with redirect:'manual' — no transparent redirect-follow (MEDIUM closed)", async () => {
  // fragrantica-latent-bugs #4, closed. fetchPage now sets redirect: "manual"
  // on every fetch() call (including every redirect hop), so a 3xx response
  // is handed back to fragrantica.ts instead of being followed transparently
  // by the runtime -- every hop is re-validated against the host allowlist
  // before being followed (see the two tests below).
  const { ctx } = makeCtx();
  const original = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response(MINIMAL_PERFUME_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await run(
      "get-perfume",
      { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
      ctx,
    );
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(
    capturedInit?.redirect,
    "manual",
    "redirect:'manual' is set so a 3xx response is inspected, not auto-followed",
  );
});

Deno.test("fixed: a 302 redirect to a hostile RFC 5737 host is rejected — the hostile host is NEVER fetched (MEDIUM closed)", async () => {
  const startUrl = `${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`;
  const hostileTarget = "http://198.51.100.30/perfume/Anything/Name-1.html";
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        if (req.url === startUrl) {
          return new Response("", {
            status: 302,
            headers: { location: hostileTarget },
          });
        }
        return undefined;
      },
      pageRoute({ [hostileTarget]: MINIMAL_PERFUME_HTML }),
    ],
    async (calls) => {
      await assertRejects(
        () =>
          run(
            "get-perfume",
            { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
            ctx,
          ),
        Error,
        "disallowed host",
      );
      assertEquals(
        calls.length,
        1,
        "only the initial (allowlisted) request is made — the hostile redirect target is never fetched",
      );
    },
  );
});

Deno.test("fixed: a 302 redirect to an allowlisted *.fragrantica.com hop is followed to substance (MEDIUM closed)", async () => {
  const startUrl = `${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`;
  const followTarget =
    "https://de.fragrantica.com/perfume/Testhouse/Fakebloom-Nova-101.html";
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        if (req.url === startUrl) {
          return new Response("", {
            status: 302,
            headers: { location: followTarget },
          });
        }
        return undefined;
      },
      pageRoute({ [followTarget]: MINIMAL_PERFUME_HTML }),
    ],
    async (calls) => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
      assertEquals(
        calls.length,
        2,
        "the initial request PLUS the allowlisted redirect hop",
      );
      assertEquals(calls[1].url, followTarget);
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(res.payload.brand, "Testhouse");
});

// ---------------------------------------------------------------------------
// Bug 5 — second-order SSRF via DuckDuckGo poisoning (MEDIUM, closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: a DuckDuckGo result pointing at a hostile host is rejected — the hostile host is NEVER fetched (second-order SSRF closed, MEDIUM)", async () => {
  // fragrantica-latent-bugs #5, closed. resolveNoteUrl's DuckDuckGo-resolved
  // hit is now checked with assertHostAllowed BEFORE it is ever fetched -- a
  // poisoned/MITM'd DuckDuckGo response pointing at an attacker-controlled
  // host is rejected instead of dereferenced.
  const hostileNoteUrl = "http://198.51.100.20/notes/Poisoned-9.html";
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([hostileNoteUrl])),
      pageRoute({ [hostileNoteUrl]: "<html><body></body></html>" }),
    ],
    async (calls) => {
      await assertRejects(
        () => run("list-by-note", { note: "some plain note name" }, ctx),
        Error,
        "disallowed host",
      );
      assertEquals(
        calls.length,
        1,
        "only the DuckDuckGo POST is made — the poisoned hit is never fetched",
      );
    },
  );
});

Deno.test("fixed: list-by-designer's DuckDuckGo-resolved hit is ALSO rejected when it points at a hostile host (second-order SSRF closed, MEDIUM)", async () => {
  const hostileDesignerUrl = "http://198.51.100.21/designers/Poisoned.html";
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([hostileDesignerUrl])),
      pageRoute({ [hostileDesignerUrl]: "<html><body></body></html>" }),
    ],
    async (calls) => {
      await assertRejects(
        () =>
          run(
            "list-by-designer",
            { designer: "some plain house name" },
            ctx,
          ),
        Error,
        "disallowed host",
      );
      assertEquals(
        calls.length,
        1,
        "only the DuckDuckGo POST is made — the poisoned hit is never fetched",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Bug 6 — unbounded note fan-out (MEDIUM, closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: find-by-notes rejects a notes[] array longer than maxNotes BEFORE any fetch (MEDIUM closed)", async () => {
  // fragrantica-latent-bugs #6, closed. A `maxNotes` global arg (default 20)
  // now caps notes.length; exceeding it throws before the fan-out loop makes
  // a single fetch.
  const NOTE_COUNT = 25;
  const notes = Array.from(
    { length: NOTE_COUNT },
    (_, i) => `Note${i}-${i + 1}`,
  );
  const pages: Record<string, string> = {};
  for (let i = 0; i < NOTE_COUNT; i++) {
    pages[`${BASE}/notes/Note${i}-${i + 1}.html`] =
      "<html><body></body></html>";
  }
  const { ctx } = makeCtx();
  await withFetchStub([pageRoute(pages)], async (calls) => {
    await assertRejects(
      () => run("find-by-notes", { notes }, ctx),
      Error,
      "exceeds",
    );
    assertEquals(calls.length, 0, "the cap is enforced before any fetch");
  });
});

Deno.test("fixed: find-by-notes accepts exactly the default maxNotes (20) — one fetch per note", async () => {
  const NOTE_COUNT = 20;
  const notes = Array.from(
    { length: NOTE_COUNT },
    (_, i) => `Note${i}-${i + 1}`,
  );
  const pages: Record<string, string> = {};
  for (let i = 0; i < NOTE_COUNT; i++) {
    pages[`${BASE}/notes/Note${i}-${i + 1}.html`] =
      "<html><body></body></html>";
  }
  const { ctx } = makeCtx();
  await withFetchStub([pageRoute(pages)], async (calls) => {
    await run("find-by-notes", { notes }, ctx);
    assertEquals(calls.length, NOTE_COUNT);
  });
});

Deno.test("fixed: globalArgs.maxNotes overrides the default cap", async () => {
  const NOTE_COUNT = 3;
  const notes = Array.from(
    { length: NOTE_COUNT },
    (_, i) => `Note${i}-${i + 1}`,
  );
  const pages: Record<string, string> = {};
  for (let i = 0; i < NOTE_COUNT; i++) {
    pages[`${BASE}/notes/Note${i}-${i + 1}.html`] =
      "<html><body></body></html>";
  }
  const { ctx } = makeCtx({ baseUrl: BASE, maxNotes: 2 });
  await withFetchStub([pageRoute(pages)], async (calls) => {
    await assertRejects(
      () => run("find-by-notes", { notes }, ctx),
      Error,
      "exceeds",
    );
    assertEquals(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bug 7 — no fetch timeout / AbortSignal (MEDIUM, closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: fetchPage's fetch() call carries an AbortSignal/timeout (MEDIUM closed)", async () => {
  // fragrantica-latent-bugs #7, closed. fetchPage now runs under withTimeout,
  // an AbortController whose signal aborts after globalArgs.timeoutMs
  // (default 15000ms) — a hung response is now bounded instead of stalling
  // the method forever. We don't actually hang a test (that would make CI
  // slow/flaky); instead we assert the captured RequestInit carries a real
  // AbortSignal.
  const { ctx } = makeCtx();
  const original = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response(MINIMAL_PERFUME_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await run(
      "get-perfume",
      { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
      ctx,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert(
    capturedInit?.signal instanceof AbortSignal,
    "an AbortSignal is attached to the request",
  );
});

Deno.test("fixed: duckDuckGo's POST also carries an AbortSignal/timeout (MEDIUM closed)", async () => {
  const { ctx } = makeCtx();
  const original = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response(ddgPage([]), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await run("search", { query: "x" }, ctx);
  } finally {
    globalThis.fetch = original;
  }
  assert(capturedInit?.signal instanceof AbortSignal);
});

// ---------------------------------------------------------------------------
// Bug 8 — duplicate-note double-count in find-by-notes (MEDIUM correctness,
// closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: passing the SAME note twice in find-by-notes fetches it only ONCE and does not double-count (MEDIUM correctness closed)", async () => {
  // fragrantica-latent-bugs #8, closed. The fan-out loop now dedups by the
  // RESOLVED note URL: notes=["Vetiver-4","Vetiver-4"] resolves to the same
  // URL both times, so the second occurrence is skipped entirely (no second
  // fetch), and `need` is computed from the DISTINCT note count, not
  // args.notes.length.
  const html = `<!doctype html><html><body>
    <a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova</a>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/notes/Vetiver-4.html`]: html })],
    async (calls) => {
      await run("find-by-notes", { notes: ["Vetiver-4", "Vetiver-4"] }, ctx);
      assertEquals(
        calls.length,
        1,
        "the identical note page is fetched only ONCE",
      );
    },
  );
  const res = written.find((w) => w.spec === "noteIntersection")!;
  const results = res.payload.results as Array<{ matchedNotes: number }>;
  assertEquals(results.length, 1);
  assertEquals(
    results[0].matchedNotes,
    1,
    "matched against the single DISTINCT note, not the duplicated count",
  );
});

// ---------------------------------------------------------------------------
// Bug 9 — instanceSlug resource-name collision (LOW, closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: two distinct search queries that would have collapsed to the same slug no longer collide (LOW closed)", async () => {
  // fragrantica-latent-bugs #9, closed. instanceSlug now appends a
  // deterministic 8-hex-char FNV-1a hash of the RAW input, so "A/B" and
  // "A B" (which both collapse to the same lossy base "A-B") get distinct
  // instance names instead of clobbering each other's written resource.
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [duckDuckGoRoute(() => ddgPage([]))],
    async () => {
      await run("search", { query: "A/B" }, ctx);
      await run("search", { query: "A B" }, ctx);
    },
  );
  const names = written.filter((w) => w.spec === "search").map((w) => w.name);
  assertEquals(names.length, 2);
  assertNotEquals(
    names[0],
    names[1],
    "distinct queries 'A/B' and 'A B' no longer collide on the same instance slug",
  );
});

// ---------------------------------------------------------------------------
// Bug 10 — parseAccords unclamped strength / false positives (LOW)
// ---------------------------------------------------------------------------

Deno.test("fixed: parseAccords clamps strength to 100 — a width:120% bar is recorded as strength 100 (LOW closed)", async () => {
  // fragrantica-latent-bugs #10, closed (clamp only). The false-positive
  // selector match on ANY colored width: bar (next test) is a SEPARATE,
  // accepted residual risk -- it cannot be fixed here without breaking the
  // byte-frozen perfume.html accords contract pin, since real accord bars
  // and this synthetic "unrelated progress bar" share identical markup shape.
  const html = `<!doctype html><html><body>
    <div itemprop="brand"><span itemprop="name">Testhouse</span></div>
    <div style="background:#ff00ff;width:120%;">overdriven</div>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({
      [`${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`]: html,
    })],
    async () => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  const accords = res.payload.accords as Array<
    { name: string; strength: number }
  >;
  assertEquals(accords, [{ name: "overdriven", strength: 100 }]);
});

Deno.test("pin: parseAccords matches ANY colored div with a width style, not just the real accord-bar markup (accepted residual, not separable, LOW)", async () => {
  const html = `<!doctype html><html><body>
    <div itemprop="brand"><span itemprop="name">Testhouse</span></div>
    <div style="background:red;width:33%;">unrelated progress bar</div>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({
      [`${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`]: html,
    })],
    async () => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(res.payload.accords, [{
    name: "unrelated progress bar",
    strength: 33,
  }]);
});

// ---------------------------------------------------------------------------
// Bug 11 — hardcoded fimgs.net thumbnail ignores baseUrl (LOW, closed)
// ---------------------------------------------------------------------------

Deno.test("fixed: imageBaseUrl overrides the perfume thumbnail host (LOW closed)", async () => {
  // fragrantica-latent-bugs #11, closed. refFromPerfumeUrl/parsePerfume now
  // thread an `imageBase` parameter (globalArgs.imageBaseUrl, defaulting to
  // the unchanged "https://fimgs.net") through to the thumbnail URL --
  // overriding it no longer requires overriding baseUrl (which stays
  // fragrantica-page-specific).
  const { ctx, written } = makeCtx({
    baseUrl: "https://mirror.example",
    imageBaseUrl: "https://custom-img.example",
  });
  await withFetchStub(
    [pageRoute({
      "https://mirror.example/perfume/Testhouse/Fakebloom-Nova-101.html":
        MINIMAL_PERFUME_HTML,
    })],
    async () => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(
    res.payload.thumbnail,
    "https://custom-img.example/mdimg/perfume-thumbs/375x500.101.jpg",
    "thumbnail host follows the imageBaseUrl override",
  );
});

Deno.test("pin: WITHOUT an imageBaseUrl override, the thumbnail still defaults to fimgs.net even when baseUrl is overridden (unchanged default)", async () => {
  const { ctx, written } = makeCtx({ baseUrl: "https://mirror.example" });
  await withFetchStub(
    [pageRoute({
      "https://mirror.example/perfume/Testhouse/Fakebloom-Nova-101.html":
        MINIMAL_PERFUME_HTML,
    })],
    async () => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(
    res.payload.thumbnail,
    "https://fimgs.net/mdimg/perfume-thumbs/375x500.101.jpg",
    "default thumbnail host is unchanged",
  );
});

// ---------------------------------------------------------------------------
// Bug 12 — stored parsed values unsanitized (LOW, accepted by decision)
// ---------------------------------------------------------------------------

Deno.test("pin: a <script>-bearing note/brand name is stored VERBATIM — intentional lossless-storage contract, not a bug (accepted by decision)", async () => {
  // fragrantica-latent-bugs #12, accepted by decision (not fixed). parsePerfume
  // performs no output encoding or stripping BY DESIGN: sanitizing at parse
  // time would corrupt legitimate brand/note names, and this model never
  // renders its stored data -- encoding is a render-time responsibility for
  // whichever downstream consumer displays it. See parsePerfume's doc
  // comment in fragrantica.ts for the full rationale.
  const html = `<!doctype html><html><body>
    <div itemprop="brand"><span itemprop="name">&lt;script&gt;alert(1)&lt;/script&gt;</span></div>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({
      [`${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`]: html,
    })],
    async () => {
      await run(
        "get-perfume",
        { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "perfume")!;
  assertEquals(res.payload.brand, "<script>alert(1)</script>");
});

// ---------------------------------------------------------------------------
// Additional hostile-response pins (non-throw hazards, contract with hosts)
// ---------------------------------------------------------------------------

Deno.test("pin: a non-2xx status carrying a Cloudflare-challenge body throws WITH the challenge hint appended", async () => {
  const cfBody =
    `<html><body class="cf-chl-container"><h1>Attention Required! | Cloudflare</h1><p>Just a moment...</p></body></html>`;
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      pageRoute({}),
      (req) => {
        if (req.url === `${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`) {
          return new Response(cfBody, { status: 503 });
        }
        return undefined;
      },
    ],
    async () => {
      await assertRejects(
        () =>
          run(
            "get-perfume",
            { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
            ctx,
          ),
        Error,
        "Cloudflare challenge",
      );
    },
  );
});

Deno.test("pin: a non-2xx status WITHOUT challenge wording throws the plain 'Fetch failed (<status>)' message", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        if (req.url === `${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return undefined;
      },
    ],
    async () => {
      const err = await assertRejects(
        () =>
          run(
            "get-perfume",
            { url: "/perfume/Testhouse/Fakebloom-Nova-101.html" },
            ctx,
          ),
        Error,
      );
      assert(String(err).includes("Fetch failed (500)"));
      assert(!String(err).includes("Cloudflare"));
    },
  );
});

Deno.test("pin: search's DuckDuckGo POST failing (non-ok) throws with a rate-limit hint", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => new Response("blocked", { status: 429 })],
    async () => {
      await assertRejects(
        () => run("search", { query: "x" }, ctx),
        Error,
        "DuckDuckGo search failed (429)",
      );
    },
  );
});

Deno.test("could-not-resolve: list-by-designer's DuckDuckGo fallback finding nothing throws a descriptive error", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [duckDuckGoRoute(() => ddgPage([]))],
    async () => {
      await assertRejects(
        () =>
          run("list-by-designer", { designer: "no such house at all" }, ctx),
        Error,
        'Could not resolve designer "no such house at all"',
      );
    },
  );
});
