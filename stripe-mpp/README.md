# @magistr/stripe-mpp

Swamp model for **Stripe's Machine Payments Protocol (MPP)** — the open HTTP-402
"Payment" auth scheme (draft-ryan-httpauth-payment-01, Stripe + Tempo) that lets
autonomous agents pay for HTTP/MCP/API resources. Fiat only, via **Shared
Payment Tokens (SPTs)**; the Tempo/crypto method is deferred.

Built reuse-first:

- [`mppx@0.8.6`](https://github.com/wevm/mppx) — the reference MPP protocol
  library (challenge codec, HMAC-bound challenge ids, credential envelope,
  receipts; server primitives)
- `stripe@22.4.0-beta.1` (public-preview channel) — typed SPT lifecycle
  (`sharedPayment.issuedTokens` / `grantedTokens`)

The model adds the swamp-native layer: vault wiring, an audit trail (a `payment`
resource on **every** pay outcome and a `refund` resource on every refund
attempt), an amount+currency spend guard enforced **before** the credential
leaves the process, `Idempotency-Key` on all money-moving POSTs, error redaction
(secret keys and `spt_` bearer ids never surface, including inside library
errors), and test-mode gates.

## Setup

```bash
swamp extension source add /path/to/swamp-workspace/stripe-mpp
swamp vault create local_encryption stripe-mpp
swamp vault put stripe-mpp STRIPE_SECRET_KEY sk_test_...
swamp vault put stripe-mpp SERVER_SECRET "$(openssl rand -hex 32)"   # seller side
swamp model create @magistr/stripe-mpp stripe-mpp \
  --global-arg 'secretKey=${{ vault.get(stripe-mpp, STRIPE_SECRET_KEY) }}' \
  --global-arg 'serverSecret=${{ vault.get(stripe-mpp, SERVER_SECRET) }}' \
  --global-arg networkId=profile_test_...
```

`networkId` is your Stripe **Business Network Profile** — created in the
Dashboard (no API exists).

## Buyer example: discover a price, then pay under a ceiling

```bash
# What does this resource cost? (no payment happens)
swamp model method run stripe-mpp probe \
  --input url=https://api.example.com/paid

# Mint a capped, expiring Shared Payment Token from a saved payment method
swamp model method run stripe-mpp mintToken \
  --input paymentMethodId=pm_... \
  --input maxAmount=1000 --input currency=usd

# Pay: probe → spend guard (amount AND currency) → credential retry → receipt
swamp model method run stripe-mpp pay \
  --input url=https://api.example.com/paid \
  --input sptId=spt_... \
  --input maxAmount=1000 --input currency=usd

# Audit trail (written on success, failure, AND blocked attempts)
swamp data get stripe-mpp payment-https-api-example-com-paid --json
```

## Consumer buyer example (Link grant, US-only)

For a human WITHOUT a Stripe account: they grant a Shared Payment Token from
their **Link wallet** and the model spends it by reference. Requires `link-cli`
installed at an absolute path (`linkCliPath` global) and an authenticated
session (`link-cli auth login`, US Link account) on the same host; the four
methods below are inert (fail closed) otherwise, and the other 14 methods are
unaffected.

```bash
# createSpendRequest is the PRIMARY guard (payee/amount/currency, before the
# consumer is prompted). Returns an lsrq_; does NOT block on approval.
swamp model method run stripe-mpp createSpendRequest \
  --input amount=500 --input currency=usd \
  --input context="<>= 100 chars the consumer reads when approving this charge>"

# The consumer approves in their Link app; poll for the terminal status from a
# workflow manual_approval step (do NOT loop this call).
swamp model method run stripe-mpp getSpendRequest --input id=lsrq_...

# Once approved, spend by reference. The binding cap is the consumer-approved
# grant amount, not this call's advisory maxAmount.
swamp model method run stripe-mpp paySpendRequest \
  --input url=https://api.example.com/paid --input id=lsrq_... \
  --input maxAmount=500 --input currency=usd
```

## Seller example: charge agents for your endpoint

```bash
# Generate the 402 material your endpoint returns
swamp model method run stripe-mpp createChallenge \
  --input amount=1500 --input currency=usd --input expiresInSeconds=300

# A request came back with "Authorization: Payment eyJ..." — verify, settle,
# and issue the receipt header
swamp model method run stripe-mpp verifyCredential \
  --input authorizationHeader="Payment eyJ..."
swamp model method run stripe-mpp chargeToken \
  --input authorizationHeader="Payment eyJ..."
swamp model method run stripe-mpp issueReceipt --input chargeId=pi_...

# Reconciliation + guarded refunds
swamp model method run stripe-mpp listCharges --input externalId=order-42
swamp model method run stripe-mpp refundCharge \
  --input chargeId=pi_... --input amount=500
```

## Methods

| Side   | Method                           | Purpose                                                |
| ------ | -------------------------------- | ------------------------------------------------------ |
| buyer  | `probe`                          | Parse a 402's payment challenges without paying        |
| buyer  | `mintToken`                      | Mint a capped SPT from a `pm_` (headless; see caveats) |
| buyer  | `pay`                            | Guarded end-to-end payment with receipt decode         |
| buyer  | `getIssuedToken` / `revokeToken` | Agent-buyer token lifecycle                            |
| buyer  | `listConsumerPaymentMethods`     | Consumer/Link: list wallet payment methods (csmrpd\_)  |
| buyer  | `createSpendRequest`             | Consumer/Link: PRIMARY guard; create a grant (lsrq\_)  |
| buyer  | `getSpendRequest`                | Consumer/Link: single-shot status (poll via workflow)  |
| buyer  | `cancelSpendRequest`             | Consumer/Link: cancel a PENDING grant                  |
| buyer  | `paySpendRequest`                | Consumer/Link: spend a grant by reference (mpp\_pay)   |
| seller | `createChallenge`                | WWW-Authenticate value + problem+json body             |
| seller | `verifyCredential`               | HMAC/expiry/method verdict (never throws)              |
| seller | `chargeToken`                    | Settle an SPT; success ONLY when `succeeded`           |
| seller | `issueReceipt`                   | Payment-Receipt header for a settled charge            |
| seller | `getCharge` / `listCharges`      | Reconciliation (search by externalId)                  |
| seller | `refundCharge`                   | Read-verified, ceiling-guarded refunds                 |
| seller | `getGrantedToken`                | Seller token view (card details trimmed)               |
| seller | `createTestGrantedToken`         | TEST-MODE-ONLY e2e helper                              |

All amounts are **minor-unit strings** ("1500" = $15.00); currencies are
lowercase ISO.

## Caveats (read before using)

- **Headless SPT minting is conditional**: it needs an existing `pm_` payment
  method and the issued token to come back `status: "active"`. `requires_action`
  (SCA) has no server-only completion — the method fails loud with guidance.
  Raw-PAN `pm_` creation is PCI-gated in live mode.
- **Business Network Profile** (`profile_test_...` / `profile_...`) is
  Dashboard-only.
- **`mintToken` needs two distinct profiles.** An agent can't issue an SPT to
  pay its own profile — Stripe rejects with "network_id is the same as the
  counterparty network_id". Pass a `sellerNetworkId` (the counterparty's
  profile) distinct from the minting account's own profile.
