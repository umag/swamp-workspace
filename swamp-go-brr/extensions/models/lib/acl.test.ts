// Tests for the shared path-ACL kernel (lib/acl.ts).
// Pure string helpers (normalizePath/pathInSet/pathEscapes) are extracted from
// gobrr.ts and must keep IDENTICAL behaviour (gobrr.deriveGate depends on them).
// resolveWithinRepo/isDeniedPath are the NEW apply-time FS-level guards; they are
// tested against a real /tmp fixture (deterministic, no external deps).
import {
  isDeniedPath,
  normalizePath,
  pathEscapes,
  pathInSet,
  resolveWithinRepo,
} from "./acl.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
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
