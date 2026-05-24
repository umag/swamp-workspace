# Dashboard Reports: Intermittent Load Failure

## Problem/Feature Description

The support team has escalated a ticket from a customer who says "sometimes the main dashboard doesn't show any reports — it just shows a loading spinner forever." The ticket was filed three days ago with no additional detail. No one on the team has been able to reproduce the behavior internally. The original reporter is currently on holiday and unavailable for follow-up. The only reproduction context provided is "it happened twice this week, both times on a Monday morning."

A junior engineer filed this as an issue in the lifecycle system and handed it off to you. You need to drive the issue through the initial triage step using the `swamp` lifecycle tooling. The repository root is at `/workspace/dashboard-app`.

## Output Specification

Produce the following files in your working directory:

1. **`triage-commands.sh`** — A shell script containing the `swamp` commands to drive this issue through the triage phase. The script should include all commands in order from creating the model instance through completing the triage step. Include brief comments explaining each section.

2. **`triage-input.yaml`** — The YAML input file that would be passed to the triage method call. Fill in all fields that you can determine from the available information.

Do not leave any large files (>50MB) on disk.
