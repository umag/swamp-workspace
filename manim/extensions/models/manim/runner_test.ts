import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type CommandRunner,
  ManimRenderError,
  type RenderIo,
  renderScene,
  type RunResult,
} from "./runner.ts";
import type { FileEntry } from "./types.ts";

/** Records every invocation and answers from a scripted handler. */
function scriptedRunner(
  handler: (bin: string, args: string[]) => RunResult,
): { run: CommandRunner; calls: { bin: string; args: string[] }[] } {
  const calls: { bin: string; args: string[] }[] = [];
  const run: CommandRunner = (bin, args) => {
    calls.push({ bin, args });
    return Promise.resolve(handler(bin, args));
  };
  return { run, calls };
}

/** In-memory RenderIo: no disk, configurable discovered files. */
function fakeIo(files: FileEntry[], bytes = new Uint8Array([1, 2, 3])): {
  io: RenderIo;
  writes: { path: string; content: string }[];
  removed: string[];
} {
  const writes: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const io: RenderIo = {
    makeTempDir: () => Promise.resolve("/work"),
    writeTextFile: (path, content) => {
      writes.push({ path, content });
      return Promise.resolve();
    },
    walkFiles: () => Promise.resolve(files),
    readFile: () => Promise.resolve(bytes),
    removeDir: (dir) => {
      removed.push(dir);
      return Promise.resolve();
    },
  };
  return { io, writes, removed };
}

const baseInput = {
  command: ["manim"],
  script: "from manim import *\nclass S(Scene): pass\n",
  sceneNames: ["S"],
  quality: "medium" as const,
  format: "mp4" as const,
  transparent: false,
  extraArgs: [],
};

Deno.test("renderScene writes script, runs CLI, returns artifact bytes", async () => {
  const { run, calls } = scriptedRunner(() => ({
    code: 0,
    stdout: "done",
    stderr: "",
  }));
  const bytes = new Uint8Array([9, 8, 7]);
  const { io, writes, removed } = fakeIo(
    [{ path: "/work/media/videos/S/720p30/S.mp4", mtimeMs: 5, size: 3 }],
    bytes,
  );

  const outcome = await renderScene(run, baseInput, io);

  assertEquals(outcome.exitCode, 0);
  assertEquals(outcome.outputBytes, bytes);
  assertEquals(outcome.outputPath, "/work/media/videos/S/720p30/S.mp4");
  assertEquals(writes[0].path, "/work/scene.py");
  assertEquals(calls[0].bin, "manim");
  assertEquals(calls[0].args[0], "render");
  assertEquals(calls[0].args.includes("/work/media"), true);
  assertEquals(removed, ["/work"]); // temp dir cleaned up
});

Deno.test("renderScene threads a wrapper command prefix", async () => {
  const { run, calls } = scriptedRunner(() => ({
    code: 0,
    stdout: "",
    stderr: "",
  }));
  const { io } = fakeIo([{ path: "/work/media/S.mp4", mtimeMs: 1, size: 1 }]);

  await renderScene(run, { ...baseInput, command: ["uvx", "manim"] }, io);

  assertEquals(calls[0].bin, "uvx");
  assertEquals(calls[0].args[0], "manim"); // wrapper arg precedes "render"
  assertEquals(calls[0].args[1], "render");
});

Deno.test("renderScene throws with stderr tail on non-zero exit", async () => {
  const { run } = scriptedRunner(() => ({
    code: 1,
    stdout: "",
    stderr: "NameError: Scene not found",
  }));
  const { io, removed } = fakeIo([]);

  const err = await assertRejects(
    () => renderScene(run, baseInput, io),
    ManimRenderError,
    "manim exited 1",
  );
  assertEquals((err as ManimRenderError).exitCode, 1);
  assertEquals(removed, ["/work"]); // cleanup still runs
});

Deno.test("renderScene throws when CLI exits 0 but produces no output", async () => {
  const { run } = scriptedRunner(() => ({
    code: 0,
    stdout: "",
    stderr: "warn",
  }));
  const { io } = fakeIo([{ path: "/work/media/S.log", mtimeMs: 1, size: 1 }]);

  await assertRejects(
    () => renderScene(run, baseInput, io),
    ManimRenderError,
    "produced no mp4 file",
  );
});

Deno.test("renderScene rejects an empty command prefix", async () => {
  const { run } = scriptedRunner(() => ({ code: 0, stdout: "", stderr: "" }));
  const { io } = fakeIo([]);
  await assertRejects(
    () => renderScene(run, { ...baseInput, command: [] }, io),
    ManimRenderError,
    "command prefix is empty",
  );
});
