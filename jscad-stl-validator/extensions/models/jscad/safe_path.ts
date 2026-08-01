// Infrastructure guard: confines validateFile's operator-supplied absolute
// path input. Self-contained (no jsr:@std/path dependency, matching the
// project's existing path-ACL convention) — plain string operations plus
// Deno.realPath only.
//
// ALWAYS-ON (regardless of allowedRoots):
//  1. filePath must be absolute.
//  2. filePath must contain no literal '.' or '..' path segment. This check
//     runs BEFORE canonicalization, so a traversal path to a nonexistent
//     target is rejected as a policy violation, never masked by a
//     filesystem NotFound from Deno.realPath.
//  3. Canonicalize via Deno.realPath (resolves symlinks).
//
// OPT-IN (only when allowedRoots is non-empty):
//  4. Each configured root is canonicalized via Deno.realPath.
//  5. The canonical target must fall under at least one canonical root,
//     using a separator-boundary prefix match (real === root ||
//     real.startsWith(root + SEP)) — this closes both the /rootFOO-vs-/root
//     prefix-collision and the symlinked-root case.
//
// Error messages are always keyed to the ORIGINAL caller-supplied filePath
// (never the canonicalized path), with a "Refusing to read" prefix distinct
// from the "Cannot read" prefix validateFile uses for filesystem errors —
// so callers/tests can tell a policy violation from an FS failure.

const SEP = "/";

/** Thrown for policy violations (non-absolute, traversal, outside allowedRoots). */
export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** True if `path` contains a literal '.' or '..' path segment. */
function hasDotSegment(path: string): boolean {
  return path.split(SEP).some((seg) => seg === "." || seg === "..");
}

/** Separator-boundary prefix match: real === root, or real is strictly under root. */
function isUnderRoot(real: string, root: string): boolean {
  return real === root || real.startsWith(root + SEP);
}

/**
 * Resolve `filePath` to a canonical absolute path safe to read.
 *
 * @param filePath Caller-supplied absolute path to an STL file.
 * @param allowedRoots Operator-set confinement roots (default `[]` — empty
 *   means unconfined, preserving the historical contract).
 * @returns The canonical (`Deno.realPath`-resolved) absolute path.
 * @throws {PathPolicyError} filePath is not absolute, contains a '.'/'..'
 *   segment, or (when allowedRoots is non-empty) resolves outside every
 *   configured root.
 * @throws Whatever `Deno.realPath` throws for a nonexistent path or other
 *   filesystem error (NOT wrapped — the caller wraps it into its own
 *   "Cannot read" message keyed to the original filePath).
 */
export async function resolveStlPath(
  filePath: string,
  allowedRoots: string[] = [],
): Promise<string> {
  if (!filePath.startsWith(SEP)) {
    throw new PathPolicyError(
      `Refusing to read "${filePath}": path must be absolute`,
    );
  }
  if (hasDotSegment(filePath)) {
    throw new PathPolicyError(
      `Refusing to read "${filePath}": path contains a '.' or '..' segment`,
    );
  }

  const real = await Deno.realPath(filePath);

  if (allowedRoots.length > 0) {
    const canonicalRoots = await Promise.all(
      allowedRoots.map((root) => Deno.realPath(root)),
    );
    const confined = canonicalRoots.some((root) => isUnderRoot(real, root));
    if (!confined) {
      throw new PathPolicyError(
        `Refusing to read "${filePath}": outside allowedRoots`,
      );
    }
  }

  return real;
}
