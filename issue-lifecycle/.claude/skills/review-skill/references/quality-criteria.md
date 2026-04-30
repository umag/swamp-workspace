# Quality Criteria Reference

Detailed criteria for reviewing Claude Code skills, expanded from the principle:
**"The context window is a public good."**

## Context Window as Public Good

The context window has a fixed budget shared by every piece of information
Claude holds during a conversation. When a skill loads, it displaces other
context -- previous conversation, file contents, tool results. A skill must
justify every line it occupies.

Practical test for each paragraph in a skill:

1. If this paragraph were deleted, would Claude produce worse output? If no,
   delete it.
2. Could this information be obtained from `--help`, tool output, or Claude's
   training data? If yes, delete it.
3. Is this a project-specific convention that Claude cannot infer? If yes, keep
   it.

## Progressive Disclosure Levels

### Tier 1: Metadata (frontmatter description)

- Always loaded into context for every conversation
- Budget: ~100 words maximum
- Contains: skill name, one-sentence purpose, when to use, trigger phrases
- Example of good metadata: "Create GitHub issues for swamp -- file bug reports
  with reproduction steps. Triggers on 'bug report', 'file issue'."
- Example of bad metadata: "This skill helps you work with issues in the swamp
  project management system by providing templates and automation." (vague, no
  triggers, no "when to use")

### Tier 2: SKILL.md body

- Loaded when the skill triggers
- Budget: under 500 lines, under 5000 words
- Contains: the 80% case -- primary workflows, quick reference tables, rules
- Tables preferred over prose for structured data
- Code examples show the pattern only (5-10 lines, not full programs)

### Tier 3: References

- Loaded on-demand when Claude needs deeper detail
- Budget: unlimited per file, but each file should be focused
- Contains: full examples, edge cases, detailed checklists, API surfaces
- Each file covers one topic

## Freedom Level Selection

### High Freedom (text instructions)

Use when the task is creative or varies significantly case-by-case.

- Code review skills
- Architecture guidance skills
- Writing/documentation skills
- Appropriate signal: skill says "evaluate", "assess", "recommend"

### Medium Freedom (pseudocode and patterns)

Use when there is a preferred approach but valid alternatives exist.

- Extension creation skills (follow the pattern, but details vary)
- Workflow design skills (DAG structure varies, conventions are fixed)
- Appropriate signal: skill shows a pattern with "adapt as needed"

### Low Freedom (specific commands and scripts)

Use when operations are fragile, destructive, or must be exact.

- Publishing/deployment skills (exact CLI sequence matters)
- CI/CD setup skills (YAML must be precise)
- Destructive operations (delete, reset, force-push)
- Appropriate signal: skill uses numbered steps with exact commands

## Skill Size Guidelines

| Metric                        | Guideline     | Action if exceeded                    |
| ----------------------------- | ------------- | ------------------------------------- |
| SKILL.md lines                | < 500         | Move content to references            |
| SKILL.md words                | < 5000        | Tighten prose, use tables             |
| Frontmatter description words | < 100         | Trim to essentials                    |
| Reference file count          | 2-7 per skill | Merge small files or split large ones |
| Individual reference lines    | < 300         | Split into focused files              |

## Common Anti-Patterns

### 1. Knowledge Duplication

The skill teaches Claude things it already knows from training data.

- Bad: "In TypeScript, use `async/await` for asynchronous operations"
- Bad: "JSON objects use curly braces and key-value pairs"
- Good: "Swamp extensions MUST export a default object matching ModelInterface"
  (project-specific, not general knowledge)

### 2. Trigger Overlap

Two skills fire on the same phrase, confusing the routing.

- Bad: skill-a triggers on "create model", skill-b triggers on "model create"
- Fix: make triggers more specific -- "create extension model" vs "create model
  definition"
- Check: read all SKILL.md frontmatters and compare trigger lists

### 3. README Masquerading as Skill

The skill is informational but gives no actionable instructions. It reads like
documentation rather than a set of procedures.

- Signal: no imperative verbs ("Run", "Create", "Check")
- Signal: lots of "X is..." explanations with no "do Y" follow-up
- Fix: restructure around tasks the user would ask Claude to perform

### 4. Monolithic Body with Empty References

All content is crammed into SKILL.md. The references/ directory is empty or
contains only trivial files.

- Signal: SKILL.md exceeds 500 lines
- Signal: references/ directory does not exist or has no .md files
- Fix: identify the 20% of content that handles edge cases, examples, and
  detailed checklists -- move it to references

### 5. Vague Triggers

Triggers are so generic they match unrelated requests.

- Bad triggers: "help", "code", "fix", "run", "create"
- Good triggers: "review skill quality", "check skill triggers", "audit skill"
- Test: would someone saying just this word/phrase specifically want this skill?

### 6. Stale References

Reference files exist but are never mentioned in SKILL.md. Claude will never
know to load them.

- Check: for each file in references/, search SKILL.md for its filename
- Fix: either link the reference from SKILL.md or delete the orphan

### 7. Copy-Paste Between Skills

Multiple skills contain large identical sections. When the shared content
changes, only some copies get updated.

- Signal: diff two skills and find 20+ identical lines
- Fix: factor shared content into a reference that both skills can point to, or
  deduplicate by having one skill defer to another
