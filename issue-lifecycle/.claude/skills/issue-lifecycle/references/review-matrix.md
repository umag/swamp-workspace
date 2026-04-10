# Review Matrix

## Which Reviews Activate When

Set `reviewMatrix` in the `plan` method to control which skills run during
plan review and code review phases.

| Skill | Field | Activate When |
|-------|-------|---------------|
| `review-code` | `code: true` | **Always** — primary reviewer |
| `review-adversarial` | `adversarial: true` | **Always** — finds what standard review misses |
| `review-security` | `security: true` | Code handles credentials, API keys, network calls, user input, file I/O |
| `review-ux` | `ux: true` | Code changes CLI output, help text, error messages, JSON mode |
| `review-skill` | `skill: true` | Changes to SKILL.md files or skill references |

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
3. **Record via model** — `swamp model method run issue-<N> record_review --input-file review.yaml`

```yaml
# review.yaml template
reviewer: review-code        # skill name
verdict: FAIL                # PASS | FAIL | SUGGEST_CHANGES
findings:
  - reviewer: review-code
    severity: HIGH           # CRITICAL | HIGH | MEDIUM | LOW
    file: src/my_file.ts
    line: 42
    description: Missing test for failure path
    fix: Add test for API error response
    status: open             # open | resolved | accepted | wontfix
```

## Aggregated Results

After ALL reviews are recorded, the human sees:
- Total findings by severity across all reviewers
- Which reviewers passed vs failed
- Whether any CRITICAL or HIGH findings block approval

## Approval Gate

The `approve_plan` method enforces **all three** conditions — fails with a
descriptive error if any one is violated:

1. **Full matrix coverage** — every reviewer listed in `reviewMatrix` (as
   `field: true`) must have recorded at least one `ReviewResult` for the
   current round. This is `allMatrixReviewersRecorded(reviews, matrix)`.
2. **Zero unresolved CRITICAL findings** across all reviews.
3. **Zero unresolved HIGH findings** across all reviews.

Findings with `status` of `resolved`, `accepted`, or `wontfix` do NOT block
approval — only `status: open` counts. This matches `hasBlockingFindings()`.

## Autonomous Loop Safety

When the skill drives the code-review loop autonomously (`review_code` →
`record_review` ×N → `iterate --input source=auto`), two safeguards prevent
runaway spinning:

1. **`findingSignature(reviews)`** — a stable hash of open CRITICAL/HIGH
   findings in the current round. If two successive iterations produce the
   same signature, the loop is not making progress. Bail out and escalate to
   the human rather than loop indefinitely. Signature is computed from
   `severity | category | description[:60]`, sorted — so minor textual edits
   to a finding's description do not mask a real loop.

2. **`codeReviewIteration` cap** — each `iterate` bumps the counter. A cap
   (e.g., 5) after which the loop exits with `outcome: "cap_reached"` in the
   final `reviewHistory` entry.

Every round's outcome is captured in `reviewHistory` (append-only), so you can
always reconstruct the trajectory via `swamp model get issue-<N> --json |
jq '.reviewHistory'`.
