---
name: review-ux
description: >
  CLI UX review for output formatting, help text, error messages, JSON mode,
  and behavioral consistency. Ensures commands are discoverable, errors are
  actionable, and output modes are consistent. Must compare against existing
  commands for consistency. Triggers on "ux review", "review ux", "/review-ux",
  "cli output", "user experience review", "help text review", "error message
  review", "output format".
---

# UX Review

## When to Run

- New CLI commands or subcommands
- Changes to output formatting (log mode or JSON mode)
- New or modified error messages
- Changes to help text or flag definitions
- Workflow output formatting changes

## 5 Review Dimensions

### 1. Help Text & Discoverability

- Every command has `--help` with a clear one-line description
- Examples included in help text (at least one per command)
- Flag descriptions are specific: "Output as JSON for machine consumption" not
  "Output format"
- Related commands cross-referenced in help
- Subcommands logically grouped

**Good vs Bad — flag description:**

```
# Bad
--output   Output format

# Good
--output   Output format: "log" (default, human-readable) or "json"
           (machine-parseable, for use with jq or scripts)
```

### 2. Error Messages

Every error must answer: **WHAT** failed, **WHY** it failed, and **WHAT TO DO**
next.

Rules:

- No raw stack traces in user-facing output
- Reference the specific input that caused the failure
- Suggest the correct command or flag when possible
- Exit codes are meaningful (not all errors = exit 1)

**Good vs Bad — error message:**

```
# Bad
Error: command failed
  at Object.<anonymous> (/app/cli.js:42:11)

# Good
Error: could not connect to database "mydb" — connection refused on port 5432.
Run `cli db status` to verify the database is running, or pass --port to
override the default port.
```

### 3. Log-Mode Output

- Structured logging via LogTape with appropriate levels
- Progress indication for operations > 2 seconds
- Success/failure clearly indicated at the end
- Verbose output available with `--verbose` or `-v`
- Paired messages: every "Starting X..." has a corresponding "X complete"

**Good vs Bad — progress + completion:**

```
# Bad
(silence for 10 seconds)
done.

# Good
Deploying service "api"... (this may take ~30s)
  ✓ Build image
  ✓ Push to registry
  ✓ Update deployment
Deployment complete in 28s.
```

### 4. JSON-Mode Output

- Valid JSON (parseable by `jq`)
- Consistent schema: same command always returns same shape
- Machine-parseable: no human-only formatting mixed in
- Includes all relevant data (not a subset of log mode)
- Arrays for collections, objects for single items
- Error responses also valid JSON with `error` field

**Good vs Bad — error in JSON mode:**

```
# Bad (mixes prose into JSON output)
Deploying...
{"status": "ok"}

# Good
{"status": "ok", "service": "api", "duration_ms": 28341}

# Good error shape
{"error": "connection refused", "code": "DB_UNREACHABLE", "port": 5432}
```

### 5. Behavioral Consistency

- Similar commands behave similarly (all `create` commands work the same way)
- Flags consistent across commands: `--json` always means JSON output, `--name`
  always means resource name
- Destructive operations require confirmation or `--force`
- Output sorting/ordering is deterministic
- No surprises: command names match what they do

**Good vs Bad — flag consistency:**

```
# Bad — inconsistent naming across commands
cli user create --username alice
cli project create --project-name my-proj

# Good — consistent flag name for the resource name
cli user create --name alice
cli project create --name my-proj
```

## Review Process

1. Read the changed command/output code
2. **Compare against 2-3 similar existing commands** — don't review in isolation
3. Check each dimension
4. **Before writing the verdict**, confirm every dimension has at least one
   finding or an explicit "N/A — not applicable to this change" note. Do not
   skip a dimension silently.
5. Output findings with UX impact assessment

## Output Format

```
## UX Review | <scope>

### Verdict: APPROVE | SUGGEST_CHANGES

### Help Text & Discoverability
- [file:line] Finding with recommendation

### Error Messages
- [file:line] Finding with recommendation

### Log-Mode Output
- [file:line] Finding with recommendation

### JSON-Mode Output
- [file:line] Finding with recommendation

### Behavioral Consistency
- [file:line] Finding with recommendation

### Consistency Comparison
Compared against: <list of similar commands>
Inconsistencies found: X

Summary: X findings across 5 dimensions
```

## Verdict Rules

- UX review uses SUGGEST_CHANGES (not REQUEST_CHANGES) — UX issues are important
  but rarely blocking
- Exception: completely missing error handling or broken JSON output →
  REQUEST_CHANGES

See [references/patterns.md](references/patterns.md) for good/bad UX examples.
