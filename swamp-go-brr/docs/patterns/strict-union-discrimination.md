---
issue: si-applied-result-typing
date: 2026-06-18
kind: pattern
---

# Strict members make a tagless z.union genuinely discriminate

## Pattern

When two object shapes share NO literal discriminant tag (so
`z.discriminatedUnion` is unavailable), model the union as
`z.union([A.strict(), B.strict()])`. `.strict()` makes each member reject
unknown keys, so a "hybrid" object that carries fields from BOTH shapes fails
both members and is rejected — instead of being silently accepted by whichever
member's required fields it happens to satisfy (extra keys stripped).

## Why

A non-strict `z.object` ignores extra keys. With a plain `z.union`, the first
member whose required fields are present wins, silently dropping the other
shape's fields. For a result that is "success XOR failure", that means a record
carrying both a success marker and a `failureKind` could be processed as a
success — a real data-integrity hole, not just a typing nicety.

## Pin it

Add a test that the hybrid is rejected:
`AppliedTaskResultSchema.safeParse({ ...SUCCESS, failureKind, note })` must
fail. A schema that drops `.strict()` will pass this object and fail the test.
