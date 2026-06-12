# Review Matrix

## Which Reviews Activate When

Set `reviewMatrix` in the `plan` method to control which skills run during the
plan review (Phase 3), test review (Phase 4a), and code review (Phase 5) phases.
The same matrix governs all three: `record_review` is accepted in `reviewing`,
`reviewing_tests`, and `code_reviewing`, and the activation criteria below apply
to test files too (e.g. if the change touches credentials, `review-security`
also reviews the tests).

| Skill                | Field               | Activate When                                                           |
| -------------------- | ------------------- | ----------------------------------------------------------------------- |
| `review-code`        | `code: true`        | **Always** — primary reviewer                                           |
| `review-adversarial` | `adversarial: true` | **Always** — finds what standard review misses                          |
| `review-security`    | `security: true`    | Code handles credentials, API keys, network calls, user input, file I/O |
| `review-ux`          | `ux: true`          | Code changes CLI output, help text, error messages, JSON mode           |
| `review-skill`       | `skill: true`       | Changes to SKILL.md files or skill references                           |

## Determining the Matrix

When creating a plan, set the matrix based on what the plan touches:

```yaml
# Touches API credentials and network calls
reviewMatrix:
  code: true
  adversarial: true
  security: true
  ux: false
  skill: false

# New CLI command with help text
reviewMatrix:
  code: true
  adversarial: true
  security: false
  ux: true
  skill: false

# New skill creation
reviewMatrix:
  code: true
  adversarial: false
  security: false
  ux: false
  skill: true
```

## Review Protocol

For each active reviewer in the matrix:

1. **Invoke the skill** — run `/review-code`, `/review-adversarial`, etc.
2. **Capture the structured output** — the skill produces findings with severity
3. **Record via model** —
   `swamp model method run issue-<N> record_review --input-file review.yaml`

```yaml
# review.yaml template
reviewer: review-code # skill name
verdict: FAIL # PASS | FAIL | SUGGEST_CHANGES
findings:
  - reviewer: review-code
    severity: HIGH # CRITICAL | HIGH | MEDIUM | LOW
    file: src/my_file.ts
    line: 42
    description: Missing test for failure path
    fix: Add test for API error response
    status: open # open | resolved | accepted | wontfix
```

## Aggregated Results

After ALL reviews are recorded, the human sees:

- Total findings by severity across all reviewers
- Which reviewers passed vs failed
- Whether any CRITICAL or HIGH findings block acceptance

The `approve_plan` and `tests_approved` methods both enforce: full matrix
coverage AND zero open CRITICAL AND zero open HIGH findings. The difference is
the trigger: `approve_plan` requires the human's explicit phrase, while
`tests_approved` (Phase 4a) fires autonomously once the gate is satisfied.
