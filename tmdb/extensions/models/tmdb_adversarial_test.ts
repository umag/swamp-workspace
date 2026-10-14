/**
 * Adversarial suite for @magistr/tmdb: credential leakage, hostile or
 * spec-violating responses, rate limiting, and malformed input.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, redact } from "./tmdb.ts";
import { fakeContext, json, stubFetch } from "./tmdb_test_helpers.ts";

const V3 = "0123456789abcdef0123456789abcdef";
const base = {
  name: "m",
  ttlDays: 30,
  refresh: false,
  refreshKeys: [],
  maxQueries: 0,
  minScore: 0.72,
  details: false,
  prune: false,
};

Deno.test("v3 key travels as api_key and never appears in an error entry", async () => {
  const s = stubFetch([[
    () => true,
    (u) => new Response(`oops ${u}`, { status: 400 }),
  ]]);
  try {
    const { context, writes } = fakeContext({ apiToken: V3 });
    await model.methods.match.execute(
      {
        ...base,
        items: [{ key: "a", title: "X", altTitles: [], kind: "movie" }],
      },
      context,
    );
    assertEquals(s.calls[0].url.searchParams.get("api_key"), V3);
    assertEquals(s.calls[0].headers.authorization, undefined);
    const e = JSON.stringify(writes[0].data);
    assert(!e.includes(V3), "key leaked into the resource");
  } finally {
    s.restore();
  }
});

Deno.test("redact scrubs api_key params and the raw token", () => {
  assertEquals(
    redact(`https://x/?api_key=${V3}&q=1 and ${V3}`, V3),
    "https://x/?api_key=***&q=1 and ***",
  );
});

Deno.test("429 with Retry-After is retried, then succeeds", async () => {
  let n = 0;
  const s = stubFetch([[
    () => true,
    () => (++n === 1
      ? json({}, 429, { "Retry-After": "0" })
      : json({ results: [], total_results: 0 })),
  ]]);
  try {
    const { context, writes } = fakeContext({ apiToken: V3 });
    await model.methods.search.execute(
      { query: "X", mediaType: "movie" },
      context,
    );
    assertEquals(n, 2);
    assertEquals(writes[0].data.totalResults, 0);
  } finally {
    s.restore();
  }
});

Deno.test("non-JSON 200 body fails loudly with a typed message", async () => {
  const s = stubFetch([[
    () => true,
    () => new Response("<html>cloudflare</html>", { status: 200 }),
  ]]);
  try {
    const { context } = fakeContext({ apiToken: V3 });
    await assertRejects(
      () =>
        model.methods.search.execute(
          { query: "X", mediaType: "movie" },
          context,
        ),
      Error,
      "non-JSON",
    );
  } finally {
    s.restore();
  }
});

Deno.test("results that are not objects are ignored, not crashed on", async () => {
  const s = stubFetch([[
    () => true,
    () => json({ results: [null, 1, "x", [], { id: 5 }], total_results: 5 }),
  ]]);
  try {
    const { context, writes } = fakeContext({ apiToken: V3 });
    await model.methods.search.execute(
      { query: "X", mediaType: "movie" },
      context,
    );
    assertEquals((writes[0].data.results as unknown[]).length, 0);
  } finally {
    s.restore();
  }
});

Deno.test("duplicate item keys are rejected before any request", async () => {
  const s = stubFetch([]);
  try {
    const { context } = fakeContext({ apiToken: V3 });
    await assertRejects(
      () =>
        model.methods.match.execute(
          {
            ...base,
            items: [{ key: "a", title: "X", altTitles: [], kind: "movie" }, {
              key: "a",
              title: "Y",
              altTitles: [],
              kind: "movie",
            }],
          },
          context,
        ),
      Error,
      "duplicate",
    );
    assertEquals(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

Deno.test("query text with URL metacharacters is encoded, not injected", async () => {
  const s = stubFetch([[
    () => true,
    () => json({ results: [], total_results: 0 }),
  ]]);
  try {
    const { context } = fakeContext({ apiToken: V3 });
    await model.methods.search.execute({
      query: "a&api_key=evil#x",
      mediaType: "movie",
    }, context);
    assertEquals(s.calls[0].url.searchParams.get("query"), "a&api_key=evil#x");
    assertEquals(s.calls[0].url.searchParams.getAll("api_key"), [V3]);
  } finally {
    s.restore();
  }
});
