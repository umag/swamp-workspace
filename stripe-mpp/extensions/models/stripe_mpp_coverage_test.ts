/**
 * Coverage tests closing gaps found in test review round 1 — every guard /
 * branch here previously had no regression test (a reviewer could delete the
 * guard and the suite would stay green). Grouped by the finding that motivated
 * each block.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.6";
import { idemKey, model } from "./stripe_mpp.ts";

const SERVER_SECRET = "0123456789abcdef0123456789abcdef";
const PROFILE = "profile_test_seller";
const GLOBAL_ARGS = {
  secretKey: "sk_test_stub_secret_key_do_not_log",
  serverSecret: SERVER_SECRET,
  networkId: PROFILE,
  realm: "honest.example.test",
  testMode: true,
  allowInsecure: true, // stubbed fetch + reserved .test host → skip DNS guard
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };
function makeCtx(overrides: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { ...GLOBAL_ARGS, ...overrides },
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
type Route = (req: Request) => Response | undefined;
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
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
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function stripeChallenge(
  opts: { amount?: string; currency?: string; realm?: string; method?: string },
) {
  return Challenge.from({
    realm: opts.realm ?? GLOBAL_ARGS.realm,
    method: opts.method ?? "stripe",
    intent: "charge",
    request: {
      amount: opts.amount ?? "500",
      currency: opts.currency ?? "usd",
      ...(opts.method && opts.method !== "stripe" ? { recipient: "0xr" } : {
        methodDetails: { networkId: PROFILE, paymentMethodTypes: ["card"] },
      }),
    },
    secretKey: SERVER_SECRET,
  });
}
const cred = (ch: ReturnType<typeof Challenge.from>, spt = "spt_x") =>
  Credential.serialize(Credential.from({ challenge: ch, payload: { spt } }));

// --- Finding: expectedRealm spend-guard untested -------------------------

Deno.test("pay: expectedRealm mismatch blocks and never sends the credential", async () => {
  const { ctx, written } = makeCtx();
  const hostile = () =>
    new Response("{}", {
      status: 402,
      headers: {
        "WWW-Authenticate": Challenge.serialize(
          stripeChallenge({ realm: "attacker.test" }),
        ),
      },
    });
  await withFetchStub([hostile], async (calls) => {
    await assertRejects(
      () =>
        run("pay", {
          url: "https://honest.example.test/paid",
          sptId: "spt_x",
          maxAmount: "1000",
          currency: "usd",
          expectedRealm: "honest.example.test",
        }, ctx),
      Error,
      "realm",
    );
    assert(!calls.some((c) => c.headers.has("Authorization")));
  });
  assertEquals(
    written.find((w) => w.spec === "payment")?.payload.outcome,
    "blocked",
  );
});

// --- Finding: refundCharge canonical + succeeded gates untested ----------

Deno.test("refundCharge: non-canonical amount is blocked before any refund POST", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => undefined], async (calls) => {
    await assertRejects(
      () => run("refundCharge", { chargeId: "pi_1", amount: "10.00" }, ctx),
      Error,
      "canonical",
    );
    assertEquals(calls.length, 0, "no PI read or refund POST for a bad amount");
  });
  assertEquals(
    written.find((w) => w.spec === "refund")?.payload.outcome,
    "blocked",
  );
});

Deno.test("refundCharge: a non-succeeded PaymentIntent is blocked (no refund POST)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/payment_intents/pi_pending")
        ? json({ id: "pi_pending", status: "processing", amount: 1000 })
        : undefined,
  ], async (calls) => {
    await assertRejects(
      () => run("refundCharge", { chargeId: "pi_pending", amount: "100" }, ctx),
      Error,
      "succeeded",
    );
    assert(
      !calls.some((c) => c.url.includes("/v1/refunds") && c.method === "POST"),
      "no refund issued against a non-succeeded charge",
    );
  });
  assertEquals(
    written.find((w) => w.spec === "refund")?.payload.outcome,
    "blocked",
  );
});

// --- Finding: verifyCredential wrong-method + price-mismatch untested ----

Deno.test("verifyCredential: a non-stripe method credential is rejected (wrong method)", async () => {
  const { ctx, written } = makeCtx();
  await run(
    "verifyCredential",
    { authorizationHeader: cred(stripeChallenge({ method: "tempo" })) },
    ctx,
  );
  const v = written.find((w) => w.spec === "credential")!;
  assertEquals(v.payload.valid, false);
  assertEquals(v.payload.reason, "wrong method");
});

Deno.test("verifyCredential: expectedAmount / expectedCurrency mismatch → valid=false", async () => {
  const { ctx, written } = makeCtx();
  const good = cred(stripeChallenge({ amount: "500", currency: "usd" }));
  await run("verifyCredential", {
    authorizationHeader: good,
    expectedAmount: "999",
  }, ctx);
  assertEquals(written.at(-1)!.payload.reason, "amount mismatch");
  await run("verifyCredential", {
    authorizationHeader: good,
    expectedCurrency: "eur",
  }, ctx);
  assertEquals(written.at(-1)!.payload.reason, "currency mismatch");
});

// --- Finding: sensitiveOutput / sensitive-meta unasserted ----------------

Deno.test("secrets are marked sensitive: sensitiveOutput on token methods, sensitive meta on secret args", () => {
  const methods = model.methods as Record<
    string,
    { sensitiveOutput?: boolean }
  >;
  for (const m of ["mintToken", "getIssuedToken", "createTestGrantedToken"]) {
    assertEquals(
      methods[m].sensitiveOutput,
      true,
      `${m} must be sensitiveOutput`,
    );
  }
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  for (const field of ["secretKey", "serverSecret"]) {
    const meta = z.globalRegistry.get(shape[field]) as
      | { sensitive?: boolean }
      | undefined;
    assertEquals(meta?.sensitive, true, `${field} must be sensitive`);
  }
});

// --- Finding: 2xx unauthenticated-receipt trust boundary undocumented ----

Deno.test("receipts are UNAUTHENTICATED: a 2xx server can stamp an arbitrary reference into the audit trail", async () => {
  // Not a vulnerability per the MPP spec (receipts are display-only; trust is
  // the TLS channel) — this test pins the boundary so a future change that
  // treats the receipt as proof is caught.
  const { ctx, written } = makeCtx();
  const ch = stripeChallenge({ amount: "500", currency: "usd" });
  // A hostile-but-delivering server produces a genuine-format receipt whose
  // reference it chose — mppx will decode it with no authenticity check.
  const forgedReceipt = Receipt.serialize(Receipt.from({
    method: "stripe",
    reference: "pi_ATTACKER_CONTROLLED",
    status: "success",
    timestamp: "2026-07-04T00:00:00.000Z",
  }));
  await withFetchStub([
    (req) =>
      req.headers.has("Authorization")
        ? new Response(JSON.stringify({ data: "x" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Payment-Receipt": forgedReceipt,
          },
        })
        : new Response("{}", {
          status: 402,
          headers: { "WWW-Authenticate": Challenge.serialize(ch) },
        }),
  ], async () => {
    await run("pay", {
      url: "https://honest.example.test/paid",
      sptId: "spt_x",
      maxAmount: "1000",
      currency: "usd",
    }, ctx);
  });
  const attempt = written.find((w) => w.spec === "payment")!;
  assertEquals(attempt.payload.outcome, "success");
  // The reference is whatever the server said — the model does not (and per
  // spec cannot) authenticate it. Documented boundary.
  assertEquals(
    (attempt.payload.receipt as Record<string, unknown>).reference,
    "pi_ATTACKER_CONTROLLED",
  );
});

// --- Finding: idempotency challenge-id anchor (charge) --------------------

Deno.test("chargeToken idempotency: distinct challenges for the same amount+token get distinct keys", async () => {
  // Two different challenges (unique HMAC ids) settling the same spt+amount
  // must NOT collide — the fix for the silent-charge-suppression bug.
  const a = await idemKey("charge", ["chal_A", undefined, "spt_1", "500"]);
  const b = await idemKey("charge", ["chal_B", undefined, "spt_1", "500"]);
  assert(a !== b, "distinct challenge ids anchor distinct idempotency keys");
});

// --- Finding: untested methods (getCharge, revokeToken, listCharges, live) ---

Deno.test("revokeToken: revokes and records the token", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/revoke")
        ? json({ id: "spt_r", status: "deactivated" })
        : undefined,
  ], async () => {
    await run("revokeToken", { sptId: "spt_r" }, ctx);
  });
  assertEquals(
    written.find((w) => w.spec === "issuedToken")?.payload.status,
    "deactivated",
  );
});

Deno.test("getCharge: retrieves and classifies a PaymentIntent", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/payment_intents/pi_g")
        ? json({
          id: "pi_g",
          status: "succeeded",
          amount: 1500,
          currency: "usd",
        })
        : undefined,
  ], async () => {
    await run("getCharge", { chargeId: "pi_g" }, ctx);
  });
  const c = written.find((w) => w.spec === "charge")!;
  assertEquals(c.payload.outcome, "success");
  assertEquals(c.payload.piId, "pi_g");
});

Deno.test("listCharges: paginates via created range and writes one charge per item plus a summary", async () => {
  const { ctx, written } = makeCtx();
  let page = 0;
  await withFetchStub([
    (req) => {
      if (!req.url.includes("/v1/payment_intents")) return undefined;
      page++;
      return page === 1
        ? json({
          data: [
            { id: "pi_1", status: "succeeded", amount: 100, currency: "usd" },
            { id: "pi_2", status: "succeeded", amount: 200, currency: "usd" },
          ],
          has_more: true,
        })
        : json({
          data: [{
            id: "pi_3",
            status: "canceled",
            amount: 300,
            currency: "usd",
          }],
          has_more: false,
        });
    },
  ], async () => {
    await run("listCharges", { pageSize: 2, maxResults: 100 }, ctx);
  });
  const charges = written.filter((w) => w.spec === "charge");
  assertEquals(
    charges.length,
    3,
    "one resource per PaymentIntent across pages",
  );
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 3);
  assertEquals((summary.payload.ids as string[]).length, 3);
});

Deno.test("createTestGrantedToken: refuses a live key even in testMode", async () => {
  const { ctx } = makeCtx({ testMode: true, secretKey: "sk_live_realkey" });
  await assertRejects(
    () =>
      run(
        "createTestGrantedToken",
        { maxAmount: "1000", currency: "usd" },
        ctx,
      ),
    Error,
    "test mode",
  );
});

// --- Code-review findings: mint spend-control + audit integrity ----------

Deno.test("mintToken: refuses a non-canonical maxAmount (no uncapped SPT)", async () => {
  const { ctx } = makeCtx();
  for (const bad of ["10.50", "abc", "1e3", "-5"]) {
    await assertRejects(
      () =>
        run("mintToken", {
          paymentMethodId: "pm_x",
          maxAmount: bad,
          currency: "usd",
        }, ctx),
      Error,
      "canonical",
    );
  }
});

Deno.test("createTestGrantedToken: refuses a non-canonical maxAmount", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      run(
        "createTestGrantedToken",
        { maxAmount: "10.5", currency: "usd" },
        ctx,
      ),
    Error,
    "canonical",
  );
});

Deno.test("mintToken: requires a seller network profile", async () => {
  const { ctx } = makeCtx({ networkId: undefined });
  await assertRejects(
    () =>
      run("mintToken", {
        paymentMethodId: "pm_x",
        maxAmount: "1000",
        currency: "usd",
      }, ctx),
    Error,
    "network profile",
  );
});

Deno.test("listCharges: reports truncated=true when the server has more but the cap is hit", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/payment_intents")
        ? json({
          data: [
            { id: "pi_1", status: "succeeded", amount: 1, currency: "usd" },
            { id: "pi_2", status: "succeeded", amount: 2, currency: "usd" },
          ],
          has_more: true, // server still has more beyond our cap
        })
        : undefined,
  ], async () => {
    await run("listCharges", { maxResults: 2, pageSize: 2 }, ctx);
  });
  assertEquals(
    written.find((w) => w.spec === "summary")?.payload.truncated,
    true,
  );
});

Deno.test("refundCharge: a second partial refund does not overwrite the first audit record", async () => {
  const { ctx, written } = makeCtx();
  const pi = {
    id: "pi_multi",
    status: "succeeded",
    amount: 1000,
    amount_received: 1000,
    currency: "usd",
    latest_charge: { id: "ch", amount_refunded: 0 },
  };
  let n = 0;
  await withFetchStub([
    (req) => {
      if (req.url.includes("/v1/payment_intents/pi_multi")) return json(pi);
      if (req.url.includes("/v1/refunds") && req.method === "POST") {
        n++;
        return json({ id: `re_${n}`, status: "succeeded", amount: 100 });
      }
      return undefined;
    },
  ], async () => {
    await run("refundCharge", {
      chargeId: "pi_multi",
      amount: "100",
      externalId: "r1",
    }, ctx);
    await run("refundCharge", {
      chargeId: "pi_multi",
      amount: "100",
      externalId: "r2",
    }, ctx);
  });
  const refunds = written.filter((w) => w.spec === "refund");
  const names = new Set(refunds.map((r) => r.name));
  assertEquals(names.size, 2, "two distinct refund audit records");
});

Deno.test("getGrantedToken is marked sensitiveOutput (persists the token id)", () => {
  const methods = model.methods as Record<
    string,
    { sensitiveOutput?: boolean }
  >;
  assertEquals(methods.getGrantedToken.sensitiveOutput, true);
});

// --- Code-review findings: chargeToken params + redaction + payment audit --

Deno.test("chargeToken: settle params include automatic_payment_methods{allow_redirects:never} + the granted token", async () => {
  const { ctx } = makeCtx();
  let body: Record<string, unknown> | undefined;
  await withFetchStub([
    (req) => {
      if (!req.url.includes("/v1/payment_intents")) return undefined;
      // Stripe SDK form-encodes the body; assert the key/value pairs are present.
      body = { url: req.url };
      return json({
        id: "pi_apm",
        status: "succeeded",
        amount: 500,
        currency: "usd",
      });
    },
  ], async (calls) => {
    await run("chargeToken", {
      sptId: "spt_g",
      amount: "500",
      currency: "usd",
    }, ctx);
    const sent = await calls[0].text();
    assert(
      sent.includes("automatic_payment_methods") &&
        sent.includes("allow_redirects") && sent.includes("never"),
      "headless settle must set automatic_payment_methods.allow_redirects=never",
    );
    assert(
      sent.includes("shared_payment_granted_token"),
      "the SPT must be sent as payment_method_data[shared_payment_granted_token]",
    );
  });
  assert(body, "the payment_intents call was made");
});

Deno.test("chargeToken: a malformed authorizationHeader throws a wrapped, redacted error", async () => {
  const { ctx } = makeCtx();
  const err = await assertRejects(
    () =>
      run("chargeToken", {
        authorizationHeader: "Payment not-valid-base64url!!" +
          GLOBAL_ARGS.secretKey,
      }, ctx),
    Error,
    "Malformed authorizationHeader",
  );
  assert(
    !String(err).includes(GLOBAL_ARGS.secretKey),
    "the wrapped parse error must not leak the secret key",
  );
});

Deno.test("pay: repeated payments to the same URL keep distinct audit records", async () => {
  const { ctx, written } = makeCtx();
  const ch = stripeChallenge({ amount: "100", currency: "usd" });
  const receipt = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });
  const server = (req: Request) =>
    req.headers.has("Authorization") ? receipt() : new Response("{}", {
      status: 402,
      headers: { "WWW-Authenticate": Challenge.serialize(ch) },
    });
  await withFetchStub([server], async () => {
    await run("pay", {
      url: "https://honest.example.test/meter",
      sptId: "spt_x",
      maxAmount: "1000",
      currency: "usd",
      externalId: "call-1",
    }, ctx);
    await run("pay", {
      url: "https://honest.example.test/meter",
      sptId: "spt_x",
      maxAmount: "1000",
      currency: "usd",
      externalId: "call-2",
    }, ctx);
  });
  const names = new Set(
    written.filter((w) => w.spec === "payment").map((w) => w.name),
  );
  assertEquals(
    names.size,
    2,
    "two distinct payment audit records, not overwritten",
  );
});

// --- Doc-research finding: test-helper granted token requires payment_method -

Deno.test("createTestGrantedToken: sends the required payment_method to the test helper", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/test_helpers/shared_payment/granted_tokens")
        ? json({
          id: "spt_test",
          usage_limits: { currency: "usd", max_amount: 1000 },
        })
        : undefined,
  ], async (calls) => {
    await run(
      "createTestGrantedToken",
      { maxAmount: "1000", currency: "usd" },
      ctx,
    );
    const body = await calls[0].text();
    assert(
      body.includes("payment_method") && body.includes("pm_card_visa"),
      "the test helper requires payment_method (default pm_card_visa)",
    );
  });
  assertEquals(
    written.find((w) => w.spec === "grantedToken")?.payload.id,
    "spt_test",
  );
});
