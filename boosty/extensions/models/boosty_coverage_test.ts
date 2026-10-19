/**
 * Coverage suite for @magistr/boosty: one test per guard or branch, so
 * deleting it turns a test red.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  normalizeToken,
  parseContent,
  renderBlocks,
  safeName,
  sanitizeBlog,
} from "./boosty.ts";

Deno.test("sanitizeBlog accepts a full boosty.to URL", () => {
  assertEquals(
    sanitizeBlog("https://boosty.to/rottenkepken/posts/1"),
    "rottenkepken",
  );
});

Deno.test("sanitizeBlog rejects an empty slug", () => {
  assertThrows(() => sanitizeBlog("  "));
});

Deno.test("normalizeToken: bare token passes through", () => {
  assertEquals(normalizeToken(" abc "), "abc");
});

Deno.test("normalizeToken: strips a Bearer prefix", () => {
  assertEquals(normalizeToken("Bearer abc"), "abc");
});

Deno.test("normalizeToken: extracts accessToken from raw cookie JSON", () => {
  assertEquals(
    normalizeToken('{"accessToken":"abc","refreshToken":"r"}'),
    "abc",
  );
});

Deno.test("normalizeToken: URL-decodes an encoded cookie before parsing", () => {
  assertEquals(
    normalizeToken(encodeURIComponent('{"accessToken":"abc"}')),
    "abc",
  );
});

Deno.test("normalizeToken: undefined is empty", () => {
  assertEquals(normalizeToken(undefined), "");
});

Deno.test("parseContent: non-JSON content is kept as plain text", () => {
  assertEquals(parseContent("raw"), { text: "raw", style: "unstyled" });
});

Deno.test("parseContent: empty content is empty unstyled", () => {
  assertEquals(parseContent(undefined), { text: "", style: "unstyled" });
});

Deno.test("renderBlocks: an unresolved image is dropped", () => {
  assertEquals(
    renderBlocks(
      [{ type: "image", url: "https://images.boosty.to/a" }],
      () => null,
      "u",
    ),
    "",
  );
});

Deno.test("renderBlocks: a file block becomes a file callout", () => {
  assertEquals(
    renderBlocks(
      [{ type: "file", title: "doc.pdf", url: "https://x/doc" }],
      () => null,
      "u",
    ),
    "> [!file] [doc.pdf](https://x/doc)",
  );
});

Deno.test("renderBlocks: an unknown block with a url becomes a link", () => {
  assertEquals(
    renderBlocks([{ type: "poll", url: "https://x/p" }], () => null, "u"),
    "[poll](https://x/p)",
  );
});

Deno.test("renderBlocks: a trailing paragraph without BLOCK_END is flushed", () => {
  assertEquals(
    renderBlocks(
      [{ type: "text", content: '["tail","unstyled",[]]' }],
      () => null,
      "u",
    ),
    "tail",
  );
});

Deno.test("safeName: empty and dot-only titles become 'untitled'", () => {
  assertEquals(safeName(""), "untitled");
  assertEquals(safeName(".."), "untitled");
});

Deno.test("safeName: truncates to 120 chars", () => {
  assertEquals(safeName("x".repeat(300)).length, 120);
});
