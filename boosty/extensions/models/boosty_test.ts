/**
 * Contract-fixture suite for @magistr/boosty: pins the Markdown rendering of
 * the block shapes Boosty's post API actually serves.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { parseContent, renderBlocks } from "./boosty.ts";
import { imageBlock, textBlock } from "./boosty_harness_test.ts";

const URL = "https://boosty.to/blog/posts/x";

Deno.test("fixture: fragments join into one paragraph until BLOCK_END", () => {
  const md = renderBlocks(
    [textBlock("Hello, "), textBlock("world.", true), textBlock("Next", true)],
    () => null,
    URL,
  );
  assertEquals(md, "Hello, world.\n\nNext");
});

Deno.test("fixture: an inline link block renders as a Markdown link", () => {
  const md = renderBlocks(
    [
      textBlock("see "),
      {
        type: "link",
        url: "https://example.com",
        content: JSON.stringify(["here", "unstyled", []]),
      },
      textBlock("", true),
    ],
    () => null,
    URL,
  );
  assertEquals(md, "see [here](https://example.com)");
});

Deno.test("fixture: an image block stands alone and embeds the resolved target", () => {
  const md = renderBlocks(
    [textBlock("a", true), imageBlock("img1"), textBlock("b", true)],
    () => "attachments/x.png",
    URL,
  );
  assertEquals(md, "a\n\n![](attachments/x.png)\n\nb");
});

Deno.test("fixture: header and list styles map to Markdown prefixes", () => {
  const md = renderBlocks(
    [
      textBlock("Title", true, "header-two"),
      textBlock("item", true, "unordered-list-item"),
      textBlock("quote", true, "blockquote"),
    ],
    () => null,
    URL,
  );
  assertEquals(md, "## Title\n\n- item\n\n> quote");
});

Deno.test("fixture: a video block becomes a callout linking to the post", () => {
  const md = renderBlocks(
    [{ type: "ok_video", title: "Clip" }],
    () => null,
    URL,
  );
  assertEquals(md, `> [!video] [Видео: Clip](${URL})`);
});

Deno.test("fixture: parseContent reads the [text, style, ranges] triple", () => {
  assertEquals(parseContent('["hi","header-one",[]]'), {
    text: "hi",
    style: "header-one",
  });
});
