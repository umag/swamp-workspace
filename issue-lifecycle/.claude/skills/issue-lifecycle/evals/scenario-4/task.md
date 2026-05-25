# Implementation Guide: Per-Account Billing Rate Limiting

## Problem/Feature Description

The billing team has just received sign-off on an approved plan for a new
rate-limiting capability. The plan introduces a `RateLimitRule` value object to
encapsulate account-specific charge frequency limits, and wires it into the
existing `BillingService` via the `RateLimiter` class.

The approved plan is in `inputs/approved-plan.yaml` and the current
implementation of the existing `RateLimiter` is in `inputs/rate-limiter.ts`. The
codebase is in active development with no external consumers — it has not yet
been released.

A senior engineer has asked you to produce a step-by-step implementation guide
so the team can use it as a reference during a pairing session tomorrow. The
guide should show exactly how you would work through each step of the approved
plan.

## Output Specification

Write **`implementation-guide.md`** — a step-by-step guide describing how you
would implement each plan step. For each step include:

- What you would do before writing any code for that step
- The complete development cycle you would follow to implement and verify the
  change, from the first action through to a finished state
- How you would integrate with the existing codebase structure
- Any refactoring or cleanup the change calls for, and when you would do it
- How you would confirm the step is complete and the tests pass

Do not produce any other output files. Do not leave large files (>50MB) on disk.
