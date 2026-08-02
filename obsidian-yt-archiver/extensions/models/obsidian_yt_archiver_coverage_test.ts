/**
 * Coverage suite: branch-fill regression tests for obsidian_yt_archiver.ts --
 * each test here closes a gap the other four suites' happy/error-path focus
 * left unguarded (a branch with no test protecting it -- if someone deletes
 * the guard, one of these goes red).
 *
 * As of 2026.08.02.1, one test below (the no-content-type-header case) was
 * flipped to `assertRejects` alongside the LB8 fix in
 * obsidian_yt_archiver.ts -- every other test here characterizes unchanged,
 * already-shipped behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./obsidian_yt_archiver.ts";

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
  assert(m, `method ${name} must exist on the model`);
  return m.execute(m.arguments.parse(args), ctx);
}

type Call = { req: Request; init: RequestInit | undefined };
type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Call[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const stub: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ req: req.clone(), init });
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  globalThis.fetch = stub;
  try {
    await fn(calls);
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

function errorResponse(body: string, status: number) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

async function makeMinimalVault(
  files: Record<string, string>,
): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "oyta-coverage-" });
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
// scan -- empty directory: zero files, zero links, no throw
// ---------------------------------------------------------------------------

Deno.test("coverage: scan() over an empty folder -- totalFiles=0, totalLinks=0, uniqueVideoIds=0, links=[]", async () => {
  const v = await makeMinimalVault({});
  try {
    await Deno.mkdir(`${v.vaultPath}/Empty`, { recursive: true });
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", { folder: "Empty" }, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    assertEquals(res.payload, {
      links: [],
      totalFiles: 0,
      totalLinks: 0,
      uniqueVideoIds: 0,
      timestamp: res.payload.timestamp,
    });
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// archive -- explicit empty array vs omitted: BOTH trigger the fallback scan
// ---------------------------------------------------------------------------

Deno.test("coverage: archive({ videoIds: [] }) triggers the SAME fallback vault scan as videoIds omitted entirely", async () => {
  const v = await makeMinimalVault({
    "a.md": "https://www.youtube.com/watch?v=fixtureAAA1",
  });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
      async (calls) => {
        await run("archive", { videoIds: [] }, ctx);
        assertEquals(calls.length, 1);
        assertEquals(
          new URL(calls[0].req.url).pathname,
          "/api/video/fixtureAAA1/",
        );
      },
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("coverage: archive() with a non-empty explicit videoIds array does NOT touch the filesystem at all -- the vault-scan branch is skipped entirely", async () => {
  // Point vaultPath at a directory that does not exist; if the fallback-scan
  // branch ran, walkMd would throw NotFound immediately.
  const { ctx, written } = makeCtx(
    globalArgs("/nonexistent/oyta-coverage-vault-path"),
  );
  await withFetchStub(
    [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
    () => run("archive", { videoIds: ["fixtureAAA1"] }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "archive")!;
  assertEquals(res.payload.queued, []);
});

Deno.test("coverage: resolve() with a non-empty explicit videoIds array also skips the filesystem entirely", async () => {
  const { ctx, written } = makeCtx(
    globalArgs("/nonexistent/oyta-coverage-vault-path"),
  );
  await withFetchStub(
    [() => errorResponse("not found", 404)],
    () => run("resolve", { videoIds: ["fixtureAAA1"] }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "resolved")!;
  assertEquals(res.payload.unresolvedIds, ["fixtureAAA1"]);
});

// ---------------------------------------------------------------------------
// archive -- notFound is dead code: always [] regardless of outcome mix
// ---------------------------------------------------------------------------

Deno.test("coverage: archive()'s notFound field is ALWAYS [] -- it is initialized but never populated by any code path (dead branch)", async () => {
  const v = await makeMinimalVault({});
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/video/fixtureFoundId/") {
          return jsonResponse({ youtube_id: "fixtureFoundId" });
        }
        if (url.pathname === "/api/video/fixtureMissId1/") {
          return errorResponse("not found", 404);
        }
        return jsonResponse({});
      }],
      () =>
        run(
          "archive",
          { videoIds: ["fixtureFoundId", "fixtureMissId1"] },
          ctx,
        ) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(res.payload.notFound, []);
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// sync -- toQueue empty: no POST calls; toQueue non-empty: both POSTs fire
// ---------------------------------------------------------------------------

Deno.test("coverage: sync() when every scanned id is already archived -- toQueue stays empty, no /api/download/ or task POST ever fires", async () => {
  const v = await makeMinimalVault({
    "a.md": "https://www.youtube.com/watch?v=fixtureAAA1",
  });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/video/fixtureAAA1/") {
          return jsonResponse({ youtube_id: "fixtureAAA1" });
        }
        return undefined;
      }],
      async (calls) => {
        await run("sync", {}, ctx);
        assertEquals(calls.length, 1, "only the single GET check should fire");
      },
    );
    const archiveRes = written.find((w) => w.spec === "archive")!;
    assertEquals(archiveRes.payload.queued, []);
    const resolvedRes = written.find((w) => w.spec === "resolved")!;
    assertEquals(resolvedRes.payload.unresolvedIds, []);
    assertEquals(
      resolvedRes.payload.videos,
      archiveRes.payload.alreadyArchived,
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("coverage: sync() over a folder with zero .md files -- scan writes all-zero counts, archive/resolved both write empty arrays, no fetch at all", async () => {
  const v = await makeMinimalVault({});
  try {
    await Deno.mkdir(`${v.vaultPath}/Empty`, { recursive: true });
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub([], async (calls) => {
      await run("sync", { folder: "Empty" }, ctx);
      assertEquals(calls.length, 0);
    });
    const scanRes = written.find((w) => w.spec === "scan")!;
    assertEquals(scanRes.payload.totalFiles, 0);
    assertEquals(scanRes.payload.totalLinks, 0);
    const archiveRes = written.find((w) => w.spec === "archive")!;
    assertEquals(archiveRes.payload.queued, []);
    assertEquals(archiveRes.payload.alreadyArchived, []);
    const resolvedRes = written.find((w) => w.spec === "resolved")!;
    assertEquals(resolvedRes.payload.videos, []);
    assertEquals(resolvedRes.payload.unresolvedIds, []);
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// channel field variants: missing entirely vs present-but-empty-string
// ---------------------------------------------------------------------------

Deno.test("coverage: a TA response with channel present but channel_name missing falls back to '' (optional chaining, not a throw)", async () => {
  const v = await makeMinimalVault({});
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() =>
        jsonResponse({
          youtube_id: "fixtureAAA1",
          title: "Fixture Title",
          channel: { channel_id: "fixtureChanId1" },
          published: "2024-02-02",
        })],
      () => run("archive", { videoIds: ["fixtureAAA1"] }, ctx) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(
      (res.payload.alreadyArchived as Array<Record<string, unknown>>)[0]
        .channel,
      "",
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("coverage: a TA response where channel is explicitly null does not throw -- optional chaining short-circuits to ''", async () => {
  const v = await makeMinimalVault({});
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() =>
        jsonResponse({
          youtube_id: "fixtureAAA1",
          title: "Fixture Title",
          channel: null,
          published: "2024-02-02",
        })],
      () => run("archive", { videoIds: ["fixtureAAA1"] }, ctx) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(
      (res.payload.alreadyArchived as Array<Record<string, unknown>>)[0]
        .channel,
      "",
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// taApi: Content-Type response header entirely absent (not just non-JSON)
// ---------------------------------------------------------------------------

Deno.test("coverage: a 200 response with NO content-type header at all is SURFACED (rejected) -- same non-JSON guard as an explicit non-JSON content-type (LB8)", async () => {
  const v = await makeMinimalVault({});
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => new Response("ignored body", { status: 200 })],
      async () => {
        await assertRejects(
          () =>
            run("archive", { videoIds: ["fixtureAAA1"] }, ctx) as Promise<
              void
            >,
        );
      },
    );
    assertEquals(
      written.find((w) => w.spec === "archive"),
      undefined,
      "a surfaced GET-check error must abort before the archive resource is ever written",
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// taApi: host trailing-slash stripping
// ---------------------------------------------------------------------------

Deno.test("coverage: a tubearchivistUrl with one or more trailing slashes is normalized (stripped) before the path is appended", async () => {
  const v = await makeMinimalVault({});
  try {
    const { ctx } = makeCtx({
      vaultPath: v.vaultPath,
      tubearchivistUrl: `${TA_URL}///`,
      tubearchivistToken: TA_TOKEN,
    });
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
      async (calls) => {
        await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
        assertEquals(calls[0].req.url, `${TA_URL}/api/video/fixtureAAA1/`);
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// extractYoutubeIds: all four URL forms in a single scan, resolve() parity
// ---------------------------------------------------------------------------

Deno.test("coverage: resolve()'s fallback scan recognizes all 4 URL forms (watch/youtu.be/embed/shorts) identically to scan()", async () => {
  const v = await makeMinimalVault({
    "all.md": [
      "https://www.youtube.com/watch?v=fixtureAAA1",
      "https://youtu.be/fixtureBBB2",
      "https://www.youtube.com/embed/fixtureCCC3",
      "https://www.youtube.com/shorts/fixtureDDD4",
    ].join("\n"),
  });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => errorResponse("not found", 404)],
      async (calls) => {
        await run("resolve", {}, ctx);
        const paths = calls.map((c) => new URL(c.req.url).pathname).sort();
        assertEquals(paths, [
          "/api/video/fixtureAAA1/",
          "/api/video/fixtureBBB2/",
          "/api/video/fixtureCCC3/",
          "/api/video/fixtureDDD4/",
        ]);
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scan: bare `youtube.com` links WITHOUT `www.` also match (regex is optional)
// ---------------------------------------------------------------------------

Deno.test("coverage: the `www.` prefix is optional in YT_PATTERNS -- a bare youtube.com/watch link is extracted identically", async () => {
  const v = await makeMinimalVault({
    "bare.md": "https://youtube.com/watch?v=fixtureAAA1",
  });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", {}, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    assertEquals(res.payload.totalLinks, 1);
    const links = res.payload.links as Array<Record<string, unknown>>;
    assertEquals(links[0].videoId, "fixtureAAA1");
  } finally {
    await v.cleanup();
  }
});

Deno.test("coverage: the `https://` scheme itself is optional in YT_PATTERNS -- a schemeless youtu.be link is extracted", async () => {
  const v = await makeMinimalVault({
    "schemeless.md": "youtu.be/fixtureBBB2 (no scheme prefix at all)",
  });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", {}, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    const links = res.payload.links as Array<Record<string, unknown>>;
    assertEquals(links.length, 1);
    assertEquals(links[0].videoId, "fixtureBBB2");
    assertEquals(links[0].url, "youtu.be/fixtureBBB2");
  } finally {
    await v.cleanup();
  }
});
