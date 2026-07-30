/**
 * Adversarial suite: SSRF via `apiUrl` (no host allowlist — syntax-only
 * validation), YAML-frontmatter injection via raw `uname`/`tags`
 * interpolation in the Obsidian builder, the unbounded `while(true)`
 * pagination loop's missing-mid refetch-page-1 defect (bounded, terminating
 * stub), three DISTINCT non-array/malformed-response failure shapes across
 * getMessages/getThread/getUser (round-2 review finding — do not conflate
 * them), a dedicated getUser empty-array pin, unguarded `JSON.parse` on a
 * non-JSON 200 body, no AbortSignal/timeout anywhere, Retry-After ignored,
 * a unicode astral-plane title-slice split, the getMessages resource-name
 * clobber when both uname and tag are given, and a mechanical
 * fixtures-secret-scan (reframed — juick has no credentials, see
 * fixtures/PROVENANCE.md).
 *
 * juick.ts is UNMODIFIED — every test here PINS current behavior (including
 * behavior that is a real, documented gap) rather than proposing a fix. Every
 * pinned gap here is filed under the LOCAL `juick-latent-bugs` model, never
 * fixed in this change. The fetch stub is cast `as unknown as typeof
 * globalThis.fetch` (deno 2.8.3 toolchain pin).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./juick.ts";
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
 * `fetch()` — needed to prove no AbortSignal was ever threaded through,
 * since `new Request(input, init)` always synthesizes an implicit `.signal`
 * even when the caller passed none (musicbrainz-adversarial pattern). */
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
 * source's unbounded `while(true)` pagination loop. Every getUserPosts test
 * in this file MUST use a terminating route like this one — a route that
 * always returns a non-empty batch hangs the test itself (round-1/round-2
 * review finding). */
function singlePage(msgs: Array<Record<string, unknown>>): Route {
  return (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname !== "/messages") return undefined;
    return url.search.includes("before_mid") ? json([]) : json(msgs);
  };
}

// ---------------------------------------------------------------------------
// SSRF — apiUrl has no host allowlist; z.string().url() validates SYNTAX only
// ---------------------------------------------------------------------------

Deno.test("SSRF: an internal/metadata-service apiUrl is fetched VERBATIM — no host allowlist anywhere", async () => {
  const { ctx } = makeCtx({
    apiUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  });
  await withFetchStub(
    [() => json([])],
    async (calls) => {
      await run("getMessages", {}, ctx);
      assertEquals(
        calls[0].url,
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/messages",
        "the exact SSRF target is what gets requested — apiUrl is concatenated raw",
      );
    },
  );
});

Deno.test("SSRF: z.string().url() on the apiUrl global argument validates URL SYNTAX ONLY, not host — an internal address parses cleanly", () => {
  // Documents the single guard's actual reach: GlobalArgsSchema declares
  // `apiUrl: z.string().url()`. This is satisfied by ANY syntactically valid
  // URL, including a loopback or link-local metadata address — there is no
  // host/scheme allowlist layered on top. The network-less default test task
  // (deno.json's `test` has no --allow-net) is the true backstop in CI, not
  // this schema.
  const hostileButSyntacticallyValid = [
    "http://169.254.169.254/",
    "http://localhost:22/",
    "http://[::1]/",
    "http://internal.corp.local/",
  ];
  for (const apiUrl of hostileButSyntacticallyValid) {
    const parsed = model.globalArguments.parse({ apiUrl }) as {
      apiUrl: string;
    };
    assertEquals(
      parsed.apiUrl,
      apiUrl,
      `${apiUrl} must parse cleanly — z.string().url() has no host check`,
    );
  }
});

// ---------------------------------------------------------------------------
// YAML-frontmatter injection — raw uname/tags interpolation in the builder
// ---------------------------------------------------------------------------

Deno.test("INJECTION: a hostile uname containing a quote and a newline corrupts the YAML frontmatter's source:/author: lines — only title is escaped", async () => {
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
  assert(
    md.includes(`source: "https://juick.com/${hostileUname}/9001"`),
    "the raw hostile uname is interpolated verbatim into source: — a newline injects a new YAML key",
  );
  assert(
    md.includes(`author: "${hostileUname}"`),
    "the raw hostile uname is interpolated verbatim into author: too",
  );
  assert(
    md.includes("admin: true"),
    "the injected `admin: true` line lands as its own YAML frontmatter key — this is the injection",
  );
});

