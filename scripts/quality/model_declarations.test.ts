/**
 * Tests for scripts/quality/model_declarations.ts — DOES NOT EXIST YET on
 * this branch. This is the RED half of plan v4 PR B step 7(a): the PARSER,
 * tested apart from the policy (scripts/quality/check_upgrade_chain.ts,
 * tested separately in check_upgrade_chain.test.ts). Every test below is
 * expected to fail with a module-resolution error until step 7 lands.
 *
 * WHY A PARSER AND NOT LINE ANCHORS — see plan v4 DESIGN DECISION 3. A
 * line-anchored scanner has four fmt-stable holes (a comment inside a
 * non-empty chain, a comment-only array, a single-line literal array, a
 * trailing-comment-guarded empty array) plus two more blind spots (a
 * column-0 `};` inside a template literal, `upgrades: [...CONST]`). So the
 * gate ships its own single-pass lexer: MASK every comment/string/template/
 * regex to spaces (offsets and newlines preserved), then navigate the mask
 * with balanced-delimiter matching.
 *
 * CONTRACT UNDER TEST, transcribed from plan v4 step 7(a):
 *
 *   maskCode(src: string): { mask: string; error: string | null }
 *     Returns a string the SAME LENGTH as src, with every character
 *     belonging to a line comment, block comment, string literal, template
 *     literal TEXT, or regex literal replaced by a space (newlines
 *     preserved). `${` interpolations keep their braces LIVE (blank only
 *     the `$`) so interpolated code nests one level deeper and can never be
 *     mistaken for a property of the enclosing object literal. A regex
 *     literal is scanned with CHARACTER-CLASS state: an unescaped `[` sets
 *     `inClass`, an unescaped `]` clears it, and an unescaped `/` only
 *     terminates the literal when `inClass` is false — a backslash escapes
 *     the next character everywhere, body or class alike. Regex-vs-division
 *     is decided on the previous significant TOKEN (word), not the previous
 *     character: a `/` is division after a non-keyword identifier, a
 *     numeric/string/template/regex literal, `)`, `]`, `++`, or `--`; it
 *     opens a regex in every other position, including after the keywords
 *     return/typeof/instanceof/in/of/new/delete/void/do/else/yield/await/
 *     throw/case. An unterminated string/template/regex is a non-null
 *     `error`, never a silent "absent" — the caller turns that into a
 *     VIOLATION, so this test suite pins the parser as THROWING when
 *     scanModelDeclarations is asked to read source maskCode could not
 *     finish masking.
 *
 *   interface ChainEntry { toVersion: string | null }
 *   interface Chain {
 *     kind: "none" | "empty" | "indirect" | "unparseable" | "literal";
 *     entries: ChainEntry[];
 *     terminus: string | null;  // last literal entry's toVersion
 *   }
 *   interface Declaration {
 *     name: string;
 *     hasType: boolean;
 *     version: string | null;
 *     versionError: boolean;      // >1 depth-1 `version` key, or malformed
 *     chain: Chain;
 *     hasDepth1Spread: boolean;   // ANY depth-1 spread element — see the
 *                                 // amendment note below, NOT `...IDENT`
 *                                 // only
 *   }
 *   scanModelDeclarations(src: string): Declaration[]
 *     Finds `export const <ident>` at delimiter depth 0 over the MASK, skips
 *     an optional type annotation up to the first depth-0 `=` (not part of
 *     `==`/`!=`/`=>`/`<=`/`>=`), and requires `{` next. Closes the object by
 *     BALANCED DELIMITER MATCHING on the mask, never a `^\};$` line test.
 *     Collects depth-1 property keys — a key MAY be quoted (`"upgrades"` /
 *     `'upgrades'`), read from the RAW source at the mask-derived offset
 *     (checked BEFORE any whitespace skip, since a masked quote is a space
 *     in the mask and a whitespace-skip that runs first consumes it,
 *     silently missing the branch).
 *     An ELEMENT of a literal chain array is a span between depth-1 commas
 *     inside `[`…`]` that is NON-EMPTY AFTER TRIMMING — a trailing comma
 *     (which `deno fmt` enforces on every one of the 31 real chains)
 *     produces no extra element.
 *     CHAIN CLASSIFICATION: not starting with `[` -> indirect (identifier,
 *     call, conditional, member access — anything); `[`…`]` with zero
 *     elements -> empty (LEGAL); any element starting with `...` -> also
 *     indirect; an element not starting with `{` -> unparseable; else ->
 *     literal, with `terminus` read from the LAST element's `toVersion`.
 *
 * AMENDMENT, binding, agreed after plan v4 approval (see
 * scratchpad/cipg-implement.yaml): `hasDepth1Spread` fires on ANY depth-1
 * spread element in the model object literal — bare identifier
 * (`...IDENT`), parenthesised expression, conditional, call, or member
 * access — not `...IDENT` only. Both required fixtures
 * (`{ ...CHAIN_BASE }` and `{ ...(LEGACY ? LEGACY_BASE : CHAIN_BASE) }`) are
 * exercised here at the PARSER level (hasDepth1Spread), because that is
 * where spread detection actually lives; the amendment's own required
 * assertion of the RULE NAME `model-declaration-indirect` lives in
 * check_upgrade_chain.test.ts, since rule names are a POLICY concept
 * model_declarations.ts does not have — see this task's final report for
 * why that split was chosen.
 *
 * Fixtures are plain (non-template-literal) JS string values built via the
 * `lines()` helper below specifically so a literal backtick or `${` inside
 * a FIXTURE never has to fight this test file's own template-literal
 * escaping — only `"` and `\` ever need escaping in a plain string, and
 * `lines()` picks single- vs double-quoting per line to dodge even that
 * where possible.
 *
 * FIXTURE-REGISTRY WIRING, fixed after the final plan-review round. Every
 * fmt-clean fixture's `lines(...)` call is a MODULE-LEVEL const (`fxNNSrc`),
 * not a `const` local to its Deno.test body, and `fmtCleanFixtures.set(...)`
 * is a module-level statement sitting right next to it — both run at IMPORT
 * time, unconditionally, before any `Deno.test` callback executes. This is
 * why the standalone fmt-clean test near the bottom of this file no longer
 * depends on which OTHER tests happened to run first: the previous shape
 * populated `fmtCleanFixtures` as a side effect of each fixture's own
 * Deno.test body running, which only happens when that specific test is
 * scheduled — correct under a full `deno test` run (definition order), but
 * silently incomplete under `--filter` (a fixture's owning test excluded ->
 * never registered) and order-dependent under `--shuffle=<seed>` (the
 * registration test could run before some fixtures registered at all).
 * Registration is now immune to both.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { maskCode, scanModelDeclarations } from "./model_declarations.ts";

function lines(...ls: string[]): string {
  return ls.join("\n") + "\n";
}

/**
 * fmt-clean fixture registry for testStrategy C's fmt-check requirement
 * (plan v4 step 7): "Fixtures are source-text strings; each is also
 * asserted `deno fmt --check`-clean so no future anchor change can be
 * justified by an fmt claim nobody ran." Every syntactically-valid fixture
 * below is a module-level `fxNNSrc` const (fx01..fx08, fx12..fx23 — 20 in
 * file order) with a `fmtCleanFixtures.set("fxNN", fxNNSrc)` statement
 * immediately beside it, both evaluated at module load. fx09, fx10, fx11
 * (the three deliberately UNTERMINATED string/template literal fixtures)
 * stay local to their own test bodies and are NEVER hoisted or registered:
 * they are inputs to the LEXER ERROR PATH, not valid TypeScript, and cannot
 * be fmt-clean by construction. See the standalone fmt-check test at the
 * bottom of this file, which iterates this map in ONE batched subprocess
 * call and independently re-derives the expected count from this file's own
 * source (see EXPECTED_FIXTURE_PATTERN below) rather than a hand-maintained
 * literal, so an fxNN const added without a matching `.set(...)` call is
 * caught rather than silently unfmt-checked.
 */
