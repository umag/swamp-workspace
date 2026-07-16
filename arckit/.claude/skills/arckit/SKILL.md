---
name: arckit
description: >
  Drive enterprise-architecture governance projects end-to-end using the
  @magistr/arckit/workspace model — a standalone swamp port of ArcKit (no
  Claude plugin or Python CLI needed). A state machine gates 12 lifecycle
  phases (foundation → context → risk → business-case → requirements →
  design → procurement → design-review → delivery → operations → assurance →
  story) against ARC-* artifacts actually on disk; 65 bundled arc-kit
  templates drive document production. Triggers on "governance project",
  "start governance", "architecture governance", "arckit", "governance
  status", "advance phase", "governance gaps", "architecture principles",
  "requirements document", "risk register", "stakeholder analysis", "SOBC",
  "business case", "ADR", "wardley map for project", "HLD review",
  "secure by design", "TCoP", "governance artifact". Do NOT use for swamp
  issue tracking (use `issue-lifecycle`) or standalone Wardley strategy
  questions (use `weak-signal-analysis`).
---

# ArcKit Governance

Drive governance projects with the `@magistr/arckit/workspace` model. All
lifecycle state persists in swamp data; all artifacts are `ARC-*.md` markdown
files on disk — the disk is the source of truth and every phase gate re-scans
it.

## Core principles (sacred — never violate)

1. **Human approves every phase advance.** `advance` is only called after the
   human explicitly says one of: `approve`, `approved`, `looks good`,
   `ship
   it`, `go`, `LGTM`, `advance`. Producing artifacts is autonomous;
   advancing the lifecycle is not.
2. **Artifacts on disk are the truth.** Never claim a phase is satisfied without
   the artifact file existing — the model re-scans and will refuse. Write
   artifacts as `projects/{dir}/ARC-{ID}-{CODE}-v{VER}.md` exactly as
   `status.nextAction.suggestedFilename` proposes.
3. **Persist through the model.** Phase transitions, skips, and abandonment go
   through model methods so state survives sessions. Never track phase progress
   only in conversation.
4. **Skips are explicit and human-authorized.** `skipPhase` needs a
   human-provided reason; non-skippable phases (foundation, context, risk,
   requirements, design, assurance) cannot be skipped at all.
5. **Fill templates from inputs, not imagination.** Before writing an artifact,
   read the mandatory input artifacts (`template` output lists them) and
   interview the human for facts you cannot derive.

## One-time workspace setup

```bash
swamp model create @magistr/arckit/workspace governance
# set globalArguments.path in the instance YAML to the workspace root
swamp model method run governance init
swamp model method run governance provisionTemplates   # optional: on-disk template copies
```

## The loop (per project)

```bash
# 1. start (profile: standard | uk-gov | mod | ai)
swamp model method run governance startProject \
  --input title="NHS Appointment Booking" --input profile=uk-gov

# 2. where am I, what's next?
swamp model method run governance status --input project=001-nhs-appointment-booking
swamp data get governance 001-nhs-appointment-booking-status --json
#   → state, gate groups (satisfied per group), nextAction:
#     { command, templateFile, suggestedFilename, mandatoryInputs, alternatives }

# 3. fetch the template for the next artifact
swamp model method run governance template \
  --input command=requirements --input project=001-nhs-appointment-booking
swamp data get governance template-requirements --json   # .attributes.content

# 4. produce the artifact:
#    read mandatoryInputs artifacts from the project dir, interview the human,
#    fill the template, Write to projects/{dir}/{suggestedFilename}

# 5. present to the human; ONLY on explicit approval:
swamp model method run governance advance --input project=001-nhs-appointment-booking

# repeat 2-5 until state = complete
```

Phase-by-phase artifact guidance: [references/phases.md](references/phases.md).
State machine, gates per profile, and full method reference:
[references/state-machine.md](references/state-machine.md).

## Resuming a session

```bash
swamp model method run governance status --input project=<dir>
swamp data get governance <dir>-status --json
```

Dispatch on `state`: any lifecycle phase → continue the loop at step 3 for
`nextAction.command`; `complete`/`abandoned` → report only. Full history:
`swamp data get governance <dir> --json`.

## Workspace-level auditing (any time)

```bash
swamp model method run governance scan     # inventory all projects/artifacts
swamp model method run governance gaps     # mandatory-dependency violations
swamp model method run governance migrateClassification            # report-only
swamp model method run governance migrateClassification --input apply=true
```

CEL for wiring into workflows/reports:

```
data.latest("governance", "gaps").attributes.summary.projectsWithViolations
data.latest("governance", "<dir>-status").attributes.gateSatisfied
data.latest("governance", "<dir>").attributes.state
```

## Related skills

| Need                                 | Use skill              |
| ------------------------------------ | ---------------------- |
| Wardley mapping method + evolution   | `weak-signal-analysis` |
| Swamp issue tracking / TDD lifecycle | `issue-lifecycle`      |
| Swamp CLI mechanics                  | `swamp`                |