Deno.test("INJECTION: a hostile tag with a newline and a leading '- ' injects an extra YAML list item under tags:", async () => {
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
  assert(
    md.includes(`  - ${hostileTag}\n`),
    "the tag is only colon-replaced (juick.ts's `tag.replace(/:/g, '-')`) — a raw newline + list-item marker passes straight through and injects an extra YAML list entry",
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
// Unbounded `while (true)` pagination — missing-mid refetches page 1 forever
// ---------------------------------------------------------------------------

Deno.test("pin: a batch whose LAST message has no `mid` makes `beforeMid` undefined, so the NEXT request re-issues the IDENTICAL page-1 query (infinite loop in production — pinned here with a call-counting stub that terminates on the 2nd call)", async () => {
  const { ctx, written } = makeCtx();
  // batch[1] deliberately omits `mid` — MessageSchema is `.passthrough()`, so
  // the wire can send this. `beforeMid = batch[batch.length-1].mid` becomes
  // `undefined`; `if (beforeMid)` is then false, so the SECOND request has NO
  // before_mid at all — an identical query string to the first request. A
  // real server that keeps answering this query loops forever; this stub
  // terminates the test by returning [] on the SECOND matching call.
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
        return baseQueryCalls === 1 ? json(pathologicalBatch) : json([]);
      }
      return undefined;
    }],
    async (calls) => {
      await run(
        "getUserPosts",
        { uname: "missing-mid-victim", withComments: false },
        ctx,
      );
      const baseQueryUrls = calls
        .map((c) => new URL(c.url).search)
        .filter((s) => s === "?uname=missing-mid-victim");
      assertEquals(
        baseQueryUrls.length,
        2,
        "the SAME page-1 query string was requested twice — before_mid never advanced past the missing-mid message",
      );
    },
  );
  assertEquals(baseQueryCalls, 2);
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = (res.payload as { posts: unknown[] }).posts;
  assertEquals(
    posts.length,
    2,
    "both messages from the one successfully-processed batch are kept — only the CURSOR is broken, not the batch itself",
  );
});

Deno.test("pin: a server that always echoes the SAME page (ignores before_mid) also loops the request unbounded — pinned with a call-counting stub", async () => {
  const repeatedBatch = [{ mid: 200, body: "always the same", replies: 0 }];
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [() => {
      calls++;
      return calls <= 2 ? json(repeatedBatch) : json([]);
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
    3,
    "the loop kept requesting (with an ever-advancing before_mid=200 that the fixture server ignores) until the stub finally broke the cycle on the 3rd call",
  );
});

// ---------------------------------------------------------------------------
// Three DISTINCT non-array / malformed-response failure shapes (round-2
// review finding — getMessages/getThread/getUser fail DIFFERENTLY)
// ---------------------------------------------------------------------------

Deno.test("pin (shape 1/3): getMessages — a non-array truthy `data` (object) sails into the `z.array(MessageSchema)` resource schema and FAILS validation (unlike porkbun's z.any(), this actually throws at writeResource in the real runtime)", async () => {
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
    { unexpected: "object shape", not: "an array" },
    "`data || []` only guards the FALSY case — a truthy non-array object sails through unchanged",
  );
  assertEquals(
    payload.count,
    undefined,
    "`(data || []).length` reads `.length` off a plain object -> undefined",
  );
  const validation = model.resources.messages.schema.safeParse(payload);
  assert(
    !validation.success,
    "the REAL resource schema (z.array(MessageSchema) for `messages`) rejects this payload — writeResource would throw in the real swamp runtime, unlike the fake test context above which just records it",
  );
});

Deno.test("pin (shape 2/3): getThread — a non-array truthy `data` (object) throws a TypeError from `items.slice(1)` BEFORE any resource is written", async () => {
  const { ctx, written } = makeCtx();
  let threw: unknown;
  await withFetchStub(
    [() => json({ unexpected: "object", not: "an array" })],
    async () => {
      try {
        await run("getThread", { mid: 1 }, ctx);
      } catch (err) {
        threw = err;
      }
    },
  );
  assert(
    threw instanceof TypeError,
    "items.slice is not a function on a plain object",
  );
  assertEquals(
    written.find((w) => w.spec === "thread"),
    undefined,
    "no resource is written — the TypeError happens before writeResource is ever called",
  );
});

