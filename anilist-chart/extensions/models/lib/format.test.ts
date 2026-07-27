import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  esc,
  fmtDec,
  fmtInt,
  fmtScore,
  fmtSigned,
  GROUP_SEP,
  RU_WORDS,
  ruPlural,
  ruWord,
} from "./format.ts";

// ── fmtInt: the BOARD rounding form (generate_board.py:80) ───────────────────
// The whole point of porting board's fmt_int (round) and NOT landing's (trunc,
// generate_board.py vs generate_landing.py:44) is this case: 29.67 rounds to 30,
// truncation would give 29. This test fails against a truncating implementation.
Deno.test("fmtInt rounds (not truncates): 29.67 -> 30", () => {
  assertEquals(fmtInt(29.67), "30");
});

Deno.test("fmtInt rounds half up at .5-ish and down below", () => {
  assertEquals(fmtInt(29.4), "29");
  assertEquals(fmtInt(0.6), "1");
});

Deno.test("fmtInt groups thousands with GROUP_SEP, never a comma", () => {
  assertEquals(fmtInt(1234), "1" + GROUP_SEP + "234");
  assertEquals(fmtInt(1234567), "1" + GROUP_SEP + "234" + GROUP_SEP + "567");
  assertEquals(fmtInt(999), "999");
  assert(!fmtInt(1234).includes(","));
});

// ── ru_plural (generate_board.py:69) ─────────────────────────────────────────
Deno.test("ruPlural picks one/few/many by Russian rules", () => {
  const p = (n: number) => ruPlural(n, "день", "дня", "дней");
  assertEquals(p(1), "день");
  assertEquals(p(21), "день");
  assertEquals(p(2), "дня");
  assertEquals(p(4), "дня");
  assertEquals(p(22), "дня");
  assertEquals(p(5), "дней");
  assertEquals(p(11), "дней"); // 11-14 always many
  assertEquals(p(12), "дней");
  assertEquals(p(14), "дней");
  assertEquals(p(111), "дней"); // 111 % 100 == 11 -> many
});

Deno.test("ruPlural: 111 is many (11..14 rule on %100)", () => {
  // 111 % 100 == 11 -> many, NOT one
  assertEquals(ruPlural(111, "one", "few", "many"), "many");
  assertEquals(ruPlural(101, "one", "few", "many"), "one");
});

// ── fmtDec / fmtSigned: comma decimal, typographic minus U+2212 ──────────────
Deno.test("fmtDec uses comma and U+2212 minus", () => {
  assertEquals(fmtDec(9.0, 1), "9,0");
  assertEquals(fmtDec(7.25, 2), "7,25");
  assertEquals(fmtDec(-1.5, 1), "−1,5");
  // the minus is the typographic U+2212, not ASCII hyphen U+002D
  assertEquals(fmtDec(-1, 0).charCodeAt(0), 0x2212);
  assert(!fmtDec(-1, 0).includes("-"));
});

Deno.test("fmtSigned prefixes + or U+2212 over an unsigned magnitude", () => {
  assertEquals(fmtSigned(1.5, 1), "+1,5");
  assertEquals(fmtSigned(-2.3, 1), "−2,3");
  assertEquals(fmtSigned(0, 1), "+0,0");
});

// ── fmtScore (generate_board.py:94): 10 -> "10", 7.5 -> "7,5" ─────────────────
Deno.test("fmtScore: integers via fmtInt, fractions via fmtDec(.,1)", () => {
  assertEquals(fmtScore(10), "10");
  assertEquals(fmtScore(7.5), "7,5");
  assertEquals(fmtScore(8), "8");
});

// ── esc (Python html.escape quote=True) ──────────────────────────────────────
Deno.test("esc matches Python html.escape(quote=True)", () => {
  assertEquals(
    esc("<a>&\"'"),
    "&lt;a&gt;&amp;&quot;&#x27;",
  );
  // ampersand escaped first so it does not double-escape the entities
  assertEquals(esc("a & b"), "a &amp; b");
  assertEquals(esc(42), "42");
});

// ── RU_WORDS: spelled 15..22, digit fallback else ────────────────────────────
Deno.test("ruWord spells 15..22 and falls back to digits", () => {
  assertEquals(ruWord(15), "пятнадцать");
  assertEquals(ruWord(20), "двадцать");
  assertEquals(ruWord(22), "двадцать два");
  assertEquals(ruWord(23), "23");
  assertEquals(ruWord(3), "3");
  assertEquals(RU_WORDS[18], "восемнадцать");
});
