/**
 * Method-level tests for @magistr/stripe-mpp (buyer + seller application
 * services). All Stripe/network traffic is intercepted by stubbing
 * `globalThis.fetch` — the model's SDK factory uses
 * `Stripe.createFetchHttpClient()` so SDK calls route through fetch too.
 *
 * Invariants under test (from the approved plan v4):
 *  - pay: amount+currency spend guard BEFORE presenting the credential
 *  - pay: a `payment` resource is persisted on EVERY outcome
 *  - mintToken: status=requires_action surfaces as an actionable error
 *  - chargeToken/issueReceipt: success gated on PaymentIntent `succeeded`
 *  - refundCharge: read-before-destructive + remaining-refundable ceiling
 *  - redaction: no sk_/spt_ values in surfaced error messages
 *  - createTestGrantedToken: refuses live mode
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.12";
import { model } from "./stripe_mpp.ts";
import {
  _resetMcpTransport,
  _setMcpTransport,
  type McpRequest,
  type McpResponse,
} from "./lib/link_cli.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SERVER_SECRET = "0123456789abcdef0123456789abcdef";

const GLOBAL_ARGS = {
  secretKey: "sk_test_stub_secret_key_do_not_log",
  serverSecret: SERVER_SECRET,
  networkId: "profile_test_fixture",
  realm: "api.example.test",
  testMode: true,
  // Fetch is stubbed and hosts are reserved .test names; skip the real
  // DNS-resolution SSRF guard so functional tests stay deterministic/offline.
  allowInsecure: true,
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; count calls per URL. */
async function withFetchStub(
  routes: Route[],
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
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Build a spec-valid 402 response advertising a stripe charge challenge. */
function fixture402(amount = "1000", currency = "usd") {
  const challenge = Challenge.from({
    realm: "api.example.test",
    method: "stripe",
    intent: "charge",
    request: {
      amount,
      currency,
      methodDetails: {
        networkId: "profile_test_fixture",
        paymentMethodTypes: ["card", "link"],
      },
    },
    secretKey: SERVER_SECRET,
  });
  return {
    challenge,
    response: () =>
      new Response(
        JSON.stringify({
          type: "https://paymentauth.org/problems/payment-required",
          title: "Payment Required",
          status: 402,
        }),
        {
          status: 402,
          headers: {
            "Content-Type": "application/problem+json",
            "WWW-Authenticate": Challenge.serialize(challenge),
            "Cache-Control": "no-store",
          },
        },
      ),
  };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
  // Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
  // before execute is invoked.
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// Buyer: probe
// ---------------------------------------------------------------------------

Deno.test("probe: parses a 402 into a challenge resource", async () => {
  const { ctx, written } = makeCtx();
  const fx = fixture402();
  await withFetchStub([() => fx.response()], async () => {
    await run("probe", { url: "https://api.example.test/paid" }, ctx);
  });
  const res = written.find((w) => w.spec === "challenge");
  assert(res, "challenge resource written");
  assertEquals(res.payload.status, 402);
  const challenges = res.payload.challenges as Array<Record<string, unknown>>;
  assertEquals(challenges.length, 1);
  assertEquals(challenges[0].method, "stripe");
});

Deno.test("probe: non-402 is recorded without challenges", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ ok: true })], async () => {
    await run("probe", { url: "https://api.example.test/free" }, ctx);
  });
  const res = written.find((w) => w.spec === "challenge");
  assert(res);
  assertEquals(res.payload.status, 200);
  assertEquals((res.payload.challenges as unknown[]).length, 0);
});

Deno.test("probe: refuses plain http for non-localhost", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () => run("probe", { url: "http://api.example.test/paid" }, ctx),
    Error,
    "https",
  );
});

// ---------------------------------------------------------------------------
// Buyer: pay — spend guard + always-persisted attempt
// ---------------------------------------------------------------------------

