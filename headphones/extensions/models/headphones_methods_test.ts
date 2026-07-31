/**
 * Method-level tests for @magistr/headphones — every one of the 29 methods,
 * happy path + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` (the `api()`/`webUi()` JSON-API + web-UI-form paths)
 * and, for `audit-library`, a stubbed `Deno.Command` covering BOTH shapes it
 * uses: `cmd.output()` (sshCommand's `find`) and
 * `cmd.spawn().stdin.getWriter()` + `.output()` (sshExecSql's `sqlite3
 * -json`).
 *
 * get-artist/get-album's array-unwrap was FIXED by this change (see
 * `headphones-apikey-hardening`); their happy-path tests below assert the
 * corrected, unwrapped shape. Every other test here is a characterization
 * test that PINS the model's current, already-shipped behavior.
 *
 * Toolchain rule: no `as typeof <global-builtin>` casts anywhere in this
 * file — the fetch/Deno.Command seams are installed via
 * `(globalThis|Deno as unknown as Record<string, unknown>).<name>`.
 *
 * `onboard-artists` requires `@std/testing`'s FakeTime (tickAsync +
 * promise-flush) to drive its setTimeout(5000)/Date.now() poll loop
 * deterministically. Those tests disable `sanitizeOps`/`sanitizeResources`
 * with an inline justification: `api()`'s `AbortSignal.timeout(60_000)` is a
 * Deno-native timer FakeTime cannot intercept (it only patches the
 * `globalThis.setTimeout`/`Date` surface), so a real, never-firing 60s timer
 * is left pending at test-end for every simulated poll iteration — this is
 * inert (the stubbed fetch never respects the signal) but would otherwise
 * trip Deno's leaked-timer sanitizer. See round-1 adversarial finding.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./headphones.ts";
import getIndexFixture from "../../fixtures/getIndex.json" with {
  type: "json",
};
import getArtistFixture from "../../fixtures/getArtist.json" with {
  type: "json",
};
import getArtistLoadingFixture from "../../fixtures/getArtist.loading.json" with {
  type: "json",
};
import findArtistFixture from "../../fixtures/findArtist.json" with {
  type: "json",
};
import getAlbumFixture from "../../fixtures/getAlbum.json" with {
  type: "json",
};
import getWantedFixture from "../../fixtures/getWanted.json" with {
  type: "json",
};
import getHistoryFixture from "../../fixtures/getHistory.json" with {
  type: "json",
};
import getLogsFixture from "../../fixtures/getLogs.json" with {
  type: "json",
};
import getVersionFixture from "../../fixtures/getVersion.json" with {
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

const GLOBAL_ARGS_WITH_SSH = {
  ...GLOBAL_ARGS,
  sshHost: "media.headphones.example",
  sshUser: "root",
  dbPath: "/config/headphones.db",
  musicDir: "/music",
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
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
      logger: {
        info: (...args: unknown[]) => logs.push({ level: "info", args }),
        warning: (...args: unknown[]) => logs.push({ level: "warning", args }),
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Cast-free seam per the toolchain rule. */
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

function text(body: string, status = 200) {
  return new Response(body, { status });
}

/** Route matching `${host}/api?cmd=<cmd>&...`. */
function apiRoute(cmd: string, body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api" || url.searchParams.get("cmd") !== cmd) {
      return undefined;
    }
    return json(body, status);
  };
}

/** Route matching the web-UI getExtras form path `${host}/<path>?...`. */
function webUiRoute(path: string, body = "", status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname !== `/${path}`) return undefined;
    return text(body, status);
  };
}

// ---------------------------------------------------------------------------
// Deno.Command dual-shape stub (audit-library only)
// ---------------------------------------------------------------------------

