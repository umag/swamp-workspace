---
name: review-code
description: >
  General code review for CLAUDE.md compliance, DDD pattern adherence, TDD
  compliance, type safety, import hygiene, and code organization. The primary
  reviewer — runs on every significant code change. Outputs structured findings
  with severity levels. Triggers on "code review", "review code", "check my
  code", "/review-code", "review changes", "review my changes".
---

# Code Review

The general-purpose reviewer. Checks every significant code change against
project conventions, architecture rules, and quality standards.

## MANDATORY Output Format

You MUST structure your ENTIRE response using this EXACT format. Do NOT skip
severity sections — include all four even if empty. The PASSED section MUST list
categories that had no findings.

```
## Code Review | src/services/order_service.ts

### Verdict: REQUEST_CHANGES

### CRITICAL (blocks merge)
- [src/services/order_service.ts:14] Hardcoded API key `sk-abc123` in source
  **Fix:** Move to environment variable or vault

### HIGH (should fix before merge)
- [src/services/order_service.ts:42] No test file for new service
  **Fix:** Create `order_service.test.ts` with success and failure path tests
- [src/services/order_service.ts:8] `npm:lodash` imported without pinned version
  **Fix:** Pin to exact version: `npm:lodash-es@4.17.21`

### MEDIUM (suggested improvement)
- [src/services/order_service.ts:27] Error message "failed" lacks context
  **Fix:** Include operation name and resource: "Failed to create order {id}: {reason}"

### LOW (minor/style)
- [src/services/order_service.ts:3] Class named `OrderProcessor` uses technical jargon
  **Fix:** Rename to `OrderFulfillmentService` using domain language

### PASSED
- CLAUDE.md compliance: all project rules satisfied
- Aggregate boundaries: no direct child access
- Type safety: no `any` types or unsafe casts
- Code organization: single responsibility, appropriate blast radius

---
Summary: 1 critical, 2 high, 1 medium, 1 low findings
Verdict: REQUEST_CHANGES
```

**Rules for this format:**

- Header MUST be `## Code Review | <scope>`.
- Verdict MUST appear both after the header AND in the Summary.
- ALL four severity sections MUST appear (CRITICAL, HIGH, MEDIUM, LOW) even if
  empty — write "None" for empty sections.
- The PASSED section MUST list which review categories had no findings.
- Every finding MUST include `[file:line]` and a `**Fix:**` recommendation.
- Summary MUST list counts for all four severity levels.
- Verdict: any CRITICAL → REQUEST_CHANGES. 2+ HIGH → REQUEST_CHANGES. Otherwise
  → APPROVE.

## How to Use

Invoke with `/review-code` or ask for "code review".

**Scope detection:**

1. If git is initialized: review `git diff --cached` (staged) or `git diff`
   (unstaged)
2. If a file path is provided: review that specific file
3. If neither: ask the user what to review

## Review Process

1. **Determine scope** — what changed?
2. **Read CLAUDE.md** — check compliance against every rule defined there
3. **Read each changed file in full** — understand context, not just the diff
4. **Evaluate against all categories below**
5. **Output in the mandatory format above**

## Review Categories

Check each category. Every finding needs `[file:line]` and `**Fix:**`.

| Category             | What to Check                                                    | Default Severity       |
| -------------------- | ---------------------------------------------------------------- | ---------------------- |
| CLAUDE.md Compliance | Every rule in CLAUDE.md                                          | CRITICAL-LOW by impact |
| DDD Compliance       | Building blocks, ubiquitous language, aggregate boundaries       | MEDIUM-HIGH            |
| TDD Compliance       | Test exists, naming, placement, failure paths, regression tests  | HIGH-LOW               |
| Type Safety          | No `any`, no unsafe casts, strict mode                           | HIGH                   |
| Import Hygiene       | Pinned npm versions, no circular imports, correct paths          | HIGH-MEDIUM            |
| Error Handling       | Actionable messages, narrow try/catch, throw before write        | HIGH-MEDIUM            |
| Security Smoke Test  | Hardcoded secrets (CRITICAL), command injection (CRITICAL)       | CRITICAL               |
| Code Organization    | Correct directories, single responsibility, minimal blast radius | MEDIUM-LOW             |

For full security audit use `/review-security`. For detailed checks per category
see [references/checklist.md](references/checklist.md).