const fmtCleanFixtures = new Map<string, string>();

// ============================================================================
// maskCode — comment / string / template / regex masking
// ============================================================================

const fx01Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.2",',
  "  upgrades: [",
  "    // fixed a bug here",
  '    { fromVersion: "2026.01.01.1", toVersion: "2026.01.01.2" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx01", fx01Src);

Deno.test("maskCode: a line comment inside a non-empty chain is masked, so the array still parses as ONE element (mutation: stop masking line comments -> this fixture stops parsing as a 1-entry literal chain)", () => {
  const src = fx01Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "literal");
  assertEquals(decl.chain.entries.length, 1);
  assertEquals(decl.chain.terminus, "2026.01.01.2");
});

const fx02Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.2",',
  "  upgrades: [",
  "    `${p, q}`,",
  '    { fromVersion: "2026.01.01.1", toVersion: "2026.01.01.2" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx02", fx02Src);

Deno.test("maskCode: a template interpolation's TOP-LEVEL comma is nested one level deeper than the enclosing array, never mistaken for a depth-1 element separator (mutation: mask the ${ interpolation braces as well as the text (blank-interp-braces) -> a raw, brace-less comma from inside the interpolation lands at the SAME depth as the upgrades[] array's own elements, splitting the chain into more elements than exist and corrupting classification; mutation: mask the whole interpolation INCLUDING its code (mask-interpolation) -> the element that should carry the live '{' from the interpolation instead resolves to no live character at all, same corruption. The comma-bearing interpolation is placed as a DIRECT ELEMENT of upgrades[] itself, not inside an unrelated 'description' property, because that is where a spurious depth-1 split is actually observable — verified against a reference implementation: the correct parser gives chain.kind 'literal' with terminus '2026.01.01.2' (the junk template element contributes a null toVersion, harmless since only the LAST element's toVersion is read); both mutations above give 'unparseable' instead)", () => {
  const src = fx02Src;
  const { error } = maskCode(src);
  assertEquals(error, null);
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].version, "2026.01.01.2");
  assertEquals(decls[0].chain.kind, "literal");
  assertEquals(decls[0].chain.terminus, "2026.01.01.2");
  // Pins the "keep the interpolation braces LIVE" half of the maskCode
  // contract (plan step 7(a)): a correct parser sees the live `{` from the
  // interpolation and counts it as its OWN element, so entries.length is 2
  // (the junk template element plus the real one). The mask-interpolation
  // mutant blanks the whole interpolation including its code, so that
  // element becomes whitespace-only and is DROPPED by the "non-empty after
  // trimming" element rule, leaving entries.length at 1 — this assertion is
  // what actually kills that mutant; kind/terminus alone do not.
  assertEquals(decls[0].chain.entries.length, 2);
});

