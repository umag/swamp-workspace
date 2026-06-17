# WorkOrder framing A/B pilot

Adoption gate for the desired-state WorkOrder framing (issue
`gobrr-desired-state-workorders`, ADR
[0006](../../../docs/decisions/0006-desired-state-workorder-framing.md)).

`WORKORDER_FRAMING` in `extensions/models/source_integration.ts` stays
`imperative` until this pilot shows **desired-state ≥ imperative** AND a human
signs off. This directory is **opt-in**: it lives outside the
`extensions/models/` test glob, so `deno task test` never runs it.

## Two gates, not one

1. **Deterministic (CI).** Prompt well-formedness for both framings is pinned by
   `extensions/models/source_integration_framing.test.ts` (byte-identity of the
   imperative path, single nonce fence, slices inlined, scaffold above slices,
   no re-scrub, gate-leak forbidden-terms). That suite runs in CI and must stay
   green. It is **prompt-hygiene**, not a security boundary — the real invariant
   is that `verifyCommand` is absent from `build_workorder`'s argument schema.

2. **Live A/B (this pilot, manual).** Compares how the two framings actually
   perform when run as leaves. Non-deterministic, so it is human-judged.

## Protocol (pinned)

- **Inputs** are pinned in `fixture.yaml`: `leafModel`, `leafEffort`,
  `verifyCommand`, and a small **synthetic** task set (no secrets; vault CEL
  references only if any credential is ever needed).
- **Decision criterion:** desired-state ≥ imperative, measured as **≥ 5/5 clean
  envelopes** (`docker-verify` exit 0) per framing across the fixture, plus a
  human spot-check of two diffs. A tie counts as "≥" (desired-state adopted only
  when it does not regress).
- **Sample:** run each framing on each fixture task; repeat the full fixture 5×
  per framing (the leaf is non-deterministic). Record per-framing pass-rates.

## Running it

Deterministic half — build and diff both framings' prompts (no network):

```bash
deno run --allow-read tests/eval/workorder-framing/pilot.ts
```

Live half — for each printed prompt, submit it through the gobrr fabric exactly
as the inline loop does (`fab submit` with `gitRepoUrl=""`, then `fab poll`),
apply via `si apply`, and gate with `dv verify` using the pinned
`verifyCommand`. Tally `docker-verify` exit codes per framing. This step needs
the Firecracker fabric substrate and is **not** automated here.

## On a pass

If desired-state clears the bar and the human signs off:

1. Record the per-framing pass-rates in ADR 0006 (replace "Pilot result:
   PENDING").
2. Flip `WORKORDER_FRAMING` to `desired-state`.
3. Collapse `buildWorkorderPrompt` to the single chosen path (remove the losing
   branch and the `framing` parameter).
4. Refresh the stale docs listed in ADR 0006.

## Envelope-format parse-rate spot-check (issue gobrr-envelope-format-hardening)

The close-marker hardening (`@@ENDEDIT`/`@@ENDFILE` requirement + pre-fence
self-check) is gated in CI by the unit tests, NOT by a live run. A live check is
**recommended but optional** and, if run, must be **same-session** (no baseline
reuse — fabric/model variance across sessions is a confound):

1. Build the leaf prompts twice — once from the pre-hardening
   `buildWorkorderPrompt` (e.g. a git stash / prior commit) and once from the
   hardened one — for the same hard-fixture tasks (`slug`/`account`, where the
   `@@ENDEDIT` drops were observed).
2. Run BOTH prompt versions through the fabric in the **same** session (same
   `leafModel`/`leafEffort`/fixture), N ≥ 15 per framing.
3. Tally the `envelope_parse` failure rate per version. "Not worse" means the
   hardened prompt's parse-failure rate ≤ the pre-hardening rate **from that
   same session**. Expected effect is small (the drops were balanced +
   non-terminal).
