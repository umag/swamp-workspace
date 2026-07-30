/**
 * Coverage suite: sweeps every guard/branch in juick.ts that the methods and
 * adversarial suites don't already exercise on BOTH sides, so deleting any
 * one of these guards turns a test red (STANDARD.md's coverage role — a
 * behavioral regression guard, not a numeric percentage).
 *
 * juick.ts is UNMODIFIED; every test PINS existing behavior. The fetch stub
 * is cast `as unknown as typeof globalThis.fetch` (deno 2.8.3 toolchain pin).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./juick.ts";

const GLOBAL_ARGS = { apiUrl: "https://api.juick.com" };

type Written = { spec: string; name: string; payload: Record<string, unknown> };

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

type Route = (req: Request) => Response | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = route(req);
      if (res) return res;
    }
    throw new Error(`unrouted ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
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

/** Runs getUserPosts against a single page of `msgs`, then an empty page to
 * terminate. Returns the built `posts` array. */
async function buildPosts(
  msgs: Array<Record<string, unknown>>,
  extraArgs: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (!url.search.includes("before_mid")) return json(msgs);
      return json([]);
    }],
    async () => {
      await run("getUserPosts", { uname: "cov-user", ...extraArgs }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  return res.payload.posts as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Guard: `data || []` — getMessages, both sides
// ---------------------------------------------------------------------------

Deno.test("getMessages: data is null (empty 200 body) -> [] and count 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => new Response("", { status: 200 })], async () => {
    await run("getMessages", {}, ctx);
  });
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.payload.messages, []);
  assertEquals(res.payload.count, 0);
});

Deno.test("getMessages: data is a non-empty array -> passed through, count matches length", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [
    { mid: 1, user: { uid: 1, uname: "a" } },
    { mid: 2, user: { uid: 2, uname: "b" } },
  ];
  await withFetchStub([() => json(fixture)], async () => {
    await run("getMessages", {}, ctx);
  });
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.payload.messages, fixture);
  assertEquals(res.payload.count, 2);
});

// ---------------------------------------------------------------------------
// Guard: `items = data || []` — getThread, both sides
// ---------------------------------------------------------------------------

Deno.test("getThread: data is null (empty 200 body) -> post {} and comments []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => new Response("", { status: 200 })], async () => {
    await run("getThread", { mid: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "thread")!;
  assertEquals(res.payload.post, {});
  assertEquals(res.payload.comments, []);
});

// ---------------------------------------------------------------------------
// Guard: getUser's `Array.isArray(data) ? data[0] : data` — both sides, valid
// (non-hostile) shapes — contrast with the adversarial suite's HOSTILE cases
// ---------------------------------------------------------------------------

Deno.test("getUser: array response -> unwrapped to data[0]", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json([{ uid: 1, uname: "arr-user" }])],
    async () => {
      await run("getUser", { uname: "arr-user" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userProfile")!;
  assertEquals(res.payload, { uid: 1, uname: "arr-user" });
});

Deno.test("getUser: bare-object (non-array) response -> passed through as-is", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ uid: 2, uname: "bare-object-user" })],
    async () => {
      await run("getUser", { uname: "bare-object-user" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userProfile")!;
  assertEquals(res.payload, { uid: 2, uname: "bare-object-user" });
});

// ---------------------------------------------------------------------------
// Guards: `body||"" tags||[] likes||0 replies||0` (getUserPosts field extraction)
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: body/tags/likes/replies ABSENT -> defaulted to ''/[]/0/0", async () => {
  const posts = await buildPosts([{ mid: 1 }], { withComments: false });
  assertEquals(posts[0].body, "");
  assertEquals(posts[0].tags, []);
  assertEquals(posts[0].likes, 0);
  assertEquals(posts[0].replyCount, 0);
});

Deno.test("getUserPosts: body/tags/likes/replies PRESENT -> passed through", async () => {
  const posts = await buildPosts(
    [{ mid: 1, body: "hello", tags: ["a", "b"], likes: 7, replies: 0 }],
    { withComments: false },
  );
  assertEquals(posts[0].body, "hello");
  assertEquals(posts[0].tags, ["a", "b"]);
  assertEquals(posts[0].likes, 7);
});

// ---------------------------------------------------------------------------
// Guard: imageUrl derivation — photo.medium takes PRECEDENCE over attach;
// attach alone synthesizes a URL; neither leaves imageUrl undefined
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: photo.medium PRESENT (attach also present) -> photo.medium wins", async () => {
  const posts = await buildPosts([{
    mid: 1,
    photo: { medium: "https://i.juick.com/photos-1-M.jpg" },
    attach: "png",
    replies: 0,
  }], { withComments: false });
  assertEquals(posts[0].imageUrl, "https://i.juick.com/photos-1-M.jpg");
});

