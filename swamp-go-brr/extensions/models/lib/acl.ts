// Shared path-ACL kernel for @magistr/swamp-go-brr.
//
// Two layers:
//  1. PURE string helpers (normalizePath/pathInSet/pathEscapes) — extracted
//     verbatim from gobrr.ts so gobrr.deriveGate keeps identical behaviour. These
//     do NO filesystem I/O; gobrr (a pure model) imports only these.
//  2. APPLY-TIME guards (isDeniedPath/resolveWithinRepo) — used by the
//     side-effectful source-integration model when it writes the jj tree. These
//     anchor every agent-supplied path to the real filesystem so a crafted path
//     cannot escape the repo via traversal, an absolute path, or a symlinked
//     parent. gobrr never calls these.

// ── 1. pure string helpers (parity with the originals in gobrr.ts) ───────────

/** Minimal glob/prefix match: exact, `dir/` prefix, or trailing `*`. */
export function pathInSet(path: string, globs: string[]): boolean {
  const p = normalizePath(path);
  return globs.some((g) => {
    const ng = normalizePath(g.replace(/\*+$/, ""));
    if (g.endsWith("*")) return p === ng || p.startsWith(ng);
    if (g.endsWith("/")) return p === ng || p.startsWith(ng);
    // treat a bare directory name as a tree prefix too
    return p === ng || p.startsWith(ng + "/");
  });
}

/** Canonicalize: strip `./`, collapse `//`, keep `..` markers for rejection. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\/+/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // escape attempt — keep the marker so callers reject it
      parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

export function pathEscapes(path: string): boolean {
  return normalizePath(path).split("/").includes("..") ||
    path.startsWith("/") || /\s/.test(path);
}

// ── 2. apply-time guards (filesystem-anchored) ───────────────────────────────

// Control paths an applied diff must never touch, regardless of the writeAllowlist:
// VCS metadata + hooks (a written hook is code execution), attribute/filter files
// (`.gitattributes` smudge/clean = command execution), and CI definitions.
const DENY_SEGMENTS = new Set([".git", ".jj", "hooks"]);
const DENY_BASENAMES = new Set([
  ".gitattributes",
  ".gitmodules",
  ".gitconfig",
  "gitconfig",
]);
const DENY_TOP_DIRS = new Set([".github", ".gitlab", ".circleci", ".ci"]);

/** True if a repo-relative path falls in the deny set (checked on the normalized form). */
export function isDeniedPath(relPath: string): boolean {
  const norm = normalizePath(relPath);
  if (norm === "") return true;
  const segs = norm.split("/");
  if (segs.some((s) => DENY_SEGMENTS.has(s))) return true;
  if (DENY_BASENAMES.has(segs[segs.length - 1])) return true;
  if (DENY_TOP_DIRS.has(segs[0])) return true;
  return false;
}

function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(root + "/");
}

/**
 * Resolve an agent-supplied repo-relative path to a safe absolute path under
 * `repoRoot` (which MUST already be an absolute realpath). Handles new files in
 * not-yet-existing subdirs: realpath the DEEPEST EXISTING ancestor (rejecting any
 * symlink component or escape), then lexically join the non-existent remainder
 * (which contains no symlinks because it does not exist) and re-assert
 * containment. Fail-closed on any lexical escape or symlinked component.
 */
export function resolveWithinRepo(
  repoRoot: string,
  relPath: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (pathEscapes(relPath)) {
    return {
      ok: false,
      reason: "path escapes (traversal/absolute/whitespace)",
    };
  }
  const norm = normalizePath(relPath);
  if (norm === "") return { ok: false, reason: "empty path" };
  const segs = norm.split("/");

  let existing = repoRoot;
  let i = 0;
  for (; i < segs.length; i++) {
    const candidate = existing + "/" + segs[i];
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(candidate);
    } catch {
      break; // this component does not exist yet — the rest is a new (lexical) tail
    }
    if (st.isSymlink) {
      return {
        ok: false,
        reason: `symlink component: ${segs.slice(0, i + 1).join("/")}`,
      };
    }
    existing = Deno.realPathSync(candidate);
    if (!isUnder(existing, repoRoot)) {
      return { ok: false, reason: "resolved component escapes repo" };
    }
  }
  const remainder = segs.slice(i);
  const abs = remainder.length
    ? existing + "/" + remainder.join("/")
    : existing;
  if (!isUnder(abs, repoRoot)) return { ok: false, reason: "escapes repo" };
  return { ok: true, abs };
}
