---
name: stripe-mpp
description: Pay for or charge for HTTP/MCP/API resources with Stripe's Machine Payments Protocol (HTTP-402 "Payment" auth + fiat Shared Payment Tokens) via the @magistr/stripe-mpp swamp model. Buyer side (probe a 402, mint an SPT, pay with spend guard) and full seller side (create challenge, verify credential, charge, receipt, reconcile, refund). Triggers on "mpp", "machine payments", "402 payment", "shared payment token", "spt", "pay for api", "pay for resource", "agent payment", "refund machine payment", "reconcile mpp charges". Do NOT use for Stripe products/prices/webhooks billing (use @goodcraft/stripe) or crypto/Tempo payments (not implemented).
---

# Stripe MPP (Machine Payments Protocol)

Drive the `@magistr/stripe-mpp` model (instance: `stripe-mpp`) to pay for or
charge for resources over the HTTP-402 "Payment" auth scheme with fiat Shared
Payment Tokens (SPTs).

## Read these caveats FIRST (they gate every flow)

1. **Spending is guarded.** `pay` requires `maxAmount` (minor units string) AND
   `currency`; the challenge is cross-checked BEFORE the credential is
   presented. Never work around a blocked payment by raising the ceiling without
   the human confirming the price.
2. **Headless minting is conditional.** `mintToken` needs an existing `pm_`
   payment method and only succeeds when the token returns `status=active`.
   `requires_action` (SCA) cannot be completed headlessly — surface the error to
   the human; do not retry in a loop.
3. **Every pay/refund outcome is persisted** (`payment` / `refund` resources) —
   check them with `swamp data get stripe-mpp <name>` before retrying anything;
   a failed attempt may still have consumed the SPT.
4. **Test helpers refuse live mode.** `createTestGrantedToken` needs
   `testMode=true` and an `sk_test_` key.
5. **Business Network Profile** (`profile_test_...`) is created in the Stripe
   Dashboard — no API exists; it's the `networkId` global argument.

## Buyer flows

Discover the price without paying:

```bash
swamp model method run stripe-mpp probe --input url=https://api.example.com/paid
swamp data get stripe-mpp probe-<slug> --json   # parsed challenges
```

Mint a spending token (vault the result id if reusing):

```bash
swamp model method run stripe-mpp mintToken \
  --input paymentMethodId=pm_... \
  --input maxAmount=1000 --input currency=usd
```

Pay (probe → guard → credential retry → receipt, one call):

```bash
swamp model method run stripe-mpp pay \
  --input url=https://api.example.com/paid \
  --input sptId=spt_... \
  --input maxAmount=1000 --input currency=usd \
  --input expectedNetworkId=profile_...   # pin the payee (recommended)
```

**Pin the counterparty.** The 402 challenge is unsigned, so a MITM/hostile
server can advertise a challenge that pays the ATTACKER. Always pass
`expectedNetworkId` (the seller's `profile_...`) when you know who you're
paying; add `expectedScope` (matching the seller's `createChallenge scope`) to
stop a credential being replayed to a different route.

`getIssuedToken` / `revokeToken` manage the token lifecycle.

## Seller flows

```bash
# 402 material for your endpoint (WWW-Authenticate value + problem+json body)
swamp model method run stripe-mpp createChallenge \
  --input amount=1500 --input currency=usd --input expiresInSeconds=300

# When a request comes back with Authorization: Payment ...
swamp model method run stripe-mpp verifyCredential \
  --input authorizationHeader="Payment eyJ..."     # verdict resource, never throws
swamp model method run stripe-mpp chargeToken \
  --input authorizationHeader="Payment eyJ..."     # settles; success ONLY if succeeded
swamp model method run stripe-mpp issueReceipt --input chargeId=pi_...
```

Reconcile and refund:

```bash
swamp model method run stripe-mpp listCharges --input externalId=order-42
swamp model method run stripe-mpp refundCharge \
  --input chargeId=pi_... --input amount=500   # read-verifies state + ceiling first
```

## Amounts

ALL amounts everywhere in this model are **minor-unit strings** ("1500" =
€15.00/$15.00). Currencies are lowercase ISO.

## Vault + globals

Vault `stripe-mpp`: `STRIPE_SECRET_KEY` (always) + `SERVER_SECRET` (seller
methods; ≥32 chars). Globals: `networkId` (profile_...), `realm`, `testMode`,
`allowInsecure` (localhost fixtures only).

## Upstream pins

The model pins `mppx@0.8.5` + `stripe@22.4.0-beta.1` (preview channels). A
GitHub Actions cron raises an issue in the workspace repo when the pins go
stale; bumps must pass the contract tests in `stripe_mpp_test.ts` first.
