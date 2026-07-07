/**
 * Contract tests pinning mppx@0.8.5 behavior to the MPP specs:
 *  - draft-ryan-httpauth-payment-01 (the "Payment" HTTP auth scheme)
 *  - mpp-specs draft-stripe-charge-00 (the stripe charge method)
 *
 * Fixture values below are derived FROM THE SPECS, not from mppx internals —
 * a pin bump that breaks these tests means the wire format changed and every
 * dependent method must be re-verified before the bump lands.
 *
 * All tests are offline: 402 generation, codec round-trips, and HMAC
 * verification are local operations (no Stripe API calls).
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "jsr:@std/assert@1";
import { Challenge, Credential, Receipt } from "npm:mppx@0.8.5";
import { Mppx, stripe as stripeServer } from "npm:mppx@0.8.5/server";

// ---------------------------------------------------------------------------
// Spec fixtures (draft-stripe-charge-00 §request / §credential)
// ---------------------------------------------------------------------------

/** 32-byte server secret (spec: HMAC-SHA256 challenge-id binding). */
const SERVER_SECRET = "0123456789abcdef0123456789abcdef";

const SPEC_CHALLENGE_PARAMS = {
  realm: "api.example.test",
  method: "stripe",
  intent: "charge",
  // Decoded `request` payload shape per draft-stripe-charge-00:
  // amount (string, minor units), currency, methodDetails{networkId,
  // paymentMethodTypes}.
  request: {
    amount: "1000",
    currency: "usd",
    methodDetails: {
      networkId: "profile_test_fixture",
      paymentMethodTypes: ["card", "link"],
    },
  },
};

/** base64url-nopad per draft-ryan-httpauth-payment-01 ABNF. */
const BASE64URL_NOPAD = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Challenge codec contract
// ---------------------------------------------------------------------------

Deno.test("challenge: serialize/deserialize round-trips all spec params", () => {
  const challenge = Challenge.from({
    ...SPEC_CHALLENGE_PARAMS,
    secretKey: SERVER_SECRET,
  });
  assert(challenge.id.length > 0, "challenge id must be present");
  assertEquals(challenge.method, "stripe");
  assertEquals(challenge.intent, "charge");
  assertEquals(challenge.realm, SPEC_CHALLENGE_PARAMS.realm);

  const wire = Challenge.serialize(challenge);
  const back = Challenge.deserialize(wire);
  assertEquals(back.id, challenge.id);
  assertEquals(back.method, challenge.method);
  assertEquals(back.intent, challenge.intent);
  assertEquals(back.realm, challenge.realm);
  assertEquals(back.request, challenge.request);
});

Deno.test("challenge: id is HMAC-bound — verify passes, tamper fails", () => {
  const challenge = Challenge.from({
    ...SPEC_CHALLENGE_PARAMS,
    secretKey: SERVER_SECRET,
  });
  assert(
    Challenge.verify(challenge, { secretKey: SERVER_SECRET }),
    "genuine challenge must verify against the issuing secret",
  );
  const tampered = {
    ...challenge,
    request: { ...SPEC_CHALLENGE_PARAMS.request, amount: "999999" },
  };
  assert(
    !Challenge.verify(tampered, { secretKey: SERVER_SECRET }),
    "tampered request must fail HMAC verification",
  );
  assert(
    !Challenge.verify(challenge, { secretKey: "wrong".repeat(8) }),
    "wrong secret must fail HMAC verification",
  );
});

// ---------------------------------------------------------------------------
// Credential codec contract (draft-stripe-charge-00: payload = {spt, externalId?})
// ---------------------------------------------------------------------------

Deno.test("credential: envelope is base64url-nopad of {challenge, payload.spt}", () => {
  const challenge = Challenge.from({
    ...SPEC_CHALLENGE_PARAMS,
    secretKey: SERVER_SECRET,
  });
  const credential = Credential.from({
    challenge,
    payload: { spt: "spt_test_fixture_123", externalId: "ext-42" },
  });
  // serialize() returns the full Authorization value including the scheme:
  // credentials = "Payment" 1*SP token68 (draft ABNF).
  const wire = Credential.serialize(credential);
  assertMatch(
    wire,
    /^Payment [A-Za-z0-9_-]+$/,
    "Authorization value must be 'Payment' + base64url-nopad (spec ABNF)",
  );

  const back = Credential.deserialize<{ spt: string; externalId?: string }>(
    wire,
  );
  assertEquals(back.payload.spt, "spt_test_fixture_123");
  assertEquals(back.payload.externalId, "ext-42");
  assertEquals(back.challenge.id, challenge.id, "challenge must echo back");
  assertEquals(back.challenge.method, "stripe");
});

