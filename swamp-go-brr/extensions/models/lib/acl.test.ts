// Tests for the shared path-ACL kernel (lib/acl.ts).
// Pure string helpers (normalizePath/pathInSet/pathEscapes) are extracted from
// gobrr.ts and must keep IDENTICAL behaviour (gobrr.deriveGate depends on them).
// resolveWithinRepo/isDeniedPath are apply-time FS-level guards; safeWriteWithinRepo/
// confineWrittenPath (issue swamp-go-brr-latent-bugs B8) are the write-time TOCTOU
// hardening layered on top. All are tested against a real /tmp fixture
// (deterministic, no external deps).
import {
  confineWrittenPath,
  isDeniedPath,
  isUnsafePathError,
  normalizePath,
  pathEscapes,
  pathInSet,
  resolveWithinRepo,
  safeWriteWithinRepo,
} from "./acl.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => void, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert(
      String(e).includes(msg),
      `expected error to include "${msg}", got: ${e}`,
    );
  }
  assert(threw, `expected a throw containing "${msg}"`);
}

// ── pure string helpers (parity with gobrr.ts) ──────────────────────────────

Deno.test("normalizePath strips ./ and // and keeps .. markers for rejection", () => {
  assert(normalizePath("./a//b") === "a/b", "strip ./ and //");
  assert(normalizePath("a/../b").split("/").includes(".."), "keeps .. marker");
  assert(normalizePath("a/b/") === "a/b", "trailing slash collapsed");
});

Deno.test("pathInSet matches exact, dir-prefix, and trailing *", () => {
  assert(pathInSet("src/a.ts", ["src"]), "dir prefix");
  assert(pathInSet("src/a.ts", ["src/a.ts"]), "exact");
  assert(
    !pathInSet("srcfoo/a.ts", ["src"]),
    "prefix must be a tree boundary, not a substring",
  );
  assert(pathInSet("x/y.ts", ["x/*"]), "trailing star");
  assert(!pathInSet("other/a.ts", ["src"]), "disjoint");
});

Deno.test("pathEscapes flags traversal, absolute, whitespace", () => {
  assert(pathEscapes("../x"), "traversal");
  assert(pathEscapes("a/../../x"), "deep traversal");
  assert(pathEscapes("/etc/passwd"), "absolute");
  assert(pathEscapes("a b"), "whitespace");
  assert(!pathEscapes("src/a.ts"), "clean path ok");
});

// ── DENY set ────────────────────────────────────────────────────────────────

Deno.test("isDeniedPath rejects VCS/hook/CI control paths regardless of allowlist", () => {
  for (
    const p of [
      ".git/config",
      ".jj/repo/store",
      "sub/.git/hooks/pre-commit",
      "hooks/pre-commit",
      ".gitattributes",
      ".gitmodules",
      "src/.gitattributes",
      ".github/workflows/ci.yml",
    ]
  ) {
    assert(isDeniedPath(p), `must deny ${p}`);
  }
  for (const p of ["src/a.ts", "done/fix-train.txt", "install.sh"]) {
    assert(!isDeniedPath(p), `must allow ${p}`);
  }
});

// ── realpath-anchored resolution (FS fixture) ───────────────────────────────

