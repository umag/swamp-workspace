/**
 * PropertyHarnessGuard domain service: bans `.clone()` in every
 * `*_property_test.ts` file across the repo. The defect being pinned: every
 * extension's property-test suite copy-pastes a `withFetchStub` harness that
 * does `calls.push(req.clone())`. Cloning a body-bearing Request tees its
 * body into a ReadableStream that is never consumed or cancelled, retaining
 * ~6KB per stubbed fetch call across an fc.assert run — at the nightly
 * soak's high FC_NUM_RUNS this OOMs the whole `deno test` process. This gate
 * stops a NEW `.clone()` from ever landing in a property-test file again
 * once the fix (an eager snapshot instead of `.clone()`) lands (see
 * fix/soak-property-harness-heap-leak).
 *
 * Scoped deliberately to `*_property_test.ts` files ONLY — a `.clone()` in
 * any other suite (`*_methods_test.ts`, etc.) is not this gate's problem,
 * because those suites don't run at FC_NUM_RUNS=30000 and can't OOM the same
 * way.
 *
 * A raw substring scan of file text would permanently flag files that
 * document the historical bug in a comment (e.g. this PR's own heap-pin
 * doc comments, which name `req.clone()` verbatim to explain what the pin
 * guards against). So comments, string/template literals, and regex
 * literals are stripped before scanning — only executable-code `.clone()`
 * calls count (see `stripCommentsAndStrings` for why regex literals need
 * their own handling, not just quotes/comments).
 *
 * THREAT MODEL: this is a lint-style CI gate against ACCIDENTAL
 * reintroduction (a stale copy-paste of the old `withFetchStub` snippet, a
 * badly-resolved merge conflict), not a defense against a determined author
 * deliberately evading it. Bracket notation (`req["clone"]()`), indirection
 * (`const c = req.clone; c.call(req)`), and similar obfuscation all pass
 * this static scan undetected by design — chasing full evasion-resistance
 * here is not worth the complexity, and would still not be exhaustive. The
 * real backstop against reintroduction regardless of how `.clone()` is
 * spelled is behavioral, not textual: the heap-growth regression pins in
 * seanime_property_test.ts and seadex_property_test.ts, which measure
 * actual `Deno.memoryUsage().heapUsed` growth against a calibrated
 * threshold. This gate is defense-in-depth on top of that, catching the
 * common accidental case earlier (at CI-diff time, with a file:line) than
 * a heap pin would.
 */
import { dirname, fromFileUrl, join, relative } from "jsr:@std/path@1";

export interface Violation {
  file: string;
  rule: string;
  what: string;
  why: string;
  fix: string;
}

export interface PropertyHarnessResult {
  checked: string[];
  violations: Violation[];
}

// Keywords after which a `/` starts a regex literal rather than acting as
// the division operator — the same disambiguation a real JS/TS lexer makes
// from the preceding token's grammatical position (an operand-expected
// position vs. an operand-just-produced position).
const REGEX_ALLOWED_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "do",
  "else",
  "case",
  "default",
]);

// Real source lines never need a regex literal (or an unclosed `[`
// character class scanned while looking for one) longer than this many
// characters. Bounding findRegexEnd's lookahead distance, on top of its
// existing newline bound, keeps a single call O(1) instead of O(line
// length): without it, a line containing many `/[` triggers with an
// unclosed class (never closed by `]`, so `inClass` never goes false)
// makes EVERY trigger scan all the way to end-of-line, which is O(n^2)
// total on one long adversarial line (measured ~8.8s at 3.2MB — see
// check_property_harness.test.ts's pathological-input regression test).
const MAX_REGEX_LOOKAHEAD = 500;

