# Phase 1: Triage

## Prerequisites

- State: none (fresh issue) OR `filed` (issue started but not yet triaged)
- Human has named the issue or explicitly asked to file one

## Steps 1–5

### 1. Create the model instance

```bash
swamp model create @magistr/issue-lifecycle <issue-name>
```

Pick a descriptive name. If the repo uses a numbered scheme, reuse that
convention. Otherwise, short-kebab-case based on the issue title (e.g.
`auth-timeout-fix`, `export-csv-slow`).

### 2. Call `start`

```bash
swamp model method run <issue-name> start \
  --input title="..." \
  --input description="..." \
  --input-file /tmp/start-issue-<issue-name>.yaml  # for labels
```

Where the YAML file contains:

```yaml
labels:
  - bug
  - priority-high
```

### 3. Investigate with moldable-dev

**Before classifying**, invoke `tessl__moldable-dev` to build whatever inspector
you need to understand the problem domain:

- Query live model / resource state
- Grep the codebase for affected areas
- Check `git log` on suspected files for regression signals

Read `agent-constraints/triage-conventions.md` at the repo root for
repo-specific exploration guidance. If it doesn't exist, fall back to
`CLAUDE.md`.

### 4. Classify

```bash
swamp model method run <issue-name> triage \
  --input priority=<critical|high|medium|low> \
  --input category=<bug|feature|security|improvement|refactor> \
  --input confidence=<high|medium|low> \
  --input reasoning="<your analysis>" \
  --input isRegression=<true|false> \
  --input-file /tmp/triage-issue-<issue-name>.yaml  # for clarifyingQuestions + affectedAreas
```

Where the YAML file contains:

```yaml
affectedAreas:
  - "src/auth/"
  - "docs/api/auth.md"
clarifyingQuestions: [] # populate if confidence is low
```

**Classification guidance:**

- `bug` — something is broken or behaving incorrectly
- `feature` — request for new functionality or enhancement
- `security` — vulnerability, hardening, or compliance work
- `improvement` — quality-of-life, ergonomics, not broken per se
- `refactor` — internal restructure, no behavior change

**Regression detection.** Set `isRegression=true` when the bug previously
worked. Signals:

- "This used to work"
- "Stopped working after"
- `git log` shows recent changes to the affected code
- Version-specific claims ("worked in v1.2")

A regression is still `category=bug`; `isRegression` is an additional detail.

**Low-confidence escape hatch.** If you cannot classify confidently, **do not
guess**. Call `triage` with `confidence=low` and populate `clarifyingQuestions`
with specific things you need the human to answer, then stop and ask. Do not
proceed to planning until the human clarifies.

**Triage is single-shot.** `triage` may only be called once — classification
freezes after it. If you misclassified, close and re-file. Reproduction is the
exception: record it later via `record_reproduction` (Step 5).

### 5. Reproduce the bug

**Bugs and regressions only — skip for features, improvements, refactors, and
security work.**

Before planning a fix, reproduce the issue to confirm the failure mode. Read
`agent-constraints/triage-conventions.md` for repo-specific reproduction steps.
If it doesn't exist, create a minimal reproduction in `/tmp/` using the
project's standard tooling.

**Two legal paths.** Reproduced the bug already? Include `reproduced:` in the
Step 4 triage call's YAML (single call, no second method needed). Reproduction
deferred? Record it later with `record_reproduction` — it stays available
through planning (`triaged` and `planned` states; calling it from any later
state is rejected), and a second call overwrites the first, so a
`could-not-reproduce` can be upgraded to `reproduced` after a retry:

```bash
swamp model method run <issue-name> record_reproduction \
  --input status=reproduced \
  --input-file /tmp/record-reproduction-issue-<issue-name>.yaml
```

Where the YAML carries the multiline notes:

```yaml
notes: |
  Steps: 1. ...
  Observed: ...
  Expected: ...
```

(`status` is one of `reproduced` | `could-not-reproduce` | `not-applicable`. The
method merges into `triageDetail.reproduced` only — classification is
untouched.)

If the bug **cannot be reproduced**, set `status: could-not-reproduce`, note
why, and **ask the human how to proceed** before planning. It may mean the issue
description is incomplete, the bug is environment-specific, or the underlying
code has already changed.

## Next phase

Triage complete → read [planning.md](planning.md) to generate the plan.
