/**
 * Coverage suite for @magistr/tmdb: guards a reviewer would expect to have
 * a test — cache freshness, verdict margins, retry bounds, auth detection.
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  classifyHits,
  isV3Key,
  needsRefresh,
  queryFingerprint,
  retryAfterMs,
  type SearchHit,
  titleIsStale,
} from "./tmdb.ts";

const hit = (id: number, title: string, year: number | null): SearchHit => ({
  id,
  kind: "movie",
  title,
  originalTitle: null,
  year,
  originalLanguage: null,
  popularity: 0,
  voteCount: 0,
  overview: null,
});

Deno.test("needsRefresh: fingerprint change, error, pending and TTL all force", () => {
  const now = Date.parse("2026-10-08T00:00:00Z");
  const fresh = {
    fingerprint: "f",
    status: "matched",
    checkedAt: "2026-10-07T00:00:00Z",
  };
  assertEquals(needsRefresh(fresh, "f", now, 7 * 864e5), false);
  assertEquals(needsRefresh(fresh, "g", now, 7 * 864e5), true);
  assertEquals(
    needsRefresh({ ...fresh, status: "error" }, "f", now, 7 * 864e5),
    true,
  );
  assertEquals(
    needsRefresh({ ...fresh, checkedAt: "garbage" }, "f", now, 7 * 864e5),
    true,
  );
  assertEquals(needsRefresh(fresh, "f", now, 0), true);
  assertEquals(needsRefresh(null, "f", now, 1), true);
});

Deno.test("classifyHits: a remake one year apart within margin is ambiguous", () => {
  const q = { title: "Dune", altTitles: [], year: null };
  const r = classifyHits(q, [hit(1, "Dune", 1984), hit(2, "Dune", 2021)], 0.72);
  assertEquals(r.verdict, "ambiguous");
  const y = classifyHits({ ...q, year: 2021 }, [
    hit(1, "Dune", 1984),
    hit(2, "Dune", 2021),
  ], 0.72);
  assertEquals([y.verdict, y.ranked[0].id], ["matched", 2]);
  assertEquals(classifyHits(q, [], 0.72).verdict, "unmatched");
});

Deno.test("retryAfterMs is bounded and defaults sanely", () => {
  assertEquals(retryAfterMs("2", 0), 2000);
  assertEquals(retryAfterMs("99999", 0), 30000);
  assertEquals(retryAfterMs(null, 1), 2000);
  assertEquals(retryAfterMs("-5", 0), 1000);
});

Deno.test("isV3Key distinguishes 32-hex keys from v4 tokens", () => {
  assertEquals(isV3Key("0123456789abcdef0123456789ABCDEF"), true);
  assertEquals(isV3Key("eyJhbGci.payload.sig"), false);
});

Deno.test("queryFingerprint ignores altTitle order and title case", () => {
  assertEquals(
    queryFingerprint({
      title: "The Matrix",
      altTitles: ["Матрица", "Matrix"],
      year: 1999,
    }),
    queryFingerprint({
      title: "the matrix",
      altTitles: ["Matrix", "Матрица"],
      year: 1999,
    }),
  );
});

Deno.test("titleIsStale treats missing/unparseable fetchedAt as stale", () => {
  assertEquals(titleIsStale(undefined, 0, 1), true);
  assertEquals(titleIsStale({ fetchedAt: "x" }, 0, 1), true);
  assertEquals(
    titleIsStale({ fetchedAt: new Date(0).toISOString() }, 10, 100),
    false,
  );
});
