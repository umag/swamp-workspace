# @magistr/arckit

A standalone swamp port of [ArcKit](https://github.com/tractorjuice/arc-kit) —
the Enterprise Architecture Governance Harness — as a skill-driven state
machine. No ArcKit Claude plugin and no Python CLI required: the templates are
bundled, the Python CLI's behavior (`init`, classification migration) is
reimplemented in the model, and the bundled `arckit` skill drives document
production through the lifecycle.

ArcKit organizes governance as markdown artifacts (`ARC-{ID}-{TYPE}-v{VER}.md`)
inside `projects/NNN-name/` directories. This extension owns both the **state
machine** (which phase each project is in, gated against artifacts actually on
disk) and the **material** (65 bundled arc-kit templates served on demand).

## Model type: `@magistr/arckit/workspace`

| Global argument | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `path`          | Absolute path to the ArcKit workspace root (contains `projects/`) |

### Lifecycle (state machine, driven by the bundled `arckit` skill)

Phases:
`foundation → context → risk → business-case → requirements → design
→ procurement → design-review → delivery → operations → assurance → story →
complete`.
Profiles (`standard | uk-gov | mod | ai`) add gate groups — e.g. `uk-gov`
requires TCoP and Secure-by-Design assessments in assurance.

- **`startProject`** `{title, profile?, dir?}` — allocate the next
  `projects/NNN-slug/` directory and enter `foundation`.
- **`status`** `{project}` — evaluate the current phase gate against the
  artifacts on disk; emits the suggested next action (command, template file,
  target `ARC-*` filename, mandatory inputs).
- **`advance`** `{project, note?}` — gate-checked transition to the next phase;
  refuses (with the missing list) while any gate group lacks an artifact. Last
  phase advances to `complete`.
- **`skipPhase`** `{project, reason}` — explicit, recorded bypass of a skippable
  phase (business-case, procurement, design-review, delivery, operations,
  story).
- **`abandon`** `{project, reason}` — close from any state.

### Templates (bundled, arc-kit v6.2.0)

- **`template`** `{command, project?}` — one template's content plus doc code,
  suggested `ARC-{ID}-{CODE}-v1.0.md` filename, and the mandatory input
  artifacts to read first (from the dependency matrix).
- **`templates`** — catalog of all bundled templates.
- **`provisionTemplates`** — copy the bundle into `.arckit/templates/`
  (refreshes defaults; `.arckit/templates-custom/` is never touched).

### Workspace auditing

- **`init`** — idempotent workspace skeleton scaffold.
- **`scan`** — full inventory: every project, every `ARC-*` artifact parsed into
  doc type / command / version / instance, with size and mtime.
- **`gaps`** — mandatory-dependency matrix check per project (artifact present
  while a mandatory upstream input is missing) plus the next step on the
  standard critical path. `projects/000-global/` artifacts satisfy dependencies
  workspace-wide.
- **`migrateClassification`** `{apply?}` — port of
  `arckit migrate-classification`: UK ladder → UAE Smart Data ladder over every
  artifact's Document Control table. Report-only unless `apply=true`.

### Example

```bash
swamp model create @magistr/arckit/workspace governance
# set globalArguments.path in the instance YAML, then:
swamp model method run governance init
swamp model method run governance startProject --input title="Payments Gateway" --input profile=uk-gov
swamp model method run governance status --input project=001-payments-gateway
swamp model method run governance template --input command=principles --input project=001-payments-gateway
# ...write the artifact, get human approval...
swamp model method run governance advance --input project=001-payments-gateway
```

CEL access:

```
data.latest("governance", "001-payments-gateway").attributes.state
data.latest("governance", "001-payments-gateway-status").attributes.gateSatisfied
data.latest("governance", "gaps").attributes.summary.projectsWithViolations
```

### Notes

- Doc-code table covers all 62 ArcKit document types, including hyphenated codes
  (`PRIN-COMP`, `SECD-MOD` — matched longest-first) and multi-instance artifacts
  (`DFD-2`, `WVCH-1`).
- Unrecognized `ARC-*` doc types surface in `scan`'s `unmappedDocTypes`.
- Templates and the dependency matrix derive from arc-kit v6.2.0 (MIT, ©
  tractorjuice); this extension redistributes the templates unmodified.