const fx03Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  '  // the chain below is the model\'s "migration" history',
  "  upgrades: [",
  '    { fromVersion: "2026.01.01.0", toVersion: "2026.01.01.1" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx03", fx03Src);

Deno.test("maskCode: a double-quote character sitting inside a LINE COMMENT immediately above the 'upgrades' key must not desynchronise the quoted-key raw-character scan for the property that follows (mutation: none exercised here beyond the existing masking contract — this fixture pins that a comment's raw quote is fully masked away and plays no part in reading the next real key) (mutation: read the property key by scanning the RAW source for the first quote character anywhere before the colon, instead of skipping masked trivia first -> this fixture reddens, because the comment's quote would be mistaken for the key's opening quote)", () => {
  const src = fx03Src;
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].chain.kind, "literal");
  assertEquals(decls[0].chain.terminus, "2026.01.01.1");
});

const fx04Src = lines(
  "export const model = {",
  '  // the "canonical" version lives here',
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx04", fx04Src);

Deno.test("maskCode: a double-quote character inside a LINE COMMENT immediately above 'version' must not desynchronise the version scan either — same class of fixture, different property", () => {
  const src = fx04Src;
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].version, "2026.01.01.1");
});

const fx05Src = lines(
  "function detect(x: string): boolean {",
  "  return /uses a ` backtick in its body/i.test(x);",
  "}",
  "",
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx05", fx05Src);

Deno.test("maskCode: regex-vs-division decided on the previous WORD, not the previous character — a regex literal right after 'return' containing a bare backtick must not flip the rest of the file into template mode (mutation: decide on the previous CHARACTER instead -> this reddens; this is the real defect measured in flipper-zero/extensions/models/lib/protocol.ts:285, where the char immediately before the regex's '/' is 'n' (the tail of 'return'), which a char-based check cannot recognise as the keyword 'return')", () => {
  const src = fx05Src;
  const { error } = maskCode(src);
  assertEquals(error, null, `expected no lex error, got: ${error}`);
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].version, "2026.01.01.1");
  assertEquals(decls[0].chain.kind, "empty");
});

