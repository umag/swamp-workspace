import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildCaptionMessages, IDEOGRAM_CAPTION_PROMPT_TEMPLATE } from "./ideogram_prompt.ts";

Deno.test("the template constant is the Ideogram magic prompt", () => {
  assertStringIncludes(IDEOGRAM_CAPTION_PROMPT_TEMPLATE, "compositional_deconstruction");
  assertStringIncludes(IDEOGRAM_CAPTION_PROMPT_TEMPLATE, "{{original_prompt}}");
});

Deno.test("buildCaptionMessages substitutes every placeholder", () => {
  const { system, user } = buildCaptionMessages("a neon cat", "9:16");
  assertEquals(system.includes("{{"), false);
  assertEquals(user.includes("{{"), false);
});

Deno.test("buildCaptionMessages puts the idea + aspect ratio in the user message", () => {
  const { system, user } = buildCaptionMessages("a neon cat", "9:16");
  assertStringIncludes(user, "a neon cat");
  assertStringIncludes(user, "9:16");
  assertStringIncludes(system, "OUTPUT CONTRACT");
});

Deno.test("buildCaptionMessages defaults a malformed aspect ratio to 1:1", () => {
  const { user } = buildCaptionMessages("idea", "not-a-ratio");
  assertStringIncludes(user, "1:1");
});
