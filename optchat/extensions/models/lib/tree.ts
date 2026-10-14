// =============================================================================
// Pure core of the OptChat memory: tree node naming, line rendering, and the
// view's merge order (Taelin's rollback push, generalised by the `due` rule).
// No I/O here — the store and the compactor build on these functions.
// =============================================================================

/** A logged message: permanent id `i`, its kind, the text, its UTF-8 size. */
export interface Message {
  i: number;
  kind: string;
  text: string;
  size: number;
  date: string;
}

/** A tree node: `node(l, i)` covers the 2^l messages from `i·2^l` on. */
export interface TreeNode {
  l: number;
  i: number;
  text: string;
  size: number;
}

/** A view line, as the `[l, i]` of the tree node it shows. */
export type Line = [number, number];

/** Most bytes a tree node's text may hold. */
export const NODE_LIMIT = 512;

/** Shown for a line whose node is not built yet. */
export const PLACEHOLDER = "(not summarized yet: zoom it)";

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function bytes(s: string): number {
  return encoder.encode(s).length;
}

/** Number of messages a node at level `l` covers. */
export function span(l: number): number {
  return 2 ** l;
}

/** Id of the first message a line covers. */
export function firstOf([l, i]: Line): number {
  return i * span(l);
}

/** Id of the last message a line covers. */
export function lastOf([l, i]: Line): number {
  return (i + 1) * span(l) - 1;
}

/** The `id+n` name of a line. */
export function labelOf(line: Line): string {
  return `${firstOf(line)}+${span(line[0])}`;
}

/** Map key of a node. */
export function keyOf(l: number, i: number): string {
  return `${l}:${i}`;
}

/** Parse a zoom target `id+n` into a line, or throw if it names no node. */
export function lineOf(id: number, n: number): Line {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`id must be a non-negative integer, got ${id}`);
  }
  if (!Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error(`n must be a power of 2, got ${n}`);
  }
  if (id % n !== 0) throw new Error(`id ${id} is not a multiple of n ${n}`);
  return [Math.log2(n), id / n];
}

/** The node text a message becomes before any compression. */
export function leafSource(m: Pick<Message, "kind" | "text">): string {
  return `${m.kind}: ${m.text}`;
}

/**
 * Defuse the prompt's own frame tags (<chat>, <input>) inside logged text, so
 * a message can't close the block it sits in. The log keeps the original.
 */
export function defuse(text: string): string {
  return text.replace(/<(\/?)(chat|input)>/gi, "‹$1$2›");
}

/** One view line: `id+n|text`, with newlines turned into spaces. */
export function renderLine(line: Line, text: string | undefined): string {
  return `${labelOf(line)}|${
    defuse(text ?? PLACEHOLDER).replace(/\r?\n/g, " ")
  }`;
}

/** Size a line takes in the view, its newline included. */
export function lineCost(line: Line, text: string | undefined): number {
  return bytes(renderLine(line, text)) + 1;
}

/**
 * How due the sibling pair starting at `line` is for a merge, in a chat of
 * `T` messages: how long ago the pair ended, in its own line size. Written as
 * `(T + 1)/2^l - i`, the gist's form of `(T - last)/2^l` shifted by 2.
 */
export function dueOf([l, i]: Line, T: number): number {
  return (T + 1) / span(l) - i;
}

/**
 * Index `k` of the most due mergeable pair `lines[k], lines[k+1]` (siblings
 * whose parent is built), oldest first on ties, or -1 when none can merge.
 */
export function mostDuePair(
  lines: Line[],
  T: number,
  isBuilt: (l: number, i: number) => boolean,
): number {
  let best = -1;
  let bestDue = -Infinity;
  for (let k = 0; k + 1 < lines.length; k++) {
    const [l, i] = lines[k];
    const [l2, i2] = lines[k + 1];
    if (l !== l2 || i % 2 !== 0 || i2 !== i + 1) continue;
    if (!isBuilt(l + 1, i / 2)) continue;
    const due = dueOf(lines[k], T);
    if (due > bestDue) {
      best = k;
      bestDue = due;
    }
  }
  return best;
}

/**
 * Merge the most due pairs until the summed `cost` of the lines is at most
 * `target`, or no pair can merge. Returns the new lines and the merge count;
 * the input array is left as it was.
 */
export function mergeDown(
  input: Line[],
  T: number,
  target: number,
  cost: (line: Line) => number,
  isBuilt: (l: number, i: number) => boolean,
): { lines: Line[]; merges: number; total: number } {
  const lines = input.map((x) => [x[0], x[1]] as Line);
  let total = 0;
  for (const line of lines) total += cost(line);
  let merges = 0;
  while (total > target) {
    const k = mostDuePair(lines, T, isBuilt);
    if (k < 0) break;
    const [l, i] = lines[k];
    const parent: Line = [l + 1, i / 2];
    total += cost(parent) - cost(lines[k]) - cost(lines[k + 1]);
    lines.splice(k, 2, parent);
    merges++;
  }
  return { lines, merges, total };
}

/** True when `lines` cover messages 0..T-1 in order, with no gap or overlap. */
export function coversChat(lines: Line[], T: number): boolean {
  let next = 0;
  for (const line of lines) {
    if (firstOf(line) !== next) return false;
    next = lastOf(line) + 1;
  }
  return next === T;
}
