import { assertEquals } from "jsr:@std/assert@1";
import {
  buildRenderArgs,
  type FileEntry,
  formatExtension,
  qualityLetter,
  selectOutputFile,
  tail,
} from "./types.ts";

Deno.test("qualityLetter maps every quality to its CLI letter", () => {
  assertEquals(qualityLetter("low"), "l");
  assertEquals(qualityLetter("medium"), "m");
  assertEquals(qualityLetter("high"), "h");
  assertEquals(qualityLetter("production"), "p");
  assertEquals(qualityLetter("fourk"), "k");
});

Deno.test("formatExtension prefixes a dot", () => {
  assertEquals(formatExtension("mp4"), ".mp4");
  assertEquals(formatExtension("gif"), ".gif");
});

Deno.test("buildRenderArgs renders named scenes with flags in order", () => {
  const args = buildRenderArgs({
    scriptPath: "/tmp/scene.py",
    sceneNames: ["Intro", "Outro"],
    quality: "high",
    format: "mp4",
    mediaDir: "/tmp/media",
    resolution: "1920,1080",
    fps: 60,
    transparent: true,
    extraArgs: ["--disable_caching"],
  });
  assertEquals(args, [
    "render",
    "--quality",
    "h",
    "--format",
    "mp4",
    "--media_dir",
    "/tmp/media",
    "--resolution",
    "1920,1080",
    "--fps",
    "60",
    "--transparent",
    "--disable_caching",
    "/tmp/scene.py",
    "Intro",
    "Outro",
  ]);
});

Deno.test("buildRenderArgs uses -a (headless) when no scene is named", () => {
  const args = buildRenderArgs({
    scriptPath: "/tmp/scene.py",
    sceneNames: [],
    quality: "medium",
    format: "gif",
    mediaDir: "/tmp/media",
    transparent: false,
    extraArgs: [],
  });
  assertEquals(args, [
    "render",
    "--quality",
    "m",
    "--format",
    "gif",
    "--media_dir",
    "/tmp/media",
    "/tmp/scene.py",
    "-a",
  ]);
});

Deno.test("buildRenderArgs omits optional flags when absent", () => {
  const args = buildRenderArgs({
    scriptPath: "/s.py",
    sceneNames: ["S"],
    quality: "low",
    format: "webm",
    mediaDir: "/m",
    transparent: false,
    extraArgs: [],
  });
  assertEquals(args.includes("--resolution"), false);
  assertEquals(args.includes("--fps"), false);
  assertEquals(args.includes("--transparent"), false);
});

Deno.test("selectOutputFile picks newest matching-format file", () => {
  const files: FileEntry[] = [
    { path: "/m/videos/S/480p15/S.mp4", mtimeMs: 100, size: 10 },
    { path: "/m/videos/S/480p15/partial.mp4", mtimeMs: 300, size: 20 },
    { path: "/m/images/S/S.png", mtimeMs: 999, size: 5 },
  ];
  assertEquals(
    selectOutputFile(files, "mp4")?.path,
    "/m/videos/S/480p15/partial.mp4",
  );
});

Deno.test("selectOutputFile breaks mtime ties by size", () => {
  const files: FileEntry[] = [
    { path: "/a.gif", mtimeMs: 5, size: 1 },
    { path: "/b.gif", mtimeMs: 5, size: 9 },
  ];
  assertEquals(selectOutputFile(files, "gif")?.path, "/b.gif");
});

Deno.test("selectOutputFile returns null when nothing matches", () => {
  const files: FileEntry[] = [{ path: "/a.log", mtimeMs: 1, size: 1 }];
  assertEquals(selectOutputFile(files, "mp4"), null);
});

Deno.test("tail keeps the end and marks truncation", () => {
  assertEquals(tail("hello", 10), "hello");
  assertEquals(tail("abcdef", 3), "…def");
});
