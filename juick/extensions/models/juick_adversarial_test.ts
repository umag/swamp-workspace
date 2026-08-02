/**
 * Adversarial suite: FIXED (juick-latent-bugs, all 8 LBs) — SSRF via
 * `apiUrl` is now closed by a default-deny `allowedHosts` allowlist plus an
 * unconditional loopback/link-local/private-IP-literal backstop, re-applied
 * on every redirect hop (LB1); YAML-frontmatter injection via raw
 * `uname`/`tags` interpolation in the Obsidian builder is now escaped (LB2);
 * the unbounded `while(true)` pagination loop now stops when the cursor
 * fails to advance AND is hard-capped by `maxPages` (LB3); an unguarded
 * `JSON.parse` on a non-JSON 200 body now throws a domain error (LB4); the
 * three DISTINCT non-array/malformed-response failure shapes across
 * getMessages/getThread/getUser are now coerced/validated instead of sailing
 * through or throwing a bare TypeError (LB5); a unicode astral-plane
 * title-slice split is fixed by slicing on code points (LB6); every request
 * now carries an AbortSignal (`timeout` global arg) and 429/503 responses
 * surface `Retry-After` in the thrown error (LB7); the getMessages
 * resource-name clobber when both uname and tag are given is fixed by
 * folding both into the name (LB8); plus a mechanical fixtures-secret-scan
 * (unaffected by this change — juick has no credentials, see
 * fixtures/PROVENANCE.md).
 *
 * Every "FIXED" test below replaces a same-named "pin" test that used to
 * characterize the gap rather than fix it — see git history / CHANGELOG.md
 * for the before/after. The fetch stub is cast `as unknown as typeof
 * globalThis.fetch` (deno 2.8.3 toolchain pin).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, yamlDq } from "./juick.ts";
import messages from "../../fixtures/messages.json" with { type: "json" };
import thread from "../../fixtures/thread.json" with { type: "json" };
import user from "../../fixtures/user.json" with { type: "json" };
import userpostsPage1 from "../../fixtures/userposts-page1.json" with {
  type: "json",
};
import userpostsPage2 from "../../fixtures/userposts-page2.json" with {
  type: "json",
};
import error500 from "../../fixtures/error-500.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { apiUrl: "https://api.juick.com" };

type Written = { spec: string; name: string; payload: unknown };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warn: () => {} },
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

type Call = { input: Request | URL | string; init: RequestInit | undefined };
type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Fetch stub that ALSO captures the raw (input, init) pair passed to
 * `fetch()` — needed to prove an AbortSignal (and `redirect: "manual"`) is
 * threaded through, since `new Request(input, init)` always synthesizes an
 * implicit `.signal` even when the caller passed none (musicbrainz-
 * adversarial pattern). */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[], rawCalls: Call[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const rawCalls: Call[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    rawCalls.push({ input, init });
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    return await fn(calls, rawCalls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route for a single-page getUserPosts scenario: the FIRST `/messages`
 * request (no `before_mid` yet) returns `msgs`, every subsequent request
 * (now carrying `before_mid`) returns an empty batch to terminate the
 * source's pagination loop. Every getUserPosts test in this file MUST use a
 * terminating route like this one — a route that always returns a non-empty
 * batch hangs the test itself (round-1/round-2 review finding). */
function singlePage(msgs: Array<Record<string, unknown>>): Route {
  return (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname !== "/messages") return undefined;
    return url.search.includes("before_mid") ? json([]) : json(msgs);
  };
}

// ---------------------------------------------------------------------------
// SSRF (LB1) — default-deny allowedHosts + unconditional private-IP backstop
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB1): an internal/metadata-service apiUrl is rejected before any fetch happens", async () => {
  const { ctx } = makeCtx({
    apiUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  });
  await withFetchStub(
    [() => json([])],
    async (calls) => {
      await assertRejects(() => run("getMessages", {}, ctx), Error);
      assertEquals(
        calls.length,
        0,
        "the private-IP-literal backstop rejects the URL before fetch is ever called",
      );
    },
  );
});

