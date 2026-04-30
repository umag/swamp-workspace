# CLI UX Patterns

## Error Messages

### Bad

```
Error: something went wrong
Error: ENOENT
Error: 404
Error: validation failed
```

### Good

```
Error: Model "my-vpc" not found. Run 'swamp model search' to see available models.
Error: Cannot delete model "my-vpc" — it has active workflow references. Remove references first or use --force.
Error: API returned 403 Forbidden for CreateBucket. Check that your credentials have s3:CreateBucket permission.
Error: Invalid YAML at line 12: expected string for 'name' field, got number.
```

### Template

```
Error: <operation> failed for <resource>. <cause>. <suggestion>.
```

## Help Text

### Bad

```
Usage: swamp model create [options]

Options:
  --name    name
  --type    type
  --json    json output
```

### Good

```
Usage: swamp model create <type> <name> [options]

Create a new model instance from a registered type.

Examples:
  swamp model create aws/ec2 my-vpc
  swamp model create aws/ec2 my-vpc --global-arg region=us-east-1

Options:
  --global-arg <key=value>  Set a global argument (repeatable)
  --json                    Output result as JSON for machine consumption
  --help                    Show this help message

See also: swamp model type search, swamp model get
```

## JSON Output

### Bad (inconsistent schema)

```json
// Sometimes returns object...
{ "name": "my-vpc", "status": "ready" }

// Sometimes returns just a string...
"my-vpc created successfully"
```

### Good (consistent schema)

```json
// Always same shape for same command
{
  "name": "my-vpc",
  "type": "aws/ec2",
  "status": "ready",
  "id": "abc-123",
  "path": "models/my-vpc.yaml"
}
```

### Error in JSON mode

```json
{
  "error": {
    "code": "MODEL_NOT_FOUND",
    "message": "Model 'my-vpc' not found",
    "suggestion": "Run 'swamp model search' to see available models"
  }
}
```

## Log Output

### Bad

```
Starting...
Done.
```

### Good

```
19:53:38.883 INF model·create Creating model "my-vpc" from type "aws/ec2"
19:53:38.945 INF model·create Model created at models/my-vpc.yaml
19:53:38.945 INF model·create Set global arguments with 'swamp model edit my-vpc'
```

## Flag Naming Conventions

| Flag               | Meaning                   | Consistency Rule                         |
| ------------------ | ------------------------- | ---------------------------------------- |
| `--json`           | JSON output mode          | Always means JSON, never "input is JSON" |
| `--name`           | Resource name             | Always the primary identifier            |
| `--force`          | Skip confirmation         | Only for destructive operations          |
| `--verbose` / `-v` | More detail               | Debug-level log output                   |
| `--quiet` / `-q`   | Less output               | Suppress non-essential output            |
| `--dry-run`        | Preview without executing | Show what would happen                   |

## Swamp-Specific Patterns

### Model Output: Log vs JSON

- **Log mode** (default): human-readable progress and results
- **JSON mode** (`--json`): machine-parseable, pipe to `jq`, use in scripts
- Every command that produces output must support both modes
- JSON mode must include ALL data that log mode shows

### Workflow Status Display

```
19:53:38 INF workflow·run Starting workflow "deploy-vpc"
19:53:39 INF workflow·run [step 1/3] Running "create-vpc"... done (1.2s)
19:53:40 INF workflow·run [step 2/3] Running "create-subnet"... done (0.8s)
19:53:41 INF workflow·run [step 3/3] Running "configure-routes"... done (0.5s)
19:53:41 INF workflow·run Workflow completed: 3/3 steps succeeded (2.5s total)
```