type CommandResult = { success: boolean; stdout: string; stderr: string };
type CommandRouter = (commandLine: string) => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();
  const calls: string[] = [];
  const stdinWrites: string[] = [];

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
      let written = "";
      return {
        stdin: {
          getWriter: () => ({
            write: (bytes: Uint8Array) => {
              written += new TextDecoder().decode(bytes);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          stdinWrites.push(written);
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
    stdinWrites,
    restore: () => {
      (Deno as unknown as Record<string, unknown>).Command = original;
    },
  };
}

// ---------------------------------------------------------------------------
// get-index
// ---------------------------------------------------------------------------

Deno.test("get-index: happy path — writes artists resource with total == length", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getIndex", getIndexFixture)],
    () => run("get-index", {}, ctx),
  );
  const res = written.find((w) => w.spec === "artists")!;
  assertEquals(res.payload.artists, getIndexFixture);
  assertEquals(res.payload.total, getIndexFixture.length);
});

Deno.test("get-index: error path — non-2xx status throws with cmd+status+body", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getIndex", "internal error", 500)],
    () =>
      assertRejects(
        () => run("get-index", {}, ctx),
        Error,
        "API getIndex failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// get-artist
// ---------------------------------------------------------------------------

Deno.test("get-artist: happy path — sends id, writes the unwrapped artist object + albums", async () => {
  const { ctx, written } = makeCtx();
  const id = getArtistFixture.artist[0].ArtistID;
  await withFetchStub(
    [apiRoute("getArtist", getArtistFixture)],
    async (calls) => {
      await run("get-artist", { id }, ctx);
      assertEquals(new URL(calls[0].url).searchParams.get("id"), id);
    },
  );
  const res = written.find((w) => w.spec === "artist")!;
  assertEquals(res.payload.artist, getArtistFixture.artist[0]);
  assertEquals(res.payload.albums, getArtistFixture.albums);
});

Deno.test("get-artist: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getArtist", "not found", 404)],
    () =>
      assertRejects(
        () => run("get-artist", { id: "does-not-exist" }, ctx),
        Error,
        "API getArtist failed: 404",
      ),
  );
});

// ---------------------------------------------------------------------------
// find-artist
// ---------------------------------------------------------------------------

Deno.test("find-artist: happy path without limit — limit param omitted, writes search results", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("findArtist", findArtistFixture)],
    async (calls) => {
      await run("find-artist", { name: "Boards of Canada" }, ctx);
      assert(!new URL(calls[0].url).searchParams.has("limit"));
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, findArtistFixture);
  assertEquals(res.payload.total, findArtistFixture.length);
  assertEquals(res.payload.query, "Boards of Canada");
});

Deno.test("find-artist: happy path with limit — limit param sent as a string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("findArtist", findArtistFixture)],
    async (calls) => {
      await run("find-artist", { name: "Autechre", limit: 5 }, ctx);
      assertEquals(new URL(calls[0].url).searchParams.get("limit"), "5");
    },
  );
});

Deno.test("find-artist: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("findArtist", "boom", 503)],
    () =>
      assertRejects(
        () => run("find-artist", { name: "x" }, ctx),
        Error,
        "API findArtist failed: 503",
      ),
  );
});

// ---------------------------------------------------------------------------
// set-extras
// ---------------------------------------------------------------------------

Deno.test("set-extras: happy path, default types — getExtras form gets ArtistID, newstyle=true, and exactly the DEFAULT_EXTRA_TYPES keys=1", async () => {
  const { ctx, written } = makeCtx();
  const DEFAULT_EXTRA_TYPES = ["ep", "single", "live", "compilation", "demo"];
  const OTHER_TYPES = [
    "soundtrack",
    "remix",
    "spokenword",
    "audiobook",
    "other",
    "dj-mix",
    "mixtape/street",
    "broadcast",
    "interview",
  ];
  await withFetchStub(
    [webUiRoute("getExtras")],
    async (calls) => {
      await run("set-extras", { id: "artist-1" }, ctx);
      const params = new URL(calls[0].url).searchParams;
      assertEquals(params.get("ArtistID"), "artist-1");
      assertEquals(params.get("newstyle"), "true");
      for (const t of DEFAULT_EXTRA_TYPES) assertEquals(params.get(t), "1");
      for (const t of OTHER_TYPES) assert(!params.has(t));
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assert((res.payload.message as string).includes("artist-1"));
});

Deno.test("set-extras: happy path, custom types — only the supplied types are sent", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [webUiRoute("getExtras")],
    async (calls) => {
      await run(
        "set-extras",
        { id: "artist-2", types: ["broadcast", "interview"] },
        ctx,
      );
      const params = new URL(calls[0].url).searchParams;
      assertEquals(params.get("broadcast"), "1");
      assertEquals(params.get("interview"), "1");
      assert(!params.has("ep"), "non-supplied default type must be absent");
    },
  );
});

