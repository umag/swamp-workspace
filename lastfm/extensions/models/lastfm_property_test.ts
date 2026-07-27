/**
 * Property-based tests (fast-check) for @magistr/lastfm.
 *
 * These cover the invariants that carry the sync's correctness and that
 * example-based tests can only sample:
 *  - idempotence: syncing the same pages twice yields identical chunks
 *  - monotonicity: the cursor never moves backwards
 *  - no loss: partitioning preserves every distinct scrobble
 *  - order independence: shuffling pages yields the same chunk set
 *  - redaction totality: no api_key substring survives redactKey
 *
 * Iteration count is overridable for nightly soak runs:
 *   FC_NUM_RUNS=10000 deno task test:soak
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  advanceCursor,
  dedupeScrobbles,
  partitionByYear,
  redactKey,
  type Scrobble,
  scrobbleKey,
} from "./lastfm.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const numRuns = ENV_RUNS ? Number(ENV_RUNS) : 200;
const cfg = { numRuns };

/** uts values spanning 2005-2026 so year partitioning is genuinely exercised. */
const utsArb = fc.integer({
  min: Math.floor(Date.UTC(2005, 0, 1) / 1000),
  max: Math.floor(Date.UTC(2026, 11, 31) / 1000),
});

const scrobbleArb: fc.Arbitrary<Scrobble> = fc.record({
  uts: utsArb,
  artist: fc.string({ minLength: 1, maxLength: 12 }),
  track: fc.string({ minLength: 1, maxLength: 12 }),
  album: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
});

const historyArb = fc.array(scrobbleArb, { maxLength: 120 });

// ---------------------------------------------------------------------------

Deno.test("property: partitioning loses nothing — every distinct scrobble lands in exactly one year", () => {
  fc.assert(
    fc.property(historyArb, (history) => {
      const deduped = dedupeScrobbles(history);
      const parts = partitionByYear(deduped);
      let total = 0;
      for (const rows of parts.values()) total += rows.length;
      assertEquals(total, deduped.length);

      // and each row is in the partition matching its own UTC year
      for (const [year, rows] of parts) {
        for (const r of rows) {
          assertEquals(
            String(new Date(r.uts * 1000).getUTCFullYear()),
            year,
          );
        }
      }
    }),
    cfg,
  );
});

Deno.test("property: dedupe is idempotent — deduping twice equals deduping once", () => {
  fc.assert(
    fc.property(historyArb, (history) => {
      const once = dedupeScrobbles(history);
      const twice = dedupeScrobbles(once);
      assertEquals(twice.length, once.length);
      assertEquals(
        twice.map(scrobbleKey).sort(),
        once.map(scrobbleKey).sort(),
      );
    }),
    cfg,
  );
});

Deno.test("property: dedupe is order-independent — any permutation yields the same key set", () => {
  fc.assert(
    fc.property(
      historyArb.chain((history) =>
        fc.tuple(
          fc.constant(history),
          // A genuine permutation of the same rows, not a partial reorder.
          fc.shuffledSubarray(history, {
            minLength: history.length,
            maxLength: history.length,
          }),
        )
      ),
      ([history, permuted]) => {
        assertEquals(
          dedupeScrobbles(permuted).map(scrobbleKey).sort(),
          dedupeScrobbles(history).map(scrobbleKey).sort(),
        );
      },
    ),
    cfg,
  );
});

Deno.test("property: dedupe never invents a scrobble absent from the input", () => {
  fc.assert(
    fc.property(historyArb, (history) => {
      const inputKeys = new Set(history.map(scrobbleKey));
      for (const row of dedupeScrobbles(history)) {
        assert(inputKeys.has(scrobbleKey(row)));
      }
    }),
    cfg,
  );
});

Deno.test("property: the cursor is monotonic — it never moves backwards", () => {
  fc.assert(
    fc.property(historyArb, utsArb, (history, prev) => {
      assert(advanceCursor(prev, history) >= prev);
    }),
    cfg,
  );
});

Deno.test("property: the cursor lands on the newest uts when it advances", () => {
  fc.assert(
    fc.property(fc.array(scrobbleArb, { minLength: 1, maxLength: 60 }), (h) => {
      const newest = Math.max(...h.map((s) => s.uts));
      assertEquals(advanceCursor(0, h), newest);
    }),
    cfg,
  );
});

/** 32 hex chars — the shape of a real Last.fm API key. */
const keyArb: fc.Arbitrary<string> = fc.array(
  fc.constantFrom(..."0123456789abcdef".split("")),
  { minLength: 32, maxLength: 32 },
).map((chars) => chars.join(""));

Deno.test("property: redaction is total — no api_key substring survives", () => {
  fc.assert(
    fc.property(keyArb, fc.string({ maxLength: 20 }), (key, method) => {
      const url =
        `https://ws.audioscrobbler.com/2.0/?method=${
          encodeURIComponent(method)
        }` +
        `&api_key=${key}&format=json`;
      const out = redactKey(url);
      assert(!out.includes(key), `key survived redaction: ${out}`);
    }),
    cfg,
  );
});

Deno.test("property: redaction preserves every non-secret parameter", () => {
  fc.assert(
    fc.property(keyArb, (key) => {
      const out = redactKey(
        `https://ws.audioscrobbler.com/2.0/?method=user.getInfo&api_key=${key}&format=json&user=u3BpaT`,
      );
      assert(out.includes("method=user.getInfo"));
      assert(out.includes("format=json"));
      assert(out.includes("user=u3BpaT"));
    }),
    cfg,
  );
});
