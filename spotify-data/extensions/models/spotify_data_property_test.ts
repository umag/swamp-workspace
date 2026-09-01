/**
 * Property-based tests (fast-check) for @magistr/spotify-data.
 *
 * These cover the invariants that carry the importer's correctness and that
 * example-based tests can only sample:
 *  - no loss: partitioning preserves every stream, exactly once
 *  - idempotence: dedupe and partition are stable under repetition
 *  - order independence: shuffling the export yields the same chunk contents
 *  - privacy totality: no source-record field survives toStream, for ANY record
 *  - key soundness: two streams share a key iff they are field-wise equal
 *
 * The generators deliberately span 1970-2038 so UTC year bucketing is
 * genuinely exercised at boundaries, not just around "now".
 *
 * Iteration count is overridable for nightly soak runs:
 *   FC_NUM_RUNS=10000 deno task test:soak
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  dedupeStreams,
  partitionByYear,
  type Stream,
  streamKey,
  toStream,
  toUts,
} from "./spotify_data.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const numRuns = ENV_RUNS ? Number(ENV_RUNS) : 200;
const cfg = { numRuns };

/** uts spanning 1970-2038 so year partitioning sees real boundaries. */
const utsArb = fc.integer({ min: 0, max: 2_147_483_647 });

/** Names drawn from a small pool so collisions and dedupe actually happen. */
const nameArb = fc.constantFrom("a", "b", "Za Frûmi", "Autechre", "", "a b");

const streamArb: fc.Arbitrary<Stream> = fc.record({
  uts: utsArb,
  artist: fc.constantFrom("a", "b", "Za Frûmi", "Autechre", "a b"),
  track: fc.constantFrom("t", "u", "a b", "Ghosts"),
  album: fc.option(nameArb, { nil: undefined }),
  trackUri: fc.option(fc.constantFrom("uri:1", "uri:2"), { nil: undefined }),
  msPlayed: fc.integer({ min: 0, max: 3_600_000 }),
  skipped: fc.option(fc.boolean(), { nil: undefined }),
  shuffle: fc.option(fc.boolean(), { nil: undefined }),
  offline: fc.option(fc.boolean(), { nil: undefined }),
  reasonStart: fc.option(fc.constantFrom("clickrow", "fwdbtn"), {
    nil: undefined,
  }),
  reasonEnd: fc.option(fc.constantFrom("trackdone", "endplay"), {
    nil: undefined,
  }),
});

const streamsArb = fc.array(streamArb, { maxLength: 60 });

// ---------------------------------------------------------------------------
// no loss
// ---------------------------------------------------------------------------

Deno.test("property: partitionByYear preserves every stream exactly once — no row is lost or duplicated", () => {
  fc.assert(
    fc.property(streamsArb, (rows) => {
      const parts = partitionByYear(rows);
      const total = [...parts.values()].reduce((a, r) => a + r.length, 0);
      assertEquals(total, rows.length);
    }),
    cfg,
  );
});

Deno.test("property: every stream lands in the bucket matching its own UTC year", () => {
  fc.assert(
    fc.property(streamsArb, (rows) => {
      for (const [year, bucket] of partitionByYear(rows)) {
        for (const row of bucket) {
          assertEquals(
            String(new Date(row.uts * 1000).getUTCFullYear()),
            year,
          );
        }
      }
    }),
    cfg,
  );
});

// ---------------------------------------------------------------------------
// idempotence
// ---------------------------------------------------------------------------

Deno.test("property: dedupeStreams is idempotent — deduping twice equals deduping once", () => {
  fc.assert(
    fc.property(streamsArb, (rows) => {
      const once = dedupeStreams(rows);
      const twice = dedupeStreams(once);
      assertEquals(twice, once);
    }),
    cfg,
  );
});

Deno.test("property: dedupeStreams output holds no two field-wise-equal rows", () => {
  fc.assert(
    fc.property(streamsArb, (rows) => {
      const out = dedupeStreams(rows);
      const keys = out.map(streamKey);
      assertEquals(new Set(keys).size, keys.length);
    }),
    cfg,
  );
});

Deno.test("property: dedupeStreams never invents a row — its output is a subsequence of its input", () => {
  fc.assert(
    fc.property(streamsArb, (rows) => {
      const out = dedupeStreams(rows);
      assert(out.length <= rows.length);
      let i = 0;
      for (const row of rows) {
        if (i < out.length && streamKey(row) === streamKey(out[i])) i++;
      }
      assertEquals(i, out.length, "output must appear in input order");
    }),
    cfg,
  );
});

