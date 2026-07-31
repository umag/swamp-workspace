/**
 * Adversarial suite: hostile/boundary inputs, tampered/malformed responses,
 * SSRF surfaces, redirect handling, and injection-inert output — every test
 * here PINS current (including current-but-risky) behavior, it never fixes
 * it. fragrantica.ts is UNMODIFIED by this change (byte-freeze).
 *
 * Every "pin:" test corresponds to a latent bug tracked in the LOCAL
 * `fragrantica-latent-bugs` @magistr/issue-lifecycle model (never the
 * swamp.club Lab — see CLAUDE.md's Anti-Bypass rule and the plan's
 * potentialChallenges). Hostile hosts/IPs stay inside RFC 5737
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) or RFC 2606 (`.example`,
 * `.invalid`) ranges; the real-world cloud-metadata target
 * 169.254.169.254 is named only in a comment, never fetched.
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

Deno.test("pin: get-perfume fetches a caller-supplied hostile absolute URL verbatim — NO base-host allowlist (SSRF, HIGH)", async () => {
  // fragrantica-latent-bugs #1. normalizePerfumeUrl returns any ^https?://
  // input unchanged; get-perfume then fetches it with no check that it is
  // on the configured baseUrl's host. Real-world equivalent target:
  // 169.254.169.254 (cloud metadata) — never fetched here, only named.
  const hostileUrl = "http://198.51.100.9/perfume/Anything/Name-1.html";
  const { ctx } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileUrl]: MINIMAL_PERFUME_HTML })],
    async (calls) => {
      await run("get-perfume", { url: hostileUrl }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(
        calls[0].url,
        hostileUrl,
        "the hostile host was fetched, unvalidated",
      );
    },
  );
});

Deno.test("pin: similar / list-by-designer / list-by-note / find-by-notes ALSO fetch a hostile absolute URL verbatim (SSRF surface spans all 5 URL-taking methods)", async () => {
  const hostileUrl = "http://198.51.100.9/perfume/Anything/Name-1.html";
  const hostileDesignerUrl = "http://203.0.113.7/designers/Anything.html";
  const hostileNoteUrl = "http://203.0.113.8/notes/Anything-1.html";
  const { ctx: ctx1 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileUrl]: MINIMAL_PERFUME_HTML })],
    async (calls) => {
      await run("similar", { url: hostileUrl }, ctx1);
      assertEquals(calls[0].url, hostileUrl);
    },
  );
  const { ctx: ctx2 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileDesignerUrl]: "<html><body></body></html>" })],
    async (calls) => {
      await run("list-by-designer", { designer: hostileDesignerUrl }, ctx2);
      assertEquals(calls[0].url, hostileDesignerUrl);
    },
  );
  const { ctx: ctx3 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileNoteUrl]: "<html><body></body></html>" })],
    async (calls) => {
      await run("list-by-note", { note: hostileNoteUrl }, ctx3);
      assertEquals(calls[0].url, hostileNoteUrl);
    },
  );
  const { ctx: ctx4 } = makeCtx();
  await withFetchStub(
    [pageRoute({ [hostileNoteUrl]: "<html><body></body></html>" })],
    async (calls) => {
      await run("find-by-notes", { notes: [hostileNoteUrl] }, ctx4);
      assertEquals(calls[0].url, hostileNoteUrl);
    },
  );
});

// ---------------------------------------------------------------------------
// Bug 2 — URIError crash on malformed percent-encoding (HIGH)
// ---------------------------------------------------------------------------

Deno.test("pin: get-perfume with a malformed percent-escape URL throws an unmapped URIError (HIGH)", async () => {
  // fragrantica-latent-bugs #2. slugToText calls decodeURIComponent with no
  // try/catch; parsePerfume calls refFromPerfumeUrl(url,...) on the page's
  // OWN url (not just parsed hrefs on the page), so a malformed %-escape in
  // the REQUESTED url itself aborts the whole method call after a successful
  // fetch — the page body's content is irrelevant, so any 200 body suffices.
  const badUrl = `${BASE}/perfume/Bad%zzBrand/Broken-1.html`;
  const { ctx } = makeCtx();
  await withFetchStub(
    [pageRoute({ [badUrl]: MINIMAL_PERFUME_HTML })],
    async () => {
      await assertRejects(
        () =>
          run(
            "get-perfume",
            { url: "/perfume/Bad%zzBrand/Broken-1.html" },
            ctx,
          ),
        URIError,
      );
    },
  );
});

Deno.test("pin: ONE poisoned %-href in a designer listing denies the ENTIRE page (collectPerfumeRefs has no per-link try/catch)", async () => {
  // fragrantica-latent-bugs #2 (continued). A single malformed href among
  // otherwise-valid perfume links throws for the whole collectPerfumeRefs
  // call, discarding every good result too.
  const html = `<!doctype html><html><body>
    <a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova</a>
    <a href="/perfume/Bad%zzBrand/Broken-2.html">Broken link</a>
  </body></html>`;
  const { ctx } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/designers/Testhouse.html`]: html })],
    async () => {
      await assertRejects(
        () => run("list-by-designer", { designer: "Testhouse" }, ctx),
        URIError,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Bug 3 — silent-empty SUCCESS on structural drift / non-HTML 200 (HIGH)
// ---------------------------------------------------------------------------

Deno.test("pin: a non-HTML 200 body (e.g. a JSON error page) parses to an empty perfume and STILL writes success (HIGH)", async () => {
  // fragrantica-latent-bugs #3. fetchPage only checks response.ok, never
  // Content-Type; parsePerfume asserts no minimum field. A JSON body linkedom
  // can't parse as HTML yields an (almost) empty document, so get-perfume
  // "succeeds" with an empty-ish perfume rather than throwing.
  const jsonBody = JSON.stringify({ error: "not html" });
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({
      [`${BASE}/perfume/Testhouse/Fakebloom-Nova-101.html`]: jsonBody,
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
  // The brand/name/id fields still populate — they come from the REQUESTED
  // URL's own shape (refFromPerfumeUrl(url, base)), not from the page body.
  // Only the page-CONTENT-derived fields go empty when the body is unusable.
  assertEquals(
    res.payload.brand,
    "Testhouse",
    "URL-derived brand survives even a non-HTML body",
  );
  assertEquals(
    res.payload.ratingValue,
    undefined,
    "no rating recognized in a JSON body",
  );
  assertEquals((res.payload.accords as unknown[]).length, 0);
  assertEquals((res.payload.perfumers as unknown[]).length, 0);
  // no exception was thrown — this is a SILENT success, not an error.
});

Deno.test("pin: a redesigned page with none of the expected selectors also 'succeeds' with an empty perfume, not an error (HIGH)", async () => {
  const html =
    `<!doctype html><html><body><p>Page redesigned, nothing recognizable.</p></body></html>`;
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
  // brand again survives from the requested URL's own shape.
  assertEquals(res.payload.brand, "Testhouse");
  assertEquals(res.payload.ratingValue, undefined);
  assertEquals((res.payload.notes as { top: string[] }).top, []);
  assert(
    typeof res.payload.timestamp === "string",
    "a fresh timestamp is still written on this silent-empty success",
  );
});

// ---------------------------------------------------------------------------
// Bug 4 — redirect-follow bypasses host intent (MEDIUM)
// ---------------------------------------------------------------------------

Deno.test("pin: fetchPage issues fetch() with default redirect handling — no explicit redirect:'manual' guard (MEDIUM)", async () => {
  // fragrantica-latent-bugs #4. fragrantica.ts's fetch() call never sets
  // `redirect`, so it defaults to "follow" — a 302 from the requested host
  // to an arbitrary Location is followed transparently, compounding bug #1's
  // SSRF surface. We assert the captured RequestInit carries no redirect
  // override (the mechanism), since a stubbed fetch never itself redirects.
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
    undefined,
    "no explicit redirect policy is set — the runtime default ('follow') applies",
  );
});

// ---------------------------------------------------------------------------
// Bug 5 — second-order SSRF via DuckDuckGo poisoning (MEDIUM)
// ---------------------------------------------------------------------------

Deno.test("pin: a DuckDuckGo result pointing at a hostile host is dereferenced without a base-domain check (second-order SSRF, MEDIUM)", async () => {
  // fragrantica-latent-bugs #5. resolveNoteUrl / list-by-designer's ddg
  // fallback accept the FIRST result matching the /notes/ or /designers/
  // path shape on ANY host — a poisoned/MITM'd DuckDuckGo response can
  // redirect the subsequent fetch to an attacker-controlled host.
  const hostileNoteUrl = "http://198.51.100.20/notes/Poisoned-9.html";
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      duckDuckGoRoute(() => ddgPage([hostileNoteUrl])),
      pageRoute({ [hostileNoteUrl]: "<html><body></body></html>" }),
    ],
    async (calls) => {
      await run("list-by-note", { note: "some plain note name" }, ctx);
      assertEquals(calls.length, 2);
      assertEquals(
        calls[1].url,
        hostileNoteUrl,
        "the poisoned DDG result was fetched with no host allowlist",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Bug 6 — unbounded note fan-out (MEDIUM)
// ---------------------------------------------------------------------------

Deno.test("pin: find-by-notes has no upper bound on notes[] length — an N-note array triggers N sequential fetches (MEDIUM)", async () => {
  // fragrantica-latent-bugs #6. The zod schema is `.min(1)` with no `.max()`.
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
    await run("find-by-notes", { notes }, ctx);
    assertEquals(
      calls.length,
      NOTE_COUNT,
      "one fetch per requested note, uncapped",
    );
  });
});

// ---------------------------------------------------------------------------
// Bug 7 — no fetch timeout / AbortSignal (MEDIUM, documented not executed)
// ---------------------------------------------------------------------------

Deno.test("pin: fetchPage's fetch() call carries no AbortSignal/timeout — a hung response would stall the method forever (MEDIUM)", async () => {
  // fragrantica-latent-bugs #7. We don't actually hang a test (that would
  // make CI slow/flaky); instead we assert the captured RequestInit has no
  // `signal`, which is the mechanism that would let a caller bound the wait.
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
    capturedInit?.signal,
    undefined,
    "no AbortSignal is attached to the request",
  );
});

Deno.test("pin: duckDuckGo's POST also carries no AbortSignal/timeout (MEDIUM)", async () => {
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
  assertEquals(capturedInit?.signal, undefined);
});

// ---------------------------------------------------------------------------
// Bug 8 — duplicate-note double-count in find-by-notes (MEDIUM correctness)
// ---------------------------------------------------------------------------

Deno.test("pin: passing the SAME note twice in find-by-notes double-counts every perfume on that page as matching ALL notes (MEDIUM correctness)", async () => {
  // fragrantica-latent-bugs #8. The fan-out loop fetches each element of
  // notes[] independently with no de-dup of the resolved URL, so
  // notes=["Vetiver-4","Vetiver-4"] fetches the SAME page twice and every
  // perfume on it ends up "matching" both (mode=all's needed threshold ==
  // notes.length == 2), even though only one distinct note was ever supplied.
  const html = `<!doctype html><html><body>
    <a href="/perfume/Testhouse/Fakebloom-Nova-101.html">Fakebloom Nova</a>
  </body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [pageRoute({ [`${BASE}/notes/Vetiver-4.html`]: html })],
    async (calls) => {
      await run("find-by-notes", { notes: ["Vetiver-4", "Vetiver-4"] }, ctx);
      assertEquals(calls.length, 2, "the identical note page is fetched TWICE");
    },
  );
  const res = written.find((w) => w.spec === "noteIntersection")!;
  const results = res.payload.results as Array<{ matchedNotes: number }>;
  assertEquals(results.length, 1);
  assertEquals(
    results[0].matchedNotes,
    2,
    "the single perfume is credited with matching BOTH (duplicated) note entries",
  );
});

// ---------------------------------------------------------------------------
// Bug 9 — instanceSlug resource-name collision (LOW)
// ---------------------------------------------------------------------------

Deno.test("pin: two distinct search queries that collapse to the same slug clobber each other's written resource name (LOW)", async () => {
  // fragrantica-latent-bugs #9. instanceSlug replaces every run of non-
  // alnum characters with a single '-', so "A/B" and "A B" (and "A-B")
  // all produce the identical slug "A-B" -> identical writeResource name.
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [duckDuckGoRoute(() => ddgPage([]))],
    async () => {
      await run("search", { query: "A/B" }, ctx);
      await run("search", { query: "A B" }, ctx);
    },
  );
  const names = written.filter((w) => w.spec === "search").map((w) => w.name);
  assertEquals(
    names[0],
    names[1],
    "distinct queries 'A/B' and 'A B' collide on the same instance slug",
  );
});

// ---------------------------------------------------------------------------
// Bug 10 — parseAccords unclamped strength / false positives (LOW)
// ---------------------------------------------------------------------------

Deno.test("pin: parseAccords never clamps strength to 100 — a width:120% bar is recorded as strength 120 (LOW)", async () => {
  // fragrantica-latent-bugs #10. Reachable through get-perfume's parsing.
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
  assertEquals(accords, [{ name: "overdriven", strength: 120 }]);
});

Deno.test("pin: parseAccords matches ANY colored div with a width style, not just the real accord-bar markup (false-positive risk, LOW)", async () => {
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
// Bug 11 — hardcoded fimgs.net thumbnail ignores baseUrl (LOW)
// ---------------------------------------------------------------------------

Deno.test("pin: the perfume thumbnail is ALWAYS built from the hardcoded fimgs.net host, even when baseUrl is overridden (LOW)", async () => {
  // fragrantica-latent-bugs #11. refFromPerfumeUrl's thumbnail field ignores
  // the `base` argument entirely: `https://fimgs.net/mdimg/...` is a literal.
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
    "thumbnail host stays fimgs.net regardless of the configured baseUrl",
  );
});

// ---------------------------------------------------------------------------
// Bug 12 — stored parsed values unsanitized (LOW, inert here)
// ---------------------------------------------------------------------------

Deno.test("pin: a <script>-bearing note/brand name is stored VERBATIM, unsanitized (LOW, inert — this model never renders it)", async () => {
  // fragrantica-latent-bugs #12. parsePerfume performs no output encoding or
  // stripping; the raw textContent is written straight into the resource.
  // Documented as a trust-boundary note for downstream consumers, not fixed
  // here (fragrantica.ts is byte-frozen).
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
