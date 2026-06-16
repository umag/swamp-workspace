---
issue: si-apply-multi-edit-same-file
date: 2026-06-16
kind: anti-pattern
---

# Anti-pattern: applying sequential edits against the pristine snapshot

## What we did wrong

`planApply` computed each `@@EDIT` against the immutable `snapshot[e.path]` and
pushed one `PlannedWrite` per block. With N blocks on one file the apply
write-loop wrote N times (last wins) and each write carried only its own change
— so a sibling that added a method but whose earlier block added the import
shipped without the import.

## Why it is wrong

Edits to the same file are not independent: block 2's `@@OLD` must match the
result of block 1, and the final file must contain every block's change.
Computing each against the original loses all but the last, and the write-loop
clobbers silently.

## Do this instead

- Seed a per-path running working-copy: `const running = { ...snapshot }` (copy
  by value; never mutate the caller's snapshot).
- Apply blocks in envelope order against the running content, writing each
  result back (`running[e.path] = next`), so `@@OLD` inclusion/uniqueness and
  the `MAX_ENVELOPE_BYTES` cap are all evaluated on the folded result.
- Emit exactly one write per path (sorted), skipping a no-op fold whose result
  equals the original snapshot.
- Reject (on the normalized path) a path that appears in both `@@EDIT` and
  `@@NEWFILE`, or as `@@NEWFILE` more than once — both are silent-clobber
  routes.