Deno.test("FIXED (juick-latent-bugs LB1): z.string().url() still validates URL SYNTAX ONLY (host-agnostic), but getMessages now REJECTS every syntactically-valid hostile apiUrl — while a real api.juick.com apiUrl still succeeds through the SAME path (non-vacuous control)", async () => {
  const hostileButSyntacticallyValid = [
    "http://169.254.169.254/",
    "http://localhost:22/",
    "http://[::1]/",
    "http://internal.corp.local/",
  ];
  for (const apiUrl of hostileButSyntacticallyValid) {
    // The schema itself is unchanged — it still only validates URL syntax.
    const parsed = model.globalArguments.parse({ apiUrl }) as {
      apiUrl: string;
    };
    assertEquals(
      parsed.apiUrl,
      apiUrl,
      `${apiUrl} must still parse cleanly — z.string().url() has no host check`,
    );

    // ...but the METHOD now rejects it: the allowlist/private-IP guard lives
    // in juickApi, not in the schema.
    const { ctx } = makeCtx({ apiUrl });
    await withFetchStub([() => json([])], async (calls) => {
      await assertRejects(() => run("getMessages", {}, ctx), Error);
      assertEquals(calls.length, 0, `${apiUrl} must never reach fetch`);
    });
  }

  // Non-vacuous control: the SAME code path (juickApi, default
  // allowedHosts) succeeds for the real api.juick.com host.
  const { ctx: controlCtx } = makeCtx({ apiUrl: "https://api.juick.com" });
  await withFetchStub([() => json([])], async (calls) => {
    await run("getMessages", {}, controlCtx);
    assertEquals(
      calls.length,
      1,
      "api.juick.com is allowed by the default allowedHosts — the guard does not vacuously reject everything",
    );
  });
});

Deno.test("FIXED (juick-latent-bugs LB1): a private-IP-literal host is rejected EVEN IF explicitly present in allowedHosts — the private-IP backstop is unconditional", async () => {
  const { ctx } = makeCtx({
    apiUrl: "http://169.254.169.254/",
    allowedHosts: ["169.254.169.254", "api.juick.com"],
  });
  await withFetchStub(
    [() => json([])],
    async (calls) => {
      const err = await assertRejects(
        () => run("getMessages", {}, ctx),
        Error,
      );
      assert(
        !/unrouted request/i.test(err.message),
        "must fail on the private-IP guard, not because the stub had no matching route",
      );
      assertEquals(
        calls.length,
        0,
        "even an explicit allowedHosts entry cannot resurrect a private-IP-literal target",
      );
    },
  );
});

