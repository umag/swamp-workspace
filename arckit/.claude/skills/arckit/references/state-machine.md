# ArcKit governance state machine

One state data artifact per project (`swamp data get <instance> <dir> --json`).
Written by `startProject`; every transition appends to `history`.

## States and transitions

```
(start) ──startProject──> foundation
foundation ──advance──> context ──advance──> risk ──advance──> business-case
business-case ──advance|skipPhase──> requirements ──advance──> design
design ──advance──> procurement ──advance|skipPhase──> design-review
design-review ──advance|skipPhase──> delivery ──advance|skipPhase──> operations
operations ──advance|skipPhase──> assurance ──advance──> story
story ──advance|skipPhase──> complete

any state ──abandon──> abandoned
```

`advance` re-scans the workspace and refuses unless every gate group of the
current phase has at least one artifact on disk. `skipPhase` requires a reason
and only works on skippable phases. Artifacts in `projects/000-global/`
(typically principles) satisfy gates for every project.

## Gates per phase

| Phase         | Gate (each group needs ≥1 artifact)                                                                     | Skippable |
| ------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| foundation    | principles                                                                                              | no        |
| context       | stakeholders                                                                                            | no        |
| risk          | risk                                                                                                    | no        |
| business-case | sobc                                                                                                    | yes       |
| requirements  | requirements                                                                                            | no        |
| design        | research \| aws/azure/gcp-research \| data-model \| wardley \| adr \| diagram \| dfd \| platform-design | no        |
| procurement   | sow \| dos \| gcloud-search \| tenders                                                                  | yes       |
| design-review | hld-review                                                                                              | yes       |
| delivery      | backlog                                                                                                 | yes       |
| operations    | operationalize \| servicenow \| devops \| traceability                                                  | yes       |
| assurance     | analyze                                                                                                 | no        |
| story         | story                                                                                                   | yes       |

## Profile extras (added gate groups)

| Profile  | Extra requirements                                     |
| -------- | ------------------------------------------------------ |
| standard | —                                                      |
| uk-gov   | assurance: + tcop, + secure                            |
| mod      | assurance: + mod-secure                                |
| ai       | design: + data-model; assurance: + ai-playbook, + atrs |

## Method reference

| Method                  | Arguments                   | Effect                                                                   |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `startProject`          | `title`, `profile?`, `dir?` | Allocate `projects/NNN-slug/`, state → foundation                        |
| `status`                | `project`                   | Gate evaluation + nextAction → `<dir>-status` data                       |
| `advance`               | `project`, `note?`          | Gate-checked move to next phase (last phase → complete)                  |
| `skipPhase`             | `project`, `reason`         | Record skip, move on (skippable phases only)                             |
| `abandon`               | `project`, `reason`         | State → abandoned from anywhere                                          |
| `template`              | `command`, `project?`       | Bundled template content + doc code + target filename + mandatory inputs |
| `templates`             | —                           | Catalog of all 60+ bundled templates                                     |
| `init`                  | —                           | Idempotent workspace skeleton                                            |
| `provisionTemplates`    | —                           | Copy bundled templates → `.arckit/templates/`                            |
| `scan`                  | —                           | Full artifact inventory → `workspace` data                               |
| `gaps`                  | —                           | Mandatory-dependency violations → `gaps` data                            |
| `migrateClassification` | `apply?`                    | UK→UAE classification ladder migration (report-only by default)          |

## Error contract

- `advance` on unmet gate → error listing `command | command` groups still
  missing. Produce one artifact per missing group, then retry.
- `startProject` on an in-flight project dir → error; use `status`, or `abandon`
  first.
- `skipPhase` on a non-skippable phase → error; the artifacts are mandatory.
