// The publish backstop: the last line of defence before a rendered page is
// written. It reproduces the oracle's EXACT-text-node check (generate_board.py
// :927 tests the literal substring `>None<`, generate_landing.py:304 `>None<` /
// `>nan<`) and generalises it to the six JavaScript stringifications a broken
// slot can collapse to, THEN adds a style/src attribute scan on top.
//
// Why a literal `>frag<` and not a word-boundary regex: a title that legitimately
// contains the word "Null" (or "NaN") must never false-positive. The check only
// fires when a WHOLE text node is exactly the bad fragment (a string slot
// that resolved to `undefined`/`null`/… and nothing else). That is precisely the
// failure the data-layer Number.isFinite guard (rankable.assertFinite) cannot
// catch, because a STRING slot never reaches a number formatter.
//
// The attribute scan is ADDITIVE: a bad value can hide inside an attribute
// (`style="--p:NaN%"`, `src="undefined"`) where it sits between quotes, not
// between `>` and `<`, so the text-node check would miss it. We restrict the
// attribute scan to `style` and `src` (numeric / URL contexts where none of
// these fragments can appear legitimately) to keep the same zero-false-positive
// property a free-text attribute (title, alt) could not offer.

/** The JS stringifications a broken slot collapses to. */
export const BAD_FRAGMENTS = [
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "-Infinity",
  "[object Object]",
] as const;

/**
 * Text nodes that are EXACTLY a bad fragment, i.e. the html contains `>frag<`.
 * Returns the offending fragments (each reported once).
 */
export function badTextNodes(html: string): string[] {
  const out: string[] = [];
  for (const frag of BAD_FRAGMENTS) {
    if (html.includes(`>${frag}<`)) out.push(frag);
  }
  return out;
}

/**
 * `style=` / `src=` attribute values containing a bad fragment. Reports the
 * whole offending `attr="value"` slice so the caller can log what leaked.
 */
export function badAttributes(html: string): string[] {
  const out: string[] = [];
  const re = /(style|src)="([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    const value = m[2];
    for (const frag of BAD_FRAGMENTS) {
      if (value.includes(frag)) {
        out.push(`${m[1]}="${value}"`);
        break;
      }
    }
  }
  return out;
}

/**
 * The full backstop: the union of the text-node check and the attribute scan.
 * An empty array means the page is safe to publish; a non-empty array is the
 * list of reasons it must be refused.
 */
export function findUnpublishable(html: string): string[] {
  return [...badTextNodes(html), ...badAttributes(html)];
}
