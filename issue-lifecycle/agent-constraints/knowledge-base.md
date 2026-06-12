# Knowledge base conventions

The KB lives in `kb/` at the repository root — flat markdown files named
`<kind>-<slug>.md` where kind is one of `decision`, `pattern`, `anti-pattern`,
`runbook`, `postmortem`.

Each entry carries frontmatter:

```markdown
---
kind: decision | pattern | anti-pattern | runbook | postmortem
issue: <issue-name that harvested it>
date: <YYYY-MM-DD>
---
```

Phase 2 (planning) knowledge lookup: grep `kb/` for terms matching the issue's
`affectedAreas` and title. Phase 6 (harvest) writes new entries here and records
them with `committed: true`.