- **SPT is US-only** (Stripe). Paying agents/customers must be US-based.
- Both deps ride **vendor preview channels** with exact pins. The release-watch
  GitHub Actions cron (`.github/workflows/stripe-mpp-release-watch.yml` in this
  workspace) checks npm dist-tags against the pins parsed from
  `extensions/models/stripe_mpp.ts` and raises one idempotent GH issue when they
  go stale. **If the import specifiers move to another file, update that
  workflow in the same change.** Pin bumps must pass the spec-fixture contract
  tests in `stripe_mpp_test.ts` — they pin the MPP wire format.
- Plain-http resource URLs are refused unless `allowInsecure=true` AND the host
  is localhost (test fixtures).

## Testing

```bash
deno task check && deno task test
```

97 offline tests, deterministic, across seven layers (property `numRuns` is
env-overridable via `FC_NUM_RUNS`; `deno task test:soak` runs at 10000 — see the
nightly `stripe-mpp-property-soak` workflow):

- **6 spec-fixture contract tests** — challenge/credential/receipt codecs +
  server 402 shape, quoted from draft-ryan-httpauth-payment-01 and mpp-specs
  draft-stripe-charge-00; these arbitrate every pin bump
- **17 method tests** — every method over a fetch stub (the SDK factory routes
  through `Stripe.createFetchHttpClient()`), covering the guard, audit-trail,
  gating, ceiling, redaction, and test-mode invariants