Deno.test("resolveWithinRepo: accepts new file in a NEW subdir; rejects traversal/absolute", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    Deno.mkdirSync(`${root}/src`);
    // existing file
    Deno.writeTextFileSync(`${root}/src/a.ts`, "x");
    const ok1 = resolveWithinRepo(root, "src/a.ts");
    assert(ok1.ok && ok1.abs === `${root}/src/a.ts`, "existing file resolves");
    // new file in a brand-new subdir (deepest-existing-ancestor + lexical remainder)
    const ok2 = resolveWithinRepo(root, "src/newpkg/deep/b.ts");
    assert(
      ok2.ok && ok2.abs === `${root}/src/newpkg/deep/b.ts`,
      "new subdir accepted",
    );
    // traversal + absolute rejected before any FS touch
    assert(!resolveWithinRepo(root, "../escape").ok, "traversal rejected");
    assert(!resolveWithinRepo(root, "/etc/passwd").ok, "absolute rejected");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("resolveWithinRepo: rejects escape through a symlinked existing dir", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const outside = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    Deno.writeTextFileSync(`${outside}/secret`, "s");
    // links/ inside the repo points OUT of the repo
    Deno.symlinkSync(outside, `${root}/links`);
    const r = resolveWithinRepo(root, "links/secret");
    assert(!r.ok, "symlinked-dir escape must be rejected");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("resolveWithinRepo: rejects a leaf that is itself a symlink", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const outside = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    Deno.writeTextFileSync(`${outside}/t`, "t");
    Deno.symlinkSync(`${outside}/t`, `${root}/leaf`);
    const r = resolveWithinRepo(root, "leaf");
    assert(!r.ok, "symlink leaf must be rejected");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

// ── safeWriteWithinRepo / confineWrittenPath (issue swamp-go-brr-latent-bugs B8) ──

Deno.test("safeWriteWithinRepo: writes a new regular file and returns its absolute path", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    const abs = safeWriteWithinRepo(root, "src/newpkg/deep/b.ts", "content");
    assert(
      abs === `${root}/src/newpkg/deep/b.ts`,
      "must return the resolved absolute path",
    );
    assert(
      Deno.readTextFileSync(abs) === "content",
      "the file must actually be written",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("safeWriteWithinRepo: refuses when the FINAL path component already exists as a symlink (no-follow, via resolveWithinRepo)", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const outside = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    Deno.writeTextFileSync(`${outside}/real.txt`, "outside-original");
    Deno.symlinkSync(`${outside}/real.txt`, `${root}/leaf.txt`);
    assertThrows(
      () => safeWriteWithinRepo(root, "leaf.txt", "new content"),
      "symlink component",
    );
    assert(
      Deno.readTextFileSync(`${outside}/real.txt`) === "outside-original",
      "the write must be refused BEFORE it can follow the symlink through",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("safeWriteWithinRepo: refuses when a PARENT directory is a symlink pointing outside the repo", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const outside = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    Deno.symlinkSync(outside, `${root}/linked`);
    assertThrows(
      () => safeWriteWithinRepo(root, "linked/file.txt", "content"),
      "symlink component",
    );
    let existed = true;
    try {
      Deno.statSync(`${outside}/file.txt`);
    } catch {
      existed = false;
    }
    assert(!existed, "nothing must be written outside the repo");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("confineWrittenPath: a path that resolves WITHIN repoRoot is a no-op (no throw, no removal)", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    const abs = `${root}/ok.txt`;
    Deno.writeTextFileSync(abs, "fine");
    confineWrittenPath(root, abs); // must not throw
    assert(
      Deno.readTextFileSync(abs) === "fine",
      "a contained path must be left untouched",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("isUnsafePathError: distinguishes a safeWriteWithinRepo path-safety refusal from a generic error", () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    Deno.mkdirSync(`${root}/blocked`);
    let pathSafetyErr: unknown;
    try {
      safeWriteWithinRepo(root, "../escape", "x");
    } catch (e) {
      pathSafetyErr = e;
    }
    assert(
      pathSafetyErr !== undefined && isUnsafePathError(pathSafetyErr),
      "a traversal refusal must be classified as an unsafe-path error",
    );
    let fsErr: unknown;
    try {
      // "blocked" exists as a directory — writing a FILE there is a genuine
      // filesystem error (EISDIR-equivalent), not a path-safety refusal.
      safeWriteWithinRepo(root, "blocked", "x");
    } catch (e) {
      fsErr = e;
    }
    assert(
      fsErr !== undefined && !isUnsafePathError(fsErr),
      "a genuine filesystem error must NOT be classified as an unsafe-path error",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
