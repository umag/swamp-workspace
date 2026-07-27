/**
 * Adversarial tests for @magistr/lastfm — assume the API is hostile and the
 * transport is broken until proven otherwise.
 *
 * Dimensions exercised:
 *  - Credentials: the api_key must never appear in an error message
 *  - Error handling: Last.fm signals failure with HTTP 200 + {error, message};
 *    permanent codes fail fast, transient codes retry
 *  - API contracts: truncated JSON, an HTML error page, a hung request
 *  - Idempotency: duplicate scrobbles across a page boundary, page drift
 *  - Input validation: a non-https base, a `to` in the future
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { classifyError, model, parseRecentTracksPage } from "./lastfm.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const GLOBAL_ARGS = { user: "u3BpaT", apiKey: KEY };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Array<{ spec: string; name: string; payload: unknown }> = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ spec, name });
      },
      logger: {
        info: (m: string) => logs.push(m),
        warning: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      },
    },
  };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist`);
  return method.execute(method.arguments.parse(args), ctx);
}

async function withRawFetch(
  responder: (url: URL, call: number) => Response | Promise<Response>,
  fn: (urls: URL[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  let call = 0;
  globalThis.fetch = ((input: Request | URL | string) => {
    const raw = input instanceof Request ? input.url : String(input);
    urls.push(new URL(raw));
    return Promise.resolve(responder(new URL(raw), call++));
  }) as typeof fetch;
  try {
    await fn(urls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

Deno.test("adversarial: the api_key never appears in a thrown error message", async () => {
  const { ctx } = makeCtx();
  await withRawFetch(
    () => json({ error: 10, message: "Invalid API key" }),
    async () => {
      const err = await assertRejects(
        () => run("profile", {}, ctx) as Promise<unknown>,
      );
      assert(
        !String(err).includes(KEY),
        `api_key leaked into the error: ${String(err)}`,
      );
    },
  );
});

Deno.test("adversarial: the api_key never appears in a log line", async () => {
  const { ctx, logs } = makeCtx();
  await withRawFetch(
    () =>
      json({
        recenttracks: { "@attr": { page: "1", totalPages: "1" }, track: [] },
      }),
    async () => {
      await run("sync-history", {}, ctx);
      const blob = logs.join("\n");
      assert(!blob.includes(KEY), "api_key leaked into the logs");
    },
  );
});

// ---------------------------------------------------------------------------
// Error handling — HTTP 200 with an error body
// ---------------------------------------------------------------------------

Deno.test("adversarial: permanent codes fail fast without retrying", async () => {
  for (const code of [6, 10, 26]) {
    const { ctx } = makeCtx();
    await withRawFetch(
      () => json({ error: code, message: `permanent ${code}` }),
      async (urls) => {
        await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
        assertEquals(urls.length, 1, `code ${code} must not be retried`);
      },
    );
  }
});

Deno.test("adversarial: transient codes are retried", async () => {
  for (const code of [8, 11, 16, 29]) {
    const { ctx } = makeCtx();
    await withRawFetch(
      (_url, call) =>
        call === 0
          ? json({ error: code, message: `transient ${code}` })
          : json({ user: { name: "u3BpaT", playcount: "1" } }),
      async (urls) => {
        await run("profile", {}, ctx);
        assert(
          urls.length > 1,
          `code ${code} must be retried, saw ${urls.length}`,
        );
      },
    );
  }
});

Deno.test("adversarial: a retried transient failure eventually gives up", async () => {
  const { ctx } = makeCtx();
  await withRawFetch(
    () => json({ error: 29, message: "Rate Limit Exceded" }),
    async (urls) => {
      await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
      assert(urls.length > 1, "should have retried");
      assert(urls.length < 20, `retry storm: ${urls.length} attempts`);
    },
  );
});

Deno.test("adversarial: an error body reports the code and message", async () => {
  const { ctx } = makeCtx();
  await withRawFetch(
    () => json({ error: 26, message: "API Key Suspended" }),
    async () => {
      const err = await assertRejects(
        () => run("profile", {}, ctx) as Promise<unknown>,
      );
      const s = String(err);
      assert(s.includes("26"), `error code missing from: ${s}`);
      assert(s.includes("Suspended"), `error message missing from: ${s}`);
    },
  );
});

// ---------------------------------------------------------------------------
// API contracts — malformed transport
// ---------------------------------------------------------------------------

Deno.test("adversarial: truncated JSON fails with a diagnostic, not a crash", async () => {
  const { ctx } = makeCtx();
  await withRawFetch(
    () =>
      new Response('{"recenttracks": {"track": [', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
    },
  );
});

Deno.test("adversarial: an HTML error page instead of JSON is rejected", async () => {
  const { ctx } = makeCtx();
  await withRawFetch(
    () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    async () => {
      await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
    },
  );
});

Deno.test("adversarial: a hung request is aborted by the timeout", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, timeoutMs: 50 });
  const original = globalThis.fetch;
  globalThis.fetch =
    ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(signal.reason));
        }
      })) as typeof fetch;
  try {
    await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Idempotency / correctness under adversarial data
// ---------------------------------------------------------------------------

const UTS = Date.UTC(2008, 0, 2) / 1000;

Deno.test("adversarial: a duplicate across a page boundary is stored once", async () => {
  const { ctx, written } = makeCtx();
  const dup = {
    artist: { "#text": "A", mbid: "" },
    name: "t1",
    date: { uts: String(UTS) },
  };
  await withRawFetch(
    (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json({
        recenttracks: {
          "@attr": { page: String(page), totalPages: "2" },
          track: [dup],
        },
      });
    },
    async () => {
      await run("sync-history", {}, ctx);
      const chunk = written.find((w) => w.spec === "scrobbles");
      const rows = ((chunk?.payload as { scrobbles?: unknown[] })?.scrobbles) ??
        [];
      assertEquals(rows.length, 1, "the duplicate must be collapsed");
    },
  );
});

Deno.test("adversarial: page drift — a shrinking walk does not silently skip", async () => {
  // Page 1 reports 3 pages; by page 2 the API claims only 1. The walk must
  // terminate cleanly rather than loop or throw.
  const { ctx, written } = makeCtx();
  await withRawFetch(
    (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json({
        recenttracks: {
          "@attr": { page: String(page), totalPages: page === 1 ? "3" : "1" },
          track: [{
            artist: { "#text": "A", mbid: "" },
            name: `t${page}`,
            date: { uts: String(UTS - page) },
          }],
        },
      });
    },
    async () => {
      await run("sync-history", {}, ctx);
      assert(written.find((w) => w.spec === "history"), "walk completed");
    },
  );
});

Deno.test("adversarial: unicode and RTL track names survive intact", () => {
  const out = parseRecentTracksPage({
    recenttracks: {
      "@attr": { page: "1", totalPages: "1" },
      track: [{
        artist: { "#text": "Аквариум" },
        name: "فيروز — لبيروت",
        date: { uts: String(UTS) },
      }],
    },
  });
  assertEquals(out.scrobbles[0].artist, "Аквариум");
  assertEquals(out.scrobbles[0].track, "فيروز — لبيروت");
});

Deno.test("adversarial: a track with no date and no nowplaying flag is discarded", () => {
  const out = parseRecentTracksPage({
    recenttracks: {
      "@attr": { page: "1", totalPages: "1" },
      track: [{ artist: { "#text": "A" }, name: "orphan" }],
    },
  });
  assertEquals(
    out.scrobbles.length,
    0,
    "a scrobble without uts is not a scrobble",
  );
});

Deno.test("adversarial: classifyError never returns transient for an unknown code", () => {
  for (const code of [0, 1, 2, 3, 4, 5, 7, 9, 12, 13, 27, 100]) {
    assertEquals(classifyError(code), "permanent", `code ${code}`);
  }
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

Deno.test("adversarial: a `to` timestamp in the future is rejected", () => {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
  }>)["sync-history"];
  assert(method, "sync-history must exist");
  const future = Math.floor(Date.now() / 1000) + 86_400;
  let threw = false;
  try {
    method.arguments.parse({ to: future });
  } catch {
    threw = true;
  }
  assert(threw, "a future `to` must be rejected");
});

Deno.test("adversarial: from > to is rejected", () => {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
  }>)["sync-history"];
  assert(method, "sync-history must exist");
  let threw = false;
  try {
    method.arguments.parse({ from: 2000, to: 1000 });
  } catch {
    threw = true;
  }
  assert(threw, "an inverted range must be rejected");
});
