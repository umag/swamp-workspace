# Phase 2: Planning (with knowledge lookup)

## Prerequisites

- State: `triaged` (or `planned`, for revisions)
- Phase 1 triage detail captured (priority, category, confidence at minimum)

Phase 2 has two parts: a **knowledge lookup** (entry side of the UAT/KB
process) and the plan itself.

## Step 6: Knowledge lookup (entry side)

Before writing the plan, search existing UAT and KB for prior art. This
closes the loop with Phase 6 (harvest) — the diff between what you find here
and what emerges during the lifecycle becomes the harvest candidates.

### UAT lookup

Read `agent-constraints/uat-conventions.md` at the repo root to locate the
UAT test base and its conventions. If it doesn't exist, fall back to scanning
for common locations:

- `tests/uat/`
- `uat/`
- `test/e2e/`
- `projects/*/uat/`

Grep for terms matching `affectedAreas` and the issue title. Collect any
scenarios that will either be exercised by this change or that you plan to
reuse.

### Knowledge base lookup

Read `agent-constraints/knowledge-base.md` at the repo root to locate the KB.
Fallback scan targets:

- `docs/`
- `knowledge-base/`
- `ADR/`
- `decisions/`
- `projects/*/ARC-*-*.md` (ArcKit artifacts)

Look for prior art: ADRs affecting this code path, design decisions, pattern
notes, runbook entries, postmortems.

### Record prior art

```bash
swamp model method run <issue-name> record_prior_art \
  --input-file /tmp/prior-art-issue-<issue-name>.yaml
```

Where the YAML contains:

```yaml
uatScenarios:
  - path: "tests/uat/auth-login.feature"
    summary: "login with valid credentials"
    reusable: true
  - path: "tests/uat/auth-timeout.feature"
    summary: "session timeout enforcement"
    reusable: false
kbEntries:
  - path: "docs/ADR/0007-auth-strategy.md"
    summary: "token-based auth ADR"
  - path: "docs/runbook/auth-incident.md"
    summary: "auth incident response runbook"
```

If you find nothing, still call `record_prior_art` with empty arrays — this
records the fact that the search was done, and Phase 6 can treat the whole
lifecycle output as net-new.

## Step 7: Generate the implementation plan

```bash
swamp model method run <issue-name> plan \
  --input summary="..." \
  --input dddAnalysis="..." \
  --input testStrategy="..." \
  --input-file /tmp/plan-issue-<issue-name>-v1.yaml
```

**Issue-scoped and version-scoped filenames are required.** Do NOT use
generic names like `/tmp/plan.yaml` — they collide with stale content from
previous lifecycle sessions, and unrelated content can silently leak into the
current plan. Always use `/tmp/plan-issue-<issue-name>-v<N>.yaml`.

The YAML file shape:

```yaml
steps:
  - order: 1
    description: "Add AuthToken value object with expiry field"
    files:
      - "src/domain/auth/AuthToken.ts"
      - "src/domain/auth/__tests__/AuthToken.test.ts"
    risks: "Existing callers pass raw strings — compat shim needed"
  - order: 2
    description: "Update AuthService to mint AuthToken instances"
    files:
      - "src/services/AuthService.ts"
      - "src/services/__tests__/AuthService.test.ts"
    risks: ""
potentialChallenges:
  - "Backwards compatibility with legacy token format"
  - "Token storage migration across existing sessions"
  - "Clock skew on expiry validation"
reviewMatrix:
  code: true
  adversarial: true
  security: true    # touching auth — enable
  ux: false
  skill: false
```

Legacy plans may use bare strings for `steps` — both forms are accepted. Rich
objects are preferred for new plans because the adversarial reviewer can check
each step's `files` list against the actual codebase.

### Plan summary sections

The `summary` argument is a freeform string. Use these markdown sections by
convention so Phase 6 (harvest) can parse them:

```markdown
## Summary
<one paragraph — what the plan does>

## Documentation impact
<files/docs that will need updating, or "none">

## UAT coverage
<existing scenarios that cover this change, or "new scenarios needed — see Phase 6">

## PR
<to be appended after the PR is opened>
```

## Step 8: Apply repo-specific planning conventions

Read `agent-constraints/planning-conventions.md` at the repo root for
repo-specific overrides: required analysis sections, documentation checks,
test strategy templates, UAT assessment rules. If it doesn't exist, the
canonical defaults above apply.

## Step 9: Present the plan

Render the plan in the **skimmable BLUF format** defined in
[plan-presentation.md](plan-presentation.md) — Goal, Approach, Domain impact
(4 lines), Scope table with a DDD-role column, Risks (only if any), one-line
Steps, Non-goals, Open questions. Read that file before presenting; it carries
the hard rules (40–80 lines, no code, DDD red flags surfaced as risks,
diagrams off by default) plus the escalation triggers for an HTML artifact
([plan-html-artifacts.md](plan-html-artifacts.md)) and Wardley maps for
strategic issues ([plan-wardley.md](plan-wardley.md)). The same format governs
every later presentation of the plan to the human, including the approval gate
in [autonomous-loop.md](autonomous-loop.md).

The skim layer sits on top of, and never replaces, the full plan content — at
the strict `approve_plan` gate the human must still be able to see every step,
finding, and risk verbatim.

After presenting, **immediately** proceed to Phase 3
([adversarial-review.md](adversarial-review.md)) — planning and adversarial
review are paired. Do not stop for human feedback between plan and first
review; the review informs the first human decision point.

## Next phase

Plan created → read [adversarial-review.md](adversarial-review.md) for the
autonomous review + iterate loop.
