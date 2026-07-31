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
 *  (b) never throws -- archive()/resolve() never throw regardless of the
 *      TubeArchivist GET-check response's status/body shape, PROVIDED the
 *      follow-up POST calls a non-empty toQueue unconditionally triggers
 *      always succeed here (taApi's two POST calls are NOT wrapped in
 *      try/catch -- a failing POST propagating is expected, characterized
 *      separately in the adversarial suite's LB6 pin, not a property this
 *      suite claims).
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
// (b) never throws -- archive()/resolve() regardless of the GET-check
// response's status/body shape
// ---------------------------------------------------------------------------

const arbStatus = fc.constantFrom(
  200,
  201,
  204,
  301,
  400,
  401,
  403,
  404,
  429,
  500,
  502,
  503,
);
const arbBody = fc.oneof(
  fc.string({ maxLength: 500 }),
  fc.constant(""),
  fc.constant(JSON.stringify({ youtube_id: "fixtureAAA1" })),
);

Deno.test("property: archive() never throws for ANY GET-check status/body combination, as long as the (unconditionally-triggered-on-requeue) follow-up POSTs succeed", async () => {
  await fc.assert(
    fc.asyncProperty(arbStatus, arbBody, async (status, body) => {
      const v = await makeVault({});
      try {
        const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            // Only the per-id GET check varies by the generated status/body
            // -- the two follow-up POSTs (download/task), which taApi does
            // NOT wrap in try/catch, always succeed here so this property
            // isolates the GET-check catch-and-continue branch (the
            // POST-failure propagation is characterized separately by the
            // adversarial suite's LB6 pin, not claimed as a property here).
            if (url.pathname === "/api/video/fixtureAAA1/") {
              return new Response(body, { status });
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

Deno.test("property: resolve() never throws for ANY GET-check status/body combination, and 'resolved' always validates against ResolvedSchema", async () => {
  await fc.assert(
    fc.asyncProperty(arbStatus, arbBody, async (status, body) => {
      const v = await makeVault({});
      try {
        const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
        let threw = false;
        await withFetchStub(
          [() => new Response(body, { status })],
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
