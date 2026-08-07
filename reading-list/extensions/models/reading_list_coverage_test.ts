/**
 * Coverage tests for @magistr/reading-list — regression locks on guards that
 * had no test standing behind them. Each test here answers one question: "if
 * someone deletes this guard, does a test go red?"
 *
 * Every case below names the guard it protects, so a future reader can tell
 * whether a failure means the guard moved or the behaviour genuinely changed.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  buildDigest,
  hostOf,
  model,
  parseFeedXml,
  renderTelegramHtml,
  type Source,
  truncate,
} from "./reading_list.ts";

const SRC: Source = {
  name: "s",
  kind: "rss",
  url: "https://s.example/feed.xml",
  tier: 1,
  enabled: true,
};

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(
  globalArgs: Record<string, unknown>,
  store: Record<string, Record<string, unknown>> = {},
) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      readResource: (n: string) => Promise.resolve(store[n] ?? null),
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

async function withBody(
  body: string,
  fn: () => Promise<void>,
  status = 200,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, { status, statusText: status === 200 ? "OK" : "No" }),
    )) as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const rssOf = (n: number) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${
    Array.from(
      { length: n },
      (_, i) =>
        `<item><title>T${i}</title><link>https://s.example/${i}</link></item>`,
    ).join("")
  }</channel></rss>`;

// --- guard: maxPerSource is a hard cap -------------------------------------

Deno.test("coverage: maxPerSource defaults to 25 when unset", async () => {
  const { written, ctx } = makeCtx({ sources: [SRC] });
  await withBody(rssOf(60), async () => {
    await run("fetch", {}, ctx);
  });
  const feed = written.find((w) => w.spec === "feed")!.payload;
  assertEquals(feed.count, 25, "the documented default cap is applied");
  assertEquals((feed.articles as unknown[]).length, 25);
});

Deno.test("coverage: maxPerSource override is respected exactly", async () => {
  const { written, ctx } = makeCtx({ sources: [SRC], maxPerSource: 3 });
  await withBody(rssOf(60), async () => {
    await run("fetch", {}, ctx);
  });
  const feed = written.find((w) => w.spec === "feed")!.payload;
  assertEquals(feed.count, 3);
});

// --- guard: an empty parse is a per-kind failure, not a silent empty feed ---

Deno.test("coverage: an RSS feed with no items is recorded as a failure", async () => {
  const { written, ctx } = makeCtx({ sources: [SRC] });
  await withBody(
    `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`,
    async () => {
      await run("fetch", {}, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "feed")!.payload;
  assertEquals(feed.ok, false);
  assertEquals(feed.error, "feed contained no items");
});

Deno.test("coverage: a gated LinkedIn profile gets its own diagnostic", async () => {
  const { written, ctx } = makeCtx({
    sources: [{
      ...SRC,
      kind: "linkedin",
      url: "https://linkedin.example/in/x",
    }],
  });
  await withBody("<html><body>Sign in</body></html>", async () => {
    await run("fetch", {}, ctx);
  });
  const feed = written.find((w) => w.spec === "feed")!.payload;
  assertEquals(feed.ok, false);
  assert(
    String(feed.error).includes("JSON-LD"),
    "the LinkedIn failure names the actual cause, not a generic empty-feed",
  );
});

// --- guard: markUnread's compound `all` condition ---------------------------

const storedFeed = {
  source: "s",
  kind: "rss",
  url: "https://s.example/feed.xml",
  tier: 1,
  ok: true,
  fetchedAt: "2026-01-02T00:00:00.000Z",
  count: 2,
  newCount: 0,
  articles: [
    {
      title: "A",
      url: "https://s.example/a",
      source: "s",
      tier: 1,
      publishedAt: "2026-01-01T00:00:00.000Z",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      isNew: false,
    },
    {
      title: "B",
      url: "https://s.example/b",
      source: "s",
      tier: 2,
      publishedAt: "2026-01-01T00:00:00.000Z",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      isNew: false,
    },
  ],
};

/**
 * A read-state carrying a STALE url — one the feeds no longer serve, e.g. an
 * article that has since rolled off the source's 25-item window. This is the
 * only input that can tell markUnread's two paths apart.
 */