Deno.test("FIXED (juick-latent-bugs LB1): an allowlisted host that 3xx-redirects to an internal/link-local Location is rejected on the redirect hop — the internal host is never fetched", async () => {
  const { ctx } = makeCtx({ apiUrl: "https://api.juick.com" });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.hostname === "api.juick.com") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return undefined;
    }],
    async (calls) => {
      await assertRejects(() => run("getMessages", {}, ctx), Error);
      assertEquals(
        calls.length,
        1,
        "only the initial api.juick.com request happens — the redirect target is never fetched",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// YAML-frontmatter injection (LB2) — uname/tags now escaped
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB2): a hostile uname containing a quote and a newline no longer corrupts the YAML frontmatter — source:/author: are now escaped exactly like title", async () => {
  const { ctx, written } = makeCtx();
  const hostileUname = 'evil"\nadmin: true\nx';
  await withFetchStub(
    [singlePage([{ mid: 9001, body: "post body", replies: 0 }])],
    async () => {
      await run(
        "getUserPosts",
        { uname: hostileUname, withComments: false },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as { posts: Array<{ obsidianContent: string }> })
    .posts;
  const md = posts[0].obsidianContent;
  const safeUname = yamlDq(hostileUname);
  assert(
    md.includes(`source: "https://juick.com/${safeUname}/9001"`),
    "the escaped uname is interpolated into source: — no raw newline survives",
  );
  assert(
    md.includes(`author: "${safeUname}"`),
    "the escaped uname is interpolated into author: too",
  );
  // Scope the "no injected key" check to the actual YAML frontmatter block
  // (between the opening and closing `---` markers) — the raw (unescaped)
  // uname still appears verbatim later in the plain-markdown "> Original:"
  // backlink line, which is body text, not YAML, and is unaffected by this
  // fix (out of LB2's scope: only source:/author: were hostile YAML sinks).
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert(fmMatch, "the YAML frontmatter block must be present");
  const frontmatter = fmMatch![1];
  assert(
    !frontmatter.split("\n").some((line) => line.trim() === "admin: true"),
    "the injected `admin: true` must NOT land as its own line inside the YAML frontmatter block",
  );
});

Deno.test("FIXED (juick-latent-bugs LB2): a hostile tag with a newline and a leading '- ' no longer injects an extra YAML list item under tags:", async () => {
  const { ctx, written } = makeCtx();
  const hostileTag = "x\n  - injected-list-item";
  await withFetchStub(
    [singlePage([{
      mid: 9002,
      body: "tagged post",
      tags: [hostileTag],
      replies: 0,
    }])],
    async () => {
      await run("getUserPosts", { uname: "victim", withComments: false }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as { posts: Array<{ obsidianContent: string }> })
    .posts;
  const md = posts[0].obsidianContent;
  const tagLines = md.split("tags:\n")[1].split("---")[0].split("\n").filter((
    l,
  ) => l.length > 0);
  assertEquals(
    tagLines.length,
    2,
    "exactly two list items: the base 'juick' tag plus the (now single-line) hostile tag — no standalone injected entry",
  );
  assert(
    !md.includes("\n  - injected-list-item\n"),
    "the newline is collapsed to a space — 'injected-list-item' never starts its own list line",
  );
});

Deno.test("pin: a tag CONTAINING a colon is the only thing sanitized — colons become hyphens, nothing else is escaped", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [singlePage([{ mid: 9003, body: "post", tags: ["a:b:c"], replies: 0 }])],
    async () => {
      await run("getUserPosts", { uname: "u", withComments: false }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as { posts: Array<{ obsidianContent: string }> })
    .posts;
  assert(posts[0].obsidianContent.includes("  - a-b-c\n"));
});

// ---------------------------------------------------------------------------
// Pagination (LB3) — stops on a stuck cursor AND is hard-capped by maxPages
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB3): a batch whose LAST message has no `mid` now STOPS pagination after the one batch instead of re-issuing the identical page-1 query forever", async () => {
  const { ctx, written } = makeCtx();
  const pathologicalBatch = [
    { mid: 100, body: "has a mid", replies: 0 },
    { body: "no mid field on this one", replies: 0 },
  ];
  let baseQueryCalls = 0;
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/messages" &&
        url.search === "?uname=missing-mid-victim"
      ) {
        baseQueryCalls++;
        return json(pathologicalBatch);
      }
      return undefined;
    }],
    async (calls) => {
      await run(
        "getUserPosts",
        { uname: "missing-mid-victim", withComments: false },
        ctx,
      );
      assertEquals(
        calls.length,
        1,
        "only ONE request is made — a missing mid now stops the loop instead of silently re-issuing the same page-1 query",
      );
    },
  );
  assertEquals(baseQueryCalls, 1);
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as { posts: unknown[] }).posts;
  assertEquals(
    posts.length,
    2,
    "both messages from the one successfully-fetched batch are still kept — only the CURSOR stops, the batch itself is unaffected",
  );
});

Deno.test("FIXED (juick-latent-bugs LB3): a server that always echoes the SAME page (ignores before_mid) now stops after 2 requests instead of looping unbounded", async () => {
  const repeatedBatch = [{ mid: 200, body: "always the same", replies: 0 }];
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [() => {
      calls++;
      return json(repeatedBatch);
    }],
    async () => {
      await run(
        "getUserPosts",
        { uname: "stuck-server-victim", withComments: false },
        ctx,
      );
    },
  );
  assertEquals(
    calls,
    2,
    "request 1 advances before_mid to 200; request 2 gets the identical page again (before_mid stayed 200 — cursor didn't advance) and the loop stops there",
  );
});

Deno.test("FIXED (juick-latent-bugs LB3): maxPages caps getUserPosts — a server that ALWAYS returns a fresh, ever-advancing page is still stopped after maxPages requests", async () => {
  const { ctx, written } = makeCtx({
    apiUrl: "https://api.juick.com",
    maxPages: 3,
  });
  let mid = 1000;
  let calls = 0;
  await withFetchStub(
    [() => {
      calls++;
      return json([{ mid: mid--, body: "always another page", replies: 0 }]);
    }],
    async () => {
      await run(
        "getUserPosts",
        { uname: "endless-server-victim", withComments: false },
        ctx,
      );
    },
  );
  assertEquals(
    calls,
    3,
    "maxPages=3 stops the loop after exactly 3 page fetches, even though the cursor advances every time and the server would happily keep paginating forever",
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as { posts: unknown[] }).posts;
  assertEquals(
    posts.length,
    3,
    "all 3 fetched pages' single message each is kept",
  );
});

