/**
 * Property-based tests for the MODEL-LEVEL invariants (as opposed to the pure
 * helpers / codecs in stripe_mpp_property_test.ts). Each property is quantified
 * over generated inputs and subsumes a cluster of the example tests: instead of
 * "a $50 challenge over a $10 cap blocks", it asserts "for ALL challenge/guard
 * combinations, the credential is sent IFF every guard passes".
 *
 * All Stripe/mppx traffic is stubbed; the model methods are driven exactly as
 * the swamp runtime drives them (arguments.parse â execute).
 */
import fc from "npm:fast-check@4.8.0";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.5";
import {
  assertUrlPolicy,
  hostCategory,
  idemKey,
  isCanonicalMinorUnits,
  model,
} from "./stripe_mpp.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);

const SERVER_SECRET = "0123456789abcdef0123456789abcdef";
const PROFILE = "profile_test_seller";
const ATTACKER = "profile_test_attacker";
const REALM = "honest.example.test";
const RUNS = { numRuns: NIGHT(200) };

const BASE_ARGS = {
  secretKey: "sk_test_stub_secret_key_do_not_log",
  serverSecret: SERVER_SECRET,
  networkId: PROFILE,
  realm: REALM,
  testMode: true,
  allowInsecure: true, // stubbed fetch + .test host â skip DNS guard
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };
function makeCtx(overrides: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { ...BASE_ARGS, ...overrides },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const m = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  return m.execute(m.arguments.parse(args), ctx);
}

type Router = (req: Request) => Response | undefined;
async function withStub<T>(
  routes: Router[],
  fn: (calls: Request[]) => Promise<T>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
  }) as typeof globalThis.fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const CANON = /^(0|[1-9][0-9]*)$/;
const arbCanon = fc.bigInt({ min: 0n, max: 9_999_999_999n }).map(String);
const arbCanonPos = fc.bigInt({ min: 1n, max: 9_999_999_999n }).map(String);
const arbNonCanon = fc.constantFrom(
  "-5",
  "1e3",
  "10.00",
  " 5 ",
  "0x1f",
  "5,0",
  "Ù¥Ù Ù ",
  "+7",
  "007",
  "",
);

// ===========================================================================
// Amount discipline
// ===========================================================================

Deno.test("prop: isCanonicalMinorUnits â /^(0|[1-9][0-9]*)$/ over arbitrary strings", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        arbCanon,
        arbNonCanon,
        fc.string(),
        fc.string({ unit: "grapheme" }),
      ),
      (s) => isCanonicalMinorUnits(s) === CANON.test(s),
    ),
    RUNS,
  );
});

Deno.test("prop: every money-input method rejects EVERY non-canonical amount", async () => {
  const attempts: Array<(a: string) => Promise<unknown>> = [
    (a) =>
      run("createChallenge", { amount: a, currency: "usd" }, makeCtx().ctx),
    (a) =>
      run(
        "chargeToken",
        { sptId: "spt_x", amount: a, currency: "usd" },
        makeCtx().ctx,
      ),
    (a) =>
      run("mintToken", {
        paymentMethodId: "pm_x",
        maxAmount: a,
        currency: "usd",
      }, makeCtx().ctx),
    (a) =>
      run(
        "createTestGrantedToken",
        { maxAmount: a, currency: "usd" },
        makeCtx().ctx,
      ),
    (a) => run("refundCharge", { chargeId: "pi_x", amount: a }, makeCtx().ctx),
  ];
  await fc.assert(
    fc.asyncProperty(arbNonCanon, async (a) => {
      for (const attempt of attempts) {
        let threw = false;
        try {
          await withStub([], () => attempt(a));
        } catch {
          threw = true;
        }
        if (!threw) return false; // a non-canonical amount slipped past a guard
      }
      return true;
    }),
    { numRuns: NIGHT(40) },
  );
});

// ===========================================================================
// Buyer spend guard â the combinatorial centerpiece
// ===========================================================================

