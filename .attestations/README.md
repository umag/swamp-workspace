# Attestations

One JSON manifest per attested commit, named `<commitSha>.json`, produced by
the `attest` method of `@magistr/issue-lifecycle` (Phase 5b — see that
extension's `.claude/skills/issue-lifecycle/references/attestation.md`).

A manifest records what was verified before the PR was opened: the commit, a
SHA-256 checksum per config input (review skills, `agent-constraints/`,
`CLAUDE.md`, task definitions), each mechanical control's status and duration,
and each reviewer's open-finding counts.

`.github/workflows/ci.yml`'s `attestation` job validates the manifest for the
PR head and, on a match, lets `deno-check` skip re-executing controls the
verification loop already ran. Validation **fails closed**: a missing,
stale, unparseable or checksum-mismatched manifest runs the full matrix. An
unattested PR is normal — it just pays for a CI run.

Commit the manifest in the same commit it attests (`git commit --amend`), or
`commitSha` will name the parent and the job will correctly reject it.

Manifests are append-only history; do not edit one by hand. Regenerate by
re-running `verify` and `attest`.