- **14 helper/codec property tests** (fast-check) — pure-helper invariants
  (redaction, slug, idempotency keys, spend-guard comparison, URL policy) and
  mppx codec round-trips + HMAC tamper detection over generated inputs
- **9 model-invariant property tests** — the combinatorial spend guard
  ("credential sent IFF every guard passes"), canonical-amount rejection across
  every money method, createChallenge↔verifyCredential round-trip + single-field
  tamper, chargeToken succeeded-gate, refundCharge ceiling, hostCategory
  dotted=decimal=hex equivalence, idempotency-key bounds
- **6 whole-flow mutation property tests** — one deterministic test per mutation
  (honest / price inflation / currency swap / credential tamper / expired
  challenge / failed settle); success asserted IFF the flow was honest
- **21 coverage/regression tests** — guard/branch cases each mapped to a
  specific review finding, so a removed guard turns a test red
- **22 adversarial security tests** — attacker's perspective, grounded in
  published research (MPP §11, x402 "Five Attacks" arXiv:2605.11781, AP2
  arXiv:2601.22569, OWASP WSTG, CVE-2025-27611, GHSA-q7pg-9pr4-mrp2):
  payee/recipient swap, price inflation, method downgrade, currency confusion,
  cross-route replay + scope binding, expired credentials, money-parsing
  (negative / `1e3` / `10.00` / unicode / hex / overflow), receipt forgery,
  idempotency mutable-field binding, HMAC delimiter injection, SSRF
  (metadata/private/loopback/userinfo, decimal+hex IP encodings), SCA-bypass,
  no-log redaction, 402-body prompt injection, and Stripe search-query injection

### Security hardening

The buyer `pay` guard pins **amount + currency + payee** (`expectedNetworkId`)
before the credential is minted — because the 402 challenge is unsigned, a
MITM/hostile server can otherwise divert funds. Optional `scope` /
`expectedScope` bind a credential to one route (anti cross-route replay).
Amounts are strictly canonical minor-units (rejecting sign/decimal/exponent/
unicode/hex confusion). Idempotency keys are collision-resistant (SHA-256) and
anchored on the unique HMAC-bound challenge id so distinct charges never
silently collide. Secrets and `spt_` ids are redacted from all surfaced errors,
including library errors.

Resource fetches refuse cloud-metadata, private, loopback, and userinfo URLs
(SSRF), normalizing IPv4 (dotted/decimal/hex) and IPv6 (loopback, IPv4-mapped
`::ffff:*`, NAT64, link-local) literals, and additionally **resolve DNS names
and block any that resolve to an internal address**. Residual (documented):
DNS-rebinding TOCTOU between the resolution check and the actual connection is
not closed — a full defense would pin the resolved IP for the connection; the
practical impact here is bounded because response bodies are never forwarded to
the counterparty and credentials are never sent to a resolved-internal host.

### Live test-mode smoke

The offline suite mocks Stripe, so it can't cover the real API's required-field
contract (three bugs — missing `payment_method`, required
`usage_limits.expires_at`, required `seller_details` — surfaced only live). Run
this minimal smoke after any dependency pin bump or Stripe preview-version
change, with a `sk_test_` key + a `profile_test_…` `networkId` configured:

```
createTestGrantedToken(maxAmount, currency)   # -> a granted spt_ token
chargeToken(sptId, amount, currency)          # -> charge status == succeeded
issueReceipt(chargeId); getCharge(chargeId)   # -> both succeed
```

Verified in Stripe test mode 2026-07-04 (settle path succeeded end to end).