Deno.test("getUserPosts: attach ONLY (no photo) -> synthesized juick.com CDN URL", async () => {
  const posts = await buildPosts(
    [{ mid: 2, attach: "png", replies: 0 }],
    { withComments: false },
  );
  assertEquals(posts[0].imageUrl, "https://juick.com/i/p/2.png");
});

Deno.test("getUserPosts: neither photo nor attach -> imageUrl stays undefined", async () => {
  const posts = await buildPosts([{ mid: 3, replies: 0 }], {
    withComments: false,
  });
  assertEquals(posts[0].imageUrl, undefined);
});

Deno.test("getUserPosts: attach is an empty string (falsy, present key) -> same as absent, imageUrl undefined", async () => {
  const posts = await buildPosts([{ mid: 4, attach: "", replies: 0 }], {
    withComments: false,
  });
  assertEquals(posts[0].imageUrl, undefined);
});

// ---------------------------------------------------------------------------
// Guard: `withComments && replyCount > 0` — all four combinations
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: withComments=true, replies=0 -> no thread fetch, comments []", async () => {
  const posts = await buildPosts([{ mid: 1, replies: 0 }], {
    withComments: true,
  });
  assertEquals(posts[0].comments, []);
});

Deno.test("getUserPosts: withComments=false, replies>0 -> no thread fetch, comments []", async () => {
  const posts = await buildPosts([{ mid: 1, replies: 3 }], {
    withComments: false,
  });
  assertEquals(posts[0].comments, []);
});

Deno.test("getUserPosts: withComments=true, replies>0 -> thread IS fetched, comments populated", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/messages" && !url.search.includes("before_mid")) {
        return json([{ mid: 1, replies: 1 }]);
      }
      if (url.pathname === "/messages") return json([]);
      if (url.pathname === "/thread") {
        return json([
          { mid: 1, body: "root", user: { uid: 1, uname: "a" } },
          { mid: 1, rid: 1, body: "a reply", user: { uid: 2, uname: "b" } },
        ]);
      }
      return undefined;
    }],
    async () => {
      await run("getUserPosts", { uname: "cov-user" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assertEquals((posts[0].comments as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// Guard: `date ? timestamp.split(" ")[0] : ""` — both sides
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: timestamp PRESENT -> date is the date portion (before the space)", async () => {
  const posts = await buildPosts(
    [{ mid: 1, timestamp: "2026-06-15 08:00:00", replies: 0 }],
    { withComments: false },
  );
  assert(
    (posts[0].obsidianPath as string).startsWith("juick/2026-06-15 "),
    "obsidianPath is prefixed with the derived date when timestamp is present",
  );
});

Deno.test("getUserPosts: timestamp ABSENT -> date is '', no date prefix in obsidianPath", async () => {
  const posts = await buildPosts([{ mid: 1, replies: 0 }], {
    withComments: false,
  });
  assert(
    !(posts[0].obsidianPath as string).match(/^juick\/\d{4}-\d{2}-\d{2} /),
    "no date prefix when timestamp is absent",
  );
});

// ---------------------------------------------------------------------------
// Guard: tags empty vs present frontmatter branch — BOTH branches emit the
// identical base line; the if-branch only ADDS per-tag lines on top
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: tags=[] -> frontmatter has ONLY the base 'tags:\\n  - juick\\n' line", async () => {
  const posts = await buildPosts([{ mid: 1, tags: [], replies: 0 }], {
    withComments: false,
  });
  const md = posts[0].obsidianContent as string;
  assert(md.includes("tags:\n  - juick\n"));
  // No additional list items beyond the base "juick" tag.
  const tagsBlock = md.split("tags:\n")[1].split("---")[0];
  assertEquals(tagsBlock, "  - juick\n");
});

Deno.test("getUserPosts: tags=['a','b'] -> frontmatter ADDS each tag as its own list item after the base line", async () => {
  const posts = await buildPosts([{ mid: 1, tags: ["a", "b"], replies: 0 }], {
    withComments: false,
  });
  const md = posts[0].obsidianContent as string;
  assert(md.includes("tags:\n  - juick\n  - a\n  - b\n"));
});

// ---------------------------------------------------------------------------
// Guard: title fallback to `juick-${mid}` when the normalized title is empty
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: body is only whitespace -> title normalizes to empty, falls back to juick-<mid>", async () => {
  const posts = await buildPosts([{ mid: 12345, body: "   ", replies: 0 }], {
    withComments: false,
  });
  assert(
    (posts[0].obsidianPath as string).endsWith("juick-12345"),
    "empty-after-normalization title falls back to juick-<mid>",
  );
});

