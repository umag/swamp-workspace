// Artist-name matching against MusicBrainz search results, shared by the
// `wanted` method (which resolves an artist name to an MBID before querying
// releases) and any report that needs the same disambiguation. Pure — no
// I/O, no zod, no MusicBrainz client.
//
// Two ideas carry the whole thing:
//
//   1. MusicBrainz names are not comparable as strings. Person entities come
//      back with `sortName` in "Surname, Given" order ("Davis, Miles") while
//      `name` holds the natural order ("Miles Davis") — sometimes it is the
//      other way round depending on the entity. Exact-string comparison
//      against either field alone rejects real matches, so both fields are
//      normalised into an order-independent TOKEN SET and either may
//      produce the match.
//   2. A token overlap is not a match. "Bill Brown" and "James Brown" share
//      the token "brown"; "Two Worlds II" and "Oscar Hammerstein II" share
//      the token "ii". Neither pair names the same artist, so matching
//      requires the full normalised token SET to be equal, not merely
//      intersecting — and when two or more DISTINCT MBIDs legitimately
//      produce that same set, the result is reported as ambiguous rather
//      than silently picking one.

/** A MusicBrainz artist search result, trimmed to what matching needs. */
export interface Candidate {
  /** MusicBrainz ID. */
  id: string;
  name: string;
  sortName?: string;
}

export type MatchResult =
  | { kind: "resolved"; mbid: string }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "unresolved" };

/**
 * Lucene/MusicBrainz query metacharacters. `&` and `|` are included as
 * single characters (not only as the `&&`/`||` operators) so that escaping
 * every occurrence also covers the multi-character operators.
 */
const LUCENE_METACHARS = new Set([
  "+",
  "-",
  "&",
  "|",
  "!",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "^",
  '"',
  "~",
  "*",
  "?",
  ":",
  "\\",
  "/",
]);

/** Stopwords dropped when normalising a name into a token set. */
const STOPWORDS = new Set(["the", "and", "a", "of"]);

/**
 * Escape Lucene/MusicBrainz query metacharacters so an artist name can be
 * safely interpolated into a search query string.
 *
 * Metacharacters: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
 *
 * A single left-to-right pass over the input, escaping each metacharacter
 * (including the backslash itself) as it is encountered. Because each
 * source character is visited exactly once, a backslash inserted to escape
 * one character is never re-visited and re-escaped — the classic
 * double-escaping bug that a sequence of independent string replacements
 * would risk.
 */
export function escapeLuceneQuery(s: string): string {
  let out = "";
  for (const ch of s) {
    if (LUCENE_METACHARS.has(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Normalise a name into an order-independent token set: lowercase, strip
 * punctuation, split into tokens, drop stopwords.
 */
function normalizeTokens(name: string): Set<string> {
  const tokens = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Order-independent equality of two token sets. */
function sameTokens(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) {
    if (!b.has(t)) return false;
  }
  return true;
}

/**
 * Order-independent token-SET match of `query` against every candidate's
 * `name` AND `sortName` (either may produce the match). Evaluated against
 * ALL candidates, never just the top-scoring one:
 *
 *   - exactly one distinct matching MBID  -> resolved
 *   - two or more distinct matching MBIDs -> ambiguous (never auto-picked)
 *   - none                                -> unresolved
 */
export function matchArtist(
  query: string,
  candidates: Candidate[],
): MatchResult {
  const queryTokens = normalizeTokens(query);
  const matchesById = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const nameMatches = sameTokens(
      normalizeTokens(candidate.name),
      queryTokens,
    );
    const sortMatches = candidate.sortName !== undefined &&
      sameTokens(normalizeTokens(candidate.sortName), queryTokens);
    if (nameMatches || sortMatches) {
      matchesById.set(candidate.id, candidate);
    }
  }

  const matched = [...matchesById.values()];
  if (matched.length === 0) return { kind: "unresolved" };
  if (matched.length === 1) {
    return { kind: "resolved", mbid: matched[0].id };
  }
  return { kind: "ambiguous", candidates: matched };
}
