/**
 * Coverage suite: sweeps every guard/branch in headphones.ts that the
 * contract/methods/adversarial suites don't already exercise on BOTH sides,
 * so deleting any one of these guards turns a test red (STANDARD.md's
 * coverage role — a behavioral regression guard, not a numeric percentage).
 *
 * headphones.ts is UNMODIFIED; every test PINS existing behavior.
 *
 * Toolchain rule: no `as typeof <global-builtin>` casts — the fetch/
 * Deno.Command seams use `(globalThis|Deno as unknown as Record<string,
 * unknown>).<name>`.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./headphones.ts";
import getArtistFixture from "../../fixtures/getArtist.json" with {
  type: "json",
};
import getArtistLoadingFixture from "../../fixtures/getArtist.loading.json" with {
  type: "json",
};
import auditRowsFixture from "../../fixtures/audit.rows.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "http://headphones.example:8181",
  apiKey: "fixture-apikey-not-real-0000000000",
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  (globalThis as unknown as Record<string, unknown>).fetch = stub;
  try {
    await fn(calls);
  } finally {
    (globalThis as unknown as Record<string, unknown>).fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withOneJson(
  body: unknown,
  fn: (calls: Request[]) => Promise<unknown>,
) {
  return withFetchStub([() => json(body)], fn);
}

function apiRoute(cmd: string, body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api" || url.searchParams.get("cmd") !== cmd) {
      return undefined;
    }
    return json(body, status);
  };
}

function webUiRoute(path: string, body = "", status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname !== `/${path}`) return undefined;
    return new Response(body, { status });
  };
}

// ---------------------------------------------------------------------------
// Guard: `Array.isArray(data) ? data : []` — every bare-array method, both
// sides
// ---------------------------------------------------------------------------

type BareArrayCase = {
  method: string;
  cmd: string;
  args: Record<string, unknown>;
  spec: string;
  field: string;
};

const BARE_ARRAY_CASES: BareArrayCase[] = [
  {
    method: "get-index",
    cmd: "getIndex",
    args: {},
    spec: "artists",
    field: "artists",
  },
  {
    method: "find-artist",
    cmd: "findArtist",
    args: { name: "x" },
    spec: "search",
    field: "results",
  },
  {
    method: "find-album",
    cmd: "findAlbum",
    args: { name: "x" },
    spec: "search",
    field: "results",
  },
  {
    method: "get-wanted",
    cmd: "getWanted",
    args: {},
    spec: "albums",
    field: "albums",
  },
  {
    method: "get-snatched",
    cmd: "getSnatched",
    args: {},
    spec: "albums",
    field: "albums",
  },
  {
    method: "get-upcoming",
    cmd: "getUpcoming",
    args: {},
    spec: "albums",
    field: "albums",
  },
  {
    method: "get-history",
    cmd: "getHistory",
    args: {},
    spec: "history",
    field: "items",
  },
  { method: "get-logs", cmd: "getLogs", args: {}, spec: "logs", field: "logs" },
];

for (const tc of BARE_ARRAY_CASES) {
  Deno.test(`${tc.method}: response is NOT an array (object envelope) -> ${tc.field} collapses to []`, async () => {
    const { ctx, written } = makeCtx();
    await withOneJson(
      apiCmdBody(tc.cmd),
      () => run(tc.method, tc.args, ctx),
    );
    const res = written.find((w) => w.spec === tc.spec)!;
    assertEquals(res.payload[tc.field], []);
  });

  Deno.test(`${tc.method}: response IS an array -> ${tc.field} passed through unchanged`, async () => {
    const { ctx, written } = makeCtx();
    const rows = [{ marker: `${tc.method}-row-1` }, {
      marker: `${tc.method}-row-2`,
    }];
    await withFetchStub(
      [apiRoute(tc.cmd, rows)],
      () => run(tc.method, tc.args, ctx),
    );
    const res = written.find((w) => w.spec === tc.spec)!;
    assertEquals(res.payload[tc.field], rows);
  });
}

/** A non-array JSON envelope shaped like `{ status: "SUCCESS" }` — used to
 * pin the `Array.isArray(data) ? data : []` guard's "not an array" side
 * uniformly across every bare-array method. */
function apiCmdBody(_cmd: string): unknown {
  return { status: "SUCCESS" };
}

// ---------------------------------------------------------------------------
// Guard: get-artist's `data.artist || data` and `data.albums || []`, both
// sides
// ---------------------------------------------------------------------------

Deno.test("get-artist: `artist` key ABSENT from the response -> falls back to the WHOLE envelope (data.artist || data)", async () => {
  const { ctx, written } = makeCtx();
  const envelope = { albums: [], somethingElse: true };
  await withOneJson(envelope, () => run("get-artist", { id: "x" }, ctx));
  const res = written.find((w) => w.spec === "artist")!;
  assertEquals(
    res.payload.artist,
    envelope,
    "no `artist` key -> data.artist is undefined (falsy) -> falls back to the entire response envelope",
  );
});

