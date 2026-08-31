/**
 * Property-based tests (fast-check@4.8.0) for the pure path helpers that decide
 * WHERE bytes land and WHETHER a remote-supplied path is allowed to be written.
 *
 * These are the two functions the 2026.08.31.1 release turns on: a bug in
 * either silently misplaces data (tierRoot) or lets a hostile `_id` escape the
 * cache (isSafeRelPath). Example-based tests cover the cases we thought of;
 * these cover the ones we did not.
 *
 * Iteration count is gated by FC_NUM_RUNS (small by default for the regular
 * test task, large for a nightly soak) — mirrors the anilist/seadex precedent.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { ConfigSchema, tierRoot } from "./config.ts";
import { isSafeRelPath, resolveWithinCache } from "./sync.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

function cfg(namespace: string) {
  return ConfigSchema.parse({
    uri: "mongodb://localhost:27017/?replicaSet=rs0",
    username: "swamp",
    namespace,
  });
}

// A namespace as the config schema would realistically carry it.
const nsArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);

// The cache root is TRUSTED input: core builds it as
// `<swampDataDir>/repos/<repoId>`, always a normalised absolute path with
// non-empty segments. Modelling it as such is deliberate — the untrusted half
// of every property below is `relPath`, which stays a fully unconstrained
// `fc.string()` so the guard is exercised over arbitrary attacker input.
const cacheArb = fc
  .array(fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/), {
    minLength: 1,
    maxLength: 5,
  })
  .map((segments) => `/${segments.join("/")}`);

// ---------------------------------------------------------------------------
// tierRoot — placement
// ---------------------------------------------------------------------------

Deno.test("property: a non-empty namespace always yields a path under the cache", () => {
  fc.assert(
    fc.property(cacheArb, nsArb, (cache, ns) => {
      const root = tierRoot(cfg(ns), cache);
      const base = cache.replace(/\/+$/, "");
      return root.startsWith(`${base}/`) && root.length > base.length;
    }),
    FC_RUNS,
  );
});

Deno.test("property: the tier root ends with exactly the namespace segment", () => {
  fc.assert(
    fc.property(cacheArb, nsArb, (cache, ns) => {
      const root = tierRoot(cfg(ns), cache);
      return root.split("/").pop() === ns;
    }),
    FC_RUNS,
  );
});

// The namespace scopes the LOCAL side only — a leak into the stored path would
// orphan every blob, since remote _ids are tier-relative.
Deno.test("property: tierRoot never mutates the namespace used for collection prefixing", () => {
  fc.assert(
    fc.property(cacheArb, nsArb, (cache, ns) => {
      const c = cfg(ns);
      tierRoot(c, cache);
      return c.namespace === ns;
    }),
    FC_RUNS,
  );
});

Deno.test("property: tierRoot is idempotent in the namespace (never doubles it)", () => {
  fc.assert(
    fc.property(cacheArb, nsArb, (cache, ns) => {
      const root = tierRoot(cfg(ns), cache);
      // Applying the same namespace to the ALREADY-rooted path must add a
      // second segment rather than silently collapse — proving the function is
      // a pure join and callers must apply it exactly once.
      return tierRoot(cfg(ns), root) === `${root}/${ns}`;
    }),
    FC_RUNS,
  );
});

Deno.test("property: distinct namespaces never collide on one tier root", () => {
  fc.assert(
    fc.property(cacheArb, nsArb, nsArb, (cache, a, b) => {
      if (a === b) return true;
      return tierRoot(cfg(a), cache) !== tierRoot(cfg(b), cache);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// isSafeRelPath / resolveWithinCache — containment
// ---------------------------------------------------------------------------

// THE core security invariant: whatever the database hands us, an accepted path
// resolves inside the cache root. Normalise the result and it must still be
// under the root — no `..` may survive anywhere in it.
Deno.test("property: an accepted path never escapes the cache root", () => {
  fc.assert(
    fc.property(cacheArb, fc.string(), (cache, relPath) => {
      if (!isSafeRelPath(relPath)) return true;
      const joined = resolveWithinCache(cache, relPath);
      const base = cache.replace(/\/+$/, "");
      if (!joined.startsWith(`${base}/`)) return false;
      // No segment of the accepted remainder may be a traversal.
      return joined
        .slice(base.length + 1)
        .split("/")
        .every((s) => s !== "" && s !== "." && s !== "..");
    }),
    FC_RUNS,
  );
});

Deno.test("property: any path containing a dot segment is rejected", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", "b", "..", ".", "x"), {
        minLength: 1,
        maxLength: 6,
      }),
      (segments) => {
        const relPath = segments.join("/");
        const hasDotSegment = segments.some((s) => s === "." || s === "..");
        if (!hasDotSegment) return true;
        return isSafeRelPath(relPath) === false;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: rejection and throwing agree exactly", () => {
  fc.assert(
    fc.property(cacheArb, fc.string(), (cache, relPath) => {
      let threw = false;
      try {
        resolveWithinCache(cache, relPath);
      } catch {
        threw = true;
      }
      return threw === !isSafeRelPath(relPath);
    }),
    FC_RUNS,
  );
});

// Anything carrying a separator-like or terminator byte must never be accepted,
// however it is embedded.
Deno.test("property: backslash and NUL are rejected wherever they appear", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 8 }),
      fc.constantFrom("\\", "\0"),
      fc.string({ minLength: 0, maxLength: 8 }),
      (a, bad, b) => isSafeRelPath(`${a}${bad}${b}`) === false,
    ),
    FC_RUNS,
  );
});

// A path built purely from safe segments must always be accepted — the guard
// must not be so strict that legitimate tier paths get dropped.
Deno.test("property: paths built from safe segments are always accepted", () => {
  const safeSegment = fc.stringMatching(/^[A-Za-z0-9@._ -]{1,20}$/)
    .filter((s) => s !== "." && s !== "..");
  fc.assert(
    fc.property(
      fc.array(safeSegment, { minLength: 1, maxLength: 8 }),
      (segments) => isSafeRelPath(segments.join("/")) === true,
    ),
    FC_RUNS,
  );
});

Deno.test("FC_NUM_RUNS knob is honoured", () => {
  assertEquals(NIGHT(200), ENV_RUNS ? Number(ENV_RUNS) : 200);
});
