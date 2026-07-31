/**
 * Method-level tests for @magistr/obsidian-yt-archiver -- all 4 methods
 * (scan, archive, resolve, sync), happy + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a REAL
 * temporary vault directory and a stubbed `globalThis.fetch` for the
 * TubeArchivist calls.
 *
 * obsidian_yt_archiver.ts is UNMODIFIED -- every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior: TubeArchivist request URL/method/header/body shapes, the
 * `Token <token>` auth scheme (not Bearer), the four methods' argument
 * schemas (all zod-default non-strict, silently dropping unknown keys), the
 * fallback-scan-when-no-videoIds behavior shared by archive/resolve, and the
 * credential-non-leak invariant across every written resource.
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

function method(name: string) {
  const m = (model.methods as MethodMap)[name];
  assert(m, `method ${name} must exist on the model`);
  return m;
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const m = method(name);
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

function videoPath(id: string): string {
  return `/api/video/${id}/`;
}

async function requestJsonBody(req: Request): Promise<unknown> {
  const text = await req.clone().text();
  return text ? JSON.parse(text) : undefined;
}

async function makeMinimalVault(
  files: Record<string, string>,
): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "oyta-methods-" });
  const vaultPath = `${root}/vault`;
  await Deno.mkdir(vaultPath, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = `${vaultPath}/${rel}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(full, content);
  }
  return {
    vaultPath,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
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
// argument schemas -- all four methods
// ---------------------------------------------------------------------------

Deno.test("scan.arguments: {} parses to {} (folder omitted, not defaulted)", () => {
  assertEquals(method("scan").arguments.parse({}), {});
});

Deno.test("scan.arguments: unknown keys are silently stripped (zod default, non-strict)", () => {
  assertEquals(method("scan").arguments.parse({ folder: "x", bogus: 1 }), {
    folder: "x",
  });
});

Deno.test("archive.arguments: {} parses to {} (videoIds omitted)", () => {
  assertEquals(method("archive").arguments.parse({}), {});
});

Deno.test("archive.arguments: unknown keys are silently stripped", () => {
  assertEquals(
    method("archive").arguments.parse({ videoIds: ["a"], bogus: 1 }),
    { videoIds: ["a"] },
  );
});

Deno.test("resolve.arguments: {} parses to {} (videoIds omitted)", () => {
  assertEquals(method("resolve").arguments.parse({}), {});
});

Deno.test("sync.arguments: {} parses to {} (folder omitted); sync has NO videoIds argument at all", () => {
  assertEquals(method("sync").arguments.parse({}), {});
  // videoIds is silently dropped -- sync's schema is folder-only.
  assertEquals(
    method("sync").arguments.parse({ videoIds: ["a"], folder: "x" }),
    { folder: "x" },
  );
});

// ---------------------------------------------------------------------------
// scan -- happy path is network-free; error path propagates the raw fs error
// ---------------------------------------------------------------------------

Deno.test("scan: happy path makes ZERO fetch calls -- scan never touches the network", async () => {
  const v = await makeMinimalVault({
    "a.md": "https://www.youtube.com/watch?v=fixtureAAA1",
  });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub([], async (calls) => {
      await run("scan", {}, ctx);
      assertEquals(calls.length, 0);
    });
    assertEquals(written.length, 1);
  } finally {
    await v.cleanup();
  }
});

Deno.test("scan: a nonexistent folder rejects with the raw Deno filesystem error, unwrapped", async () => {
  const v = await makeMinimalVault({ "a.md": "no links here" });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await assertRejects(
      () => run("scan", { folder: "does-not-exist" }, ctx) as Promise<void>,
      Deno.errors.NotFound,
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// archive -- happy path request shape
// ---------------------------------------------------------------------------

Deno.test("archive: GET check carries Authorization: Token <token>, Content-Type: application/json, no body, method GET", async () => {
  const v = await makeMinimalVault({ "a.md": "no links" });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
      async (calls) => {
        await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
        assertEquals(calls.length, 1);
        const { req, init } = calls[0];
        assertEquals(req.method, "GET");
        assertEquals(new URL(req.url).pathname, videoPath("fixtureAAA1"));
        assertEquals(req.headers.get("authorization"), `Token ${TA_TOKEN}`);
        assertEquals(req.headers.get("content-type"), "application/json");
        assertEquals(init?.body ?? null, null);
      },
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("archive: a not-yet-archived id is POSTed to /api/download/ with {data:[{youtube_id,status:'pending'}]}, then POSTs the no-body download_pending task", async () => {
  const v = await makeMinimalVault({ "a.md": "no links" });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === videoPath("fixtureZZZ9")) {
          return errorResponse("not found", 404);
        }
        if (url.pathname === "/api/download/") return jsonResponse({});
        if (url.pathname === "/api/task/by-name/download_pending/") {
          return jsonResponse({});
        }
        return undefined;
      }],
      async (calls) => {
        await run("archive", { videoIds: ["fixtureZZZ9"] }, ctx);
        assertEquals(calls.length, 3);
        const download = calls.find((c) =>
          new URL(c.req.url).pathname === "/api/download/"
        )!;
        assertEquals(download.req.method, "POST");
        assertEquals(await requestJsonBody(download.req), {
          data: [{ youtube_id: "fixtureZZZ9", status: "pending" }],
        });
        assertEquals(
          download.req.headers.get("authorization"),
          `Token ${TA_TOKEN}`,
        );
        const task = calls.find((c) =>
          new URL(c.req.url).pathname ===
            "/api/task/by-name/download_pending/"
        )!;
        assertEquals(task.req.method, "POST");
        assertEquals(task.init?.body ?? null, null);
      },
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(res.payload.queued, ["fixtureZZZ9"]);
  } finally {
    await v.cleanup();
  }
});

Deno.test("archive: when every id is already archived, toQueue is empty and NEITHER /api/download/ NOR the task endpoint is ever called", async () => {
  const v = await makeMinimalVault({ "a.md": "no links" });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
      async (calls) => {
        await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
        assertEquals(calls.length, 1);
        assertEquals(
          new URL(calls[0].req.url).pathname,
          videoPath("fixtureAAA1"),
        );
      },
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("archive: fallback scan (videoIds omitted) walks the FULL vaultPath in extraction order -- ignores any notion of subfolder (archive has no folder argument at all)", async () => {
  const v = await makeMinimalVault({
    "only.md":
      "first https://www.youtube.com/watch?v=fixtureAAA1\nsecond https://youtu.be/fixtureBBB2",
  });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "x" })],
      async (calls) => {
        await run("archive", {}, ctx);
        assertEquals(calls.length, 2);
        assertEquals(
          new URL(calls[0].req.url).pathname,
          videoPath("fixtureAAA1"),
        );
        assertEquals(
          new URL(calls[1].req.url).pathname,
          videoPath("fixtureBBB2"),
        );
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolve -- never mutates TubeArchivist state
// ---------------------------------------------------------------------------

Deno.test("resolve: never issues /api/download/ or the download_pending task, regardless of unresolved ids -- only GET checks happen", async () => {
  const v = await makeMinimalVault({ "a.md": "no links" });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === videoPath("fixtureAAA1")) {
          return jsonResponse({ youtube_id: "fixtureAAA1" });
        }
        if (url.pathname === videoPath("fixtureZZZ9")) {
          return errorResponse("not found", 404);
        }
        return undefined;
      }],
      async (calls) => {
        await run(
          "resolve",
          { videoIds: ["fixtureAAA1", "fixtureZZZ9"] },
          ctx,
        );
        assertEquals(calls.length, 2);
        assert(
          calls.every((c) => c.req.method === "GET"),
          "resolve must only ever issue GET checks",
        );
      },
    );
    assertEquals(written.filter((w) => w.spec === "archive"), []);
  } finally {
    await v.cleanup();
  }
});

Deno.test("resolve: fallback scan (videoIds omitted) walks the FULL vaultPath, same as archive -- resolve also has no folder argument", async () => {
  const v = await makeMinimalVault({
    "only.md": "https://www.youtube.com/embed/fixtureCCC3",
  });
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureCCC3" })],
      async (calls) => {
        await run("resolve", {}, ctx);
        assertEquals(calls.length, 1);
        assertEquals(
          new URL(calls[0].req.url).pathname,
          videoPath("fixtureCCC3"),
        );
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// sync -- folder is forwarded ONLY to the scan phase; writes 3 resources
// ---------------------------------------------------------------------------

Deno.test("sync: the folder argument scopes the scan phase; writes scan, archive, resolved in that order", async () => {
  const v = await makeMinimalVault({
    "Sub/only.md": "https://www.youtube.com/watch?v=fixtureAAA1",
    "outside.md": "https://youtu.be/fixtureBBB2",
  });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === videoPath("fixtureAAA1")) {
          return jsonResponse({ youtube_id: "fixtureAAA1" });
        }
        return undefined;
      }],
      () => run("sync", { folder: "Sub" }, ctx) as Promise<void>,
    );
    assertEquals(written.map((w) => w.spec), ["scan", "archive", "resolved"]);
    const scanRes = written[0];
    assertEquals(scanRes.payload.totalFiles, 1);
    const links = scanRes.payload.links as Array<Record<string, unknown>>;
    assertEquals(links.length, 1);
    assertEquals(links[0].videoId, "fixtureAAA1");
    // outside.md (fixtureBBB2) is OUTSIDE the Sub/ folder scope -- never seen.
    assert(
      !links.some((l) => l.videoId === "fixtureBBB2"),
      "sync(folder=Sub) must not see files outside the Sub subtree",
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Credential non-leak -- across all 4 methods
// ---------------------------------------------------------------------------

Deno.test("credentials: tubearchivistToken never appears in any written resource, across scan/archive/resolve/sync", async () => {
  const v = await makeMinimalVault({
    "a.md": "https://www.youtube.com/watch?v=fixtureAAA1",
  });
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
      async () => {
        await run("scan", {}, ctx);
        await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
        await run("resolve", { videoIds: ["fixtureAAA1"] }, ctx);
        await run("sync", {}, ctx);
      },
    );
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(
        !s.includes(TA_TOKEN),
        `${w.spec}: token leaked into a written resource`,
      );
    }
  } finally {
    await v.cleanup();
  }
});
