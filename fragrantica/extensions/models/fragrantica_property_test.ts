/**
 * Property-based tests (fast-check) for @magistr/fragrantica.
 *
 * fragrantica.ts is UNMODIFIED — every property here observes already-shipped
 * behavior, either directly on the four exported pures or (for private
 * helpers) by driving `model.methods.<m>.execute()` against a stubbed fetch
 * and reading back the written resource.
 *
 * Arbitraries are RESTRICTED to a safe charset (letters/digits/spaces/hyphens)
 * throughout. This deliberately EXCLUDES the two documented totality
 * exceptions, each pinned separately in fragrantica_adversarial_test.ts:
 *   - malformed percent-encoding (`%zz`) makes slugToText/refFromPerfumeUrl
 *     throw a URIError — "parser never throws" is FALSE over the raw input
 *     space, so the arbitrary here never generates a `%` character.
 *   - a non-HTML / structurally-drifted body yields a silent-empty SUCCESS
 *     rather than a total, always-populated shape — the get-perfume
 *     output-shape property below only generates well-formed HTML bodies.
 *
 * Properties:
 *  (a) parseAccords — strength is always a non-negative integer, every name
 *      is 1..40 chars, results are deduped by name, and the list never
 *      exceeds the 30-item cap.
 *  (b) parseNotes — always returns exactly {top,middle,base,general} string
 *      arrays and never throws over safe-charset pyramid HTML.
 *  (c) refFromPerfumeUrl — total over safe-charset (non-%) slugs: name is a
 *      string, id matches the generated numeric suffix, thumbnail is
 *      id-derived.
 *  (d) instanceSlug (private, observed via search's written resource name) —
 *      idempotent: slugifying an already-slug-shaped string is a no-op.
 *  (e) get-perfume's written payload always matches the PerfumeDetail shape.
 *  (f) collectPerfumeRefs (private, observed via list-by-designer) — output
 *      length never exceeds the 500-item cap and every URL is unique.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { z } from "npm:zod@4";
import { DOMParser } from "npm:linkedom@0.16.11";
import {
  model,
  parseAccords,
  parseNotes,
  refFromPerfumeUrl,
} from "./fragrantica.ts";

// Property iteration count — overridable for a nightly soak via FC_NUM_RUNS
// (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

const BASE = "https://fragrantica.example";

// deno-lint-ignore no-explicit-any
function doc(html: string): any {
  return new DOMParser().parseFromString(html, "text/html");
}

// ---------------------------------------------------------------------------
// Harness (for the through-execute() properties: (d), (e), (f))
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

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

async function withFetchStub(routes: Route[], fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch =
    (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      for (const route of routes) {
        const res = await route(req);
        if (res) return res;
      }
      throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
    }) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function htmlResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function duckDuckGoRoute(page: string): Route {
  return (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.hostname === "html.duckduckgo.com") {
      return htmlResponse(page);
    }
    return undefined;
  };
}

function pageRoute(pages: Record<string, string>): Route {
  return (req) => {
    if (req.method === "GET" && req.url in pages) {
      return htmlResponse(pages[req.url]);
    }
    return undefined;
  };
}

const emptyDdg = duckDuckGoRoute(`<!doctype html><html><body></body></html>`);

// ---------------------------------------------------------------------------
// (a) parseAccords
// ---------------------------------------------------------------------------

const arbAccordName = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,38}[A-Za-z]$/);
const arbAccordBar = fc.record({
  name: arbAccordName,
  pct: fc.float({ min: 0, max: 500, noNaN: true }),
});

function accordsHtml(bars: Array<{ name: string; pct: number }>): string {
  const body = bars
    .map((b) =>
      `<div style="background:#123456;width:${b.pct}%;">${b.name}</div>`
    )
    .join("\n");
  return `<!doctype html><html><body>${body}</body></html>`;
}

Deno.test("property: parseAccords — strength is always a non-negative integer, names 1..40 chars, deduped, capped at 30", () => {
  fc.assert(
    fc.property(
      fc.array(arbAccordBar, { minLength: 0, maxLength: 40 }),
      (bars) => {
        const d = doc(accordsHtml(bars));
        const accords = parseAccords(d);
        assert(accords.length <= 30);
        const seen = new Set<string>();
        for (const a of accords) {
          assert(
            Number.isInteger(a.strength),
            `strength ${a.strength} must be an integer`,
          );
          assert(
            a.strength >= 0,
            "strength must be non-negative (Math.round of a >=0 pct)",
          );
          assert(a.name.length >= 1 && a.name.length <= 40);
          assert(
            !seen.has(a.name),
            `duplicate name "${a.name}" must have been deduped`,
          );
          seen.add(a.name);
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) parseNotes
// ---------------------------------------------------------------------------

const arbNoteName = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,18}[A-Za-z]$/);
const arbNoteId = fc.integer({ min: 1, max: 999 });

function pyramidHtml(
  levels: Array<{ heading?: string; notes: string[] }>,
): string {
  const inner = levels
    .map((lvl, i) => {
      const links = lvl.notes
        .map((n, j) =>
          `<a href="/notes/${n.replace(/ /g, "-")}-${i}${j}.html">${n}</a>`
        )
        .join("");
      const heading = lvl.heading ? `<h4>${lvl.heading}</h4>` : "";
      return `${heading}<div class="pyramid-level-container">${links}</div>`;
    })
    .join("\n");
  return `<!doctype html><html><body><div id="pyramid">${inner}</div></body></html>`;
}

const arbLevel = fc.record({
  heading: fc.option(
    fc.constantFrom("Top Notes", "Middle Notes", "Base Notes", "Heart Notes"),
    { nil: undefined },
  ),
  notes: fc.array(arbNoteName, { minLength: 0, maxLength: 4 }),
});

Deno.test("property: parseNotes — always returns exactly {top,middle,base,general} string arrays and never throws over safe-charset HTML", () => {
  fc.assert(
    fc.property(
      fc.array(arbLevel, { minLength: 0, maxLength: 5 }),
      (levels) => {
        const d = doc(pyramidHtml(levels));
        const notes = parseNotes(d.querySelector("#pyramid"));
        assertEquals(Object.keys(notes).sort(), [
          "base",
          "general",
          "middle",
          "top",
        ]);
        for (const key of ["top", "middle", "base", "general"] as const) {
          assert(Array.isArray(notes[key]));
          for (const n of notes[key]) assert(typeof n === "string");
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: parseNotes(null) is always the all-empty shape, independent of any generated input", () => {
  fc.assert(
    fc.property(arbNoteId, () => {
      assertEquals(parseNotes(null), {
        top: [],
        middle: [],
        base: [],
        general: [],
      });
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) refFromPerfumeUrl — total over safe-charset (non-%) slugs
// ---------------------------------------------------------------------------

const arbSlugWord = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,20}$/);

Deno.test("property: refFromPerfumeUrl is total over safe-charset slugs — id always matches the numeric suffix, thumbnail is id-derived", () => {
  fc.assert(
    fc.property(
      arbSlugWord,
      arbSlugWord,
      fc.integer({ min: 1, max: 999999 }),
      (brand, name, id) => {
        const href = `/perfume/${brand}/${name}-${id}.html`;
        const ref = refFromPerfumeUrl(href, BASE);
        assert(typeof ref.name === "string");
        assertEquals(ref.id, id);
        assertEquals(ref.url, `${BASE}${href}`);
        assertEquals(
          ref.thumbnail,
          `https://fimgs.net/mdimg/perfume-thumbs/375x500.${id}.jpg`,
        );
        return true;
      },
    ),
    FC_RUNS,
  );
});

// No digits at all — avoids the documented perfumeIdFromUrl fallback quirk
// (ANY path ending in "-<digits>.html", not just a /perfume/ one, yields a
// numeric id via its trailing-digits regex; a digit-free slug never triggers
// that fallback, so this property stays about the PERFUME_HREF mismatch).
const arbNonNumericSlug = fc.stringMatching(
  /^[A-Za-z][A-Za-z-]{0,18}[A-Za-z]$/,
);

Deno.test("property: refFromPerfumeUrl on a non-perfume-shaped, digit-free path is always the empty-name/no-id shape", () => {
  fc.assert(
    fc.property(arbNonNumericSlug, (slug) => {
      const ref = refFromPerfumeUrl(`/designers/${slug}.html`, BASE);
      assertEquals(ref.name, "");
      assertEquals(ref.id, undefined);
      assertEquals(ref.thumbnail, undefined);
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) instanceSlug idempotency — observed via search's written resource name
// ---------------------------------------------------------------------------

Deno.test("property: instanceSlug is idempotent — re-slugifying an already-slug-shaped query is a no-op", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^[A-Za-z0-9]{1,20}(-[A-Za-z0-9]{1,20}){0,4}$/),
      async (alreadySlug) => {
        const { ctx: ctx1, written: w1 } = makeCtx();
        await withFetchStub([emptyDdg], async () => {
          await run("search", { query: alreadySlug }, ctx1);
        });
        const { ctx: ctx2, written: w2 } = makeCtx();
        const onceMore = w1.find((w) => w.spec === "search")!.name;
        await withFetchStub([emptyDdg], async () => {
          await run("search", { query: onceMore }, ctx2);
        });
        const twice = w2.find((w) => w.spec === "search")!.name;
        return onceMore === twice;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) get-perfume output shape
// ---------------------------------------------------------------------------

// PerfumeDetailSchema itself is not exported (byte-freeze); re-declared here
// (per the plan review's accepted finding) to keep the structural assertion
// independent of any single field's value.
const PerfumeDetailShape = z.object({
  url: z.string(),
  id: z.number().optional(),
  name: z.string(),
  brand: z.string().optional(),
  gender: z.string().optional(),
  year: z.number().optional(),
  ratingValue: z.number().optional(),
  ratingCount: z.number().optional(),
  description: z.string().optional(),
  thumbnail: z.string().optional(),
  perfumers: z.array(z.string()),
  accords: z.array(z.object({ name: z.string(), strength: z.number() })),
  notes: z.object({
    top: z.array(z.string()),
    middle: z.array(z.string()),
    base: z.array(z.string()),
    general: z.array(z.string()),
  }),
  similar: z.array(z.object({
    name: z.string(),
    brand: z.string().optional(),
    url: z.string(),
    id: z.number().optional(),
    thumbnail: z.string().optional(),
  })),
  timestamp: z.string(),
});

function perfumePageHtml(opts: {
  brand: string;
  name: string;
  id: number;
  accordName: string;
  accordPct: number;
  noteName: string;
}): string {
  return `<!doctype html><html><head>
    <meta property="og:title" content="${opts.name} ${opts.brand} for women"/>
  </head><body>
    <div itemprop="brand"><span itemprop="name">${opts.brand}</span></div>
    <div style="background:#123;width:${opts.accordPct}%;">${opts.accordName}</div>
    <div id="pyramid">
      <h4>Top Notes</h4>
      <div class="pyramid-level-container"><a href="/notes/${opts.noteName}-1.html">${opts.noteName}</a></div>
    </div>
  </body></html>`;
}

Deno.test("property: get-perfume's written payload always matches the PerfumeDetail shape over safe-charset HTML", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSlugWord,
      arbSlugWord,
      fc.integer({ min: 1, max: 999999 }),
      arbAccordName,
      fc.float({ min: 0, max: 100, noNaN: true }),
      arbNoteName,
      async (brand, name, id, accordName, accordPct, noteName) => {
        const url = `${BASE}/perfume/${brand}/${name}-${id}.html`;
        const html = perfumePageHtml({
          brand,
          name,
          id,
          accordName,
          accordPct,
          noteName,
        });
        const { ctx, written } = makeCtx();
        await withFetchStub([pageRoute({ [url]: html })], async () => {
          await run("get-perfume", { url }, ctx);
        });
        const res = written.find((w) => w.spec === "perfume")!;
        const parsed = PerfumeDetailShape.safeParse(res.payload);
        return parsed.success;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) collectPerfumeRefs — cap and uniqueness, observed via list-by-designer
// ---------------------------------------------------------------------------

Deno.test("property: collectPerfumeRefs (via list-by-designer) never exceeds the 500-item cap and every written URL is unique", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 520 }),
      async (n) => {
        const links = Array.from(
          { length: n },
          (_, i) =>
            `<a href="/perfume/House/Item-${1000 + i}.html">Item ${i}</a>`,
        ).join("\n");
        const html = `<!doctype html><html><body>${links}</body></html>`;
        const designerUrl = `${BASE}/designers/House.html`;
        const { ctx, written } = makeCtx();
        await withFetchStub([pageRoute({ [designerUrl]: html })], async () => {
          await run("list-by-designer", { designer: "House" }, ctx);
        });
        const res = written.find((w) => w.spec === "listing")!;
        const results = res.payload.results as Array<{ url: string }>;
        const urls = new Set(results.map((r) => r.url));
        return results.length <= 500 && urls.size === results.length &&
          results.length === Math.min(n, 500);
      },
    ),
    { numRuns: NIGHT(50) },
  );
});
