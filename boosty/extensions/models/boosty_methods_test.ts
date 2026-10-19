/**
 * Methods suite for @magistr/boosty: `archive` and `whoami` end to end against
 * a stubbed API and a temp output directory.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { model } from "./boosty.ts";
import {
  boostyRoute,
  imageBlock,
  listDir,
  makeCtx,
  post,
  tempDir,
  textBlock,
  withFetch,
} from "./boosty_harness_test.ts";

const archive = model.methods.archive.execute;
const whoami = model.methods.whoami.execute;

Deno.test("archive: pages the whole feed and writes one note per post", async () => {
  const dir = await tempDir();
  try {
    const { ctx, written } = makeCtx();
    await withFetch(
      boostyRoute([
        [post("aaaaaaaa-1", "First", { tags: ["a b"] })],
        [post("bbbbbbbb-2", "Second")],
      ]),
      () => archive({ blog: "blog", outputDir: dir }, ctx),
    );
    const notes = (await listDir(dir)).filter((n) => n.endsWith(".md"));
    assertEquals(notes.length, 2);
    const first = await Deno.readTextFile(`${dir}/${notes[0]}`);
    assertStringIncludes(first, "access: full");
    assertStringIncludes(first, '  - "a-b"');
    assertEquals(written[0].spec, "archive");
    assertEquals(written[0].payload.total, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive: downloads images, names them by block id, embeds local path", async () => {
  const dir = await tempDir();
  try {
    const { ctx } = makeCtx();
    await withFetch(
      boostyRoute([[
        post("cccccccc-3", "Pics", {
          data: [imageBlock("1234abcd-5678-ef"), textBlock("x", true)],
        }),
      ]]),
      () => archive({ blog: "blog", outputDir: dir }, ctx),
    );
    assertEquals(await listDir(`${dir}/attachments`), [
      "blog-cccccccc-1234abcd-5678.png",
    ]);
    const note = await Deno.readTextFile(
      `${dir}/${(await listDir(dir)).find((n) => n.endsWith(".md"))}`,
    );
    assertStringIncludes(
      note,
      "![](attachments/blog-cccccccc-1234abcd-5678.png)",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive: second run is idempotent (no rewrites, no re-downloads)", async () => {
  const dir = await tempDir();
  try {
    const pages = [[
      post("dddddddd-4", "Same", { data: [imageBlock("img-1")] }),
    ]];
    await withFetch(
      boostyRoute(pages),
      () => archive({ blog: "blog", outputDir: dir }, makeCtx().ctx),
    );
    const { ctx, written } = makeCtx();
    const calls = await withFetch(boostyRoute(pages), async (calls) => {
      await archive({ blog: "blog", outputDir: dir }, ctx);
      return calls;
    });
    assertEquals(written[0].payload.notesUnchanged, 1);
    assertEquals(written[0].payload.imagesSkipped, 1);
    assert(calls.every((c) => c.url.hostname !== "images.boosty.to"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive: a locked post is written from its teaser with access: locked", async () => {
  const dir = await tempDir();
  try {
    const { ctx, written } = makeCtx();
    await withFetch(
      boostyRoute([[
        post("eeeeeeee-5", "Paid", {
          hasAccess: false,
          data: [],
          teaser: [textBlock("teaser text", true)],
        }),
      ]]),
      () => archive({ blog: "blog", outputDir: dir }, ctx),
    );
    const note = await Deno.readTextFile(
      `${dir}/${(await listDir(dir)).find((n) => n.endsWith(".md"))}`,
    );
    assertStringIncludes(note, "access: locked");
    assertStringIncludes(note, "teaser text");
    assertEquals(written[0].payload.locked, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive: sends the normalized token as a Bearer header", async () => {
  const dir = await tempDir();
  try {
    const cookie = encodeURIComponent(JSON.stringify({ accessToken: "tok" }));
    const { ctx } = makeCtx({ accessToken: cookie });
    const calls = await withFetch(boostyRoute([[]]), async (calls) => {
      await archive({ blog: "blog", outputDir: dir }, ctx);
      return calls;
    });
    assertEquals(calls[0].headers["authorization"], "Bearer tok");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("whoami: reports the account and sample access", async () => {
  const { ctx, written } = makeCtx({ accessToken: "tok" });
  await withFetch(
    boostyRoute([[post("ffffffff-6", "P")]]),
    () => whoami({ blog: "blog" }, ctx),
  );
  assertEquals(written[0].spec, "whoami");
  assertEquals(written[0].payload.userStatus, 200);
  assertEquals(written[0].payload.userName, "Tester");
  assertEquals(written[0].payload.sample, [{ title: "P", hasAccess: true }]);
});