// Nested `${...}` template interpolations recurse through the JS call
// stack (scanTemplate -> scanCode -> scanOne -> scanTemplate for each
// nesting level), so pathologically deep nesting otherwise throws an
// uncaught RangeError: Maximum call stack size exceeded around depth
// ~5000 (measured). This caps recursion well before that, letting
// checkPropertyHarness report the file as unparseable (fail closed)
// instead of crashing the whole CI process — see scanTemplate below.
const MAX_TEMPLATE_DEPTH = 200;

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Strip line comments, block comments (including doc-comments), quoted
 * string literals, template literals, and regex literals from TypeScript
 * source, replacing their contents with nothing (regex/string/template
 * bodies) or literal-preserving text (identifiers/plain code) so a
 * subsequent substring/regex scan only ever sees real executable code.
 *
 * Not a full parser, but a real tokenizer's worth of state beyond a naive
 * quote/comment scanner: it tracks whether the most recently scanned token
 * was a "value" (identifier, number, string, regex, template literal, `)`,
 * `]`) to disambiguate a bare `/` as regex-literal-start vs. the division
 * operator, exactly like `a / b` (division, value before `/`) vs. `x =
 * /re/` or `return /re/` (regex, operator/keyword before `/`) in real JS.
 * This matters because a regex character class can legally contain a quote
 * character — e.g. `/[;&'"]/` — and without regex awareness a naive
 * quote-delimiter scanner desyncs at that quote, enters "string scan" mode,
 * and searches for the next matching quote ANYWHERE later in the file,
 * silently swallowing everything after it (including any real `.clone()`
 * call). This is not hypothetical: it reproduced against
 * flipper-zero/extensions/models/flipper_zero_property_test.ts's
 * `const METACHAR = /[;&|$\`'"\\]/;` and
 * musicbrainz/extensions/models/musicbrainz_property_test.ts's
 * `const SAFE_TEXT = /^[A-Za-z0-9 ,.'-]{1,24}$/;` before this fix (see
 * check_property_harness.test.ts's regex-literal fixtures, built from these
 * two real lines).
 *
 * Template literals recurse into `${...}` interpolations (via the shared
 * `scanCode` below) rather than treating the whole template as one opaque
 * blob delimited by the next backtick — a nested template (`` `outer
 * ${`inner`} end` ``) would otherwise desync the backtick pairing and
 * either swallow real code or leave inner-template prose unstripped (a
 * false positive if that prose happens to mention `.clone()`).
 *
 * Known blind spot in the regex/division disambiguation itself — still
 * present, still not exercised by any file in this repo today: a `)`
 * closing an `if`/`while`/`for` condition is classified as a value
 * (division-favoring) even though `if (x) /re/.test(y)` is valid
 * regex-starting JS; multi-character operators like postfix `++`/`--` are
 * scanned one punctuation character at a time, so a `/` immediately after
 * `a++ / b` can be misclassified too. Either misclassification means a `/`
 * that was actually a regex literal gets scanned as division instead — the
 * original, pre-regex-awareness failure mode.
 *
 * That misclassification USED TO be able to eat real code, contrary to
 * this module's earlier claim that it "never" did: when the misclassified
 * "division" operand itself contains a quote character (e.g. an inline
 * char-class regex like `/[a-z'"]/` written behind an `if`/`while` guard
 * instead of assigned to a `const` first), the quote used to be picked up
 * by the ordinary string-literal branch, which searched forward for the
 * NEXT matching quote ANYWHERE LATER IN THE FILE — silently swallowing
 * everything in between, including a genuine `.clone()` call (see
 * check_property_harness.test.ts's if/while-guarded regex-literal
 * fixtures, and `findStringEnd` below). The fix does not eliminate the
 * misclassification (still an open blind spot, above) but bounds its
 * blast radius: like `findRegexEnd`, the string-literal scan now gives up
 * at the next unescaped newline rather than scanning to EOF, since a real
 * JS/TS single/double-quoted string cannot legally span a raw newline
 * anyway — an unclosed quote is therefore always a misparse, and now costs
 * at most the rest of the current line, never the rest of the file.
 */
