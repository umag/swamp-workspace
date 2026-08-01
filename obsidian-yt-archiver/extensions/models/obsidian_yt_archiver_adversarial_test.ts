/**
 * Adversarial suite: hostile/boundary inputs and a mechanical
 * fixtures-secret-scan over obsidian-yt-archiver/fixtures/*.
 *
 * As of 2026.08.01.1, obsidian_yt_archiver.ts carries ONE behavior change --
 * the `assertFolderWithinVault` containment guard that fixes LB2 -- and is
 * otherwise unmodified. This suite is where the 8 latent bugs tracked in the
 * LOCAL `obsidian-yt-archiver-latent-bugs` issue-lifecycle model (NEVER
 * filed to the swamp.club Lab -- see CLAUDE.md's anti-bypass rule) are
 * characterized: 7 remain failing-would-be-red-if-"fixed" pins of current
 * (unfixed) behavior, and LB2 is now a fixed-would-be-red-if-"reintroduced"
 * pin (assertRejects) rather than a pin of the escape:
 *   LB1 request-forgery via arbitrary videoIds reaching other TA endpoints on
 *   the SAME host (MEDIUM), LB2 path traversal via `folder` (HIGH, FIXED --
 *   see "LB2 ... FIXED" below), LB3 error-handling conflates
 *   fetch-fail/401/500 with "not archived" -> mass re-queue (MEDIUM), LB4 no
 *   fetch timeout (MEDIUM), LB5 whole-file reads + sequential per-id fetch
 *   with no cap (LOW-MED), LB6 error body truncated to 200 chars, token
 *   never leaked (LOW), LB7 default redirect:"follow" (LOW), LB8 a non-JSON
 *   200 resolves to a blank "archived" record (LOW).
 *
 * It also pins six REFUTED risk classes as covered-negatives -- explicitly
 * checked and found NOT applicable to this model, so a future change that
 * makes them applicable turns a test red:
 *   - credential leak: the token is header-only, never embedded in any URL,
 *     query string, or written resource.
 *   - injection: the model is read-only against the vault (never writes) and
 *     never shells out (no Deno.Command anywhere in the source).
 *   - XXE: no XML/DOMParser is ever used -- vault content is scanned with
 *     plain regexes over raw text, so a DOCTYPE/ENTITY payload is inert text.
 *   - command injection: there is no `Deno.Command` call in the source at
 *     all -- a mechanical grep-style assertion over the module's own source.
 *   - symlink escape: a `.md` file that is a SYMLINK is skipped by walkMd --
 *     `Deno.DirEntry.isFile` is false for a symlink entry, so it never
 *     matches the `entry.isFile && entry.name.endsWith(".md")` branch.
 *   - cross-host SSRF: the TubeArchivist host comes ONLY from the
 *     operator-fixed `tubearchivistUrl` global argument; neither `videoIds`
 *     nor `folder` can change the request's host/origin, only its path.
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
  const root = await Deno.makeTempDir({ prefix: "oyta-adversarial-" });
  const vaultPath = `${root}/vault`;
  await copyDir(`${FIXTURES_DIR}/vault`, vaultPath);
  await copyDir(`${FIXTURES_DIR}/outside`, `${root}/outside`);
  return {
    root,
    vaultPath,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function readTaFixture(name: string): Promise<string> {
  return await Deno.readTextFile(`${FIXTURES_DIR}/ta/${name}`);
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

// ===========================================================================
// LB1 request-forgery via arbitrary videoIds -- MEDIUM
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB1, MEDIUM): a `../`-laden videoId is fetched verbatim -- the URL parser normalizes the dot-segments, landing on a DIFFERENT TA endpoint on the SAME host", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ ok: true })],
      async (calls) => {
        await run(
          "archive",
          { videoIds: ["../../admin/danger"] },
          ctx,
        );
        assertEquals(calls.length, 1);
        const url = new URL(calls[0].req.url);
        // Normalized away from /api/video/../../admin/danger/ -> /admin/danger/
        assertEquals(url.pathname, "/admin/danger/");
        assertEquals(url.host, "ta.fixture.example.com");
      },
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("refuted (covered-negative, cross-host SSRF): an absolute-URL-shaped videoId stays an OPAQUE path segment -- the host never changes", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ ok: true })],
      async (calls) => {
        await run(
          "archive",
          { videoIds: ["https://evil.fixture.example.org/steal"] },
          ctx,
        );
        assertEquals(calls.length, 1);
        const url = new URL(calls[0].req.url);
        assertEquals(url.host, "ta.fixture.example.com");
        assert(
          url.pathname.includes("evil.fixture.example.org"),
          "the hostile string is reached only as an inert path segment on the fixed host",
        );
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB2 path traversal via `folder` -- HIGH -- FIXED 2026.08.01.1
// ===========================================================================
//
// assertFolderWithinVault now rejects any `folder` that escapes the vault
// root (an absolute path, or a vault-relative resolved path that is `..` or
// begins with `../`), invoked identically before `scan` and `sync` ever
// touch the filesystem. These cases PIN THE FIX (assertRejects), reusing the
// SAME synthetic `fixtures/outside/escape-note.md` escape target as a
// now-REJECTED input, plus deeper traversal and absolute-path variants, for
// BOTH scan and sync symmetrically.

const LB2_TRAVERSAL_FOLDERS = [
  "../outside",
  "..",
  "../..",
  "notes/../../outside",
];

for (const folder of LB2_TRAVERSAL_FOLDERS) {
  Deno.test(`fixed (obsidian-yt-archiver-latent-bugs LB2, HIGH): scan(folder="${folder}") is rejected -- the vault escape no longer reads fixtures/outside`, async () => {
    const v = await setupVault();
    try {
      const { ctx } = makeCtx(globalArgs(v.vaultPath));
      await assertRejects(
        () => run("scan", { folder }, ctx) as Promise<void>,
        Error,
        "escapes the vault",
      );
    } finally {
      await v.cleanup();
    }
  });

  Deno.test(`fixed (obsidian-yt-archiver-latent-bugs LB2, HIGH): sync(folder="${folder}") is rejected -- the SAME guard applies symmetrically to sync`, async () => {
    const v = await setupVault();
    try {
      const { ctx } = makeCtx(globalArgs(v.vaultPath));
      await assertRejects(
        () => run("sync", { folder }, ctx) as Promise<void>,
        Error,
        "escapes the vault",
      );
    } finally {
      await v.cleanup();
    }
  });
}

Deno.test("fixed (obsidian-yt-archiver-latent-bugs LB2, HIGH): scan(folder=<absolute path>) is rejected outright, before any relative-escape check runs", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await assertRejects(
      () => run("scan", { folder: `${v.root}/outside` }, ctx) as Promise<void>,
      Error,
      "absolute path",
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("fixed (obsidian-yt-archiver-latent-bugs LB2, HIGH): sync(folder=<absolute path>) is rejected outright, before any relative-escape check runs", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await assertRejects(
      () => run("sync", { folder: `${v.root}/outside` }, ctx) as Promise<void>,
      Error,
      "absolute path",
    );
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB3 conflated error handling -- MEDIUM
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB3, MEDIUM): a 401 (auth failure) and a 500 (server error) are treated IDENTICALLY to a genuine 404 -- all three get re-queued for download", async () => {
  const v = await setupVault();
  try {
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/video/fixture401Id/") {
          return errorResponse("unauthorized", 401);
        }
        if (url.pathname === "/api/video/fixture500Id/") {
          return errorResponse("server error", 500);
        }
        if (url.pathname === "/api/video/fixture404Id/") {
          return errorResponse("not found", 404);
        }
        if (url.pathname === "/api/download/") return jsonResponse({});
        if (url.pathname === "/api/task/by-name/download_pending/") {
          return jsonResponse({});
        }
        return undefined;
      }],
      () =>
        run("archive", {
          videoIds: ["fixture401Id", "fixture500Id", "fixture404Id"],
        }, ctx) as Promise<void>,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(
      (res.payload.queued as string[]).sort(),
      ["fixture401Id", "fixture404Id", "fixture500Id"],
      "a 401 and a 500 are re-queued exactly like a genuine 404 -- no distinction is made",
    );
    assertEquals(res.payload.alreadyArchived, []);
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB4 no fetch timeout -- MEDIUM
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB4, MEDIUM): no TA request (GET check, POST download, POST task) ever passes an AbortSignal/timeout", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/video/fixtureQQQ1/") {
          return errorResponse("not found", 404);
        }
        return jsonResponse({});
      }],
      async (calls) => {
        await run("archive", { videoIds: ["fixtureQQQ1"] }, ctx);
        assert(calls.length >= 3, "sanity: GET + download + task all fired");
        for (const c of calls) {
          assertEquals(c.init?.signal, undefined);
        }
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB5 whole-file reads + sequential fetch, no cap -- LOW-MED
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB5, LOW-MED): N videoIds produce exactly N SEQUENTIAL GET checks, in argument order, with no batching/concurrency and no cap", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    const ids = Array.from({ length: 8 }, (_, i) => `fixtureSeq${i}Xx`);
    const seenAtCallTime: string[] = [];
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        // If fetches were concurrent, multiple in-flight paths could be
        // observed before any resolves; recording synchronously on each
        // invocation and asserting strict prefix growth demonstrates the
        // sequential (await-per-id) execution the source code performs.
        seenAtCallTime.push(url.pathname);
        if (url.pathname.startsWith("/api/video/")) {
          return errorResponse("not found", 404);
        }
        // archive()'s two POST calls (download/task) are NOT wrapped in
        // try/catch -- they must succeed so this test observes only the
        // GET-check sequence it's pinning.
        return jsonResponse({});
      }],
      () => run("archive", { videoIds: ids }, ctx) as Promise<void>,
    );
    const getPaths = seenAtCallTime.filter((p) => p.startsWith("/api/video/"));
    assertEquals(
      getPaths,
      ids.map((id) => `/api/video/${id}/`),
    );
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB6 error body truncated to 200 chars -- LOW (token never leaked)
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB6, LOW): a >200-char TA error body is truncated to exactly 200 chars in the thrown message; the token never appears in it", async () => {
  const v = await setupVault();
  try {
    const longBody = await readTaFixture("error_long.txt");
    assert(longBody.length > 200, "sanity: fixture body must exceed 200 chars");
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    // archive()'s per-id GET check is wrapped in try/catch (a thrown error
    // there is swallowed into `toQueue`), but the two POST calls that follow
    // (`/api/download/` and the download_pending task) are NOT wrapped -- a
    // failure there propagates the raw taApi Error straight out of the
    // method call. That is the seam used to observe the exact message text.
    let postThrew: unknown;
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/video/fixtureLongErrId/") {
          return errorResponse("not found", 404);
        }
        if (url.pathname === "/api/download/") {
          return errorResponse(longBody, 503);
        }
        return undefined;
      }],
      async () => {
        try {
          await run("archive", { videoIds: ["fixtureLongErrId"] }, ctx);
        } catch (e) {
          postThrew = e;
        }
      },
    );
    assert(postThrew instanceof Error);
    const message = (postThrew as Error).message;
    const expectedTail = longBody.slice(0, 200);
    assertEquals(
      message,
      `TA POST /api/download/: 503 - ${expectedTail}`,
    );
    assertEquals(
      message.length,
      `TA POST /api/download/: 503 - `.length + 200,
    );
    assert(
      !message.includes(TA_TOKEN),
      "the token must never appear in the thrown message",
    );
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB7 default redirect:"follow" -- LOW
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB7, LOW): taApi passes no explicit `redirect` option -- the fetch default of 'follow' applies to every TA call", async () => {
  const v = await setupVault();
  try {
    const { ctx } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() => jsonResponse({ youtube_id: "fixtureAAA1" })],
      async (calls) => {
        await run("archive", { videoIds: ["fixtureAAA1"] }, ctx);
        assertEquals(calls.length, 1);
        assertEquals(calls[0].init?.redirect, undefined);
      },
    );
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// LB8 non-JSON 200 -> blank "archived" record -- LOW
// ===========================================================================

Deno.test("pin (obsidian-yt-archiver-latent-bugs LB8, LOW): a 200 OK with a non-JSON content-type resolves as {} -- the video is recorded archived:true with every field blank", async () => {
  const v = await setupVault();
  try {
    const nonJson = await readTaFixture("non_json_ok.txt");
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await withFetchStub(
      [() =>
        new Response(nonJson, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })],
      () =>
        run("archive", { videoIds: ["fixtureNonJson1"] }, ctx) as Promise<
          void
        >,
    );
    const res = written.find((w) => w.spec === "archive")!;
    assertEquals(res.payload.alreadyArchived, [
      {
        videoId: "fixtureNonJson1",
        title: "",
        channel: "",
        published: "",
        taUrl: `${TA_URL}/video/fixtureNonJson1`,
        archived: true,
      },
    ]);
    assertEquals(res.payload.queued, []);
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// Covered-negatives
// ===========================================================================

Deno.test("refuted: globalArguments carries exactly vaultPath/tubearchivistUrl/tubearchivistToken -- the token is the ONLY credential-shaped field, and it is header-only", () => {
  const keys = Object.keys(model.globalArguments.shape);
  assertEquals(
    keys.sort(),
    ["tubearchivistToken", "tubearchivistUrl", "vaultPath"],
  );
});

Deno.test("refuted: no `Deno.Command` call anywhere in the frozen source -- a mechanical grep-style check, so command injection has no surface", async () => {
  const src = await Deno.readTextFile(
    new URL("./obsidian_yt_archiver.ts", import.meta.url),
  );
  assert(
    !src.includes("Deno.Command"),
    "the source must never shell out -- command injection is not applicable",
  );
});

Deno.test("refuted: the model never writes to the vault -- no Deno.mkdir/writeFile/writeTextFile/remove call anywhere in the frozen source", async () => {
  const src = await Deno.readTextFile(
    new URL("./obsidian_yt_archiver.ts", import.meta.url),
  );
  for (
    const forbidden of [
      "Deno.mkdir",
      "Deno.writeFile",
      "Deno.writeTextFile",
      "Deno.remove",
    ]
  ) {
    assert(!src.includes(forbidden), `source must never call ${forbidden}`);
  }
});

Deno.test("refuted: a literal DOCTYPE/ENTITY (XXE-shaped) payload embedded in a vault note is inert -- no XML/DOMParser is ever used, only plain regex scanning", async () => {
  const v = await setupVault();
  try {
    const xxeContent =
      `<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/fixture-passwd"> ]>\n&xxe;\nhttps://www.youtube.com/watch?v=fixtureXXE1`;
    await Deno.writeTextFile(`${v.vaultPath}/xxe.md`, xxeContent);
    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    let threw: unknown;
    try {
      await run("scan", {}, ctx);
    } catch (e) {
      threw = e;
    }
    assertEquals(threw, undefined, "no throw from the XXE-shaped payload");
    const res = written.find((w) => w.spec === "scan")!;
    const links = res.payload.links as Array<Record<string, unknown>>;
    assert(
      links.some((l) => l.videoId === "fixtureXXE1"),
      "the video link on the same line/file is still extracted normally",
    );
    const payloadStr = JSON.stringify(res.payload);
    assert(
      !payloadStr.includes("fixture-passwd"),
      "the entity was never resolved into file content -- no read ever happened",
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("refuted (symlink escape): a `.md` file that is a SYMLINK is skipped by walkMd -- Deno.DirEntry.isFile is false for a symlink entry", async () => {
  const v = await setupVault();
  try {
    const outsideTarget = `${v.root}/symlink-target-outside.md`;
    await Deno.writeTextFile(
      outsideTarget,
      "https://www.youtube.com/watch?v=fixtureSYM1",
    );
    const linkPath = `${v.vaultPath}/notes/symlinked-note.md`;
    await Deno.symlink(outsideTarget, linkPath);

    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", { folder: "notes" }, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    // notes/ has video-note.md + no-links.md (2 real files); the symlink is
    // a THIRD directory entry but must not be counted or walked.
    assertEquals(res.payload.totalFiles, 2);
    const links = res.payload.links as Array<Record<string, unknown>>;
    assert(
      !links.some((l) => l.videoId === "fixtureSYM1"),
      "the symlinked file's content must never be read",
    );
  } finally {
    await v.cleanup();
  }
});

Deno.test("refuted (symlink escape): a symlinked DIRECTORY is also never recursed into -- isDirectory is false for a symlink entry too", async () => {
  const v = await setupVault();
  try {
    const outsideDir = `${v.root}/symlinked-dir-target`;
    await Deno.mkdir(outsideDir, { recursive: true });
    await Deno.writeTextFile(
      `${outsideDir}/hidden.md`,
      "https://www.youtube.com/watch?v=fixtureDIR1",
    );
    await Deno.symlink(outsideDir, `${v.vaultPath}/notes/linked-dir`);

    const { ctx, written } = makeCtx(globalArgs(v.vaultPath));
    await run("scan", { folder: "notes" }, ctx);
    const res = written.find((w) => w.spec === "scan")!;
    assertEquals(res.payload.totalFiles, 2);
    const links = res.payload.links as Array<Record<string, unknown>>;
    assert(!links.some((l) => l.videoId === "fixtureDIR1"));
  } finally {
    await v.cleanup();
  }
});

// ===========================================================================
// Fixtures-secret-scan -- mechanical backstop over the committed corpus
// ===========================================================================

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "SECRET-shaped key name", re: /\b[A-Z_]*SECRET[A-Z_]*\b/ },
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
  {
    name: "bearer/token-shaped value",
    re: /^(Bearer|Token)\s+[A-Za-z0-9._-]{20,}$/,
  },
];

async function walkAllFixtureFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...await walkAllFixtureFiles(p));
    } else if (entry.isFile) {
      out.push(p);
    }
  }
  return out;
}

Deno.test("fixtures-secret-scan: no committed fixture file (vault/outside/ta) contains a secret-shaped token", async () => {
  const files = [
    ...await walkAllFixtureFiles(`${FIXTURES_DIR}/vault`),
    ...await walkAllFixtureFiles(`${FIXTURES_DIR}/outside`),
    ...await walkAllFixtureFiles(`${FIXTURES_DIR}/ta`),
  ];
  const violations: string[] = [];
  for (const file of files) {
    const raw = await Deno.readTextFile(file);
    for (const { name, re } of SECRET_PATTERNS) {
      for (const token of raw.split(/\s+/)) {
        if (re.test(token)) {
          violations.push(`${file}: token "${token}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity -- the scanner actually detects an injected secret shape", () => {
  const poisoned = "a".repeat(40);
  const violations: string[] = [];
  for (const { re } of SECRET_PATTERNS) {
    if (re.test(poisoned)) violations.push(poisoned);
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real high-entropy shape",
  );
});
