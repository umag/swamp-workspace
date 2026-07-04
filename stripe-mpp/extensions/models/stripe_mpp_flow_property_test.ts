/**
 * Property-based MUTATION tests over WHOLE flows.
 *
 * Each run generates a full buyerâseller interaction (seller emits a real
 * challenge via the model's createChallenge; the buyer pays via the model's
 * pay; the seller verifies and settles via verifyCredential/chargeToken â
 * all through the actual model methods) and injects ONE mutation drawn from
 * an adversarial catalog. The property: the flow terminates at the
 * documented rejection point for that mutation, and â the load-bearing
 * invariant â **a successful charge resource exists IFF the flow was
 * honest**. A guard rejection must also mean the credential never left the
 * buyer.
 *
 * Mutation catalog:
 *  - honest             â everything succeeds end-to-end, receipt decodes
 *  - amount-exceeds     â challenge demands more than maxAmount: buyer
 *                         blocks BEFORE sending the credential
 *  - currency-mismatch  â challenge in another currency: buyer blocks
 *  - credential-tamper  â MITM rewrites the price inside the credential:
 *                         seller HMAC verification rejects; settle refuses
 *  - expired-challenge  â HMAC-valid but expired challenge: verify rejects
 *  - settle-fails       â Stripe settles to a non-succeeded PaymentIntent:
 *                         chargeToken persists a failed charge and throws
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.5";
import { model } from "./stripe_mpp.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);

const SERVER_SECRET = "0123456789abcdef0123456789abcdef";

const GLOBAL_ARGS = {
  secretKey: "sk_test_stub_secret_key_do_not_log",
  serverSecret: SERVER_SECRET,
  networkId: "profile_test_fixture",
  realm: "flow.example.test",
  testMode: true,
  allowInsecure: true, // stubbed fetch + reserved .test host â skip DNS guard
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
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

function runMethod(
  name: string,
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<unknown> {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist`);
  return method.execute(method.arguments.parse(args), ctx);
}

type FlowRoute = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: FlowRoute[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`unrouted: ${req.method} ${req.url}`);
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const MUTATIONS = [
  "honest",
  "amount-exceeds",
  "currency-mismatch",
  "credential-tamper",
  "expired-challenge",
  "settle-fails",
] as const;
type Mutation = (typeof MUTATIONS)[number];

const arbFlowFields = fc.record({
  amount: fc.bigInt({ min: 1n, max: 9_999_999n }).map(String),
  currency: fc.constantFrom("usd", "eur", "gbp"),
  sptId: fc.stringMatching(/^spt_[A-Za-z0-9]{6,24}$/),
  externalId: fc.stringMatching(/^[A-Za-z0-9._-]{1,24}$/),
});

// ---------------------------------------------------------------------------
// The whole-flow property â driven as one test PER mutation so every mutation
// is exercised deterministically every run (not sampled probabilistically),
// while field values remain randomized within each.
// ---------------------------------------------------------------------------

for (const mutation of MUTATIONS) {
  Deno.test(`property: whole buyerâseller flow [${mutation}] â success IFF honest, rejected at its documented gate`, async () => {
    await fc.assert(
      fc.asyncProperty(arbFlowFields, async (fields) => {
        const { amount, currency, sptId, externalId } = fields;
        const resourceUrl = "https://flow.example.test/paid";

        // ------------------------------------------------------- seller setup
        // Real challenge material from the model itself.
        const seller = makeCtx();
        await runMethod("createChallenge", {
          amount,
          currency,
          externalId,
          expiresInSeconds: 600,
        }, seller.ctx);
        const spec = seller.written.find((w) => w.spec === "challengeSpec")!;
        let wwwAuthenticate = spec.payload.wwwAuthenticate as string;

        // Challenge-level mutations happen before the buyer ever sees it.
        if (mutation === "amount-exceeds") {
          // Seller (or MITM) demands 10Ã more than the buyer authorized.
          const inflated = seller.written.length && makeCtx();
          await runMethod("createChallenge", {
            amount: (BigInt(amount) * 10n + 1n).toString(),
            currency,
            externalId,
            expiresInSeconds: 600,
          }, (inflated as ReturnType<typeof makeCtx>).ctx);
          wwwAuthenticate = ((inflated as ReturnType<typeof makeCtx>).written
            .find((w) => w.spec === "challengeSpec")!.payload
            .wwwAuthenticate) as string;
        }
        if (mutation === "currency-mismatch") {
          const other = currency === "usd" ? "eur" : "usd";
          const swapped = makeCtx();
          await runMethod("createChallenge", {
            amount,
            currency: other,
            externalId,
            expiresInSeconds: 600,
          }, swapped.ctx);
          wwwAuthenticate = swapped.written
            .find((w) => w.spec === "challengeSpec")!.payload
            .wwwAuthenticate as string;
        }

        // --------------------------------------------------------- buyer pays
        const buyer = makeCtx();
        let capturedCredential: string | undefined;
        const receiptWire = Receipt.serialize(Receipt.from({
          method: "stripe",
          reference: "pi_flow_settled",
          status: "success",
          timestamp: "2026-07-03T00:00:00.000Z",
        }));

        await withFetchStub([
          (req) => {
            if (!req.url.startsWith(resourceUrl)) return undefined;
            const auth = req.headers.get("Authorization");
            if (!auth) {
              return new Response("{}", {
                status: 402,
                headers: {
                  "WWW-Authenticate": wwwAuthenticate,
                  "Content-Type": "application/problem+json",
                },
              });
            }
            capturedCredential = auth;
            return json({ data: "resource" }, 200, {
              "Payment-Receipt": receiptWire,
            });
          },
        ], async (calls) => {
          const payArgs = {
            url: resourceUrl,
            sptId,
            maxAmount: amount,
            currency,
            externalId,
          };
          if (
            mutation === "amount-exceeds" || mutation === "currency-mismatch"
          ) {
            await assertRejects(() => runMethod("pay", payArgs, buyer.ctx));
            // Guard invariant: the credential never left the buyer.
            assertEquals(capturedCredential, undefined);
            assert(
              !calls.some((c) => c.headers.has("Authorization")),
              "no credentialed request after a guard block",
            );
            const attempt = buyer.written.find((w) => w.spec === "payment");
            assertEquals(attempt?.payload.outcome, "blocked");
            return; // flow ends at the buyer gate
          }
          await runMethod("pay", payArgs, buyer.ctx);
          assertEquals(
            buyer.written.find((w) => w.spec === "payment")?.payload.outcome,
            "success",
          );
        });
        if (mutation === "amount-exceeds" || mutation === "currency-mismatch") {
          return true;
        }
        assert(capturedCredential, "seller captured the credential");
        let credentialForSeller = capturedCredential!;

        // ------------------------------------------------- in-transit attacks
        if (mutation === "credential-tamper") {
          const cred = Credential.deserialize<{ spt: string }>(
            credentialForSeller,
          );
          const req = cred.challenge.request as Record<string, unknown>;
          credentialForSeller = Credential.serialize(Credential.from({
            challenge: {
              ...cred.challenge,
              request: {
                ...req,
                // MITM lowers the price â must ALWAYS differ from the honest
                // amount (appending a digit guarantees a change even when the
                // generated amount is "1"), so the HMAC genuinely breaks.
                amount: "1" + String(req.amount),
              },
            },
            payload: cred.payload,
          }));
        }
        if (mutation === "expired-challenge") {
          // HMAC-valid but expired: signed with the same server secret.
          const expired = Challenge.from({
            realm: GLOBAL_ARGS.realm,
            method: "stripe",
            intent: "charge",
            expires: "2020-01-01T00:00:00.000Z",
            request: {
              amount,
              currency,
              methodDetails: {
                networkId: GLOBAL_ARGS.networkId,
                paymentMethodTypes: ["card", "link"],
              },
            },
            secretKey: SERVER_SECRET,
          });
          credentialForSeller = Credential.serialize(
            Credential.from({ challenge: expired, payload: { spt: sptId } }),
          );
        }

        // ------------------------------------------------- seller verifies
        const verify = makeCtx();
        await runMethod("verifyCredential", {
          authorizationHeader: credentialForSeller,
          expectedAmount: amount,
          expectedCurrency: currency,
        }, verify.ctx);
        const verdict = verify.written.find((w) => w.spec === "credential")!;
        if (
          mutation === "credential-tamper" || mutation === "expired-challenge"
        ) {
          assertEquals(
            verdict.payload.valid,
            false,
            `${mutation} must fail verify`,
          );
        } else {
          assertEquals(verdict.payload.valid, true);
        }

        // ------------------------------------------------- seller settles
        const settle = makeCtx();
        const piStatus = mutation === "settle-fails"
          ? "requires_action"
          : "succeeded";
        await withFetchStub([
          (req) =>
            req.url.includes("/v1/payment_intents")
              ? json({
                id: "pi_flow_settled",
                status: piStatus,
                amount: Number(amount),
                currency,
              })
              : undefined,
        ], async () => {
          const settleCall = () =>
            runMethod("chargeToken", {
              authorizationHeader: credentialForSeller,
            }, settle.ctx);
          if (mutation === "credential-tamper") {
            // HMAC gate refuses before any Stripe call.
            await assertRejects(settleCall, Error, "HMAC");
            return;
          }
          if (mutation === "expired-challenge") {
            // chargeToken has its own settle-side expiry gate â exercise it
            // (not just verifyCredential above).
            await assertRejects(settleCall, Error, "expired");
            return;
          }
          if (mutation === "settle-fails") {
            await assertRejects(settleCall, Error, "succeed");
            return;
          }
          await settleCall(); // honest
        });

        // ------------------------------------------- the load-bearing invariant
        const successfulCharges = settle.written.filter((w) =>
          w.spec === "charge" && w.payload.outcome === "success"
        );
        if (mutation === "honest") {
          assertEquals(successfulCharges.length, 1, "honest flow settles once");
          // And the receipt the buyer got decodes to the settled reference.
          const attempt = buyer.written.find((w) => w.spec === "payment")!;
          const receipt = attempt.payload.receipt as Record<string, unknown>;
          assertEquals(receipt.reference, "pi_flow_settled");
        } else {
          assertEquals(
            successfulCharges.length,
            0,
            `mutation ${mutation} must never produce a successful charge`,
          );
        }
        return true;
      }),
      { numRuns: NIGHT(10) },
    );
  });
}
