# Quality Dimensions Reference

Pass criteria and NEEDS_WORK signals for the 7 dimensions in SKILL.md. A
dimension PASSES only when every pass criterion holds. Freedom levels, size
guidelines and anti-pattern examples are in `quality-criteria.md`.

## 1. Frontmatter Quality

Pass:

- `name` is kebab-case and matches the skill directory name.
- `description` says what the skill does, when to use it, and (when a sibling is
  close) when NOT to, naming that sibling.
- `description` is 1–1024 characters (hard limit of the skill format).
- Trigger phrases are ones a user would type, not internal jargon.

NEEDS_WORK signals:

- A description that only lists triggers, or only describes, but not both.
- "Triggers on all …" / "use for any …" — claims every request of a kind.
- Description over 1024 characters (tooling rejects the skill).

## 2. Progressive Disclosure

Pass:

- SKILL.md is under 500 lines and about 5000 words.
- Long examples, tables of options and background live in `references/`.
- SKILL.md says WHEN to open each reference ("before reporting, read …").

NEEDS_WORK signals:

- Worked examples longer than ~20 lines in the body.
- An empty or missing `references/` next to a long body.

## 3. Trigger Precision

Pass:

- Each trigger phrase maps to this skill's job and no sibling's.
- `evals/trigger_evals.json` has negative examples pointing at the sibling that
  should match instead.

NEEDS_WORK signals:

- Single-word triggers ("review", "fix", "code").
- A trigger that also appears in a sibling's description.

How to check: compare against the sibling list in SKILL.md and every other
`.claude/skills/*/SKILL.md` description in the project.

## 4. Instruction Quality

Pass:

- Steps are numbered and imperative ("Read …", "Run …").
- MUST is used only for hard requirements; SHOULD for defaults.
- There is an explicit check before the output is delivered.

NEEDS_WORK signals:

- Prose that describes a topic without telling Claude what to do.
- Steps that depend on information the skill never says how to get.

## 5. Context Window Budget

Pass:

- Every paragraph is project-specific or a decision rule Claude would not make
  on its own.
- No restated language syntax, stdlib APIs or general best practice.

NEEDS_WORK signals:

- Tutorial-style explanations of well-known tools.
- The same rule stated in two places.

## 6. Cross-Skill Consistency

Pass:

- Headings, table style and code-block style match sibling skills.
- Shared concepts use the same names as the siblings (e.g. severity levels).

NEEDS_WORK signals:

- A different report format for the same kind of review.
- Renamed concepts ("blocker" here, "CRITICAL" in siblings).

## 7. Reference Organization

Pass:

- Each reference file covers one topic and its name says which.
- Every file in `references/` is linked from SKILL.md, and every reference path
  SKILL.md mentions exists.

NEEDS_WORK signals:

- A reference file nothing links to (never loaded).
- A link to a file that does not exist (stale reference).

How to check: list `references/`, then search SKILL.md for each file name, and
for each `references/…` path in SKILL.md confirm the file exists.
