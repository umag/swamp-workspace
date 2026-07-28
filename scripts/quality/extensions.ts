/**
 * The ONE definition of "what is an extension" in this repo: any top-level
 * directory containing a manifest.yaml. This mirrors .github/workflows/ci.yml's
 * `discover` job glob (`for m in <dir>/manifest.yaml; ...`) exactly — see
 * extensions.test.ts's parity assertion, which re-derives the CI job's glob
 * from disk and asserts the two sets are identical, so the two definitions
 * of "an extension" can never silently diverge (the exact HIGH finding
 * round-1 plan review raised against a second, subtly different scanner).
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

export interface DiscoverOptions {
  /** Repo root to scan. Defaults to two levels up from this file
   * (scripts/quality/ -> scripts/ -> repo root). */
  root?: string;
}

function defaultRoot(): string {
  return join(dirname(fromFileUrl(import.meta.url)), "..", "..");
}

/**
 * List every extension directory name (sorted) under `root` that has a
 * manifest.yaml. Read-only; does not touch quality.yaml or any other file.
 * Excludes dot-directories, matching bash's `<dir>/manifest.yaml` glob
 * (which does not match dot-directories by default).
 */
export async function listExtensions(
  options: DiscoverOptions = {},
): Promise<string[]> {
  const root = options.root ?? defaultRoot();
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    if (entry.name.startsWith(".")) continue;
    try {
      const stat = await Deno.stat(join(root, entry.name, "manifest.yaml"));
      if (stat.isFile) names.push(entry.name);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return names.sort();
}
