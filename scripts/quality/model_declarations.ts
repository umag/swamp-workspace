/**
 * Parser for `export const <ident> = { ... }` model declarations in a
 * TypeScript source file — the shared lexer/parser behind
 * scripts/quality/check_upgrade_chain.ts. Dependency-free, two stages:
 *
 *   1. maskCode(src) replaces every character belonging to a comment,
 *      string literal, template-literal TEXT, or regex literal with a
 *      space (same length as src, newlines preserved), so a subsequent
 *      structural scan never has to reason about lexical trivia.
 *   2. scanModelDeclarations(src) walks the MASK to find declaration
 *      boundaries and depth-1 properties via balanced-delimiter matching,
 *      then reads the actual values back out of the RAW source at
 *      mask-derived offsets.
 *
 * See plan v4 step 7(a) (scratchpad/cipg-plan-v4.yaml) for the full
 * design rationale — this docblock only carries the load-bearing traps,
 * because a fifth anchor is exactly the failure mode a line-scanner falls
 * into and this module exists to avoid:
 *
 *   - REGEX CHARACTER CLASSES. A regex literal is scanned with a
 *     character-class boolean: an unescaped `[` sets it, an unescaped `]`
 *     clears it, and an unescaped `/` terminates the literal only when the
 *     class is not open. A backslash escapes the next character everywhere
 *     (body or class). Without class tracking, an in-tree literal like
 *     `/\/perfume\/([^/]+)\/(.+?)-(\d+)\.html/` (fragrantica.ts:252) or
 *     `/[\\/]/` (fidonet_msgbase.ts:122) terminates early, corrupting
 *     everything lexed after it.
 *   - REGEX VERSUS DIVISION is decided on the previous significant WORD,
 *     never the previous character: a `/` is division after a non-keyword
 *     identifier, a numeric/string/template/regex literal, `)`, `]`, `++`
 *     or `--`; it opens a regex in every other position, including after
 *     return/typeof/instanceof/in/of/new/delete/void/do/else/yield/await/
 *     throw/case. A character-based check misreads `return /re/` (the
 *     char before `/` is `n`, the tail of "return") and cascades a
 *     template-literal misfire hundreds of lines later.
 *   - TEMPLATE INTERPOLATION. `${` keeps its braces LIVE in the mask
 *     (blank only the `$`), so interpolated code nests one level deeper
 *     than the enclosing object literal and a raw comma inside `${...}`
 *     can never be mistaken for a depth-1 array-element separator. Element
 *     emptiness (for chain-entry splitting) is measured on the MASK, not
 *     the raw text — an interpolation that resolves to whitespace-only
 *     mask content is a real (if useless) element, not a dropped one.
 *   - QUOTED PROPERTY KEYS. `"upgrades"` / `'upgrades'` name the same
 *     property as a bare `upgrades` to TypeScript, but the mask blanks
 *     both the quote characters and the key text — a masked quote is a
 *     SPACE. The raw character at a depth-1 key position must be checked
 *     for a quote BEFORE any whitespace-skip runs, because a whitespace
 *     skip placed first silently consumes that space and the quoted-key
 *     branch is never reached (this is the one place the fix is easy to
 *     write and still not work).
 *
 * @module
 */

/** One entry of a resolved literal `upgrades[]` chain. `toVersion` is
 * null when the element's `toVersion` value could not be read as a plain
 * quoted string (still counts as an entry — only the terminus read cares
 * whether the LAST entry's value was readable). */
export interface ChainEntry {
  toVersion: string | null;
}

/**
 * `upgrades[]`'s resolved shape:
 *   - "none"        — no `upgrades` key at all (legal — most declarations)
 *   - "empty"        — `upgrades: []`, zero elements after trimming (legal)
 *   - "indirect"     — the value is not a readable array literal at all
 *                      (identifier, call, member access, conditional …),
 *                      OR an array element itself starts with `...`
 *   - "unparseable"  — an array literal with an element not starting `{`
 *   - "literal"      — a real, element-by-element readable array
 */
export interface Chain {
  kind: "none" | "empty" | "indirect" | "unparseable" | "literal";
  entries: ChainEntry[];
  /** The LAST literal element's `toVersion`, or null when kind !==
   * "literal" or that element's value was unreadable. */
  terminus: string | null;
}