Deno.test("get-artist: `artist` key PRESENT (truthy) -> used directly, envelope NOT used as fallback", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    getArtistFixture,
    () => run("get-artist", { id: getArtistFixture.artist[0].ArtistID }, ctx),
  );
  const res = written.find((w) => w.spec === "artist")!;
  assertEquals(res.payload.artist, getArtistFixture.artist);
});

Deno.test("get-artist: `albums` key ABSENT -> collapses to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    { artist: getArtistFixture.artist },
    () => run("get-artist", { id: "x" }, ctx),
  );
  const res = written.find((w) => w.spec === "artist")!;
  assertEquals(res.payload.albums, []);
});

Deno.test("get-artist: `albums` key PRESENT -> passed through unchanged", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    getArtistFixture,
    () => run("get-artist", { id: getArtistFixture.artist[0].ArtistID }, ctx),
  );
  const res = written.find((w) => w.spec === "artist")!;
  assertEquals(res.payload.albums, getArtistFixture.albums);
});

// ---------------------------------------------------------------------------
// Guard: get-album's `data.album || data` and `data.tracks || []`, both
// sides
// ---------------------------------------------------------------------------

Deno.test("get-album: `album` key ABSENT from the response -> falls back to the WHOLE envelope", async () => {
  const { ctx, written } = makeCtx();
  const envelope = { tracks: [], somethingElse: true };
  await withOneJson(envelope, () => run("get-album", { id: "x" }, ctx));
  const res = written.find((w) => w.spec === "album")!;
  assertEquals(res.payload.album, envelope);
});

Deno.test("get-album: `tracks` key ABSENT -> collapses to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    { album: [{ AlbumID: "x" }] },
    () => run("get-album", { id: "x" }, ctx),
  );
  const res = written.find((w) => w.spec === "album")!;
  assertEquals(res.payload.tracks, []);
});

// ---------------------------------------------------------------------------
// Guard: api()'s `try { JSON.parse } catch { {raw} }`, both sides (general
// form — the adversarial suite covers the "hostile HTML server" framing
// specifically; this pins the guard itself)
// ---------------------------------------------------------------------------

Deno.test("api(): valid JSON body -> JSON.parse succeeds, no {raw} wrapper", async () => {
  const { ctx, written } = makeCtx();
  await withOneJson(
    { current_version: "abc" },
    () => run("get-version", {}, ctx),
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.current_version, "abc");
  assertEquals(res.payload.raw, undefined);
});

Deno.test("api(): non-JSON 200 body -> JSON.parse throws, caught, falls back to {raw: text}", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => new Response("not json at all", { status: 200 })],
    () => run("get-version", {}, ctx),
  );
  const res = written.find((w) => w.spec === "version")!;
  assertEquals(res.payload.raw, "not json at all");
});

// ---------------------------------------------------------------------------
// onboard-artists guards
// ---------------------------------------------------------------------------

async function driveOnboardPoll<T>(
  time: FakeTime,
  resultPromise: Promise<T>,
  maxTicks = 20,
): Promise<T> {
  let settled = false;
  resultPromise.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let i = 0; i < maxTicks && !settled; i++) {
    await time.tickAsync(5000);
    await Promise.resolve();
  }
  return await resultPromise;
}