Deno.test("set-extras: error path — non-2xx status throws with the webUi path in the message", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [webUiRoute("getExtras", "server error", 500)],
    () =>
      assertRejects(
        () => run("set-extras", { id: "artist-1" }, ctx),
        Error,
        "getExtras failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// onboard-artists — FakeTime-driven poll loop
// ---------------------------------------------------------------------------

/** Advance the poll loop until `resultPromise` settles, alternating fake-time
 * ticks with microtask flushes — the "tickAsync + promise-flush per
 * iteration" discipline the round-1 review required. Caps at `maxTicks` so a
 * bug that stops the loop from ever resolving fails fast instead of hanging. */
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
    "onboard-artists: happy path — polls past Loading, queues only pending albums, doQueue defaults true",
  // AbortSignal.timeout(60_000) inside api() is a Deno-native timer FakeTime
  // cannot intercept; the stubbed fetch never honors it, so it is inert but
  // remains "pending" at test-end for every simulated getArtist poll call.
  // See the file-header note and the round-1 adversarial finding.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      let getArtistCalls = 0;
      const queuedIds: string[] = [];
      const resultPromise = withFetchStub(
        [
          apiRoute("addArtist", {}),
          webUiRoute("getExtras"),
          (req) => {
            const url = new URL(req.url);
            if (
              url.pathname !== "/api" ||
              url.searchParams.get("cmd") !== "getArtist"
            ) return undefined;
            getArtistCalls++;
            return json(
              getArtistCalls < 3 ? getArtistLoadingFixture : getArtistFixture,
            );
          },
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
        () =>
          run(
            "onboard-artists",
            { ids: [getArtistFixture.artist[0].ArtistID] },
            ctx,
          ),
      );
      await driveOnboardPoll(time, resultPromise);

      const res = written.find((w) => w.spec === "onboarding")!;
      const artists = res.payload.artists as Array<Record<string, unknown>>;
      assertEquals(artists.length, 1);
      const summary = artists[0];
      assertEquals(summary.loaded, true);
      // getArtistFixture has 2 albums: one Downloaded (already active), one
      // Skipped (pending — onboard's filter includes Skipped, see PIN test
      // in the property suite for the unqueue-album clobber flow).
      assertEquals(summary.totalAlbums, 2);
      assertEquals(summary.queued, 1);
      assertEquals(summary.alreadyActive, 1);
      assertEquals(res.payload.totalQueued, 1);
      assertEquals(queuedIds, ["3d4e5f6a-7777-8888-9999-aaaabbbbcccc"]);
      assertEquals(getArtistCalls, 3, "must poll until Status leaves Loading");
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name:
    "onboard-artists: queue=false — pending albums are counted but never queued",
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
            {
              ids: [getArtistFixture.artist[0].ArtistID],
              queue: false,
            },
            ctx,
          ),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const summary = (res.payload.artists as Array<Record<string, unknown>>)[
        0
      ];
      assertEquals(summary.queued, 0);
      assertEquals(
        queueAlbumCalls,
        0,
        "queue=false must never call queueAlbum",
      );
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name:
    "onboard-artists: per-artist error isolation — one bad id fails without aborting the batch, both summaries recorded",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      const BAD_ID = "bad-artist-id";
      const GOOD_ID = getArtistFixture.artist[0].ArtistID;
      const resultPromise = withFetchStub(
        [
          (req) => {
            const url = new URL(req.url);
            if (
              url.pathname === "/api" &&
              url.searchParams.get("cmd") === "addArtist"
            ) {
              if (url.searchParams.get("id") === BAD_ID) {
                return json({ error: "no such MusicBrainz id" }, 400);
              }
              return json({});
            }
            return undefined;
          },
          webUiRoute("getExtras"),
          apiRoute("getArtist", getArtistFixture),
          apiRoute("queueAlbum", {}),
        ],
        () => run("onboard-artists", { ids: [BAD_ID, GOOD_ID] }, ctx),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const artists = res.payload.artists as Array<Record<string, unknown>>;
      assertEquals(artists.length, 2, "both ids must produce a summary");
      const bad = artists.find((a) => a.artistId === BAD_ID)!;
      const good = artists.find((a) => a.artistId === GOOD_ID)!;
      assert(typeof bad.error === "string" && bad.error.length > 0);
      assertEquals(bad.loaded, false);
      assertEquals(good.loaded, true);
      assertEquals(good.error, undefined);
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name:
    "onboard-artists: a failing queueAlbum for one pending album is captured in `failed`, other albums still queue",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const time = new FakeTime();
    try {
      const { ctx, written } = makeCtx();
      // Two pending (Skipped/null-status) albums so both attempt queueAlbum.
      const twoAlbumsFixture = {
        ...getArtistFixture,
        albums: [
          { ...getArtistFixture.albums[1], AlbumID: "pending-fail" },
          { ...getArtistFixture.albums[1], AlbumID: "pending-ok" },
        ],
      };
      const resultPromise = withFetchStub(
        [
          apiRoute("addArtist", {}),
          webUiRoute("getExtras"),
          apiRoute("getArtist", twoAlbumsFixture),
          (req) => {
            const url = new URL(req.url);
            if (
              url.pathname !== "/api" ||
              url.searchParams.get("cmd") !== "queueAlbum"
            ) return undefined;
            const id = url.searchParams.get("id");
            if (id === "pending-fail") return json("nope", 500);
            return json({});
          },
        ],
        () =>
          run(
            "onboard-artists",
            { ids: [getArtistFixture.artist[0].ArtistID] },
            ctx,
          ),
      );
      await driveOnboardPoll(time, resultPromise);
      const res = written.find((w) => w.spec === "onboarding")!;
      const summary = (res.payload.artists as Array<Record<string, unknown>>)[
        0
      ];
      assertEquals(summary.queued, 1);
      const failed = summary.failed as Array<Record<string, unknown>>;
      assertEquals(failed.length, 1);
      assertEquals(failed[0].albumId, "pending-fail");
    } finally {
      time.restore();
    }
  },
});

