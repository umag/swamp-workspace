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

## History: the NUL-byte domain separator is now a plain escape

`idemKey` (roughly line 320) SHA-256-hashes `` `${op}\x00${input}` ``, where
`\x00` is the **NUL character** used as a domain separator between `op` and
`input`. That separator is load-bearing: it is what keeps two distinct logical
inputs from ever hashing to the same idempotency key (see the "INJECTIVE —
distinct inputs → distinct keys" property in `stripe_mpp_property_test.ts`), so
it must never be removed or replaced with an ordinary character that could
plausibly appear inside `op` or an encoded `input` part.

Until the 2026.09.19.2 release, that NUL was written as a **raw 0x00 byte**
pasted directly into the template literal, rather than the two-character `\x00`
escape sequence. Because of that raw byte, `file` reported the source as `data`
and plain `grep` treated it as binary and silently skipped it — which could
produce a false "the model has no `npm:` imports" conclusion, and anyone
auditing this file needed `grep -a` (or to read the file directly) to see its
contents at all.

The raw byte has been replaced with the `\x00` escape, which produces the exact
same runtime string (same bytes fed to `TextEncoder`, same SHA-256 digests, same
idempotency keys — verified by recomputing `idemKey` for fixed inputs before and
after the change and diffing the hex output) while making the file ordinary
UTF-8 text. `file` no longer reports it as `data`, and plain `grep` no longer
skips it — **this hazard no longer applies**, and `stripe_mpp.ts` can be grepped
like any other file in this repo. Do not reintroduce a raw NUL byte here "to
match the docs" or out of habit from this history — the escape is the correct,
permanent form.