export interface Declaration {
  /** The identifier after `export const`. */
  name: string;
  /** Whether a type annotation (`: Foo`) sat between the identifier and
   * `=`. */
  hasType: boolean;
  /** True when the object literal has a depth-1 `type` property — the
   * discriminator real model declarations carry (`export const model = {
   * type: "@vendor/name", version: "…", … }`). Distinct from `hasType`,
   * which is about a TS type ANNOTATION on the const itself, not this
   * object PROPERTY. Used as the model-identity test: an unrelated helper
   * object that merely happens to have a `version` field (`export const
   * schemaInfo = { version: 3 }`) has no `type` key and must not be
   * mistaken for a model declaration. */
  hasTypeKey: boolean;
  /** True when `hasTypeKey` is true, there is exactly one depth-1 `type`
   * property, and its value is a plain double-quoted string starting with
   * `"@"` — swamp's own type-name shape (`@vendor/name`), verified against
   * all 59 real model declarations. `hasTypeKey` alone is not enough: a
   * JSON-Schema-shaped helper (`export const inputSchema = { type:
   * "object", properties: {…} }`) has a depth-1 `type` key too, and must
   * NOT be mistaken for a model just because the key is present — only a
   * `@vendor/name`-shaped VALUE identifies a real swamp model. Used
   * together with `hasDepth1Spread`/`hasUnreadableProperty` as the
   * model-identity test: a declaration is either KNOWN to be a model
   * (`hasModelType`) or its identity is UNREADABLE (a depth-1 spread or an
   * unreadable property key might be hiding the real `type`), and either
   * case must be evaluated rather than silently treated as "not a
   * model" — only a declaration with neither is safely ignored. */
  hasModelType: boolean;
  /** True when the object literal contains a depth-1 property whose key
   * could not be read — numeric (`0: …`), computed (`[expr]: …`), or an
   * accessor/modifier shape (`get upgrades() {…}`, `set x(v) {…}`, `async
   * foo() {…}`). The parser cannot know whether such a property
   * contributes an `upgrades` (or `version`) property, so a declaration
   * carrying one is unreadable at the policy layer — the same reasoning
   * `hasDepth1Spread` already applies to a depth-1 spread. */
  hasUnreadableProperty: boolean;
  /** True when `upgrades` appeared more than once at depth 1. Mirrors
   * `versionError`'s "more than one depth-1 key" handling — JavaScript
   * itself resolves a duplicate key to the LAST one, but reading only
   * `upgradesProps[0]` (as if the first were authoritative) can read a
   * chain that will never actually ship, so this must fail closed rather
   * than silently pick one. */
  hasDuplicateUpgrades: boolean;
  /** The declaration's `version` value, or null if absent/unreadable. */
  version: string | null;
  /** True when `version` appeared more than once at depth 1, or its
   * value was not a plain double-quoted string. */
  versionError: boolean;
  chain: Chain;
  /** True when the object literal contains ANY depth-1 spread element
   * (`...` followed by anything at all — bare identifier, parenthesised
   * expression, conditional, call, member access). The parser cannot
   * know whether such a spread contributes an `upgrades` property, so a
   * declaration carrying one is unreadable at the policy layer. */
  hasDepth1Spread: boolean;
  /** [start, end) offsets of the declaration's own object-literal body
   * (`{` through the matching `}`, inclusive) in the ORIGINAL source. Not
   * part of the parser's own contract (model_declarations.test.ts never
   * asserts it) — exposed for callers like check_upgrade_chain.ts that
   * need to raw-scan a SPECIFIC declaration's text (e.g. the
   * `upgrade-chain-unreadable` cross-check) rather than the whole file. */
  span: { start: number; end: number };
}

export interface MaskResult {
  /** Same length as the input; every comment/string/template-text/regex
   * character replaced with a space, newlines preserved. */
  mask: string;
  /** Non-null when the source contains an unterminated string, template
   * literal, or regex literal — the caller must treat this as a
   * violation, never a silent "no declarations found". */
  error: string | null;
  /** Offsets of every `${`'s `{` that maskCode kept LIVE (see the module
   * docblock's TEMPLATE INTERPOLATION trap). A whitespace skip that blanks
   * straight through a template's backtick and text can land ON one of
   * these — a caller testing "is the next significant mask character an
   * object-literal opener `{`" must reject an offset in this set rather
   * than treat a template's own interpolation brace as a declaration's or
   * a chain element's `{`. */
  interpolationBraces: Set<number>;
}

// Keywords after which a `/` opens a regex literal rather than acting as
// division — the previous significant WORD, never the previous character.
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
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

// Nested `${...}` interpolations recurse (scanTemplate -> scanCode ->
// scanOne -> scanTemplate for a nested template), so a pathological input
// is bounded well before it could exhaust the call stack — see
// check_property_harness.ts's identical MAX_TEMPLATE_DEPTH rationale.
const MAX_TEMPLATE_DEPTH = 200;

/** Masks comments, strings, template-literal text, and regex literals in
 * `src`, replacing each with spaces (newlines preserved) so a later
 * structural scan sees only real code shape. See the module docblock for
 * the regex-character-class and regex-vs-division traps this must not
 * regress on. Structured like check_property_harness.ts's
 * stripCommentsAndStrings (same repo, same class of problem) but
 * POSITION-PRESERVING: every output character sits at its source offset,
 * and a `${` interpolation's braces/code are copied LIVE rather than
 * dropped, so a depth-1 scan downstream sees them nested one level deeper
 * than the enclosing object/array. */