// ---------------------------------------------------------------------------
// del-artist / pause-artist / resume-artist / refresh-artist / add-album /
// unqueue-album / force-search / force-active-artists-update / clear-logs /
// restart / update — table-driven: every one of these follows the identical
// "call api(cmd, params) -> write a task resource with a message" shape.
// ---------------------------------------------------------------------------

type SimpleTaskCase = {
  method: string;
  cmd: string;
  args: Record<string, unknown>;
  params: Record<string, string>;
  messageIncludes: string;
};

const SIMPLE_TASK_CASES: SimpleTaskCase[] = [
  {
    method: "del-artist",
    cmd: "delArtist",
    args: { id: "artist-1" },
    params: { id: "artist-1" },
    messageIncludes: "Deleted artist artist-1",
  },
  {
    method: "pause-artist",
    cmd: "pauseArtist",
    args: { id: "artist-1" },
    params: { id: "artist-1" },
    messageIncludes: "Paused artist artist-1",
  },
  {
    method: "resume-artist",
    cmd: "resumeArtist",
    args: { id: "artist-1" },
    params: { id: "artist-1" },
    messageIncludes: "Resumed artist artist-1",
  },
  {
    method: "refresh-artist",
    cmd: "refreshArtist",
    args: { id: "artist-1" },
    params: { id: "artist-1" },
    messageIncludes: "Refreshed artist artist-1",
  },
  {
    method: "add-album",
    cmd: "addAlbum",
    args: { id: "album-1" },
    params: { id: "album-1" },
    messageIncludes: "Added album album-1",
  },
  {
    method: "unqueue-album",
    cmd: "unqueueAlbum",
    args: { id: "album-1" },
    params: { id: "album-1" },
    messageIncludes: "Unqueued album album-1",
  },
  {
    method: "force-search",
    cmd: "forceSearch",
    args: {},
    params: {},
    messageIncludes: "Forced album search initiated",
  },
  {
    method: "force-active-artists-update",
    cmd: "forceActiveArtistsUpdate",
    args: {},
    params: {},
    messageIncludes: "Active artists update initiated",
  },
  {
    method: "clear-logs",
    cmd: "clearLogs",
    args: {},
    params: {},
    messageIncludes: "Logs cleared",
  },
  {
    method: "restart",
    cmd: "restart",
    args: {},
    params: {},
    messageIncludes: "Restart initiated",
  },
  {
    method: "update",
    cmd: "update",
    args: {},
    params: {},
    messageIncludes: "Update initiated",
  },
];