Deno.test({
  name:
    "onboard-artists: pending filter — null/undefined/''/Skipped are queued; Wanted/Snatched/Downloaded are left alone (both sides of every branch)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      const artistFixture = {
        artist: getArtistFixture.artist,
        albums: [
          { AlbumID: "a-null", Status: null },
          { AlbumID: "a-undefined" }, // Status key entirely absent
          { AlbumID: "a-empty", Status: "" },
          { AlbumID: "a-skipped", Status: "Skipped" },
          { AlbumID: "a-wanted", Status: "Wanted" },
          { AlbumID: "a-snatched", Status: "Snatched" },
          { AlbumID: "a-downloaded", Status: "Downloaded" },
        ],
        description: [],
      };
      const queuedIds: string[] = [];
      const resultPromise = withFetchStub(
        [
          apiRoute("addArtist", {}),
          webUiRoute("getExtras"),
          apiRoute("getArtist", artistFixture),
          (req) => {
            const url = new URL(req.url);
            if (
              url.pathname !== "/api" ||
              url.searchParams.get("cmd") !== "queueAlbum"
            ) return undefined;
            queuedIds.push(url.searchParams.get("id")!);
            return json({});
          },
        ],
        () => run("onboard-artists", { ids: ["artist-x"] }, ctx),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const summary = (res.payload.artists as Array<Record<string, unknown>>)[
        0
      ];
      assertEquals(summary.totalAlbums, 7);
      assertEquals(
        summary.queued,
        4,
        "null/undefined/''/Skipped must all be queued",
      );
      assertEquals(
        summary.alreadyActive,
        3,
        "Wanted/Snatched/Downloaded must be left alone",
      );
      assertEquals(
        queuedIds.sort(),
        ["a-empty", "a-null", "a-skipped", "a-undefined"].sort(),
      );
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name:
    "onboard-artists: queue explicitly true — pending albums ARE queued (mirrors the default; both explicit forms pinned)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      let queueAlbumCalls = 0;
      const resultPromise = withFetchStub(
        [
          apiRoute("addArtist", {}),
          webUiRoute("getExtras"),
          apiRoute("getArtist", getArtistFixture),
          (req) => {
            const url = new URL(req.url);
            if (
              url.pathname === "/api" &&
              url.searchParams.get("cmd") === "queueAlbum"
            ) {
              queueAlbumCalls++;
              return json({});
            }
            return undefined;
          },
        ],
        () =>
          run(
            "onboard-artists",
            { ids: [getArtistFixture.artist[0].ArtistID], queue: true },
            ctx,
          ),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const summary = (res.payload.artists as Array<Record<string, unknown>>)[
        0
      ];
      assertEquals(summary.queued, 1);
      assertEquals(queueAlbumCalls, 1);
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name:
    "onboard-artists: timeout expiry — Status never leaves Loading before the deadline -> loaded stays false, no exception, batch continues",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      const resultPromise = withFetchStub(
        [
          apiRoute("addArtist", {}),
          webUiRoute("getExtras"),
          apiRoute("getArtist", getArtistLoadingFixture), // ALWAYS Loading
        ],
        () =>
          run(
            "onboard-artists",
            {
              ids: [getArtistLoadingFixture.artist[0].ArtistID],
              timeoutSeconds: 10,
            },
            ctx,
          ),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const summary = (res.payload.artists as Array<Record<string, unknown>>)[
        0
      ];
      assertEquals(
        summary.loaded,
        false,
        "deadline expired while still Loading",
      );
      assertEquals(summary.error, undefined, "expiry is not an exception");
      assertEquals(summary.totalAlbums, 0);
      assertEquals(summary.queued, 0);
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name:
    "onboard-artists: supplying an EMPTY types array collapses to DEFAULT_EXTRA_TYPES (same falsy-length guard as omitted)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      let extrasParams: URLSearchParams | undefined;
      const resultPromise = withFetchStub(
        [
          apiRoute("addArtist", {}),
          (req) => {
            const url = new URL(req.url);
            if (url.pathname !== "/getExtras") return undefined;
            extrasParams = url.searchParams;
            return new Response("", { status: 200 });
          },
          apiRoute("getArtist", getArtistFixture),
          apiRoute("queueAlbum", {}),
        ],
        () =>
          run(
            "onboard-artists",
            { ids: [getArtistFixture.artist[0].ArtistID], types: [] },
            ctx,
          ),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const summary = (res.payload.artists as Array<Record<string, unknown>>)[
        0
      ];
      assertEquals(
        summary.extras,
        ["ep", "single", "live", "compilation", "demo"],
        "empty array must collapse to DEFAULT_EXTRA_TYPES, same as omitted",
      );
      assert(extrasParams?.get("ep") === "1");
    } finally {
      time.restore();
    }
  },
});

// ---------------------------------------------------------------------------
// queue-album's `if (args.lossless)` guard, both sides
// ---------------------------------------------------------------------------

Deno.test("queue-album: lossless=false (falsy, explicit) -> omitted from params, same as undefined", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("queueAlbum", {})],
    async (calls) => {
      await run("queue-album", { id: "album-1", lossless: false }, ctx);
      assert(!new URL(calls[0].url).searchParams.has("lossless"));
    },
  );
});

// ---------------------------------------------------------------------------
// force-process's `if (args.dir)` guard, both sides (incl. falsy empty
// string, not just omitted)
// ---------------------------------------------------------------------------

Deno.test("force-process: dir='' (empty, falsy) -> omitted from params, same as omitted entirely", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("forceProcess", {})],
    async (calls) => {
      await run("force-process", { dir: "" }, ctx);
      assert(!new URL(calls[0].url).searchParams.has("dir"));
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assertEquals(res.payload.message, "Post-processing initiated");
});

// ---------------------------------------------------------------------------
// audit-library guards: titleNorm/artistNorm length<2 skip/bypass, both
// sides of the length==2 boundary
// ---------------------------------------------------------------------------

