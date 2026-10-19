/**
 * Adversarial suite for @magistr/boosty: hostile blog slugs, image URLs,
 * titles and API responses must never escape the output dir or reach a
 * foreign host.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { hostAllowed, model, safeName, sanitizeBlog } from "./boosty.ts";
import {
  boostyRoute,
  json,
  listDir,
  makeCtx,
  post,
  tempDir,
  withFetch,
} from "./boosty_harness_test.ts";

const archive = model.methods.archive.execute;

Deno.test("adversarial: a traversal slug is rejected", () => {
  assertThrows(() => sanitizeBlog("../etc"));
  assertThrows(() => sanitizeBlog("a b"));
  assertThrows(() => sanitizeBlog("a?x=1"));
});

Deno.test("adversarial: lookalike and non-https hosts are refused", () => {
  assert(!hostAllowed("https://evilboosty.to/x"));
  assert(!hostAllowed("https://boosty.to.evil.example/x"));
  assert(!hostAllowed("http://images.boosty.to/x"));
  assert(!hostAllowed("file:///etc/passwd"));
  assert(hostAllowed("https://images.boosty.to/x"));
});

Deno.test("adversarial: a foreign image URL is never fetched", async () => {
  const dir = await tempDir();
  try {
    const calls = await withFetch(
      boostyRoute([[
        post("aaaaaaaa-1", "X", {
          data: [{ type: "image", id: "i", url: "https://evil.example/a.png" }],
        }),
      ]]),
      async (calls) => {
        await archive({ blog: "blog", outputDir: dir }, makeCtx().ctx);
        return calls;
      },
    );
    assert(calls.every((c) => c.url.hostname.endsWith("boosty.to")));
    assertEquals(await listDir(`${dir}/attachments`), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("adversarial: a path-like title stays inside the output dir", async () => {
  const dir = await tempDir();
  try {
    await withFetch(
      boostyRoute([[post("aaaaaaaa-1", "../../escape/..")]]),
      () => archive({ blog: "blog", outputDir: dir }, makeCtx().ctx),
    );
    const names = await listDir(dir);
    assert(names.every((n) => !n.includes("/")));
    assert(names.some((n) => n.endsWith(".md")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("adversarial: an image block id with path chars falls back to an index", async () => {
  const dir = await tempDir();
  try {
    await withFetch(
      boostyRoute([[
        post("aaaaaaaa-1", "X", {
          data: [{
            type: "image",
            id: "../../x",
            url: "https://images.boosty.to/a",
          }],
        }),
      ]]),
      () => archive({ blog: "blog", outputDir: dir }, makeCtx().ctx),
    );
    assertEquals(await listDir(`${dir}/attachments`), [
      "blog-aaaaaaaa-01.png",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("adversarial: a relative outputDir is refused", async () => {
  await assertRejects(() =>
    archive({ blog: "blog", outputDir: "rel/dir" }, makeCtx().ctx)
  );
});

Deno.test("adversarial: a 401 from the feed fails loudly instead of writing nothing", async () => {
  const dir = await tempDir();
  try {
    await assertRejects(
      () =>
        withFetch(
          () => json({ error: "no" }, 401),
          () => archive({ blog: "blog", outputDir: dir }, makeCtx().ctx),
        ),
      Error,
      "401",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("adversarial: a non-array feed payload yields zero posts, not a crash", async () => {
  const dir = await tempDir();
  try {
    const { ctx, written } = makeCtx();
    await withFetch(
      () => json({ data: "nope", extra: { isLast: true } }),
      () => archive({ blog: "blog", outputDir: dir }, ctx),
    );
    assertEquals(written[0].payload.total, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("adversarial: safeName strips every path and Obsidian link char", () => {
  assertEquals(
    safeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'),
    "a b c d e f g h i j k l m n",
  );
});
