// Property-based tests (fast-check) for @magistr/pihole's pure reconciliation
// and redaction logic (lib/dns.ts). No I/O, no fetch stub needed — these are
// the formal invariants behind the destructive-safety guards exercised at
// the method level in pihole_adversarial_test.ts / pihole_methods_test.ts.
//
// Invariants under test:
//  - convergence is idempotent: diffing again after applying a diff yields
//    no further changes
//  - deleteExtras=false (or omitted) never deletes, for any input
//  - NO-PHANTOM-DELETE: deleted ⊆ existing, for any deleteExtras
//  - totality: added ⊎ unchanged == the distinct desired set, with no
//    overlap, and added never intersects existing
//  - redaction totality: every secret >=8 chars is removed from arbitrary
//    surrounding text, redaction is idempotent, and output is length-capped
//
// FC_NUM_RUNS overrides the run count for a larger nightly soak (see
// pihole/deno.json's test:soak task).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fc from "npm:fast-check@4.8.0";
import { diffRecords, type DnsRecord, redactSecrets } from "./lib/dns.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbIp = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255))
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

const arbHostname = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}\.test$/);

const arbRecord: fc.Arbitrary<DnsRecord> = fc.record({
  ip: arbIp,
  hostname: arbHostname,
});

const arbRecordList = fc.array(arbRecord, { maxLength: 12 });

function key(r: DnsRecord): string {
  return `${r.ip} ${r.hostname}`;
}

/** Apply a diff's added/deleted to `existing`, producing the next state — a
 * pure model of what `runSync` does against the live appliance. */
function applyDiff(
  existing: DnsRecord[],
  diff: ReturnType<typeof diffRecords>,
): DnsRecord[] {
  const removedKeys = new Set(diff.deleted.map(key));
  const kept = existing.filter((r) => !removedKeys.has(key(r)));
  return [...kept, ...diff.added];
}

// ---------------------------------------------------------------------------
// Convergence idempotence
// ---------------------------------------------------------------------------

Deno.test("property: converging twice is a no-op (idempotent convergence)", () => {
  fc.assert(
    fc.property(arbRecordList, arbRecordList, (existing, desired) => {
      const first = diffRecords(existing, desired, { deleteExtras: true });
      const converged = applyDiff(existing, first);
      const second = diffRecords(converged, desired, { deleteExtras: true });
      return second.added.length === 0 && second.deleted.length === 0;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// deleteExtras=false never deletes
// ---------------------------------------------------------------------------

Deno.test("property: deleteExtras=false (or omitted) never deletes, for any existing/desired pair", () => {
  fc.assert(
    fc.property(arbRecordList, arbRecordList, (existing, desired) => {
      const explicitFalse = diffRecords(existing, desired, {
        deleteExtras: false,
      });
      const omitted = diffRecords(existing, desired);
      return explicitFalse.deleted.length === 0 && omitted.deleted.length === 0;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// NO-PHANTOM-DELETE: deleted subset-of existing
// ---------------------------------------------------------------------------

Deno.test("property: NO-PHANTOM-DELETE — every deleted record was in the existing set (deleted subset-of existing), for any deleteExtras", () => {
  fc.assert(
    fc.property(
      arbRecordList,
      arbRecordList,
      fc.boolean(),
      (existing, desired, deleteExtras) => {
        const d = diffRecords(existing, desired, { deleteExtras });
        const existingKeys = new Set(existing.map(key));
        return d.deleted.every((r) => existingKeys.has(key(r)));
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// Totality / no-loss
// ---------------------------------------------------------------------------

Deno.test("property: totality — added and unchanged together exactly cover the distinct desired set, with no overlap", () => {
  fc.assert(
    fc.property(arbRecordList, arbRecordList, (existing, desired) => {
      const d = diffRecords(existing, desired);
      const distinctDesired = new Set(desired.map(key));
      const addedKeys = new Set(d.added.map(key));
      const unchangedKeys = new Set(d.unchanged.map(key));
      const noOverlap = [...addedKeys].every((k) => !unchangedKeys.has(k));
      const union = new Set([...addedKeys, ...unchangedKeys]);
      const coversDistinctDesired = union.size === distinctDesired.size &&
        [...union].every((k) => distinctDesired.has(k));
      return noOverlap && coversDistinctDesired;
    }),
    FC_RUNS,
  );
});

Deno.test("property: added never intersects existing (an 'added' record was never already present)", () => {
  fc.assert(
    fc.property(arbRecordList, arbRecordList, (existing, desired) => {
      const d = diffRecords(existing, desired);
      const existingKeys = new Set(existing.map(key));
      return d.added.every((r) => !existingKeys.has(key(r)));
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// Redaction totality
// ---------------------------------------------------------------------------

const arbSecret = fc.string({ minLength: 8, maxLength: 40 }).filter(
  (s) => s.trim().length >= 8,
);

Deno.test("property: redactSecrets removes every generated secret (>=8 chars) from arbitrary surrounding text", () => {
  fc.assert(
    fc.property(
      arbSecret,
      fc.string(),
      fc.string(),
      (secret, before, after) => {
        const out = redactSecrets(`${before}${secret}${after}`, [secret]);
        return !out.includes(secret);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: redactSecrets is idempotent (re-redacting an already-redacted string changes nothing)", () => {
  fc.assert(
    fc.property(arbSecret, fc.string(), (secret, msg) => {
      const once = redactSecrets(msg, [secret]);
      return redactSecrets(once, [secret]) === once;
    }),
    FC_RUNS,
  );
});

Deno.test("property: redactSecrets output is always bounded to the 2048-char cap", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 5000 }), (text) => {
      return redactSecrets(text, []).length <= 2048;
    }),
    FC_RUNS,
  );
});

Deno.test("property: redactSecrets tolerates any mix of empty/undefined secrets without throwing", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.array(fc.option(fc.string(), { nil: undefined }), { maxLength: 5 }),
      (text, secrets) => {
        redactSecrets(text, secrets);
        return true;
      },
    ),
    FC_RUNS,
  );
});

// Explicit sanity pin: the property harness itself runs (guards against a
// silently-vacuous fc.assert due to a misconfigured arbitrary).
Deno.test("property harness sanity: FC_RUNS resolves to a positive integer", () => {
  assertEquals(Number.isInteger(FC_RUNS.numRuns) && FC_RUNS.numRuns > 0, true);
});
