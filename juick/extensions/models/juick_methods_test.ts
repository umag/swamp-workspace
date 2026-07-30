/**
 * Method-level tests for @magistr/juick — every one of the 4 methods
 * (getMessages, getThread, getUser, getUserPosts), happy path + error path,
 * driven through `model.methods.<m>.arguments.parse()` + `.execute()` against
 * a stubbed `globalThis.fetch` and a fake context.
 *
 * juick.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * The fetch stub is cast `as unknown as typeof globalThis.fetch` (deno 2.8.3
 * toolchain pin — a bare `as typeof globalThis.fetch` is rejected here).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./juick.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { apiUrl: "https://api.juick.com" };

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warn"; args: unknown[] };

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
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warn: (...args: unknown[]) => {
          logs.push({ level: "warn", args });
        },
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

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
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

/** Single-route stub returning the same body/status to every call. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

/** Route by exact query-string match — used for the pagination methods. */
function bySearch(routes: Record<string, unknown>): Route {
  return (req: Request) => {
    const search = new URL(req.url).search;
    if (search in routes) return json(routes[search]);
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

Deno.test("getMessages: no filters — GETs /messages with no query string, writes feed_all", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{ mid: 1, user: { uid: 1, uname: "a" } }];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("getMessages", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/messages");
    assertEquals(url.search, "");
  });
  const res = written.find((w) => w.spec === "messages");
  assert(res);
  assertEquals(res.name, "feed_all");
  assertEquals(res.payload.messages, fixture);
  assertEquals(res.payload.count, 1);
  assertEquals(res.payload.query, "");
});

Deno.test("getMessages: uname filter — GETs /messages?uname=X, writes feed_<uname>", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("getMessages", { uname: "some-user" }, ctx);
    assertEquals(new URL(calls[0].url).search, "?uname=some-user");
  });
  const res = written.find((w) => w.spec === "messages");
  assert(res);
  assertEquals(res.name, "feed_some-user");
});

Deno.test("getMessages: tag filter — GETs /messages?tag=X, writes feed_<tag>", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("getMessages", { tag: "music" }, ctx);
    assertEquals(new URL(calls[0].url).search, "?tag=music");
  });
  const res = written.find((w) => w.spec === "messages");
  assert(res);
  assertEquals(res.name, "feed_music");
});

Deno.test("getMessages: search + popular — both params appear in the query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run(
      "getMessages",
      { search: "swamp", popular: true },
      ctx,
    );
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("search"), "swamp");
    assertEquals(url.searchParams.get("popular"), "1");
  });
});

Deno.test("getMessages: popular=false is NOT sent as a query param (guard is truthy `if(args.popular)`)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("getMessages", { popular: false }, ctx);
    assertEquals(new URL(calls[0].url).search, "");
  });
});

Deno.test("getMessages: error path — non-ok response throws with status + body text", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => new Response("server exploded", { status: 503 })],
    async () => {
      await assertRejects(
        () => run("getMessages", {}, ctx),
        Error,
        "503",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// getThread
// ---------------------------------------------------------------------------

Deno.test("getThread: happy path — GETs /thread?mid=<mid>, splits post (items[0]) from comments (items.slice(1))", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [
    { mid: 500, body: "root", user: { uid: 1, uname: "author" } },
    { mid: 500, rid: 1, body: "reply one", user: { uid: 2, uname: "r1" } },
    { mid: 500, rid: 2, body: "reply two", user: { uid: 3, uname: "r2" } },
  ];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("getThread", { mid: 500 }, ctx);
    assertEquals(new URL(calls[0].url).search, "?mid=500");
  });
  const res = written.find((w) => w.spec === "thread");
  assert(res);
  assertEquals(res.name, "thread_500");
  assertEquals(res.payload.mid, 500);
  assertEquals(res.payload.post, fixture[0]);
  assertEquals(res.payload.comments, [fixture[1], fixture[2]]);
});

Deno.test("getThread: a thread with no replies — comments is an empty array", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{
    mid: 501,
    body: "lonely root",
    user: { uid: 1, uname: "a" },
  }];
  await withOneResponse(fixture, 200, async () => {
    await run("getThread", { mid: 501 }, ctx);
  });
  const res = written.find((w) => w.spec === "thread")!;
  assertEquals(res.payload.comments, []);
});

Deno.test("getThread: error path — non-ok response throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("not found", 404, async () => {
    await assertRejects(
      () => run("getThread", { mid: 999 }, ctx),
      Error,
      "404",
    );
  });
});

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

Deno.test("getUser: happy path — array-wrapped response is unwrapped to data[0], writes user_<uname>", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{ uid: 42, uname: "someone", fullname: "Some One" }];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("getUser", { uname: "someone" }, ctx);
    assertEquals(new URL(calls[0].url).search, "?uname=someone");
  });
  const res = written.find((w) => w.spec === "userProfile");
  assert(res);
  assertEquals(res.name, "user_someone");
  assertEquals(res.payload, fixture[0]);
});

Deno.test("getUser: uname is URL-encoded in the query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([{ uid: 1, uname: "a b" }], 200, async (calls) => {
    await run("getUser", { uname: "a b" }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("uname"), "a b");
    assert(calls[0].url.includes("a%20b") || calls[0].url.includes("a+b"));
  });
});

