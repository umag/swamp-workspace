# Inspector Patterns

Recipes for building contextual micro tools with swamp.

## JSON Pipeline Pattern

Chain swamp commands to answer specific questions:

```bash
# What models have stale data (no execution in 24h)?
swamp data query 'has(attributes.lastExecuted) && timestamp(attributes.lastExecuted) < now() - duration("24h")' --json

# Which workflows failed in the last run?
swamp workflow history <name> --json  # then filter for status == "error"

# What resources does this model manage?
swamp model get <name> --json  # extract resource specs
```

## CEL Query Patterns

### Filter by Attributes
```bash
swamp data query 'attributes.status == "running"' --json
swamp data query 'attributes.region == "us-east-1"' --json
```

### Filter by Tags
```bash
swamp data query 'has(tags.environment) && tags.environment == "production"' --json
```

### Filter by Date Range
```bash
swamp data query 'timestamp(createdAt) > now() - duration("7d")' --json
```

### Combine Predicates
```bash
swamp data query 'attributes.status == "error" && has(tags.critical)' --json
```

### Extract Specific Fields
```bash
swamp data query 'attributes.status == "running"' --select 'name,attributes.instanceId,attributes.region' --json
```

## Multi-Step Inspection

When a single query isn't enough, compose a multi-step investigation:

1. **Start broad**: `swamp model get <name> --json` — what's the current state?
2. **Narrow down**: `swamp data get <name> <dataName> --json` — what specific data?
3. **Trace history**: `swamp model method history <name> --json` — what changed?
4. **Correlate**: `swamp model output data <outputId> --json` — what was the result?

## Building a Health Check Inspector

For any model type, a health check answers:

1. Does the model exist and is it valid? → `swamp model validate <name>`
2. When was it last executed? → `swamp model method history <name> --json`
3. Is its data fresh? → `swamp data get <name> --json` (check timestamps)
4. Are there errors in recent outputs? → `swamp model output search <name> --json`

## Building a Change History Inspector

Track what changed and when:

1. List data versions → `swamp data list <name> --json`
2. Compare versions → extract attributes from two versions and diff
3. Correlate with method executions → `swamp model method history <name> --json`

## The Adjacent Unexplored

Once you've answered one question cheaply, ask: **what new question does this
answer enable?** Each commoditized answer opens a door to questions you couldn't
afford to ask before.

Example chain:
- "Which models have stale data?" → (CEL query)
- "Why is this model's data stale?" → (method history)
- "What failed in the last execution?" → (output inspector)
- "Is this a recurring failure?" → (multi-run correlation)
- "Should we add a health check workflow?" → (build a report)
