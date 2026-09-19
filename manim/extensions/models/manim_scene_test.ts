import {
  assertEquals,
  assertObjectMatch,
  assertThrows,
} from "jsr:@std/assert@1";
import { model, runRender } from "./manim_scene.ts";
import type { CommandRunner, RenderIo } from "./manim/runner.ts";
import type { FileEntry } from "./manim/types.ts";

const render = model.methods.render;

Deno.test("model metadata declares the expected type, specs, and version", () => {
  assertEquals(model.type, "@magistr/manim/scene");
  assertEquals(model.version, "2026.09.19.1");
  assertEquals(Object.keys(model.resources), ["result"]);
  assertEquals(Object.keys(model.files).sort(), ["log", "output"]);
});

Deno.test("global command defaults to ['manim'] and requires ≥1 element", () => {
  assertEquals(model.globalArguments.parse({}).command, ["manim"]);
  assertEquals(
    model.globalArguments.parse({ command: ["uvx", "manim"] }).command,
    ["uvx", "manim"],
  );
  assertThrows(() => model.globalArguments.parse({ command: [] }));
});

Deno.test("render args apply defaults", () => {
  const parsed = render.arguments.parse({ script: "x" });
  assertObjectMatch(parsed, {
    sceneNames: [],
    quality: "medium",
    format: "mp4",
    transparent: false,
    extraArgs: [],
  });
});

Deno.test("render args reject empty script and bad resolution", () => {
  assertThrows(() => render.arguments.parse({ script: "" }));
  assertThrows(() =>
    render.arguments.parse({ script: "x", resolution: "1920x1080" })
  );
  assertThrows(() => render.arguments.parse({ script: "x", quality: "ultra" }));
});

Deno.test("render args accept a valid full payload", () => {
  const parsed = render.arguments.parse({
    script: "from manim import *",
    sceneNames: ["Intro"],
    quality: "fourk",
    format: "webm",
    resolution: "3840,2160",
    fps: 30,
    transparent: true,
    extraArgs: ["--disable_caching"],
  });
  assertEquals(parsed.quality, "fourk");
  assertEquals(parsed.resolution, "3840,2160");
});

Deno.test("runRender writes output, log, and result on success", async () => {
  const bytes = new Uint8Array([4, 2]);
  const run: CommandRunner = () =>
    Promise.resolve({ code: 0, stdout: "rendered", stderr: "" });
  const files: FileEntry[] = [
    {
      path: "/work/media/videos/S/720p30/S.mp4",
      mtimeMs: 1,
      size: bytes.length,
    },
  ];
  const io: RenderIo = {
    makeTempDir: () => Promise.resolve("/work"),
    writeTextFile: () => Promise.resolve(),
    walkFiles: () => Promise.resolve(files),
    readFile: () => Promise.resolve(bytes),
    removeDir: () => Promise.resolve(),
  };

  const written: { spec: string; data?: Record<string, unknown> }[] = [];
  const ctx = {
    globalArgs: { command: ["manim"] },
    createFileWriter: (spec: string, _name: string) => ({
      writeAll: () => {
        written.push({ spec });
        return Promise.resolve({ name: spec });
      },
      writeText: () => {
        written.push({ spec });
        return Promise.resolve({ name: spec });
      },
    }),
    writeResource: (
      spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, data });
      return Promise.resolve({ name: spec });
    },
  };

  const result = await runRender(
    {
      script: "from manim import *\nclass S(Scene): pass\n",
      sceneNames: ["S"],
    },
    ctx,
    { run, io },
  );

  assertEquals(result.dataHandles.length, 3);
  assertEquals(written.map((w) => w.spec).sort(), ["log", "output", "result"]);
  const resultRow = written.find((w) => w.spec === "result");
  assertObjectMatch(resultRow!.data!, {
    success: true,
    format: "mp4",
    sizeBytes: bytes.length,
  });
});