const fx06Src = lines(
  "const PERFUME_HREF = /\\/perfume\\/([^/]+)\\.html/;",
  "",
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx06", fx06Src);

Deno.test("maskCode: an unescaped '/' INSIDE a regex character class does not terminate the literal (mutation: stop tracking [ ] character classes inside a regex literal -> this fixture reddens; modelled on fragrantica/extensions/models/fragrantica.ts:252's PERFUME_HREF, which has 9 manifest-listed sibling files carrying 21 such sites)", () => {
  const src = fx06Src;
  const { error } = maskCode(src);
  assertEquals(error, null, `expected no lex error, got: ${error}`);
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].version, "2026.01.01.1");
});

const fx07Src = lines(
  "const hasSeparator = /[\\\\/]/.test(area);",
  "",
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx07", fx07Src);

Deno.test("maskCode: an escaped backslash immediately before an unescaped '/' inside a character class is still class-aware (mutation: stop tracking [ ] character classes -> this fixture reddens too; modelled on fidonet-msgbase/extensions/models/fidonet_msgbase.ts:122's hasSeparator)", () => {
  const src = fx07Src;
  const { error } = maskCode(src);
  assertEquals(error, null, `expected no lex error, got: ${error}`);
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
});

const fx08Src = lines(
  "const RE = /[`\\]/]/;",
  "",
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx08", fx08Src);

Deno.test("maskCode: a character class ends at the FIRST unescaped ']' — an escaped '\\]' inside the class is a class MEMBER, not the terminator, and the class holds a '/' AFTER that escaped ']' so a mis-lex is observable (mutation: end a character class at the first ']' regardless of a preceding backslash -> this reddens: the mutant clears inClass one character early at the escaped ']', the very next '/' is then read as the literal's TERMINATOR instead of a class member, and the stray unbalanced ']' that follows drives the mask's delimiter depth off zero, which pushes the 'export const model' declaration below out of depth-0 and the parser stops finding it entirely — verified against a reference implementation: baseline yields 1 declaration, the mutant yields 0. A class holding no '/' after its escaped ']' — e.g. the real firecracker.ts:9 PATH_RE — cannot discriminate this mutation at all, which is why the fixture must include one to be non-vacuous)", () => {
  const src = fx08Src;
  const { error } = maskCode(src);
  assertEquals(error, null, `expected no lex error, got: ${error}`);
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].version, "2026.01.01.1");
});

Deno.test("maskCode: an unterminated string literal returns a non-null error (mutation: return 'absent' instead of an error for an unterminated string -> this reddens, and a caller inverting the check would read the file as clean)", () => {
  const src = 'const oops = "never closes\n' +
    "export const model = {\n" +
    '  version: "2026.01.01.1",\n' +
    "};\n";
  const { error } = maskCode(src);
  assert(
    error !== null,
    "expected a non-null error for an unterminated string literal",
  );
});