const readStateWithStale = () => ({
  "feed-s": storedFeed,
  "read-state": {
    urls: {
      "https://s.example/a": "2026-01-01T00:00:00.000Z",
      "https://s.example/b": "2026-01-01T00:00:00.000Z",
      "https://s.example/rolled-off": "2025-01-01T00:00:00.000Z",
    },
    count: 3,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

Deno.test("coverage: markUnread all-alone wipes the map, including stale urls", async () => {
  const { written, ctx } = makeCtx({ sources: [SRC] }, readStateWithStale());
  // The full-clear branch operates on the read-state MAP, so it reaches urls
  // that no stored feed mentions any more. Deleting the compound condition
  // would route this through selectUrls and strand every stale entry forever.
  await run("markUnread", { all: true }, ctx);
  const state = written.find((w) => w.spec === "read")!.payload;
  assertEquals(state.count, 0);
  assertEquals(Object.keys(state.urls as Record<string, string>), []);
});

Deno.test("coverage: markUnread all+selector goes through the feeds, sparing stale urls", async () => {
  const { written, ctx } = makeCtx({ sources: [SRC] }, readStateWithStale());
  // `all` short-circuits the other selectors inside selectUrls (see its
  // `if (filter.all) return true`), so this still unmarks every STORED
  // article — but it resolves against the feeds, so the rolled-off url is
  // untouched. That asymmetry is the whole point of the compound condition.
  await run("markUnread", { all: true, tier: 1 }, ctx);
  const urls = written.find((w) => w.spec === "read")!.payload.urls as Record<
    string,
    string
  >;
  assertEquals(
    Object.keys(urls),
    ["https://s.example/rolled-off"],
    "only the url absent from the feeds survives",
  );
});

// --- guard: url scheme rejection at the parse boundary ---------------------

Deno.test("coverage: a relative or protocol-relative link is rejected, not half-parsed", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Rel</title><link>/relative/path</link></item>
    <item><title>Proto</title><link>//cdn.example/x</link></item>
    <item><title>OK</title><link>https://s.example/ok</link></item>
  </channel></rss>`;
  assertEquals(
    parseFeedXml(xml, SRC).map((a) => a.url),
    ["https://s.example/ok"],
    "only an absolute http(s) link becomes an article",
  );
});

Deno.test("coverage: hostOf returns undefined, never an empty string", () => {
  // `new URL("javascript:x")` parses with hostname === "" — the falsy-but-
  // defined case that made this guard necessary in the first place.
  assertEquals(hostOf("javascript:alert(1)"), undefined);
  assertEquals(hostOf("mailto:a@b.example"), undefined);
  assertEquals(hostOf("https://www.x.example/p"), "x.example");
});

// --- guard: derived counts and rendering limits -----------------------------

Deno.test("coverage: unreadCount appears only when a read set is supplied", () => {
  const feeds = [storedFeed];
  const without = buildDigest(feeds, "tier");
  assertEquals(
    without.unreadCount,
    undefined,
    "no read set means no unread claim",
  );

  const withSet = buildDigest(
    feeds,
    "tier",
    new Set(["https://s.example/a"]),
  );
  assertEquals(withSet.unreadCount, 1);
});

Deno.test("coverage: the render cap emits an overflow line rather than truncating silently", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    title: `Article number ${i} with a reasonably long title`,
    url: `https://s.example/${i}`,
    source: "s",
    tier: 1,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    isNew: true,
  }));
  const out = renderTelegramHtml(many, { windowHours: 24, maxChars: 500 });
  assert(out.length <= 600, "the body stays near the cap");
  assert(
    /…and \d+ more/.test(out),
    "the dropped remainder is declared, not silently lost",
  );
});

Deno.test("coverage: truncate breaks on a word boundary and stays within limit", () => {
  const out = truncate("alpha beta gamma delta epsilon", 12);
  assert(out.length <= 13, "limit is honoured");
  assert(!out.includes("gamm"), "no mid-word cut");
});

// --- guard: digestMessage refuses a fully-failed fetch ----------------------

Deno.test("coverage: digestMessage will not compose from zero working sources", async () => {
  const { ctx } = makeCtx({ sources: [SRC] });
  await withBody("", async () => {
    await assertRejects(
      () => run("digestMessage", { sinceHours: 24 }, ctx) as Promise<unknown>,
      Error,
      "refusing to compose",
    );
  }, 500);
});

// --- guard: the source files themselves stay plain text --------------------

/**
 * Raw control bytes in a source file are invisible to every normal tool and
 * survive every behavioural test.
 *
 * This is not hypothetical: v2026.08.07.1 shipped with literal 0x00 0x01 bytes
 * inside a string in the adversarial suite, written where escape sequences were
 * intended. `deno fmt`, `lint`, `check` and all 109 tests were green; CI was
 * green; it was reviewed and merged. Git silently recorded the file as BINARY
 * (`Bin 0 -> 8298 bytes`), which costs the file its diff, its blame and any
 * future reviewability — and `grep` resolves to ripgrep on some machines, which
 * SKIPS binary files, so searching for the offending byte reports "no matches"
 * and reads like a clean bill of health.
 *
 * No behavioural test can catch this, so the suite reads its own directory.
 * The forbidden characters are built with String.fromCharCode at runtime and
 * never written as literals, so this test cannot reintroduce the very bug it
 * exists to prevent.
 */
Deno.test("guard: no source file contains a raw control byte", async () => {
  const dir = new URL(".", import.meta.url).pathname;
  const offenders: string[] = [];

  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const bytes = await Deno.readFile(`${dir}${entry.name}`);
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      // Tab, LF and CR are the only control bytes legitimately in source.
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 0x20 || c === 0x7f) {
        const hex = c.toString(16).padStart(2, "0");
        offenders.push(`${entry.name}: 0x${hex} at byte offset ${i}`);
        break; // one report per file is enough to fail and locate it
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "write the character as an escape sequence (backslash-u) so the FILE " +
      "stays plain text while the STRING still holds the character",
  );
});