export function maskCode(src: string): MaskResult {
  const n = src.length;
  const out: string[] = new Array(n);
  let i = 0;
  // Whether the previously scanned significant token was a "value" —
  // drives the `/` regex-vs-division disambiguation. Shared across the
  // whole scan, including through template-interpolation recursion, so
  // classification is correct on both sides of an interpolation boundary.
  let lastTokenIsValue = false;
  let templateDepth = 0;
  let error: string | null = null;
  const interpolationBraces = new Set<number>();

  function fail(message: string): void {
    if (error === null) error = message;
  }

  function blankAt(pos: number): void {
    out[pos] = src[pos] === "\n" ? "\n" : " ";
  }

  function keepAt(pos: number): void {
    out[pos] = src[pos];
  }

  // `start` points at the opening `/` of a regex literal. Character-class
  // aware: an unescaped `[` sets inClass, an unescaped `]` clears it, and
  // an unescaped `/` terminates the literal only when inClass is false. A
  // backslash escapes the next character everywhere, body or class alike.
  // A raw newline before termination is an unterminated-literal error.
  function scanRegex(start: number): number {
    blankAt(start);
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === "\n") {
        fail("unterminated regex literal");
        return j;
      }
      if (c === "\\") {
        blankAt(j);
        if (j + 1 < n) blankAt(j + 1);
        j += 2;
        continue;
      }
      if (c === "[") {
        inClass = true;
        blankAt(j);
        j++;
        continue;
      }
      if (c === "]") {
        inClass = false;
        blankAt(j);
        j++;
        continue;
      }
      if (c === "/" && !inClass) {
        blankAt(j);
        j++;
        while (j < n && /[a-zA-Z]/.test(src[j])) {
          blankAt(j);
          j++;
        }
        return j;
      }
      blankAt(j);
      j++;
    }
    fail("unterminated regex literal");
    return j;
  }

  // `start` points at an opening `"`/`'`. A real string literal cannot
  // legally span a raw newline, so hitting one before the matching quote
  // is always an unterminated-literal error.
  function scanString(start: number): number {
    blankAt(start);
    const quote = src[start];
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (c === "\n") {
        fail("unterminated string literal");
        return j;
      }
      if (c === "\\") {
        blankAt(j);
        if (j + 1 < n) blankAt(j + 1);
        j += 2;
        continue;
      }
      if (c === quote) {
        blankAt(j);
        return j + 1;
      }
      blankAt(j);
      j++;
    }
    fail("unterminated string literal");
    return j;
  }

  // `start` points at the opening backtick. Raw template text is blanked;
  // a `${` interpolation blanks only the `$`, keeps the `{` live, and
  // recurses via scanCode(true) — which itself keeps the matching `}`
  // live when it closes the interpolation at depth 0.
  function scanTemplate(start: number): number {
    templateDepth++;
    if (templateDepth > MAX_TEMPLATE_DEPTH) {
      fail(
        `template interpolation nesting exceeds ${MAX_TEMPLATE_DEPTH} levels`,
      );
      templateDepth--;
      return n;
    }
    blankAt(start);
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (error !== null) {
        templateDepth--;
        return j;
      }
      if (c === "\\") {
        blankAt(j);
        if (j + 1 < n) blankAt(j + 1);
        j += 2;
        continue;
      }
      if (c === "`") {
        blankAt(j);
        templateDepth--;
        return j + 1;
      }
      if (c === "$" && src[j + 1] === "{") {
        blankAt(j); // the `$`
        keepAt(j + 1); // the `{` — stays live, matched by scanCode(true)
        interpolationBraces.add(j + 1);
        i = j + 2;
        scanCode(true);
        j = i;
        continue;
      }
      blankAt(j);
      j++;
    }
    fail("unterminated template literal");
    templateDepth--;
    return j;
  }

  // Consumes one comment/string/regex/template token at the CURRENT
  // position `i`, if one starts there — returns true and leaves `i`
  // advanced past it. Returns false so the caller falls through to
  // identifier/number/plain-character handling.
  function scanOne(): boolean {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      blankAt(i);
      blankAt(i + 1);
      let j = i + 2;
      while (j < n && src[j] !== "\n") {
        blankAt(j);
        j++;
      }
      i = j;
      lastTokenIsValue = false;
      return true;
    }

    if (c === "/" && next === "*") {
      blankAt(i);
      blankAt(i + 1);
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) {
        blankAt(j);
        j++;
      }
      if (j >= n) {
        fail("unterminated block comment");
        i = n;
        return true;
      }
      blankAt(j);
      blankAt(j + 1);
      i = j + 2;
      lastTokenIsValue = false;
      return true;
    }

    // Regex literal — only attempted in an operand-expected position.
    if (c === "/" && !lastTokenIsValue) {
      i = scanRegex(i);
      lastTokenIsValue = true;
      return true;
    }

    if (c === '"' || c === "'") {
      i = scanString(i);
      lastTokenIsValue = true;
      return true;
    }

    if (c === "`") {
      i = scanTemplate(i);
      lastTokenIsValue = true;
      return true;
    }

    return false;
  }

  // Shared scanner loop. At the top level (stopAtUnmatchedBrace false) it
  // runs to EOF. Inside a template interpolation (stopAtUnmatchedBrace
  // true) it tracks brace depth and returns once it consumes the
  // interpolation's own closing `}` — every `{`/`}` seen directly here
  // (not through scanOne, which consumes comments/strings/regexes/
  // templates as atomic units) is a genuine code-level brace.
  function scanCode(stopAtUnmatchedBrace: boolean): void {
    let depth = 0;
    while (i < n) {
      if (error !== null) return;
      if (scanOne()) continue;
      const c = src[i];
      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdentChar(src[j])) j++;
        const word = src.slice(i, j);
        for (let k = i; k < j; k++) keepAt(k);
        // A word right after `.` (or `?.`) is a PROPERTY NAME, never a
        // keyword in operator position — `o.in / 2` must lex `/` as
        // division even though "in" is one of REGEX_ALLOWED_AFTER_WORD's
        // 14 keywords. Look at the nearest already-emitted, non-whitespace
        // mask character (out[] is filled left-to-right, so everything
        // before `i` is final).
        let p = i - 1;
        while (p >= 0 && /\s/.test(out[p] as string)) p--;
        const afterDot = p >= 0 && out[p] === ".";
        lastTokenIsValue = afterDot || !REGEX_ALLOWED_AFTER_WORD.has(word);
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i;
        while (j < n && /[0-9A-Za-z_$.]/.test(src[j])) j++;
        for (let k = i; k < j; k++) keepAt(k);
        lastTokenIsValue = true;
        i = j;
        continue;
      }
      if (stopAtUnmatchedBrace && c === "{") {
        depth++;
        keepAt(i);
        lastTokenIsValue = false;
        i++;
        continue;
      }
      if (stopAtUnmatchedBrace && c === "}") {
        keepAt(i);
        if (depth === 0) {
          i++;
          return;
        }
        depth--;
        lastTokenIsValue = false;
        i++;
        continue;
      }
      // A completed `++`/`--` is a value-producing postfix operator (or a
      // prefix one immediately before a value) — `i++ / 2` must lex `/` as
      // division. Consume both characters as one token so the second `+`/
      // `-` doesn't re-trigger this same check.
      if ((c === "+" || c === "-") && src[i + 1] === c) {
        keepAt(i);
        keepAt(i + 1);
        lastTokenIsValue = true;
        i += 2;
        continue;
      }
      keepAt(i);
      if (!/\s/.test(c)) lastTokenIsValue = c === ")" || c === "]";
      i++;
    }
  }

  scanCode(false);
  if (error !== null) {
    // Every position must still be filled (out is a sparse array up to
    // wherever scanning stopped) so `.join("")` never inserts "undefined".
    for (let k = 0; k < n; k++) {
      if (out[k] === undefined) blankAt(k);
    }
  }
  return { mask: out.join(""), error, interpolationBraces };
}

