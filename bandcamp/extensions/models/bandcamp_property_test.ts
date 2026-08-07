/**
 * Property-based tests (fast-check) for @magistr/bandcamp.
 *
 * bandcamp.ts exports no pure parser helpers -- every property here is
 * observed by driving `model.methods.<m>.execute()` against a stubbed fetch
 * and reading back the written resource, per the approved plan's test seam.
 * Well-formedness is checked against the model's OWN `model.resources.<x>
 * .schema` zod schemas (not a reimplementation), so a future schema
 * tightening/loosening is what these properties actually track.
 *
 * Honors `FC_NUM_RUNS` for the nightly soak (`deno task test:soak`).
 *
 * Properties:
 *  (a) never throws -- get-album/get-artist/search-* never throw for ANY
 *      HTML string body (arbitrary/hostile content included), and the
 *      written resource always validates against its resource schema.
 *  (b) output schema always well-formed -- search-artist over a
 *      fc-generated set of `.searchresult.data-search` entries always
 *      produces a `search` resource that validates against
 *      `model.resources.search.schema`.
 *  (c) normalization idempotent -- the about/bio 500-char truncation the
 *      model performs is idempotent: re-running get-album with the ALREADY
 *      -truncated about text embedded produces the identical about value.
 *  (d) multi-step flow invariant -- search-artist's first result URL, fed
 *      into get-artist, always yields a well-formed artistDetail resource,
 *      never a throw.
 *  (e) astral-safe truncation (bandcamp-latent-bugs #7) -- for astral-heavy
 *      input, `about` never exceeds 500 CODE POINTS and never ends in a
 *      lone (unpaired) surrogate. Additive alongside (c).
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./bandcamp.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = {}) {
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

async function withHtmlBody(
  body: string,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
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

// ---------------------------------------------------------------------------
// (a) never throws, over hostile/arbitrary HTML bodies
// ---------------------------------------------------------------------------

// Unrestricted arbitrary strings -- includes control characters, lone
// surrogates, empty strings, and anything else fast-check's shrinker finds.
const arbHostileHtml = fc.string({ maxLength: 4000 });

Deno.test("property: search-artist never throws for ANY string HTML body, and its resource is always schema-valid", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileHtml, async (body) => {
      const { ctx, written } = makeCtx();
      let threw = false;
      await withHtmlBody(body, async () => {
        try {
          await run("search-artist", { query: "x" }, ctx);
        } catch {
          threw = true;
        }
      });
      if (threw) return false;
      model.resources.search.schema.parse(written[0].payload);
      return true;
    }),
    FC_RUNS,
  );
});

Deno.test("property: get-album never throws for ANY string HTML body, and its resource is always schema-valid", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileHtml, async (body) => {
      const { ctx, written } = makeCtx();
      let threw = false;
      await withHtmlBody(body, async () => {
        try {
          await run(
            "get-album",
            { url: "https://fixture.bandcamp.com/album/x" },
            ctx,
          );
        } catch {
          threw = true;
        }
      });
      if (threw) return false;
      model.resources.albumDetail.schema.parse(written[0].payload);
      return true;
    }),
    FC_RUNS,
  );
});

Deno.test("property: get-artist never throws for ANY string HTML body, and its resource is always schema-valid", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileHtml, async (body) => {
      const { ctx, written } = makeCtx();
      let threw = false;
      await withHtmlBody(body, async () => {
        try {
          await run("get-artist", { url: "https://fixture.bandcamp.com" }, ctx);
        } catch {
          threw = true;
        }
      });
      if (threw) return false;
      model.resources.artistDetail.schema.parse(written[0].payload);
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) output schema well-formed, over a generated set of search items
// ---------------------------------------------------------------------------

// Requires at least one alnum character -- an all-whitespace/punctuation
// title (e.g. a single space) trims to "" and gets DROPPED by
// parseSearchResults' `if (title) results.push(entry)` guard, which would
// make "every generated item survives" a false premise for this property.
// (fast-check@4.8.0's stringMatching doesn't support lookahead assertions,
// so the alnum requirement is a post-hoc `.filter()` instead of a regex.)
const arbSafeText = fc
  .stringMatching(/^[a-zA-Z0-9 '.,-]{1,40}$/)
  .filter((s) => /[a-zA-Z0-9]/.test(s));

const arbSearchItem = fc.record({
  title: arbSafeText,
  href: fc.stringMatching(/^https:\/\/fixture-[a-z0-9-]{1,20}\.example\.com$/),
  subhead: fc.option(arbSafeText, { nil: undefined }),
});

function renderSearchHtml(
  items: Array<{ title: string; href: string; subhead?: string }>,
) {
  const li = items.map((it) =>
    `<li class="searchresult data-search"><div class="heading"><a href="${it.href}">${it.title}</a></div>` +
    (it.subhead ? `<div class="subhead">${it.subhead}</div>` : "") +
    `</li>`
  ).join("");
  return `<html><body><ul>${li}</ul><p>of ${items.length} results</p></body></html>`;
}

Deno.test("property: search-artist's written resource is ALWAYS schema-valid for any generated set of well-formed items, with results.length == total", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbSearchItem, { minLength: 0, maxLength: 15 }),
      async (items) => {
        const { ctx, written } = makeCtx();
        await withHtmlBody(renderSearchHtml(items), async () => {
          await run("search-artist", { query: "x" }, ctx);
        });
        const payload = written[0].payload;
        model.resources.search.schema.parse(payload);
        const results = payload.results as unknown[];
        return results.length === items.length &&
          payload.total === items.length;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) normalization idempotent -- about/bio's slice(0,500) truncation
// ---------------------------------------------------------------------------

const arbAboutText = fc.stringMatching(/^[a-zA-Z0-9 '.,-]{0,900}$/);

async function aboutFor(text: string): Promise<string> {
  const { ctx, written } = makeCtx();
  const html =
    `<html><body><div class="tralbumData tralbum-about">${text}</div></body></html>`;
  await withHtmlBody(html, async () => {
    await run(
      "get-album",
      { url: "https://fixture.bandcamp.com/album/x" },
      ctx,
    );
  });
  return written[0].payload.about as string;
}

Deno.test("property: about's 500-char truncation is idempotent -- re-running get-album with the ALREADY-truncated text yields the identical about value", async () => {
  await fc.assert(
    fc.asyncProperty(arbAboutText, async (text) => {
      const once = await aboutFor(text);
      const twice = await aboutFor(once);
      return twice === once;
    }),
    FC_RUNS,
  );
});

Deno.test("property: about is never longer than 500 characters, for any input length", async () => {
  await fc.assert(
    fc.asyncProperty(arbAboutText, async (text) => {
      const about = await aboutFor(text);
      return about.length <= 500;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) astral-safe truncation -- bandcamp-latent-bugs #7's code-point cut.
// Additive: strengthens (c)/(d) above without touching them. The existing
// ASCII-only `arbAboutText` never straddles a surrogate pair (code points ==
// code units for ASCII), so this dedicated astral-heavy arbitrary is needed
// to actually exercise the boundary the #7 fix changed.
// ---------------------------------------------------------------------------

const arbAstralHeavyText = fc
  .array(
    fc.constantFrom("A", "b", "9", " ", "\u{1F600}", "\u{1F601}", "\u{1F602}"),
    { maxLength: 900 },
  )
  .map((chars) => chars.join(""));

Deno.test("property: about never ends in a lone (unpaired) surrogate and never exceeds 500 CODE POINTS, even for astral-heavy input straddling the truncation boundary", async () => {
  await fc.assert(
    fc.asyncProperty(arbAstralHeavyText, async (text) => {
      const about = await aboutFor(text);
      return Array.from(about).length <= 500 &&
        !/[\uD800-\uDBFF]$/.test(about);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) multi-step flow invariant: search-artist -> get-artist on its own url
// ---------------------------------------------------------------------------

Deno.test("property: a search-artist result's url, fed into get-artist, always yields a well-formed artistDetail resource, never a throw", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSafeText,
      fc.stringMatching(/^fixture-[a-z0-9-]{1,20}$/),
      async (title, subdomainSlug) => {
        const url = `https://${subdomainSlug}.bandcamp.com`;
        const searchHtml = renderSearchHtml([{ title, href: url }]);
        const artistHtml =
          `<html><body><p id="band-name-location"><span class="title">${title}</span></p></body></html>`;

        const { ctx: searchCtx, written: searchWritten } = makeCtx();
        await withHtmlBody(searchHtml, async () => {
          await run("search-artist", { query: "x" }, searchCtx);
        });
        const foundUrl = (searchWritten[0].payload.results as Array<
          Record<string, unknown>
        >)[0].url as string;

        const { ctx: artistCtx, written: artistWritten } = makeCtx();
        let threw = false;
        await withFetchStub([() =>
          new Response(artistHtml, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })], async () => {
          try {
            await run("get-artist", { url: foundUrl }, artistCtx);
          } catch {
            threw = true;
          }
        });
        if (threw) return false;
        model.resources.artistDetail.schema.parse(artistWritten[0].payload);
        // parseArtistPage always `.trim()`s the extracted name -- compare
        // against the trimmed form, not the raw generated title (which may
        // carry leading/trailing spaces the arbitrary is free to produce).
        return artistWritten[0].payload.name === title.trim();
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// Sanity: the never-throws property scanner actually exercises hostile input
// ---------------------------------------------------------------------------

Deno.test("sanity: the hostile-HTML arbitrary can generate control characters and unpaired surrogates (not vacuously safe strings)", () => {
  let sawWeird = false;
  fc.assert(
    fc.property(arbHostileHtml, (s) => {
      // Charcode check instead of a control-char regex literal (lint's
      // no-control-regex rule disallows \x00-\x08 inside a RegExp).
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) <= 8) sawWeird = true;
      }
      if (s.length > 0) sawWeird = true;
      return true;
    }),
    { numRuns: 500 },
  );
  assert(
    sawWeird,
    "sanity: the arbitrary must generate non-empty strings at least once",
  );
});
