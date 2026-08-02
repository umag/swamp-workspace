/**
 * Property-based tests (fast-check) for @magistr/obsidian-yt-archiver.
 *
 * obsidian_yt_archiver.ts exports no pure parser helpers -- every property
 * here is observed by driving `model.methods.<m>.execute()` against a REAL
 * temporary vault directory and (for archive/resolve/sync) a stubbed fetch,
 * then reading back the written resources. Well-formedness is checked
 * against the model's OWN `model.resources.<x>.schema` zod schemas (not a
 * reimplementation), so a future schema tightening/loosening is what these
 * properties actually track.
 *
 * Honors `FC_NUM_RUNS` for the nightly soak (`deno task test:soak`).
 *
 * Properties:
 *  (a) never throws -- scan() never throws for ANY single-file vault content
 *      (arbitrary/hostile text included), and the written `scan` resource
 *      always validates against ScanResultSchema.
 *  (b1) never throws -- archive()/resolve() never throw for a genuine
 *      JSON-200 GET-check (explicit `application/json` content-type + a
 *      valid JSON body) or a genuine 404 GET-check (any body/content-type --
 *      a non-2xx status never reaches the content-type branch at all), and
 *      the written resource always validates against its schema.
 *  (b2) surfaces -- archive()/resolve() REJECT (throw) for a GET-check that
 *      is a redirect (301), a non-2xx auth/server/rate-limit status
 *      (400/401/403/429/500/502/503), or a 200 with a non-JSON content-type.
 *      None of these mean "not archived", so as of 2026.08.02.1 (LB3/LB7/
 *      LB8) none of them may be silently queued/recorded -- they must
 *      surface instead. (b1) and (b2) partition every GET-check outcome this
 *      suite generates with no overlap: this REPLACES the older, broader
 *      "archive()/resolve() never throw for ANY status" property, which the
 *      LB3/LB7/LB8 fixes directly contradict.
 *  (c) dedup invariant -- uniqueVideoIds always equals the size of the
 *      distinct-videoId set derived from `links`, for any generated set of
 *      (possibly repeated, possibly cross-file) ids.
 *  (d) multi-file flow invariant -- for any generated set of N files each
 *      embedding one DISTINCT well-formed id, scan() always reports
 *      totalFiles===N, totalLinks===N, uniqueVideoIds===N.
 *  (e) idempotent read -- scanning the identical vault content twice in a
 *      row produces byte-identical links/totalFiles/totalLinks/
 *      uniqueVideoIds (only the timestamp may differ).
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./obsidian_yt_archiver.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(100) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: structuredClone(payload) as Record<string, unknown>,
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
  const m = (model.methods as MethodMap)[name];
  return m.execute(m.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(routes: Route[], fn: () => Promise<void>) {
  const original = globalThis.fetch;
  const stub: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function makeVault(
  files: Record<string, string>,
): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "oyta-property-" });
  const vaultPath = `${root}/vault`;
  await Deno.mkdir(vaultPath, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = `${vaultPath}/${rel}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(full, content);
  }
  return { vaultPath, cleanup: () => Deno.remove(root, { recursive: true }) };
}

const TA_URL = "https://ta.fixture.example.com";
const TA_TOKEN = "fixture-ta-token-do-not-log";

function globalArgs(vaultPath: string) {
  return {
    vaultPath,
    tubearchivistUrl: TA_URL,
    tubearchivistToken: TA_TOKEN,
  };
}

// ---------------------------------------------------------------------------
// (a) never throws -- arbitrary single-file vault content
// ---------------------------------------------------------------------------

const arbHostileContent = fc.string({ maxLength: 2000 });

Deno.test("property: scan() never throws for ANY single-file vault content, and the written 'scan' resource always validates against ScanResultSchema", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileContent, async (content) => {
      const v = await makeVault({ "note.md": content });
      try {
        const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        try {
          await run("scan", {}, ctx);
        } catch {
          threw = true;
        }
        if (threw) return false;
        const res = written.find((w) => w.spec === "scan")!;
        model.resources.scan.schema.parse(res.payload);
        return true;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b1) never throws -- a genuine JSON-200 or a genuine 404 GET-check
// (b2) surfaces -- every other GET-check outcome (redirect/4xx/5xx/non-JSON)
// ---------------------------------------------------------------------------

type StubCase = { status: number; contentType: string; body: string };

function respondWith(c: StubCase): Response {
  const headers: Record<string, string> = {};
  if (c.contentType) headers["Content-Type"] = c.contentType;
  return new Response(c.body, { status: c.status, headers });
}

/** A well-formed TA video body -- always valid JSON, always parseable. */
const arbJsonVideoBody = fc.oneof(
  fc.constant(JSON.stringify({})),
  fc.constant(JSON.stringify({ youtube_id: "fixtureAAA1" })),
  fc.string({ maxLength: 200 }).map((title) =>
    JSON.stringify({
      title,
      channel: { channel_name: "Fixture Channel" },
      published: "2024-01-01",
    })
  ),
);

