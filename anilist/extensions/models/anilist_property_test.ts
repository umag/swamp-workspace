/**
 * Property-based tests (fast-check) for @magistr/anilist's exported pure
 * helpers: `compressRanges` (honesty/dedupe over arbitrary integer sets),
 * `mergeActivities` (group-count invariant over arbitrary (user,media) keys),
 * `advanceCursor` (monotonicity / never-backwards), and `filterNewActivities`
 * (per-user isolation, cross-checked against an independent oracle
 * reimplementation of the filter rule).
 *
 * Iteration count is gated by FC_NUM_RUNS (small by default for the regular
 * test task, large for the nightly `test:soak` — mirrors the
 * seadex/musicbrainz/porkbun precedent exactly).
 *
 * These pure helpers are untouched by the `2026.08.02.1` AL1-AL4 fixes (which
 * are scoped to `gql()`'s request/retry path and its call sites — see
 * `anilist_adversarial_test.ts`); every property here still characterizes
 * already-shipped, unchanged behavior over the full input space, not just
 * the concrete examples in the coverage suite.
 */
import fc from "npm:fast-check@4.8.0";
import {
  type ActivityCursor,
  type ActivityItem,
  advanceCursor,
  compressRanges,
  filterNewActivities,
  mergeActivities,
} from "./anilist.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// compressRanges — honesty (never invents a number) + dedupe + sorted runs
// ---------------------------------------------------------------------------

/** Independent oracle: expand a compressRanges() output string back into the
 * exact set of integers it represents ("1-3, 7" -> {1,2,3,7}). */
