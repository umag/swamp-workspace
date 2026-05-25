# Autonomous Review Loop Analysis

## Problem/Feature Description

The `notification-dispatch-refactor` issue has been running through the
autonomous plan-review loop. The loop has been iterating automatically, revising
the plan and re-running reviewers each round. The current state of the loop —
including the hydrate summary from the most recent round and the full review
history — is captured in `inputs/loop-state.json`.

The team lead needs you to analyze the situation and produce the message that
should be presented to the human engineer at this point in the loop, based on
what the autonomous loop control flow dictates.

## Output Specification

Produce **`handover.md`** — the message to present to the human engineer given
the current loop state. The message should accurately reflect what the loop's
control flow dictates in this situation, describe the current state clearly, and
give the engineer enough information to decide how to proceed.

Do not produce any other output files. Do not leave large files (>50MB) on disk.