export function stripCommentsAndStrings(source: string): string {
  const n = source.length;
  let i = 0;
  let out = "";
  // Whether the most recently scanned token was a complete "value" (see the
  // docblock above) — drives the `/` regex-vs-division disambiguation.
  let lastTokenIsValue = false;
  // Current `${...}` interpolation nesting depth — see MAX_TEMPLATE_DEPTH
  // and scanTemplate below.
  let templateDepth = 0;

  // `start` points at an opening `/`. Returns the index just past its
  // closing (unescaped, outside-a-`[...]`-class) `/`, or null if no such
  // closing `/` exists before a newline/EOF/the MAX_REGEX_LOOKAHEAD cap.
  // Used both to decide whether a `/` is plausibly a regex literal at all
  // (a lookahead, no mutation) and then to actually consume it — so a
  // misfire of the value/operator heuristic above can never eat real code:
  // if no closing `/` is found, the `/` is treated as plain division and
  // normal scanning resumes right after it.
  function findRegexEnd(start: number): number | null {
    let j = start + 1;
    let inClass = false;
    const limit = Math.min(n, start + 1 + MAX_REGEX_LOOKAHEAD);
    while (j < limit) {
      const ch = source[j];
      if (ch === "\n") return null;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        j++;
        continue;
      }
      if (ch === "]") {
        inClass = false;
        j++;
        continue;
      }
      if (ch === "/" && !inClass) return j + 1;
      j++;
    }
    return null;
  }

  // `start` points at an opening `"`/`'`; `quote` is that same character.
  // Returns the index just past the matching closing quote, or null if no
  // such closing quote exists before a raw (unescaped) newline or EOF.
  // Mirrors findRegexEnd's lookahead-before-commit shape immediately
  // above: a real single/double-quoted JS/TS string literal cannot
  // legally span a raw newline, so failing to find a same-line closing
  // quote means this character was never really a string-literal start —
  // most likely a quote sitting inside a regex character class that the
  // `)`-after-if/while/for blind spot (see the module docblock) mis-scanned
  // as division. Bounding this lookahead to end-of-line, exactly like
  // findRegexEnd, caps the cost of that misclassification at one line
  // instead of scanning to EOF for the next matching quote anywhere in the
  // file.
  function findStringEnd(start: number, quote: string): number | null {
    let j = start + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === "\n") return null;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) return j + 1;
      j++;
    }
    return null;
  }

  // Appends one plain (non-token) character to `out` and updates
  // `lastTokenIsValue` — whitespace is transparent (never changes
  // classification); `)` / `]` are values (they close a call/grouping or
  // an index/array-literal); every other punctuation character is
  // operator-like (a regex may legally start right after it).
  function appendPlainChar(c: string): void {
    out += c;
    i++;
    if (/\s/.test(c)) return;
    lastTokenIsValue = c === ")" || c === "]";
  }

  // Handles one comment/string/regex/template-literal token starting at the
  // current position, if any does — returns true and advances `i`
  // (appending to `out` as appropriate) when it did, false if the caller
  // should fall through to identifier/number/plain-character handling.
  function scanOne(): boolean {
    const c = source[i];
    const next = source[i + 1];

    // Line comment: skip to (not including) the newline so line breaks are
    // preserved in the output. Transparent to regex/division
    // classification, same as in real JS.
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      return true;
    }

    // Block comment (covers both /* */ and /** */ — the extra leading `*`
    // in a JSDoc comment is just another character consumed by the same
    // scan to the closing `*/`). Transparent to classification.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      return true;
    }

    // Regex literal — only attempted in an operand-expected position (see
    // the docblock's disambiguation rule), and only committed to if a
    // plausible closing `/` actually exists before the next newline.
    if (c === "/" && !lastTokenIsValue) {
      const end = findRegexEnd(i);
      if (end !== null) {
        i = end;
        while (i < n && /[a-zA-Z]/.test(source[i])) i++; // flags
        lastTokenIsValue = true;
        return true;
      }
      // No plausible closing `/`: not a regex after all (most likely
      // division misclassified by the heuristic, or malformed source) —
      // fall through to plain-character handling so nothing is dropped.
    }

    // Single/double-quoted string literal. Bounded to end-of-line via
    // findStringEnd (see its docblock) rather than scanning to the next
    // matching quote ANYWHERE later in the file — see the module
    // docblock's "Known blind spot" note for why an unbounded scan here
    // used to be able to eat real code.
    if (c === '"' || c === "'") {
      const end = findStringEnd(i, c);
      if (end !== null) {
        i = end;
        lastTokenIsValue = true;
        return true;
      }
      // No closing quote before EOL/EOF: not a real string literal after
      // all — fall through so the caller treats just the opening quote as
      // a plain character and normal scanning resumes right after it,
      // capping the blast radius to this line instead of the rest of the
      // file.
    }

    // Template literal — see scanTemplate for interpolation handling.
    if (c === "`") {
      scanTemplate();
      lastTokenIsValue = true;
      return true;
    }

    return false;
  }

  // Scans template-literal raw text starting at the opening backtick,
  // recursing into `${...}` interpolations via scanCode(true) so nested
  // templates and any comments/strings/regexes inside an interpolation are
  // scanned properly instead of desyncing the backtick pairing.
  //
  // Each nesting level costs one JS call-stack frame (scanTemplate ->
  // scanCode -> scanOne -> scanTemplate), so pathologically deep nesting
  // is bounded explicitly via templateDepth/MAX_TEMPLATE_DEPTH rather than
  // left to hit an uncaught RangeError partway through — throwing here
  // lets checkPropertyHarness's caller report the file as unparseable
  // (fail closed) instead of the whole CI process crashing.
  function scanTemplate(): void {
    templateDepth++;
    if (templateDepth > MAX_TEMPLATE_DEPTH) {
      throw new Error(
        `stripCommentsAndStrings: template interpolation nesting exceeds ` +
          `${MAX_TEMPLATE_DEPTH} levels — refusing to recurse further`,
      );
    }
    try {
      i++; // opening `
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") {
          i++;
          return;
        }
        if (c === "$" && source[i + 1] === "{") {
          i += 2;
          scanCode(true);
          continue;
        }
        i++; // raw template text is opaque, like an ordinary string literal
      }
    } finally {
      templateDepth--;
    }
  }

  // The shared scanner loop. At the top level (`stopAtUnmatchedBrace`
  // false) it runs to EOF. Inside a template interpolation
  // (`stopAtUnmatchedBrace` true) it tracks brace depth and returns once it
  // consumes the interpolation's own closing `}` — every `{`/`}` it sees
  // directly (not through scanOne, which consumes comments/strings/regexes/
  // templates as atomic units) is a genuine code-level brace, so plain
  // depth counting is exact.
  function scanCode(stopAtUnmatchedBrace: boolean): void {
    let depth = 0;
    while (i < n) {
      if (scanOne()) continue;
      const c = source[i];
      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdentChar(source[j])) j++;
        const word = source.slice(i, j);
        out += word;
        i = j;
        lastTokenIsValue = !REGEX_ALLOWED_AFTER_WORD.has(word);
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i;
        while (j < n && /[0-9A-Za-z_$]/.test(source[j])) j++;
        out += source.slice(i, j);
        i = j;
        lastTokenIsValue = true;
        continue;
      }
      if (stopAtUnmatchedBrace && c === "{") {
        depth++;
        appendPlainChar(c);
        continue;
      }
      if (stopAtUnmatchedBrace && c === "}") {
        if (depth === 0) {
          i++;
          return;
        }
        depth--;
        appendPlainChar(c);
        continue;
      }
      appendPlainChar(c);
    }
  }

  scanCode(false);
  return out;
}