for (const tc of SIMPLE_TASK_CASES) {
  Deno.test(`${tc.method}: happy path — calls cmd=${tc.cmd}, writes a task message`, async () => {
    const { ctx, written } = makeCtx();
    await withFetchStub(
      [apiRoute(tc.cmd, {})],
      async (calls) => {
        await run(tc.method, tc.args, ctx);
        const params = new URL(calls[0].url).searchParams;
        for (const [k, v] of Object.entries(tc.params)) {
          assertEquals(params.get(k), v);
        }
      },
    );
    const res = written.find((w) => w.spec === "task")!;
    assert(
      (res.payload.message as string).includes(tc.messageIncludes),
      `expected message to include "${tc.messageIncludes}", got "${res.payload.message}"`,
    );
  });

  Deno.test(`${tc.method}: error path — non-2xx status throws`, async () => {
    const { ctx } = makeCtx();
    await withFetchStub(
      [apiRoute(tc.cmd, "boom", 500)],
      () =>
        assertRejects(
          () => run(tc.method, tc.args, ctx),
          Error,
          `API ${tc.cmd} failed: 500`,
        ),
    );
  });
}

Deno.test("add-artist: happy path — calls addArtist, writes task message (kept separate: also exercised by onboard-artists' fan-out)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("addArtist", {})],
    () => run("add-artist", { id: "artist-9" }, ctx),
  );
  const res = written.find((w) => w.spec === "task")!;
  assert((res.payload.message as string).includes("Added artist artist-9"));
});

Deno.test("add-artist: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("addArtist", "boom", 500)],
    () =>
      assertRejects(
        () => run("add-artist", { id: "artist-9" }, ctx),
        Error,
        "API addArtist failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// get-album
// ---------------------------------------------------------------------------

Deno.test("get-album: happy path — sends id, writes the unwrapped album object + tracks", async () => {
  const { ctx, written } = makeCtx();
  const id = getAlbumFixture.album[0].AlbumID;
  await withFetchStub(
    [apiRoute("getAlbum", getAlbumFixture)],
    async (calls) => {
      await run("get-album", { id }, ctx);
      assertEquals(new URL(calls[0].url).searchParams.get("id"), id);
    },
  );
  const res = written.find((w) => w.spec === "album")!;
  assertEquals(res.payload.album, getAlbumFixture.album[0]);
  assertEquals(res.payload.tracks, getAlbumFixture.tracks);
});

Deno.test("get-album: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getAlbum", "not found", 404)],
    () =>
      assertRejects(
        () => run("get-album", { id: "missing" }, ctx),
        Error,
        "API getAlbum failed: 404",
      ),
  );
});

