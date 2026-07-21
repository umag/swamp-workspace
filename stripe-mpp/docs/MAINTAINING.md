# Maintaining `@magistr/stripe-mpp`

Maintainer notes harvested from the issue lifecycle. Not shipped with the
extension (not in `manifest.yaml` `additionalFiles`).

## Bumping the `mppx` pin (it is a RUNTIME dependency)

`mppx` is **not** a test-only oracle. The model imports it at runtime
(`extensions/models/stripe_mpp.ts`) and delegates the MPP
challenge/credential/receipt codec and the HMAC challenge-id binding to it. A
version bump therefore changes the **shipped bundle's behaviour**. Procedure:

1. Bump **every** `npm:mppx@<v>` specifier — the two in `stripe_mpp.ts` (bare +
   `/server`) and one or two in each of the seven `stripe_mpp_*_test.ts` files
   (a whole-file `0.8.x` → `0.8.y` replace catches the doc-comment literal at
   `stripe_mpp_test.ts:2` too). Leave `npm:stripe@…` alone unless the
   `public-preview` dist-tag actually moved (`npm view stripe dist-tags`).
2. Bump **both** version literals to today's CalVer: `manifest.yaml` `version:`
   **and** the model `version:` in `stripe_mpp.ts` (`export const model`). CI
   (`.github/workflows/ci.yml`, "Check model version matches manifest")
   hard-fails if they differ, and the publish job fires on the **manifest** bump
   — miss either and nothing republishes.
3. Regenerate `deno.lock` cleanly (`rm deno.lock && deno task check`). deno's
   incremental re-lock leaves the old `mppx@0.8.x` specifier orphaned; a fresh
   regen keeps only the new pin (verify: no stale specifier, sha512 integrity
   present).
4. Gate on the suites: `deno task check` first (fast-fail on a signature
   change), then `deno task test` (contract + adversarial/tamper are co-equal
   hard gates, must pass **unmodified**) + `deno task test:soak`.
5. Prove the wire format is unchanged with **durable** evidence, not just green
   tests: the crypto primitives (`@noble/hashes` HMAC-SHA256, `@noble/curves`,
   `@scure/*`) should be byte-identical in the regenerated lock, and the
   upstream release notes for the intervening versions should show no change to
   the HMAC binding, key derivation, domain separators, or the codec. The
   round-trip suites cannot detect a self-consistent wire change on their own —
   that is what the golden vectors in `stripe_mpp_test.ts` are for.

## Gotcha: plain `grep` silently skips `stripe_mpp.ts`

`stripe_mpp.ts` embeds a **raw NUL byte** (in `idemKey`, roughly line 318) as
the SHA-256 idempotency-key domain separator (`` `${op}\x00${input}` ``).
Because of that NUL, `file` reports the source as `data` and plain `grep` treats
it as binary and **silently skips it** — which can produce a false "the model
has no `npm:` imports" conclusion. Always use `grep -a` (or read the file
directly) when auditing this file.
