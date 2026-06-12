# Resume: CSV Import Validation Lifecycle

## Problem/Feature Description

A colleague was driving the `csv-import-validation` issue through its lifecycle
and had to step away mid-flow. You have been asked to pick up where they left
off. The complete lifecycle state at the point of handoff is in
`inputs/lifecycle-state.json`.

The repository root is at `/workspace/import-service`. You are currently working
from a Claude Code worktree at
`/workspace/import-service/.claude/worktrees/csv-import-validation`. The team
uses the `swamp` lifecycle management toolset.

## Output Specification

Produce **`resume.sh`** — a shell script containing the `swamp` commands needed
to correctly resume this lifecycle from exactly where it was left off and drive
it through the current phase. The script should:

- **Begin with a 3–5 line orientation comment block** naming the current
  lifecycle state and the skill reference file being followed for this phase
- Start with the commands needed to orient yourself before taking any action
- Check out the correct branch before reading or modifying any code
- Complete the current phase using the correct swamp commands and YAML files,
  with comments explaining each section
- The phase boundary for this fixture is `tests_approved` transitioning the
  model to `implementing` — include all commands through that gate

Do not leave any large files (>50MB) on disk.
