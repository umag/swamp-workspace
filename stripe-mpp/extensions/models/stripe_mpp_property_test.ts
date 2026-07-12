/**
 * Property-based tests (fast-check) for @magistr/stripe-mpp.
 *
 * Two layers:
 *  1. Our pure helpers — redaction, slug, idempotency keys, spt truncation,
 *     the minor-units spend-guard comparison, and the URL policy. These are
 *     the security-relevant invariants: they must hold for ALL inputs, not
 *     just the examples in the unit suite.
 *  2. mppx codec invariants — challenge/credential/receipt round-trips and
 *     HMAC tamper detection over generated (spec-plausible) inputs. These
 *     extend the fixed spec fixtures in stripe_mpp_test.ts: a pin bump that
 *     only breaks on unusual-but-valid values surfaces here.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.5";
import {
  amountExceeds,
  assertUrlPolicy,
  idemKey,
  redact,
  slug,
  truncateSpt,
} from "./stripe_mpp.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);

const SERVER_SECRET = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Stripe-style secret keys and spt ids. */
const arbSecretKey = fc.tuple(
  fc.constantFrom("sk_test_", "sk_live_"),
  fc.stringMatching(/^[A-Za-z0-9]{8,40}$/),
).map(([p, s]) => p + s);

const arbSptId = fc.stringMatching(/^spt_[A-Za-z0-9_]{4,40}$/);

/** Minor-unit amount strings (non-negative integers, up to 15 digits). */
const arbAmount = fc.bigInt({ min: 0n, max: 999_999_999_999_999n })
  .map((n) => n.toString());

/** Spec-plausible challenge params: lowercase-ASCII method, sane realm. */
const arbChallengeParams = fc.record({
  realm: fc.stringMatching(/^[a-z0-9.-]{1,40}$/),
  // mppx's deserialize enforces /^[a-z][a-z0-9:_-]*$/ on method (letter-first,
  // lowercase per spec). Note the asymmetry: Challenge.from() does NOT
  // validate this — a method like "-" serializes fine but can never be
  // parsed back. Generate only wire-valid methods.
  method: fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/),
  intent: fc.constantFrom("charge", "session"),
  request: fc.record({
    amount: arbAmount,
    currency: fc.constantFrom("usd", "eur", "jpy", "gbp"),
    methodDetails: fc.record({
      networkId: fc.stringMatching(/^profile_test_[A-Za-z0-9]{1,20}$/),
      paymentMethodTypes: fc.uniqueArray(
        fc.constantFrom("card", "link", "klarna", "afterpay_clearpay"),
        { minLength: 1, maxLength: 4 },
      ),
    }),
  }),
});

const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Layer 1: pure helper invariants
// ---------------------------------------------------------------------------

Deno.test("property: redact removes the secret key and ALL spt ids from any message", () => {
  fc.assert(
    fc.property(
      arbSecretKey,
      arbSptId,
      fc.string(),
      fc.string(),
      (secretKey, sptId, before, after) => {
        const g = { secretKey, serverSecret: SERVER_SECRET } as Parameters<
          typeof redact
        >[0];
        const out = redact(g, `${before}${secretKey}${after} token=${sptId}`);
        return !out.includes(secretKey) && !out.includes(sptId) &&
          !out.includes(SERVER_SECRET);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: redact is idempotent", () => {
  fc.assert(
    fc.property(arbSecretKey, fc.string(), (secretKey, msg) => {
      const g = { secretKey } as Parameters<typeof redact>[0];
      const once = redact(g, msg);
      return redact(g, once) === once;
    }),
    FC_RUNS,
  );
});

Deno.test("property: slug is always instance-name safe", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const out = slug(s);
      return /^[a-z0-9][a-z0-9-]*$/.test(out) && out.length <= 48;
    }),
    FC_RUNS,
  );
});

