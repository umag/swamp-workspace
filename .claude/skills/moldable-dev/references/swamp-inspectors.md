# Swamp-Specific Inspector Templates

## Model Health Check

Answer: "Is this model healthy and up-to-date?"

```bash
# 1. Validate definition
swamp model validate <name>

# 2. Check current state
swamp model get <name> --json

# 3. Check last execution
swamp model method history <name> --json
# Look for: last run timestamp, status, duration

# 4. Check data freshness
swamp data get <name> --json
# Look for: version timestamps, data age

# 5. Check for recent errors
swamp model output search <name> --json
# Look for: outputs with error status
```

**Healthy indicators**: recent successful execution, fresh data, no error
outputs.
**Unhealthy indicators**: no recent execution, stale data, error outputs,
validation failures.

## Workflow Bottleneck Finder

Answer: "Which step is slowing down this workflow?"

```bash
# 1. Get execution history
swamp workflow history <name> --json

# 2. For each run, examine step durations
# Look for: steps with disproportionate duration

# 3. Check if slow steps are waiting on model locks
# Fan-out rule: single calls holding locks block parallel steps
```

**Bottleneck indicators**: one step taking >80% of total time, steps waiting on
locked models, sequential steps that could be parallel.

## Data Freshness Checker

Answer: "Is any model data expired or stale?"

```bash
# 1. Query all data with age check
swamp data query 'true' --select 'modelName,dataName,version,createdAt' --json

# 2. Identify stale data
# Compare createdAt against expected refresh interval

# 3. Check retention policy compliance
swamp data list <name> --json
# Look for: versions exceeding retention limits
```

**Fresh indicators**: data updated within expected interval, version count within
retention limits.
**Stale indicators**: data older than refresh interval, too many versions
(missing GC), no recent writes.

## Extension Audit

Answer: "What extensions are installed and are they current?"

```bash
# 1. List installed extensions
swamp extension list --json

# 2. For each extension, verify configuration
swamp model type describe <type> --json
# Check: method signatures, schema completeness

# 3. Check for available updates
swamp extension search <name> --json
```

## Execution Timeline

Answer: "What happened across models and workflows in the last hour?"

```bash
# 1. Search audit log for recent activity
swamp audit search --json
# Filter by timestamp range

# 2. Correlate model executions with workflow runs
# Match: model method executions to workflow step completions

# 3. Identify causal chains
# Which workflow triggered which model method?
# Did any method failure cascade to workflow failure?
```

This inspector is the most powerful — it reveals the system's actual behavior
over time, not just its current state. Build it as a report for recurring use.
