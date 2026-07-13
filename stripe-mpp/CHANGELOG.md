# Changelog

## 2026.07.13.1

Dependency bump: `mppx@0.8.5 → 0.8.6` (patch). No breaking changes to the
Challenge / Credential / Receipt codecs or the Mppx / Stripe server APIs.

- Upstream 0.8.6 relevant to this model: _preserved method-specific extension
  fields on receipts_ per the Payment-Receipt spec. The remaining 0.8.6 fixes
  are Tempo/crypto-path only (not exercised — this model is fiat/SPT).
- Re-bundle republishes with 0.8.6 inlined (extension deps are bundled at build
  time). Spec-fixture contract tests (`stripe_mpp_test.ts`) re-run green against
  0.8.6; full 97-test suite + property soak unchanged.

## 2026.07.03.1

Initial beta release of `@magistr/stripe-mpp` — buyer and full seller sides of
Stripe's Machine Payments Protocol (HTTP-402 "Payment" auth,
draft-ryan-httpauth-payment-01), fiat via Shared Payment Tokens.

- 14 methods: probe, mintToken, pay, getIssuedToken, revokeToken,
  createChallenge, verifyCredential, chargeToken, issueReceipt, getCharge,
  listCharges, refundCharge, getGrantedToken, createTestGrantedToken.
- Built on mppx@0.8.5 (MPP protocol) + stripe@22.4.0-beta.1 preview SDK (SPT
  lifecycle). Swamp-native layer: audit trail, amount+currency+payee+realm+
  scope spend guard, SHA-256 idempotency keys, SSRF-hardened resource fetches
  (IPv4/IPv6 literals + DNS resolution), error redaction, test-mode gates.
- 97 offline tests + env-overridable property soak (FC_NUM_RUNS) validated at
  10000 cases; seller settle path live-verified in Stripe test mode.

**Beta:** rides Stripe preview API channels (exact-pinned deps); interfaces may
shift with the drafts. US-only (Stripe SPT). Fiat only; Tempo deferred.
