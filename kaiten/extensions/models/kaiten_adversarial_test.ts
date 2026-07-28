/**
 * Adversarial suite: hostile/malformed API responses, unicode content,
 * pagination edges, retry exhaustion, and a fixtures-secret-scan tuned to
 * Kaiten's actual credential shape (no fixed token prefix, unlike
 * porkbun's pk1_/sk1_ — the token enters the wire only via the
 * `Authorization: Bearer <token>` header, and the vault key is `API_TOKEN`).
 *
 * kaiten.ts is UNMODIFIED — every test here PINS current behavior (including
 * behavior that is arguably risky) rather than proposing a fix. Where a test
 * documents a real gap, it is labeled "pin" and says so explicitly.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./kaiten.ts";
import spaces from "../../fixtures/spaces.json" with { type: "json" };
import boards from "../../fixtures/boards.json" with { type: "json" };
import columns from "../../fixtures/columns.json" with { type: "json" };
import cards from "../../fixtures/cards.json" with { type: "json" };
import card from "../../fixtures/card.json" with { type: "json" };
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = "KAITEN-ADVERSARIAL-SENTINEL-tOkEn-4b1e9d";
const GLOBAL_ARGS = { domain: "acme", token: SENTINEL_TOKEN, maxRetries: 2 };

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

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
// Hostile / malformed responses
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON (HTML 502) 200 response body surfaces as an unmapped SyntaxError", async () => {
  // kget calls `await res.json()` on any 2xx response, without first
  // checking Content-Type. A reverse-proxy that returns HTML with a 200
  // status (misconfigured, but real) throws a raw SyntaxError from JSON
  // parsing — not mapped to a Kaiten-domain error. Documented gap, not
  // fixed here (kaiten.ts unmodified). withOneResponse always
  // JSON.stringifies its body, so a raw non-JSON Response is stubbed
  // directly here instead.
  const { ctx } = makeCtx();
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("<html><body>Maintenance</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )) as unknown as typeof globalThis.fetch;
  try {
    await assertRejects(() => run("listSpaces", {}, ctx), SyntaxError);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("non-array, non-object top-level JSON (a bare string) -> asArray yields [], no crash", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json("just a string")], async () => {
    await run("listCards", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "card").length, 0);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 0);
});

Deno.test("non-array, non-object top-level JSON (a bare number) -> asArray yields []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json(12345)], async () => {
    await run("listSpaces", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "space").length, 0);
});

Deno.test("items missing `id` entirely are SKIPPED from a mixed list, valid items still written", async () => {
  const { ctx, written } = makeCtx();
  const mixed = [
    { title: "no id" },
    { id: 5, title: "has id" },
    { id: null, title: "explicit null id" },
  ];
  await withFetchStub([() => json(mixed)], async () => {
    await run("listSpaces", {}, ctx);
  });
  const writtenSpaces = written.filter((w) => w.spec === "space");
  assertEquals(writtenSpaces.length, 1);
  assertEquals(writtenSpaces[0].name, "space-5");
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 1);
  assertEquals(summary.payload.ids, [5]);
});

// ---------------------------------------------------------------------------
// getSpace / getBoard / getCard with a hostile non-object body
// ---------------------------------------------------------------------------

Deno.test("pin: getCard with a JSON `null` body — spreading null degrades to just {fetchedAt}", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(null, 200, async () => {
    await run("getCard", { id: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "card")!;
  // {...null, fetchedAt} === {fetchedAt} — spreading null/undefined is a
  // documented no-op in JS, not a crash.
  assertEquals(Object.keys(res.payload), ["fetchedAt"]);
});

Deno.test("pin: getCard with a JSON ARRAY body — spreading an array yields numeric-index keys, not card fields", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([1, 2, 3], 200, async () => {
    await run("getCard", { id: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "card")!;
  // {...[1,2,3], fetchedAt} === {"0":1,"1":2,"2":3, fetchedAt} — pinned as
  // documented type-confusion behavior, not fixed (kaiten.ts frozen).
  assertEquals(res.payload["0"], 1);
  assertEquals(res.payload["1"], 2);
  assertEquals(res.payload["2"], 3);
  assert("fetchedAt" in res.payload);
});

Deno.test("pin: getSpace with a JSON `null` body degrades the same way as getCard", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(null, 200, async () => {
    await run("getSpace", { id: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "space")!;
  assertEquals(Object.keys(res.payload), ["fetchedAt"]);
});

// ---------------------------------------------------------------------------
// Network hangs past timeoutMs — the AbortController path
// ---------------------------------------------------------------------------

Deno.test("pin: a request that outlives timeoutMs is aborted — kget then throws a raw AbortError (DOMException), not a Kaiten-domain error", async () => {
  // kget wires an AbortController that fires after g.timeoutMs (see
  // kaiten.ts's kget). This stub NEVER resolves on its own — the only thing
  // that ever settles this fetch is the real timeoutMs abort, so this is a
  // genuine (if tiny) real-timer wait, not a stubbed one.
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, timeoutMs: 15 });
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      req.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as unknown as typeof globalThis.fetch;
  try {
    let threw: unknown;
    try {
      await run("listSpaces", {}, ctx);
    } catch (err) {
      threw = err;
    }
    assert(
      threw instanceof DOMException,
      `expected a DOMException, got ${threw}`,
    );
    assertEquals((threw as DOMException).name, "AbortError");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Retry exhaustion — 429 on every attempt
// ---------------------------------------------------------------------------

Deno.test('pin: 429 on every attempt exhausts maxRetries and throws (Retry-After: "0" keeps this test fast)', async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, maxRetries: 2 });
  let attempts = 0;
  await withFetchStub(
    [() => {
      attempts++;
      return json({ error: "still limited" }, 429, { "Retry-After": "0" });
    }],
    async () => {
      await assertRejects(() => run("listSpaces", {}, ctx), Error, "429");
    },
  );
  // maxRetries=2 means attempts 0,1,2 all get a 429 (attempt < maxRetries
  // retries after attempts 0 and 1; attempt 2 is not < maxRetries so it
  // throws) => 3 total attempts.
  assertEquals(attempts, 3);
});

// ---------------------------------------------------------------------------
// listCards pagination edges: dedup, truncation
// ---------------------------------------------------------------------------

Deno.test("listCards: duplicate ids across pages are DEDUPED (a shifting live listing can re-serve an id)", async () => {
  const { ctx, written } = makeCtx();
  const page1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
  // Page 2 re-serves id 3 (e.g. it moved due to a concurrent edit) plus one
  // genuinely new id.
  const page2 = [{ id: 3 }, { id: 4 }];
  let call = 0;
  await withFetchStub([(req) => {
    call++;
    const offset = new URL(req.url).searchParams.get("offset");
    if (offset === "0") return json(page1);
    if (offset === "3") return json(page2);
    return json([]);
  }], async () => {
    await run("listCards", { pageSize: 3, maxResults: 10 }, ctx);
  });
  const ids = written.filter((w) => w.spec === "card").map((w) => w.name)
    .sort();
  assertEquals(ids, ["card-1", "card-2", "card-3", "card-4"]);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 4);
  assert(call >= 2);
});

Deno.test("listCards: truncation at maxResults sets truncated=true and stops fetching further pages", async () => {
  const { ctx, written } = makeCtx();
  const page1 = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
  let calls = 0;
  await withFetchStub([() => {
    calls++;
    return json(page1);
  }], async () => {
    await run("listCards", { pageSize: 5, maxResults: 3 }, ctx);
  });
  const cardsWritten = written.filter((w) => w.spec === "card");
  assertEquals(cardsWritten.length, 3);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.truncated, true);
  assertEquals(summary.payload.total, 3);
  assertEquals(
    calls,
    1,
    "must stop after maxResults is reached, no further page fetched",
  );
});

// ---------------------------------------------------------------------------
// additionalParams passthrough + unicode titles preserved
// ---------------------------------------------------------------------------

Deno.test("listCards: additionalParams passes through arbitrary raw query keys verbatim", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", {
      additionalParams: { type_id: "2", "custom_field_99": "x" },
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("type_id"), "2");
    assertEquals(url.searchParams.get("custom_field_99"), "x");
  });
});

Deno.test("unicode board/card titles (CJK, emoji, RTL) are preserved verbatim through the passthrough spread", async () => {
  const { ctx, written } = makeCtx();
  const unicodeTitles = [
    { id: 1, title: "スプリント ボード 🚀" },
    { id: 2, title: "لوحة المهام" },
    { id: 3, title: "Тестовая карточка — «важно»" },
  ];
  await withFetchStub([() => json(unicodeTitles)], async () => {
    await run("listCards", {}, ctx);
  });
  const writtenTitles = written
    .filter((w) => w.spec === "card")
    .map((w) => w.payload.title)
    .sort();
  assertEquals(
    writtenTitles,
    unicodeTitles.map((t) => t.title).sort(),
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop tuned to Kaiten's token shape
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "literal Bearer prefix", re: /\bBearer\s+\S+/ },
  { name: "vault key name API_TOKEN", re: /\bAPI_TOKEN\b/ },
  // Kaiten tokens have NO fixed prefix (unlike porkbun's pk1_/sk1_) — a
  // prefix-based scan would be vacuous. Fall back to a generic high-entropy
  // detector: an ENTIRE string of 32+ alnum/base64url characters, no
  // separators. None of our authored fixture values (ids, titles,
  // timestamps, uids) match this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
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
  "spaces.json": spaces,
  "boards.json": boards,
  "columns.json": columns,
  "cards.json": cards,
  "card.json": card,
  "error.json": errorFixture,
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected token shape", () => {
  // Guards against the scan test above being vacuously true (e.g. broken
  // regexes that never match anything). Poison with all three shapes.
  const poisoned = {
    a: "Authorization: Bearer abc123def456",
    b: "the key is API_TOKEN",
    c: "a".repeat(40),
  };
  const violations: string[] = [];
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length >= 3,
    "sanity check: scanner must flag all three poisoned shapes",
  );
});