Deno.test("pay: blocks when challenge amount exceeds maxAmount — attempt persisted, credential never sent", async () => {
  const { ctx, written } = makeCtx();
  const fx = fixture402("100000", "usd"); // 1000.00 usd demanded
  await withFetchStub([() => fx.response()], async (calls) => {
    await assertRejects(
      () =>
        run("pay", {
          url: "https://api.example.test/paid",
          sptId: "spt_test_fixture",
          maxAmount: "1000",
          currency: "usd",
        }, ctx),
      Error,
      "exceeds",
    );
    assertEquals(calls.length, 1, "no retry after guard rejection");
    assert(
      !calls.some((c) => c.headers.has("Authorization")),
      "credential must never be presented",
    );
  });
  const attempt = written.find((w) => w.spec === "payment");
  assert(attempt, "payment attempt persisted on blocked outcome");
  assertEquals(attempt.payload.outcome, "blocked");
});

Deno.test("pay: blocks on currency mismatch", async () => {
  const { ctx, written } = makeCtx();
  const fx = fixture402("500", "usd");
  await withFetchStub([() => fx.response()], async (calls) => {
    await assertRejects(
      () =>
        run("pay", {
          url: "https://api.example.test/paid",
          sptId: "spt_test_fixture",
          maxAmount: "1000",
          currency: "eur",
        }, ctx),
      Error,
      "currency",
    );
    assert(
      !calls.some((c) => c.headers.has("Authorization")),
      "credential must never be sent on a currency block",
    );
  });
  assertEquals(
    written.find((w) => w.spec === "payment")?.payload.outcome,
    "blocked",
  );
});

Deno.test("pay: success — retries with Payment credential, decodes receipt, persists attempt", async () => {
  const { ctx, written } = makeCtx();
  const fx = fixture402("500", "usd");
  const receiptWire = Receipt.serialize(Receipt.from({
    method: "stripe",
    reference: "pi_test_settled_1",
    status: "success",
    timestamp: "2026-07-03T00:00:00.000Z",
  }));
  await withFetchStub([
    (req) => {
      if (!req.headers.has("Authorization")) return fx.response();
      const auth = req.headers.get("Authorization")!;
      assertMatch(auth, /^Payment [A-Za-z0-9_-]+$/);
      const cred = Credential.deserialize<{ spt: string }>(auth);
      assertEquals(cred.payload.spt, "spt_test_fixture");
      assertEquals(cred.challenge.id, fx.challenge.id, "challenge echoed");
      return json({ data: "the-resource" }, 200, {
        "Payment-Receipt": receiptWire,
      });
    },
  ], async (calls) => {
    await run("pay", {
      url: "https://api.example.test/paid",
      sptId: "spt_test_fixture",
      maxAmount: "1000",
      currency: "usd",
    }, ctx);
    assertEquals(calls.length, 2, "probe + credentialed retry");
  });
  const attempt = written.find((w) => w.spec === "payment");
  assert(attempt);
  assertEquals(attempt.payload.outcome, "success");
  const receipt = attempt.payload.receipt as Record<string, unknown>;
  assertEquals(receipt.reference, "pi_test_settled_1");
  assert(
    !JSON.stringify(attempt.payload).includes("spt_test_fixture"),
    "full spt bearer id must not be persisted in the attempt record",
  );
});

Deno.test("pay: failed retry persists attempt with outcome failed", async () => {
  const { ctx, written } = makeCtx();
  const fx = fixture402("500", "usd");
  await withFetchStub([
    (req) =>
      req.headers.has("Authorization")
        ? json({ error: "verification failed" }, 402)
        : fx.response(),
  ], async () => {
    await assertRejects(() =>
      run("pay", {
        url: "https://api.example.test/paid",
        sptId: "spt_test_fixture",
        maxAmount: "1000",
        currency: "usd",
      }, ctx)
    );
  });
  const attempt = written.find((w) => w.spec === "payment");
  assert(attempt, "attempt persisted even when the retry fails");
  assertEquals(attempt.payload.outcome, "failed");
  assertEquals(attempt.payload.httpStatus, 402);
});

// ---------------------------------------------------------------------------
// Buyer: mintToken
// ---------------------------------------------------------------------------

