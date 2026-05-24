# Phase 6: Knowledge harvest (UAT + KB improvement)

## Prerequisites

- State: `resolved` (Phase 5 just called `resolve_findings`)
- Human explicitly requested `harvest` (skippable — call `complete` directly to skip)

Phase 6 extracts reusable learnings from the lifecycle and proposes additions
to the UAT test base and knowledge base.

This is the **exit side** of the UAT/KB improvement process. The entry
side (pre-planning knowledge lookup) lives in
[planning.md](planning.md) Step 6. The diff between what was known at
entry (`state.priorArt`) and what emerges here is where the harvest
candidates come from.

Phase 6 is **optional but recommended**. Skipping it calls `complete`
directly from `resolved` and loses the harvest opportunity.

## Step 1: UAT scenario extraction

Gather material:

1. **Triage reproduction.** Re-read `state.triageDetail.reproduced.notes`
   (if any). The reproduction steps themselves are usually a good seed for
   a new UAT scenario.
2. **Plan UAT coverage section.** Re-read the `## UAT coverage` section of
   `state.plan.summary` — this lists what the plan expected to need.
3. **Implementation diff.** `git diff main..<state.branch>` — every new
   code path is a candidate for UAT coverage.
4. **Adversarial findings.** Pull from `state.reviewHistory` all HIGH
   findings that were resolved by adding logic (not just code restructure).
   Each one represents a case the plan almost missed; the corresponding
   test scenario should outlive this lifecycle.
5. **Prior art.** Re-read `state.priorArt.uatScenarios` — the scenarios
   already in the UAT base. Your proposals should **not duplicate** these.

Draft new Given/When/Then scenarios for:

- Any new code path introduced by the change
- The triage reproduction (if it wasn't already covered by an existing
  scenario)
- Any HIGH-severity edge case that was resolved by adding logic
- Any `isRegression: true` case — regression tests are high-value

Read `agent-constraints/uat-conventions.md` for the repo's preferred UAT
format (Gherkin, Playwright, Cypress, shell scripts, etc.). Default:
Given/When/Then in markdown.

Write proposals to `/tmp/uat-proposals-issue-<issue-name>.md`.

Format:

```markdown
# UAT proposals: <issue-name>

## UAT-1: <short title>

**Rationale.** Why this needs coverage — cite the specific finding or
regression. Example: "ADV-3 (HIGH): plan missed handling of zero-length
input. Resolved by adding guard in AuthService.validate()."

**Destination.** `tests/uat/<path>.feature` (or the path from
agent-constraints)

**Scenario:**

```gherkin
Given <precondition>
When <action>
Then <expected outcome>
```

## UAT-2: ...
```

## Step 2: Knowledge base harvest

Gather material:

1. **All review rounds.** `state.reviewHistory` — every round's findings
   (including resolved ones) tell you what the machine almost got wrong.
2. **Plan DDD analysis.** `state.plan.dddAnalysis` — the domain model
   decisions.
3. **Plan potentialChallenges.** `state.plan.potentialChallenges` — the
   risks the plan acknowledged.
4. **Clarifying questions.** `state.triageDetail.clarifyingQuestions` and
   the human's answers to them — these are often gold for KB.
5. **Prior art.** `state.priorArt.kbEntries` — don't duplicate.

Distill into KB candidates by kind:

- **`decision`** — ADR-style records for non-obvious design choices. The
  kind of thing that needs a permanent record of "why".
- **`pattern`** — a pattern that was reinforced (used well) or introduced
  by this change and should be copied by future work.
- **`anti-pattern`** — an approach that was considered and rejected,
  especially if the adversarial review caught it. "We almost did X
  because Y, but Z is why that would have been wrong." Extremely valuable.
- **`runbook`** — operational doc updates if the bug revealed a gap
  (e.g. "when auth latency spikes, check X")
- **`postmortem`** — for bugs serious enough to warrant a written
  postmortem with cause, impact, timeline, lessons

Read `agent-constraints/knowledge-base.md` for the repo's KB format.
Default: ADR-style markdown files with frontmatter.

Write proposals to `/tmp/kb-proposals-issue-<issue-name>.md`.

Format:

```markdown
# KB proposals: <issue-name>

## KB-1: <title>

**Kind.** decision | pattern | anti-pattern | runbook | postmortem

**Rationale.** Why this belongs in the KB — cite the specific finding,
clarifying question, or design decision.

**Destination.** `docs/ADR/NNNN-<slug>.md` (or the path from
agent-constraints)

**Body:**

<full markdown of the proposed KB entry>

## KB-2: ...
```

## Step 3: Present to human

Show both files to the human with a concise intro:

```markdown
**Harvest candidates from <issue-name>:**

- **UAT proposals:** N (see /tmp/uat-proposals-issue-<issue-name>.md)
- **KB proposals:** M (see /tmp/kb-proposals-issue-<issue-name>.md)

Top 3 highest-signal items:

1. <short description>
2. <short description>
3. <short description>

Please review and tell me which to commit. You can say:
- `commit all` — accept every proposal
- `commit UAT-1 UAT-3 KB-2` — accept specific items by ID
- `skip` — record the proposals but commit nothing
```

## Step 4: Commit approved proposals

For each approved item, write the file to its destination path. Mark
committed items with `committed: true` in the harvest record.

Include the issue name in the committed file's metadata/tags so future
Phase 2 lookups can find it:

```markdown
---
issue: <issue-name>
date: <iso date>
---
```

## Step 5: Call harvest

```bash
swamp model method run <issue-name> harvest \
  --input-file /tmp/harvest-issue-<issue-name>.yaml
```

Where the YAML contains the full proposal set (committed and not):

```yaml
uatProposals:
  - scenario: "Given X When Y Then Z"
    rationale: "ADV-3 HIGH regression case"
    path: "tests/uat/auth-zero-length.feature"
    committed: true
  - scenario: "Given A When B Then C"
    rationale: "new code path introduced by step 4"
    path: "tests/uat/auth-refresh.feature"
    committed: false
kbProposals:
  - kind: decision
    title: "Use TokenFactory for all mint paths"
    body: "<full ADR body>"
    path: "docs/ADR/0012-token-factory.md"
    committed: true
  - kind: anti-pattern
    title: "Don't mint tokens in AuthService directly"
    body: "<full body>"
    path: "docs/patterns/anti/token-mint.md"
    committed: true
```

State transitions from `resolved` → `harvested`. The harvest record is now
persisted and discoverable via `swamp data get <issue-name> current --json`.

## Step 6: Call complete

```bash
swamp model method run <issue-name> complete --input summary="..."
```

State transitions from `harvested` → `complete`. The lifecycle is done.

## Skip path

If the human chooses to skip harvest:

```bash
swamp model method run <issue-name> complete --input summary="..."
```

`complete` accepts both `resolved` and `harvested` as source states, so
skipping is always legal. The model's `harvest` field stays empty.

## Fallbacks when agent-constraints are missing

If `agent-constraints/uat-conventions.md` or `knowledge-base.md` don't
exist in the repo, scan for the defaults in [planning.md](planning.md)
Step 6 (UAT and KB lookup). If nothing is found, prompt the human for the
destination paths and **offer to create the constraint files for next
time**:

> I don't see `agent-constraints/uat-conventions.md` in this repo. Where
> does UAT live? I can write the path to `agent-constraints/uat-conventions.md`
> so future lifecycles skip the question.

This seeds the constraint convention for the next issue.