Deno.test("maskCode: an unterminated template literal ALSO returns a non-null error", () => {
  const src = "const oops = `never closes\n" +
    "export const model = {\n" +
    '  version: "2026.01.01.1",\n' +
    "};\n";
  const { error } = maskCode(src);
  assert(
    error !== null,
    "expected a non-null error for an unterminated template",
  );
});

Deno.test("scanModelDeclarations: an unterminated string literal is surfaced as a thrown error, never as an empty/absent declaration list (mutation: swallow the lex error and return [] -> a caller distinguishing 'zero declarations' (model-declaration-unreadable) from 'unlexable source' (model-source-unlexable) would misclassify this file)", () => {
  const src = 'const oops = "never closes\n' +
    "export const model = {\n" +
    '  version: "2026.01.01.1",\n' +
    "};\n";
  assertThrows(() => scanModelDeclarations(src));
});

// ============================================================================
// scanModelDeclarations — declaration boundary and property scanning
// ============================================================================

const fx12Src = lines(
  "export const model: Record<string, unknown> = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx12", fx12Src);

Deno.test("scanModelDeclarations: a type annotation between the identifier and '=' is skipped, not required to be '= {' immediately (mutation: require '= {' immediately after the identifier -> this fixture stops being discovered; 9 of the 68 exported object consts in the real repo are written 'export const NAME: Record<...> = {')", () => {
  const src = fx12Src;
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].name, "model");
  assertEquals(decls[0].hasType, true);
  assertEquals(decls[0].version, "2026.01.01.1");
});

const fx13Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.03.01.1",',
  "  description: `Example:",
  "function foo() {",
  "  return 1;",
  "};",
  "`,",
  "  upgrades: [",
  '    { fromVersion: "2026.01.01.1", toVersion: "2026.03.01.1" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx13", fx13Src);

Deno.test("scanModelDeclarations: the object is closed by BALANCED DELIMITER MATCHING, not a '^\\};$' line test — a column-0 '};' embedded inside a template literal's raw text must not end the declaration early (mutation: close a declaration on a '^\\};$' line test instead of balanced matching -> this fixture stops reporting a chain at all, because the object appears to end before 'upgrades' is ever reached)", () => {
  const src = fx13Src;
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].chain.kind, "literal");
  assertEquals(decls[0].chain.terminus, "2026.03.01.1");
});

const fx14Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "RIGHT",',
  '  "upgrades": [',
  '    { fromVersion: "OLD", toVersion: "WRONG" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx14", fx14Src);

Deno.test("scanModelDeclarations: reads keys out of the RAW source at the mask offset, not the mask itself — a quoted 'upgrades' key must still be found (mutation: read depth-1 keys out of the MASK only -> this fixture stops reporting its terminus, because the mask blanks BOTH the quote characters and the key text)", () => {
  const src = fx14Src;
  const decls = scanModelDeclarations(src);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].version, "RIGHT");
  assertEquals(decls[0].chain.kind, "literal");
  assertEquals(
    decls[0].chain.terminus,
    "WRONG",
    "expected the quoted 'upgrades' key to be read and its literal chain resolved",
  );
});

const fx15Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.08.07.1",',
  "  upgrades: [",
  '    { fromVersion: "2026.07.17.1", toVersion: "2026.08.02.1" },',
  '    { fromVersion: "2026.08.02.1", toVersion: "2026.08.04.1" },',
  '    { fromVersion: "2026.08.04.1", toVersion: "2026.08.05.1" },',
  '    { fromVersion: "2026.08.05.1", toVersion: "2026.08.05.2" },',
  '    { fromVersion: "2026.08.05.2", toVersion: "2026.08.07.1" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx15", fx15Src);

Deno.test("scanModelDeclarations: the terminus is the LAST element's toVersion, not the first (mutation: read the FIRST toVersion instead of the last element's -> this five-entry fixture, modelled on music-library/extensions/models/music_library.ts:2333-2369, reddens)", () => {
  const src = fx15Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.entries.length, 5);
  assertEquals(decl.chain.terminus, "2026.08.07.1");
});

