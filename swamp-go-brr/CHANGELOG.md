# Changelog

All notable changes to `@magistr/swamp-go-brr`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.06.15.1 — preflight (+ scaffold), bundled skill, two-leaf TDD

### Added

- `@magistr/swamp-go-brr/preflight` — codebase-agnostic substrate setup. Ensures
  the local OCI registry and digest-pins the codebase's OWN gate image
  (`pin_image`: builds a `buildContext` or pins a prebuilt `sourceImage`,
  pushes, resolves the RepoDigest, pulls it back for the `--network none` gate),
  then emits the run `config` (gate params, `fabric_up` inputs, the vault CEL
  for the OAuth token, and the `si`/`dv`/`fab` create commands). No language
  toolchain is baked in — that lives in the codebase's gate image. Shells to
  `docker` only (never `swamp`, which would deadlock on the per-process
  `__global__` lock).
- Bundled the `swamp-go-brr` driving skill (SKILL.md + inline-loop /
  work-contract / practices / reporting references + trigger evals) into the
  package under `.claude/skills/swamp-go-brr/`, declared via the manifest
  `skills:` list. The loop is driver-free — the agent IS the driver — so the
  cross-model protocol (gobrr → build_workorder → fabric submit/poll → apply →
  docker-verify → report), the sacred rules, and the concurrency gotchas now
  ship with the models instead of living only in one repo.
- `preflight scaffold` — scaffold a greenfield repo for a run: write the
  caller-provided baseline files, `jj git init --colocate`, describe the
  bootstrap change, and return the common base change id. jj-only (no `swamp`),
  toolchain-agnostic (the caller brings the file set).

### Changed

- Skill: surface `preflight` as **Phase 0** (it was implemented but undocumented
  — the top cause of slow runs) via a new `references/preflight.md`: the
  substrate + fabric-readiness + greenfield-scaffold recipe, with
  **per-language** gate presets (TS / Rust / Python), not deno-only.
- Skill: redefined TDD as a **two-leaf, language-agnostic** flow — a **test
  leaf** writes the tests + a signature-only **contract** (gated by a static
  check of the contract), then a **code leaf** (`dependsOn` it) implements
  against the contract and is gated by running the hidden tests, seeing the
  signature but never the assertions. Added leaf-authoring patterns
  (`@@NEWFILE`-on-absent; test-leaf vs code-leaf) and the fabric-readiness +
  per-kind gate-command gotchas. No gobrr change — the driver picks the gate
  command per leaf kind.

## 2026.06.12.1 — source-integration + driver-free loop

### Added

- `@magistr/swamp-go-brr/source-integration` — the host code-ownership /
  allowlist-ACL actor: `build_workorder` (read the allowlist file slice into the
  leaf prompt, no-clone) and `apply` (parse the `@@EDIT` envelope, apply each
  task as a **per-task base-isolated** jj change behind a **realpath-anchored**
  allowlist ACL with a DENY set + mode/symlink/gitlink rejection + size caps,
  return host-observed `changedPaths` + a secret-scrubbed diff). Shared path-ACL
  kernel in `extensions/models/lib/acl.ts`.

### Changed

- `gobrr` is now a strictly PURE DAG state machine: its JSON `parseEnvelope` is
  removed (envelope parsing moved to `source-integration`, which owns the
  canonical `@@EDIT` wire format + the nonce-fence forgery defense).
  `unsafe_change` added to the failureKind vocabulary. The loop is driven inline
  (no driver script).
