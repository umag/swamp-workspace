# Changelog

All notable changes to `@magistr/swamp-go-brr`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.06.16.3 — source-integration: input-validation hardening

### Changed

- `source-integration` now validates inputs through two pure, unit-tested
  predicates: `isSafeRepoScope` (absolute, no shell metacharacters / whitespace
  / `..`) is enforced in **both** `apply` and `build_workorder` (the latter
  previously had no guard before `realPathSync`), and `isSafeRevision`
  (non-empty, no leading `-`, no whitespace) guards `args.base` before `jj new`,
  which now also passes a `--` separator (defense vs flag injection). The `.jj`
  existence check uses `lstatSync` (no-follow) so a symlinked `.jj` fails
  closed. All defense-in-depth — no live exploit; surfaced by the
  si-apply-multi-edit review.

## 2026.06.16.2 — source-integration: reject duplicate @@NEWFILE paths

### Fixed

- `source-integration` `planApply` rejected a path present in both `@@EDIT` and
  `@@NEWFILE` but not two `@@NEWFILE` blocks for the same path — the second
  silently clobbered the first. The pre-check now also rejects duplicate
  `@@NEWFILE` paths, keyed on the normalized path (so `dir//x.ts` and `dir/x.ts`
  cannot slip past as distinct), returning `envelope_parse` before any write.
  Multiple `@@EDIT` blocks per file remain valid (they fold).

## 2026.06.16.1 — source-integration: cumulative same-file edit fold

### Fixed

- `source-integration` `planApply` lost data when a leaf emitted multiple
  `@@EDIT` blocks for the SAME file: each block was computed against the
  pristine snapshot and pushed as a separate write, so the apply write-loop kept
  only the last block (e.g. a sibling that added a method but dropped its
  import). Blocks for one file are now applied one after another over a per-path
  running copy and folded into a single cumulative write, with `@@OLD`
  inclusion/uniqueness and the `MAX_ENVELOPE_BYTES` cap checked against the
  running content. A path present in both `@@EDIT` and `@@NEWFILE` is rejected
  (`envelope_parse`), and a no-op fold (content unchanged) emits no write.
  Guards stay per block; the apply write-loop and the host-observed
  `changedPaths`/diff are unchanged.

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
