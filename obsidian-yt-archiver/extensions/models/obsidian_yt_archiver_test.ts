/**
 * Contract-fixture suite: pins the CONCRETE field-by-field output shape for
 * obsidian_yt_archiver.ts's 4 methods (scan/archive/resolve/sync) against
 * fixtures/vault (a synthetic Obsidian vault subtree) and fixtures/ta
 * (synthetic TubeArchivist REST responses) -- independent of the
 * request-shape assertions that live in the methods suite.
 *
 * obsidian_yt_archiver.ts has ONLY `model` exported -- extractYoutubeIds,
 * taApi, and walkMd are module-private. Every test here drives them
 * exclusively through `model.methods.<m>.execute()` against a REAL temporary
 * vault directory (populated from the committed fixtures via
 * `Deno.makeTempDir()` + `setupVault()`) and a stubbed `globalThis.fetch` for
 * the TubeArchivist calls. obsidian_yt_archiver.ts is UNMODIFIED by this
 * change -- every assertion below was captured by actually running the
 * frozen source against these fixtures (not hand-derived from reading the
 * regex/loop logic), so it pins REAL observed behavior.
 *
 * All fixtures are PURE synthetic/hand-authored data -- see
 * fixtures/PROVENANCE.md. Every test here is offline: the vault lives in a
 * throwaway temp directory and TubeArchivist calls are served by a stubbed
 * fetch, no network call is made.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./obsidian_yt_archiver.ts";
import videoOk from "../../fixtures/ta/video_ok.json" with { type: "json" };
import videoOkBare from "../../fixtures/ta/video_ok_bare.json" with {
  type: "json",
};

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
      // A real writeResource serializes/persists the payload at call time.
      // structuredClone here mirrors that snapshot semantics, so a later
      // in-place mutation of an object the model continues to hold (see
      // sync()'s shared `videos` array, written once as "archive" then
      // mutated further before being written again as "resolved") can never
      // retroactively change an already-captured resource -- this avoids a
      // test-harness artifact that a naive reference-holding fake would
      // introduce.
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
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (
    calls: { req: Request; init: RequestInit | undefined }[],
  ) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: { req: Request; init: RequestInit | undefined }[] = [];
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

const FIXTURES_DIR = new URL("../../fixtures", import.meta.url).pathname;

async function copyDir(src: string, dest: string) {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const s = `${src}/${entry.name}`;
    const d = `${dest}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(s, d);
    } else if (entry.isFile) {
      await Deno.writeTextFile(d, await Deno.readTextFile(s));
    }
  }
}

async function setupVault(): Promise<
  { root: string; vaultPath: string; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "oyta-contract-" });
  const vaultPath = `${root}/vault`;
  await copyDir(`${FIXTURES_DIR}/vault`, vaultPath);
  await copyDir(`${FIXTURES_DIR}/outside`, `${root}/outside`);
  return {
    root,
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
// Structural pins
// ---------------------------------------------------------------------------

Deno.test("structural: model.resources declares exactly scan/archive/resolved", () => {
  assertEquals(Object.keys(model.resources).sort(), [
    "archive",
    "resolved",
    "scan",
  ]);
});

Deno.test("structural: model.methods declares exactly archive/resolve/scan/sync", () => {
  assertEquals(Object.keys(model.methods).sort(), [
    "archive",
    "resolve",
    "scan",
    "sync",
  ]);
});

// ---------------------------------------------------------------------------
// scan -- folder="notes" (2 files, only video-note.md has links)
// ---------------------------------------------------------------------------

Deno.test("contract: scan(folder=notes) -- pins the 3-link array in exact file order, first-occurrence dedup, and the 2/3/3 counts", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", { folder: "notes" }, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    assertEquals(res.payload.totalFiles, 2);
    assertEquals(res.payload.totalLinks, 3);
    assertEquals(res.payload.uniqueVideoIds, 3);
    assertEquals(res.payload.links, [
      {
        file: "notes/video-note.md",
        videoId: "fixtureAAA1",
        url: "https://www.youtube.com/watch?v=fixtureAAA1",
        line: 3,
      },
      {
        file: "notes/video-note.md",
        videoId: "fixtureBBB2",
        url: "https://youtu.be/fixtureBBB2",
        line: 5,
      },
      {
        file: "notes/video-note.md",
        videoId: "fixtureCCC3",
        url: "https://www.youtube.com/embed/fixtureCCC3",
        line: 9,
      },
    ]);
    assert(
      typeof res.payload.timestamp === "string" &&
        !isNaN(Date.parse(res.payload.timestamp as string)),
      "timestamp must be a parseable ISO string",
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scan -- folder="Clippings" (1 file)
// ---------------------------------------------------------------------------

Deno.test("contract: scan(folder=Clippings) -- pins the shorts-link + cross-file-duplicate-id 2-link array", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", { folder: "Clippings" }, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    assertEquals(res.payload.totalFiles, 1);
    assertEquals(res.payload.totalLinks, 2);
    assertEquals(res.payload.uniqueVideoIds, 2);
    assertEquals(res.payload.links, [
      {
        file: "Clippings/clipped-video.md",
        videoId: "fixtureDDD4",
        url: "https://www.youtube.com/shorts/fixtureDDD4",
        line: 3,
      },
      {
        file: "Clippings/clipped-video.md",
        videoId: "fixtureAAA1",
        url: "https://www.youtube.com/watch?v=fixtureAAA1",
        line: 5,
      },
    ]);
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scan -- no folder (whole vault): dot-folder skipped, cross-file aggregate
// ---------------------------------------------------------------------------

Deno.test("contract: scan() with no folder -- walks the whole vault, skips .obsidian entirely, aggregates totalFiles=3/totalLinks=5/uniqueVideoIds=4", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", {}, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    assertEquals(res.payload.totalFiles, 3);
    assertEquals(res.payload.totalLinks, 5);
    assertEquals(res.payload.uniqueVideoIds, 4);
    const links = res.payload.links as Array<Record<string, unknown>>;
    // Cross-file ordering depends on Deno.readDir's directory-listing order,
    // which is not guaranteed -- assert per-file slices (each internally
    // deterministic, per extractYoutubeIds's guaranteed line-by-line order)
    // instead of the whole flat array positionally.
    assertEquals(
      links.filter((l) => l.file === "notes/video-note.md"),
      [
        {
          file: "notes/video-note.md",
          videoId: "fixtureAAA1",
          url: "https://www.youtube.com/watch?v=fixtureAAA1",
          line: 3,
        },
        {
          file: "notes/video-note.md",
          videoId: "fixtureBBB2",
          url: "https://youtu.be/fixtureBBB2",
          line: 5,
        },
        {
          file: "notes/video-note.md",
          videoId: "fixtureCCC3",
          url: "https://www.youtube.com/embed/fixtureCCC3",
          line: 9,
        },
      ],
    );
    assertEquals(
      links.filter((l) => l.file === "Clippings/clipped-video.md"),
      [
        {
          file: "Clippings/clipped-video.md",
          videoId: "fixtureDDD4",
          url: "https://www.youtube.com/shorts/fixtureDDD4",
          line: 3,
        },
        {
          file: "Clippings/clipped-video.md",
          videoId: "fixtureAAA1",
          url: "https://www.youtube.com/watch?v=fixtureAAA1",
          line: 5,
        },
      ],
    );
    assertEquals(links.filter((l) => l.file === "notes/no-links.md"), []);
    assert(
      links.every((l) => !String(l.file).startsWith(".obsidian")),
      "no link may come from the dot-folder",
    );
    assert(
      !links.some((l) => l.videoId === "fixtureHID5"),
      "the id hidden inside .obsidian must never surface",
    );
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// archive -- explicit videoIds, one found (full fields) one not found
// ---------------------------------------------------------------------------

Deno.test("contract: archive() with one found + one not-found id -- pins alreadyArchived's exact field mapping from video_ok.json and notFound always []", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === videoPath("fixtureAAA1")) {
          return jsonResponse(videoOk);
        }
        if (url.pathname === videoPath("fixtureZZZ9")) {
          return errorResponse("not found", 404);
        }
        if (url.pathname === "/api/download/") {
          return jsonResponse({ success: true });
        }
        if (url.pathname === "/api/task/by-name/download_pending/") {
          return jsonResponse({ success: true });
        }
        return undefined;
      }],
      () =>
        run(
          "archive",
          { videoIds: ["fixtureAAA1", "fixtureZZZ9"] },
          ctx,
        ) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(res.payload.queued, ["fixtureZZZ9"]);
    assertEquals(res.payload.notFound, []);
    assertEquals(res.payload.alreadyArchived, [
      {
        videoId: "fixtureAAA1",
        title: "Fixture Archived Video Title",
        channel: "Fixture Channel One",
        published: "2024-01-15",
        taUrl: `${TA_URL}/video/fixtureAAA1`,
        archived: true,
      },
    ]);
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// archive -- bare TA response (no channel/title/published at all)
// ---------------------------------------------------------------------------

Deno.test("contract: archive() -- a bare TA video response (no channel/title/published keys) maps to empty-string fallbacks, still archived:true", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse(videoOkBare)],
      () => run("archive", { videoIds: ["fixtureBBB2"] }, ctx) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(res.payload.alreadyArchived, [
      {
        videoId: "fixtureBBB2",
        title: "",
        channel: "",
        published: "",
        taUrl: `${TA_URL}/video/fixtureBBB2`,
        archived: true,
      },
    ]);
    assertEquals(res.payload.queued, []);
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolve -- mix of resolved/unresolved
// ---------------------------------------------------------------------------

Deno.test("contract: resolve() -- pins videos[]/unresolvedIds[] shape, never writes an 'archive' resource", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === videoPath("fixtureAAA1")) {
          return jsonResponse(videoOk);
        }
        if (url.pathname === videoPath("fixtureZZZ9")) {
          return errorResponse("not found", 404);
        }
        return undefined;
      }],
      () =>
        run(
          "resolve",
          { videoIds: ["fixtureAAA1", "fixtureZZZ9"] },
          ctx,
        ) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "resolved")!;
    assertEquals(res.payload.unresolvedIds, ["fixtureZZZ9"]);
    assertEquals(res.payload.videos, [
      {
        videoId: "fixtureAAA1",
        title: "Fixture Archived Video Title",
        channel: "Fixture Channel One",
        published: "2024-01-15",
        taUrl: `${TA_URL}/video/fixtureAAA1`,
        archived: true,
      },
    ]);
    assertEquals(written.filter((w) => w.spec === "archive"), []);
  } finally {
    await v.cleanup();
  }
});

// ---------------------------------------------------------------------------
// sync -- end-to-end over a single-file folder: scan + archive + resolved,
// and the archive/resolved snapshot-timing pin (see makeCtx's comment)
// ---------------------------------------------------------------------------

Deno.test("contract: sync(folder=Clippings) -- writes scan+archive+resolved; 'archive' is the archived-only snapshot, 'resolved' carries both entries", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === videoPath("fixtureAAA1")) {
          return jsonResponse(videoOk);
        }
        if (url.pathname === videoPath("fixtureDDD4")) {
          return errorResponse("not found", 404);
        }
        if (url.pathname === "/api/download/") {
          return jsonResponse({ success: true });
        }
        if (url.pathname === "/api/task/by-name/download_pending/") {
          return jsonResponse({ success: true });
        }
        return undefined;
      }],
      () => run("sync", { folder: "Clippings" }, ctx) as Promise<void>,
    );

    const scanRes = written.find((w) => w.spec === "scan")!;
    assertEquals(scanRes.payload.totalFiles, 1);
    assertEquals(scanRes.payload.totalLinks, 2);
    assertEquals(scanRes.payload.uniqueVideoIds, 2);

    const archiveRes = written.find((w) => w.spec === "archive")!;
    assertEquals(archiveRes.payload.queued, ["fixtureDDD4"]);
    assertEquals(archiveRes.payload.notFound, []);
    assertEquals(archiveRes.payload.alreadyArchived, [
      {
        videoId: "fixtureAAA1",
        title: "Fixture Archived Video Title",
        channel: "Fixture Channel One",
        published: "2024-01-15",
        taUrl: `${TA_URL}/video/fixtureAAA1`,
        archived: true,
      },
    ]);

    const resolvedRes = written.find((w) => w.spec === "resolved")!;
    assertEquals(resolvedRes.payload.unresolvedIds, ["fixtureDDD4"]);
    assertEquals(resolvedRes.payload.videos, [
      {
        videoId: "fixtureAAA1",
        title: "Fixture Archived Video Title",
        channel: "Fixture Channel One",
        published: "2024-01-15",
        taUrl: `${TA_URL}/video/fixtureAAA1`,
        archived: true,
      },
      {
        videoId: "fixtureDDD4",
        title: "",
        channel: "",
        published: "",
        taUrl: `${TA_URL}/video/fixtureDDD4`,
        archived: false,
      },
    ]);
  } finally {
    await v.cleanup();
  }
});
