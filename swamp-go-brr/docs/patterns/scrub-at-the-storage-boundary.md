---
issue: gobrr-record-step-outputs
date: 2026-06-16
kind: pattern
---

# Scrub secrets at the storage boundary, unconditionally — not at the caller

## Pattern

When code persists text that originates from an untrusted/observed source (a
subprocess's stdout, a leaf agent's output, a captured diff), redact secrets in
the **function that writes the record**, unconditionally — do not rely on the
caller having already scrubbed it.

In `buildStepOutput`, `verifyTail` (raw docker-verify stdout) is scrubbed at the
point it becomes a stored field:

```ts
verifyTail: scrubSecrets(input.verifyTail).slice(-VERIFY_TAIL_BYTES),
```

The driver assembles `verifyTail`, but `buildStepOutput` is the authoritative,
last-line scrub site. A driver that forgets to scrub cannot leak — the storage
boundary always redacts. (The `diff` field is the dual case: it arrives ALREADY
scrubbed at the apply boundary, so `buildStepOutput` re-bounds it only and does
not re-scrub — comment the asymmetry so a maintainer doesn't "fix" one to match
the other.)

## Why

Phase-5 security review caught that delegating the scrub to the caller is
exactly how a secret leaks: a new persisted field (`verifyTail`) is wired
through a driver that scrubbed the diff but not the new tail. Putting the scrub
in the writer makes the guarantee independent of every call site.

## Supporting practices

- Keep the scrubber **pure and shared** (`lib/scrub.ts`) so both boundaries
  (apply diff, step-output verifyTail) use one implementation; import it from
  `lib/`, never across model files, to avoid a cycle.
- Prefer **over-redaction of audit text** to leaking: the generic high-entropy
  pattern requires a letter AND a digit AND ≥8 chars, so plain identifiers
  survive while real `key=value` secrets are caught.
- Use length-anchored prefix patterns with `{n,}` (not `{n}`) so a longer token
  (e.g. a GitLab/GitHub refresh token) is redacted in full, not just its first
  _n_ chars.
- Never commit secret-SHAPED test fixtures as contiguous literals — split the
  provider prefix across string concatenation (`"gl" + "pat-" + body`) so GitHub
  push protection doesn't flag the fixture as a live credential; the runtime
  value is unchanged.