Deno.test("mintToken: requires_action surfaces as actionable error", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/shared_payment/issued_tokens")
        ? json({
          id: "spt_needs_sca",
          object: "shared_payment.issued_token",
          status: "requires_action",
          next_action: { type: "use_stripe_sdk" },
          livemode: false,
        })
        : undefined,
  ], async () => {
    await assertRejects(
      () =>
        run("mintToken", {
          paymentMethodId: "pm_test_card",
          maxAmount: "1000",
          currency: "usd",
        }, ctx),
      Error,
      "requires_action",
    );
  });
});

Deno.test("mintToken: active token written with idempotency key sent", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) => {
      if (!req.url.includes("/v1/shared_payment/issued_tokens")) {
        return undefined;
      }
      assert(
        req.headers.get("Idempotency-Key"),
        "Idempotency-Key required on token mint",
      );
      return json({
        id: "spt_minted_ok",
        object: "shared_payment.issued_token",
        status: "active",
        livemode: false,
        usage_limits: { currency: "usd", max_amount: 1000 },
      });
    },
  ], async () => {
    await run("mintToken", {
      paymentMethodId: "pm_test_card",
      maxAmount: "1000",
      currency: "usd",
      externalId: "order-1",
    }, ctx);
  });
  const tok = written.find((w) => w.spec === "issuedToken");
  assert(tok);
  assertEquals(tok.payload.status, "active");
  assertEquals(tok.payload.id, "spt_minted_ok");
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

Deno.test("errors never echo the secret key or full spt ids", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([
    () =>
      json({
        error: {
          message:
            "Invalid API Key provided: sk_test_stub_secret_key_do_not_log for spt_test_fixture",
        },
      }, 401),
  ], async () => {
    const err = await assertRejects(() =>
      run("getIssuedToken", { sptId: "spt_test_fixture" }, ctx)
    );
    const msg = String(err);
    assert(!msg.includes("sk_test_stub_secret_key_do_not_log"), "sk redacted");
    assert(!msg.includes("spt_test_fixture"), "spt redacted");
  });
});

// ---------------------------------------------------------------------------
// Seller: createChallenge / verifyCredential
// ---------------------------------------------------------------------------

Deno.test("createChallenge: emits verifiable WWW-Authenticate + problem+json", async () => {
  const { ctx, written } = makeCtx();
  await run("createChallenge", {
    amount: "1500",
    currency: "usd",
  }, ctx);
  const spec = written.find((w) => w.spec === "challengeSpec");
  assert(spec);
  const headerValue = spec.payload.wwwAuthenticate as string;
  assertMatch(headerValue, /^Payment /);
  const parsed = Challenge.fromHeaders(
    new Headers({ "WWW-Authenticate": headerValue }),
  );
  assertEquals(parsed.method, "stripe");
  assert(
    Challenge.verify(parsed, { secretKey: SERVER_SECRET }),
    "emitted challenge verifies against serverSecret",
  );
  const req = parsed.request as Record<string, unknown>;
  assertEquals(req.amount, "1500");
  const problem = spec.payload.problemJson as Record<string, unknown>;
  assertEquals(problem.status, 402);
});

Deno.test("verifyCredential: accepts a genuine credential, rejects a price-tampered one (HMAC)", async () => {
  const { ctx, written } = makeCtx();
  const fx = fixture402("1500", "usd");
  const good = Credential.serialize(
    Credential.from({ challenge: fx.challenge, payload: { spt: "spt_ok_1" } }),
  );
  await run("verifyCredential", { authorizationHeader: good }, ctx);
  const v1 = written.filter((w) => w.spec === "credential").at(-1);
  assertEquals(v1?.payload.valid, true);

  const tampered = Credential.serialize(Credential.from({
    challenge: {
      ...fx.challenge,
      request: {
        ...(fx.challenge.request as Record<string, unknown>),
        amount: "1",
      },
    },
    payload: { spt: "spt_ok_1" },
  }));
  await run("verifyCredential", { authorizationHeader: tampered }, ctx);
  const v2 = written.filter((w) => w.spec === "credential").at(-1);
  assertEquals(v2?.payload.valid, false);
});

// ---------------------------------------------------------------------------
// Seller: chargeToken / issueReceipt
// ---------------------------------------------------------------------------