/** Depth (0 = top level) of every position in `mask`, counting `(`/`[`/`{`
 * as +1 and `)`/`]`/`}` as -1, combined into one counter — a real,
 * balanced TS file never closes one bracket kind with another, so a
 * single counter is exact for "how many enclosing groups" without having
 * to track which kind each one is. `depth[i]` is the depth BEFORE
 * processing position `i` (so an opening bracket itself is recorded at
 * its OUTER depth; its contents start one deeper). */
function computeDepth(mask: string): number[] {
  const n = mask.length;
  const depth: number[] = new Array(n);
  let d = 0;
  for (let i = 0; i < n; i++) {
    depth[i] = d;
    const c = mask[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
  }
  return depth;
}

/** Finds, over the mask, the index of the delimiter matching the one at
 * `openPos` (which must hold `openCh`), by counting `openCh`/`closeCh`
 * occurrences from `openPos` onward. Returns -1 if unbalanced. */
function matchDelims(
  mask: string,
  openPos: number,
  openCh: string,
  closeCh: string,
): number {
  let d = 0;
  for (let i = openPos; i < mask.length; i++) {
    if (mask[i] === openCh) d++;
    else if (mask[i] === closeCh) {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** Splits [start, end) into spans separated by commas that sit at exactly
 * `targetDepth` in `depth` — every other comma (inside a nested call,
 * array, object, or template interpolation) is deeper and does not
 * split. A trailing comma before `end` yields one trailing span that is
 * empty (or whitespace/comment-only); callers filter that out via a
 * MASK-based emptiness check, never a raw-text one (raw text inside a
 * comment or interpolation is not "empty" the way its mask projection
 * is — see the module docblock). */
function splitTopLevel(
  mask: string,
  start: number,
  end: number,
  depth: number[],
  targetDepth: number,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let segStart = start;
  for (let i = start; i < end; i++) {
    if (depth[i] === targetDepth && mask[i] === ",") {
      spans.push([segStart, i]);
      segStart = i + 1;
    }
  }
  spans.push([segStart, end]);
  return spans;
}

/** Skips leading whitespace and full `//`/`/* *‍/` comments in [start, end)
 * of the RAW source, stopping at the first character that is neither —
 * this is deliberately a raw-text mini-lexer for trivia, not a mask-based
 * whitespace skip: a mask-based skip cannot tell "blank because comment"
 * from "blank because quoted-key string" (both mask to spaces), but a
 * comment is unambiguous in RAW text (it starts with a literal `//` or
 * `/‍*`), so recognizing it explicitly here means the quote-detection that
 * follows never has to guess. This is what keeps a raw double-quote
 * character SITTING INSIDE a comment (e.g. `// the model's "migration"
 * history`) from being mistaken for the start of a quoted key: the whole
 * comment is skipped as one unit before any quote check ever runs. */
function skipTrivia(raw: string, start: number, end: number): number {
  let pos = start;
  while (pos < end) {
    const c = raw[pos];
    if (/\s/.test(c)) {
      pos++;
      continue;
    }
    if (c === "/" && raw[pos + 1] === "/") {
      pos += 2;
      while (pos < end && raw[pos] !== "\n") pos++;
      continue;
    }
    if (c === "/" && raw[pos + 1] === "*") {
      pos += 2;
      while (pos < end - 1 && !(raw[pos] === "*" && raw[pos + 1] === "/")) {
        pos++;
      }
      pos = Math.min(pos + 2, end);
      continue;
    }
    return pos;
  }
  return pos;
}

/** Reads a quoted key's text out of RAW source starting at its opening
 * quote, honouring backslash escapes. Returns the key, the index just past
 * the closing quote (or `raw.length` if never closed — malformed input the
 * caller's own maskCode pass would already have flagged as an unterminated
 * string, so this path is defensive only), and `hadEscape`: true when the
 * raw text contained a backslash. This reader does not decode escapes to
 * their real meaning (`u` is not turned into `u`) — it only consumes
 * the character AFTER the backslash literally — so a caller must not treat
 * `key` as the true property name when `hadEscape` is true. `"BSu0075pgrades"`
 * (written here with BS standing for one literal backslash so this comment
 * cannot be misread as decoded text) yields the plausible-but-wrong key
 * "u0075pgrades" even though tsc and the JS runtime both resolve the real
 * property to "upgrades". */
function readQuotedKey(
  raw: string,
  start: number,
): { key: string; end: number; hadEscape: boolean } {
  const quote = raw[start];
  let j = start + 1;
  let key = "";
  let hadEscape = false;
  while (j < raw.length) {
    const c = raw[j];
    if (c === "\\") {
      hadEscape = true;
      key += raw[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (c === quote) return { key, end: j + 1, hadEscape };
    key += c;
    j++;
  }
  return { key, end: j, hadEscape };
}

interface PropEntry {
  /** null for a spread element (no key at all) or an unrecognized key
   * shape (numeric/computed — not used by this gate). */
  key: string | null;
  isSpread: boolean;
  valueStart: number;
  valueEnd: number;
}

/** Reads every depth-1 (relative to `propDepth`) property of an object
 * literal spanning [start, end) — the raw object interior, i.e. just
 * after its `{` and just before its matching `}`. A key MAY be bare
 * (`upgrades`) or quoted (`"upgrades"`/`'upgrades'`); either names the
 * same property, and both are read from RAW source (never the mask,
 * which blanks a quoted key's text along with its quotes). A depth-1
 * spread (`...`, any shape) is recorded with `isSpread: true` and no key. */
function scanObjectProperties(
  raw: string,
  mask: string,
  depth: number[],
  start: number,
  end: number,
  propDepth: number,
): PropEntry[] {
  const spans = splitTopLevel(mask, start, end, depth, propDepth);
  const out: PropEntry[] = [];
  for (const [segStart, segEnd] of spans) {
    if (mask.slice(segStart, segEnd).trim() === "") continue; // trailing comma tail, or comment/whitespace-only
    const keyPos = skipTrivia(raw, segStart, segEnd);
    if (keyPos >= segEnd) continue;
    if (raw.slice(keyPos, keyPos + 3) === "...") {
      out.push({
        key: null,
        isSpread: true,
        valueStart: keyPos,
        valueEnd: segEnd,
      });
      continue;
    }
    let keyName: string;
    let afterKey: number;
    if (raw[keyPos] === '"' || raw[keyPos] === "'") {
      const q = readQuotedKey(raw, keyPos);
      if (q.hadEscape) {
        // The reader above does not decode escapes, so a raw backslash
        // means `q.key` may not be the true property name — see
        // readQuotedKey's doc for the "upgrades" written with a
        // backslash-escape example. Claiming a plausible-but-wrong key
        // here would let it slip past both the structural scan and the
        // raw cross-check, so fail closed instead.
        out.push({
          key: null,
          isSpread: false,
          valueStart: segStart,
          valueEnd: segEnd,
        });
        continue;
      }
      keyName = q.key;
      afterKey = q.end;
    } else if (isIdentStart(raw[keyPos])) {
      let j = keyPos;
      while (j < segEnd && isIdentChar(raw[j])) j++;
      keyName = raw.slice(keyPos, j);
      afterKey = j;
    } else {
      // A numeric or computed (`[expr]`) key — not a shape this gate
      // needs to name, but still a real property, so it must not be
      // silently dropped from the property count.
      out.push({
        key: null,
        isSpread: false,
        valueStart: segStart,
        valueEnd: segEnd,
      });
      continue;
    }
    // The text just read is only a KEY if the next significant character
    // is `:` (an explicit `key: value` pair) or the segment simply ends
    // there (a genuine shorthand, `{ version }`). Anything else — `[`,
    // `(`, `<`, or a second identifier — means what was just read is a
    // modifier (an accessor/method/generic shape: `get upgrades() {…}`,
    // `get ["upgrades"]() {…}`, `async upgrades() {…}`, `static upgrades =
    // …`), not the key, so the real key (if any) is unreadable and must
    // fail closed. This single check subsumes the previous
    // second-identifier-only heuristic, which missed `get ["upgrades"]()`
    // (`[` is not a second identifier).
    const sigPos = skipTrivia(raw, afterKey, segEnd);
    if (sigPos < segEnd && mask[sigPos] !== ":") {
      out.push({
        key: null,
        isSpread: false,
        valueStart: segStart,
        valueEnd: segEnd,
      });
      continue;
    }
    if (sigPos >= segEnd) {
      // Shorthand property (`{ version }`) or otherwise no explicit
      // value — record the key with an empty value region rather than
      // dropping it.
      out.push({
        key: keyName,
        isSpread: false,
        valueStart: segEnd,
        valueEnd: segEnd,
      });
      continue;
    }
    out.push({
      key: keyName,
      isSpread: false,
      valueStart: sigPos + 1,
      valueEnd: segEnd,
    });
  }
  return out;
}

// Matches a plain double-quoted scalar with no escapes — the same shape
// swamp itself requires for `version`/`toVersion` values in this repo.
const QUOTED_VALUE_RE = /^\s*"([^"\\\n]*)"\s*$/;

function parseQuotedValue(
  raw: string,
  start: number,
  end: number,
): string | null {
  const m = QUOTED_VALUE_RE.exec(raw.slice(start, end));
  return m ? m[1] : null;
}

// Same shape as QUOTED_VALUE_RE, but tolerates a trailing `as <Type>` /
// `satisfies <Type>` assertion — the same tolerance classifyChain already
// gives a `upgrades[]` array literal, needed because a real declaration
// writes its type discriminator as `type: "@vendor/name" as const,`
// (comfyui.ts:351).
const QUOTED_VALUE_WITH_ASSERTION_RE =
  /^\s*"([^"\\\n]*)"\s*(?:(?:as|satisfies)\b.*)?$/;

function parseQuotedValueAllowingAssertion(
  raw: string,
  start: number,
  end: number,
): string | null {
  const m = QUOTED_VALUE_WITH_ASSERTION_RE.exec(raw.slice(start, end));
  return m ? m[1] : null;
}

/** Classifies an `upgrades` property's value region. See the Chain
 * interface for the five possible kinds and DESIGN DECISION 3 / step 7(a)
 * in plan v4 for the full rationale — summarized in the module docblock. */
function classifyChain(
  raw: string,
  mask: string,
  depth: number[],
  valueStart: number,
  valueEnd: number,
): Chain {
  let i = valueStart;
  while (i < valueEnd && /\s/.test(mask[i])) i++;
  if (i >= valueEnd || mask[i] !== "[") {
    return { kind: "indirect", entries: [], terminus: null };
  }
  const arrayOpen = i;
  const arrayClose = matchDelims(mask, arrayOpen, "[", "]");
  if (arrayClose === -1) {
    return { kind: "unparseable", entries: [], terminus: null };
  }
  // The value must be the array literal AND NOTHING ELSE — a trailing
  // `.concat(BROKEN)` (or any other expression tacked onto the array) means
  // the array we just matched is only PART of the value, and reading it
  // alone would silently ignore whatever comes after. A trailing `as`/
  // `satisfies` type assertion is tolerated (the parser already unwraps
  // those at the declaration level; disallowing them here would reject a
  // legal, common annotation for no safety gain).
  const afterArray = mask.slice(arrayClose + 1, valueEnd).trim();
  if (afterArray !== "" && !/^(as|satisfies)\b/.test(afterArray)) {
    return { kind: "indirect", entries: [], terminus: null };
  }
  const elemDepth = depth[arrayOpen] + 1;
  const spans = splitTopLevel(
    mask,
    arrayOpen + 1,
    arrayClose,
    depth,
    elemDepth,
  );
  const nonEmpty = spans.filter(([s, e]) => mask.slice(s, e).trim() !== "");
  if (nonEmpty.length === 0) {
    return { kind: "empty", entries: [], terminus: null };
  }

  type Shape = {
    start: number;
    end: number;
    kind: "spread" | "object" | "other";
  };
  const shapes: Shape[] = nonEmpty.map(([s, e]) => {
    let k = s;
    while (k < e && /\s/.test(mask[k])) k++;
    if (mask.slice(k, k + 3) === "...") {
      return { start: k, end: e, kind: "spread" };
    }
    if (mask[k] === "{") return { start: k, end: e, kind: "object" };
    return { start: k, end: e, kind: "other" };
  });

  if (shapes.some((s) => s.kind === "spread")) {
    return { kind: "indirect", entries: [], terminus: null };
  }
  if (shapes.some((s) => s.kind !== "object")) {
    return { kind: "unparseable", entries: [], terminus: null };
  }

  const entries: ChainEntry[] = [];
  for (const s of shapes) {
    const objClose = matchDelims(mask, s.start, "{", "}");
    if (objClose === -1) {
      entries.push({ toVersion: null });
      continue;
    }
    const propDepth = depth[s.start] + 1;
    const props = scanObjectProperties(
      raw,
      mask,
      depth,
      s.start + 1,
      objClose,
      propDepth,
    );
    const toVersionProp = props.find((p) => p.key === "toVersion");
    const toVersion = toVersionProp
      ? parseQuotedValue(raw, toVersionProp.valueStart, toVersionProp.valueEnd)
      : null;
    entries.push({ toVersion });
  }
  return {
    kind: "literal",
    entries,
    terminus: entries.length > 0 ? entries[entries.length - 1].toVersion : null,
  };
}

/** One depth-0 event a declaration's own `=` search can run into: a
 * bracket OPEN (`{`/`[`/`(`), a genuine assignment `=` (excluding the
 * compound operators `==`/`!=`/`<=`/`>=`/`=>`), or a statement-terminating
 * `;`. */
interface Boundary {
  pos: number;
  kind: "open" | "eq" | "semi";
}

/** Precomputes EVERY depth-0 boundary event in `mask`, in ONE linear pass,
 * already sorted by position (a single left-to-right scan naturally
 * yields them in order) — replaces scanModelDeclarations's previous
 * per-match tail rescan, which was quadratic in the number of `export
 * const` matches with no following depth-0 `=`/`;` of their own (`export
 * const enum E { A = 0 }`, the exact shape whose `deno fmt`-canonical form
 * — no trailing `;` — has no depth-0 terminator at all). Consumed by a
 * single monotone pointer in scanModelDeclarations's own loop, since
 * matches are found in non-decreasing position order: each boundary is
 * visited a bounded number of times across the WHOLE scan, however many
 * `export const` matches the file contains, making the combined scan O(n)
 * regardless of how many (or how few) `=`/`;` characters punctuate it.
 * `open` events are nested content's `{`/`[`/`(` — depth-1+ characters
 * inside them are invisible here by construction (only depth-0 positions
 * are ever recorded), so a long block contributes exactly ONE entry
 * (its open), not one per character. */
function findDepth0Boundaries(mask: string, depth: number[]): Boundary[] {
  const n = mask.length;
  const boundaries: Boundary[] = [];
  for (let k = 0; k < n; k++) {
    if (depth[k] !== 0) continue;
    const c = mask[k];
    if (c === "{" || c === "[" || c === "(") {
      boundaries.push({ pos: k, kind: "open" });
      continue;
    }
    if (c === ";") {
      boundaries.push({ pos: k, kind: "semi" });
      continue;
    }
    if (c !== "=") continue;
    const prevC = k > 0 ? mask[k - 1] : "";
    const nextC = k + 1 < n ? mask[k + 1] : "";
    if (prevC === "=" || prevC === "!" || prevC === "<" || prevC === ">") {
      continue;
    }
    if (nextC === "=" || nextC === ">") continue;
    boundaries.push({ pos: k, kind: "eq" });
  }
  return boundaries;
}

/** Finds every `export const <ident>[: Type] = { ... }` declaration at
 * delimiter depth 0, over `maskCode(src)`'s mask, reading values back out
 * of the raw source at mask-derived offsets. Throws when `maskCode`
 * reports an unterminated literal — callers must treat that as a
 * violation, never an empty result. */
export function scanModelDeclarations(src: string): Declaration[] {
  const { mask, error, interpolationBraces } = maskCode(src);
  if (error !== null) {
    throw new Error(`model_declarations: unable to lex source: ${error}`);
  }
  const n = src.length;
  const depth = computeDepth(mask);
  const boundaries = findDepth0Boundaries(mask, depth);
  // Shared, monotone cursor into `boundaries` — matches are found by
  // `exportConstRe` in non-decreasing position order, and (once a
  // declaration is parsed) `lastIndex` is jumped past its own body, so
  // `afterIdent` across the whole while loop below is also non-decreasing.
  // That lets every match's own `=`-search advance this ONE pointer
  // forward instead of rescanning `mask` from its own `afterIdent` — see
  // findDepth0Boundaries's doc for why this makes the whole scan O(n).
  let boundaryIdx = 0;
  const declarations: Declaration[] = [];
  const exportConstRe = /\bexport\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = exportConstRe.exec(mask)) !== null) {
    const matchStart = m.index;
    if (depth[matchStart] !== 0) continue;
    const name = m[1];
    const afterIdent = exportConstRe.lastIndex;

    let q = afterIdent;
    while (q < n && /\s/.test(mask[q])) q++;
    const hasType = mask[q] === ":";

    while (
      boundaryIdx < boundaries.length &&
      boundaries[boundaryIdx].pos < afterIdent
    ) {
      boundaryIdx++;
    }
    let eq = -1;
    let scanIdx = boundaryIdx;
    while (scanIdx < boundaries.length) {
      const boundary = boundaries[scanIdx];
      if (boundary.kind === "open") {
        // A depth-0 bracket with NO type annotation before it (`hasType`
        // false) cannot legally belong to this declaration — a bare
        // `const IDENT` allows nothing but `=` (modulo whitespace/
        // comments) before its initializer, so this is an UNRELATED block
        // (e.g. `export const enum E { A = 0 }`'s own body, once the
        // regex has already — wrongly, see the LOW fix for that —
        // captured "enum" as the identifier). Treat exactly like hitting
        // a `;`: this match's own '=' search found nothing, so it must
        // not adopt whatever comes after the block as its value. A `{`
        // guarded by a real type annotation (`CONFIG: { a: number } =
        // {...}`) is legitimate and transparent — skip over it and keep
        // looking for this declaration's own '='.
        if (!hasType) break;
        scanIdx++;
        continue;
      }
      if (boundary.kind === "semi") break;
      eq = boundary.pos;
      break;
    }
    boundaryIdx = scanIdx;
    if (eq === -1) continue;

    let b = eq + 1;
    while (b < n && /\s/.test(mask[b])) b++;
    // A live template-interpolation brace landed at `b` (the whitespace
    // skip above blanked straight through a preceding template's backtick
    // and text) is not a real declaration body — see maskCode's
    // `interpolationBraces` doc.
    if (mask[b] !== "{" || interpolationBraces.has(b)) continue;

    const close = matchDelims(mask, b, "{", "}");
    if (close === -1) continue;

    const innerDepth = depth[b] + 1;
    const props = scanObjectProperties(
      src,
      mask,
      depth,
      b + 1,
      close,
      innerDepth,
    );
    const versionProps = props.filter((p) => p.key === "version");
    const upgradesProps = props.filter((p) => p.key === "upgrades");
    const typeProps = props.filter((p) => p.key === "type");
    const hasDepth1Spread = props.some((p) => p.isSpread);
    const hasTypeKey = typeProps.length > 0;
    // A `type` key alone is not enough — a JSON-Schema-shaped helper
    // (`{ type: "object", … }`) has one too. Only a single, plainly
    // quoted `"@vendor/name"`-shaped value identifies a real swamp model;
    // see the Declaration interface's `hasModelType` doc.
    const typeValue = typeProps.length === 1
      ? parseQuotedValueAllowingAssertion(
        src,
        typeProps[0].valueStart,
        typeProps[0].valueEnd,
      )
      : null;
    const hasModelType = typeValue !== null && typeValue.startsWith("@");
    const hasUnreadableProperty = props.some((p) =>
      p.key === null && !p.isSpread
    );
    const hasDuplicateUpgrades = upgradesProps.length > 1;

    let version: string | null = null;
    let versionError = false;
    if (versionProps.length === 1) {
      version = parseQuotedValue(
        src,
        versionProps[0].valueStart,
        versionProps[0].valueEnd,
      );
      versionError = version === null;
    } else if (versionProps.length > 1) {
      versionError = true;
    }

    const chain: Chain = upgradesProps.length > 0
      ? classifyChain(
        src,
        mask,
        depth,
        upgradesProps[0].valueStart,
        upgradesProps[0].valueEnd,
      )
      : { kind: "none", entries: [], terminus: null };

    declarations.push({
      name,
      hasType,
      hasTypeKey,
      hasModelType,
      hasUnreadableProperty,
      hasDuplicateUpgrades,
      version,
      versionError,
      chain,
      hasDepth1Spread,
      span: { start: b, end: close + 1 },
    });
    exportConstRe.lastIndex = close + 1;
  }
  return declarations;
}
