---
issue: si-apply-multi-edit-same-file
date: 2026-06-16
kind: pattern
---

# Pattern: ACL/size/uniqueness checks live in the pure planApply core

## Pattern

`planApply` is the unit-tested Anti-Corruption Layer (sacred rule 1) between
untrusted leaf output and the trusted jj repo. Keep the allowlist/DENY/traversal
guard, the `MAX_ENVELOPE_BYTES` size cap, the `MAX_BLOCKS` count cap, and
`@@OLD` inclusion/uniqueness **inside this pure function** (no I/O, fully
unit-testable).

The side-effectful `apply` only does jj/filesystem work plus an independent
post-apply `jj diff` tripwire that re-walks the change and fails closed on any
out-of-allowlist / denied / non-regular path.

## Why

- Rejections happen before any `jj new`, so a bad envelope never produces a
  partial change.
- The checks are exhaustively unit-tested without a filesystem; the tripwire is
  a second, independent layer (defense in depth).
- Pushing checks into the I/O path would lose testability and weaken the
  boundary — resist it even when it looks like an optimization (e.g. hoisting
  `guard()` out of the per-block loop).

## Applied here

The same-file fold added running-content checks but kept all of them in
`planApply`; `apply` and the tripwire were untouched.
