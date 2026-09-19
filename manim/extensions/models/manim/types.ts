/**
 * Domain layer for @magistr/manim/scene.
 *
 * Pure, side-effect-free helpers: the ManimCommunity CLI quality/format
 * vocabulary, the render-argv builder, and output-file selection. No swamp
 * I/O and no subprocess calls live here, so every function is unit-testable
 * without spawning `manim`.
 *
 * @module
 */

/** Render qualities, mapped to ManimCommunity `--quality` letters. */
export const QUALITIES = [
  "low",
  "medium",
  "high",
  "production",
  "fourk",
] as const;

/** One of {@link QUALITIES}. */
export type Quality = typeof QUALITIES[number];

/** Output container formats supported by ManimCommunity `--format`. */
export const FORMATS = ["mp4", "gif", "png", "webm"] as const;

/** One of {@link FORMATS}. */
export type Format = typeof FORMATS[number];

const QUALITY_LETTER: Record<Quality, string> = {
  low: "l", // 480p15
  medium: "m", // 720p30
  high: "h", // 1080p60
  production: "p", // 1440p60
  fourk: "k", // 2160p60
};

/** Return the ManimCommunity `--quality` letter (l/m/h/p/k) for a quality. */
export function qualityLetter(quality: Quality): string {
  return QUALITY_LETTER[quality];
}

/** Return the file extension (with leading dot) a format produces. */
export function formatExtension(format: Format): string {
  return `.${format}`;
}

/** Structured inputs for {@link buildRenderArgs}. */
export interface RenderArgsInput {
  /** Absolute path to the Python scene file. */
  scriptPath: string;
  /** Scene class names to render; empty renders all scenes (`-a`). */
  sceneNames: string[];
  /** Render quality. */
  quality: Quality;
  /** Output container format. */
  format: Format;
  /** Directory manim writes media into (`--media_dir`). */
  mediaDir: string;
  /** Optional `--resolution` value, e.g. `"1920,1080"`. */
  resolution?: string;
  /** Optional frame rate (`--fps`). */
  fps?: number;
  /** Render with a transparent background (`--transparent`). */
  transparent: boolean;
  /** Extra raw CLI arguments appended before the script path. */
  extraArgs: string[];
}

/**
 * Build the argv for a `manim render` invocation, excluding the command
 * prefix (the caller prepends the binary and any wrapper args).
 *
 * The result always starts with the `render` subcommand and always runs
 * headless: when no scene is named, `-a` renders every scene in the file
 * instead of manim prompting interactively.
 */
export function buildRenderArgs(input: RenderArgsInput): string[] {
  const args: string[] = ["render"];
  args.push("--quality", qualityLetter(input.quality));
  args.push("--format", input.format);
  args.push("--media_dir", input.mediaDir);
  if (input.resolution) args.push("--resolution", input.resolution);
  if (typeof input.fps === "number") args.push("--fps", String(input.fps));
  if (input.transparent) args.push("--transparent");
  for (const extra of input.extraArgs) args.push(extra);
  args.push(input.scriptPath);
  if (input.sceneNames.length === 0) {
    args.push("-a"); // render all scenes; headless-safe (no interactive prompt)
  } else {
    for (const scene of input.sceneNames) args.push(scene);
  }
  return args;
}

/** A discovered file under the media directory. */
export interface FileEntry {
  /** Absolute path to the file. */
  path: string;
  /** Modification time in epoch milliseconds. */
  mtimeMs: number;
  /** Size in bytes. */
  size: number;
}

/**
 * Choose the rendered artifact from files discovered under the media dir:
 * the newest (then largest) file whose extension matches the format.
 * Returns `null` when nothing matches — the caller fails closed.
 */
export function selectOutputFile(
  files: FileEntry[],
  format: Format,
): FileEntry | null {
  const ext = formatExtension(format).toLowerCase();
  const matches = files.filter((f) => f.path.toLowerCase().endsWith(ext));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return matches[0];
}

/** Keep the last `max` characters of a string, prefixed with an ellipsis. */
export function tail(text: string, max = 2000): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}
