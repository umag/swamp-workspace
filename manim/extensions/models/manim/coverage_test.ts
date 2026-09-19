// Coverage suite: exercises every branch of the pure domain helpers and the
// model's argument/global schemas that the other suites don't already pin.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildRenderArgs,
  formatExtension,
  FORMATS,
  QUALITIES,
  qualityLetter,
  selectOutputFile,
  tail,
} from "./types.ts";
import { model } from "../manim_scene.ts";

Deno.test("qualityLetter + formatExtension cover every enum member", () => {
  const letters = QUALITIES.map(qualityLetter);
  assertEquals(letters, ["l", "m", "h", "p", "k"]);
  const exts = FORMATS.map(formatExtension);
  assertEquals(exts, [".mp4", ".gif", ".png", ".webm"]);
});

Deno.test("buildRenderArgs includes fps without resolution", () => {
  const args = buildRenderArgs({
    scriptPath: "/s.py",
    sceneNames: ["A"],
    quality: "production",
    format: "png",
    mediaDir: "/m",
    fps: 24,
    transparent: false,
    extraArgs: [],
  });
  assertEquals(args.includes("--fps"), true);
  assertEquals(args[args.indexOf("--fps") + 1], "24");
  assertEquals(args.includes("--resolution"), false);
  assertEquals(args.includes("-a"), false);
});

Deno.test("selectOutputFile matches case-insensitively on extension", () => {
  const chosen = selectOutputFile(
    [{ path: "/m/S.MP4", mtimeMs: 1, size: 1 }],
    "mp4",
  );
  assertEquals(chosen?.path, "/m/S.MP4");
});

Deno.test("tail returns trimmed input when within the limit", () => {
  assertEquals(tail("  hi  ", 100), "  hi");
});

Deno.test("render args reject fps <= 0 and non-integer fps", () => {
  const render = model.methods.render;
  assertThrows(() => render.arguments.parse({ script: "x", fps: 0 }));
  assertThrows(() => render.arguments.parse({ script: "x", fps: -5 }));
  assertThrows(() => render.arguments.parse({ script: "x", fps: 1.5 }));
});

Deno.test("render args reject an empty scene name inside the list", () => {
  const render = model.methods.render;
  assertThrows(() => render.arguments.parse({ script: "x", sceneNames: [""] }));
});

Deno.test("extraArgs passthrough is preserved verbatim", () => {
  const render = model.methods.render;
  const parsed = render.arguments.parse({
    script: "x",
    extraArgs: ["--disable_caching", "--flush_cache"],
  });
  assertEquals(parsed.extraArgs, ["--disable_caching", "--flush_cache"]);
});
