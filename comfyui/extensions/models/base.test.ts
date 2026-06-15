import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { model as comfyui } from "./comfyui.ts";

// Baseline smoke test — the ONLY gobrr `verifyInputs` file. It keeps
// `deno test -A` green at the gobrr common base and is immutable (no leaf may
// edit it). Build leaves add their own *.test.ts files (lib/comfy_client.test.ts,
// lib/caption.test.ts, lib/workflow_patch.test.ts, comfyui.test.ts).

Deno.test("comfyui model declares its type", () => {
  assertEquals(comfyui.type, "@magistr/comfyui/instance");
  assertExists(comfyui.methods);
});

Deno.test("comfyui model declares the expected methods", () => {
  assertExists(comfyui.methods.lookup);
  assertExists(comfyui.methods.sync);
  assertExists(comfyui.methods.build_caption);
  assertExists(comfyui.methods.generate);
});