Deno.test("prop: pay sends the credential IFF every guard passes, and always persists exactly one payment", async () => {
  const receiptWire = Receipt.serialize(Receipt.from({
    method: "stripe",
    reference: "pi_ok",
    status: "success",
    timestamp: "2026-07-04T00:00:00.000Z",
  }));
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        chAmount: fc.oneof(arbCanon, arbNonCanon),
        chCurrency: fc.constantFrom("usd", "eur", "jpy"),
        chNetwork: fc.constantFrom(PROFILE, ATTACKER),
        chRealm: fc.constantFrom(REALM, "attacker.test"),
        maxAmount: arbCanonPos,
        expCurrency: fc.constantFrom("usd", "eur", "jpy"),
        expNetwork: fc.option(fc.constantFrom(PROFILE, ATTACKER), {
          nil: undefined,
        }),
        expRealm: fc.option(fc.constantFrom(REALM, "attacker.test"), {
          nil: undefined,
        }),
      }),
      async (t) => {
        const challenge = Challenge.from({
          realm: t.chRealm,
          method: "stripe",
          intent: "charge",
          request: {
            amount: t.chAmount,
            currency: t.chCurrency,
            methodDetails: {
              networkId: t.chNetwork,
              paymentMethodTypes: ["card"],
            },
          },
          secretKey: "attacker-secret-32-bytes-padding!",
        });
        const canon = CANON.test(t.chAmount);
        const shouldSend = canon &&
          BigInt(t.chAmount) <= BigInt(t.maxAmount) &&
          t.chCurrency.toLowerCase() === t.expCurrency.toLowerCase() &&
          (t.expNetwork === undefined || t.chNetwork === t.expNetwork) &&
          (t.expRealm === undefined || t.chRealm === t.expRealm);

        const { ctx, written } = makeCtx();
        const sent = await withStub([
          (req) =>
            req.headers.has("Authorization")
              ? json({ ok: true }, 200)
              : new Response("{}", {
                status: 402,
                headers: {
                  "WWW-Authenticate": Challenge.serialize(challenge),
                  "Payment-Receipt": receiptWire,
                },
              }),
        ], async (calls) => {
          try {
            await run("pay", {
              url: `https://${REALM}/paid`,
              sptId: "spt_x",
              maxAmount: t.maxAmount,
              currency: t.expCurrency,
              ...(t.expNetwork ? { expectedNetworkId: t.expNetwork } : {}),
              ...(t.expRealm ? { expectedRealm: t.expRealm } : {}),
            }, ctx);
          } catch { /* blocked/failed â expected when !shouldSend */ }
          return calls.some((c) => c.headers.has("Authorization"));
        });

        // Core invariant: credential leaves the process IFF all guards pass.
        if (sent !== shouldSend) return false;
        // Audit invariant: exactly one payment resource, valid outcome enum.
        const pays = written.filter((w) => w.spec === "payment");
        if (pays.length !== 1) return false;
        const outcome = pays[0].payload.outcome;
        if (shouldSend) return outcome === "success";
        return outcome === "blocked";
      },
    ),
    { numRuns: NIGHT(250) },
  );
});

// ===========================================================================
// Seller: createChallenge â verifyCredential round-trip + single-field tamper
// ===========================================================================

Deno.test("prop: a genuine credential verifies; any single-field tamper fails; verifyCredential never throws", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        amount: arbCanonPos,
        currency: fc.constantFrom("usd", "eur"),
        scope: fc.option(fc.stringMatching(/^\/[a-z]{1,8}$/), {
          nil: undefined,
        }),
        tamper: fc.constantFrom(
          "none",
          "amount",
          "method",
          "realm",
          "scope",
          "expired",
        ),
      }),
      async (t) => {
        // Seller mints a real challenge.
        const seller = makeCtx();
        await run("createChallenge", {
          amount: t.amount,
          currency: t.currency,
          ...(t.scope ? { scope: t.scope } : {}),
          ...(t.tamper === "expired" ? { expiresInSeconds: 1 } : {}),
        }, seller.ctx);
        const www = seller.written.find((w) => w.spec === "challengeSpec")!
          .payload.wwwAuthenticate as string;
        let ch = Challenge.fromHeaders(
          new Headers({ "WWW-Authenticate": www }),
        );

        if (t.tamper === "expired") {
          // Re-mint with a definitely-past expiry, HMAC-valid.
          ch = Challenge.from({
            realm: REALM,
            method: "stripe",
            intent: "charge",
            expires: "2000-01-01T00:00:00.000Z",
            request: ch.request as Record<string, unknown>,
            secretKey: SERVER_SECRET,
          });
        } else if (t.tamper !== "none") {
          const req = ch.request as Record<string, unknown>;
          const details = req.methodDetails as Record<string, unknown>;
          ch = {
            ...ch,
            ...(t.tamper === "method" ? { method: "tempo" } : {}),
            ...(t.tamper === "realm" ? { realm: "evil.test" } : {}),
            request: t.tamper === "amount"
              ? { ...req, amount: t.amount + "9" }
              : t.tamper === "scope"
              ? {
                ...req,
                methodDetails: { ...details, metadata: { scope: "/evil" } },
              }
              : req,
          } as typeof ch;
        }

        const credential = Credential.serialize(
          Credential.from({ challenge: ch, payload: { spt: "spt_x" } }),
        );
        const { ctx, written } = makeCtx();
        // Never throws, regardless of tamper.
        await run("verifyCredential", {
          authorizationHeader: credential,
          ...(t.scope && t.tamper !== "scope"
            ? { expectedScope: t.scope }
            : {}),
          ...(t.tamper === "scope" && t.scope
            ? { expectedScope: t.scope }
            : {}),
        }, ctx);
        const verdict = written.find((w) => w.spec === "credential")!;
        const expectValid = t.tamper === "none";
        return verdict.payload.valid === expectValid;
      },
    ),
    { numRuns: NIGHT(150) },
  );
});

