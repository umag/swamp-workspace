# Implementation Plan: Machine-Readable CLI Output

## Problem/Feature Description

The DevOps team maintains a set of CI pipeline scripts that check the status of
open issues during deployment gates. Currently these scripts parse the
human-readable terminal output of the `swamp status` command using fragile regex
patterns. Every time the output formatting changes — which happens frequently as
the CLI evolves — the pipeline scripts break and someone has to manually patch
the regexes.

The team has agreed to add a `--json` flag to `swamp status` so CI pipelines can
consume structured output. The issue has already been triaged and the full
triage context is available in `inputs/triage-state.json`. You have been asked
to produce the implementation plan document that will be reviewed and approved
by the team before work begins.

The team follows a structured plan presentation format for all issues — the plan
is a human-facing decision document, not a design spec. It should allow the tech
lead to make a ship/refine/reject decision in about 30 seconds by skimming it.

## Output Specification

Write the implementation plan to **`plan.md`**.

The plan should cover how you would implement the `--json` flag for
`swamp status`, based on the affected areas and context in
`inputs/triage-state.json`. Use your knowledge of CLI tool patterns and
TypeScript conventions to fill in realistic details.

Do not produce any other output files.