// ---------------------------------------------------------------------------
// order independence
// ---------------------------------------------------------------------------

Deno.test("property: shuffling the export changes no year's CONTENT — chunks are order-independent once sorted", () => {
  fc.assert(
    fc.property(
      streamsArb,
      fc.array(fc.nat(), { maxLength: 60 }),
      (rows, ns) => {
        // Deterministic permutation driven by the generated numbers.
        const shuffled = [...rows];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (ns[i % Math.max(ns.length, 1)] ?? 0) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        // Sort by year with an EXPLICIT comparator: the default one stringifies
        // each entry, which throws on a null-prototype record.
        const sortKeys = (m: Map<string, Stream[]>) =>
          [...m.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([y, rs]) => [y, rs.map(streamKey).sort()]);
        assertEquals(
          sortKeys(partitionByYear(dedupeStreams(shuffled))),
          sortKeys(partitionByYear(dedupeStreams(rows))),
        );
      },
    ),
    cfg,
  );
});

// ---------------------------------------------------------------------------
// key soundness
// ---------------------------------------------------------------------------

Deno.test("property: two streams share a streamKey IFF every field is equal", () => {
  fc.assert(
    fc.property(streamArb, streamArb, (a, b) => {
      const fieldsEqual = JSON.stringify(normalize(a)) ===
        JSON.stringify(normalize(b));
      assertEquals(streamKey(a) === streamKey(b), fieldsEqual);
    }),
    cfg,
  );
});

/** Field order and undefined-vs-empty normalized the way streamKey sees them. */
function normalize(s: Stream) {
  return [
    s.uts,
    s.artist,
    s.track,
    s.album ?? "",
    s.trackUri ?? "",
    s.msPlayed,
    s.skipped ?? "",
    s.shuffle ?? "",
    s.offline ?? "",
    s.reasonStart ?? "",
    s.reasonEnd ?? "",
  ];
}

// ---------------------------------------------------------------------------
// privacy totality
// ---------------------------------------------------------------------------

Deno.test("property: NO generated privacy value survives toStream, for any record shape", () => {
  const secretArb = fc.constantFrom(
    "203.0.113.9",
    "10.1.2.3",
    "SECRET-PLATFORM",
    "NL",
    "incognito-marker",
  );
  fc.assert(
    fc.property(
      utsArb,
      secretArb,
      secretArb,
      fc.boolean(),
      (uts, ip, platform, incognito) => {
        const raw = {
          ts: new Date(uts * 1000).toISOString(),
          ms_played: 1000,
          master_metadata_track_name: "t",
          master_metadata_album_artist_name: "a",
          ip_addr: ip,
          conn_country: platform,
          platform,
          incognito_mode: incognito,
        };
        const s = toStream(raw);
        assert(s, "a well-formed music record must parse");
        const json = JSON.stringify(s);
        assert(!json.includes(ip), `ip ${ip} survived toStream`);
        assert(
          !json.includes(platform),
          `platform ${platform} survived toStream`,
        );
      },
    ),
    cfg,
  );
});

Deno.test("property: toStream output keys are always exactly the allowlisted Stream fields", () => {
  const ALLOWED = [
    "album",
    "artist",
    "msPlayed",
    "offline",
    "reasonEnd",
    "reasonStart",
    "shuffle",
    "skipped",
    "track",
    "trackUri",
    "uts",
  ];
  fc.assert(
    fc.property(
      fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer())),
      utsArb,
      (extras, uts) => {
        const s = toStream({
          ...extras,
          ts: new Date(uts * 1000).toISOString(),
          ms_played: 1000,
          master_metadata_track_name: "t",
          master_metadata_album_artist_name: "a",
          episode_name: undefined,
          audiobook_title: undefined,
        });
        if (!s) return; // an extras key may have clobbered a required field
        for (const k of Object.keys(s)) {
          assert(ALLOWED.includes(k), `unexpected key "${k}" on Stream`);
        }
      },
    ),
    cfg,
  );
});

// ---------------------------------------------------------------------------
// timestamp round-trip
// ---------------------------------------------------------------------------

Deno.test("property: toUts round-trips any ISO instant it accepts, to the second", () => {
  fc.assert(
    fc.property(utsArb, (uts) => {
      const iso = new Date(uts * 1000).toISOString();
      assertEquals(toUts(iso), uts);
    }),
    cfg,
  );
});

Deno.test("property: toUts returns undefined for every non-string, never NaN", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.array(fc.string()),
      ),
      (bad) => {
        assertEquals(toUts(bad), undefined);
      },
    ),
    cfg,
  );
});
