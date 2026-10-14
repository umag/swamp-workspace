/**
 * Methods suite for @magistr/habr: every method's success and failure paths
 * with `fetch` stubbed.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./habr.ts";
import {
  habrRoute,
  json,
  makeCtx,
  text,
  withFetch,
} from "./habr_harness_test.ts";

function feed(ids: string[], pagesCount: number) {
  return {
    pagesCount,
    publicationIds: ids,
    publicationRefs: Object.fromEntries(
      ids.map((id) => [id, { id, titleHtml: `T${id}`, lang: "ru" }]),
    ),
  };
}

const art = (id: string) => ({
  id,
  titleHtml: `A${id}`,
  textHtml: `<p>${id}</p>`,
});

Deno.test("list-articles: fans out over every page", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({
      pages: { "1": feed(["1"], 3), "2": feed(["2"], 3), "3": feed(["3"], 3) },
    }),
    async (calls) => {
      const r = await model.methods["list-articles"].execute(
        { user: "u" },
        ctx,
      );
      assertEquals(calls.length, 3);
      assertEquals(r.dataHandles.length, 1);
    },
  );
  assertEquals(
    (written[0].payload.articles as { id: string }[]).map((a) => a.id),
    ["1", "2", "3"],
  );
  assertEquals(written[0].payload.pagesFetched, 3);
});

Deno.test("list-articles: maxPages caps the fan-out", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({ pages: { "1": feed(["1"], 5), "2": feed(["2"], 5) } }),
    async (calls) => {
      await model.methods["list-articles"].execute(
        { user: "u", maxPages: 2 },
        ctx,
      );
      assertEquals(calls.length, 2);
    },
  );
  assertEquals(written[0].payload.pagesCount, 5);
  assertEquals(written[0].payload.pagesFetched, 2);
});

Deno.test("list-articles: maxPages above pagesCount is clamped", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({ pages: { "1": feed(["1"], 1) } }),
    async (calls) => {
      await model.methods["list-articles"].execute(
        { user: "u", maxPages: 9 },
        ctx,
      );
      assertEquals(calls.length, 1);
    },
  );
  assertEquals(written[0].payload.pagesFetched, 1);
});

Deno.test("list-articles: an empty feed writes zero articles", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({ pages: { "1": { pagesCount: 0, publicationIds: [] } } }),
    () => model.methods["list-articles"].execute({ user: "u" }, ctx),
  );
  assertEquals(written[0].payload.total, 0);
  model.resources.articles.schema.parse(written[0].payload);
});

Deno.test("list-articles: HTTP error rejects and writes nothing", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(() => text("nope", 503), async () => {
    await assertRejects(
      () => model.methods["list-articles"].execute({ user: "u" }, ctx),
      Error,
      "503",
    );
  });
  assertEquals(written.length, 0);
});

Deno.test("list-articles: failure on a later page writes nothing", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(habrRoute({ pages: { "1": feed(["1"], 2) } }), async () => {
    await assertRejects(
      () => model.methods["list-articles"].execute({ user: "u" }, ctx),
      Error,
      "404",
    );
  });
  assertEquals(written.length, 0);
});

Deno.test("list-articles: invalid alias rejects before any fetch", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => json({}), async (calls) => {
    await assertRejects(
      () => model.methods["list-articles"].execute({ user: "a/b" }, ctx),
      Error,
      "Invalid Habr user alias",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("get-article: writes one article resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(habrRoute({ articles: { "42": art("42") } }), async () => {
    const r = await model.methods["get-article"].execute({ id: " 42 " }, ctx);
    assertEquals(r.dataHandles, [{ spec: "article", name: "42" }]);
  });
  assertEquals(written[0].payload.text, "42");
  model.resources.article.schema.parse(written[0].payload);
});

Deno.test("get-article: missing textHtml yields empty body and text", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({ articles: { "7": { id: "7" } } }),
    () => model.methods["get-article"].execute({ id: "7" }, ctx),
  );
  assertEquals(written[0].payload.textHtml, "");
  assertEquals(written[0].payload.text, "");
});

Deno.test("get-article: 404 rejects", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(habrRoute({}), async () => {
    await assertRejects(
      () => model.methods["get-article"].execute({ id: "1" }, ctx),
      Error,
      "404",
    );
  });
  assertEquals(written.length, 0);
});

Deno.test("get-article: non-numeric id rejects before any fetch", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => json({}), async (calls) => {
    await assertRejects(
      () => model.methods["get-article"].execute({ id: "12a" }, ctx),
      Error,
      "Invalid Habr article id",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("get-articles: one resource per id, in order", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    habrRoute({ articles: { "1": art("1"), "2": art("2") } }),
    async (calls) => {
      const r = await model.methods["get-articles"].execute(
        { ids: ["2", "1"] },
        ctx,
      );
      assertEquals(r.dataHandles.length, 2);
      assertEquals(calls.length, 2);
    },
  );
  assertEquals(written.map((w) => w.name), ["2", "1"]);
});

Deno.test("get-articles: empty id list does nothing", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => json({}), async (calls) => {
    const r = await model.methods["get-articles"].execute({ ids: [] }, ctx);
    assertEquals(r.dataHandles, []);
    assertEquals(calls.length, 0);
  });
});

Deno.test("get-articles: one invalid id rejects the whole batch before fetching", async () => {
  const { ctx } = makeCtx();
  await withFetch(() => json(art("1")), async (calls) => {
    await assertRejects(
      () => model.methods["get-articles"].execute({ ids: ["1", "x"] }, ctx),
      Error,
      "Invalid Habr article id",
    );
    assertEquals(calls.length, 0);
  });
});