Deno.test("chargeToken: success only when PaymentIntent is succeeded; failure persisted", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) => {
      if (!req.url.includes("/v1/payment_intents")) return undefined;
      assert(req.headers.get("Idempotency-Key"), "idempotent settle");
      return json({
        id: "pi_settle_1",
        object: "payment_intent",
        status: "succeeded",
        amount: 1500,
        currency: "usd",
      });
    },
  ], async () => {
    await run("chargeToken", {
      sptId: "spt_granted_1",
      amount: "1500",
      currency: "usd",
    }, ctx);
  });
  const ok = written.find((w) => w.spec === "charge");
  assert(ok);
  assertEquals(ok.payload.outcome, "success");
  assertEquals(ok.payload.piId, "pi_settle_1");

  const { ctx: ctx2, written: written2 } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/payment_intents")
        ? json({
          id: "pi_settle_2",
          status: "requires_action",
          amount: 1500,
          currency: "usd",
        })
        : undefined,
  ], async () => {
    await assertRejects(() =>
      run("chargeToken", {
        sptId: "spt_granted_2",
        amount: "1500",
        currency: "usd",
      }, ctx2)
    );
  });
  const failed = written2.find((w) => w.spec === "charge");
  assert(failed, "failed charge persisted");
  assertEquals(failed.payload.outcome, "failed");
});

Deno.test("issueReceipt: refuses non-succeeded charges; emits decodable receipt", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/payment_intents/pi_ok")
        ? json({
          id: "pi_ok",
          status: "succeeded",
          amount: 1500,
          currency: "usd",
        })
        : req.url.includes("/v1/payment_intents/pi_pending")
        ? json({
          id: "pi_pending",
          status: "processing",
          amount: 1500,
          currency: "usd",
        })
        : undefined,
  ], async () => {
    await run("issueReceipt", { chargeId: "pi_ok" }, ctx);
    await assertRejects(
      () => run("issueReceipt", { chargeId: "pi_pending" }, ctx),
      Error,
      "succeeded",
    );
  });
  const rec = written.find((w) => w.spec === "receipt");
  assert(rec);
  const decoded = Receipt.deserialize(rec.payload.header as string);
  assertEquals(decoded.reference, "pi_ok");
  assertEquals(decoded.method, "stripe");
});

// ---------------------------------------------------------------------------
// Seller: refundCharge — read-before-destructive + ceiling
// ---------------------------------------------------------------------------

Deno.test("refundCharge: enforces remaining-refundable ceiling from live state", async () => {
  const { ctx, written } = makeCtx();
  const pi = {
    id: "pi_refundable",
    status: "succeeded",
    amount: 1000,
    amount_received: 1000,
    currency: "usd",
    latest_charge: { id: "ch_1", amount_refunded: 400 },
  };
  await withFetchStub([
    (req) => {
      const url = req.url;
      if (url.includes("/v1/payment_intents/pi_refundable")) return json(pi);
      if (url.includes("/v1/refunds") && req.method === "POST") {
        assert(req.headers.get("Idempotency-Key"), "idempotent refund");
        return json({ id: "re_1", status: "succeeded", amount: 500 });
      }
      return undefined;
    },
  ], async (calls) => {
    // Over the remaining 600 → must be rejected BEFORE any POST /refunds.
    await assertRejects(
      () =>
        run("refundCharge", { chargeId: "pi_refundable", amount: "700" }, ctx),
      Error,
      "remaining",
    );
    assert(
      !calls.some((c) => c.url.includes("/v1/refunds") && c.method === "POST"),
      "no refund POST after ceiling rejection",
    );
    // Within the ceiling → proceeds.
    await run(
      "refundCharge",
      { chargeId: "pi_refundable", amount: "500" },
      ctx,
    );
  });
  const refunds = written.filter((w) => w.spec === "refund");
  assertEquals(refunds.at(-1)?.payload.outcome, "success");
  assertEquals(refunds.at(-1)?.payload.refundId, "re_1");
});

// ---------------------------------------------------------------------------
// Seller: granted tokens
// ---------------------------------------------------------------------------

