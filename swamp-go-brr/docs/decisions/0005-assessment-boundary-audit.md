---
issue: gobrr-assessment-boundary-audit
date: 2026-06-17
kind: decision
---

# Assessment-boundary audit: every handoff measures, never trusts a self-report

## Context

Promise Theory / sacred rule 5: an _assessment_ must be an INDEPENDENT
measurement, never the producer asserting its own success (a trusted self-report
is a non-promise). This audits every inter-actor handoff in the gobrr loop for
that property: a give-promise, a bounded use-promise, and an independent
measurement.

## The boundaries (verdicts)

| Boundary                                                            | Verdict             | Why                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| leaf → `report()` green gate                                        | SOUND               | greens ONLY on `verifyExitCode===0`; `changedPaths`/`diff` are host-observed (`jj diff`); `failureKind` is host-produced; `testReport` is advisory and never read by `applyReport`.                                                                                                                                                                                |
| `apply()` `changedPaths`                                            | SOUND               | derived from `jj diff --git` (`parseGitDiffPaths`) + a mode-aware post-apply re-walk tripwire that re-checks every observed path against the allowlist/DENY/symlink rules — never the agent's declared blocks ([0001](0001-source-integration-host-observed-state.md)).                                                                                            |
| `fabric.poll` completion                                            | SOUND               | the driver uses fabric's "done" only to read `rawStdout`; `parseEnvelope` (per-invocation high-entropy nonce fence) + `planApply` + the re-walk + `docker-verify` re-measure. A false "done" → `envelope_parse`/`nonce_mismatch` → `infra_error`, fail-closed.                                                                                                     |
| docker-verify exit code                                             | SOUND               | `exitCode = parseExitSentinel(res.stdout) ?? res.code`. The `__GOBRR_EXIT__:$?` sentinel is appended by the **SSH host shell** after `docker run` returns — the network-isolated, cap-dropped, read-only container cannot forge it (output ordering puts the host sentinel last; the `$`-anchored regex takes the last match). `res.code` fallback is fail-closed. |
| heartbeat `vmId`, `add_followup` spec, `testReport`, `costEstimate` | BOUNDED-SELF-REPORT | advisory or bounded (repoScope/depth/cycle/owner) — never a gate.                                                                                                                                                                                                                                                                                                  |

## Decision (what was hardened)

The named boundaries already measure. The audit's adversarial pass found one
real asymmetry the surface read missed: **`heartbeat()` and `add_followup()`
validated lease OWNERSHIP but not lease EXPIRY**, while `applyReport()` checks
both. An expired-but-unreaped lease could therefore be renewed (resurrected past
its TTL, dodging the scheduler reap) or could still inject a follow-up —
trusting the owner's continued claim without re-measuring the lease's validity.

Both methods now call the existing pure `leaseExpired` and reject a lapsed
lease, making lease validity = (owner AND not-expired) consistently enforced at
every state-transition method. Pinned by method-level tests (expired → throws;
valid → succeeds, so the fix can't be "always throw").

The already-sound invariants are now regression-pinned too: `testReport` is
never the gate; `parseExitSentinel` takes the host's last sentinel (no container
forgery); `parseGitDiffPaths` flags symlinks/gitlinks/mode-changes as
non-regular.

## Consequences / assumptions

- **The sentinel-forgery defense assumes SSH transport integrity.** `sshExecRaw`
  uses `StrictHostKeyChecking=no`; the host shell appends the authoritative
  sentinel, so the container cannot forge a green — but an SSH MITM could. This
  holds only on a trusted private network where host impersonation is out of the
  threat model.
- **`changedPaths` provenance is a driver contract.** `applyReport` consumes the
  `WorkResult.changedPaths` the driver passes; that field MUST be
  `source-integration.apply()`'s `jj`-observed list, not anything
  agent-declared. This is enforced by the driver wiring, not a pure-function
  invariant.
- Unrelated findings surfaced by the audit are filed as separate issues, not
  fixed in this span: `lib-ssh-hardening` (execution timeout + type
  annotations + host-key verification), `si-applied-result-typing` (type the
  `applied` inner-result so the host-observed-vs-declared `changedPaths`
  contract is compile-checked), and `si-defense-in-depth-followups`
  (`isSafeRepoScope` null-byte/percent rejection + `parseGitDiffPaths`
  modified-symlink `index`-line detection). Step-output mismatch escalation
  remains a noted future improvement.
