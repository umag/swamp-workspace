/**
 * Tests for the AllowlistGuard domain service: the shrink-only monotonicity
 * guard over quality-allowlist.txt, cross-checked against the immutable
 * quality-offenders.baseline.txt and against each extension's quality.yaml
 * backlog declarations so the two sources of truth cannot drift apart.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  checkAllowlist,
  checkBaselineImmutable,
  readAllowlist,
} from "./check_allowlist.ts";

async function git(root: string, ...args: string[]) {
  const cmd = new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

async function makeGitRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-git-" });
  await git(root, "init", "-q", "-b", "master");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  return root;
}

Deno.test("readAllowlist strips comment lines and blank lines", async () => {
  const dir = await Deno.makeTempDir({ prefix: "quality-allowlist-read-" });
  try {
    const path = join(dir, "quality-allowlist.txt");
    await Deno.writeTextFile(
      path,
      "# header comment\n\nalpha\n  beta  \n# another comment\ngamma\n",
    );
    const set = await readAllowlist(path);
    assertEquals([...set].sort(), ["alpha", "beta", "gamma"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readAllowlist returns an empty set when the file does not exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "quality-allowlist-read-" });
  try {
    const set = await readAllowlist(join(dir, "does-not-exist.txt"));
    assertEquals(set.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkAllowlist flags an allowlist entry that is NOT in the baseline (growth)", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-check-" });
  try {
    await Deno.writeTextFile(
      join(root, "quality-allowlist.txt"),
      "alpha\nbeta\n",
    );
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "alpha\n",
    );
    const { violations } = await checkAllowlist(root);
    assert(
      violations.some((v) =>
        v.rule === "allowlist-growth" && v.what.includes("beta")
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAllowlist passes when the allowlist is a subset of the baseline", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-check-" });
  try {
    await Deno.writeTextFile(
      join(root, "quality-allowlist.txt"),
      "alpha\n",
    );
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "alpha\nbeta\n",
    );
    const { violations } = await checkAllowlist(root);
    assertEquals(
      violations.filter((v) => v.rule === "allowlist-growth"),
      [],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable is silent when the baseline is unchanged since merge-base", async () => {
  const root = await makeGitRepo();
  try {
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\nbeta\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "seed baseline");
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable flags a line ADDED to the baseline vs merge-base", async () => {
  const root = await makeGitRepo();
  try {
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "seed baseline");
    await git(root, "checkout", "-q", "-b", "feature");
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\nsneaky-addition\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "tamper with baseline");
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assert(violations.length > 0);
    assert(violations.some((v) => v.what.includes("sneaky-addition")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable tolerates a SEED-RACE correction (extension existed at merge-base without a quality.yaml)", async () => {
  // The race this exception exists for: an extension merged to master via a
  // branch cut BEFORE the gate landed, so the baseline was seeded from a
  // stale snapshot. Adding that extension's line together with its first
  // quality.yaml is a seed correction, not growth.
  const root = await makeGitRepo();
  try {
    await Deno.mkdir(join(root, "raced-ext"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "raced-ext", "manifest.yaml"),
      "name: raced-ext\n",
    );
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\n",
    );
    await git(root, "add", "-A");
    await git(
      root,
      "commit",
      "-q",
      "-m",
      "raced-ext exists, ungated; baseline seeded without it",
    );
    await git(root, "checkout", "-q", "-b", "fix");
    await Deno.writeTextFile(
      join(root, "raced-ext", "quality.yaml"),
      "schemaVersion: 1\nextension: raced-ext\n",
    );
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\nraced-ext\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "seed-race correction");
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable still flags an added line for an extension ALREADY GATED at merge-base", async () => {
  // The seed-race exception must not open a hole for regressing an
  // already-gated extension back onto the baseline.
  const root = await makeGitRepo();
  try {
    await Deno.mkdir(join(root, "gated-ext"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "gated-ext", "manifest.yaml"),
      "name: gated-ext\n",
    );
    await Deno.writeTextFile(
      join(root, "gated-ext", "quality.yaml"),
      "schemaVersion: 1\nextension: gated-ext\n",
    );
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\n",
    );
    await git(root, "add", "-A");
    await git(
      root,
      "commit",
      "-q",
      "-m",
      "gated-ext fully gated; baseline seeded",
    );
    await git(root, "checkout", "-q", "-b", "feature");
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\ngated-ext\n",
    );
    await git(root, "add", "-A");
    await git(
      root,
      "commit",
      "-q",
      "-m",
      "attempt to regress gated-ext onto the baseline",
    );
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assert(violations.length > 0);
    assert(violations.some((v) => v.what.includes("gated-ext")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable does not flag a line REMOVED from the baseline (shrink is fine)", async () => {
  const root = await makeGitRepo();
  try {
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\nbeta\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "seed baseline");
    await git(root, "checkout", "-q", "-b", "feature");
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\n",
    );
    await git(root, "add", "-A");
    await git(
      root,
      "commit",
      "-q",
      "-m",
      "shrink is allowed for the allowlist, not the baseline, but must not false-fail here either",
    );
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable does NOT flag the SEED commit itself (file absent at merge-base entirely)", async () => {
  // The exact bootstrapping case: the PR that introduces
  // quality-offenders.baseline.txt for the first time necessarily adds
  // every line as a "+" in a naive diff — that must never be treated as
  // "growth", or the gate would reject its own seeding PR.
  const root = await makeGitRepo();
  try {
    await Deno.writeTextFile(join(root, "README.md"), "seed\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "repo exists, no baseline yet");
    await git(root, "checkout", "-q", "-b", "feature");
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "# immutable baseline\nalpha\nbeta\ngamma\n",
    );
    await git(root, "add", "-A");
    await git(
      root,
      "commit",
      "-q",
      "-m",
      "seed the baseline for the first time",
    );
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkBaselineImmutable degrades to no-violation (not a crash) when there is no git history at all", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-nogit-" });
  try {
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "alpha\n",
    );
    const violations = await checkBaselineImmutable(
      root,
      "quality-offenders.baseline.txt",
      "master",
    );
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAllowlist flags a backlog offender that is missing from the allowlist", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-cross-" });
  try {
    await Deno.mkdir(join(root, "beta"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "beta", "manifest.yaml"),
      "name: beta\n",
    );
    await Deno.writeTextFile(
      join(root, "beta", "quality.yaml"),
      `
schemaVersion: 1
extension: beta
tests:
  contract-fixture: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  methods: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  adversarial: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  coverage: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  property-invariant-flow: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
watch: { state: na, justification: "no external dependency to watch here" }
canary: { state: na, justification: "no live instance exists for this one" }
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: na, justification: "unreleased, no changelog needed yet" }
  skill: { state: na, justification: "bundles no Claude skill whatsoever" }
ratchet: { rubricVersion: 3, baselinePercentage: 40, label: "Grade C" }
`,
    );
    await Deno.writeTextFile(join(root, "quality-allowlist.txt"), "");
    await Deno.writeTextFile(join(root, "quality-offenders.baseline.txt"), "");
    const { violations } = await checkAllowlist(root);
    assert(violations.some((v) => v.rule === "offender-not-allowlisted"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAllowlist flags a fully-compliant extension still left on the allowlist (stale entry)", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-stale-" });
  try {
    await Deno.mkdir(join(root, "gamma"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "gamma", "manifest.yaml"),
      "name: gamma\n",
    );
    await Deno.writeTextFile(
      join(root, "gamma", "quality.yaml"),
      `
schemaVersion: 1
extension: gamma
tests:
  contract-fixture: { state: present, files: ["a_test.ts"] }
  methods: { state: present, files: ["a_test.ts"] }
  adversarial: { state: present, files: ["a_test.ts"] }
  coverage: { state: present, files: ["a_test.ts"] }
  property-invariant-flow: { state: present, files: ["a_test.ts"] }
watch: { state: na, justification: "no external dependency to watch here" }
canary: { state: na, justification: "no live instance exists for this one" }
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: na, justification: "unreleased, no changelog needed yet" }
  skill: { state: na, justification: "bundles no Claude skill whatsoever" }
ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" }
`,
    );
    await Deno.writeTextFile(join(root, "quality-allowlist.txt"), "gamma\n");
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "gamma\n",
    );
    const { violations } = await checkAllowlist(root);
    assert(violations.some((v) => v.rule === "allowlist-stale-entry"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAllowlist gives every violation a non-empty WHAT/WHY/FIX shape", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-shape-" });
  try {
    await Deno.writeTextFile(
      join(root, "quality-allowlist.txt"),
      "alpha\nbeta\n",
    );
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "alpha\n",
    );
    const { violations } = await checkAllowlist(root);
    assert(violations.length > 0);
    for (const v of violations) {
      assert(v.what.length > 0, "missing WHAT");
      assert(v.why.length > 0, "missing WHY");
      assert(v.fix.length > 0, "missing FIX");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check_allowlist.ts --help exits 0 with non-empty usage output", async () => {
  const scriptUrl = new URL("./check_allowlist.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run=git",
      scriptUrl.pathname,
      "--help",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("check_allowlist.ts --json <path> writes a machine-parseable summary (CI reporting)", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-allowlist-cli-" });
  try {
    await Deno.writeTextFile(join(root, "quality-allowlist.txt"), "alpha\n");
    await Deno.writeTextFile(
      join(root, "quality-offenders.baseline.txt"),
      "alpha\n",
    );
    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./check_allowlist.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=git",
        "--allow-env",
        scriptUrl.pathname,
        "--json",
        jsonPath,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    assertEquals(code, 0);
    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