Deno.test("getGrantedToken: trims payment method details to brand/last4/exp", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    (req) =>
      req.url.includes("/v1/shared_payment/granted_tokens/")
        ? json({
          id: "spt_granted_x",
          usage_limits: { currency: "usd", max_amount: 1000 },
          payment_method_details: {
            type: "card",
            card: {
              brand: "visa",
              last4: "4242",
              exp_month: 12,
              exp_year: 2030,
              fingerprint: "SHOULD_NOT_PERSIST",
              number: "4242424242424242",
            },
          },
        })
        : undefined,
  ], async () => {
    await run("getGrantedToken", { sptId: "spt_granted_x" }, ctx);
  });
  const tok = written.find((w) => w.spec === "grantedToken");
  assert(tok);
  const s = JSON.stringify(tok.payload);
  assert(s.includes("visa") && s.includes("4242"));
  assert(!s.includes("SHOULD_NOT_PERSIST"), "fingerprint trimmed");
  assert(!s.includes("4242424242424242"), "PAN never persisted");
});

Deno.test("createTestGrantedToken: refuses outside test mode", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, testMode: false });
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

// ---------------------------------------------------------------------------
// Consumer buyer (Link grant) — driven through the injected link-cli MCP
// transport (no subprocess). NOTE: these mutate a process-global transport, so
// this file must not run under `deno test --parallel`.
// ---------------------------------------------------------------------------

const CONSUMER_ARGS = {
  ...GLOBAL_ARGS,
  linkCliPath: "/opt/link-cli/link-cli",
  linkCliVersion: "0.9.0",
  allowLiveGrants: false,
};

/** Stub the MCP transport with a per-tool response map; capture the calls. */
function withMcpStub(
  routes: Record<string, unknown>,
  fn: (calls: McpRequest[]) => Promise<void>,
) {
  const calls: McpRequest[] = [];
  _setMcpTransport((req: McpRequest): Promise<McpResponse> => {
    calls.push(req);
    const payload = routes[req.tool];
    return Promise.resolve({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload ?? {}) }],
      },
    });
  });
  return (async () => {
    try {
      await fn(calls);
    } finally {
      _resetMcpTransport();
    }
  })();
}

Deno.test("consumer: methods fail closed without an absolute linkCliPath", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS); // no linkCliPath
  await assertRejects(
    () => model.methods.getSpendRequest.execute({ id: "lsrq_abc" }, ctx),
    Error,
    "linkCliPath",
  );
});

Deno.test("consumer: methods reject a relative linkCliPath (no PATH hijack)", async () => {
  const { ctx } = makeCtx({ ...CONSUMER_ARGS, linkCliPath: "link-cli" });
  await assertRejects(
    () => model.methods.getSpendRequest.execute({ id: "lsrq_abc" }, ctx),
    Error,
    "linkCliPath",
  );
});

Deno.test("listConsumerPaymentMethods fans out one resource per item + summary", async () => {
  const { ctx, written } = makeCtx(CONSUMER_ARGS);
  await withMcpStub(
    {
      "payment-methods_list": [
        { id: "csmrpd_visa1", type: "card", display: "Visa ****4242" },
        { id: "csmrpd_bank2", type: "bank_account" },
      ],
    },
    () => {
      return model.methods.listConsumerPaymentMethods.execute({}, ctx).then(
        () => {
          const cpm = written.filter((w) => w.spec === "consumerPaymentMethod");
          assertEquals(cpm.length, 2);
          assertEquals(cpm[0].payload.id, "csmrpd_visa1");
          const summary = written.find((w) => w.spec === "summary");
          assert(summary);
          assertEquals(summary.name, "summary-consumer-payment-methods");
          assertEquals(summary.payload.total, 2);
        },
      );
    },
  );
});

Deno.test("getSpendRequest rejects a non-lsrq id", async () => {
  const { ctx } = makeCtx(CONSUMER_ARGS);
  await assertRejects(
    () => model.methods.getSpendRequest.execute({ id: "spend_bad" }, ctx),
    Error,
    "lsrq_",
  );
});

