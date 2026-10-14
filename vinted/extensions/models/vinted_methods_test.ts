/** Methods tests: search + item execute() with stubbed HTTP. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { deps, model } from "./vinted.ts";
import { fixture, makeCtx } from "../../fixtures/ctx.ts";

const real = { ...deps };
const restore = () => Object.assign(deps, real);

Deno.test("search: first run has no isNew; second run flags only new ids", async () => {
  const urls: string[] = [];
  let html = fixture("catalog.html");
  deps.fetchPage = (u) => (urls.push(u), Promise.resolve(html));
  try {
    const { ctx, store } = makeCtx();
    const args = model.methods.search.arguments.parse({
      query: "burberry trench",
      priceTo: 150,
      brandIds: [364],
      pages: 1,
    });
    await model.methods.search.execute(args, ctx as never);
    const s1 = store.get("search-burberry-trench") as {
      newCount: number;
      itemCount: number;
    };
    assertEquals([s1.itemCount, s1.newCount], [4, 0]);
    assert(
      urls[0].includes("price_to=150") &&
        urls[0].includes("brand_ids%5B%5D=364"),
    );
    html = html.replace(/10298802242/g, "99999999999");
    await model.methods.search.execute(args, ctx as never);
    const s2 = store.get("search-burberry-trench") as {
      newCount: number;
      items: { id: string; isNew: boolean }[];
    };
    assertEquals(s2.newCount, 1);
    assertEquals(s2.items.find((i) => i.isNew)?.id, "99999999999");
  } finally {
    restore();
  }
});

Deno.test("search: mustMatch filters titles", async () => {
  deps.fetchPage = () => Promise.resolve(fixture("catalog.html"));
  try {
    const { ctx, store } = makeCtx();
    await model.methods.search.execute(
      model.methods.search.arguments.parse({ query: "x", mustMatch: "parka" }),
      ctx as never,
    );
    assertEquals((store.get("search-x") as { itemCount: number }).itemCount, 1);
  } finally {
    restore();
  }
});

Deno.test("item: URL ref resolves to id and writes item-<id>", async () => {
  const urls: string[] = [];
  deps.fetchPage = (
    u,
  ) => (urls.push(u), Promise.resolve(fixture("item_10107271840.html")));
  try {
    const { ctx, store } = makeCtx();
    await model.methods.item.execute({
      refs: [
        "https://www.vinted.nl/items/10107271840-impers-burberrys-homme?referrer=catalog",
        "10107271840",
      ],
    }, ctx as never);
    assertEquals(urls, ["https://www.vinted.nl/items/10107271840"]);
    assertEquals(
      (store.get("item-10107271840") as { price: { amount: number } }).price
        .amount,
      118,
    );
  } finally {
    restore();
  }
});

Deno.test("item: skips stored items, records failures, continues", async () => {
  const calls: string[] = [];
  deps.fetchPage = (u) => {
    calls.push(u);
    return u.endsWith("/111111")
      ? Promise.reject(new Error("HTTP 429"))
      : Promise.resolve(fixture("item_10107271840.html"));
  };
  try {
    const { ctx, store } = makeCtx();
    store.set("item-222222", { id: "222222" });
    await model.methods.item.execute(
      model.methods.item.arguments.parse({
        refs: ["111111", "222222", "10107271840"],
      }),
      ctx as never,
    );
    const run = store.get("item-run") as {
      fetched: string[];
      skipped: string[];
      failed: { id: string }[];
    };
    assertEquals(run.fetched, ["10107271840"]);
    assertEquals(run.skipped, ["222222"]);
    assertEquals(run.failed.map((f) => f.id), ["111111"]);
    assertEquals(calls.length, 2);
  } finally {
    restore();
  }
});

Deno.test("reparse: rewrites only items whose measurements changed", async () => {
  const { ctx, store, writes } = makeCtx();
  store.set("item-111111", {
    id: "111111",
    description: "63cm de large/130cm de long",
    measurements: { waistCm: 63 },
  });
  store.set("item-222222", {
    id: "222222",
    description: "nothing",
    measurements: {},
  });
  await model.methods.reparse.execute(
    { refs: ["111111", "222222", "333333"] },
    ctx as never,
  );
  assertEquals(writes.map((w) => w.name), ["item-111111"]);
  assertEquals(
    (store.get("item-111111") as { measurements: unknown }).measurements,
    { chestFlatCm: 63, chestCm: 126, lengthCm: 130 },
  );
});
