/**
 * Unit tests for the `resolveStlPath` path-confinement guard.
 *
 * Always-on: rejects non-absolute paths and any `.`/`..` traversal segment
 * BEFORE touching the filesystem, then canonicalizes via `Deno.realPath`.
 * Opt-in: when `allowedRoots` is non-empty, the canonicalized target must
 * fall under one of the canonicalized roots (separator-boundary prefix
 * match), closing both the `/rootFOO`-vs-`/root` prefix-collision and
 * symlinked-root/target cases.
 *
 * All fixture content is synthetic, built in per-test temp directories — see
 * fixtures/PROVENANCE.md.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PathPolicyError, resolveStlPath } from "./safe_path.ts";

// ---------------------------------------------------------------------------
// Always-on: non-absolute / traversal rejection (runs BEFORE realPath)
// ---------------------------------------------------------------------------

Deno.test("resolveStlPath: rejects a relative path", async () => {
  await assertRejects(
    () => resolveStlPath("relative/part.stl"),
    PathPolicyError,
    "absolute",
  );
});

Deno.test("resolveStlPath: rejects a path containing a '..' traversal segment, even when the target does not exist (ordering: traversal check runs before realPath)", async () => {
  const root = await Deno.makeTempDir({ prefix: "safe-path-trav-" });
  try {
    const traversalPath = `${root}/allowed/../does-not-exist.stl`;
    const err = await assertRejects(
      () => resolveStlPath(traversalPath),
      PathPolicyError,
    );
    // Must be the traversal policy error, NOT a realPath NotFound — proves
    // the '.'/'..' check runs before any filesystem access.
    assertEquals((err as Error).message.includes("segment"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveStlPath: rejects a path containing a '.' segment", async () => {
  const root = await Deno.makeTempDir({ prefix: "safe-path-dot-" });
  try {
    await assertRejects(
      () => resolveStlPath(`${root}/./part.stl`),
      PathPolicyError,
      "segment",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveStlPath: a missing (but clean, absolute) path propagates the underlying filesystem error, NOT a PathPolicyError", async () => {
  const root = await Deno.makeTempDir({ prefix: "safe-path-missing-" });
  try {
    const missing = `${root}/does-not-exist.stl`;
    let caught: unknown;
    try {
      await resolveStlPath(missing);
    } catch (err) {
      caught = err;
    }
    assertEquals(caught instanceof PathPolicyError, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Always-on: clean absolute path accepted, canonicalized
// ---------------------------------------------------------------------------

Deno.test("resolveStlPath: accepts a clean absolute path to an existing file and returns its canonical realpath", async () => {
  const root = await Deno.makeTempDir({ prefix: "safe-path-clean-" });
  try {
    const filePath = `${root}/part.stl`;
    await Deno.writeFile(filePath, new Uint8Array([1, 2, 3]));
    const resolved = await resolveStlPath(filePath);
    assertEquals(resolved, await Deno.realPath(filePath));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Opt-in: allowedRoots confinement
// ---------------------------------------------------------------------------

Deno.test("resolveStlPath: with allowedRoots set, accepts a file inside a configured root", async () => {
  const root = await Deno.makeTempDir({ prefix: "safe-path-root-" });
  try {
    const filePath = `${root}/part.stl`;
    await Deno.writeFile(filePath, new Uint8Array([1, 2, 3]));
    const resolved = await resolveStlPath(filePath, [root]);
    assertEquals(resolved, await Deno.realPath(filePath));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveStlPath: with allowedRoots set, rejects a file outside every configured root", async () => {
  const allowed = await Deno.makeTempDir({ prefix: "safe-path-allowed-" });
  const outside = await Deno.makeTempDir({ prefix: "safe-path-outside-" });
  try {
    const filePath = `${outside}/secret.stl`;
    await Deno.writeFile(filePath, new Uint8Array([1, 2, 3]));
    await assertRejects(
      () => resolveStlPath(filePath, [allowed]),
      PathPolicyError,
      "allowedRoots",
    );
  } finally {
    await Deno.remove(allowed, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("resolveStlPath: separator-boundary containment — a sibling directory sharing a name prefix (rootFOO) does NOT satisfy an allowedRoot of root", async () => {
  const base = await Deno.makeTempDir({ prefix: "safe-path-prefix-" });
  try {
    const root = `${base}/root`;
    const rootFoo = `${base}/rootFOO`;
    await Deno.mkdir(root, { recursive: true });
    await Deno.mkdir(rootFoo, { recursive: true });
    const filePath = `${rootFoo}/part.stl`;
    await Deno.writeFile(filePath, new Uint8Array([1, 2, 3]));
    await assertRejects(
      () => resolveStlPath(filePath, [root]),
      PathPolicyError,
      "allowedRoots",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("resolveStlPath: rejects a symlink inside an allowedRoot that points OUTSIDE it", async () => {
  const allowed = await Deno.makeTempDir({ prefix: "safe-path-symroot-" });
  const outside = await Deno.makeTempDir({ prefix: "safe-path-symout-" });
  try {
    const secretPath = `${outside}/secret.stl`;
    await Deno.writeFile(secretPath, new Uint8Array([1, 2, 3]));
    const escapeLink = `${allowed}/escape.stl`;
    await Deno.symlink(secretPath, escapeLink);
    await assertRejects(
      () => resolveStlPath(escapeLink, [allowed]),
      PathPolicyError,
      "allowedRoots",
    );
  } finally {
    await Deno.remove(allowed, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("resolveStlPath: canonicalizes both the configured root and the target, so a raw (pre-canonicalization) root/target pair still matches after resolution", async () => {
  // `Deno.makeTempDir()` itself may return a path through a symlinked
  // ancestor (e.g. macOS `/var` -> `/private/var`). Configure the RAW
  // (non-canonical) root and target strings — resolveStlPath must
  // canonicalize both sides before comparing, so this still succeeds.
  const root = await Deno.makeTempDir({ prefix: "safe-path-canon-" });
  try {
    const filePath = `${root}/part.stl`;
    await Deno.writeFile(filePath, new Uint8Array([1, 2, 3]));
    const resolved = await resolveStlPath(filePath, [root]);
    assertEquals(resolved, await Deno.realPath(filePath));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Empty allowedRoots (default) preserves the unconfined contract
// ---------------------------------------------------------------------------

Deno.test("resolveStlPath: with no allowedRoots (default []), any clean absolute existing path resolves — the default contract is unconfined", async () => {
  const rootA = await Deno.makeTempDir({ prefix: "safe-path-unconf-a-" });
  const rootB = await Deno.makeTempDir({ prefix: "safe-path-unconf-b-" });
  try {
    const fileA = `${rootA}/part.stl`;
    const fileB = `${rootB}/part.stl`;
    await Deno.writeFile(fileA, new Uint8Array([1]));
    await Deno.writeFile(fileB, new Uint8Array([2]));
    assertEquals(await resolveStlPath(fileA), await Deno.realPath(fileA));
    assertEquals(await resolveStlPath(fileB), await Deno.realPath(fileB));
  } finally {
    await Deno.remove(rootA, { recursive: true });
    await Deno.remove(rootB, { recursive: true });
  }
});
