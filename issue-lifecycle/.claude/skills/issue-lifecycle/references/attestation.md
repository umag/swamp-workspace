# Phase 5b: Attestation

## Prerequisites

- State: `resolved` — code review exited clean and the human called
  `resolve_findings`
- A verification round exists ([verification.md](verification.md)) with every
  required control `pass`

Phase 5b emits the **attestation manifest**: structured evidence of what was
verified, against which commit, under which configuration. It is what lets CI
validate in seconds instead of re-executing everything the lifecycle already
ran.

This phase is optional in the state machine (`complete` accepts `resolved`
directly) and **mandatory in practice** for any change that will open a PR
against a repo whose CI validates attestations.

## What the manifest contains

| Field             | Why it is there                                              |
| ----------------- | ------------------------------------------------------------ |
| `commitSha`       | Binds the evidence to exactly one tree                       |
| `configChecksums` | SHA-256 per config input — the independently verifiable half |
| `controls[]`      | Per-control status, exit code, duration, runner              |
| `reviews[]`       | Per-reviewer verdict and open-finding counts by severity     |
| `runner`          | Which environment produced the results                       |
| `producedBy`      | Hostname or worker id                                        |
| `modelVersion`    | Which model version produced the manifest                    |
| `planVersion`     | Which plan revision the work implements                      |

The split matters. **Config integrity is independently verifiable** — a
validator recomputes every digest from the PR tree and compares, so nobody has
to take your word for which review prompts and constraints were in force.
**Result integrity is trusted** to whoever ran the controls, which is why
`runner` is recorded and why a control needing higher assurance can be moved to
a `managed` tier rather than being asserted from a laptop.

Do not oversell this. An attestation produced on a developer machine and one
produced on an ephemeral managed runner carry different weight, and the manifest
says which you have.

## Step 1: Choose the config paths

Checksum everything that shaped the verification. At minimum:

- every active matrix reviewer's `SKILL.md` and its `references/`
- `agent-constraints/*.md` — including `verification-controls.md`
- the repo `CLAUDE.md`
- `deno.json` (the task definitions the controls invoke)
- `quality.yaml` where the repo has one

Paths are repo-relative. A path that cannot be read makes `attest` **refuse**
rather than silently omit the entry — an omitted checksum would let a deleted
constraints file validate cleanly.

## Step 2: Attest

```bash
swamp model method run <issue-name> attest --input "{
  \"commitSha\": \"$(git rev-parse HEAD)\",
  \"repoDir\": \"$(pwd)\",
  \"configPaths\": [\"agent-constraints/verification-controls.md\", \"CLAUDE.md\", \"deno.json\"],
  \"producedBy\": \"$(hostname)\"
}"
```

`attest` re-checks every gate before writing anything: a verification round
exists, every required control passed, no reviewer recorded FAIL, zero open
CRITICAL/HIGH, every config path readable. It **asserts**; it does not approve.
It cannot be used to wave through work that failed a gate — if it refuses, the
refusal is the finding.

State moves `resolved` → `attested`.

## Step 3: Commit the manifest, then open the PR

Order matters. The manifest must be **in the tree the PR proposes**, and it must
name that tree's commit.

```bash
swamp data get <issue-name> attestation --json > .attestations/<commitSha>.json
git add .attestations/<commitSha>.json
git commit --amend --no-edit    # keeps commitSha == the attested commit
```

Amending is what keeps `commitSha` honest. Committing the manifest as a _new_
commit changes HEAD, so the manifest would name its own parent and CI would
reject it — correctly.

Then open the PR.

`attest` accepts an optional `prUrl`, which is the lifecycle's first-class PR
link — pass it in the `attest` call when the PR already exists (a re-attest
after a review round, say). For the common case where the PR is opened _after_
attesting, record the URL in the human-facing summary; `attest` is guarded on
`resolved` and cannot be re-run from `attested` just to add a link.

## Step 4: What CI does with it

CI recomputes the config checksums from the PR tree, checks `commitSha` against
the PR head, and confirms every required control passed. On a match it skips
re-executing those controls. On **any** mismatch — missing manifest, bad
checksum, wrong SHA, unreadable JSON — it runs the full matrix instead.

The gate fails **closed to re-execution**, never open to a pass. A validator
that cannot verify the evidence has learned nothing, and "learned nothing" must
cost a CI run, not buy a green check.

CI keeps running what the attestation cannot speak to: compliance ratchets,
property soaks, and live canaries. Those are independent outcome verification —
they check the change from outside, on infrastructure the lifecycle does not
control.

## Next phase

[knowledge-harvest.md](knowledge-harvest.md) — `harvest` accepts `attested`. Or
call `complete` directly; it accepts `resolved`, `attested` and `harvested`.