const fx16Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.2",',
  "  upgrades: [",
  '    { fromVersion: "2026.01.01.1", toVersion: "2026.01.01.2" },',
  "  ],",
  "};",
);
fmtCleanFixtures.set("fx16", fx16Src);

Deno.test("scanModelDeclarations: a trailing comma before the closing ']' produces NO extra element (mutation: keep the whitespace-only tail when splitting array elements -> every trailing-comma chain — all 31 in the real tree — would report upgrade-chain-unparseable instead of a correct 1-entry literal)", () => {
  const src = fx16Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "literal");
  assertEquals(decl.chain.entries.length, 1);
  assertEquals(decl.chain.terminus, "2026.01.01.2");
});

// --- chain classification: indirect (non-array value) -----------------

const fx17Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: CHAIN,",
  "};",
);
fmtCleanFixtures.set("fx17", fx17Src);

Deno.test("scanModelDeclarations: 'upgrades: CHAIN' (a hoisted identifier) is indirect, not absent (mutation: treat a non-array upgrades value as 'absent' instead of 'indirect' -> this fixture reddens)", () => {
  const src = fx17Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "indirect");
});

const fx18Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: buildUpgrades(),",
  "};",
);
fmtCleanFixtures.set("fx18", fx18Src);

Deno.test("scanModelDeclarations: 'upgrades: buildUpgrades()' (a call expression) is indirect, not absent (mutation: treat a non-array upgrades value as 'absent' instead of 'indirect' -> this fixture reddens)", () => {
  const src = fx18Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "indirect");
});

const fx19Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [...CHAIN],",
  "};",
);
fmtCleanFixtures.set("fx19", fx19Src);

Deno.test("scanModelDeclarations: 'upgrades: [...CHAIN]' (a spread ARRAY ELEMENT) is indirect (mutation: treat a spread ARRAY ELEMENT as an ordinary element instead of checking for the '...' prefix -> this fixture reddens; the value here IS an array literal, so the sibling tests' 'non-array -> absent' mutation does not apply — the discriminating mutation is specifically dropping the element-level '...' check. This is the array-VALUE spread, distinct from the depth-1 object spread tested below)", () => {
  const src = fx19Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "indirect");
});

// --- depth-1 object spread on the DECLARATION itself, per the amendment ---

const fx20Src = lines(
  "export const model = {",
  "  ...CHAIN_BASE,",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "};",
);
fmtCleanFixtures.set("fx20", fx20Src);

Deno.test("scanModelDeclarations: a depth-1 '...IDENT' spread on the model object itself sets hasDepth1Spread (mutation: treat a depth-1 '...IDENT' as an ordinary property -> this fixture stops reporting)", () => {
  const src = fx20Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.hasDepth1Spread, true);
});

const fx21Src = lines(
  "export const model = {",
  "  ...(LEGACY ? LEGACY_BASE : CHAIN_BASE),",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "};",
);
fmtCleanFixtures.set("fx21", fx21Src);

Deno.test("scanModelDeclarations: hasDepth1Spread fires on ANY depth-1 spread element, not '...IDENT' only — a parenthesised conditional expression after the dots must ALSO be caught (AMENDMENT fixture 2/2, mutation: narrow the spread match back to '...IDENT' -> this fixture reddens, which is exactly the false-pass the amendment exists to close: 'export const model = { ...(LEGACY ? LEGACY_BASE : CHAIN_BASE) }' is deno-fmt-stable, type-clean, and swamp-push-clean)", () => {
  const src = fx21Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.hasDepth1Spread, true);
});

// --- empty chain, legal --------------------------------------------------

const fx22Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "  upgrades: [],",
  "};",
);
fmtCleanFixtures.set("fx22", fx22Src);

Deno.test("scanModelDeclarations: 'upgrades: []' is the empty chain kind, not indirect or unparseable", () => {
  const src = fx22Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "empty");
});

const fx23Src = lines(
  "export const model = {",
  '  type: "@fixture/x",',
  '  version: "2026.01.01.1",',
  "};",
);
fmtCleanFixtures.set("fx23", fx23Src);

