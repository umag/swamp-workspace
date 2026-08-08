/**
 * Adversarial suite: hostile/malformed responses, raw youtube_id path
 * interpolation injection, unicode round-trip, download-queue mutation
 * idempotency/clobber pins, a trust-boundary pin on token echo, and a
 * mechanical fixtures-secret-scan over tubearchivist/fixtures/*.json.
 *
 * tubearchivist.ts is BYTE-FROZEN — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so
 * explicitly.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./tubearchivist.ts";
import videoList from "../../fixtures/video-list.json" with { type: "json" };
import videoDetail from "../../fixtures/video-detail.json" with {
  type: "json",
};
import channelList from "../../fixtures/channel-list.json" with {
  type: "json",
};
import queueList from "../../fixtures/queue-list.json" with { type: "json" };
import searchFixture from "../../fixtures/search.json" with { type: "json" };
import stats from "../../fixtures/stats.json" with { type: "json" };
import backupList from "../../fixtures/backup-list.json" with {
  type: "json",
};
import snapshotList from "../../fixtures/snapshot-list.json" with {
  type: "json",
};
import ping from "../../fixtures/ping.json" with { type: "json" };
import task from "../../fixtures/task.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HOST = "https://tubearchivist.example.com";
const TOKEN = "ta_stub_token";

const GLOBAL_ARGS = { host: HOST, token: TOKEN };

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

function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

// ---------------------------------------------------------------------------
// HTTP-status handling (contrast with a naive "parse JSON, check body.status"
// client): tubearchivist.ts's api() DOES check response.ok before touching
// the body at all.
// ---------------------------------------------------------------------------

Deno.test("pin: a non-ok HTTP status is mapped to a normal Error BEFORE any JSON parsing is attempted, even with an HTML body", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      const err = await assertRejects(() => run("ping", {}, ctx), Error);
      assert(
        String(err).includes("failed: 502"),
        "the status code must surface in the error message",
      );
      assert(
        String(err).includes("Bad Gateway"),
        "the response body (sliced) must surface in the error message",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Hostile / malformed JSON bodies -> unmapped TypeErrors
// ---------------------------------------------------------------------------

Deno.test("pin: list-videos crashes with an unmapped TypeError when the whole response body is JSON null", async () => {
  // `const videos = (data.data || []).map(...)` reads `data.data` — but if
  // `data` itself is `null` (a literal JSON `null` body), the property
  // access `data.data` throws BEFORE the `|| []` fallback can run. Documented
  // gap, not fixed here (tubearchivist.ts is byte-frozen).
  const { ctx } = makeCtx();
  await withOneResponse(null, 200, async () => {
    await assertRejects(() => run("list-videos", {}, ctx), TypeError);
  });
});

Deno.test("pin: list-videos crashes with an unmapped TypeError when data.data is a non-array truthy string", async () => {
  // `data.data || []` only guards the FALSY case. A hostile/buggy server
  // sending a non-array truthy `data.data` (e.g. a string) sails through the
  // `||` guard unchanged, and `.map` is not a function on a string.
  const { ctx } = makeCtx();
  await withOneResponse({ data: "not-an-array" }, 200, async () => {
    await assertRejects(() => run("list-videos", {}, ctx), TypeError);
  });
});

Deno.test("pin: list-videos crashes with an unmapped TypeError when data.data is a non-array truthy object", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ data: { unexpected: "shape" } }, 200, async () => {
    await assertRejects(() => run("list-videos", {}, ctx), TypeError);
  });
});

Deno.test("pin: list-channels crashes with an unmapped TypeError on a non-array truthy data.data", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ data: "not-an-array" }, 200, async () => {
    await assertRejects(() => run("list-channels", {}, ctx), TypeError);
  });
});

Deno.test("pin: list-queue crashes with an unmapped TypeError on a non-array truthy data.data", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ data: "not-an-array" }, 200, async () => {
    await assertRejects(() => run("list-queue", {}, ctx), TypeError);
  });
});

Deno.test("list-videos: a null data.data (falsy) does NOT crash — the || [] guard catches exactly this case", async () => {
  // Contrast with the two pins above: null is FALSY, so `data.data || []`
  // does catch it, unlike a non-array truthy value. This test documents the
  // guard's actual boundary precisely.
  const { ctx, written } = makeCtx();
  await withOneResponse({ data: null, paginate: {} }, 200, async () => {
    await run("list-videos", {}, ctx);
  });
  const res = written.find((w) => w.spec === "videos")!;
  assertEquals(res.payload.videos, []);
});

// ---------------------------------------------------------------------------
// Injection via raw youtube_id path interpolation (no encodeURIComponent)
// ---------------------------------------------------------------------------

Deno.test("pin: a youtube_id with '../' path-traversal segments ESCAPES the /api/video/ prefix once the URL is parsed", async () => {
  // get-video's template `/api/video/${youtube_id}/` interpolates raw, with
  // no encodeURIComponent. Standard URL dot-segment normalization (RFC 3986
  // 5.2.4) then collapses "video/../" when the resulting string is parsed
  // into a URL/Request — so an attacker-controlled youtube_id can make the
  // actual request land OUTSIDE /api/video/ entirely. Documented gap, not
  // fixed here (tubearchivist.ts is byte-frozen); callers must not pass
  // attacker-controlled youtube_id values without their own validation.
  const { ctx } = makeCtx();
  await withOneResponse({ youtube_id: "x" }, 200, async (calls) => {
    await run("get-video", { youtube_id: "../etc/passwd" }, ctx);
    const url = new URL(calls[0].url);
    assert(
      !url.pathname.startsWith("/api/video/"),
      `expected the traversal to escape /api/video/, got ${url.pathname}`,
    );
  });
});

Deno.test("pin: a youtube_id containing '/' (e.g. 'a/b') adds an EXTRA path segment rather than being one opaque label", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ youtube_id: "x" }, 200, async (calls) => {
    await run("get-video", { youtube_id: "a/b" }, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/video/a/b/");
  });
});

Deno.test("pin: a youtube_id containing '#' truncates the request into a URL fragment — never reaches the server", async () => {
  // '#' begins a URL fragment; everything from '#' onward is stripped from
  // the pathname (and never sent over the wire at all). This silently
  // truncates the intended path rather than erroring.
  const { ctx } = makeCtx();
  await withOneResponse({ youtube_id: "x" }, 200, async (calls) => {
    await run("get-video", { youtube_id: "#" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/video/");
    assert(
      !url.pathname.includes("#"),
      "the fragment marker itself must not appear in the pathname",
    );
  });
});

Deno.test("pin: a youtube_id containing '?' diverts the trailing slash into a query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ youtube_id: "x" }, 200, async (calls) => {
    await run("get-video", { youtube_id: "?" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/video/");
    assert(
      url.search.length > 0,
      "the trailing '/' from the template must be diverted into the query string",
    );
  });
});

Deno.test("pin: delete-video is vulnerable to the same raw youtube_id path interpolation as get-video", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("delete-video", { youtube_id: "a/b" }, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/video/a/b/");
    assertEquals(calls[0].method, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// Unicode round-trip
// ---------------------------------------------------------------------------

Deno.test("search: a unicode query is percent-encoded in the URL and the unicode results pass through unchanged", async () => {
  const { ctx, written } = makeCtx();
  const unicodeResults = [
    { title: "「アーカイブ」動画", youtube_id: "synVid00001" },
    { title: "Café Über Naïve résumé 🎬", youtube_id: "synVid00002" },
  ];
  await withOneResponse(
    { results: unicodeResults },
    200,
    async (calls) => {
      await run("search", { query: "アーカイブ 🎬" }, ctx);
      const url = new URL(calls[0].url);
      assertEquals(url.searchParams.get("query"), "アーカイブ 🎬");
      assert(
        url.search.includes("%"),
        "the raw query string must be percent-encoded on the wire",
      );
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, unicodeResults);
});

Deno.test("get-video: a unicode-titled video round-trips through the no-unwrap storage unchanged", async () => {
  const { ctx, written } = makeCtx();
  const detail = {
    youtube_id: "synVid00003",
    title: "日本語のタイトル — with an emdash and emoji 🎥",
  };
  await withOneResponse(detail, 200, async () => {
    await run("get-video", { youtube_id: "synVid00003" }, ctx);
  });
  const res = written.find((w) => w.spec === "videos")!;
  assertEquals((res.payload.videos as unknown[])[0], detail);
});

// ---------------------------------------------------------------------------
// Download-queue mutation idempotency / fixed-name writeResource clobber pins
// ---------------------------------------------------------------------------

Deno.test("pin: add-to-queue is NOT idempotent — repeating identical args sends two independent POSTs", async () => {
  const { ctx } = makeCtx();
  let posts = 0;
  await withFetchStub(
    [(req) => {
      if (new URL(req.url).pathname === "/api/download/") {
        posts++;
        return json({ task_id: `t${posts}` });
      }
      return undefined;
    }],
    async (calls) => {
      await run("add-to-queue", { youtube_ids: ["synVid00001"] }, ctx);
      await run("add-to-queue", { youtube_ids: ["synVid00001"] }, ctx);
      assertEquals(calls.length, 2, "no dedup — two independent POSTs");
    },
  );
});

Deno.test("pin: add-to-queue's writeResource uses the SAME fixed name (queue-add) on every call — clobbers on repeat", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ task_id: "t1" }, 200, async () => {
    await run("add-to-queue", { youtube_ids: ["synVid00001"] }, ctx);
    await run("add-to-queue", { youtube_ids: ["synVid00002"] }, ctx);
  });
  const names = written.filter((w) => w.spec === "download").map((w) => w.name);
  assertEquals(
    names,
    ["queue-add", "queue-add"],
    "both calls write the identical resource name — the second clobbers the first in a real instance",
  );
});

Deno.test("pin: subscribe's writeResource uses the SAME fixed name (subscribe) on every call — clobbers on repeat", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ task_id: "t1" }, 200, async () => {
    await run("subscribe", { channel_ids: ["UCsynthetic0000000001"] }, ctx);
    await run("subscribe", { channel_ids: ["UCsynthetic0000000002"] }, ctx);
  });
  const names = written.filter((w) =>
    w.spec === "task" && w.name === "subscribe"
  );
  assertEquals(names.length, 2, "both calls target the SAME (spec, name) pair");
});

Deno.test("pin: start-download's writeResource uses the SAME fixed name (download) on every call", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ task_id: "t1" }, 200, async () => {
    await run("start-download", {}, ctx);
    await run("start-download", {}, ctx);
  });
  const names = written.filter((w) =>
    w.spec === "task" && w.name === "download"
  );
  assertEquals(names.length, 2, "both calls target the SAME (spec, name) pair");
});

Deno.test("pin: delete-video's writeResource uses the SAME fixed name (delete) regardless of which video was deleted", async () => {
  // Unlike get-video (which names the resource after the youtube_id),
  // delete-video's writeResource name is a literal constant — deleting two
  // DIFFERENT videos back-to-back clobbers the same "task"/"delete" entry,
  // losing the audit trail of which video was deleted first.
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async () => {
    await run("delete-video", { youtube_id: "synVid00001" }, ctx);
    await run("delete-video", { youtube_id: "synVid00002" }, ctx);
  });
  const deletes = written.filter((w) =>
    w.spec === "task" && w.name === "delete"
  );
  assertEquals(deletes.length, 2);
  assertEquals(deletes[0].name, deletes[1].name);
  assert(
    deletes[0].payload.message !== deletes[1].payload.message,
    "the payload differs per video but the (spec, name) pair does not",
  );
});

Deno.test("pin: mark-watched's writeResource uses the SAME fixed name (watched) regardless of which video was marked", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async () => {
    await run(
      "mark-watched",
      { youtube_id: "synVid00001", is_watched: true },
      ctx,
    );
    await run(
      "mark-watched",
      { youtube_id: "synVid00002", is_watched: false },
      ctx,
    );
  });
  const marks = written.filter((w) =>
    w.spec === "task" && w.name === "watched"
  );
  assertEquals(marks.length, 2);
  assertEquals(marks[0].name, marks[1].name);
});

Deno.test("pin: delete-video has no existence check — deleting the same id twice makes two identical requests", async () => {
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [() => {
      calls++;
      return json({});
    }],
    async () => {
      await run("delete-video", { youtube_id: "synVid00001" }, ctx);
      await run("delete-video", { youtube_id: "synVid00001" }, ctx);
    },
  );
  assertEquals(
    calls,
    2,
    "no idempotency short-circuit — the client always calls through",
  );
});

// ---------------------------------------------------------------------------
// Trust-boundary pin: a hostile server echoing the token in its response body
// ---------------------------------------------------------------------------

Deno.test("pin: a hostile server echoing the token in an error response body surfaces it via body.slice(0,200) in the thrown error", async () => {
  // The client's Authorization header is never logged or written anywhere
  // (see the token-leak sweep in tubearchivist_methods_test.ts) — but api()
  // does not sanitize the SERVER's response body before slicing it into the
  // thrown error. A hostile or misconfigured server that echoes the token
  // back (e.g. in a verbose auth-failure page) would have that echoed value
  // surfaced to whatever reads the error. Distinct sentinel token from the
  // rest of this suite so this test cannot pass by accident.
  const sentinelToken = "ta_trust_boundary_sentinel_0001";
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(
        `Unauthorized: your token '${sentinelToken}' was rejected`,
        { status: 401, headers: { "Content-Type": "text/plain" } },
      )],
    async () => {
      const err = await assertRejects(
        () =>
          run("ping", {}, {
            ...ctx,
            globalArgs: { host: HOST, token: sentinelToken },
          }),
        Error,
      );
      assert(
        String(err).includes(sentinelToken),
        "sanity: the hostile server's echoed token must actually surface — proves the trust-boundary gap exists",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "vault key name TA_TOKEN", re: /\bTA_TOKEN\b/ },
  {
    name: "generic 'token' assignment shape",
    re: /\btoken["']?\s*[:=]\s*["'][^"']+["']/i,
  },
  // Generic high-entropy blob: a value that is ENTIRELY 32+ alnum/base64url
  // characters with NO separators (deliberately excludes '-' so a
  // hyphenated RFC 4122 UUID like task.json's synthetic task_id, which is
  // structurally a UUID rather than a secret, does not false-positive) —
  // none of our authored fixture values (ids, titles, filenames, ISO dates)
  // match this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=]{32,}$/ },
];

/** Recursively collect every string leaf value in a parsed JSON structure. */
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
  "video-list.json": videoList,
  "video-detail.json": videoDetail,
  "channel-list.json": channelList,
  "queue-list.json": queueList,
  "search.json": searchFixture,
  "stats.json": stats,
  "backup-list.json": backupList,
  "snapshot-list.json": snapshotList,
  "ping.json": ping,
  "task.json": task,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape", () => {
  // Guards against the scan test above being vacuously true (e.g. broken
  // regexes that never match anything).
  const violations: string[] = [];
  const poisoned = { key: "a".repeat(40) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a high-entropy 40-char blob",
  );
});
