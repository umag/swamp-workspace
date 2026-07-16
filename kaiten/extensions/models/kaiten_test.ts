import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { backoffMs, model, resolveBase, slug } from "./kaiten.ts";

function ga(overrides: Record<string, unknown> = {}) {
  // deno-lint-ignore no-explicit-any
  return (model.globalArguments as any).parse({
    domain: "acme",
    token: "tok",
    ...overrides,
  });
}

Deno.test("resolveBase: bare subdomain becomes <domain>.kaiten.ru", () => {
  assertEquals(resolveBase(ga()), "https://acme.kaiten.ru/api/latest");
});

Deno.test("resolveBase: full host is kept as-is", () => {
  assertEquals(
    resolveBase(ga({ domain: "kaiten.example.com" })),
    "https://kaiten.example.com/api/latest",
  );
});

Deno.test("resolveBase: strips protocol, path and trailing slash", () => {
  assertEquals(
    resolveBase(ga({ domain: "https://acme.kaiten.ru/some/path/" })),
    "https://acme.kaiten.ru/api/latest",
  );
});

Deno.test("resolveBase: honours apiVersion", () => {
  assertEquals(
    resolveBase(ga({ apiVersion: "v1" })),
    "https://acme.kaiten.ru/api/v1",
  );
});

Deno.test("resolveBase: strips a path-traversal attempt down to the host", () => {
  // The path (and anything after the first slash) is dropped, so a traversal
  // attempt cannot escape the host — it resolves to the clean host.
  assertEquals(
    resolveBase(ga({ domain: "acme.kaiten.ru/../evil" })),
    "https://acme.kaiten.ru/api/latest",
  );
});

Deno.test("resolveBase: rejects hosts with illegal characters", () => {
  assertThrows(() => resolveBase(ga({ domain: "acme kaiten" })));
  assertThrows(() => resolveBase(ga({ domain: "acme_kaiten!" })));
});

Deno.test("backoffMs: prefers Retry-After seconds (capped at 60s)", () => {
  assertEquals(
    backoffMs(new Response(null, { headers: { "Retry-After": "2" } })),
    2000,
  );
  assertEquals(
    backoffMs(new Response(null, { headers: { "Retry-After": "9999" } })),
    60_000,
  );
});

Deno.test("backoffMs: falls back to 1s when no headers present", () => {
  assertEquals(backoffMs(new Response(null)), 1000);
});

Deno.test("slug: stable, lowercased, safe", () => {
  assertEquals(slug("Board 128 / Live!"), "board-128-live");
  assertEquals(slug(""), "all");
});

Deno.test("listCards args: sane defaults", () => {
  // deno-lint-ignore no-explicit-any
  const parsed = (model.methods.listCards.arguments as any).parse({});
  assertEquals(parsed.maxResults, 500);
  assertEquals(parsed.pageSize, 100);
  assertEquals(parsed.additionalParams, {});
});

Deno.test("model: read-only surface only (no mutating methods)", () => {
  const names = Object.keys(model.methods).sort();
  assertEquals(names, [
    "getBoard",
    "getCard",
    "getSpace",
    "listBoards",
    "listCards",
    "listColumns",
    "listSpaces",
  ]);
  // Guard against accidental write methods creeping in.
  for (const n of names) {
    if (
      /^(create|update|delete|patch|post|move|archive|add|remove|set)/i.test(n)
    ) {
      throw new Error(`Unexpected mutating-looking method: ${n}`);
    }
  }
});
