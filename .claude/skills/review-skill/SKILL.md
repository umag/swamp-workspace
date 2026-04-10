---
name: review-skill
description: |
  Skill quality review for Claude Code skills. Checks frontmatter quality,
  progressive disclosure, trigger precision, instruction quality, context
  window budget, cross-skill consistency, and reference organization.
  Ensures skills follow the "context window is a public good" principle.
  Triggers on "skill review", "review skill", "/review-skill", "check
  skill", "skill quality", "new skill review".
---

# Skill Quality Review

The context window is a public good. Every line in a skill competes with
everything else Claude needs to know. This skill reviews other skills against
that principle.

## When to Run

- After creating or modifying a skill's SKILL.md
- After adding or removing references
- When trigger conflicts are suspected
- To periodically audit skill quality across the project

## Review Process

1. Read the target skill's SKILL.md and all files in its references/ directory
2. Read SKILL.md files from other skills in the project (for trigger conflict
   and consistency checks)
3. Evaluate the skill against all 7 quality dimensions below
4. Produce a structured review report

## Quality Dimensions

Evaluate each of the 7 dimensions. For full criteria and examples, read
`references/dimensions.md`.

| # | Dimension | Key Question |
| --- | --- | --- |
| 1 | Frontmatter Quality | Is `name` kebab-case? Does `description` explain what, when, and when NOT? Are triggers natural and unique? |
| 2 | Progressive Disclosure | Is heavy content in references/? Does SKILL.md stay under 500 lines / 5000 words? |
| 3 | Trigger Precision | Do triggers match user intent without false positives, false negatives, or overlap? |
| 4 | Instruction Quality | Are instructions imperative and actionable? Are steps numbered? Is MUST vs SHOULD used correctly? |
| 5 | Context Window Budget | Does every paragraph earn its place? Is project-specific knowledge prioritised over general knowledge? |
| 6 | Cross-Skill Consistency | Does the skill follow heading conventions, table/code-block style, and naming patterns of the project? |
| 7 | Reference Organization | Is each reference file focused, named descriptively, linked from SKILL.md, and loaded on-demand? |

Sibling skills in this repo — check every new or modified skill against these
for trigger overlap. A new skill's description must not fire on queries that
clearly belong to one of these:

- `issue-lifecycle` — drive issue triage → plan → review → implement → harvest
- `ddd` — Domain-Driven Design building block selection
- `tdd` — Red-Green-Refactor workflow enforcement
- `moldable-dev` — live-data inspectors and domain-specific micro tools
- `review-code` — general code review (CLAUDE.md, types, architecture, tests)
- `review-adversarial` — adversarial review (assume broken, 7 dimensions)
- `review-security` — security audit (injection, secrets, OWASP, supply chain)
- `review-ux` — CLI UX review (output, help text, errors, JSON mode)
- `review-skill` — this skill

Trigger-overlap discrimination is also enforced in CI via each skill's
`evals/trigger_evals.json` — write negative examples that point at the sibling
skill that *should* match so promptfoo catches regressions.

## Freedom Level Assessment

Assess prescriptiveness level. Details in `references/dimensions.md`.

| Level | When to use |
| --- | --- |
| High | Varied, flexible tasks — text writing, code review, architecture |
| Medium | Preferred approach exists but variations are acceptable |
| Low | Fragile, error-prone operations — publishing, destructive ops, CI setup |

Flag skills that over-constrain creative tasks or under-constrain fragile ones.

## Anti-Patterns to Flag

Flag these immediately. Full examples in `references/quality-criteria.md`.

1. **Trigger squatting** — overly broad triggers like "help", "code", "fix"
2. **README masquerading as skill** — informational content, no actionable instructions
3. **Monolithic SKILL.md** — all content in body with empty references/, exceeding 500 lines
4. **Knowledge duplication** — teaching Claude things it already knows (language syntax, stdlib APIs)
5. **Vague triggers** — so generic they match everything or nothing
6. **Stale references** — reference files that exist but are never mentioned in SKILL.md
7. **Copy-paste skills** — duplicate large sections from other skills instead of cross-referencing

## Output Format

Produce the review in this exact structure:

```
## Skill Review | <skill-name>

### Quality Score: X/7 dimensions passing

### 1. Frontmatter Quality
- Status: PASS / NEEDS_WORK
- Findings: ...

### 2. Progressive Disclosure
- Status: PASS / NEEDS_WORK
- Findings: ...

### 3. Trigger Precision
- Status: PASS / NEEDS_WORK
- Findings: ...

### 4. Instruction Quality
- Status: PASS / NEEDS_WORK
- Findings: ...

### 5. Context Window Budget
- Status: PASS / NEEDS_WORK
- Findings: ...

### 6. Cross-Skill Consistency
- Status: PASS / NEEDS_WORK
- Findings: ...

### 7. Reference Organization
- Status: PASS / NEEDS_WORK
- Findings: ...

### Freedom Level
- Assessed level: High / Medium / Low
- Appropriate for domain: Yes / No
- Notes: ...

### Improvement Suggestions
1. Specific actionable suggestion
2. ...

### Trigger Conflict Check
Checked against: [list of existing skills checked]
Conflicts found: None / [list conflicts]
```

## Reviewing Multiple Skills

When asked to review all skills in a project:

1. List all skill directories under `.claude/skills/`
2. Review each skill individually using the output format above
3. Produce a summary table at the end:

```
## Skill Quality Summary

| Skill | Score | Worst Dimension | Top Priority Fix |
| --- | --- | --- | --- |
| skill-a | 6/7 | Context Budget | Move examples to references |
| skill-b | 7/7 | -- | None |
```

For detailed dimension criteria and worked examples, read
`references/dimensions.md` and `references/quality-criteria.md`.
