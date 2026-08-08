/**
 * Tests for scripts/changelog-section.sh. The script has ZERO tests today;
 * these pin the CONTRACT plan v4 step 1 requires (not yet implemented on
 * this branch, so every test below is expected to fail red until that step
 * lands). They drive the REAL script via `Deno.Command("bash", ...)` against
 * temp-dir fixtures — never a reimplementation — so they test the shipped
 * artifact, matching scripts/registry_drift_test.ts's shape (top-level in
 * scripts/, `_test.ts` suffix, `jsr:@std/assert@1`).
 *
 * CONTRACT UNDER TEST, from plan v4 step 1:
 *   stdout is byte-identical to today for every currently succeeding case,
 *   and EMPTY for every failing case (the awk program must BUFFER the
 *   section into a variable and print it only from END, on success — a
 *   print-as-you-go shape leaks the heading onto stdout before END discovers
 *   a code-5 blank body).
 *   Exit codes:
 *     0 = section found, body has >=1 non-whitespace line (heading included,
 *         untruncated)
 *     3 = the CHANGELOG file does not exist (replaces today's exit 0)
 *     4 = the file exists but has no heading for this version
 *     5 = the heading exists but the body under it is entirely blank
 *     6 = the version's heading appears MORE THAN ONCE in the file
 *   Heading match accepts BOTH `## <version>` (today's rule, guarded so
 *   `## 2026.08.19.1` does not also match `## 2026.08.19.10`) and the
 *   bracketed `## [<version>]` form lastfm uses.
 *
 * `scripts/deno.json`'s `test` task already grants `--allow-read
 * --allow-write --allow-run`, so no task change is needed here. The script
 * path is resolved from `import.meta.url`, not `Deno.cwd()`, because the
 * task runs with cwd = `scripts/`.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const SCRIPT = join(
  dirname(fromFileUrl(import.meta.url)),
  "changelog-section.sh",
);

interface RunResult {
  code: number;
  stdout: string;
}

/** Drives the REAL script via bash, exactly as it ships (mode 0755,
 * `#!/usr/bin/env bash` shebang) — never a TypeScript reimplementation. */
async function run(changelogPath: string, version: string): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT, changelogPath, version],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

/** Writes `content` as a CHANGELOG.md in a fresh temp dir, runs `fn` against
 * its path, and always cleans up — mirroring check_property_harness.test.ts's
 * writeFixture/finally shape. */
async function withChangelog(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "changelog-section-" });
  try {
    const path = join(dir, "CHANGELOG.md");
    await Deno.writeTextFile(path, content);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// --- plain heading, the baseline positive case ------------------------------

Deno.test("plain '## <v>' heading is found: rc 0, stdout equals the section exactly (mutation: break the plain-form match -> reddens)", async () => {
  await withChangelog(
    "# Changelog\n\n## 2026.08.19.1\n\nDid a thing.\n\n## 2026.08.18.1\n\nOlder.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 0);
      assertEquals(stdout, "## 2026.08.19.1\n\nDid a thing.\n\n");
    },
  );
});

// --- bracketed heading --------------------------------------------------

Deno.test("bracketed '## [<v>] — date' heading is found: rc 0, stdout equals the section exactly (mutation: delete the bracketed branch -> reddens on both rc and stdout equality)", async () => {
  await withChangelog(
    "## Unreleased\n\nDraft.\n\n" +
      "## [2026.07.27.1] — 2026-07-27\n\nBracketed heading works.\n\n" +
      "## [2026.07.20.1] — 2026-07-20\n\nOlder bracketed.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.07.27.1");
      assertEquals(code, 0);
      assertEquals(
        stdout,
        "## [2026.07.27.1] — 2026-07-27\n\nBracketed heading works.\n\n",
      );
    },
  );
});

// --- absent version -------------------------------------------------------

Deno.test("version absent from the file: rc 4, stdout EMPTY (mutation: exit 4 -> exit 0 in the heading-absent path -> reddens)", async () => {
  await withChangelog(
    "## 2026.08.18.1\n\nOnly this one exists.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 4);
      assertEquals(stdout, "");
    },
  );
});

