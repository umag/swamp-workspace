# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.01.1

Dependency bump: `mppx@0.8.12 → 0.8.14` (patch, preview channel, bundled runtime
dep) + `linkCliVersion` drift-detection default `0.9.0 → 0.10.1`
(fixture/default only, no bundle impact).

- **mppx**: NO-OP on the fiat/SPT wire contract, confirmed on durable evidence.
  `deno task check` stayed clean (no method signature the model calls moved) and
  the full offline suite (121 tests) + the 10000-run property soak pass
  **UNMODIFIED**, including the byte-exact `stripe_mpp_test.ts` golden-vector
  test — the Challenge / Credential / Receipt codec, HMAC challenge-id binding,
  key derivation, and domain separators are unchanged. The 0.8.13/0.8.14 deltas
  are Tempo/SQLite/stablecoin patch changes plus additive APIs this fiat/SPT
  model does not import.
  - **Watch item**: 0.8.14 marks the legacy combined payment-verification hooks
    DEPRECATED (not removed, not yet used by this model) — a future mppx major
    that removes them will need re-verification, not just a version bump.
- **link-cli**: `@stripe/link-cli` re-pinned `0.9.0 → 0.10.1` on **release-notes
  evidence only** (additive/security changes, no documented stdio-MCP contract
  change) — **not live-verified**, Link is still US-only and the maintainer's
  account is EU (`stripe_mpp_live_test.ts` stays `ignore`d). The bump is
  required regardless: the drift-detection preflight (`lib/link_cli.ts`) rejects
  a real 0.10.1 binary unless `linkCliVersion` is bumped to match. Updated the
  three fixture literals (`lib/link_cli.test.ts`, `stripe_mpp_methods_test.ts`,
  `stripe_mpp_live_test.ts`) alongside the default; the `mpp_pay` /
  `paySpendRequest` spend-by-reference path stays on the same watch list as the
  rest of the consumer-buyer surface for the next real observation.
- Transitive drift from the lockfile regeneration: `viem 2.55.4 → 2.55.10`, `ox`
  gains a `0.14.33` peer variant alongside the existing `0.14.30` (mppx/viem
  resolve different ox ranges), `mppx` picks up the matching `viem@2.55.10` peer
  combination. `stripe` stays `22.4.0-beta.1` and `@stripe/stripe-js` stays
  `9.9.0` (both unchanged); the crypto primitives are byte-identical in the
  regenerated lock (`@noble/hashes@1.8.0`, `@noble/curves@1.9.1`,
  `@scure/base@1.2.6`, `@scure/bip32@1.7.0`, `@scure/bip39@1.6.0`) and every dep
  keeps its sha512 integrity hash.
- Re-bundle republishes with `0.8.14` inlined (extension deps are bundled at
  build time). All fixtures stay synthetic (RFC 2606 hosts, `_test_fixture_`
  ids) — no vectors were re-derived, since the golden test passed unmodified.

## 2026.07.21.2

Dependency bump: `mppx@0.8.6 → 0.8.12` (patch, preview channel). No breaking
changes to the Challenge / Credential / Receipt codecs or the Mppx / Stripe
server APIs.

- Wire format unchanged, on durable evidence: the crypto primitives are
  byte-identical in the regenerated lock (`@noble/hashes@1.8.0` backs the
  HMAC-SHA256 id-binding, `@noble/curves@1.9.1`, `@scure/*` all unmoved), and
  the upstream review of the `0.8.6..0.8.12` releases (0.8.7, 0.8.8, 0.8.9,
  0.8.11, 0.8.12 — 0.8.10 was never published) found **no** change to the HMAC
  challenge-id binding, key derivation, domain separators, or the
  challenge/credential/receipt serialization. The 0.8.7..0.8.12 deltas are
  Celo/Tempo/session-voucher and `mppx validate`-command code this fiat/SPT
  model does not import.
- Transitive drift from the lockfile regeneration: `viem 2.54.2 → 2.55.4`,
  `ox 0.14.29 → 0.14.30`, `@stripe/stripe-js 9.8.0 → 9.9.0`, and a prerelease
  inversion `@modelcontextprotocol/server 2.0.0-beta.2 → 2.0.0-alpha.4` (pulled
  via `incur`, off the crypto/wire path), plus test-only dedupes. `stripe` stays
  `22.4.0-beta.1` (unchanged — still the current public-preview dist-tag); every
  dep keeps its sha512 integrity hash.
- Re-bundle republishes with `0.8.12` inlined (extension deps are bundled at
  build time). Regression coverage: the full suite (120 offline tests) + the
  10000-run property soak re-run green against `0.8.12`, and the spec-fixture
  contract (`stripe_mpp_test.ts`) and adversarial/tamper
  (`stripe_mpp_adversarial_test.ts`) suites pass UNMODIFIED.

## 2026.07.21.1

Consumer buyer (Link grant): a human WITHOUT a Stripe account can now fund agent
payments from their **Link wallet**. Five methods behind a new `lib/link_cli.ts`
anti-corruption layer that drives Stripe's `link-cli` as an MCP server over
**stdio** (`link-cli --mcp`) — deliberately NOT its HTTP `serve` mode, which
binds all interfaces with `Access-Control-Allow-Origin: *` and no auth (see
`SPIKE-link-cli.md`).

- `listConsumerPaymentMethods`, `createSpendRequest`, `getSpendRequest`,
  `cancelSpendRequest`, `paySpendRequest`.
- The grant is spent BY REFERENCE (`mpp_pay --spendRequestId`); the model never
  holds a raw `spt_` (persists `lsrq_` only, strictObject resources). No Link
  token custody — link-cli owns its device-flow session on disk; the subprocess
  is spawned `clearEnv`.
- `createSpendRequest` is the PRIMARY binding guard (anchored payee, amount cap
  `≤500000` + `$0.50` USD floor, `context≥100`, response-echo) before the
  consumer is prompted; `paySpendRequest`'s pre-flight is advisory only.
- New non-secret globals: `linkCliPath` (absolute, fail-closed),
  `linkCliVersion` (drift-detection preflight), `allowLiveGrants` (default false
  → test mode).
- Extracted `pay`'s spend-guard into the shared `challengeGuardViolation()`
  helper (behaviour-preserving).
- **US-only** (Stripe Link) and inert without an authenticated co-located
  link-cli session; the four consumer methods fail closed, the existing 14 are
  unaffected. **Not live-verified** (Link is US-only; the maintainer is EU) —
  built on the observed v0.9.0 tool contract, pinned by fixtures.

## 2026.07.16.2

Housekeeping: aligned the model `version` field with the manifest version so the
published model type version and the package version do not drift (the CI
model-version check enforces this).

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
