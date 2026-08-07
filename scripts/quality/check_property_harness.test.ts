/**
 * Tests for the PropertyHarnessGuard domain service (check_property_harness.ts
 * — does not exist yet, this file is the RED half of the
 * fix/soak-property-harness-heap-leak plan's PR A).
 *
 * The defect being pinned: every extension's `_property_test.ts` suite
 * copy-pastes a `withFetchStub` harness that does `calls.push(req.clone())`.
 * Cloning a body-bearing Request tees its body into a ReadableStream that is
 * never consumed or cancelled, retaining ~6KB per stubbed fetch call across
 * an fc.assert run — at the nightly soak's high FC_NUM_RUNS this OOMs the
 * whole `deno test` process (measured: heapUsed 7MB -> 125MB over 60k
 * clones). check_property_harness.ts is the static gate that stops a NEW
 * `.clone()` from ever landing in a property-test file again once the fix
 * (an eager snapshot instead of `.clone()`) lands.
 *
 * Expected shape (mirroring check_compliance.ts's Violation, minus the
 * `extension` field which doesn't apply to a single-file scan):
 *
 *   export interface Violation {
 *     file: string;  // path to the offending *_property_test.ts, relative
 *                     // to the scanned root
 *     rule: string;
 *     what: string;  // must name the file (see the "names the file" test
 *                     // below)
 *     why: string;
 *     fix: string;
 *   }
 *
 *   export async function checkPropertyHarness(
 *     root: string,
 *   ): Promise<{ checked: string[]; violations: Violation[] }>
 *
 * checkPropertyHarness scans EVERY `*_property_test.ts` file under `root`
 * (recursively, mirroring the real repo's `<ext>/extensions/models/` layout)
 * for the literal substring `.clone()`. The ban is deliberately scoped to
 * property-test files ONLY — a `.clone()` in a `_methods_test.ts` (or any
 * other suite) is not this gate's problem, because those suites don't run at
 * FC_NUM_RUNS=30000 and can't OOM the same way.
 *
 * These tests build small temp-dir fixture trees (cleaned up in `finally`),
 * per the established pattern in check_compliance.test.ts /
 * check_allowlist.test.ts, so they never depend on the real repo's current
 * `.clone()` usage (which is real and repo-wide today — see the plan).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import {
  checkPropertyHarness,
  stripCommentsAndStrings,
} from "./check_property_harness.ts";

async function writeFixture(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const full = join(root, relPath);
  await Deno.mkdir(dirname(full), { recursive: true });
  await Deno.writeTextFile(full, content);
}

// A minimal but realistic withFetchStub-shaped snippet — the exact pattern
// copy-pasted across seanime/seadex/juick/headphones/victoriametrics (and
// every other extension's property suite). This static gate bans `.clone()`
// in ALL of them, unconditionally. Only seanime and seadex additionally get
// a heap-growth regression PIN in this PR (see the "Heap-leak regression
// pin" comment block at the bottom of each of those two
// *_property_test.ts files for measured numbers and why juick/headphones/
// victoriametrics were deliberately left unpinned — their own property
// suites have separate, undiagnosed heap-noise sources that make a pin
// bound uncalibratable today, not an oversight in this PR's scope).
const SOURCE_WITH_CLONE = `
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

const SOURCE_WITHOUT_CLONE = `
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

// Mirrors the EXACT shape this PR's own fix lands in seanime/seadex: the
// real `.clone()` call is gone from code, but an explanatory doc comment
// about the historical bug (naming the removed call verbatim) stays behind
// — because it documents WHY the heap pin below it exists. A literal
// substring scan of raw file text would flag this file forever; the gate
// must strip comments before scanning. One `//` line comment, one `/** */`
// block comment, each mentioning `.clone()` on its own — no real call in
// either.
const SOURCE_CLONE_ONLY_IN_LINE_COMMENT = `
// withFetchStub's \`calls.push(req.clone())\` above used to tee each
// stubbed Request's body into a ReadableStream that was never consumed —
// see fix/soak-property-harness-heap-leak for the removed call.
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

