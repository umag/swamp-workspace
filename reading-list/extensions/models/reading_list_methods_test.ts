/**
 * Method-level tests for @magistr/reading-list. Every network call is
 * intercepted by stubbing `globalThis.fetch`; no test may reach a real feed
 * (the default `deno task test` runs without --allow-net, so a leak fails
 * loudly rather than silently hitting the internet).
 *
 * Invariants under test:
 *  - `fetch` writes one `feed` resource per configured source plus one merged
 *    `digest`, and a failing source is recorded rather than aborting the run
 *  - `firstSeenAt` is carried forward per URL, so re-running does not churn it
 *    and only genuinely unseen articles are flagged `isNew`
 *  - `latest` rebuilds from stored feeds with no network at all, and `limit`
 *    recomputes the derived counts instead of leaving them stale
 *  - `digestMessage` is a no-op on an empty window, and REFUSES to report a
 *    successful send when the Telegram model returned no resource
 *  - `markRead`/`markUnread` reject an empty selector and an unparseable date,
 *    and `markRead` keeps the EARLIEST read timestamp on a re-mark
 *  - `sources` performs no I/O whatsoever
 *
 * Method arguments are always parsed THROUGH the zod `arguments` schema before
 * execute() — swamp strips any argument the schema omits, so calling execute()
 * directly would hide that entire class of bug.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./reading_list.ts";

type Written = { spec: string; name: string; payload: Record<string, unknown> };

const SOURCES = [
  {
    name: "alpha",
    kind: "rss",
    url: "https://alpha.example/feed.xml",
    author: "Alpha",
    tier: 1,
    enabled: true,
  },
  {
    name: "beta",
    kind: "rss",
    url: "https://beta.example/feed.xml",
    author: "Beta",
    tier: 2,
    enabled: true,
  },
];

function rss(items: Array<{ title: string; link: string; date?: string }>) {
  const body = items
    .map((i) =>
      `<item><title>${i.title}</title><link>${i.link}</link>` +
      (i.date ? `<pubDate>${i.date}</pubDate>` : "") +
      `<description>summary of ${i.title}</description></item>`
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

function makeCtx(
  globalArgs: Record<string, unknown> = { sources: SOURCES },
  store: Record<string, Record<string, unknown>> = {},
) {
  const written: Written[] = [];
  const logs: string[] = [];
  const ranModels: Array<Record<string, unknown>> = [];
  let runModelResult: { resources: Array<{ name: string }> } = {
    resources: [{ name: "msg-1" }],
  };
  const ctx: Record<string, unknown> = {
    globalArgs,
    readResource: (name: string) => Promise.resolve(store[name] ?? null),
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ name });
    },
    runModel: (options: Record<string, unknown>) => {
      ranModels.push(options);
      return Promise.resolve(runModelResult);
    },
    logger: {
      info: (m: string) => logs.push(m),
      warning: (m: string) => logs.push(m),
    },
  };
  return {
    written,
    logs,
    ranModels,
    ctx,
    setRunModelResult(r: { resources: Array<{ name: string }> }) {
      runModelResult = r;
    },
  };
}

/** Mirror the swamp runtime: schema-parse arguments, then execute. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

async function withFetchStub(
  handler: (url: string) => { body?: string; status?: number },
  fn: (urls: string[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    const raw = input instanceof Request ? input.url : String(input);
    urls.push(raw);
    const { body = "", status = 200 } = handler(raw);
    return Promise.resolve(
      new Response(body, {
        status,
        statusText: status === 200 ? "OK" : "Error",
      }),
    );
  }) as typeof globalThis.fetch;
  try {
    await fn(urls);
  } finally {
    globalThis.fetch = original;
  }
}

const feedsOf = (written: Written[]) =>
  written.filter((w) => w.spec === "feed");
const digestOf = (written: Written[]) =>
  written.find((w) => w.spec === "digest")?.payload;

// --- fetch -----------------------------------------------------------------

Deno.test("fetch writes one feed per source plus a merged digest", async () => {
  const { written, ctx } = makeCtx();
  await withFetchStub(
    (url) =>
      url.includes("alpha")
        ? { body: rss([{ title: "A1", link: "https://alpha.example/1" }]) }
        : { body: rss([{ title: "B1", link: "https://beta.example/1" }]) },
    async () => {
      await run("fetch", {}, ctx);
    },
  );

  assertEquals(feedsOf(written).map((w) => w.name), [
    "feed-alpha",
    "feed-beta",
  ]);
  const digest = digestOf(written);
  assertEquals(digest?.sourceCount, 2);
  assertEquals(digest?.okCount, 2);
  assertEquals(digest?.failedCount, 0);
  assertEquals(digest?.totalArticles, 2);
});

Deno.test("fetch records a failing source without aborting the run", async () => {
  const { written, logs, ctx } = makeCtx();
  await withFetchStub(
    (url) =>
      url.includes("alpha")
        ? { body: rss([{ title: "A1", link: "https://alpha.example/1" }]) }
        : { status: 503 },
    async () => {
      await run("fetch", {}, ctx);
    },
  );

  const feeds = feedsOf(written);
  assertEquals(feeds.length, 2, "the failing source still gets a feed record");
  const beta = feeds.find((f) => f.name === "feed-beta")!.payload;
  assertEquals(beta.ok, false);
  assert(String(beta.error).includes("503"), "the HTTP status is preserved");
  assertEquals(beta.articles, []);

  const digest = digestOf(written);
  assertEquals(digest?.okCount, 1);
  assertEquals(digest?.failedCount, 1);
  // `failed[]` carries "<source>: <reason>", not a bare name — the digest is
  // meant to be readable on its own without cross-referencing the feed record.
  assertEquals(digest?.failed, ["beta: HTTP 503 Error"]);
  assert(logs.some((l) => l.includes("failed")), "the failure is logged");
});

Deno.test("fetch carries firstSeenAt forward so a re-run flags nothing new", async () => {
  const seenAt = "2020-01-01T00:00:00.000Z";
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    "feed-alpha": {
      articles: [{ url: "https://alpha.example/1", firstSeenAt: seenAt }],
    },
  });

  await withFetchStub(
    () => ({
      body: rss([
        { title: "A1", link: "https://alpha.example/1" },
        { title: "A2", link: "https://alpha.example/2" },
      ]),
    }),
    async () => {
      await run("fetch", {}, ctx);
    },
  );

  const articles = feedsOf(written)[0].payload.articles as Array<
    { url: string; firstSeenAt: string; isNew: boolean }
  >;
  const first = articles.find((a) => a.url === "https://alpha.example/1")!;
  const second = articles.find((a) => a.url === "https://alpha.example/2")!;
  assertEquals(first.firstSeenAt, seenAt, "the prior timestamp is preserved");
  assertEquals(first.isNew, false);
  assertEquals(second.isNew, true, "the genuinely unseen article is new");
});

Deno.test("fetch rejects a configuration with no enabled sources", async () => {
  const { ctx } = makeCtx({
    sources: [{ ...SOURCES[0], enabled: false }],
  });
  await assertRejects(
    () => run("fetch", {}, ctx) as Promise<unknown>,
    Error,
    "No enabled sources configured",
  );
});

// --- latest ----------------------------------------------------------------

const storedFeed = (over: Record<string, unknown> = {}) => ({
  source: "alpha",
  kind: "rss",
  url: "https://alpha.example/feed.xml",
  tier: 1,
  ok: true,
  fetchedAt: "2026-01-02T00:00:00.000Z",
  count: 2,
  newCount: 1,
  articles: [
    {
      title: "Old",
      url: "https://alpha.example/old",
      source: "alpha",
      tier: 1,
      publishedAt: "2020-01-01T00:00:00.000Z",
      firstSeenAt: "2020-01-01T00:00:00.000Z",
      isNew: false,
    },
    {
      title: "New",
      url: "https://alpha.example/new",
      source: "alpha",
      tier: 1,
      publishedAt: "2026-01-01T00:00:00.000Z",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      isNew: true,
    },
  ],
  ...over,
});

Deno.test("latest rebuilds from stored feeds and touches no network", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    "feed-alpha": storedFeed(),
  });
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("latest must not fetch");
  }) as typeof globalThis.fetch;
  try {
    await run("latest", {}, ctx);
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(digestOf(written)?.totalArticles, 2);
});

Deno.test("latest onlyNew keeps just the freshly seen articles", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    "feed-alpha": storedFeed(),
  });
  await run("latest", { onlyNew: true }, ctx);
  const digest = digestOf(written)!;
  assertEquals(digest.totalArticles, 1);
  assertEquals(
    (digest.articles as Array<{ title: string }>)[0].title,
    "New",
  );
});

Deno.test("latest unreadOnly drops articles in the persisted read set", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    "feed-alpha": storedFeed(),
    "read-state": {
      urls: { "https://alpha.example/old": "2026-01-01T00:00:00.000Z" },
      count: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await run("latest", { unreadOnly: true }, ctx);
  const digest = digestOf(written)!;
  assertEquals(digest.totalArticles, 1);
  assertEquals(
    (digest.articles as Array<{ url: string }>)[0].url,
    "https://alpha.example/new",
  );
});

Deno.test("latest limit recomputes the derived counts, not just the list", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    "feed-alpha": storedFeed(),
  });
  await run("latest", { limit: 1, orderBy: "date" }, ctx);
  const digest = digestOf(written)!;
  assertEquals((digest.articles as unknown[]).length, 1);
  assertEquals(digest.totalArticles, 1, "totalArticles follows the slice");
  assertEquals(digest.newCount, 1, "newCount is recounted over the slice");
  assertEquals(digest.unreadCount, 1, "unreadCount is recounted too");
});

Deno.test("latest refuses to run before anything has been fetched", async () => {
  const { ctx } = makeCtx({ sources: [SOURCES[0]] }, {});
  await assertRejects(
    () => run("latest", {}, ctx) as Promise<unknown>,
    Error,
    "No stored feeds",
  );
});

// --- digestMessage ---------------------------------------------------------

const recentRss = () =>
  rss([{
    title: "Fresh",
    link: "https://alpha.example/fresh",
    date: new Date().toUTCString(),
  }]);

Deno.test("digestMessage composes a message resource for a non-empty window", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] });
  await withFetchStub(() => ({ body: recentRss() }), async () => {
    await run("digestMessage", { sinceHours: 24 }, ctx);
  });
  const message = written.find((w) => w.spec === "message")!.payload;
  assertEquals(message.count, 1);
  assertEquals(message.windowHours, 24);
  assert(String(message.text).includes("Fresh"));
});

Deno.test("digestMessage is a silent no-op when the window is empty", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] });
  const old = rss([{
    title: "Ancient",
    link: "https://alpha.example/old",
    date: new Date("2000-01-01").toUTCString(),
  }]);
  let result: { dataHandles: unknown[] } | undefined;
  await withFetchStub(() => ({ body: old }), async () => {
    result = await run("digestMessage", { sinceHours: 24 }, ctx) as {
      dataHandles: unknown[];
    };
  });
  assertEquals(result?.dataHandles, [], "no handle is returned");
  assertEquals(
    written.filter((w) => w.spec === "message").length,
    0,
    "and nothing is written, so a quiet day cannot resend a stale digest",
  );
});

Deno.test("digestMessage sends through the named telegram model", async () => {
  const { ranModels, ctx } = makeCtx({ sources: [SOURCES[0]] });
  await withFetchStub(() => ({ body: recentRss() }), async () => {
    await run("digestMessage", { sinceHours: 24, telegramModel: "tg" }, ctx);
  });
  assertEquals(ranModels.length, 1);
  assertEquals(ranModels[0].definition, "tg");
  assertEquals(ranModels[0].method, "sendMessage");
  const sendArgs = ranModels[0].arguments as Record<string, unknown>;
  assertEquals(sendArgs.parseMode, "HTML");
  assertEquals(sendArgs.disableWebPagePreview, true);
  assert(String(sendArgs.text).includes("Fresh"));
});

Deno.test("digestMessage forwards a chatId override only when given", async () => {
  const withOverride = makeCtx({ sources: [SOURCES[0]] });
  await withFetchStub(() => ({ body: recentRss() }), async () => {
    await run(
      "digestMessage",
      { sinceHours: 24, telegramModel: "tg", chatId: "42" },
      withOverride.ctx,
    );
  });
  assertEquals(
    (withOverride.ranModels[0].arguments as Record<string, unknown>).chatId,
    "42",
  );

  const withoutOverride = makeCtx({ sources: [SOURCES[0]] });
  await withFetchStub(() => ({ body: recentRss() }), async () => {
    await run(
      "digestMessage",
      { sinceHours: 24, telegramModel: "tg" },
      withoutOverride.ctx,
    );
  });
  assert(
    !("chatId" in
      (withoutOverride.ranModels[0].arguments as Record<string, unknown>)),
    "the instance default must not be overridden with undefined",
  );
});

Deno.test("digestMessage throws when the telegram send returns no resource", async () => {
  const harness = makeCtx({ sources: [SOURCES[0]] });
  harness.setRunModelResult({ resources: [] });
  await withFetchStub(() => ({ body: recentRss() }), async () => {
    await assertRejects(
      () =>
        run(
          "digestMessage",
          { sinceHours: 24, telegramModel: "tg" },
          harness.ctx,
        ) as Promise<unknown>,
      Error,
      "produced no sentMessage resource",
    );
  });
});

Deno.test("digestMessage composes without sending when no telegram model is named", async () => {
  const { ranModels, written, ctx } = makeCtx({ sources: [SOURCES[0]] });
  await withFetchStub(() => ({ body: recentRss() }), async () => {
    await run("digestMessage", { sinceHours: 24 }, ctx);
  });
  assertEquals(ranModels.length, 0, "no send is attempted");
  assertEquals(written.filter((w) => w.spec === "message").length, 1);
});

Deno.test("digestMessage refuses to compose when every source failed", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(() => ({ status: 500 }), async () => {
    await assertRejects(
      () => run("digestMessage", { sinceHours: 24 }, ctx) as Promise<unknown>,
      Error,
      "sources failed",
    );
  });
});

// --- markRead / markUnread -------------------------------------------------

const readStore = () => ({
  "feed-alpha": storedFeed(),
});

Deno.test("markRead rejects an empty selector", async () => {
  const { ctx } = makeCtx({ sources: [SOURCES[0]] }, readStore());
  await assertRejects(
    () => run("markRead", {}, ctx) as Promise<unknown>,
    Error,
    "Specify what to mark",
  );
});

Deno.test("markRead rejects an unparseable before date", async () => {
  const { ctx } = makeCtx({ sources: [SOURCES[0]] }, readStore());
  await assertRejects(
    () => run("markRead", { before: "not-a-date" }, ctx) as Promise<unknown>,
    Error,
    "Unparseable",
  );
});

Deno.test("markRead throws when the selector matches nothing", async () => {
  const { ctx } = makeCtx({ sources: [SOURCES[0]] }, readStore());
  await assertRejects(
    () => run("markRead", { source: "nope" }, ctx) as Promise<unknown>,
    Error,
    "Nothing matched",
  );
});

Deno.test("markRead persists the selected urls", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, readStore());
  await run("markRead", { all: true }, ctx);
  const state = written.find((w) => w.spec === "read")!.payload;
  assertEquals(state.count, 2);
  assertEquals(
    Object.keys(state.urls as Record<string, string>).sort(),
    ["https://alpha.example/new", "https://alpha.example/old"],
  );
});

Deno.test("markRead keeps the earliest read timestamp on a re-mark", async () => {
  const earlier = "2021-01-01T00:00:00.000Z";
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    ...readStore(),
    "read-state": {
      urls: { "https://alpha.example/old": earlier },
      count: 1,
      updatedAt: earlier,
    },
  });
  await run("markRead", { all: true }, ctx);
  const urls = written.find((w) => w.spec === "read")!.payload.urls as Record<
    string,
    string
  >;
  assertEquals(
    urls["https://alpha.example/old"],
    earlier,
    "an already-read article keeps its original timestamp",
  );
  assert(urls["https://alpha.example/new"], "the new one is added");
});

Deno.test("markUnread with all clears the entire read set", async () => {
  const { written, ctx } = makeCtx({ sources: [SOURCES[0]] }, {
    ...readStore(),
    "read-state": {
      urls: {
        "https://alpha.example/old": "2026-01-01T00:00:00.000Z",
        "https://alpha.example/new": "2026-01-01T00:00:00.000Z",
      },
      count: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await run("markUnread", { all: true }, ctx);
  const state = written.find((w) => w.spec === "read")!.payload;
  assertEquals(state.count, 0);
  assertEquals(Object.keys(state.urls as Record<string, string>), []);
});

Deno.test("markUnread rejects an empty selector", async () => {
  const { ctx } = makeCtx({ sources: [SOURCES[0]] }, readStore());
  await assertRejects(
    () => run("markUnread", {}, ctx) as Promise<unknown>,
    Error,
    "Specify what to unmark",
  );
});

// --- sources / discover ----------------------------------------------------

Deno.test("sources lists the configuration without any I/O", async () => {
  const { ctx } = makeCtx();
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("sources must not fetch");
  }) as typeof globalThis.fetch;
  try {
    await run("sources", {}, ctx);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("discover ranks hosts from explicit urls with probing off", async () => {
  const { written, ctx } = makeCtx();
  await run("discover", {
    urls: [
      "https://writer.example/post-1",
      "https://writer.example/post-2",
      "https://other.example/x",
    ],
    probe: false,
  }, ctx);
  const candidates = written.filter((w) => w.spec === "candidate");
  assert(candidates.length >= 1, "at least one candidate host is written");
  const top = candidates[0].payload;
  assertEquals(top.host, "writer.example");
  assertEquals(top.mentions, 2);
});

Deno.test("discover rejects a call with no urls and no source model", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () => run("discover", { probe: false }, ctx) as Promise<unknown>,
    Error,
    "No URLs found",
  );
});