Deno.test("getUserPosts: body is a normal sentence -> title is NOT the juick-<mid> fallback", async () => {
  const posts = await buildPosts(
    [{ mid: 1, body: "A perfectly normal title.", replies: 0 }],
    { withComments: false },
  );
  assert(!(posts[0].obsidianPath as string).includes("juick-1"));
});

// ---------------------------------------------------------------------------
// Guard: comment rendering — cUser Anonymous fallback, cDate, replyQuote
// ---------------------------------------------------------------------------

Deno.test("getUserPosts comments: a reply with a user.uname is attributed by name; a reply with no user falls back to 'Anonymous'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/messages" && !url.search.includes("before_mid")) {
        return json([{ mid: 1, replies: 2 }]);
      }
      if (url.pathname === "/messages") return json([]);
      if (url.pathname === "/thread") {
        return json([
          { mid: 1, body: "root", user: { uid: 1, uname: "author" } },
          {
            mid: 1,
            rid: 1,
            body: "named reply",
            user: { uid: 2, uname: "named-replier" },
            timestamp: "2026-06-20 10:00:00",
            replyQuote: "quoted text",
          },
          { mid: 1, rid: 2, body: "anonymous reply", user: {} },
        ]);
      }
      return undefined;
    }],
    async () => {
      await run("getUserPosts", { uname: "cov-user" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  const md = posts[0].obsidianContent as string;
  assert(md.includes("### named-replier — 2026-06-20"));
  assert(md.includes("> quoted text"));
  assert(md.includes("### Anonymous"));
});

// ---------------------------------------------------------------------------
// Guard: apiUrl trailing-slash stripping
// ---------------------------------------------------------------------------

Deno.test("getMessages: apiUrl WITH a trailing slash produces the identical request URL as without", async () => {
  const withSlash = makeCtx({ apiUrl: "https://api.juick.com/" });
  const withoutSlash = makeCtx({ apiUrl: "https://api.juick.com" });
  let urlA = "";
  let urlB = "";
  await withFetchStub([(req) => {
    urlA = req.url;
    return json([]);
  }], async () => {
    await run("getMessages", {}, withSlash.ctx);
  });
  await withFetchStub([(req) => {
    urlB = req.url;
    return json([]);
  }], async () => {
    await run("getMessages", {}, withoutSlash.ctx);
  });
  assertEquals(urlA, urlB);
  assertEquals(urlA, "https://api.juick.com/messages");
});

Deno.test("getUserPosts: apiUrl WITH a trailing slash produces the identical request URL as without (double-strip: getUserPosts strips first, juickApi strips again — a harmless no-op)", async () => {
  const withSlash = makeCtx({ apiUrl: "https://api.juick.com/" });
  const withoutSlash = makeCtx({ apiUrl: "https://api.juick.com" });
  let urlA = "";
  let urlB = "";
  await withFetchStub([(req) => {
    urlA = req.url;
    return json([]);
  }], async () => {
    await run("getUserPosts", { uname: "x" }, withSlash.ctx);
  });
  await withFetchStub([(req) => {
    urlB = req.url;
    return json([]);
  }], async () => {
    await run("getUserPosts", { uname: "x" }, withoutSlash.ctx);
  });
  assertEquals(urlA, urlB);
  assertEquals(urlA, "https://api.juick.com/messages?uname=x");
});

// ---------------------------------------------------------------------------
// Guard: folder default value
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: folder defaults to 'juick' when omitted", async () => {
  const posts = await buildPosts([{ mid: 1, replies: 0 }]);
  assert((posts[0].obsidianPath as string).startsWith("juick/"));
});

// ---------------------------------------------------------------------------
// Guard: withComments default value (true) when omitted entirely
// ---------------------------------------------------------------------------

Deno.test("getUserPosts: withComments defaults to true — a post with replies fetches its thread even when the arg is omitted", async () => {
  const { ctx, written } = makeCtx();
  let threadFetched = false;
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/messages" && !url.search.includes("before_mid")) {
        return json([{ mid: 1, replies: 1 }]);
      }
      if (url.pathname === "/messages") return json([]);
      if (url.pathname === "/thread") {
        threadFetched = true;
        return json([{ mid: 1, body: "root", user: { uid: 1, uname: "a" } }]);
      }
      return undefined;
    }],
    async () => {
      // withComments deliberately omitted from args
      await run("getUserPosts", { uname: "cov-user" }, ctx);
    },
  );
  assert(
    threadFetched,
    "the default withComments=true triggers the thread fetch",
  );
  assert(written.find((w) => w.spec === "userPosts"));
});