Deno.test("substr guard: '2026.08.19.1' does not match a heading of '2026.08.19.10' -> rc 4 (mutation: weaken the substr guard -> reddens; pins EXISTING behaviour that has no test today)", async () => {
  await withChangelog(
    "## 2026.08.19.10\n\nA longer version that starts with the same digits.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 4);
      assertEquals(stdout, "");
    },
  );
});

// --- absent file -----------------------------------------------------------

Deno.test("CHANGELOG file does not exist: rc 3, stdout EMPTY (mutation: exit 3 -> exit 4 -> the two cases are asserted separately, so this one reddens)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "changelog-section-" });
  try {
    const missing = join(dir, "CHANGELOG.md"); // never written
    const { code, stdout } = await run(missing, "2026.08.19.1");
    assertEquals(code, 3);
    assertEquals(stdout, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- blank body, buffering ---------------------------------------------

Deno.test("heading present, body only blank lines: rc 5, stdout EMPTY (mutation: drop the blank-body tracking -> rc 5 assertion reddens)", async () => {
  await withChangelog(
    "## 2026.08.19.1\n\n   \n\n## 2026.08.18.1\n\nSomething real.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 5);
      assertEquals(stdout, "");
    },
  );
});

Deno.test("blank-body stdout stays EMPTY even though the heading was matched — pins BUFFERING, not just the exit code (mutation: print as you go instead of buffering into END -> this reddens even if rc still reports 5; measured leak on the print-as-you-go form: 15 bytes of heading)", async () => {
  await withChangelog(
    "## 2026.08.19.1\n\n   \n",
    async (path) => {
      const { stdout } = await run(path, "2026.08.19.1");
      assertEquals(
        stdout.length,
        0,
        `expected zero bytes on stdout for a blank-body failure, got ${stdout.length}: ${
          JSON.stringify(stdout)
        }`,
      );
    },
  );
});

// --- duplicate heading -------------------------------------------------

Deno.test("the same '## <v>' heading twice: rc 6, stdout EMPTY. TWO mutations, both of which must redden it, because they fail differently (i: delete 'if (f) { dup = 1; exit }' from the heading rule -> rc 0 with both bodies plus the repeated heading, measured 66 bytes on a two-bullet fixture; ii: move 'f && /^## / { exit }' ABOVE the heading rule -> rc 0 with only the first body, measured 32 bytes on the same fixture)", async () => {
  await withChangelog(
    "## 2026.08.19.1\n\n- first bullet\n\n## 2026.08.19.1\n\n- second bullet\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 6);
      assertEquals(stdout, "");
    },
  );
});

// PINNED, NOT ASSUMED: duplicate detection is ONLY reliable for the target
// heading appearing twice in a row. The `f && /^## / { exit }` terminator
// exits the whole awk program at the very next `## ` heading it sees after
// the target has matched once — including a DIFFERENT version's heading —
// so a duplicate SEPARATED by another version's section is never reached at
// all: `dup` never gets set, and the script returns rc 0 with only the
// FIRST occurrence's body. Measured directly against this exact fixture.
// This is "first wins, silently" rather than "duplicate anywhere in the
// file", and it is the behaviour the plan's own step-1 prototype produces
// verbatim — pin it here so the gap is documented rather than discovered in
// production.
Deno.test("a duplicate heading SEPARATED by a different version's section is NOT detected as a duplicate: rc 0, stdout is the FIRST occurrence's body only (documents the real behaviour — adjacent duplicates return rc 6 per the test above, a non-adjacent duplicate does not)", async () => {
  await withChangelog(
    "## 1.0.0\n\nFirst body.\n\n## 0.9.0\n\nMiddle section.\n\n## 1.0.0\n\nSecond body.\n",
    async (path) => {
      const { code, stdout } = await run(path, "1.0.0");
      assertEquals(code, 0);
      assertEquals(stdout, "## 1.0.0\n\nFirst body.\n\n");
    },
  );
});

// --- extraction boundary -------------------------------------------------

Deno.test("extraction stops at the next '## ' heading and does not run on (mutation: remove the 'f && /^## / { exit }' terminator -> the section runs into the following version, this assertion reddens on the exact stdout equality)", async () => {
  await withChangelog(
    "## 2026.08.19.1\n\nCurrent section.\n\n## 2026.08.18.1\n\nMust NOT appear in the output.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 0);
      assertEquals(stdout, "## 2026.08.19.1\n\nCurrent section.\n\n");
      assertEquals(
        stdout.includes("Must NOT appear"),
        false,
        `section leaked past the next heading: ${JSON.stringify(stdout)}`,
      );
    },
  );
});

