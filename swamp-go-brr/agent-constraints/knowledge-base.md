# Knowledge base conventions

The `@magistr/swamp-go-brr` KB lives under `docs/`:

- `docs/decisions/NNNN-<slug>.md` — ADR-style decisions (the "why" of
  non-obvious design choices).
- `docs/patterns/<slug>.md` — patterns to copy.
- `docs/patterns/anti/<slug>.md` — anti-patterns (what was rejected and why).

Each file carries frontmatter:

```yaml
---
issue: <issue-name>
date: <YYYY-MM-DD>
kind: decision | pattern | anti-pattern | runbook | postmortem
---
```

Phase 2 knowledge lookup greps `docs/` for prior art before planning.
