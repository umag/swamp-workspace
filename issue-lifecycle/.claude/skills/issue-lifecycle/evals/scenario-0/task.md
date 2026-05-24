# Lifecycle Automation: Authentication Regression

## Problem/Feature Description

The platform engineering team has been hit with a critical regression: users logging in from multiple geographic regions simultaneously are being logged out unexpectedly. The bug appears to have been introduced two weeks ago after a routine deploy to the session management service — several users have reported "it used to work fine before" and the support team has flagged it as `priority-high`. The root cause is suspected to be in the token validation middleware, which appears to be racing against a Redis cache invalidation during concurrent requests from different regions.

You have been asked to drive this issue through the lifecycle using the team's standard tooling. The repository root is at `/workspace/myapp` and you are currently working from a Claude Code worktree at `/workspace/myapp/.claude/worktrees/auth-fix-session`. The team uses the `swamp` lifecycle management toolset.

## Output Specification

Produce the following files in your working directory:

1. **`lifecycle.sh`** — A shell script that runs the complete sequence of `swamp` commands to drive this issue from filing through Phase 4 implementation start (ending with the call that signals the start of code review). The script should be executable and contain all the `swamp` commands in the correct sequence, using the correct flags and options. Include comments in the script that explain what each section does (e.g. `# Phase 1: Triage`, `# Phase 3: Fan out reviewers`, etc.).

2. **`triage-input.yaml`** — The YAML input file used for the triage method call, with all required fields filled in based on the bug description above.

3. **`plan-input.yaml`** — The YAML input file used for the plan method call, with steps, potentialChallenges, and reviewMatrix populated for this type of change (touching authentication session tokens and Redis cache).

4. **`findings-input.yaml`** — An example YAML input file for recording reviewer findings, with at least two findings from two different reviewers.

Do not leave any file larger than 50MB on disk.