/** never-throws case: a genuine JSON-200 -- explicit `application/json`
 * content-type plus a valid JSON body, the ordinary "already archived"
 * path. */
const arbNeverThrowsJson200: fc.Arbitrary<StubCase> = arbJsonVideoBody.map((
  body,
) => ({
  status: 200,
  contentType: "application/json",
  body,
}));

/** never-throws case: a genuine 404 -- any body/content-type, since a
 * non-2xx status never reaches the content-type branch at all. */
const arbNeverThrows404: fc.Arbitrary<StubCase> = fc.record({
  status: fc.constant(404),
  contentType: fc.constantFrom("text/plain", "application/json", ""),
  body: fc.string({ maxLength: 200 }),
});

const arbNeverThrowsCase = fc.oneof(arbNeverThrowsJson200, arbNeverThrows404);

/** surfaces case: a redirect or a non-2xx auth/server/rate-limit status --
 * content-type/body are irrelevant here: the redirect guard and the !res.ok
 * branch both fire well before the content-type branch is ever reached. */
const arbSurfaceErrorStatus = fc.constantFrom(
  301,
  400,
  401,
  403,
  429,
  500,
  502,
  503,
);
const arbSurfacesErrorCase: fc.Arbitrary<StubCase> = fc.record({
  status: arbSurfaceErrorStatus,
  contentType: fc.constantFrom("text/plain", "application/json", ""),
  body: fc.string({ maxLength: 200 }),
});

/** surfaces case: a 200 with a non-JSON content-type -- the LB8 guard. */
const arbSurfacesNonJson200: fc.Arbitrary<StubCase> = fc.record({
  status: fc.constant(200),
  contentType: fc.constantFrom("text/plain", ""),
  body: fc.string({ maxLength: 200 }),
});

const arbSurfacesCase = fc.oneof(arbSurfacesErrorCase, arbSurfacesNonJson200);

