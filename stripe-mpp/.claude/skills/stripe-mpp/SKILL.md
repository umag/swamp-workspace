---
name: stripe-mpp
description: Pay for or charge for HTTP/MCP/API resources with Stripe's Machine Payments Protocol (HTTP-402 "Payment" auth + fiat Shared Payment Tokens) via the @magistr/stripe-mpp swamp model. Buyer side has two paths — an AGENT buyer (probe a 402, mint an SPT, pay with spend guard) and a CONSUMER buyer where a human WITHOUT a Stripe account grants a Shared Payment Token from their Link wallet (via link-cli) that the model spends by reference — plus the full seller side (create challenge, verify credential, charge, receipt, reconcile, refund). Triggers on "mpp", "machine payments", "402 payment", "shared payment token", "spt", "pay for api", "pay for resource", "agent payment", "link wallet", "link spend request", "consumer payment method", "grant a shared payment token", "pay without a stripe account", "refund machine payment", "reconcile mpp charges". Do NOT use for ordinary Stripe consumer checkout, products/prices/webhooks billing (use @goodcraft/stripe) or crypto/Tempo payments (not implemented).
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

Two paths. The **agent buyer** already holds a Stripe payment method. The
**consumer buyer** is a human WITHOUT a Stripe account who grants a token from
their Link wallet.

### Agent buyer (you already hold a Stripe payment method)

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

`getIssuedToken` / `revokeToken` manage the agent-buyer token lifecycle (they do
NOT apply to a consumer Link grant — see below).

### Consumer buyer (Link grant)

A human without a Stripe account funds the payment from their **Link wallet**.
The model drives Stripe's `link-cli` over an MCP stdio subprocess and spends the
grant **by reference** — it never holds the token.

**Gates (US-only feature — inert otherwise):**

- **Prerequisite:** on THIS host, `link-cli` must be installed at an absolute
  path (set the `linkCliPath` global) and a device session authenticated once:
  `link-cli auth login` (a US Link account). The four methods below fail closed
  otherwise.
- **`allowLiveGrants` defaults to false** (test mode). There is no session
  live/test signal, so set it true only on a US Link account you mean to move
  real money on.
- `context` must be **≥ 100 chars** (the consumer reads it when approving);
  amount is minor-units, `≤ 500000`, and meets the `$0.50` USD card minimum.
- **No revocation** for an approved grant; `cancelSpendRequest` covers a
  _pending_ request only.

Flow:

```bash
# 1. (optional) list the consumer's Link payment methods
swamp model method run stripe-mpp listConsumerPaymentMethods

# 2. create the grant — the PRIMARY guard runs here (payee/amount/currency).
#    Returns an lsrq_ id; does NOT block on approval.
swamp model method run stripe-mpp createSpendRequest \
  --input amount=500 --input currency=usd \
  --input context="<>=100 chars describing the purchase the consumer approves>"

# 3. the consumer approves in their Link app. Poll for the terminal status —
#    do NOT loop this; drive the ~10-min wait from a workflow `manual_approval`
#    step (timeout 600). Statuses: created -> pending_approval ->
#    approved | denied | expired.
swamp model method run stripe-mpp getSpendRequest --input id=lsrq_...

# 4. once approved, spend it by reference against the paid URL.
swamp model method run stripe-mpp paySpendRequest \
  --input url=https://api.example.com/paid --input id=lsrq_... \
  --input maxAmount=500 --input currency=usd
```

`paySpendRequest`'s pre-flight guard is **advisory** — link-cli's `mpp_pay`
re-fetches and spends against its own challenge, so the binding spend cap is the
amount the consumer approved at grant time (Stripe-enforced), not this call. The
agent-side `pay` cannot spend a Link grant (there is no raw `spt_`). See
[references/link-cli-mcp.md](references/link-cli-mcp.md) for the MCP tool
surface.

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

The **consumer buyer adds NO vault keys** — link-cli owns its Link session on
disk (device-flow). It adds three non-secret globals: `linkCliPath` (absolute
path to the binary), `linkCliVersion`, and `allowLiveGrants` (default false).
The link-cli subprocess is spawned with `clearEnv`, so it never inherits
`STRIPE_SECRET_KEY` / `SERVER_SECRET`; keep the consumer host's Stripe
credentials and its Link session as separate stores.

## Upstream pins

The model pins `mppx@0.8.6` + `stripe@22.4.0-beta.1` (preview channels). A
GitHub Actions cron raises an issue in the workspace repo when the pins go
stale; bumps must pass the contract tests in `stripe_mpp_test.ts` first.
