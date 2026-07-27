// Shared primitives for the «Доска почёта» board compute (generate_board.py).
// awards.ts and pairs.ts build on these; the board's ~19 min/max sites all go
// through one `pickOrSkip`, and every number that reaches a formatter is
// finite-checked at the DATA layer via `assertFinite`.

/** One flat joined score+metadata row (generate_board.py load_rows / cols). */
export interface Row {
  user: string;
  media_id: number;
  score: number; // the user's score; 0 means "in list, unrated"
  romaji: string | null;
  english: string | null;
  genres: string[] | null;
  year: number | null; // start_year
  format: string | null;
  episodes: number | null;
  duration: number | null;
  world: number | null; // average_score (0-100)
  popularity: number | null;
  cover: string | null;
}

/** Per-user aggregates (generate_board.py:155-163). */
export interface PerUser {
  list: number; // UNFILTERED row count — do NOT filter to score>0
  rated: Row[]; // score > 0
  nrated: number;
  avg: number;
  tens: number;
  distinct: number;
}

export interface GroupedRows {
  users: string[]; // sorted
  byUser: Map<string, Row[]>;
  owners: Map<number, Set<string>>;
  per: Map<string, PerUser>;
}

/** title_of (generate_board.py:141): romaji, else english, else "#<id>". */
export function titleOf(r: Row): string {
  return r.romaji || r.english || `#${r.media_id}`;
}

/**
 * Group rows by user and media, compute per-user aggregates.
 *
 * `list` is the UNFILTERED count of the user's rows; only `rated` is derived
 * with `score > 0`. If `list` were also filtered to score>0, then nrated/list
 * would pin «Совесть чата» at 1.0 and break the MIN_LIST-gated awards
 * (generate_board.py:157-160, 244).
 */
export function groupRows(rows: Row[]): GroupedRows {
  const byUser = new Map<string, Row[]>();
  const owners = new Map<number, Set<string>>();
  for (const r of rows) {
    let bu = byUser.get(r.user);
    if (!bu) byUser.set(r.user, bu = []);
    bu.push(r);
    let ow = owners.get(r.media_id);
    if (!ow) owners.set(r.media_id, ow = new Set());
    ow.add(r.user);
  }
  const users = [...byUser.keys()].sort();
  const per = new Map<string, PerUser>();
  for (const [u, rs] of byUser) {
    const rated = rs.filter((r) => r.score > 0);
    const avg = rated.length
      ? rated.reduce((a, r) => a + r.score, 0) / rated.length
      : 0;
    const tens = rated.filter((r) => r.score === 10).length;
    const distinct = new Set(rated.map((r) => r.score)).size;
    per.set(u, {
      list: rs.length,
      rated,
      nrated: rated.length,
      avg,
      tens,
      distinct,
    });
  }
  return { users, byUser, owners, per };
}

// ── warnings: two SEPARATE channels ──────────────────────────────────────────
// `skips` collects pickOrSkip's "no eligible candidate" events (a new safety
// net, not in the oracle). `curated` collects the oracle's "holder changed,
// curated note dropped" events (generate_board.py:172). They are kept apart so
// a dropped joke is never confused with a skipped award.
export interface Warn {
  skips: string[];
  curated: string[];
}

export function newWarn(): Warn {
  return { skips: [], curated: [] };
}

/**
 * The single min/max site for the board. Returns the picked item, or null (and
 * records a skip) when there is no eligible candidate or the winning key is not
 * finite. On ties it returns the FIRST candidate, matching Python's max()/min()
 * — so callers must pass candidates in the oracle's iteration order.
 */
export function pickOrSkip<T>(
  candidates: T[],
  keyFn: (t: T) => number,
  mode: "min" | "max",
  label: string,
  warn: Warn,
): T | null {
  if (candidates.length === 0) {
    warn.skips.push(`${label}: no eligible candidate, award skipped`);
    return null;
  }
  let best = candidates[0];
  let bestKey = keyFn(best);
  for (let i = 1; i < candidates.length; i++) {
    const k = keyFn(candidates[i]);
    if (mode === "max" ? k > bestKey : k < bestKey) {
      best = candidates[i];
      bestKey = k;
    }
  }
  if (!Number.isFinite(bestKey)) {
    warn.skips.push(
      `${label}: winning key not finite (${bestKey}), award skipped`,
    );
    return null;
  }
  return best;
}

/**
 * Data-layer finite guard. Every value about to enter a number formatter is
 * checked here, tagged with its field name and media_id, so a NaN/Infinity is
 * caught at the source rather than surfacing as a broken cell in the page.
 */
export function assertFinite(
  value: number,
  field: string,
  mediaId: number | string,
): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `non-finite ${field} for media_id=${mediaId}: ${value}`,
    );
  }
  return value;
}

// ── CURATED (generate_board.py:57-64) ────────────────────────────────────────
// Four hand-written notes. Three are keyed by (award, string-holder); the
// fourth (pair-top) is keyed by an unordered pair and lives in CURATED_PAIRS.
export const CURATED_AWARDS: Record<string, string> = {
  "flop|stakanVpechen":
    "«Skelter Heaven» и «Hametsu no Mars» — два знаменитейших провала в истории, " +
    "и у обоих высший балл. И «Boku no Pico», куда же без него",
  "sport|LetoDeWirre": "держит четверть велоспорта чата",
  "conscience|lizken": "оценил {rated} из {total}",
};

export interface CuratedPair {
  members: string[];
  title: string;
  caption: string;
}

export const CURATED_PAIRS: CuratedPair[] = [
  {
    members: ["akemiv", "nanavi42"],
    title: "Муж и жена",
    caption: "кажется, один диван",
  },
];

// The set of award keys that HAVE a curated string note (used to decide whether
// a missing exact match means "holder changed"). The pair-top key is excluded
// because its holder is an unordered pair, not a string (generate_board.py:171
// `if isinstance(_, str)`).
const CURATED_AWARD_KEYS = new Set(
  Object.keys(CURATED_AWARDS).map((k) => k.split("|")[0]),
);

function applyTemplate(tpl: string, fmt: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => (k in fmt ? fmt[k] : `{${k}}`));
}

/**
 * curated() from generate_board.py:167. If an exact (award, holder) note
 * exists, return it (with template fields filled). Otherwise, if THIS award has
 * a curated note for some OTHER holder, record a "holder changed" warning in
 * the SEPARATE curated channel and fall back to the computed text.
 */
export function curatedNote(
  key: string,
  holder: string,
  computedText: string,
  warn: Warn,
  fmt?: Record<string, string>,
): string {
  const cur = CURATED_AWARDS[`${key}|${holder}`];
  if (cur !== undefined) {
    return fmt ? applyTemplate(cur, fmt) : cur;
  }
  if (CURATED_AWARD_KEYS.has(key)) {
    warn.curated.push(`${key}: holder changed, curated note dropped`);
  }
  return computedText;
}

/**
 * Order-independent lookup for the tipped-in pair note (generate_board.py:381
 * uses `frozenset((a, b))`). Returns { title, caption } or null.
 */
export function pairCurated(
  a: string,
  b: string,
): { title: string; caption: string } | null {
  const key = [a, b].slice().sort().join("|");
  for (const c of CURATED_PAIRS) {
    if (c.members.slice().sort().join("|") === key) {
      return { title: c.title, caption: c.caption };
    }
  }
  return null;
}