Deno.test("scanModelDeclarations: a declaration with no 'upgrades' key at all has chain kind 'none', distinct from 'empty'", () => {
  const src = fx23Src;
  const [decl] = scanModelDeclarations(src);
  assertEquals(decl.chain.kind, "none");
});

// ============================================================================
// testStrategy C: every registered fixture above is deno-fmt-clean, so no
// future anchor change in maskCode/scanModelDeclarations can be justified by
// an fmt claim nobody actually ran. Scoped to the 20 fixtures registered in
// fmtCleanFixtures above (fx01-fx08, fx12-fx23); fx09/fx10/fx11 (the
// deliberately UNTERMINATED string/template fixtures at the "maskCode:
// unterminated" tests) are excluded by construction — they exist to feed
// the LEXER ERROR PATH and are not valid, fmt-checkable TypeScript.
//
// BATCHED INTO ONE SUBPROCESS, not one `deno fmt --check` spawn per fixture.
// Measured on this machine: 20 separate spawns cost ~14s of a ~1m47s suite;
// one spawn covering all 20 files costs ~0.77s. `deno fmt --check` accepts
// multiple file arguments and reports each non-conforming one by path, so
// batching loses no diagnostic precision.
// ============================================================================

/** Matches this file's own fixture-definition idiom: a module-level
 * `const fxNNSrc = lines(` statement. Used to derive the EXPECTED registered
 * count from the file's own source rather than a hand-maintained literal —
 * see the completeness check below. */
const FIXTURE_CONST_PATTERN = /^const fx\d+Src = lines\(/gm;

Deno.test("every registered fixture is actually deno-fmt-clean under scripts/deno.json, checked in ONE batched subprocess (this is a REGISTRATION check, not a mutation-killing test: it exists so a future fixture edit that drifts from deno fmt's own formatting cannot be waved through on an unverified fmt claim, per testStrategy C)", async () => {
  const selfSource = await Deno.readTextFile(fromFileUrl(import.meta.url));
  const definedCount = (selfSource.match(FIXTURE_CONST_PATTERN) ?? []).length;
  // COMPLETENESS, not a magic number: derived from this file's own fxNNSrc
  // const declarations rather than a hand-maintained literal, so a future
  // `const fx24Src = lines(...)` added WITHOUT a matching
  // `fmtCleanFixtures.set("fx24", fx24Src)` call is caught here — the two
  // counts disagree — rather than silently shipping an unfmt-checked
  // fixture (mutation: add a module-level fxNNSrc const and forget to
  // register it -> this assertion reddens instead of passing vacuously).
  assertEquals(
    fmtCleanFixtures.size,
    definedCount,
    `fmtCleanFixtures has ${fmtCleanFixtures.size} entries but this file ` +
      `defines ${definedCount} module-level fxNNSrc consts — a fixture was ` +
      "added without registering it (or vice versa)",
  );
  assertEquals(
    fmtCleanFixtures.size,
    20,
    "expected exactly 20 registered fixtures (23 total minus fx09/fx10/fx11) — " +
      "a count drift here means a fixture was added or removed without " +
      "updating this test's own bookkeeping",
  );
  const denoJsonSrc = await Deno.readTextFile(
    join(dirname(fromFileUrl(import.meta.url)), "..", "deno.json"),
  );
  const dir = await Deno.makeTempDir({ prefix: "model-decl-fmt-" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), denoJsonSrc);
    const names: string[] = [];
    const files: string[] = [];
    for (const [name, src] of fmtCleanFixtures) {
      const file = join(dir, `${name}.ts`);
      await Deno.writeTextFile(file, src);
      names.push(name);
      files.push(file);
    }
    // ONE spawn covering every fixture, not one spawn per fixture.
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--check", "--config", join(dir, "deno.json"), ...files],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    assert(
      out.success,
      `one or more of [${names.join(", ")}] is not deno-fmt-clean: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