function expandCompressed(s: string): Set<number> {
  const out = new Set<number>();
  if (s === "") return out;
  for (const token of s.split(", ")) {
    const m = token.match(/^(-?\d+)(?:-(-?\d+))?$/);
    if (!m) {
      throw new Error(`unparseable token in compressRanges output: ${token}`);
    }
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  return out;
}

Deno.test("property: compressRanges expands back to EXACTLY the distinct input set — never invents, never drops a number", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 500 }), {
        minLength: 0,
        maxLength: 40,
      }),
      (nums) => {
        const compressed = compressRanges(nums);
        const expanded = expandCompressed(compressed);
        const inputSet = new Set(nums);
        return expanded.size === inputSet.size &&
          [...inputSet].every((n) => expanded.has(n));
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: compressRanges output runs are strictly ascending and non-overlapping", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 500 }), {
        minLength: 1,
        maxLength: 40,
      }),
      (nums) => {
        const compressed = compressRanges(nums);
        if (compressed === "") return nums.length === 0;
        const starts = compressed.split(", ").map((token) => {
          const m = token.match(/^(-?\d+)/)!;
          return Number(m[1]);
        });
        for (let i = 1; i < starts.length; i++) {
          if (starts[i] <= starts[i - 1]) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// mergeActivities — merged-row count equals the number of DISTINCT
// (userName, mediaId) keys, regardless of how many raw activities share a key
// ---------------------------------------------------------------------------

const arbActivity = fc.record({
  id: fc.integer({ min: 1, max: 100_000 }),
  createdAt: fc.integer({ min: 0, max: 2_000_000_000 }),
  userId: fc.integer({ min: 1, max: 100 }),
  userName: fc.constantFrom("fixture_watcher", "synth_traveler", "testUserA"),
  status: fc.constantFrom(
    "watched episode",
    "rewatched episode",
    "read chapter",
    "completed",
  ),
  progress: fc.option(
    fc.integer({ min: 1, max: 50 }).map((n) => String(n)),
    { nil: null },
  ),
  mediaId: fc.integer({ min: 90001, max: 90010 }),
  title: fc.constantFrom("Nebula Drifters", "Static Bloom", "Quiet Horizon"),
  siteUrl: fc.constant(null),
  score: fc.constant(null),
});

Deno.test("property: mergeActivities produces exactly one row per DISTINCT (userName, mediaId) key, regardless of how many raw activities share that key", () => {
  fc.assert(
    fc.property(
      fc.array(arbActivity, { minLength: 0, maxLength: 30 }),
      (activities: ActivityItem[]) => {
        const merged = mergeActivities(activities);
        const distinctKeys = new Set(
          activities.map((a) => `${a.userName} ${a.mediaId}`),
        );
        return merged.length === distinctKeys.size;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: every mergeActivities output row's (userName, mediaId) pair is one that actually appeared in the input", () => {
  fc.assert(
    fc.property(
      fc.array(arbActivity, { minLength: 1, maxLength: 30 }),
      (activities: ActivityItem[]) => {
        const merged = mergeActivities(activities);
        const inputKeys = new Set(
          activities.map((a) => `${a.userName} ${a.mediaId}`),
        );
        return merged.every((m) => inputKeys.has(`${m.userName} ${m.mediaId}`));
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// advanceCursor — monotonicity: a user's lastSeenActivityId never decreases,
// always becomes max(previous, max sent id for that user)
// ---------------------------------------------------------------------------

const arbSentActivity = fc.record({
  id: fc.integer({ min: 1, max: 100_000 }),
  createdAt: fc.integer({ min: 0, max: 2_000_000_000 }),
  userId: fc.integer({ min: 1, max: 100 }),
  userName: fc.constantFrom("fixture_watcher", "synth_traveler"),
  status: fc.constant("watched episode"),
  progress: fc.constant("1"),
  mediaId: fc.constant(90001),
  title: fc.constant("Nebula Drifters"),
  siteUrl: fc.constant(null),
  score: fc.constant(null),
});

Deno.test("property: advanceCursor never moves any user's lastSeenActivityId backwards — always max(previous, max sent id for that user)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100_000 }),
      fc.array(arbSentActivity, { minLength: 0, maxLength: 20 }),
      (initialLastSeen, sent: ActivityItem[]) => {
        const cursor: ActivityCursor = {
          users: {
            fixture_watcher: { userId: 1, lastSeenActivityId: initialLastSeen },
          },
        };
        const next = advanceCursor(cursor, sent);
        const sentIdsForUser = sent
          .filter((a) => a.userName === "fixture_watcher")
          .map((a) => a.id);
        const expected = sentIdsForUser.length
          ? Math.max(initialLastSeen, ...sentIdsForUser)
          : initialLastSeen;
        return next.users.fixture_watcher.lastSeenActivityId === expected;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// filterNewActivities — cross-checked against an independent oracle
// reimplementation of the per-user filter rule (proves user isolation as a
// side effect: each user's own threshold governs only their own activities)
// ---------------------------------------------------------------------------

const arbCursorEntry = fc.record({
  userId: fc.integer({ min: 1, max: 100 }),
  lastSeenActivityId: fc.integer({ min: 0, max: 1000 }),
  lastSeenCreatedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000 }), {
    nil: undefined,
  }),
});

function oracleFilter(
  activities: ActivityItem[],
  cursor: ActivityCursor,
  lookbackCutoff: number,
): ActivityItem[] {
  return activities.filter((a) => {
    const entry = cursor.users[a.userName.toLowerCase()];
    if (entry && entry.lastSeenActivityId > 0) {
      return a.id > entry.lastSeenActivityId;
    }
    return a.createdAt > (entry?.lastSeenCreatedAt ?? lookbackCutoff);
  });
}

Deno.test("property: filterNewActivities matches an independent oracle reimplementation of the per-user threshold rule, over arbitrary cursors/activities (proves user isolation as a corollary)", () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.constantFrom("fixture_watcher", "synth_traveler", "testusera"),
        arbCursorEntry,
      ),
      fc.array(arbActivity, { minLength: 0, maxLength: 20 }),
      fc.integer({ min: 0, max: 2_000_000_000 }),
      (usersDict, activities: ActivityItem[], lookbackCutoff) => {
        const cursor: ActivityCursor = { users: usersDict };
        const actual = filterNewActivities(activities, cursor, lookbackCutoff);
        const expected = oracleFilter(activities, cursor, lookbackCutoff);
        return JSON.stringify(actual.map((a) => a.id).sort()) ===
          JSON.stringify(expected.map((a) => a.id).sort());
      },
    ),
    FC_RUNS,
  );
});
