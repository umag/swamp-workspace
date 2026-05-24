# Resume: Webhook Retry Backoff Lifecycle

## Problem/Feature Description

A colleague was driving the `webhook-retry-backoff` issue through its lifecycle and had to step away mid-flow. You have been asked to pick up where they left off. The complete lifecycle state at the point of handoff is in `inputs/session-state.json`.

The repository root is at `/workspace/webhooks-service`. You are currently working from a Claude Code worktree at `/workspace/webhooks-service/.claude/worktrees/webhook-retry-backoff`. The team uses the `swamp` lifecycle management toolset.

## Output Specification

Produce **`resume.sh`** — a shell script containing the `swamp` commands needed to correctly resume this lifecycle from exactly where it was left off and drive it through the next complete phase. The script should:

- Start with the commands needed to orient yourself before taking any action
- Check out the correct branch before reading or modifying any code
- Complete the current phase using the correct swamp commands and YAML files
- Include comments explaining each section

Do not leave any large files (>50MB) on disk.