Deno.test("an '## Unreleased' section above the target section does not break extraction: rc 0", async () => {
  await withChangelog(
    "## Unreleased\n\nSome pending draft notes.\n\n## 2026.08.19.1\n\nReal section body.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 0);
      assertEquals(stdout, "## 2026.08.19.1\n\nReal section body.\n");
    },
  );
});

// --- no trailing newline ----------------------------------------------

Deno.test("a file whose last line has no trailing newline: rc 0, and the section is complete", async () => {
  await withChangelog(
    "## 2026.08.19.1\n\nNo trailing newline on this body line.",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 0);
      assertEquals(
        stdout,
        "## 2026.08.19.1\n\nNo trailing newline on this body line.\n",
      );
    },
  );
});

// --- plain heading WITH a suffix, e.g. "## <v> — <date>" -----------------
// No fixture anywhere in this file used the plain-form heading WITH a
// trailing suffix before this — every plain-form fixture was a bare
// `## <v>`, and the only suffixed fixture used lastfm's BRACKETED form.
// Live shape in this repo: 5 of 52 packages carry a suffix on their
// CURRENT-version plain heading (firecracker, issue-lifecycle, libvirt,
// pihole, swamp-go-brr).

Deno.test("plain '## <v> — <suffix>' heading (unbracketed, with trailing text) is found: rc 0, stdout equals the section exactly (mutation: match the heading with a regex built from the version string instead of index()-based literal matching -- an obvious way to write the plain-vs-bracketed rewrite -- reddens on stdout equality, because '.' in the version would then match ANY character)", async () => {
  await withChangelog(
    "## 2026.08.19.1 — some title\n\nBody text here.\n\n## 2026.08.18.1\n\nOlder.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 0);
      assertEquals(
        stdout,
        "## 2026.08.19.1 — some title\n\nBody text here.\n\n",
      );
    },
  );
});

Deno.test("regex-vs-literal guard: a heading of '## 2026X08X19X1' does NOT match version '2026.08.19.1' -> rc 4 (mutation: match the heading with a regex built from the version string, where the literal '.' characters become wildcards -> this reddens, since 'X' would then satisfy the wildcarded '.'; pins that the matcher is index()-based literal matching, not regex matching, over BOTH heading forms)", async () => {
  await withChangelog(
    "## 2026X08X19X1\n\nBody.\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 4);
      assertEquals(stdout, "");
    },
  );
});

// --- HTML-comment-only body: a DELIBERATE non-goal, documented as such ---
// A body consisting only of an HTML comment (e.g. "<!-- TODO: write these
// notes -->") passes as a real section — this is not an oversight, it is
// documented in the script's own docblock. Pinning it here stops a future
// "tighten the blank check" edit from silently reversing that decision.

Deno.test("a body consisting ONLY of an HTML comment PASSES as a real section: rc 0 (mutation: html-comment-blank, treating an HTML-comment-only body as blank -> this reddens on the exit code; the script's docblock states this is deliberate, not an oversight)", async () => {
  await withChangelog(
    "## 2026.08.19.1\n\n<!-- TODO: write these notes -->\n",
    async (path) => {
      const { code, stdout } = await run(path, "2026.08.19.1");
      assertEquals(code, 0);
      assertEquals(
        stdout,
        "## 2026.08.19.1\n\n<!-- TODO: write these notes -->\n",
      );
    },
  );
});