const SOURCE_CLONE_ONLY_IN_BLOCK_COMMENT = `
/**
 * Heap-leak regression pin.
 *   - WITH req.clone() (before the fix): heapUsed grows ~600MB.
 *   - WITHOUT it (an eager snapshot instead of clone): heapUsed grows
 *     only ~55MB — ordinary, GC-reclaimable per-iteration garbage.
 */
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

// `.clone()` appearing only inside a string literal (e.g. an assertion
// message quoting the removed call) — also not executable code.
const SOURCE_CLONE_ONLY_IN_STRING_LITERAL = `
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return routes[0](req);
  };
  await fn(calls);
}

const NOTE = "withFetchStub's req.clone() used to leak memory here";
Deno.test("property: some invariant holds", () => {});
`;

// The realistic mid-migration state: the REAL call is still present in code
// AND a doc comment about it exists nearby (exactly what seanime/seadex
// look like today, before their eventual fix). Must still flag exactly one
// violation — comment-stripping must not eat the real call too.
const SOURCE_WITH_CLONE_AND_COMMENT_ABOUT_IT = `
// withFetchStub's \`calls.push(req.clone())\` below tees each stubbed
// Request's body into a ReadableStream that is never consumed or cancelled.
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

Deno.test("checkPropertyHarness flags a *_property_test.ts source containing .clone() with exactly one violation naming the file", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_WITH_CLONE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    const [v] = violations;
    assert(
      v.file.endsWith("widget_property_test.ts"),
      `expected violation.file to name widget_property_test.ts, got ${v.file}`,
    );
    assert(
      v.what.includes("widget_property_test.ts"),
      `expected violation.what to name the file, got: ${v.what}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness gives the violation a non-empty rule/what/why/fix shape", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_WITH_CLONE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations.length, 1, JSON.stringify(violations));
    const [v] = violations;
    assert(v.rule.length > 0, "missing rule");
    assert(v.what.length > 0, "missing what");
    assert(v.why.length > 0, "missing why");
    assert(v.fix.length > 0, "missing fix");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness does NOT flag .clone() in a *_methods_test.ts file — the ban is scoped to property tests only", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_methods_test.ts",
      SOURCE_WITH_CLONE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness does not flag a *_property_test.ts file with no .clone()", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_WITHOUT_CLONE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Comment/string-literal awareness --------------------------------------
//
// A naive `content.includes(".clone()")` scan is built exactly to the
// docblock's literal wording above ("for the literal substring `.clone()`")
// and would flag every fixture below forever, even though none of them
// contain an executable `.clone()` call. This is not hypothetical: this PR
// adds heap-pin doc comments to seanime_property_test.ts and
// seadex_property_test.ts that name `req.clone()` verbatim to explain the
// bug the pin guards against — once a future fix removes the real call but
// (naturally) leaves the explanatory comment behind, a substring-only gate
// would permanently break on the exact files it exists to protect. These
// tests force the real implementation to strip comments and string/template
// literals before scanning, not substring-match raw file text.

Deno.test("checkPropertyHarness does NOT flag .clone() appearing only inside a // line comment", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_CLONE_ONLY_IN_LINE_COMMENT,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness does NOT flag .clone() appearing only inside a /* */ or /** */ block comment", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_CLONE_ONLY_IN_BLOCK_COMMENT,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness does NOT flag .clone() appearing only inside a string literal", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_CLONE_ONLY_IN_STRING_LITERAL,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness still flags a real .clone() call even when a comment ALSO mentions .clone() nearby", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_WITH_CLONE_AND_COMMENT_ABOUT_IT,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(
      violations.length,
      1,
      `expected exactly one violation (the real call), got: ${
        JSON.stringify(violations)
      }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- `checked[]` contract --------------------------------------------------
//
// The docblock's return shape promises `{ checked: string[]; violations:
// Violation[] }`, but until now no test ever read `checked`. An
// implementation that returns `checked: []` unconditionally (while still
// computing `violations` correctly) would pass every test above — nothing
// proves the gate actually visited the files it claims to have scanned. This
// matters because `checked` is the thing a caller (e.g. build-ci-report.ts,
// or a human reading the JSON summary) uses to confirm the gate covered the
// whole tree rather than silently scanning zero files.

Deno.test("checkPropertyHarness's checked[] lists every scanned *_property_test.ts file and excludes non-property test files", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_WITHOUT_CLONE,
    );
    // Sits right next to the property suite above — must be scanned (and
    // must be absent from checked[]) even though it also contains .clone().
    await writeFixture(
      root,
      "widget/extensions/models/widget_methods_test.ts",
      SOURCE_WITH_CLONE,
    );
    const { checked, violations } = await checkPropertyHarness(root);
    assertEquals(
      checked,
      [join("widget", "extensions", "models", "widget_property_test.ts")],
      `checked[] must list exactly the one *_property_test.ts file and ` +
        `nothing else, got: ${JSON.stringify(checked)}`,
    );
    assertEquals(
      violations,
      [],
      "widget_methods_test.ts's .clone() must not be scanned at all — it " +
        "is not a *_property_test.ts file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness scans a MULTI-FILE tree in one call — checked[] lists every *_property_test.ts across multiple extensions and violations[] flags exactly the offending ones", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    // Clean: no .clone() at all.
    await writeFixture(
      root,
      "alpha/extensions/models/alpha_property_test.ts",
      SOURCE_WITHOUT_CLONE,
    );
    // Violating: a real .clone() call.
    await writeFixture(
      root,
      "beta/extensions/models/beta_property_test.ts",
      SOURCE_WITH_CLONE,
    );
    // Clean: .clone() appears only in a comment.
    await writeFixture(
      root,
      "gamma/extensions/models/gamma_property_test.ts",
      SOURCE_CLONE_ONLY_IN_LINE_COMMENT,
    );
    // Violating: a real .clone() call PLUS a nearby comment about it —
    // exactly seanime/seadex's current shape on this branch.
    await writeFixture(
      root,
      "delta/extensions/models/delta_property_test.ts",
      SOURCE_WITH_CLONE_AND_COMMENT_ABOUT_IT,
    );
    // A non-property suite sitting right next to a violating property
    // suite — must be excluded from BOTH checked[] and violations[].
    await writeFixture(
      root,
      "alpha/extensions/models/alpha_methods_test.ts",
      SOURCE_WITH_CLONE,
    );

    const { checked, violations } = await checkPropertyHarness(root);

    assertEquals(
      checked.slice().sort(),
      [
        join("alpha", "extensions", "models", "alpha_property_test.ts"),
        join("beta", "extensions", "models", "beta_property_test.ts"),
        join("delta", "extensions", "models", "delta_property_test.ts"),
        join("gamma", "extensions", "models", "gamma_property_test.ts"),
      ].sort(),
      `checked[] must list exactly the four *_property_test.ts files ` +
        `across the four extension directories, got: ${
          JSON.stringify(checked)
        }`,
    );

    const violatingFiles = violations.map((v: { file: string }) => v.file)
      .sort();
    assertEquals(
      violatingFiles,
      [
        join("beta", "extensions", "models", "beta_property_test.ts"),
        join("delta", "extensions", "models", "delta_property_test.ts"),
      ].sort(),
      `violations[] must flag exactly beta and delta (alpha is clean, ` +
        `gamma's .clone() is comment-only, alpha_methods_test.ts is out ` +
        `of scope), got: ${JSON.stringify(violatingFiles)}`,
    );
    assertEquals(
      violations.length,
      2,
      "expected exactly one violation per offending file (not, e.g., one " +
        `per .clone() substring match), got: ${JSON.stringify(violations)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Regex-literal awareness -------------------------------------------------
//
// A quote character inside a regex character class (e.g. `/['"]/`) desyncs
// a naive quote-delimiter scanner: it enters "string scan" mode at that
// quote and searches for the NEXT matching quote anywhere later in the
// file, silently swallowing everything after it — including any real
// `.clone()` call. This reproduced live against two REAL files in this
// repo: flipper-zero/extensions/models/flipper_zero_property_test.ts:313
// (`const METACHAR = /[;&|$\`'"\\]/;`) and musicbrainz/extensions/models/
// musicbrainz_property_test.ts:347 (`const SAFE_TEXT =
// /^[A-Za-z0-9 ,.'-]{1,24}$/;`, one of THIS PR's own 18 migrated files).
// These fixtures are built from those two real lines verbatim.

const SOURCE_REGEX_WITH_QUOTES_THEN_REAL_CLONE = `
const METACHAR = /[;&|$\`'"\\\\]/;
const SAFE_TEXT = /^[A-Za-z0-9 ,.'-]{1,24}$/;

async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

const SOURCE_REGEX_WITH_QUOTES_THEN_INNOCENT_CODE = `
const METACHAR = /[;&|$\`'"\\\\]/;
const SAFE_TEXT = /^[A-Za-z0-9 ,.'-]{1,24}$/;

function sanitize(s) {
  return SAFE_TEXT.test(s) && !METACHAR.test(s);
}

async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: sanitize rejects metacharacters", () => {
  if (!sanitize("safe text")) throw new Error("expected safe");
});
`;

Deno.test("checkPropertyHarness CATCHES a real .clone() call that appears after a regex literal whose character class contains quote characters", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_REGEX_WITH_QUOTES_THEN_REAL_CLONE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(
      violations.length,
      1,
      "a quote-containing regex literal earlier in the file must not " +
        `desync the scanner and hide the real .clone() call after it, got: ${
          JSON.stringify(violations)
        }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkPropertyHarness does NOT flag a regex literal whose character class contains quote characters when no real .clone() call follows it", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_REGEX_WITH_QUOTES_THEN_INNOCENT_CODE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(
      violations,
      [],
      "a quote-containing regex literal must not be mistaken for an " +
        `open string literal that then flags unrelated innocent code, got: ${
          JSON.stringify(violations)
        }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Nested template literal awareness ---------------------------------------
//
// The template-literal branch only ever looked for the NEXT backtick as its
// closing delimiter, with no awareness of `${...}` interpolation
// boundaries. A nested template — `${`inner`}` — desyncs that pairing: the
// scanner treats the INNER template's closing backtick as if it closed the
// OUTER template, which leaves the inner template's raw text unstripped.
// If that inner text merely mentions ".clone()" in prose (not a real
// call), the naive scanner would flag it — a false positive on innocent
// code.

const SOURCE_NESTED_TEMPLATE_CLONE_IN_PROSE = `
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return routes[0](req);
  };
  await fn(calls);
}

const msg = \`outer \${\`text .clone() here\`} end\`;

Deno.test("property: some invariant holds", () => {});
`;

Deno.test("checkPropertyHarness does NOT flag '.clone()' appearing only as prose inside a NESTED template literal", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_NESTED_TEMPLATE_CLONE_IN_PROSE,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(
      violations,
      [],
      "a nested template literal's inner raw text must stay opaque " +
        "(like an ordinary string), not desync the backtick pairing and " +
        `surface as unstripped code, got: ${JSON.stringify(violations)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Split-call whitespace tolerance ------------------------------------------
//
// A cheap, non-exhaustive improvement (see the module docblock's THREAT
// MODEL note — full evasion-resistance is explicitly out of scope): the
// violation check tolerates whitespace/newlines between `.clone` and `()`,
// so a real call reformatted across lines is still caught.

const SOURCE_SPLIT_CLONE_CALL = `
async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req
      .clone
      ());
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

Deno.test("checkPropertyHarness CATCHES a real .clone() call split across lines (whitespace/newlines between .clone and the call parens)", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      SOURCE_SPLIT_CLONE_CALL,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(
      violations.length,
      1,
      `expected the split .clone() call to be caught, got: ${
        JSON.stringify(violations)
      }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Real-repo safety net ---------------------------------------------------
//
// Every fixture above uses a synthetic temp dir, so nothing yet proves the
// gate actually catches the REAL, un-migrated state of this repo. Without
// this test, an implementer could swap only seanime and seadex (the two
// extensions with a heap pin) to the eager-snapshot fix and leave every
// other *_property_test.ts still calling .clone() — the fixture-only suite
// above would stay green throughout, because none of it ever looks at this
// repo's actual files.
//
// The repo root is resolved from import.meta.url, NOT from cwd — this test
// must give the same answer regardless of which directory `deno test` (or a
// contributor's shell) happens to be invoked from. This file lives at
// scripts/quality/check_property_harness.test.ts, so the repo root is two
// directories up, mirroring check_compliance.ts's own
// `join(dirname(fromFileUrl(import.meta.url)), "..", "..")` convention.

Deno.test("checkPropertyHarness reports ZERO violations against the REAL repository root — the safety net proving every extension's *_property_test.ts got the eager-snapshot swap", async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const { violations } = await checkPropertyHarness(root);
  assertEquals(
    violations,
    [],
    `${violations.length} *_property_test.ts file(s) still call ` +
      "withFetchStub's req.clone() and have NOT had the eager-snapshot " +
      "fix applied yet (see fix/soak-property-harness-heap-leak):\n" +
      violations.map((v: { file: string }) => `  - ${v.file}`).join("\n"),
  );
});

// --- if/while/for-guarded regex blind spot: bounded blast radius -----------
//
// The module docblock's own documented blind spot -- a `)` closing an
// if/while/for condition is classified as a "value", so a `/` right after
// it is scanned as division instead of regex-start -- used to be able to
// eat real code when the misclassified "division" operand contained a
// quote character: the quote then started an UNBOUNDED string scan that
// searched for the next matching quote ANYWHERE LATER IN THE FILE, hiding
// everything in between -- including a real `.clone()` call. These
// fixtures (mirroring the exact repro that found the bug, one of them
// built from this repo's own real METACHAR/SAFE_TEXT-shaped char-class
// regex, just written inline behind a guard instead of assigned to a
// `const` first) prove the fix: a real `.clone()` call after the
// misclassified regex is now always caught, because the string scan gives
// up at end-of-line instead of running to EOF.

const SOURCE_IF_GUARDED_REGEX_WITH_SQUOTE = `
function sanitize(x, y) {
  if (x) /a'b/.test(y);
  calls.push(req.clone());
}
`;

const SOURCE_IF_GUARDED_REGEX_WITH_DQUOTE = `
function sanitize(x, y) {
  if (x) /a"b/.test(y);
  calls.push(req.clone());
}
`;

const SOURCE_WHILE_GUARDED_REGEX_WITH_SQUOTE = `
function sanitize(x, y) {
  while (x) /a'b/.test(y);
  calls.push(req.clone());
}
`;

const SOURCE_IF_GUARDED_VALIDATOR_THEN_REAL_HARNESS = `
function validate(input) {
  if (input.length > 0) /[a-z'"]/.test(input);
  return true;
}

async function withFetchStub(routes, fn) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    return routes[0](req);
  };
  await fn(calls);
}

Deno.test("property: some invariant holds", () => {});
`;

const IF_WHILE_GUARDED_BLIND_SPOT_FIXTURES: ReadonlyArray<
  readonly [string, string]
> = [
  [
    "if-guarded regex with a single quote in its body",
    SOURCE_IF_GUARDED_REGEX_WITH_SQUOTE,
  ],
  [
    "if-guarded regex with a double quote in its body",
    SOURCE_IF_GUARDED_REGEX_WITH_DQUOTE,
  ],
  [
    "while-guarded regex with a single quote in its body",
    SOURCE_WHILE_GUARDED_REGEX_WITH_SQUOTE,
  ],
  [
    "if-guarded char-class validator, then a real withFetchStub harness later in the file",
    SOURCE_IF_GUARDED_VALIDATOR_THEN_REAL_HARNESS,
  ],
];

for (const [name, source] of IF_WHILE_GUARDED_BLIND_SPOT_FIXTURES) {
  Deno.test(`checkPropertyHarness still catches a real .clone() call after an ${name} (bounded blast radius, not swallowed to EOF)`, async () => {
    const root = await Deno.makeTempDir({ prefix: "property-harness-" });
    try {
      await writeFixture(
        root,
        "widget/extensions/models/widget_property_test.ts",
        source,
      );
      const { violations } = await checkPropertyHarness(root);
      assertEquals(
        violations.length,
        1,
        `expected the real .clone() call after the misclassified regex to ` +
          `be caught, got: ${JSON.stringify(violations)}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

// --- findRegexEnd quadratic-scan regression ---------------------------------
//
// An unclosed `[` character class made every same-line `/[` trigger scan
// all the way to end-of-line with no early exit -- O(n^2) total on a line
// with many triggers (measured ~8.8s at 3.2MB pre-fix). MAX_REGEX_LOOKAHEAD
// bounds each trigger's scan to a constant, making this linear again.

Deno.test("stripCommentsAndStrings completes in well under a second on a pathological single-line unclosed-bracket-class input (regression for the O(n^2) findRegexEnd blowup)", () => {
  const TRIGGER_COUNT = 1600;
  const FILLER = "x".repeat(2000);
  const pathological = Array.from(
    { length: TRIGGER_COUNT },
    () => `=/[${FILLER}`,
  ).join("");

  const start = performance.now();
  stripCommentsAndStrings(pathological);
  const elapsedMs = performance.now() - start;

  assert(
    elapsedMs < 1000,
    `expected the bounded-lookahead scan to complete in well under 1s, ` +
      `took ${elapsedMs}ms (pre-fix this shape measured ~8.8s at a ` +
      "similar size -- see MAX_REGEX_LOOKAHEAD in check_property_harness.ts)",
  );
});

// --- Template-interpolation recursion depth regression ----------------------
//
// scanTemplate recursed into scanCode for every nested `${...}` with no
// depth limit, throwing an uncaught RangeError: Maximum call stack size
// exceeded around depth ~5000. MAX_TEMPLATE_DEPTH bounds the recursion and
// checkPropertyHarness now reports the file as unparseable (a normal,
// reported violation, exit code 1) instead of the whole process crashing.

function buildDeeplyNestedTemplate(depth: number): string {
  let s = "`x`";
  for (let level = 0; level < depth; level++) {
    s = "`${" + s + "}`";
  }
  return s;
}

Deno.test("checkPropertyHarness reports a deeply-nested template-interpolation file as an unparseable violation instead of crashing with a RangeError", async () => {
  const root = await Deno.makeTempDir({ prefix: "property-harness-" });
  try {
    const nested = buildDeeplyNestedTemplate(5000);
    await writeFixture(
      root,
      "widget/extensions/models/widget_property_test.ts",
      `const msg = ${nested};\nDeno.test("property: some invariant holds", () => {});\n`,
    );
    const { violations } = await checkPropertyHarness(root);
    assertEquals(
      violations.length,
      1,
      `expected exactly one reported (not crashed) outcome, got: ${
        JSON.stringify(violations)
      }`,
    );
    const [v] = violations;
    assert(
      v.file.endsWith("widget_property_test.ts"),
      `expected the violation to name the file, got: ${JSON.stringify(v)}`,
    );
    assert(
      v.rule.length > 0 && v.why.length > 0 && v.fix.length > 0,
      `expected a populated rule/why/fix on the reported outcome, got: ${
        JSON.stringify(v)
      }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
