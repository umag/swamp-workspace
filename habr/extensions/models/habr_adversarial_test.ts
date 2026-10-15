/**
 * Adversarial suite for @magistr/habr: hostile caller input (path/query
 * smuggling), hostile redirects (SSRF), and spec-violating or malicious
 * server responses.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  decodeEntities,
  MAX_PAGES,
  model,
  normalizePagesCount,
  parseSummary,
} from "./habr.ts";
import {
  BASE,
  habrRoute,
  json,
  makeCtx,
  redirect,
  text,
  withFetch,
} from "./habr_harness_test.ts";

const HOSTILE_ALIASES = [
  "../admin",
  "user?x=1",
  "user&page=99",
  "user#frag",
  "us er",
  "user%2F..",
  "юзер",
  "",
  "   ",
];

for (const user of HOSTILE_ALIASES) {
  Deno.test(`list-articles rejects hostile alias ${JSON.stringify(user)}`, async () => {
    const { ctx } = makeCtx();
    await withFetch(() => json({}), async (calls) => {
      await assertRejects(() =>
        model.methods["list-articles"].execute({ user }, ctx)
      );
      assertEquals(calls.length, 0);
    });
  });
}

for (const id of ["1/../2", "1?x", "-1", "1e3", "0x10", "", "١٢٣"]) {
  Deno.test(`get-article rejects hostile id ${JSON.stringify(id)}`, async () => {
    const { ctx } = makeCtx();
    await withFetch(() => json({}), async (calls) => {
      await assertRejects(() =>
        model.methods["get-article"].execute({ id }, ctx)
      );
      assertEquals(calls.length, 0);
    });
  });
}

for (const lang of ["ru&user=victim", "ru/../x", "r", "en-US#"]) {
  Deno.test(`hostile lang global ${JSON.stringify(lang)} is rejected before fetch`, async () => {
    const { ctx } = makeCtx({ baseUrl: BASE, lang });
    await withFetch(() => json({}), async (calls) => {
      await assertRejects(
        () => model.methods["get-article"].execute({ id: "1" }, ctx),
        Error,
        "Invalid Habr language",
      );
      assertEquals(calls.length, 0);
    });
  });
}

for (
  const target of [
    "https://evil.example/kek/v2/articles/1/",
    "https://evilhabr.com/x",
    "https://habr.com.attacker.example/x",
    "http://169.254.169.254/latest/meta-data/",
  ]
) {
  Deno.test(`redirect to disallowed host ${target} is refused`, async () => {
    const { ctx, written } = makeCtx();
    await withFetch(() => redirect(target), async (calls) => {
      await assertRejects(
        () => model.methods["get-article"].execute({ id: "1" }, ctx),
        Error,
        "disallowed host",
      );
      assertEquals(calls.length, 1);
    });
    assertEquals(written.length, 0);
  });
}

Deno.test("redirect to *.habr.com is followed", async () => {
  const { ctx, written } = makeCtx();
  await withFetch((c) => {
    if (c.url.hostname === "habr.example") {
      return redirect("https://m.habr.com/kek/v2/articles/1/");
    }
    return json({ id: "1", textHtml: "<p>ok</p>" });
  }, async (calls) => {
    await model.methods["get-article"].execute({ id: "1" }, ctx);
    assertEquals(calls.map((c) => c.url.hostname), [
      "habr.example",
      "m.habr.com",
    ]);
  });
  assertEquals(written[0].payload.text, "ok");
});

Deno.test("relative redirect resolves against the current host", async () => {
  const { ctx } = makeCtx();
  let n = 0;
  await withFetch(
    () => (n++ === 0
      ? redirect("/kek/v2/articles/1/?moved=1")
      : json({ id: "1" })),
    async (calls) => {
      await model.methods["get-article"].execute({ id: "1" }, ctx);
      assertEquals(calls[1].url.origin, BASE);
      assertEquals(calls[1].url.searchParams.get("moved"), "1");
    },
  );
});

Deno.test("redirect loop is bounded", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => redirect(`${BASE}/loop`), async (calls) => {
    await assertRejects(
      () => model.methods["get-article"].execute({ id: "1" }, ctx),
      Error,
      "Too many redirects",
    );
    assert(calls.length <= 6);
  });
});

Deno.test("redirect without Location is refused", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => redirect(null, 301), async () => {
    await assertRejects(
      () => model.methods["get-article"].execute({ id: "1" }, ctx),
      Error,
      "no Location",
    );
  });
});

Deno.test("non-JSON 200 body rejects", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(() => text("<html>captcha</html>"), async () => {
    await assertRejects(() =>
      model.methods["get-article"].execute({ id: "1" }, ctx)
    );
  });
  assertEquals(written.length, 0);
});

Deno.test("a hung server is aborted by timeoutMs", async () => {
  const { ctx } = makeCtx({ baseUrl: BASE, timeoutMs: 20 });
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
      );
    });
  try {
    await assertRejects(() =>
      model.methods["get-article"].execute({ id: "1" }, ctx)
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("hostile huge pagesCount is clamped to MAX_PAGES", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    (c) =>
      json({
        pagesCount: 1e12,
        publicationIds: [c.url.searchParams.get("page")],
      }),
    async (calls) => {
      await model.methods["list-articles"].execute({ user: "u" }, ctx);
      assertEquals(calls.length, MAX_PAGES);
    },
  );
  assertEquals(written[0].payload.pagesCount, MAX_PAGES);
});

Deno.test("non-numeric pagesCount means a single page, schema-valid", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    () => json({ pagesCount: "lots", publicationIds: [] }),
    async (calls) => {
      await model.methods["list-articles"].execute({ user: "u" }, ctx);
      assertEquals(calls.length, 1);
    },
  );
  model.resources.articles.schema.parse(written[0].payload);
});

Deno.test("garbage statistics and readingTime still produce a schema-valid article", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({
      articles: {
        "5": {
          id: 5,
          titleHtml: 123,
          readingTime: Number.NaN,
          tags: "not-an-array",
          hubs: [null, { alias: 7 }],
          statistics: { readingCount: "many", score: "-3" },
          textHtml: null,
        },
      },
    }),
    () => model.methods["get-article"].execute({ id: "5" }, ctx),
  );
  const a = model.resources.article.schema.parse(written[0].payload);
  assertEquals(a.statistics.reads, 0);
  assertEquals(a.statistics.score, -3);
  assertEquals(a.readingTime, null);
  assertEquals(a.tags, []);
  assertEquals(a.hubs, ["7"]);
});

Deno.test("a hostile server-supplied lang cannot inject into the article URL", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({ articles: { "5": { id: "5", lang: "../../evil" } } }),
    () => model.methods["get-article"].execute({ id: "5" }, ctx),
  );
  assertEquals(written[0].payload.url, `${BASE}/ru/articles/5/`);
  assertEquals(written[0].payload.lang, "ru");
});

Deno.test("title script tags are stripped, never stored as markup", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({
      articles: { "5": { id: "5", titleHtml: "<script>alert(1)</script>Hi" } },
    }),
    () => model.methods["get-article"].execute({ id: "5" }, ctx),
  );
  assertEquals(written[0].payload.title, "alert(1)Hi");
});

Deno.test("out-of-range numeric entities do not throw", () => {
  assertEquals(decodeEntities("a&#99999999;b"), "a&#99999999;b");
  assertEquals(decodeEntities("&#x110000;"), "&#x110000;");
  assertEquals(decodeEntities("&#x10FFFF;"), String.fromCodePoint(0x10ffff));
});

// Counterexamples the nightly-scale property run found: JSON objects whose
// `toString` is not callable made `String()` / `Number()` throw
// "Cannot convert object to primitive value" and abort the whole run.
Deno.test("parseSummary: objects with a non-callable toString do not throw", () => {
  const s = parseSummary(
    {
      id: [{ toString: "" }],
      titleHtml: { toString: false },
      statistics: { readingCount: { toString: false } },
      author: { alias: { valueOf: 1 } },
    },
    "https://habr.com",
    "ru",
  );
  assertEquals(s.id, "");
  assertEquals(s.title, "");
  assertEquals(s.statistics.reads, 0);
});

Deno.test("normalizePagesCount: an object pagesCount is one page, not a throw", () => {
  assertEquals(normalizePagesCount({ toString: false }), 1);
  assertEquals(normalizePagesCount("3"), 3);
});