Deno.test("pin (shape 3/3): getUser — a non-array truthy `data` (object) is passed through AS-IS (not data[0]) and would fail UserSchema if it lacks uid/uname", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ error: "not a user, not an array" })],
    async () => {
      await run("getUser", { uname: "x" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userProfile")!;
  assertEquals(
    res.payload,
    { error: "not a user, not an array" },
    "Array.isArray(data) is false for a plain object -> `user = data`, passed through unchanged",
  );
  const validation = model.resources.userProfile.schema.safeParse(res.payload);
  assert(
    !validation.success,
    "UserSchema requires uid (number) and uname (string) — this hostile shape fails validation",
  );
});

Deno.test("pin: getUser on an EMPTY array `[]` — data[0] is undefined, a DISTINCT trigger from the non-array shapes above", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json([])],
    async () => {
      await run("getUser", { uname: "ghost" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userProfile")!;
  assertEquals(
    res.payload,
    undefined,
    "Array.isArray([]) is true -> data[0] on an empty array is undefined",
  );
  const validation = model.resources.userProfile.schema.safeParse(res.payload);
  assert(
    !validation.success,
    'writeResource("userProfile", ..., undefined) fails UserSchema\'s required fields',
  );
});

// ---------------------------------------------------------------------------
// Unguarded JSON.parse — a non-JSON 200 body throws a bare SyntaxError
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON 200 response body (e.g. an HTML error page from a misconfigured proxy) surfaces as an unmapped SyntaxError", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html><body>502 via reverse proxy</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      let threw: unknown;
      try {
        await run("getMessages", {}, ctx);
      } catch (err) {
        threw = err;
      }
      assert(
        threw instanceof SyntaxError,
        "juickApi's `JSON.parse(text)` has no try/catch — this is NOT mapped to a Juick-domain error",
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
// No AbortSignal/timeout anywhere; Retry-After is never read
// ---------------------------------------------------------------------------

Deno.test("pin: no method ever passes an AbortSignal to fetch — a hung api.juick.com endpoint would hang the call forever", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json([])],
    async (_calls, rawCalls) => {
      await run("getMessages", {}, ctx);
      assertEquals(rawCalls.length, 1);
      assertEquals(
        rawCalls[0].init,
        undefined,
        "juickApi calls `fetch(url)` with no second argument at all — no signal, no headers, nothing",
      );
    },
  );
});

Deno.test("pin: a 503 WITH a Retry-After header still throws immediately — the header is never read, and no retry is attempted", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("service unavailable", {
        status: 503,
        headers: { "Retry-After": "120" },
      })],
    async (calls) => {
      let threw: unknown;
      try {
        await run("getMessages", {}, ctx);
      } catch (err) {
        threw = err;
      }
      assert(threw instanceof Error);
      assert((threw as Error).message.includes("503"));
      assertEquals(
        calls.length,
        1,
        "no retry was attempted despite Retry-After",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Unicode astral-plane split in the title slice
// ---------------------------------------------------------------------------

Deno.test("pin: a title whose 80th UTF-16 code unit lands inside an astral surrogate pair leaks a LONE (unpaired) surrogate into both title and obsidianPath", async () => {
  const { ctx, written } = makeCtx();
  // 79 ASCII chars + one astral emoji (2 UTF-16 code units: a high surrogate
  // then a low surrogate). slice(0, 80) keeps the 79 ASCII chars plus ONLY
  // the emoji's high surrogate, splitting the pair.
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
  // title isn't a separate field on the written post object (it's baked into
  // obsidianContent/obsidianPath) — recover it from obsidianPath, which is
  // `${folder}/${date ? date + " " : ""}${title}` with no date here (the
  // fixture message carries no timestamp).
  const recoveredTitle = posts[0].obsidianPath.slice("juick/".length);
  assertEquals(recoveredTitle.length, 80);
  const lastCharCode = recoveredTitle.charCodeAt(79);
  assert(
    lastCharCode >= 0xd800 && lastCharCode <= 0xdbff,
    `expected a lone HIGH surrogate at position 79 (got 0x${
      lastCharCode.toString(16)
    }) — slice(0,80) split the astral pair`,
  );
});

// ---------------------------------------------------------------------------
// getMessages resource-name clobber — tag is silently dropped from the NAME
// when uname is also present (though the query itself includes both)
// ---------------------------------------------------------------------------

Deno.test("pin: getMessages with BOTH uname and tag — the query includes both params, but the written resource NAME uses only uname (tag is dropped from the name)", async () => {
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
    "feed_alice",
    "the resource NAME collapses to feed_<uname>, silently ignoring tag — two different tag-scoped feeds for the same uname would clobber each other's persisted resource",
  );
});

Deno.test("pin: two DIFFERENT tag-scoped feeds for the SAME uname both resolve to the IDENTICAL resource name — the actual clobber mechanism", async () => {
  // In the real swamp runtime, writeResource is keyed on instance name (per
  // the memory note: "context.readResource(name) is keyed on instance name
  // ONLY, not per-spec"), so a SECOND call with the same computed name
  // overwrites the first call's persisted resource. Our fake context here
  // just appends to an array (it doesn't simulate that overwrite), so this
  // test proves the actual clobbering MECHANISM — both calls compute the
  // same name — the same technique porkbun's own "create's writeResource
  // uses the SAME fixed resource name" pin uses for an analogous defect.
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json([])], async () => {
    await run("getMessages", { uname: "alice", tag: "music" }, ctx);
    await run("getMessages", { uname: "alice", tag: "sports" }, ctx);
  });
  const names = written.filter((w) => w.spec === "messages").map((w) => w.name);
  assertEquals(
    names,
    ["feed_alice", "feed_alice"],
    "both the music-tagged and sports-tagged feed queries write the IDENTICAL resource name — the second call clobbers the first in a real persisted instance",
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
