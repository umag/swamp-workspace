/**
 * Contract-fixture suite: pins the CONCRETE api.juick.com wire shape from
 * juick/fixtures/*.json directly — independent of juick.ts's resource
 * schemas, which use `.passthrough()` throughout (MessageSchema, ReplySchema,
 * UserSchema). A suite that only asserted "the written resource validates
 * against the model's schema" would be toothless (passthrough accepts extra
 * fields and never rejects a drift); this suite hardcodes the expected
 * keyset + value types from the documented shape so a real wire-format drift
 * turns a test red (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made. The fetch stub is cast `as unknown as typeof
 * globalThis.fetch` (deno 2.8.3 toolchain pin — a bare `as typeof
 * globalThis.fetch` is rejected under this toolchain).
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

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
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

/** Single-route stub matching on the request's search string. */
function bySearch(routes: Record<string, unknown>) {
  return (req: Request) => {
    const search = new URL(req.url).search;
    for (const [match, body] of Object.entries(routes)) {
      if (search === match) return json(body);
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// messages.json contract — via getMessages
// ---------------------------------------------------------------------------

Deno.test("contract: messages.json[0] — FULL optional-field message (photo+tags+updated) keeps the documented keyset and wire types", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(messages)],
    async () => {
      await run("getMessages", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "messages")!;
  const msg = (res.payload.messages as Array<Record<string, unknown>>)[0];
  assertEquals(
    Object.keys(msg).sort(),
    [
      "body",
      "likes",
      "mid",
      "photo",
      "replies",
      "tags",
      "timestamp",
      "updated",
      "user",
    ],
  );
  assertEquals(typeof msg.mid, "number");
  assertEquals(typeof msg.body, "string");
  assertEquals(typeof msg.timestamp, "string");
  assertEquals(typeof msg.likes, "number");
  assertEquals(typeof msg.replies, "number");
  assert(Array.isArray(msg.tags));
  const user = msg.user as Record<string, unknown>;
  assertEquals(typeof user.uid, "number");
  assertEquals(typeof user.uname, "string");
  const photo = msg.photo as Record<string, unknown>;
  assertEquals(typeof photo.medium, "string");
  assertEquals(typeof photo.small, "string");
  assertEquals(typeof photo.thumbnail, "string");
});

Deno.test("contract: messages.json[1] — MINIMAL message (no tags/photo/updated/attach) keeps the documented keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(messages)],
    async () => {
      await run("getMessages", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "messages")!;
  const msg = (res.payload.messages as Array<Record<string, unknown>>)[1];
  assertEquals(
    Object.keys(msg).sort(),
    ["body", "likes", "mid", "replies", "timestamp", "user"],
  );
  assertEquals(msg.likes, 0);
  assertEquals(msg.replies, 0);
});

Deno.test("contract: messages.json — count equals the fixture length and query is empty for an unfiltered feed", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(messages)],
    async () => {
      await run("getMessages", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.payload.count, messages.length);
  assertEquals(res.payload.query, "");
});

// ---------------------------------------------------------------------------
// thread.json contract — via getThread
// ---------------------------------------------------------------------------

Deno.test("contract: thread.json — post is items[0] (no rid); replies carry rid, optional replyQuote", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(thread)],
    async () => {
      await run("getThread", { mid: 4002001 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "thread")!;
  const post = res.payload.post as Record<string, unknown>;
  const comments = res.payload.comments as Array<Record<string, unknown>>;
  assertEquals(post.mid, 4002001);
  assert(!("rid" in post), "the root post has no rid field");
  assertEquals(comments.length, 2);
  assertEquals(comments[0].rid, 1);
  assertEquals(comments[0].replyQuote, thread[1].replyQuote);
  assertEquals(comments[1].rid, 2);
  assert(
    !("replyQuote" in comments[1]),
    "the second reply has no replyQuote in the fixture",
  );
  for (const c of comments) {
    assertEquals(typeof c.mid, "number");
    assertEquals(typeof (c.user as Record<string, unknown>).uname, "string");
  }
});

// ---------------------------------------------------------------------------
// user.json contract — via getUser (array-wrapped single-user response)
// ---------------------------------------------------------------------------

Deno.test("contract: user.json — array-wrapped single user is unwrapped to the bare object with documented field types", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(user)],
    async () => {
      await run("getUser", { uname: "fixture-profile-user" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userProfile")!;
  assertEquals(res.payload.uid, user[0].uid);
  assertEquals(res.payload.uname, user[0].uname);
  assertEquals(res.payload.fullname, user[0].fullname);
  assertEquals(res.payload.avatar, user[0].avatar);
  assertEquals(typeof res.payload.uid, "number");
  assertEquals(typeof res.payload.uname, "string");
});

// ---------------------------------------------------------------------------
// userposts-page{1,2}.json contract — via getUserPosts (bounded 2-page stub)
// ---------------------------------------------------------------------------

Deno.test("contract: userposts pages — paginates page1 -> page2 -> empty (terminates), preserving every field and renaming wire `replies` to model `replyCount`", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      bySearch({
        "?uname=fixture-userposts-user": userpostsPage1,
        "?uname=fixture-userposts-user&before_mid=4003009": userpostsPage2,
        "?uname=fixture-userposts-user&before_mid=4003008": [],
      }),
    ],
    async (calls) => {
      await run(
        "getUserPosts",
        { uname: "fixture-userposts-user", withComments: false },
        ctx,
      );
      assertEquals(
        calls.length,
        3,
        "page1 + page2 + the terminating empty page",
      );
    },
  );
  const res = written.find((w) => w.spec === "userPosts")!;
  const posts = res.payload.posts as Array<Record<string, unknown>>;
  assertEquals(res.payload.userSlug, "fixture-userposts-user");
  assertEquals(res.payload.count, 3);
  assertEquals(posts.length, 3);
  assertEquals(posts.map((p) => p.mid), [4003010, 4003009, 4003008]);

  // Wire `replies` -> model `replyCount` (contract rename, not a passthrough field)
  assertEquals(posts[0].replyCount, 2, "wire replies:2 becomes replyCount:2");
  assert(
    !("replies" in posts[0]),
    "the built post object has no `replies` key",
  );

  // photo.medium -> imageUrl derivation
  assertEquals(posts[0].imageUrl, "https://i.juick.com/photos-4003010-M.jpg");
  // attach (no photo) -> synthesized juick.com CDN URL
  assertEquals(posts[1].imageUrl, "https://juick.com/i/p/4003009.jpg");
  // neither photo nor attach -> imageUrl stays undefined
  assert(!("imageUrl" in posts[2]) || posts[2].imageUrl === undefined);

  assertEquals(posts[0].tags, ["diary"]);
  assertEquals(posts[1].tags, []);
  assertEquals(typeof posts[0].obsidianContent, "string");
  assertEquals(typeof posts[0].obsidianPath, "string");
});

// ---------------------------------------------------------------------------
// error-500.json contract — non-2xx surfaces status + truncated body text
// ---------------------------------------------------------------------------

Deno.test("contract: error-500.json — a non-ok response throws with the status code and the body text verbatim", async () => {
  const { ctx } = makeCtx();
  const bodyText = JSON.stringify(error500);
  await withFetchStub(
    [() =>
      new Response(bodyText, {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })],
    async () => {
      let threw: unknown;
      try {
        await run("getMessages", {}, ctx);
      } catch (err) {
        threw = err;
      }
      assert(threw instanceof Error);
      assert((threw as Error).message.includes("500"));
      assert(
        (threw as Error).message.includes(bodyText.slice(0, 500)),
        "the (truncated) response body text is included verbatim in the error message",
      );
    },
  );
});