Deno.test("getSpendRequest records status and NEVER persists a raw spt_", async () => {
  const { ctx, written } = makeCtx(CONSUMER_ARGS);
  await withMcpStub(
    {
      // A hostile/buggy response carrying a raw token must not reach a resource.
      "spend-request_retrieve": {
        id: "lsrq_abc",
        status: "approved",
        amount: 500,
        currency: "usd",
        network_id: "profile_test_fixture",
        shared_payment_token: "spt_live_LEAKED_SECRET_9999",
      },
    },
    () => {
      return model.methods.getSpendRequest.execute({ id: "lsrq_abc" }, ctx)
        .then(() => {
          const sr = written.find((w) => w.spec === "spendRequest");
          assert(sr);
          assertEquals(sr.payload.status, "approved");
          assertEquals(sr.payload.outcome, "retrieved");
          assertEquals(sr.payload.amount, "500"); // integer coerced to string
          // The strictObject schema + field-by-field construction means the
          // stray spt_ can never be persisted.
          assertEquals(
            JSON.stringify(sr.payload).includes("spt_"),
            false,
          );
        });
    },
  );
});

Deno.test("cancelSpendRequest reads before cancelling", async () => {
  const { ctx, written } = makeCtx(CONSUMER_ARGS);
  await withMcpStub(
    {
      "spend-request_retrieve": { id: "lsrq_abc", status: "pending_approval" },
      "spend-request_cancel": { id: "lsrq_abc", status: "cancelled" },
    },
    (calls) => {
      return model.methods.cancelSpendRequest.execute({ id: "lsrq_abc" }, ctx)
        .then(() => {
          assertEquals(calls.map((c) => c.tool), [
            "spend-request_retrieve",
            "spend-request_cancel",
          ]);
          const sr = written.find((w) => w.spec === "spendRequest");
          assert(sr);
          assertEquals(sr.payload.outcome, "cancelled");
        });
    },
  );
});

const CTX100 =
  "Buying one month of API access to the weather forecast endpoint for an " +
  "automated trading agent; single charge, no recurring commitment here.";

Deno.test("createSpendRequest fails closed when no payee networkId resolves", async () => {
  const { ctx } = makeCtx({ ...CONSUMER_ARGS, networkId: undefined });
  await assertRejects(
    () =>
      run("createSpendRequest", {
        amount: "500",
        currency: "usd",
        context: CTX100,
      }, ctx),
    Error,
    "payee",
  );
});

Deno.test("createSpendRequest rejects a sub-floor amount BEFORE prompting", async () => {
  const { ctx } = makeCtx(CONSUMER_ARGS);
  await withMcpStub({}, async (calls) => {
    await assertRejects(
      () =>
        run("createSpendRequest", {
          amount: "10", // $0.10, below the $0.50 USD floor
          currency: "usd",
          context: CTX100,
        }, ctx),
      Error,
      "minimum",
    );
    assertEquals(calls.length, 0, "no link-cli call before a guard rejection");
  });
});

