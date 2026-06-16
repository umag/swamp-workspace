---
issue: si-input-validation-hardening
date: 2026-06-16
kind: pattern
---

# Pattern: prefer a `--` separator over a tight charset for CLI arguments

## Context

`source-integration.apply` passes `args.base` (a jj revision) positionally to
`jj new`. Because exec is via `Deno.Command` with an **array** (no shell), the
only injection vector is **flag injection**: a value starting with `-` is read
as a flag (e.g. `--ignore-immutable`), not a revision.

## Pattern

- Pass a **`--` separator** before the positional argument:
  `["new", "-m", msg, "--", args.base]`. `--` ends flag parsing (clap, getopt,
  …) so the value can never be interpreted as a flag — structural, future-proof.
- Add a **minimal guard** as defense in depth: non-empty, no leading `-`, no
  whitespace (`isSafeRevision`). Keep it minimal.

## Anti-pattern

A **tight charset allowlist** (e.g. `/^[A-Za-z0-9@_./-]+$/`) for a CLI argument
is over-engineered when no shell is involved, and it **false-rejects legitimate
inputs** — jj revsets use `~ ^ :: ( )` etc. The only thing that must be rejected
for flag-safety is a leading `-`; the `--` separator handles the rest.

## Related

Validate side-effectful-method inputs with **pure, unit-tested predicates**
([pure-acl-core](pure-acl-core.md)): `isSafeRepoScope` (absolute, no shell
metacharacters / whitespace / `..`) guards both `apply` and `build_workorder`
before `realPathSync`; `isSafeRevision` guards `args.base`. And read
repo-control files with `lstatSync` (no-follow) so a symlinked `.jj` fails
closed.