// ===========================================================================
// Seller: chargeToken succeeded-gate
// ===========================================================================

Deno.test("prop: chargeToken success â PaymentIntent status==succeeded; always persists a charge", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(
        "succeeded",
        "requires_action",
        "processing",
        "requires_payment_method",
        "canceled",
      ),
      arbCanonPos,
      async (status, amount) => {
        const { ctx, written } = makeCtx();
        let threw = false;
        await withStub([
          (req) =>
            req.url.includes("/v1/payment_intents")
              ? json({
                id: "pi_x",
                status,
                amount: Number(amount),
                currency: "usd",
              })
              : undefined,
        ], async () => {
          try {
            await run("chargeToken", {
              sptId: "spt_g",
              amount,
              currency: "usd",
            }, ctx);
          } catch {
            threw = true;
          }
        });
        const charge = written.find((w) => w.spec === "charge");
        if (!charge) return false; // must persist on every outcome
        const succeeded = status === "succeeded";
        return charge.payload.outcome === (succeeded ? "success" : "failed") &&
          threw === !succeeded;
      },
    ),
    { numRuns: NIGHT(120) },
  );
});

// ===========================================================================
// Seller: refundCharge ceiling (read-before-destructive)
// ===========================================================================

Deno.test("prop: refundCharge issues a POST IFF succeeded â§ canonical â§ amount â¤ remaining", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        received: fc.integer({ min: 1, max: 100000 }),
        alreadyRefunded: fc.integer({ min: 0, max: 100000 }),
        amount: arbCanonPos,
        status: fc.constantFrom("succeeded", "processing", "canceled"),
      }),
      async (t) => {
        const alreadyRefunded = Math.min(t.alreadyRefunded, t.received);
        const remaining = t.received - alreadyRefunded;
        const { ctx } = makeCtx();
        const posted = await withStub([
          (req) => {
            if (req.url.includes("/v1/payment_intents/pi_r")) {
              return json({
                id: "pi_r",
                status: t.status,
                amount: t.received,
                amount_received: t.received,
                currency: "usd",
                latest_charge: { id: "ch", amount_refunded: alreadyRefunded },
              });
            }
            if (req.url.includes("/v1/refunds") && req.method === "POST") {
              return json({
                id: "re_1",
                status: "succeeded",
                amount: Number(t.amount),
              });
            }
            return undefined;
          },
        ], async (calls) => {
          try {
            await run(
              "refundCharge",
              { chargeId: "pi_r", amount: t.amount },
              ctx,
            );
          } catch { /* blocked */ }
          return calls.some((c) =>
            c.url.includes("/v1/refunds") && c.method === "POST"
          );
        });
        const shouldPost = t.status === "succeeded" &&
          BigInt(t.amount) <= BigInt(remaining);
        return posted === shouldPost;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

// ===========================================================================
// SSRF: hostCategory reference-equivalence + policy over generated IPv4
// ===========================================================================

function refCategory(o: number[]): string {
  if (o[0] === 127 || o[0] === 0) return "loopback";
  if (o[0] === 169 && o[1] === 254) return "metadata";
  if (o[0] === 10) return "private";
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private";
  if (o[0] === 192 && o[1] === 168) return "private";
  return "public";
}

Deno.test("prop: hostCategory classifies dotted = decimal = hex IPv4 identically and matches the reference ranges", () => {
  fc.assert(
    fc.property(
      fc.tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      ),
      (o) => {
        const dotted = o.join(".");
        const int = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
        const hex = "0x" + int.toString(16);
        const want = refCategory(o);
        return hostCategory(dotted) === want &&
          hostCategory(String(int)) === want &&
          hostCategory(hex) === want;
      },
    ),
    RUNS,
  );
});

Deno.test("prop: assertUrlPolicy blocks an IPv4 host IFF it is non-public (allowInsecure=false)", () => {
  const g = {
    secretKey: "sk_test_x",
    allowInsecure: false,
  } as unknown as Parameters<typeof assertUrlPolicy>[0];
  fc.assert(
    fc.property(
      fc.tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 254 }),
      ),
      (o) => {
        const url = `https://${o.join(".")}/x`;
        const isPublic = refCategory(o) === "public";
        let threw = false;
        try {
          assertUrlPolicy(g, url);
        } catch {
          threw = true;
        }
        return threw === !isPublic;
      },
    ),
    RUNS,
  );
});

// ===========================================================================
// Idempotency: key stays within Stripe's 255-char limit for realistic inputs
// ===========================================================================

Deno.test("prop: idemKey is always within Stripe's 255-char Idempotency-Key limit", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("charge", "refund", "mint"),
      fc.array(fc.option(fc.string({ maxLength: 300 }), { nil: undefined }), {
        maxLength: 5,
      }),
      async (op, parts) => {
        const key = await idemKey(op, parts);
        return key.length <= 255 && key.length > 0;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});
