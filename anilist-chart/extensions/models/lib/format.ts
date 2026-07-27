// Formatters ported verbatim from generate_board.py (the register/«журнал»
// voice). Intl is BANNED here: every grouping and rounding decision is plain
// JS so the output is deterministic and identical wherever it runs.
//
// Two typographic invariants carried from the oracle:
//   - the decimal separator is a comma (generate_board.py:86)
//   - the minus is the typographic U+2212, never the ASCII hyphen U+002D
//     (generate_board.py:85-86)
// Both special characters are written as \u escapes, never literal invisible
// or look-alike bytes in source.

// Group separator for thousands. Spec (plan v11 step 7) calls for U+00A0 (a
// no-break space) so grouped figures never wrap mid-number. NOTE: the oracle's
// generate_board.py:80 emits a plain U+0020 space (verified by repr); U+00A0
// here is the one deliberate deviation from the oracle byte, taken per the
// written spec ("group sep is U+00A0/space never comma"). Set this to " "
// if strict oracle byte-parity on grouped numbers is ever required.
export const GROUP_SEP = "\u00A0";

const MINUS = "\u2212"; // typographic minus sign (U+2212)

/** Russian plural selector (generate_board.py:69). */
export function ruPlural(
  n: number,
  one: string,
  few: string,
  many: string,
): string {
  const a = Math.abs(Math.trunc(n)); // Python: abs(int(n))
  const mod100 = a % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = a % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Group a non-negative integer's digit string in threes from the right. */
function groupDigits(digits: string): string {
  let out = "";
  const len = digits.length;
  for (let i = 0; i < len; i++) {
    if (i > 0 && (len - i) % 3 === 0) out += GROUP_SEP;
    out += digits[i];
  }
  return out;
}

/**
 * The board's integer form (generate_board.py:80): `int(round(n))` then group.
 * This is the ROUNDING form — NOT the landing's truncating `int(n)`
 * (generate_landing.py:44), which is off-by-one on ~half of runs at the
 * award-07/14 headlines.
 *
 * NOTE: Python `round()` is banker's rounding (half-to-even); JS `Math.round`
 * is half-up. They differ only at exact .5 boundaries, which do not arise for
 * the counts and averages fed here. The spec pins Math.round; fmtInt(29.67)
 * must be "30".
 */
export function fmtInt(n: number): string {
  const r = Math.round(n);
  const neg = r < 0;
  const digits = Math.abs(r).toString();
  return (neg ? "-" : "") + groupDigits(digits);
}

/** Fixed-decimal form: comma separator, typographic minus (generate_board.py:84). */
export function fmtDec(x: number, nd = 1): string {
  return x.toFixed(nd).replace(".", ",").replace("-", MINUS);
}

/** Signed form: explicit + / U+2212 over an unsigned magnitude (generate_board.py:89). */
export function fmtSigned(x: number, nd = 1): string {
  const s = fmtDec(Math.abs(x), nd);
  return (x >= 0 ? "+" : MINUS) + s;
}

/** A score as written into the журнал: 10 -> "10", 7.5 -> "7,5" (generate_board.py:94). */
export function fmtScore(x: number): string {
  return Number.isInteger(x) ? fmtInt(x) : fmtDec(x, 1);
}

/** Python html.escape(str(s), quote=True). Ampersand first, then <, >, ", '. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Spelled Russian numerals 15..22 (generate_board.py:102). */
export const RU_WORDS: Record<number, string> = {
  15: "пятнадцать",
  16: "шестнадцать",
  17: "семнадцать",
  18: "восемнадцать",
  19: "девятнадцать",
  20: "двадцать",
  21: "двадцать один",
  22: "двадцать два",
};

/** RU_WORDS.get(n, str(n)) — spelled where known, digits otherwise. */
export function ruWord(n: number): string {
  return RU_WORDS[n] ?? String(n);
}
