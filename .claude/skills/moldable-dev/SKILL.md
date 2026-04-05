---
name: moldable-dev
description: >
  Moldable development principles — programming through contextual micro tools
  built for each problem. Applies swamp CLI inspectors, live data queries, CEL
  predicates, and reusable reports to investigate systems and reduce
  time-to-answer (ttA). Creates domain-specific inspector patterns, per-problem
  custom views, and narrative-driven workflow YAML rather than generic dashboards
  or one-off scripts. Use when asked to "explore data structures through custom
  views", "debug by building contextual inspectors", "investigate live system
  state", "understand a model or workflow", "query audit logs", "build a reusable
  report", "inspect runtime data", "use moldable development", or "reduce
  time-to-answer".
---

# Moldable Development

Build micro tools tailored to each investigation to reduce time-to-answer — query live system state rather than reading source, and make every tool reusable.

## Core Behavioral Principles

- **Query live data before reading source.** Use domain tools to expose actual system state — the default view is rarely best for the current question.
- **Build reusable views, not one-off scripts.** If you've run the same commands twice, make a report or workflow.
- **Cross module/file/service boundaries freely.** Let the question drive the investigation, not the architecture.
- **Produce deterministic, re-runnable tools** rather than summarizing directly.

## Applied to Swamp — Contextual Inspectors

Don't read source to understand runtime behavior — **query the actual data**.

### Model Inspector

```bash
# Live state — what does this model look like RIGHT NOW?
swamp model get <name> --json

# What methods are available?
swamp model type describe <type> --json

# What data has it produced?
swamp data get <name> --json
```

**Example output from `swamp model get mymodel --json`:**
```json
{
  "name": "mymodel",
  "status": "ready",
  "lastExecutedAt": "2024-05-10T14:23:00Z",
  "fields": {
    "inputCount": 42,
    "outputCount": 38
  }
}
```
Validate: `status` should be `"ready"`, `lastExecutedAt` should be recent, and `outputCount` should be non-zero.

### Workflow Inspector

```bash
# Execution history — what happened?
swamp workflow history <name> --json

# Current state of a specific run
swamp workflow history <name> --json | # extract run details
```

### Output Inspector

```bash
# Method execution results
swamp model output data <outputId> --json

# Search outputs by model
swamp model output search <name> --json
```

### Audit Inspector

```bash
# What commands were run and when?
swamp audit search --json
```

### Data Query Inspector (CEL)

```bash
# Find data matching domain predicates
swamp data query '<predicate>' --json

# Filter by attributes
swamp data query 'attributes.status == "running"' --json
```

## Worked Example: Debugging a Failing Model

A complete multi-step investigation — run these in sequence, validate before proceeding:

```bash
# 1. Check current live state
swamp model get <name> --json
# → status == "ready"? fields populated and non-null?

# 2. Review execution history
swamp workflow history <name> --json
# → Recent runs successful? Any runs with status "failed" or retryCount > 0?

# 3. Query outputs for the failing method
swamp model output search <name> --json
# → Outputs present? createdAt timestamp recent (not stale)?

# 4. Inspect a specific output
swamp model output data <outputId> --json
# → Output data shape matches expected schema? Values within expected ranges?

# 5. Check audit log for recent commands
swamp audit search --json
# → Refresh command present? completedAt populated (not null)?

# 6. If data is stale — trigger refresh, then re-verify steps 1 and 3
```

Once this sequence proves useful, wrap it as a `swamp-report` health check so it is reusable.

## Building Micro Tools

A tool doesn't need to be complex. A 3-line CEL query is a tool. A swamp report
is a tool. The key metric: **can you build it in minutes?**

### When to Build a Tool

- You've run the same 3 commands more than twice → make a report or workflow
- You're piping JSON through multiple `jq` filters → make a data query
- You're explaining a process to someone → make it a narrative (workflow YAML)
- You're debugging the same class of problem → make an inspector pattern

### Tool Hierarchy (Cheapest First)

| Tool Type          | Cost      | When to Use                                    |
| ------------------ | --------- | ---------------------------------------------- |
| CEL query          | Seconds   | Filter/extract from existing data              |
| CLI pipeline       | Minutes   | Chain swamp commands for a specific question    |
| Swamp report       | Minutes   | Reusable data transformation/analysis          |
| Swamp workflow     | Hours     | Multi-step orchestrated investigation          |
| Extension model    | Hours-Day | New domain abstraction worth encoding          |

### Reports as Moldable Tools

Use `swamp-report` to create reusable domain-specific views:

- **Model health check**: verify model state, check last execution, identify
  stale data
- **Workflow bottleneck finder**: analyze execution history, find slow steps
- **Data freshness checker**: query data versions, identify expired artifacts
- **Extension audit**: list installed extensions, verify configuration

## Anti-Patterns

- **Using `cat` + `grep` on YAML** instead of `swamp model get --json` — the
  domain tool already parses and validates
- **Generic dashboards** instead of focused domain views — every problem deserves
  its own view
- **Reading source code** when live data answers the question faster — query
  first, read second
- **Treating all data the same** — use domain-specific views per model type
- **Debugging by adding print statements** instead of querying audit/output logs
- **Asking LLMs to summarize directly** — use them to build deterministic tools
  with explainable outputs instead

See [references/inspector-patterns.md](references/inspector-patterns.md) for
recipes and [references/swamp-inspectors.md](references/swamp-inspectors.md)
for swamp-specific templates.