// ---------------------------------------------------------------------------
// find-album
// ---------------------------------------------------------------------------

Deno.test("find-album: happy path without limit — writes search results", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("findAlbum", findArtistFixture)],
    async (calls) => {
      await run("find-album", { name: "Tomorrow's Harvest" }, ctx);
      assert(!new URL(calls[0].url).searchParams.has("limit"));
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, findArtistFixture);
});

Deno.test("find-album: happy path with limit — limit sent as a string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("findAlbum", [])],
    async (calls) => {
      await run("find-album", { name: "x", limit: 10 }, ctx);
      assertEquals(new URL(calls[0].url).searchParams.get("limit"), "10");
    },
  );
});

Deno.test("find-album: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("findAlbum", "boom", 500)],
    () =>
      assertRejects(
        () => run("find-album", { name: "x" }, ctx),
        Error,
        "API findAlbum failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// queue-album
// ---------------------------------------------------------------------------

Deno.test("queue-album: happy path without lossless — lossless param omitted", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("queueAlbum", {})],
    async (calls) => {
      await run("queue-album", { id: "album-1" }, ctx);
      assert(!new URL(calls[0].url).searchParams.has("lossless"));
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assert((res.payload.message as string).includes("album-1"));
});

Deno.test("queue-album: happy path with lossless=true — lossless=1 sent", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("queueAlbum", {})],
    async (calls) => {
      await run("queue-album", { id: "album-1", lossless: true }, ctx);
      assertEquals(
        new URL(calls[0].url).searchParams.get("lossless"),
        "1",
      );
    },
  );
});

Deno.test("queue-album: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("queueAlbum", "boom", 500)],
    () =>
      assertRejects(
        () => run("queue-album", { id: "album-1" }, ctx),
        Error,
        "API queueAlbum failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// get-wanted / get-snatched / get-upcoming / get-history
// ---------------------------------------------------------------------------

Deno.test("get-wanted: happy path — writes albums with category 'wanted'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getWanted", getWantedFixture)],
    () => run("get-wanted", {}, ctx),
  );
  const res = written.find((w) => w.spec === "albums")!;
  assertEquals(res.payload.albums, getWantedFixture);
  assertEquals(res.payload.category, "wanted");
});

Deno.test("get-wanted: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getWanted", "boom", 500)],
    () =>
      assertRejects(
        () => run("get-wanted", {}, ctx),
        Error,
        "API getWanted failed: 500",
      ),
  );
});

Deno.test("get-snatched: happy path — writes albums with category 'snatched'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getSnatched", getWantedFixture)],
    () => run("get-snatched", {}, ctx),
  );
  const res = written.find((w) => w.spec === "albums")!;
  assertEquals(res.payload.albums, getWantedFixture);
  assertEquals(res.payload.category, "snatched");
});

Deno.test("get-snatched: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getSnatched", "boom", 500)],
    () =>
      assertRejects(
        () => run("get-snatched", {}, ctx),
        Error,
        "API getSnatched failed: 500",
      ),
  );
});

Deno.test("get-upcoming: happy path — writes albums with category 'upcoming'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getUpcoming", getWantedFixture)],
    () => run("get-upcoming", {}, ctx),
  );
  const res = written.find((w) => w.spec === "albums")!;
  assertEquals(res.payload.albums, getWantedFixture);
  assertEquals(res.payload.category, "upcoming");
});

Deno.test("get-upcoming: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getUpcoming", "boom", 500)],
    () =>
      assertRejects(
        () => run("get-upcoming", {}, ctx),
        Error,
        "API getUpcoming failed: 500",
      ),
  );
});