// ---------------------------------------------------------------------------
// Receipt codec contract (spec: {status:"success", method, timestamp, reference})
// ---------------------------------------------------------------------------

Deno.test("receipt: round-trips and enforces status literal", () => {
  const receipt = Receipt.from({
    method: "stripe",
    reference: "pi_test_fixture_123",
    status: "success",
    timestamp: "2026-07-03T00:00:00.000Z",
  });
  assertEquals(receipt.status, "success");
  const wire = Receipt.serialize(receipt);
  assertMatch(wire, BASE64URL_NOPAD);
  const back = Receipt.deserialize(wire);
  assertEquals(back.reference, "pi_test_fixture_123");
  assertEquals(back.method, "stripe");

  const parsed = Receipt.Schema.safeParse({ ...receipt, status: "failed" });
  assert(!parsed.success, "Schema must reject non-'success' status literal");
});

// ---------------------------------------------------------------------------
// Server 402 contract (draft-ryan-httpauth-payment-01 §WWW-Authenticate)
// ---------------------------------------------------------------------------

Deno.test("server: stripe.charge emits a spec-compliant 402 challenge", async () => {
  const mppx = Mppx.create({
    methods: [
      stripeServer.charge({
        secretKey: "sk_test_offline_dummy",
        networkId: "profile_test_fixture",
        paymentMethodTypes: ["card", "link"],
      }),
    ],
    realm: "api.example.test",
    secretKey: SERVER_SECRET,
  });

  const handler = Mppx.compose(
    mppx.stripe.charge({ amount: "1000", currency: "usd", decimals: 2 }),
  );
  const response = await handler(
    new Request("https://api.example.test/paid", { method: "GET" }),
  );

  assertEquals(response.status, 402, "no credential → 402 Payment Required");
  assert(response.status === 402, "narrow the response union");
  const challengeResponse = response.challenge as Response;
  assertEquals(challengeResponse.status, 402);
  const wwwAuth = challengeResponse.headers.get("WWW-Authenticate");
  assert(wwwAuth, "WWW-Authenticate header must be present");
  assertMatch(
    wwwAuth,
    /^Payment /,
    "auth scheme must be 'Payment' (RFC9110 challenge grammar)",
  );

  // The challenge must parse with the client-side codec (round-trip through
  // the same library both sides will use in production).
  const challenges = Challenge.fromResponseList(challengeResponse);
  assert(challenges.length >= 1, "at least one challenge advertised");
  const ch = challenges.find((c) => c.method === "stripe");
  assert(ch, "stripe method challenge present");
  assertEquals(ch.intent, "charge");
  assertEquals(ch.realm, "api.example.test");
  assert(
    Challenge.verify(ch, { secretKey: SERVER_SECRET }),
    "advertised challenge id must be HMAC-verifiable by the issuer",
  );

  // Decoded request payload per draft-stripe-charge-00.
  const req = ch.request as Record<string, unknown>;
  assertEquals(typeof req.amount, "string", "amount is a string (spec)");
  assertEquals(req.currency, "usd");
  const details = req.methodDetails as Record<string, unknown>;
  assertEquals(details.networkId, "profile_test_fixture");
  assertEquals(details.paymentMethodTypes, ["card", "link"]);
});

Deno.test("credential: tampered challenge inside credential fails server verify", () => {
  const challenge = Challenge.from({
    ...SPEC_CHALLENGE_PARAMS,
    secretKey: SERVER_SECRET,
  });
  const credential = Credential.from({
    challenge: {
      ...challenge,
      request: { ...SPEC_CHALLENGE_PARAMS.request, amount: "1" },
    },
    payload: { spt: "spt_test_fixture_123" },
  });
  const back = Credential.deserialize(Credential.serialize(credential));
  assert(
    !Challenge.verify(back.challenge, { secretKey: SERVER_SECRET }),
    "server must detect price-tampering via the HMAC-bound challenge id",
  );
  assertNotEquals(
    (back.challenge.request as Record<string, unknown>).amount,
    SPEC_CHALLENGE_PARAMS.request.amount,
  );
});
