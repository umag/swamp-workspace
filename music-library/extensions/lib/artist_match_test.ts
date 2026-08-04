// Unit + property tests for the pure artist-matching logic in
// artist_match.ts.
// Run: deno test --allow-env=FC_NUM_RUNS --permit-no-files
//   extensions/lib/artist_match_test.ts

import fc from "npm:fast-check@4.8.0";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type Candidate,
  escapeLuceneQuery,
  matchArtist,
} from "./artist_match.ts";

// Property iteration count — overridable via FC_NUM_RUNS, mirroring
// music_library_property_test.ts's convention (e.g. the nightly soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

function cand(id: string, name: string, sortName?: string): Candidate {
  return sortName === undefined ? { id, name } : { id, name, sortName };
}

// ---------------------------------------------------------------------------
// 1. Sort-name flip is accepted
// ---------------------------------------------------------------------------

Deno.test("matchArtist: a sort-name flip (Davis, Miles) resolves the natural-order query (Miles Davis)", () => {
  const candidates = [
    // The display name deliberately does NOT token-match the query, so
    // this can only resolve through the sortName field.
    cand("mbid-miles-davis", "Miles Davis Quintet", "Davis, Miles"),
  ];
  const r = matchArtist("Miles Davis", candidates);
  assertEquals(r, { kind: "resolved", mbid: "mbid-miles-davis" });
});

// ---------------------------------------------------------------------------
// 2. Same-token collisions are rejected, not silently resolved
// ---------------------------------------------------------------------------

Deno.test("matchArtist: a shared token does not cross-match — Bill Brown resolves to Bill Brown, not James Brown", () => {
  const candidates = [
    cand("mbid-james-brown", "James Brown"),
    cand("mbid-bill-brown", "Bill Brown"),
  ];
  const r = matchArtist("Bill Brown", candidates);
  assertEquals(r, { kind: "resolved", mbid: "mbid-bill-brown" });
});

Deno.test("matchArtist: a shared token does not cross-match — Two Worlds II does not resolve to Oscar Hammerstein II", () => {
  const candidates = [
    cand("mbid-oscar-hammerstein-ii", "Oscar Hammerstein II"),
    cand("mbid-two-worlds-ii", "Two Worlds II"),
  ];
  const r = matchArtist("Two Worlds II", candidates);
  assertEquals(r, { kind: "resolved", mbid: "mbid-two-worlds-ii" });
});

Deno.test("matchArtist: two distinct MBIDs with the same normalised token set are ambiguous, never auto-picked", () => {
  const candidates = [
    cand("mbid-bill-brown-1", "Bill Brown"),
    cand("mbid-bill-brown-2", "Bill Brown"),
  ];
  const r = matchArtist("Bill Brown", candidates);
  assertEquals(r.kind, "ambiguous");
  if (r.kind === "ambiguous") {
    assertEquals(
      r.candidates.map((c) => c.id).sort(),
      ["mbid-bill-brown-1", "mbid-bill-brown-2"],
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Order independence
// ---------------------------------------------------------------------------

Deno.test("matchArtist: token order does not matter", () => {
  const candidates = [cand("mbid-iron-maiden", "Iron Maiden")];
  const r = matchArtist("Maiden Iron", candidates);
  assertEquals(r, { kind: "resolved", mbid: "mbid-iron-maiden" });
});

// ---------------------------------------------------------------------------
// 4. Stopwords are dropped
// ---------------------------------------------------------------------------

Deno.test("matchArtist: stopwords are dropped — 'The Beatles' matches 'Beatles'", () => {
  const candidates = [cand("mbid-beatles", "Beatles")];
  const r = matchArtist("The Beatles", candidates);
  assertEquals(r, { kind: "resolved", mbid: "mbid-beatles" });
});

// ---------------------------------------------------------------------------
// 5. Never auto-pick from multiple equal-scoring candidates
// ---------------------------------------------------------------------------

Deno.test("matchArtist: multiple equal-scoring candidates never auto-pick — ambiguous with all matches listed", () => {
  const candidates = [
    cand("mbid-therapy-1", "Therapy?"),
    cand("mbid-therapy-2", "Therapy?"),
    cand("mbid-unrelated", "Unrelated Artist"),
  ];
  const r = matchArtist("Therapy?", candidates);
  assertEquals(r.kind, "ambiguous");
  if (r.kind === "ambiguous") {
    assertEquals(r.candidates.length, 2);
  }
});

// ---------------------------------------------------------------------------
// 6. Unresolved
// ---------------------------------------------------------------------------

Deno.test("matchArtist: no matching candidate is unresolved", () => {
  const candidates = [
    cand("mbid-a", "Godspeed You! Black Emperor"),
    cand("mbid-b", "Sunn O)))"),
  ];
  const r = matchArtist("Nonexistent Artist XYZ", candidates);
  assertEquals(r, { kind: "unresolved" });
});

Deno.test("matchArtist: an empty candidate list is unresolved", () => {
  const r = matchArtist("Anything", []);
  assertEquals(r, { kind: "unresolved" });
});

// ---------------------------------------------------------------------------
// 7. Lucene escaping — unit cases
// ---------------------------------------------------------------------------

Deno.test("escapeLuceneQuery: escapes each real-artist-name metacharacter case", () => {
  assertEquals(escapeLuceneQuery("AC/DC"), "AC\\/DC");
  assertEquals(
    escapeLuceneQuery("Godspeed You! Black Emperor"),
    "Godspeed You\\! Black Emperor",
  );
  assertEquals(escapeLuceneQuery("[dunkelbunt]"), "\\[dunkelbunt\\]");
  assertEquals(escapeLuceneQuery("Therapy?"), "Therapy\\?");
  assertEquals(escapeLuceneQuery("Sunn O)))"), "Sunn O\\)\\)\\)");
  assertEquals(escapeLuceneQuery("+/-"), "\\+\\/\\-");
});

// ---------------------------------------------------------------------------
// 8. Property test — no unescaped metacharacter survives, for ANY input
// ---------------------------------------------------------------------------

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

/**
 * Walk `s` treating a backslash as consuming the character after it (an
 * escape pair), and report whether any metacharacter survives OUTSIDE such
 * a pair — i.e. unescaped.
 */
function hasUnescapedMetachar(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (LUCENE_METACHARS.has(s[i])) return true;
    i++;
  }
  return false;
}

Deno.test("property: escapeLuceneQuery leaves no unescaped metacharacter, for ANY input string", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      return !hasUnescapedMetachar(escapeLuceneQuery(s));
    }),
    FC_RUNS,
  );
});