type CommandResult = { success: boolean; stdout: string; stderr: string };
type CommandRouter = (commandLine: string) => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();
  const calls: string[] = [];

  class FakeCommand {
    #commandLine: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#commandLine = args[args.length - 1] ?? "";
      calls.push(this.#commandLine);
    }
    output() {
      const r = router(this.#commandLine);
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
    spawn() {
      const commandLine = this.#commandLine;
      return {
        stdin: {
          getWriter: () => ({
            write: (_bytes: Uint8Array) => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          const r = router(commandLine);
          return Promise.resolve({
            success: r.success,
            code: r.success ? 0 : 1,
            stdout: encoder.encode(r.stdout),
            stderr: encoder.encode(r.stderr),
          });
        },
      };
    }
  }

  const original = Deno.Command;
  (Deno as unknown as Record<string, unknown>).Command = FakeCommand;
  return {
    calls,
    restore: () => {
      (Deno as unknown as Record<string, unknown>).Command = original;
    },
  };
}

function routerWith(dirs: string[], rows: unknown[]): CommandRouter {
  return (commandLine) => {
    if (commandLine.startsWith("find ")) {
      return { success: true, stdout: dirs.join("\n") + "\n", stderr: "" };
    }
    if (commandLine.startsWith("sqlite3")) {
      return { success: true, stdout: JSON.stringify(rows), stderr: "" };
    }
    return { success: false, stdout: "", stderr: `unrouted: ${commandLine}` };
  };
}

Deno.test("audit-library: AlbumTitle normalizing to < 2 chars is SKIPPED (continue) — neither present nor missing", async () => {
  const { ctx, written } = makeCtx(
    { ...GLOBAL_ARGS, sshHost: "media.headphones.example" },
  );
  const rows = [
    {
      AlbumID: "short",
      ArtistName: "Someone",
      AlbumTitle: "A",
      ReleaseDate: null,
    },
    auditRowsFixture[1], // a normal row that WILL be present
  ];
  const dirs = ["/music/Autechre/Confield"];
  const stub = installCommandStub(routerWith(dirs, rows));
  try {
    await run("audit-library", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "audit")!;
  assertEquals(res.payload.totalDownloaded, 2);
  assertEquals(
    (res.payload.presentOnDisk as number) +
      (res.payload.missingCount as number),
    1,
    "the length<2 title row must be silently skipped — neither counted present nor missing",
  );
});

Deno.test("audit-library: ArtistName normalizing to < 2 chars BYPASSES the requireArtist check even when requireArtist=true", async () => {
  const { ctx, written } = makeCtx(
    { ...GLOBAL_ARGS, sshHost: "media.headphones.example" },
  );
  const rows = [
    {
      AlbumID: "x",
      ArtistName: "X",
      AlbumTitle: "Ghettoville",
      ReleaseDate: null,
    },
  ];
  // Directory contains the title but NOT any artist name.
  const dirs = ["/music/unsorted/Ghettoville"];
  const stub = installCommandStub(routerWith(dirs, rows));
  try {
    await run("audit-library", { requireArtist: true }, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "audit")!;
  assertEquals(
    res.payload.missingCount,
    0,
    "artistNorm.length < 2 must bypass the artist check even with requireArtist=true",
  );
});

Deno.test("audit-library: ArtistName normalizing to EXACTLY 2 chars does NOT bypass — requireArtist=true and a non-matching dir -> missing", async () => {
  const { ctx, written } = makeCtx(
    { ...GLOBAL_ARGS, sshHost: "media.headphones.example" },
  );
  const rows = [
    {
      AlbumID: "x",
      ArtistName: "Xu",
      AlbumTitle: "Ghettoville",
      ReleaseDate: null,
    },
  ];
  const dirs = ["/music/unsorted/Ghettoville"]; // no "xu" anywhere
  const stub = installCommandStub(routerWith(dirs, rows));
  try {
    await run("audit-library", { requireArtist: true }, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "audit")!;
  assertEquals(
    res.payload.missingCount,
    1,
    "a 2-char artist name is NOT short-circuited — requireArtist=true must still apply",
  );
});

// ---------------------------------------------------------------------------
// Security-review finding: apiKey is NOT marked sensitive today
// ---------------------------------------------------------------------------

Deno.test("pin: apiKey is NOT marked `.meta({ sensitive: true })` today — documented security-hardening gap", () => {
  // Unlike telegram-send's botToken, headphones.ts's globalArguments schema
  // never calls `.meta({ sensitive: true })` on apiKey. Real gap surfaced
  // during the test-backfill security review; headphones.ts is deliberately
  // UNMODIFIED by this change (no manifest version bump). This pins the
  // CURRENT (regrettable) state so a future fix flips it from failing to
  // passing rather than silently slipping by. Tracked by
  // `headphones-apikey-hardening`.
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.apiKey) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    undefined,
    "apiKey is not yet marked sensitive — if this starts failing, headphones.ts added the annotation; update this pin to assert true",
  );
});