// ---------------------------------------------------------------------------
// Three DISTINCT non-array / malformed-response failure shapes (LB5) — now
// coerced/validated instead of sailing through or throwing a bare TypeError
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB5 shape 1/3): getMessages — a non-array truthy `data` (object) is now coerced to [] exactly like the falsy case, and the written resource passes its OWN schema", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ unexpected: "object shape", not: "an array" })],
    async () => {
      await run("getMessages", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "messages")!;
  const payload = res.payload as { messages: unknown; count: unknown };
  assertEquals(
    payload.messages,
    [],
    "a non-array truthy object is now coerced to [] — Array.isArray(data) replaces the old `data || []`",
  );
  assertEquals(payload.count, 0);
  const validation = model.resources.messages.schema.safeParse(payload);
  assert(
    validation.success,
    "the coerced payload now passes the real resource schema — writeResource would no longer throw in the real swamp runtime",
  );
});

Deno.test("FIXED (juick-latent-bugs LB5 shape 2/3): getThread — a non-array truthy `data` (object) no longer throws a TypeError; post defaults to {} and comments to []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ unexpected: "object", not: "an array" })],
    async () => {
      await run("getThread", { mid: 1 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "thread")!;
  const payload = res.payload as { post: unknown; comments: unknown };
  assertEquals(payload.post, {});
  assertEquals(payload.comments, []);
});

Deno.test("FIXED (juick-latent-bugs LB5 shape 3/3): getUser — a non-array truthy `data` (object) that fails UserSchema now throws a domain error instead of being written through as-is", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ error: "not a user, not an array" })],
    async () => {
      await assertRejects(
        () => run("getUser", { uname: "x" }, ctx),
        Error,
        "invalid user response",
      );
    },
  );
  assertEquals(
    written.find((w) => w.spec === "userProfile"),
    undefined,
    "no resource is written when the shape fails validation",
  );
});

Deno.test("FIXED (juick-latent-bugs LB5): getUser on an EMPTY array `[]` — data[0] is undefined, which now also throws a domain error instead of writing `undefined` through", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json([])],
    async () => {
      await assertRejects(
        () => run("getUser", { uname: "ghost" }, ctx),
        Error,
        "invalid user response",
      );
    },
  );
  assertEquals(written.find((w) => w.spec === "userProfile"), undefined);
});

// ---------------------------------------------------------------------------
// JSON.parse (LB4) — a non-JSON 200 body now throws a domain error
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB4): a non-JSON 200 response body (e.g. an HTML error page from a misconfigured proxy) now surfaces as a Juick domain Error, not a bare SyntaxError", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html><body>502 via reverse proxy</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      const err = await assertRejects(
        () => run("getMessages", {}, ctx),
        Error,
      );
      assert(
        !(err instanceof SyntaxError),
        "juickApi's JSON.parse is now wrapped — this must NOT be a bare SyntaxError",
      );
      assert(
        err.message.includes("invalid JSON response"),
        "the domain error message identifies the failure as an invalid JSON response",
      );
    },
  );
});

Deno.test("pin: an empty 200 body (no content) parses to `null`, not an error — `text ? JSON.parse(text) : null`", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => new Response("", { status: 200 })],
    async () => {
      await run("getMessages", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals((res.payload as { messages: unknown }).messages, []);
});

// ---------------------------------------------------------------------------
// AbortSignal/timeout + Retry-After (LB7)
// ---------------------------------------------------------------------------

Deno.test('FIXED (juick-latent-bugs LB7): every request now carries an AbortSignal and uses redirect: "manual" — a hung api.juick.com endpoint can no longer hang the call forever', async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json([])],
    async (_calls, rawCalls) => {
      await run("getMessages", {}, ctx);
      assertEquals(rawCalls.length, 1);
      const init = rawCalls[0].init;
      assert(init !== undefined, "fetch is now called with an init object");
      assert(
        init!.signal instanceof AbortSignal,
        "an AbortSignal is threaded through to fetch",
      );
      assertEquals(
        init!.redirect,
        "manual",
        'redirect: "manual" is required so redirect Locations can be re-validated (LB1)',
      );
    },
  );
});

Deno.test("FIXED (juick-latent-bugs LB7): a 503 WITH a Retry-After header still throws (no auto-retry), but the header value is now surfaced in the error message", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("service unavailable", {
        status: 503,
        headers: { "Retry-After": "120" },
      })],
    async (calls) => {
      const err = await assertRejects(
        () => run("getMessages", {}, ctx),
        Error,
      );
      assert(err.message.includes("503"));
      assert(
        err.message.includes("120"),
        "the Retry-After value is now included in the thrown error message",
      );
      assertEquals(
        calls.length,
        1,
        "still no retry is attempted — Retry-After is surfaced, not acted on",
      );
    },
  );
});

