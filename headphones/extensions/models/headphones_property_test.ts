/**
 * Property-based / invariant / multi-step-flow tests (fast-check) for
 * @magistr/headphones.
 *
 * headphones.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch (+ a stubbed
 * Deno.Command for the audit-library invariant) and reading back the
 * written resource, per the approved plan.
 *
 * Properties:
 *  (a) onboard-artists partition invariant — queued + alreadyActive ==
 *      totalAlbums, and no album with Status in {Wanted, Snatched,
 *      Downloaded} is ever queued, over random per-album status arrays.
 *  (b) onboard-artists totalQueued == the sum of every per-artist `queued`,
 *      over random multi-artist batches.
 *  (c) onboard-artists per-artist error isolation — a random subset of
 *      failing artist ids never prevents the surviving ids from producing a
 *      full, correct summary.
 *  (d) the apiKey sentinel never appears in any written resource, across
 *      random method/response combinations.
 *  (e) audit-library's substring-match invariant — a directory containing
 *      both the (normalized) artist and title always yields present, never
 *      missing.
 *
 * PLUS an EXPLICIT multi-step clobber flow: unqueue-album sets an album to
 * Skipped, then onboard-artists (Skipped is in its pending filter) re-queues
 * that same album — pinning the cross-method idempotency defect described in
 * plan v2 (tracked by the filed hardening issue
 * `headphones-apikey-hardening`).
 *
 * FakeTime import pinned: `import { FakeTime } from "jsr:@std/testing@1/time"`.
 * fast-check pinned: `npm:fast-check@4.8.0`. Iteration count gated by
 * FC_NUM_RUNS (small default in CI, large in `deno task test:soak`).
 *
 * Toolchain rule: no `as typeof <global-builtin>` casts — the fetch/
 * Deno.Command seams use `(globalThis|Deno as unknown as Record<string,
 * unknown>).<name>`.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./headphones.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(50) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const APIKEY_SENTINEL = "fixture-only-property-not-a-real-headphones-key";

const GLOBAL_ARGS = {
  host: "http://headphones.example:8181",
  apiKey: APIKEY_SENTINEL,
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
  fn: (calls: CapturedRequest[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
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
    for (const route of routes) {
      const res = await route(routable);
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
// (a) onboard-artists partition invariant
// ---------------------------------------------------------------------------

const arbAlbumStatus = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constant("Skipped"),
  fc.constant("Wanted"),
  fc.constant("Snatched"),
  fc.constant("Downloaded"),
  fc.stringMatching(/^[A-Za-z]{1,10}$/),
);

const arbAlbum = fc.record({
  AlbumID: fc.uuid(),
  Status: arbAlbumStatus,
});

const NEVER_QUEUE = new Set(["Wanted", "Snatched", "Downloaded"]);

async function runOnboardOnce(
  albums: Array<{ AlbumID: string; Status: unknown }>,
  artistId = "prop-artist",
) {
  const { ctx, written } = makeCtx();
  const queuedIds = new Set<string>();
  const artistPayload = {
    artist: [{
      ArtistID: artistId,
      ArtistName: "Prop Artist",
      Status: "Active",
    }],
    albums,
    description: [],
  };
  await withFetchStub(
    [
      apiRoute("addArtist", {}),
      webUiRoute("getExtras"),
      apiRoute("getArtist", artistPayload),
      (req) => {
        const url = new URL(req.url);
        if (
          url.pathname !== "/api" ||
          url.searchParams.get("cmd") !== "queueAlbum"
        ) return undefined;
        queuedIds.add(url.searchParams.get("id")!);
        return json({});
      },
    ],
    () => run("onboard-artists", { ids: [artistId] }, ctx),
  );
  const res = written.find((w) => w.spec === "onboarding")!;
  const summary = (res.payload.artists as Array<Record<string, unknown>>)[0];
  return { summary, queuedIds, written };
}

Deno.test({
  name:
    "property: onboard-artists partition invariant — queued + alreadyActive == totalAlbums; Wanted/Snatched/Downloaded never queued",
  // AbortSignal.timeout(60_000) inside api() is a Deno-native timer that
  // leaves a real, inert, never-firing timer pending at test-end for every
  // simulated api() call. See headphones_methods_test.ts's file header.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAlbum, { maxLength: 12 }),
        async (albums) => {
          const { summary, queuedIds } = await runOnboardOnce(albums);
          for (const a of albums) {
            if (
              NEVER_QUEUE.has(a.Status as string) && queuedIds.has(a.AlbumID)
            ) {
              return false;
            }
          }
          return (
            (summary.queued as number) + (summary.alreadyActive as number) ===
              albums.length
          );
        },
      ),
      FC_RUNS,
    );
  },
});

// ---------------------------------------------------------------------------
// (b) totalQueued == sum of per-artist queued
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "property: onboard-artists totalQueued == the sum of every per-artist queued, over random multi-artist batches",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(arbAlbumStatus, { maxLength: 6 }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (perArtistStatuses) => {
          const { ctx, written } = makeCtx();
          const ids = perArtistStatuses.map((_, i) => `artist-${i}`);
          await withFetchStub(
            [
              apiRoute("addArtist", {}),
              webUiRoute("getExtras"),
              (req) => {
                const url = new URL(req.url);
                if (
                  url.pathname !== "/api" ||
                  url.searchParams.get("cmd") !== "getArtist"
                ) return undefined;
                const id = url.searchParams.get("id")!;
                const idx = ids.indexOf(id);
                const albums = perArtistStatuses[idx].map((s, j) => ({
                  AlbumID: `${id}-album-${j}`,
                  Status: s,
                }));
                return json({
                  artist: [{ ArtistID: id, ArtistName: id, Status: "Active" }],
                  albums,
                  description: [],
                });
              },
              apiRoute("queueAlbum", {}),
            ],
            () => run("onboard-artists", { ids }, ctx),
          );
          const res = written.find((w) => w.spec === "onboarding")!;
          const summaries = res.payload.artists as Array<
            Record<string, unknown>
          >;
          const sumQueued = summaries.reduce(
            (acc, s) => acc + (s.queued as number),
            0,
          );
          return res.payload.totalQueued === sumQueued;
        },
      ),
      FC_RUNS,
    );
  },
});

// ---------------------------------------------------------------------------
// (c) per-artist error isolation
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "property: onboard-artists per-artist error isolation — a random subset of failing ids never blocks the surviving ids from a full, correct summary",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 999 }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        async (idNums, failFlags) => {
          const ids = idNums.map((n) => `artist-${n}`);
          const fails = new Set(
            ids.filter((_, i) => failFlags[i % failFlags.length]),
          );
          const { ctx, written } = makeCtx();
          await withFetchStub(
            [
              (req) => {
                const url = new URL(req.url);
                if (
                  url.pathname !== "/api" ||
                  url.searchParams.get("cmd") !== "addArtist"
                ) return undefined;
                const id = url.searchParams.get("id")!;
                if (fails.has(id)) return json({ error: "boom" }, 500);
                return json({});
              },
              webUiRoute("getExtras"),
              (req) => {
                const url = new URL(req.url);
                if (
                  url.pathname !== "/api" ||
                  url.searchParams.get("cmd") !== "getArtist"
                ) return undefined;
                const id = url.searchParams.get("id")!;
                return json({
                  artist: [{ ArtistID: id, ArtistName: id, Status: "Active" }],
                  albums: [],
                  description: [],
                });
              },
            ],
            () => run("onboard-artists", { ids }, ctx),
          );
          const res = written.find((w) => w.spec === "onboarding")!;
          const summaries = res.payload.artists as Array<
            Record<string, unknown>
          >;
          if (summaries.length !== ids.length) return false;
          for (const s of summaries) {
            const isFailing = fails.has(s.artistId as string);
            if (isFailing && !(typeof s.error === "string" && s.error)) {
              return false;
            }
            if (!isFailing && s.error !== undefined) return false;
          }
          return true;
        },
      ),
      FC_RUNS,
    );
  },
});

// ---------------------------------------------------------------------------
// (d) apiKey sentinel never appears in any written resource
// ---------------------------------------------------------------------------

const arbSimpleMethod = fc.constantFrom(
  "get-index",
  "get-wanted",
  "get-history",
  "get-logs",
  "get-version",
);

Deno.test("property: the apiKey sentinel never appears in any written resource, across random simple-method/response combinations", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSimpleMethod,
      fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
      async (methodName, junkStrings) => {
        const { ctx, written } = makeCtx();
        const cmdByMethod: Record<string, string> = {
          "get-index": "getIndex",
          "get-wanted": "getWanted",
          "get-history": "getHistory",
          "get-logs": "getLogs",
          "get-version": "getVersion",
        };
        const cmd = cmdByMethod[methodName];
        const body = methodName === "get-version"
          ? Object.fromEntries(junkStrings.map((s, i) => [`k${i}`, s]))
          : junkStrings;
        await withFetchStub(
          [apiRoute(cmd, body)],
          () => run(methodName, {}, ctx),
        );
        for (const w of written) {
          if (JSON.stringify(w.payload).includes(APIKEY_SENTINEL)) {
            return false;
          }
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) audit-library substring-match invariant
// ---------------------------------------------------------------------------

type CommandResult = { success: boolean; stdout: string; stderr: string };
type CommandRouter = (commandLine: string) => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();

  class FakeCommand {
    #commandLine: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#commandLine = args[args.length - 1] ?? "";
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
    restore: () => {
      (Deno as unknown as Record<string, unknown>).Command = original;
    },
  };
}

// Alphabetic-only, length >= 2 — guarantees normalize() never triggers the
// titleNorm/artistNorm length<2 skip/bypass guards, so this property is
// exercising the genuine substring-match path, not a vacuous skip.
const arbWord = fc.stringMatching(/^[A-Za-z]{2,12}$/);

Deno.test("property: audit-library's substring-match invariant — a directory containing both the (normalized) artist and title always yields present, never missing", async () => {
  await fc.assert(
    fc.asyncProperty(arbWord, arbWord, async (artist, title) => {
      const { ctx, written } = makeCtx(
        { ...GLOBAL_ARGS, sshHost: "media.headphones.example" },
      );
      const rows = [
        {
          AlbumID: "x",
          ArtistName: artist,
          AlbumTitle: title,
          ReleaseDate: null,
        },
      ];
      const dirs = [`/music/${artist}/${title}`];
      const stub = installCommandStub((commandLine) => {
        if (commandLine.startsWith("find ")) {
          return { success: true, stdout: dirs.join("\n") + "\n", stderr: "" };
        }
        return { success: true, stdout: JSON.stringify(rows), stderr: "" };
      });
      try {
        await run("audit-library", { requireArtist: true }, ctx);
      } finally {
        stub.restore();
      }
      const res = written.find((w) => w.spec === "audit")!;
      return res.payload.missingCount === 0;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// EXPLICIT clobber flow: unqueue-album -> onboard-artists re-queues Skipped
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "FLOW (documented idempotency clobber, PIN not fix): unqueue-album sets an album to Skipped, then onboard-artists re-queues that SAME album",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ALBUM_ID = "3d4e5f6a-7777-8888-9999-aaaabbbbcccc";
    const ARTIST_ID = "f59c5520-5f92-4d33-b271-c0b45741e0aa";

    // Step 1: unqueue-album — the operator's intent is "leave this alone".
    const { ctx: unqueueCtx, written: unqueueWritten } = makeCtx();
    await withFetchStub(
      [apiRoute("unqueueAlbum", {})],
      () => run("unqueue-album", { id: ALBUM_ID }, unqueueCtx),
    );
    const unqueueRes = unqueueWritten.find((w) => w.spec === "task")!;
    assert((unqueueRes.payload.message as string).includes(ALBUM_ID));

    // Step 2: onboard-artists runs later (e.g. a scheduled onboarding sweep)
    // and observes the SAME album now at Status "Skipped" — exactly what
    // step 1 just set server-side. onboard-artists' pending filter includes
    // `s === "Skipped"`, so it re-queues it, silently undoing step 1's
    // intent. This is the real cross-method idempotency defect from plan
    // v2 (tracked by the local `headphones-apikey-hardening` issue-lifecycle
    // model) — PINNED here, not fixed; it is explicitly out of scope for the
    // redaction + array-unwrap fix landed by that model (onboard-artists'
    // pending filter is untouched by this change).
    const { ctx: onboardCtx, written: onboardWritten } = makeCtx();
    const queuedIds: string[] = [];
    await withFetchStub(
      [
        apiRoute("addArtist", {}),
        webUiRoute("getExtras"),
        apiRoute("getArtist", {
          artist: [
            {
              ArtistID: ARTIST_ID,
              ArtistName: "Boards of Canada",
              Status: "Active",
            },
          ],
          albums: [
            {
              AlbumID: ALBUM_ID,
              AlbumTitle: "Music Has the Right to Children",
              Status: "Skipped",
            },
          ],
          description: [],
        }),
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
      () => run("onboard-artists", { ids: [ARTIST_ID] }, onboardCtx),
    );
    const onboardRes = onboardWritten.find((w) => w.spec === "onboarding")!;
    const summary =
      (onboardRes.payload.artists as Array<Record<string, unknown>>)[0];

    assertEquals(
      queuedIds,
      [ALBUM_ID],
      "CLOBBER: onboard-artists re-queues the album unqueue-album just marked Skipped",
    );
    assertEquals(summary.queued, 1);
    assertEquals(summary.alreadyActive, 0);
  },
});
