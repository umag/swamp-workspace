// The two tipped-in «Пары» — the highest and lowest score correlations across
// users sharing at least PAIR_MIN_COMMON titles (generate_board.py:349-400).

import { fmtDec, fmtScore } from "./format.ts";
import {
  assertFinite,
  type GroupedRows,
  pairCurated,
  pickOrSkip,
  type Row,
  titleOf,
  type Warn,
} from "./rankable.ts";

const PAIR_MIN_COMMON = 50; // a correlation over fewer shared titles is noise

export interface Pair {
  t: string; // title (звание)
  w: string; // "a · b"
  n: string; // correlation, fmtDec(r, 2)
  p: string; // paragraph
  cap: string; // caption over the two covers
  covers: string[]; // cover image URLs (0-2)
  alt: string[]; // alt text per cover
}

interface Scored {
  a: string;
  b: string;
  r: number;
  common: number[];
}

export function computePairs(
  grouped: GroupedRows,
  rows: Row[],
  warn: Warn,
): (Pair | null)[] {
  const { users, per } = grouped;

  // scored[u]: media_id -> score, over the user's rated titles.
  const scored = new Map<string, Map<number, number>>();
  for (const u of users) {
    const m = new Map<number, number>();
    for (const r of per.get(u)!.rated) m.set(r.media_id, r.score);
    scored.set(u, m);
  }

  // first row seen per media_id (generate_board.py:367-369 setdefault).
  const metaById = new Map<number, Row>();
  for (const r of rows) {
    if (!metaById.has(r.media_id)) metaById.set(r.media_id, r);
  }

  const pairs: Scored[] = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const a = users[i];
      const b = users[j];
      const sa = scored.get(a)!;
      const sb = scored.get(b)!;
      const common = [...sa.keys()].filter((m) => sb.has(m));
      if (common.length < PAIR_MIN_COMMON) continue;
      const xs = common.map((m) => sa.get(m)!);
      const ys = common.map((m) => sb.get(m)!);
      const n = common.length;
      const mx = xs.reduce((s, x) => s + x, 0) / n;
      const my = ys.reduce((s, y) => s + y, 0) / n;
      const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
      if (!sxx || !syy) continue; // a flat rater has no correlation
      let num = 0;
      for (let k = 0; k < n; k++) num += (xs[k] - mx) * (ys[k] - my);
      const r = num / Math.sqrt(sxx * syy);
      pairs.push({ a, b, r, common });
    }
  }

  // Two covers for the tipped-in photo, ordered by `keyFn` ascending (keyFn is
  // pre-negated so the best/most-fought titles come first). Only covered titles.
  const showcase = (
    common: number[],
    keyFn: (m: number) => number,
  ): number[] => {
    const cands = common.filter((m) => metaById.get(m)!.cover);
    cands.sort((m1, m2) => keyFn(m1) - keyFn(m2));
    return cands.slice(0, 2);
  };

  const best = pickOrSkip(pairs, (p) => p.r, "max", "pair-best", warn);
  const worst = pickOrSkip(pairs, (p) => p.r, "min", "pair-worst", warn);

  // ── pair 1: best (highest correlation) ──────────────────────────────────────
  let pair1: Pair | null = null;
  if (best) {
    const { a, b, r, common } = best;
    const cur = pairCurated(a, b);
    const t1 = cur ? cur.title : "Совпали";
    const cap1 = cur ? cur.caption : "вкус — один на двоих";
    const covers1 = showcase(
      common,
      (m) => -(scored.get(a)!.get(m)! + scored.get(b)!.get(m)!),
    );
    pair1 = {
      t: t1,
      w: `${a} · ${b}`,
      n: fmtDec(assertFinite(r, "pair_r", `${a}/${b}`), 2),
      p: `Самое высокое совпадение оценок в чате, на ${common.length} общих тайтлах.`,
      cap: cap1,
      covers: covers1.map((m) => metaById.get(m)!.cover as string),
      alt: covers1.map((m) => `«${titleOf(metaById.get(m)!)}»`),
    };
  }

  // ── pair 2: worst (lowest correlation) ──────────────────────────────────────
  let pair2: Pair | null = null;
  if (worst) {
    const { a, b, r, common } = worst;
    const covers2 = showcase(
      common,
      (m) => -Math.abs(scored.get(a)!.get(m)! - scored.get(b)!.get(m)!),
    );
    // GUARD: covers2[0] is the "most fought" title. If no common title has a
    // cover, `fight` would be undefined (a crash in the oracle); skip the pair.
    if (covers2.length === 0) {
      warn.skips.push(
        "pair-worst: no cover for any common title, pair skipped",
      );
    } else {
      const fight = covers2[0];
      const s1 = scored.get(a)!.get(fight)!;
      const s2 = scored.get(b)!.get(fight)!;
      const rr = assertFinite(r, "pair_r", `${a}/${b}`);
      const agree = Math.abs(rr) < 0.1
        ? "и ноль согласия. Статистически — как подбросить монетку."
        : `и корреляция всего ${fmtDec(rr, 2)}.`;
      pair2 = {
        t: "Непримиримые",
        w: `${a} · ${b}`,
        n: fmtDec(rr, 2),
        p: `${common.length} общих тайтлов ${agree}`,
        cap: `«${titleOf(metaById.get(fight)!)}»: ${
          fmtScore(Math.min(s1, s2))
        } против ${fmtScore(Math.max(s1, s2))}`,
        covers: covers2.map((m) => metaById.get(m)!.cover as string),
        alt: covers2.map((m) => `«${titleOf(metaById.get(m)!)}»`),
      };
    }
  }

  return [pair1, pair2];
}