async function findPropertyTestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile && entry.name.endsWith("_property_test.ts")) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found.sort();
}

// Whitespace/newline-tolerant so a split call across lines (`req\n  .clone\n
//  ()`) is still caught — a real .clone() call doesn't stop being real just
// because it's formatted across multiple lines. Still a substring-shaped
// check, not full call-target resolution (see the module docblock's THREAT
// MODEL note): bracket notation and indirection remain out of scope.
const CLONE_CALL_PATTERN = /\.clone\s*\(\s*\)/;

/** Scan every `*_property_test.ts` file under `root` (recursively) for a
 * real (non-comment, non-string, non-regex) `.clone()` call. Aggregates
 * every violation before returning — never aborts on the first offending
 * file. */
export async function checkPropertyHarness(
  root: string,
): Promise<PropertyHarnessResult> {
  const files = await findPropertyTestFiles(root);
  const checked: string[] = [];
  const violations: Violation[] = [];

  for (const full of files) {
    const rel = relative(root, full);
    checked.push(rel);
    const content = await Deno.readTextFile(full);
    let stripped: string;
    try {
      stripped = stripCommentsAndStrings(content);
    } catch (err) {
      // stripCommentsAndStrings couldn't finish scanning this file (e.g.
      // the template-nesting depth cap tripped) — its .clone() status is
      // genuinely UNKNOWN, not clean. Fail closed: report it as a
      // blocking violation instead of silently contributing zero
      // violations or letting the exception crash the whole CI job.
      violations.push({
        file: rel,
        rule: "property-test-unparseable",
        what: `${rel} could not be scanned for .clone() calls`,
        why: err instanceof Error ? err.message : String(err),
        fix: "simplify the file's structure (e.g. flatten deeply nested " +
          "template-literal interpolations) so it can be tokenized, or " +
          "file a bug against check_property_harness.ts if the file is " +
          "ordinary TypeScript",
      });
      continue;
    }
    if (CLONE_CALL_PATTERN.test(stripped)) {
      violations.push({
        file: rel,
        rule: "property-test-clone-leak",
        what: `${rel} calls .clone() on a stubbed fetch Request`,
        why:
          "cloning a body-bearing Request tees its body into a ReadableStream " +
          "that is never consumed or cancelled, retaining ~6KB per stubbed " +
          "fetch call and OOMing the nightly soak at high FC_NUM_RUNS (see " +
          "fix/soak-property-harness-heap-leak).",
        fix: "replace calls.push(req.clone()) with an eager plain-object " +
          "snapshot — read the body once via `await req.text()` and build a " +
          "plain object instead of cloning the Request",
      });
    }
  }

  return { checked: checked.sort(), violations };
}