Deno.test("property: idemKey is deterministic — same op+parts → same key", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1 }),
      fc.array(fc.option(fc.string(), { nil: undefined }), { maxLength: 5 }),
      async (op, parts) => {
        const a = await idemKey(op, parts);
        const b = await idemKey(op, parts);
        return a === b && a.startsWith(`swamp-mpp-${op}-`);
      },
    ),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: idemKey is INJECTIVE — distinct inputs → distinct keys (no charge suppression)", async () => {
  // The money bug this guards: two genuinely-different charges/refunds must
  // never collide onto one Idempotency-Key (which would make Stripe suppress
  // the second). Covers order-sensitivity, positional boundaries, and
  // undefined-vs-"" — a 32-bit hash could not carry this.
  const seen = new Map<string, string>();
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("charge", "refund", "mint"),
      fc.array(fc.option(fc.string({ maxLength: 12 }), { nil: undefined }), {
        minLength: 1,
        maxLength: 4,
      }),
      async (op, parts) => {
        const key = await idemKey(op, parts);
        const sig = JSON.stringify([op, parts]);
        const prior = seen.get(key);
        if (prior !== undefined && prior !== sig) return false; // collision
        seen.set(key, sig);
        return true;
      },
    ),
    { numRuns: NIGHT(300) },
  );
  // Explicit boundary cases the generator might not hit.
  const k = (op: string, p: Array<string | undefined>) => idemKey(op, p);
  const keys = await Promise.all([
    k("charge", ["a", "bc"]),
    k("charge", ["ab", "c"]), // positional boundary
    k("charge", ["x", "y"]),
    k("charge", ["y", "x"]), // order
    k("charge", [undefined, "z"]),
    k("charge", ["", "z"]), // undefined vs ""
    k("refund", ["a", "bc"]), // op namespaced
  ]);
  assertEquals(new Set(keys).size, keys.length, "all boundary keys distinct");
});

Deno.test("property: truncateSpt never leaks a full id longer than 8 chars", () => {
  fc.assert(
    fc.property(arbSptId, (sptId) => {
      const out = truncateSpt(sptId);
      return sptId.length <= 8 || !out.includes(sptId);
    }),
    FC_RUNS,
  );
});

Deno.test("property: amountExceeds agrees with BigInt comparison and fails closed on garbage", () => {
  fc.assert(
    fc.property(arbAmount, arbAmount, (a, b) => {
      return amountExceeds(a, b) === (BigInt(a) > BigInt(b));
    }),
    FC_RUNS,
  );
  fc.assert(
    fc.property(
      fc.string().filter((s) => {
        try {
          BigInt(s);
          return false;
        } catch {
          return true;
        }
      }),
      arbAmount,
      (garbage, max) => amountExceeds(garbage, max) === true,
    ),
    FC_RUNS,
  );
});

Deno.test("property: URL policy — https always passes, http only for localhost+allowInsecure", () => {
  const g = (allowInsecure: boolean) =>
    ({
      secretKey: "sk_test_x",
      allowInsecure,
    }) as unknown as Parameters<typeof assertUrlPolicy>[0];
  fc.assert(
    fc.property(
      // The regex can emit hosts new URL rejects (invalid IDN like
      // `xn--0.aa`, leading/trailing-hyphen labels, empty labels). Those are
      // out of scope for the POLICY test — filter to hosts that form a valid
      // URL so a parse error can't masquerade as a policy failure (surfaced
      // only at ~1k+ generated cases, i.e. the nightly soak).
      fc.stringMatching(/^[a-z0-9.-]{1,30}\.[a-z]{2,6}$/).filter((h) => {
        try {
          new URL(`https://${h}/x`);
          return true;
        } catch {
          return false;
        }
      }),
      fc.boolean(),
      (host, allowInsecure) => {
        // https: always accepted
        assertUrlPolicy(g(allowInsecure), `https://${host}/x`);
        // http on a public host: always rejected
        try {
          assertUrlPolicy(g(allowInsecure), `http://${host}/x`);
          return host === "localhost"; // only acceptable escape
        } catch {
          return true;
        }
      },
    ),
    FC_RUNS,
  );
  // localhost http hinges exactly on the allowInsecure flag
  assertUrlPolicy(g(true), "http://localhost:4242/x");
  try {
    assertUrlPolicy(g(false), "http://localhost:4242/x");
    assert(false, "http://localhost must be rejected without allowInsecure");
  } catch {
    // expected
  }
});