Deno.test("createSpendRequest rejects an over-cap amount", async () => {
  const { ctx } = makeCtx(CONSUMER_ARGS);
  await withMcpStub({}, async (calls) => {
    await assertRejects(
      () =>
        run("createSpendRequest", {
          amount: "500001",
          currency: "usd",
          context: CTX100,
        }, ctx),
      Error,
      "cap",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("createSpendRequest sends the SPT tool args and derives test mode", async () => {
  const { ctx, written } = makeCtx(CONSUMER_ARGS); // allowLiveGrants false
  await withMcpStub(
    {
      "spend-request_create": {
        id: "lsrq_new",
        status: "pending_approval",
        network_id: "profile_test_fixture",
        amount: 500,
        currency: "usd",
      },
    },
    async (calls) => {
      await run("createSpendRequest", {
        amount: "500",
        currency: "usd",
        context: CTX100,
      }, ctx);
      assertEquals(calls[0].tool, "spend-request_create");
      const a = calls[0].args;
      assertEquals(a.credentialType, "shared_payment_token");
      assertEquals(a.networkId, "profile_test_fixture");
      assertEquals(a.amount, 500); // canonical string -> integer at the wire
      assertEquals(a.requestApproval, false);
      assertEquals(a.test, true); // derived from allowLiveGrants=false
      const sr = written.find((w) => w.spec === "spendRequest");
      assert(sr);
      assertEquals(sr.payload.id, "lsrq_new");
      assertEquals(sr.payload.outcome, "created");
    },
  );
});

Deno.test("createSpendRequest blocks a grant whose echoed payee was swapped", async () => {
  const { ctx } = makeCtx(CONSUMER_ARGS);
  await withMcpStub(
    {
      "spend-request_create": {
        id: "lsrq_evil",
        status: "pending_approval",
        network_id: "profile_test_ATTACKER", // != requested
        amount: 500,
        currency: "usd",
      },
    },
    async () => {
      await assertRejects(
        () =>
          run("createSpendRequest", {
            amount: "500",
            currency: "usd",
            context: CTX100,
          }, ctx),
        Error,
        "echo mismatch",
      );
    },
  );
});

Deno.test("paySpendRequest: advisory pre-flight blocks an over-ceiling 402 before mpp_pay", async () => {
  const { ctx, written } = makeCtx(CONSUMER_ARGS);
  const fx = fixture402("100000", "usd"); // 1000.00 demanded
  await withFetchStub([() => fx.response()], async () => {
    await withMcpStub({}, async (calls) => {
      await assertRejects(
        () =>
          run("paySpendRequest", {
            url: "https://api.example.test/paid",
            id: "lsrq_abc",
            maxAmount: "1000", // 10.00 ceiling
            currency: "usd",
          }, ctx),
        Error,
        "exceeds",
      );
      assert(
        !calls.some((c) => c.tool === "mpp_pay"),
        "mpp_pay must not run after the advisory guard blocks",
      );
    });
  });
  const sr = written.find((w) => w.spec === "spendRequest");
  assert(sr);
  assertEquals(sr.payload.outcome, "blocked");
});

Deno.test("paySpendRequest: spends by reference via mpp_pay, then reports", async () => {
  const { ctx, written } = makeCtx(CONSUMER_ARGS);
  const fx = fixture402("1000", "usd"); // within the 1000 ceiling
  await withFetchStub([() => fx.response()], async () => {
    await withMcpStub(
      { "mpp_pay": { ok: true }, "report": { ok: true } },
      async (calls) => {
        await run("paySpendRequest", {
          url: "https://api.example.test/paid",
          id: "lsrq_abc",
          maxAmount: "1000",
          currency: "usd",
        }, ctx);
        const pay = calls.find((c) => c.tool === "mpp_pay");
        assert(pay, "mpp_pay called");
        assertEquals(pay.args.spendRequestId, "lsrq_abc"); // BY REFERENCE
        assert(calls.some((c) => c.tool === "report"), "report telemetry sent");
      },
    );
  });
  const sr = written.find((w) => w.spec === "spendRequest");
  assert(sr);
  assertEquals(sr.payload.outcome, "paid");
});

Deno.test("getIssuedToken/revokeToken reject a Link-origin id with guidance", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  for (const m of ["getIssuedToken", "revokeToken"]) {
    await assertRejects(
      () => run(m, { sptId: "lsrq_notAnIssuedToken" }, ctx),
      Error,
      "paySpendRequest",
    );
  }
});

Deno.test("consumer: testMode + allowLiveGrants together is refused", async () => {
  const { ctx } = makeCtx({
    ...CONSUMER_ARGS,
    testMode: true,
    allowLiveGrants: true,
  });
  await assertRejects(
    () => model.methods.getSpendRequest.execute({ id: "lsrq_abc" }, ctx),
    Error,
    "Contradictory config",
  );
});

Deno.test("createSpendRequest blocks a grant whose echoed payment method was swapped", async () => {
  const { ctx } = makeCtx(CONSUMER_ARGS);
  await withMcpStub(
    {
      "spend-request_create": {
        id: "lsrq_pm",
        status: "pending_approval",
        network_id: "profile_test_fixture",
        amount: 500,
        currency: "usd",
        payment_method_id: "csmrpd_ATTACKER",
      },
    },
    async () => {
      await assertRejects(
        () =>
          run("createSpendRequest", {
            amount: "500",
            currency: "usd",
            context: CTX100,
            paymentMethodId: "csmrpd_mycard",
          }, ctx),
        Error,
        "payment method",
      );
    },
  );
});