Deno.test("FIXED (juick-latent-bugs LB7): juickApi aborts an in-flight request once `timeout` elapses — a hung endpoint no longer hangs the call forever", async () => {
  const { ctx } = makeCtx({ apiUrl: "https://api.juick.com", timeout: 20 });
  await withFetchStub(
    [(req) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => {
          reject(
            new DOMException("The signal has been aborted", "AbortError"),
          );
        });
      })],
    async () => {
      await assertRejects(() => run("getMessages", {}, ctx), DOMException);
    },
  );
});

// ---------------------------------------------------------------------------
// Unicode astral-plane split (LB6) — fixed by slicing on code points
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB6): a title whose 80th CODE POINT lands on an astral emoji keeps the surrogate pair intact — slicing now happens by code point, not UTF-16 code unit", async () => {
  const { ctx, written } = makeCtx();
  // 79 ASCII chars + one astral emoji (2 UTF-16 code units: a high surrogate
  // then a low surrogate, but exactly ONE code point).
  const prefix = "x".repeat(79);
  const astral = "\u{1F600}"; // 😀 U+1F600, encoded as a surrogate pair
  const body = prefix + astral + " trailing text that must be cut off";
  await withFetchStub(
    [singlePage([{ mid: 9999, body, replies: 0 }])],
    async () => {
      await run("getUserPosts", { uname: "u", withComments: false }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as {
    posts: Array<{ obsidianPath: string }>;
  }).posts;
  const recoveredTitle = posts[0].obsidianPath.slice("juick/".length);
  assertEquals(
    Array.from(recoveredTitle).length,
    80,
    "80 CODE POINTS are kept: 79 'x' plus the whole emoji as ONE code point",
  );
  assertEquals(
    recoveredTitle.length,
    81,
    "the UTF-16 length is 81 — the emoji still costs 2 code units, but both stay paired",
  );
  assertEquals(
    Array.from(recoveredTitle).at(-1),
    astral,
    "the emoji survives whole — no lone/unpaired surrogate",
  );
});

// ---------------------------------------------------------------------------
// getMessages resource-name clobber (LB8) — fixed by folding tag into name
// ---------------------------------------------------------------------------

Deno.test("FIXED (juick-latent-bugs LB8): getMessages with BOTH uname and tag — the resource NAME now folds in the tag instead of silently dropping it", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json([])],
    async (calls) => {
      await run("getMessages", { uname: "alice", tag: "music" }, ctx);
      const url = new URL(calls[0].url);
      assertEquals(url.searchParams.get("uname"), "alice");
      assertEquals(url.searchParams.get("tag"), "music");
    },
  );
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(
    res.name,
    "feed_alice_tag_music",
    "the resource NAME now encodes both uname and tag, matching the query",
  );
});

Deno.test("FIXED (juick-latent-bugs LB8): two DIFFERENT tag-scoped feeds for the SAME uname now resolve to DIFFERENT resource names — no more clobber", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json([])], async () => {
    await run("getMessages", { uname: "alice", tag: "music" }, ctx);
    await run("getMessages", { uname: "alice", tag: "sports" }, ctx);
  });
  const names = written.filter((w) => w.spec === "messages").map((w) => w.name);
  assertEquals(
    names,
    ["feed_alice_tag_music", "feed_alice_tag_sports"],
    "the two tag-scoped feeds now write to DISTINCT resource names",
  );
  assert(
    names[0] !== names[1],
    "the two names must differ — this is the fix for the clobber",
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — reframed: juick has NO credentials (only a public
// apiUrl), so the scan targets real-email/high-entropy/bearer patterns
// (musicbrainz/porkbun reframing precedent) rather than a vendor key shape.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "email NOT on the RFC 2606 example.com/example.org domain",
    re:
      /[a-zA-Z0-9._%+-]+@(?!example\.(?:com|org)\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  },
  {
    name:
      "high-entropy token-shaped value (32+ alnum/base64url, no separators)",
    re: /^[A-Za-z0-9+/_=-]{32,}$/,
  },
  { name: "bearer/authorization keyword", re: /\b(bearer|authorization)\b/i },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "messages.json": messages,
  "thread.json": thread,
  "user.json": user,
  "userposts-page1.json": userpostsPage1,
  "userposts-page2.json": userpostsPage2,
  "error-500.json": error500,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a real-email, high-entropy, or bearer-keyword string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected real-email and high-entropy shape", () => {
  const violations: string[] = [];
  const poisoned = {
    contact: "real.person@gmail.com",
    token: "aGVsbG93b3JsZHRoaXNpc2FmYWtldG9rZW5zaGFwZQ==",
  };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(violations.length > 0, "sanity check: scanner must flag both shapes");
});