Deno.test("get-history: happy path — writes history items with total == length", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getHistory", getHistoryFixture)],
    () => run("get-history", {}, ctx),
  );
  const res = written.find((w) => w.spec === "history")!;
  assertEquals(res.payload.items, getHistoryFixture);
  assertEquals(res.payload.total, getHistoryFixture.length);
});

Deno.test("get-history: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getHistory", "boom", 500)],
    () =>
      assertRejects(
        () => run("get-history", {}, ctx),
        Error,
        "API getHistory failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// force-process
// ---------------------------------------------------------------------------

Deno.test("force-process: happy path without dir — dir param omitted", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("forceProcess", {})],
    async (calls) => {
      await run("force-process", {}, ctx);
      assert(!new URL(calls[0].url).searchParams.has("dir"));
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assertEquals(res.payload.message, "Post-processing initiated");
});

Deno.test("force-process: happy path with dir — dir param sent, message includes it", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("forceProcess", {})],
    async (calls) => {
      await run("force-process", { dir: "/downloads/complete" }, ctx);
      assertEquals(
        new URL(calls[0].url).searchParams.get("dir"),
        "/downloads/complete",
      );
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assert((res.payload.message as string).includes("/downloads/complete"));
});

Deno.test("force-process: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("forceProcess", "boom", 500)],
    () =>
      assertRejects(
        () => run("force-process", {}, ctx),
        Error,
        "API forceProcess failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// get-version / check-github
// ---------------------------------------------------------------------------

Deno.test("get-version: happy path — writes version fields verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getVersion", getVersionFixture)],
    () => run("get-version", {}, ctx),
  );
  const res = written.find((w) =>
    w.spec === "version" && w.name === "current"
  )!;
  assertEquals(res.payload.current_version, getVersionFixture.current_version);
  assertEquals(res.payload.commits_behind, getVersionFixture.commits_behind);
});

Deno.test("get-version: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getVersion", "boom", 500)],
    () =>
      assertRejects(
        () => run("get-version", {}, ctx),
        Error,
        "API getVersion failed: 500",
      ),
  );
});

Deno.test("check-github: happy path — writes version fields under name 'update-check'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("checkGithub", getVersionFixture)],
    () => run("check-github", {}, ctx),
  );
  const res = written.find((
    w,
  ) => (w.spec === "version" && w.name === "update-check"))!;
  assertEquals(res.payload.current_version, getVersionFixture.current_version);
});

Deno.test("check-github: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("checkGithub", "boom", 500)],
    () =>
      assertRejects(
        () => run("check-github", {}, ctx),
        Error,
        "API checkGithub failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// get-logs
// ---------------------------------------------------------------------------

Deno.test("get-logs: happy path — writes logs array verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [apiRoute("getLogs", getLogsFixture)],
    () => run("get-logs", {}, ctx),
  );
  const res = written.find((w) => w.spec === "logs")!;
  assertEquals(res.payload.logs, getLogsFixture);
});

Deno.test("get-logs: error path — non-2xx status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [apiRoute("getLogs", "boom", 500)],
    () =>
      assertRejects(
        () => run("get-logs", {}, ctx),
        Error,
        "API getLogs failed: 500",
      ),
  );
});

// ---------------------------------------------------------------------------
// audit-library
// ---------------------------------------------------------------------------

function defaultAuditRouter(dirs: string[]): CommandRouter {
  return (commandLine) => {
    if (commandLine.startsWith("find ")) {
      return { success: true, stdout: dirs.join("\n") + "\n", stderr: "" };
    }
    if (commandLine.startsWith("sqlite3")) {
      return {
        success: true,
        stdout: JSON.stringify(auditRowsFixture),
        stderr: "",
      };
    }
    return { success: false, stdout: "", stderr: `unrouted: ${commandLine}` };
  };
}

