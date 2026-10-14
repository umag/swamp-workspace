/** Adversarial tests: hostile HTML, bad LLM output, path and input abuse. */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  decodeEntities,
  deps,
  extractJson,
  htmlToText,
  model,
  parseThread,
} from "./dieworkwear.ts";
import { makeCtx } from "../../fixtures/ctx.ts";

const realDeps = { ...deps };

Deno.test("parseThread rejects a page with no tweets (e.g. Cloudflare block)", () => {
  assertThrows(
    () => parseThread("<html>Just a moment...</html>", "1", "x"),
    Error,
    "No tweets",
  );
});

Deno.test("htmlToText strips script-ish markup and embedded blockquotes", () => {
  const t = htmlToText(
    'a<script>x</script><blockquote class="twitter-tweet"><a>evil</a></blockquote>b &lt;i&gt;',
  );
  assert(!t.includes("evil"));
  assertEquals(t, "axb <i>");
});

Deno.test("decodeEntities ignores out-of-range code points", () => {
  assertEquals(decodeEntities("&#1114112;&#0;ok"), "ok");
});

Deno.test("extractJson fails loudly on prose", () => {
  assertThrows(() => extractJson("I cannot help with that."), Error, "No JSON");
});

Deno.test("advise rejects unknown figure", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      model.methods.advise.execute({
        figure: "../../etc",
        occasion: "any",
        includeExtracted: false,
        synthesize: false,
      }, ctx as never),
    Error,
    "Unknown figure",
  );
});

Deno.test("advise without figure or prior classification rejects", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      model.methods.advise.execute({
        occasion: "any",
        includeExtracted: false,
        synthesize: false,
      }, ctx as never),
    Error,
    "figure",
  );
});

Deno.test("critique rejects relative paths and non-image extensions", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      model.methods.critique.execute(
        { imagePath: "a.jpg", occasion: "any" },
        ctx as never,
      ),
    Error,
    "absolute",
  );
  assert(
    !model.methods.critique.arguments.safeParse({ imagePath: "/etc/passwd" })
      .success,
  );
});

Deno.test("fetch ids must be numeric (no URL/path injection)", () => {
  assert(!model.methods.fetch.arguments.safeParse({ ids: ["../x"] }).success);
  assert(!model.methods.fetch.arguments.safeParse({ ids: ["1?a=b"] }).success);
});

Deno.test("extract: all threads failing -> throws but still records failures", async () => {
  const { ctx, store } = makeCtx();
  store.set("corpus", { threads: [{ id: "123456" }] });
  store.set("thread-123456", {
    id: "123456",
    tweets: [{ id: "123456", text: "t" }],
  });
  deps.runClaude = () => Promise.resolve("not json");
  try {
    await assertRejects(
      () => model.methods.extract.execute({ refresh: false }, ctx as never),
      Error,
      "every thread",
    );
    assertEquals(
      (store.get("extracted") as { failures: unknown[] }).failures.length,
      1,
    );
  } finally {
    Object.assign(deps, realDeps);
  }
});

Deno.test("author global arg rejects non-handle values", () => {
  assert(!model.globalArguments.safeParse({ author: "x/../../admin" }).success);
});