// ---------------------------------------------------------------------------
// Layer 2: mppx codec invariants over generated inputs
// ---------------------------------------------------------------------------

Deno.test("property: challenge serialize/deserialize round-trips for generated params", () => {
  fc.assert(
    fc.property(arbChallengeParams, (params) => {
      const ch = Challenge.from({ ...params, secretKey: SERVER_SECRET });
      const back = Challenge.deserialize(Challenge.serialize(ch));
      return back.id === ch.id && back.method === ch.method &&
        back.intent === ch.intent && back.realm === ch.realm &&
        JSON.stringify(back.request) === JSON.stringify(ch.request);
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: HMAC binding — genuine verifies, any amount/realm/method mutation fails", () => {
  fc.assert(
    fc.property(
      arbChallengeParams,
      fc.constantFrom("amount", "realm", "method"),
      (params, field) => {
        const ch = Challenge.from({ ...params, secretKey: SERVER_SECRET });
        if (!Challenge.verify(ch, { secretKey: SERVER_SECRET })) return false;

        const mutated = field === "amount"
          ? {
            ...ch,
            request: {
              ...(ch.request as Record<string, unknown>),
              amount: params.request.amount + "9",
            },
          }
          : field === "realm"
          ? { ...ch, realm: ch.realm + "x" }
          : { ...ch, method: ch.method + "x" };
        return !Challenge.verify(mutated, { secretKey: SERVER_SECRET });
      },
    ),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: credential round-trips arbitrary spt/externalId payloads", () => {
  fc.assert(
    fc.property(
      arbChallengeParams,
      arbSptId,
      fc.option(fc.stringMatching(/^[A-Za-z0-9._-]{1,40}$/), {
        nil: undefined,
      }),
      (params, spt, externalId) => {
        const ch = Challenge.from({ ...params, secretKey: SERVER_SECRET });
        const wire = Credential.serialize(Credential.from({
          challenge: ch,
          payload: { spt, ...(externalId ? { externalId } : {}) },
        }));
        if (!/^Payment [A-Za-z0-9_-]+$/.test(wire)) return false;
        const back = Credential.deserialize<
          { spt: string; externalId?: string }
        >(wire);
        return back.payload.spt === spt &&
          back.payload.externalId === externalId &&
          back.challenge.id === ch.id;
      },
    ),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: receipt round-trips arbitrary references and timestamps", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^pi_[A-Za-z0-9]{4,30}$/),
      fc.date({
        min: new Date("2020-01-01"),
        max: new Date("2100-01-01"),
        noInvalidDate: true,
      }),
      (reference, date) => {
        const r = Receipt.from({
          method: "stripe",
          reference,
          status: "success",
          timestamp: date.toISOString(),
        });
        const back = Receipt.deserialize(Receipt.serialize(r));
        return back.reference === reference &&
          back.timestamp === date.toISOString() && back.status === "success";
      },
    ),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: full loop — challenge emitted by one side parses and verifies on the other", () => {
  fc.assert(
    fc.property(arbChallengeParams, (params) => {
      const ch = Challenge.from({ ...params, secretKey: SERVER_SECRET });
      const parsedList = Challenge.fromHeadersList(
        new Headers({ "WWW-Authenticate": Challenge.serialize(ch) }),
      );
      assertEquals(parsedList.length, 1);
      return Challenge.verify(parsedList[0], { secretKey: SERVER_SECRET });
    }),
    { numRuns: NIGHT(100) },
  );
});