Deno.test("audit-library: happy path — cross-checks DB rows against filesystem dirs, splitting present/missing", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS_WITH_SSH);
  // Only 2 of the 3 downloaded albums (Boards of Canada, Autechre) have a
  // matching directory; Actress/Ghettoville is deliberately absent.
  const dirs = [
    "/music/Boards of Canada/Tomorrow's Harvest",
    "/music/Autechre/Confield",
  ];
  const stub = installCommandStub(defaultAuditRouter(dirs));
  try {
    await run("audit-library", {}, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "audit")!;
  assertEquals(res.payload.totalDownloaded, auditRowsFixture.length);
  assertEquals(res.payload.presentOnDisk, 2);
  assertEquals(res.payload.missingCount, 1);
  const missing = res.payload.missing as Array<Record<string, unknown>>;
  assertEquals(missing.length, 1);
  assertEquals(missing[0].ArtistName, "Actress");
  assertEquals(res.payload.scannedDirs, dirs.length);
  assertEquals(res.payload.musicDir, "/music");
  assertEquals(res.payload.dbPath, "/config/headphones.db");
});

Deno.test("audit-library: missing sshHost throws before any SSH command is invoked", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS); // no sshHost
  const stub = installCommandStub(defaultAuditRouter([]));
  try {
    await assertRejects(
      () => run("audit-library", {}, ctx),
      Error,
      "sshHost must be set",
    );
    assertEquals(stub.calls.length, 0, "no Deno.Command must be constructed");
  } finally {
    stub.restore();
  }
});

Deno.test("audit-library: requireArtist=false relaxes matching to title-only", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS_WITH_SSH);
  // Directory contains the album title ("Confield") but NOT the artist name
  // ("Autechre") anywhere in the path.
  const dirs = ["/music/misc-drop/Confield (2001)"];
  const rows = [auditRowsFixture[1]]; // Autechre - Confield
  const stub = installCommandStub((commandLine) => {
    if (commandLine.startsWith("find ")) {
      return { success: true, stdout: dirs.join("\n") + "\n", stderr: "" };
    }
    return { success: true, stdout: JSON.stringify(rows), stderr: "" };
  });
  try {
    await run("audit-library", { requireArtist: false }, ctx);
  } finally {
    stub.restore();
  }
  const res = written.find((w) => w.spec === "audit")!;
  assertEquals(
    res.payload.missingCount,
    0,
    "requireArtist=false must find it on title alone",
  );
});

Deno.test("audit-library: maxDepth threads through into the find command's -maxdepth flag", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS_WITH_SSH);
  const stub = installCommandStub(defaultAuditRouter([]));
  try {
    await run("audit-library", { maxDepth: 7 }, ctx);
  } finally {
    stub.restore();
  }
  const findCall = stub.calls.find((c) => c.startsWith("find "))!;
  assert(
    findCall.includes("-maxdepth 7"),
    `expected -maxdepth 7 in "${findCall}"`,
  );
});

Deno.test("audit-library: default maxDepth is 4 when not supplied", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS_WITH_SSH);
  const stub = installCommandStub(defaultAuditRouter([]));
  try {
    await run("audit-library", {}, ctx);
  } finally {
    stub.restore();
  }
  const findCall = stub.calls.find((c) => c.startsWith("find "))!;
  assert(findCall.includes("-maxdepth 4"));
});

// ---------------------------------------------------------------------------
// No method calls the logger — pin (mirrors the porkbun/telegram-send
// precedent: a future change that starts logging must add its own leak test)
// ---------------------------------------------------------------------------

Deno.test("pin: no method calls context.logger today, across a representative happy-path sweep", async () => {
  const { ctx, logs } = makeCtx();
  await withFetchStub(
    [apiRoute("getIndex", getIndexFixture)],
    () => run("get-index", {}, ctx),
  );
  await withFetchStub(
    [apiRoute("getVersion", getVersionFixture)],
    () => run("get-version", {}, ctx),
  );
  assertEquals(logs.length, 0);
});
