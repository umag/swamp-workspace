/** Adversarial tests: anti-bot pages, malformed payloads, hostile input. */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  decodeRsc,
  grabJson,
  itemIdOf,
  model,
  parseCatalog,
  parseItem,
} from "./vinted.ts";

Deno.test("parseCatalog throws on an anti-bot / empty page", () => {
  assertThrows(
    () => parseCatalog("<html>captcha</html>", "www.vinted.nl"),
    Error,
    "No catalog items",
  );
});

Deno.test("parseItem throws when neither plugins nor ld+json exist", () => {
  assertThrows(
    () => parseItem("<html></html>", "1", "www.vinted.nl"),
    Error,
    "No item data",
  );
});

Deno.test("decodeRsc skips malformed chunks; grabJson handles brackets in strings", () => {
  const html =
    'self.__next_f.push([1,"\\x"])self.__next_f.push([1,"{\\"items\\":[{\\"t\\":\\"a]}b\\"}]}"])';
  assertEquals(grabJson(decodeRsc(html), '"items":['), [{ t: "a]}b" }]);
  assertEquals(grabJson('"items":[1,2', '"items":['), null);
});

Deno.test("itemIdOf rejects non-Vinted refs", () => {
  assertEquals(itemIdOf(" 10107271840 "), "10107271840");
  assertThrows(() => itemIdOf("https://evil.example/?x=1"));
  assertThrows(() => itemIdOf("1;rm -rf /"));
});

Deno.test("domain global arg only accepts vinted hosts", () => {
  assert(!model.globalArguments.safeParse({ domain: "evil.com" }).success);
  assert(
    !model.globalArguments.safeParse({ domain: "www.vinted.nl.evil.com/x" })
      .success,
  );
  assert(
    model.globalArguments.safeParse({ domain: "www.vinted.co.uk" }).success,
  );
});

Deno.test("catalog items missing price or id are skipped, not fatal", () => {
  const payload = JSON.stringify(
    '{"items":[{"productItem":{"id":1}},{"productItem":{"id":2,"title":"t","price":{"amount":"5.00","currencyCode":"EUR"}}}]}',
  );
  const { items } = parseCatalog(
    `self.__next_f.push([1,${payload}])`,
    "www.vinted.nl",
  );
  assertEquals(items.map((i) => i.id), ["2"]);
});

Deno.test("item: every fetch failing throws after recording item-run", async () => {
  const { deps } = await import("./vinted.ts");
  const { makeCtx } = await import("../../fixtures/ctx.ts");
  const real = deps.fetchPage;
  deps.fetchPage = () => Promise.reject(new Error("HTTP 429"));
  try {
    const { ctx, store } = makeCtx();
    let threw = false;
    try {
      await model.methods.item.execute(
        model.methods.item.arguments.parse({ refs: ["123456"] }),
        ctx as never,
      );
    } catch {
      threw = true;
    }
    assert(threw);
    assertEquals(
      (store.get("item-run") as { failed: unknown[] }).failed.length,
      1,
    );
  } finally {
    deps.fetchPage = real;
  }
});

Deno.test("item: stops after 3 consecutive 403s and reports notAttempted", async () => {
  const { deps } = await import("./vinted.ts");
  const { makeCtx } = await import("../../fixtures/ctx.ts");
  const real = deps.fetchPage;
  let calls = 0;
  deps.fetchPage =
    () => (calls++, Promise.reject(new Error("GET x -> HTTP 403")));
  try {
    const { ctx, store } = makeCtx();
    try {
      await model.methods.item.execute(
        model.methods.item.arguments.parse({
          refs: ["100001", "100002", "100003", "100004", "100005"],
        }),
        ctx as never,
      );
    } catch { /* all failed -> throws */ }
    assertEquals(calls, 3);
    assertEquals(
      (store.get("item-run") as { notAttempted: string[] }).notAttempted,
      ["100004", "100005"],
    );
  } finally {
    deps.fetchPage = real;
  }
});

Deno.test("RSC placeholder description falls back to ld+json", () => {
  const html =
    `<script type="application/ld+json">{"@type":"Product","name":"n","description":"Pit to pit 60 cm","offers":{"price":1,"priceCurrency":"EUR"}}</script>` +
    `self.__next_f.push([1,${
      JSON.stringify(
        '{"plugins":[{"name":"description","data":{"description":"$f7"}}]}',
      )
    }])`;
  const it = parseItem(html, "1", "www.vinted.nl");
  assertEquals(it.description, "Pit to pit 60 cm");
  assertEquals(it.measurements.chestCm, 120);
});

Deno.test("cookieFile must be absolute; userAgent bounded", () => {
  assert(
    !model.globalArguments.safeParse({ cookieFile: "cookies.txt" }).success,
  );
  assert(
    model.globalArguments.safeParse({
      cookieFile: "/tmp/c.txt",
      userAgent: "Mozilla/5.0 test",
    }).success,
  );
  assert(!model.globalArguments.safeParse({ userAgent: "x" }).success);
});
