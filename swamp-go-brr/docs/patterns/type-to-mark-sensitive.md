---
issue: si-applied-result-typing
date: 2026-06-18
kind: pattern
---

# Type an opaque field before you can mark it sensitive

## Pattern

A field hidden inside `z.unknown()` / `z.record(string, z.unknown())` cannot
carry `.meta({ sensitive: true })` — there is no schema node to annotate. If an
opaque blob holds secret-bearing data (a scrubbed diff, a captured stdout),
replacing the `unknown` with a concrete schema is a PREREQUISITE for downstream
redaction, not a separate nicety.

## Why it matters here

`si-applied-resource-lifetime` bounded the `applied` resource's TTL but could
not mark its `diff` sensitive — the field was inside `z.unknown()`. Typing the
result (`si-applied-result-typing`) is what finally let `diff` be
`z.string().meta({ sensitive: true })`. Scrubbing-at-write stays the PRIMARY
control (see `scrub-at-the-storage-boundary`); the sensitive marking is
defense-in-depth that typing unlocks.