Deno.test("getUser: error path — non-ok response throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("nope", 500, async () => {
    await assertRejects(
      () => run("getUser", { uname: "x" }, ctx),
      Error,
      "500",
    );
  });
});

// ---------------------------------------------------------------------------
// getUserPosts
// ---------------------------------------------------------------------------

const POST_NO_REPLIES = {
  mid: 7001,
  body: "Post with no replies, no tags, no photo.",
  timestamp: "2026-05-01 10:00:00",
  likes: 0,
  replies: 0,
};

const POST_WITH_REPLIES = {
  mid: 7002,
  body: "Post with replies and a photo.",
  timestamp: "2026-05-02 11:00:00",
  tags: ["life"],
  likes: 3,
  replies: 1,
  photo: { medium: "https://i.juick.com/photos-7002-M.jpg" },
};

const THREAD_FOR_7002 = [
  { mid: 7002, body: "root", user: { uid: 1, uname: "author" } },
  {
    mid: 7002,
    rid: 1,
    body: "a comment",
    user: { uid: 9, uname: "commenter" },
    timestamp: "2026-05-02 12:00:00",
  },
];

Deno.test("getUserPosts: single page, withComments default true — fetches the thread for a post with replies > 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/messages" && !url.search.includes("before_mid")
        ) {
          return json([POST_WITH_REPLIES]);
        }
        if (url.pathname === "/messages") return json([]); // terminate
        if (url.pathname === "/thread") return json(THREAD_FOR_7002);
        return undefined;
      },
    ],
    async (calls) => {
      await run("getUserPosts", { uname: "author" }, ctx);
      const threadCalls = calls.filter((c) =>
        new URL(c.url).pathname === "/thread"
      );
      assertEquals(threadCalls.length, 1);
      assertEquals(new URL(threadCalls[0].url).search, "?mid=7002");
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assertEquals(posts.length, 1);
  assertEquals(posts[0].replyCount, 1);
  assertEquals((posts[0].comments as unknown[]).length, 1);
  assertEquals(res.payload.userSlug, "author");
  assertEquals(res.payload.count, 1);
});

Deno.test("getUserPosts: withComments=false — never fetches a thread even when replies > 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/messages" && !url.search.includes("before_mid")
        ) {
          return json([POST_WITH_REPLIES]);
        }
        if (url.pathname === "/messages") return json([]);
        return undefined; // any /thread request is unrouted -> would throw
      },
    ],
    async () => {
      await run(
        "getUserPosts",
        { uname: "author", withComments: false },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assertEquals((posts[0].comments as unknown[]).length, 0);
});

Deno.test("getUserPosts: default folder is 'juick'; a custom folder is honored in obsidianPath", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/messages" && !url.search.includes("before_mid")
        ) {
          return json([POST_NO_REPLIES]);
        }
        return json([]);
      },
    ],
    async () => {
      await run("getUserPosts", { uname: "author" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assert(
    (posts[0].obsidianPath as string).startsWith("juick/"),
    "default folder is 'juick'",
  );
});

Deno.test("getUserPosts: custom folder argument is used verbatim in obsidianPath", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/messages" && !url.search.includes("before_mid")
        ) {
          return json([POST_NO_REPLIES]);
        }
        return json([]);
      },
    ],
    async () => {
      await run(
        "getUserPosts",
        { uname: "author", folder: "imports/juick" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assert((posts[0].obsidianPath as string).startsWith("imports/juick/"));
});

Deno.test("getUserPosts: multi-page pagination — page1 -> page2 -> empty terminates, posts combined in fetch order", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      bySearch({
        "?uname=paginated-user": [
          {
            mid: 8002,
            body: "newer",
            timestamp: "2026-05-10 10:00:00",
            replies: 0,
          },
        ],
        "?uname=paginated-user&before_mid=8002": [
          {
            mid: 8001,
            body: "older",
            timestamp: "2026-05-09 10:00:00",
            replies: 0,
          },
        ],
        "?uname=paginated-user&before_mid=8001": [],
      }),
    ],
    async (calls) => {
      await run(
        "getUserPosts",
        { uname: "paginated-user", withComments: false },
        ctx,
      );
      assertEquals(calls.length, 3);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assertEquals(posts.map((p) => p.mid), [8002, 8001]);
  assertEquals(res.payload.count, 2);
});

Deno.test("getUserPosts: a thread-fetch failure is swallowed — comments end up empty, a warn is logged, the post is still written", async () => {
  const { ctx, written, logs } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/messages" && !url.search.includes("before_mid")
        ) {
          return json([POST_WITH_REPLIES]);
        }
        if (url.pathname === "/messages") return json([]);
        if (url.pathname === "/thread") {
          return new Response("boom", { status: 500 });
        }
        return undefined;
      },
    ],
    async () => {
      await run("getUserPosts", { uname: "author" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assertEquals((posts[0].comments as unknown[]).length, 0);
  assert(
    logs.some((l) => l.level === "warn"),
    "a warn log is emitted when the per-post thread fetch fails",
  );
});

Deno.test("getUserPosts: zero posts (empty feed) — writes an empty posts array, count 0", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([], 200, async () => {
    await run("getUserPosts", { uname: "nobody" }, ctx);
  });
  const res = written.find((w) => w.spec === "userPosts")!;
  assertEquals(res.payload.posts, []);
  assertEquals(res.payload.count, 0);
});
