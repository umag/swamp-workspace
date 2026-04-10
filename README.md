# swamp-workspace

Swamp extensions monorepo. Each subdirectory is a self-contained extension
with its own `manifest.yaml`, `.swamp.yaml`, skills, models, and tests.

## Extensions

| Directory                                      | Package                       | Description                                    |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| [`issue-lifecycle/`](issue-lifecycle/README.md) | `@magistr/issue-lifecycle`    | Issue lifecycle model + 9 development skills   |

## Adding a new extension

Create a new directory at the repo root:

```
my-extension/
  .swamp.yaml           # swamp repo init --tool claude
  manifest.yaml         # extension manifest
  deno.json             # Deno dev config
  extensions/models/    # model source + tests
  .claude/skills/       # bundled skills (optional)
  README.md
```

Then add it to the CI matrix in `.github/workflows/ci.yml`.

## CI

PR checks:
- `deno-check` — fmt, lint, type check, test (per extension)
- `skill-review` — tessl quality review (per skill, threshold 0.90)
- `skill-trigger-eval` — promptfoo routing eval on sonnet (threshold 90%)

Push to main:
- `extension-publish` — auto-publishes when a `manifest.yaml` version bumps

## Development

```bash
# Run tests for an extension
cd issue-lifecycle/extensions/models
deno test issue_lifecycle.test.ts

# Build and run skill routing evals
deno run --allow-read --allow-write scripts/build-promptfoo-tests.ts
npx promptfoo eval -c promptfoo.generated.yaml

# Publish an extension
cd issue-lifecycle
swamp extension push manifest.yaml --dry-run
swamp extension push manifest.yaml --yes
```
