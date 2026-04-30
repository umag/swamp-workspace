---
name: review-adversarial
description: >
  Adversarial code review that assumes code is broken until proven otherwise.
  Reviews across 7 dimensions: credentials, logging, error handling, testing,
  idempotency, API contracts, resource management. For core domain changes,
  extension code, and anything touching state or external APIs. Triggers on
  "adversarial review", "review adversarial", "/review-adversarial", "assume
  broken", "stress test code", "break my code", "find bugs".
---

# Adversarial Review

Assume the code is broken until proven otherwise. Your job is to find failure
modes, not confirm correctness.

## MANDATORY Output Format

You MUST structure your ENTIRE response using this EXACT format. Do NOT skip
sections. Do NOT omit dimensions that pass — mark them PASS explicitly.

```
## Adversarial Review | <file or scope description>

### Verdict: FAIL

### Dimension 1: Credentials & Secrets
**Status:** CRITICAL
- [filename:line] Hardcoded API key in source code
  **Risk:** Key exposed in version control and logs
  **Fix:** Move to environment variable or vault with `.meta({ sensitive: true })`

### Dimension 2: Logging Quality
**Status:** PASS

### Dimension 3: Error Handling
**Status:** HIGH
- [filename:line] `writeResource` called before validation
  **Risk:** Partial write on validation failure leaves inconsistent state
  **Fix:** Move validation before any write calls

### Dimension 4: Testing Completeness
**Status:** HIGH
- [filename:line] No test for API error response (4xx/5xx)
  **Risk:** Unknown behavior on external failure
  **Fix:** Add test with mocked error response

### Dimension 5: Idempotency & Resilience
**Status:** PASS

### Dimension 6: API Contracts
**Status:** MEDIUM
- [filename:line] No `AbortSignal` timeout on fetch call
  **Risk:** Request hangs indefinitely on network issues
  **Fix:** Add `signal: AbortSignal.timeout(30_000)` to fetch options

### Dimension 7: Resource Management
**Status:** PASS

### Summary
Dimensions reviewed: 7
CRITICAL: 1 | HIGH: 2 | MEDIUM: 1 | LOW: 0
Verdict: FAIL
```

**Rules for this format:**

- The header MUST be `## Adversarial Review | <scope>`.
- The verdict MUST appear both after the header AND in the Summary.
- ALL 7 dimensions MUST appear, numbered 1-7 in order, even if PASS.
- Every finding MUST include `[file:line]`, `**Risk:**`, and `**Fix:**`.
- The Summary MUST list counts for all four severity levels.
- Verdict is FAIL if any CRITICAL or HIGH finding exists. Otherwise PASS.

## When to Run

- After writing new code, before tests
- After significant refactoring
- Before publishing packages or deploying
- On any code touching external APIs, state, or credentials

## The 7 Dimensions

### 1. Credentials & Secrets

Flag any hardcoded secrets or credentials visible in the code under review. For
the full credential audit (vault annotations, env-based auth, scoping), defer to
`/review-security`. Here, just note obvious exposure. Severity: CRITICAL for
exposure found, PASS if none visible.

### 2. Logging Quality

Assume the log is the only evidence after failure. Check: missing
entry/completion logs, string interpolation instead of structured placeholders,
wrong log levels, sensitive data in logs. Severity: HIGH for missing
entry/completion logs, MEDIUM for level mistakes.

### 3. Error Handling

Assume every external call will fail. Check: writes before validation (partial
state), broad try/catch swallowing errors, non-descriptive error messages,
missing HTTP status/body in errors, no transient vs permanent error distinction.
Severity: CRITICAL for partial writes, HIGH for swallowed errors.

### 4. Testing Completeness

Assume untested code is broken. Check: missing test context usage, no failure
path tests, no injectable client pattern for external APIs, missing edge case
tests (empty input, already-exists, not-found, invalid input). Severity: HIGH
for missing failure paths, MEDIUM for missing edge cases.

### 5. Idempotency & Resilience

Assume the operation will be retried. Check: create throws on "already exists"
instead of returning existing, delete throws on 404 instead of succeeding,
orphaned resources on partial failure, no retry with backoff for transient
errors. Severity: HIGH for non-idempotent CRUD, MEDIUM for missing partial
failure handling.

### 6. API Contracts

Assume the API response is wrong. Check: no response validation before field
access, missing pagination for list endpoints, no `Retry-After` handling, no
`AbortSignal` timeout on network requests, URLs/methods not matching docs.
Severity: HIGH for missing validation, MEDIUM for missing pagination.

### 7. Resource Management

Assume cleanup won't happen automatically. Check: file handles not closed in
finally blocks, temp files not cleaned on error paths, cloud resource IDs not
tracked, leaked AbortControllers/event listeners, missing `using` or
try/finally. Severity: HIGH for leaked cloud resources, MEDIUM for leaked local
resources.

## Severity Rules

- **CRITICAL**: data loss, security breach, credential exposure
- **HIGH**: silent failure, data corruption, resource leak
- **MEDIUM**: degraded behavior, missing edge case handling
- **LOW**: style issue, minor improvement opportunity

See [references/dimensions.md](references/dimensions.md) for expanded
checklists.