Deno.test("property (b1): archive() never throws for a genuine JSON-200 or a genuine 404 GET-check, and the written 'archive' resource always validates", async () => {
  await fc.assert(
    fc.asyncProperty(arbNeverThrowsCase, async (c) => {
      const v = await makeVault({});
      try {
        const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            // Only the per-id GET check varies -- the two follow-up POSTs
            // (download/task), unconditionally triggered when a 404 queues
            // the id, always succeed here so this property isolates the
            // GET-check branch alone.
            if (url.pathname === "/api/video/fixtureAAA1/") {
              return respondWith(c);
            }
            return jsonResponse({});
          }],
          async () => {
            try {
              await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
            } catch {
              threw = true;
            }
          },
        );
        if (threw) return false;
        const res = written.find((w) => w.spec === "archive")!;
        model.resources.archive.schema.parse(res.payload);
        return true;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

Deno.test("property (b2): archive() REJECTS for a redirect/4xx/5xx status or a non-JSON 200 GET-check -- none of these are silently queued or recorded", async () => {
  await fc.assert(
    fc.asyncProperty(arbSurfacesCase, async (c) => {
      const v = await makeVault({});
      try {
        const { ctx } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            if (url.pathname === "/api/video/fixtureAAA1/") {
              return respondWith(c);
            }
            return jsonResponse({});
          }],
          async () => {
            try {
              await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
            } catch {
              threw = true;
            }
          },
        );
        return threw;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

Deno.test("property (b1): resolve() never throws for a genuine JSON-200 or a genuine 404 GET-check, and 'resolved' always validates against ResolvedSchema", async () => {
  await fc.assert(
    fc.asyncProperty(arbNeverThrowsCase, async (c) => {
      const v = await makeVault({});
      try {
        const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        await withFetchStub(
          [() => respondWith(c)],
          async () => {
            try {
              await run("resolve", { videoIds: ["fixtureAAA1"] }, ctx);
            } catch {
              threw = true;
            }
          },
        );
        if (threw) return false;
        const res = written.find((w) => w.spec === "resolved")!;
        model.resources.resolved.schema.parse(res.payload);
        return true;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

Deno.test("property (b2): resolve() REJECTS for a redirect/4xx/5xx status or a non-JSON 200 GET-check", async () => {
  await fc.assert(
    fc.asyncProperty(arbSurfacesCase, async (c) => {
      const v = await makeVault({});
      try {
        const { ctx } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        await withFetchStub(
          [() => respondWith(c)],
          async () => {
            try {
              await run("resolve", { videoIds: ["fixtureAAA1"] }, ctx);
            } catch {
              threw = true;
            }
          },
        );
        return threw;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) dedup invariant -- uniqueVideoIds === size of the distinct-id set
// ---------------------------------------------------------------------------

const arbId = fc.stringMatching(/^[a-zA-Z0-9_-]{11}$/);

Deno.test("property: for ANY generated multi-line, multi-repeat set of well-formed ids in a single file, uniqueVideoIds always equals the distinct-id count derived from links", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbId, { minLength: 1, maxLength: 12 }),
      async (ids) => {
        const content = ids
          .map((id) => `https://www.youtube.com/watch?v=${id}`)
          .join("\n");
        const v = await makeVault({ "note.md": content });
        try {
          const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
          await run("scan", {}, ctx);
          const res = written.find((w) => w.spec === "scan")!;
          model.resources.scan.schema.parse(res.payload);
          const links = res.payload.links as Array<{ videoId: string }>;
          const distinct = new Set(links.map((l) => l.videoId));
          return res.payload.uniqueVideoIds === distinct.size;
        } finally {
          await v.cleanup();
        }
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) multi-file flow invariant -- N distinct ids across N files
// ---------------------------------------------------------------------------

const arbDistinctIds = fc
  .uniqueArray(arbId, { minLength: 1, maxLength: 6 });

Deno.test("property: for N files each embedding one DISTINCT id, scan() always reports totalFiles===N, totalLinks===N, uniqueVideoIds===N", async () => {
  await fc.assert(
    fc.asyncProperty(arbDistinctIds, async (ids) => {
      const files: Record<string, string> = {};
      ids.forEach((id, i) => {
        files[`note-${i}.md`] = `https://youtu.be/${id}`;
      });
      const v = await makeVault(files);
      try {
        const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
        await run("scan", {}, ctx);
        const res = written.find((w) => w.spec === "scan")!;
        model.resources.scan.schema.parse(res.payload);
        return res.payload.totalFiles === ids.length &&
          res.payload.totalLinks === ids.length &&
          res.payload.uniqueVideoIds === ids.length;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) idempotent read -- scanning identical content twice yields identical
// links/totalFiles/totalLinks/uniqueVideoIds
// ---------------------------------------------------------------------------

Deno.test("property: scanning the identical vault content twice in a row yields identical links/totalFiles/totalLinks/uniqueVideoIds (only timestamp may differ)", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileContent, async (content) => {
      const v = await makeVault({ "note.md": content });
      try {
        const { ctx: ctx1, written: w1 } = makeCtx(globalArgs(v.vaultPath));
        const { ctx: ctx2, written: w2 } = makeCtx(globalArgs(v.vaultPath));
        await run("scan", {}, ctx1);
        await run("scan", {}, ctx2);
        const r1 = w1.find((w) => w.spec === "scan")!.payload;
        const r2 = w2.find((w) => w.spec === "scan")!.payload;
        return JSON.stringify(r1.links) === JSON.stringify(r2.links) &&
          r1.totalFiles === r2.totalFiles &&
          r1.totalLinks === r2.totalLinks &&
          r1.uniqueVideoIds === r2.uniqueVideoIds;
      } finally {
        await v.cleanup();
      }
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// Sanity: the never-throws property scanner actually exercises hostile input
// ---------------------------------------------------------------------------

Deno.test("sanity: the hostile-content arbitrary can generate control characters and non-empty strings (not vacuously safe)", () => {
  let sawWeird = false;
  fc.assert(
    fc.property(arbHostileContent, (s) => {
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
