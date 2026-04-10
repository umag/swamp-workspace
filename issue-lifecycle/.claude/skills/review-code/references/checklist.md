# Code Review Checklist

## Project Rules Compliance

Read the project's CLAUDE.md and check all rules defined there. Each rule
violation is a finding. Map severity by impact:

| Impact | Severity | Examples |
|--------|----------|----------|
| Data loss or security | CRITICAL | Destructive ops without verification |
| Architecture violation | HIGH | Bypassing abstractions, missing search-before-build |
| Suboptimal pattern | MEDIUM | Re-fetching available data, deprecated patterns |
| Style or convention | LOW | Reporting format, documentation preferences |

## DDD Compliance (5 items)

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| Building block selection | Entity used where Value Object appropriate (or vice versa) | MEDIUM |
| Ubiquitous language | Technical names (Handler, Manager, Processor) instead of domain terms | MEDIUM |
| Aggregate boundaries | Direct access to child entities bypassing aggregate root | HIGH |
| Module = aggregate | Multiple unrelated concerns in a single module | HIGH |
| Domain logic placement | Business rules in config/orchestration instead of domain layer | MEDIUM |

## TDD Compliance (4 items)

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| Test exists | New/changed code has no corresponding test file | HIGH |
| Test naming | Test name doesn't follow `"<unit> <does thing> when <condition>"` | LOW |
| Test placement | Test file not next to source (`foo.test.ts` beside `foo.ts`) | LOW |
| Failure path coverage | Tests only cover success path, no error/edge cases | MEDIUM |

## Type Safety (3 items)

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| No `any` | Explicit `any` or implicit `any` from missing type annotations | HIGH |
| No unsafe casts | `as unknown as X` or `as any` patterns | HIGH |
| Readonly correctness | Mutable where readonly is appropriate | LOW |

## Import Hygiene (3 items)

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| Pinned versions | `npm:` imports without exact version | HIGH |
| No circular imports | Module A imports B which imports A | HIGH |
| Correct paths | Importing from internal paths instead of `mod.ts` | MEDIUM |

## Error Handling (4 items)

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| Actionable messages | Error says "something went wrong" without context | MEDIUM |
| Narrow try/catch | Catching all errors in a single broad try/catch | MEDIUM |
| Throw before write | Writing partial state before validation completes | HIGH |
| HTTP error detail | Network errors missing status code or response body | LOW |

## Security Smoke Test (2 items)

Quick check only. For full audit use `/review-security`.

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| Hardcoded secrets | `AKIA`, `ghp_`, `sk-`, `xoxb-`, `password =`, `secret =`, `apiKey =` in source | CRITICAL |
| Command injection | User input or external data in shell commands, `exec()`, `Deno.Command`, template strings to shell | CRITICAL |

## Code Organization (3 items)

| Check | What to Look For | Severity |
|-------|-----------------|----------|
| Directory conventions | Files in wrong directory for their type | MEDIUM |
| Single responsibility | Function/class doing too many things | MEDIUM |
| Blast radius | Change touches files unrelated to the stated purpose | LOW |