function printHelp() {
  console.log(
    `check_property_harness.ts — ban .clone() in every *_property_test.ts file

Usage:
  deno run --allow-read scripts/quality/check_property_harness.ts [--help] [--json <path>]

Scans every *_property_test.ts file under the repo root (recursively) for a
real .clone() call on a stubbed fetch Request — comments, string/template
literals, and regex literals are stripped before scanning, so a doc comment
naming .clone() verbatim does not trip the gate. This is a defense-in-depth
lint gate against accidental reintroduction, not evasion-proof. Set
QUALITY_REPO_ROOT to scan a tree other than this script's own repo (used by
its tests; CI never needs it).

--json <path>  also write {checked, violations} as JSON to <path> (the
               sticky PR-comment report reads this — see
               scripts/build-ci-report.ts).

Exit codes:
  0  no *_property_test.ts file calls .clone()
  1  one or more violations found (also emits a GitHub ::error annotation
     per violation when running in CI)
`,
  );
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }
  const jsonFlagIndex = args.indexOf("--json");
  const jsonPath = jsonFlagIndex >= 0 ? args[jsonFlagIndex + 1] : undefined;
  const root = Deno.env.get("QUALITY_REPO_ROOT") ??
    join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const { checked, violations } = await checkPropertyHarness(root);
  console.log(`Checked ${checked.length} *_property_test.ts file(s).`);
  for (const v of violations) {
    console.log(
      `${v.file}: [${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`,
    );
    console.log(`::error file=${v.file}::${v.what} — ${v.fix}`);
  }
  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify({ checked, violations }, null, 2),
    );
  }
  if (violations.length > 0) {
    console.log(
      `\n${violations.length} violation(s) across ${checked.length} checked file(s).`,
    );
    Deno.exit(1);
  }
  console.log("No *_property_test.ts file calls .clone().");
}
