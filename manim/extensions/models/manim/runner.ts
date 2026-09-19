/**
 * Infrastructure layer for @magistr/manim/scene.
 *
 * Owns the subprocess and filesystem seams behind injectable interfaces so
 * the render orchestration is unit-testable without spawning `manim` or
 * touching disk. {@link renderScene} builds the argv, runs the CLI, discovers
 * the produced artifact, and returns its bytes; it fails closed with a named
 * error on a non-zero exit or a missing output.
 *
 * @module
 */

import {
  buildRenderArgs,
  type FileEntry,
  type Format,
  type Quality,
  selectOutputFile,
  tail,
} from "./types.ts";

/** Result of one subprocess invocation. */
export interface RunResult {
  /** Process exit code. */
  code: number;
  /** Captured stdout, decoded as UTF-8. */
  stdout: string;
  /** Captured stderr, decoded as UTF-8. */
  stderr: string;
}

/** Runs a command and returns its captured output. Injected for testing. */
export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<RunResult>;

/** Default {@link CommandRunner} backed by `Deno.Command`. */
export const defaultRunner: CommandRunner = async (bin, args, opts) => {
  const command = new Deno.Command(bin, {
    args,
    cwd: opts?.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
};

/** Filesystem seam used by {@link renderScene}. Injected for testing. */
export interface RenderIo {
  /** Create a fresh temp directory and return its path. */
  makeTempDir: () => Promise<string>;
  /** Write text content to a path. */
  writeTextFile: (path: string, content: string) => Promise<void>;
  /** Recursively list files under a directory as {@link FileEntry}. */
  walkFiles: (dir: string) => Promise<FileEntry[]>;
  /** Read a file's bytes. */
  readFile: (path: string) => Promise<Uint8Array>;
  /** Remove a directory tree, ignoring errors. */
  removeDir: (dir: string) => Promise<void>;
}

/** Default {@link RenderIo} backed by Deno's filesystem APIs. */
export const defaultIo: RenderIo = {
  makeTempDir: () => Deno.makeTempDir({ prefix: "swamp-manim-" }),
  writeTextFile: (path, content) => Deno.writeTextFile(path, content),
  walkFiles: async (dir) => {
    const entries: FileEntry[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for await (const entry of Deno.readDir(current)) {
        const path = `${current}/${entry.name}`;
        if (entry.isDirectory) {
          stack.push(path);
        } else if (entry.isFile) {
          const info = await Deno.stat(path);
          entries.push({
            path,
            mtimeMs: info.mtime?.getTime() ?? 0,
            size: info.size,
          });
        }
      }
    }
    return entries;
  },
  readFile: (path) => Deno.readFile(path),
  removeDir: async (dir) => {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  },
};

/** Parameters for {@link renderScene}. */
export interface RenderInput {
  /** Command prefix; first element is the binary, rest are wrapper args. */
  command: string[];
  /** Python source of the manim scene(s). */
  script: string;
  /** Scene class names to render; empty renders all scenes. */
  sceneNames: string[];
  /** Render quality. */
  quality: Quality;
  /** Output container format. */
  format: Format;
  /** Optional `--resolution` value, e.g. `"1920,1080"`. */
  resolution?: string;
  /** Optional frame rate. */
  fps?: number;
  /** Transparent background. */
  transparent: boolean;
  /** Extra raw CLI arguments. */
  extraArgs: string[];
}

/** Successful render outcome with the produced artifact's bytes. */
export interface RenderOutcome {
  /** Process exit code (always 0 on success). */
  exitCode: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Bytes of the produced artifact. */
  outputBytes: Uint8Array;
  /** Path (inside the temp media dir) of the produced artifact. */
  outputPath: string;
  /** Wall-clock render duration in milliseconds. */
  durationMs: number;
}

/** Raised when the manim CLI fails or produces no matching output. */
export class ManimRenderError extends Error {
  /** Exit code of the failed invocation, when one was produced. */
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ManimRenderError";
    this.exitCode = exitCode;
  }
}

/**
 * Render a manim scene: write the script to a temp workspace, invoke the CLI
 * headless, discover the produced artifact, and return its bytes. Always
 * cleans up the temp workspace. Throws {@link ManimRenderError} on a non-zero
 * exit or when no artifact matching the requested format is produced.
 */
export async function renderScene(
  run: CommandRunner,
  input: RenderInput,
  io: RenderIo = defaultIo,
): Promise<RenderOutcome> {
  if (input.command.length === 0) {
    throw new ManimRenderError("command prefix is empty", -1);
  }
  const started = Date.now();
  const workDir = await io.makeTempDir();
  const scriptPath = `${workDir}/scene.py`;
  const mediaDir = `${workDir}/media`;
  try {
    await io.writeTextFile(scriptPath, input.script);

    const [bin, ...prefix] = input.command;
    const args = [
      ...prefix,
      ...buildRenderArgs({
        scriptPath,
        sceneNames: input.sceneNames,
        quality: input.quality,
        format: input.format,
        mediaDir,
        resolution: input.resolution,
        fps: input.fps,
        transparent: input.transparent,
        extraArgs: input.extraArgs,
      }),
    ];

    const result = await run(bin, args, { cwd: workDir });
    if (result.code !== 0) {
      throw new ManimRenderError(
        `manim exited ${result.code}: ${tail(result.stderr || result.stdout)}`,
        result.code,
      );
    }

    const files = await io.walkFiles(mediaDir);
    const chosen = selectOutputFile(files, input.format);
    if (!chosen) {
      throw new ManimRenderError(
        `manim exited 0 but produced no ${input.format} file under the ` +
          `media dir; stderr: ${tail(result.stderr)}`,
        0,
      );
    }

    const outputBytes = await io.readFile(chosen.path);
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      outputBytes,
      outputPath: chosen.path,
      durationMs: Date.now() - started,
    };
  } finally {
    await io.removeDir(workDir);
  }
}
