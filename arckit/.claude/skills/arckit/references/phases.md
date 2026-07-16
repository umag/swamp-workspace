# Phase-by-phase artifact production

For every artifact: run `template` (with `project=` so the target filename is
filled in), read the `mandatoryInputs` artifacts from the project directory,
interview the human for facts you cannot derive, fill the template, and Write
the file to `projects/{dir}/{suggestedFilename}`. Keep the template's Document
Control table (version, classification, status) and fill every section — mark
genuinely inapplicable sections "Not applicable" with a reason rather than
deleting them. Bump the `-vN.N` filename suffix for revisions instead of
overwriting approved versions.

## foundation — principles

Global principles live in `projects/000-global/ARC-000-PRIN-v1.0.md` and satisfy
the gate for every project; write project-specific principles only when the
project genuinely deviates. Interview for: organizational values, regulatory
context, cloud/vendor posture, build-vs-buy bias. 10–15 principles, each with
rationale and implications.

## context — stakeholders

Map stakeholders → drivers → goals → measurable outcomes. Interview for the
actual people/roles; do not invent names. Include RACI and engagement level.

## risk — risk register

HM Treasury Orange Book style: cause → event → impact, inherent/residual
scoring, owners, mitigations. Seed from stakeholder concerns and principles.

## business-case — SOBC (skippable for internal/small work)

Green Book 5-case model (strategic, economic, commercial, financial,
management). Skip only when the human states funding/approval is already secured
— record that as the skip reason.

## requirements — requirements

The backbone artifact: BR-NNN business requirements, FR-NNN functional, NFR-NNN
non-functional, INT-NNN integration, DAT-NNN data. Every requirement traceable
to a stakeholder goal; MoSCoW priorities; acceptance criteria.

## design — one or more of research / data-model / wardley / adr / diagram / dfd / platform-design

Pick by project shape (`ai` profile also mandates data-model):

- market/vendor choice pending → research
- data-heavy or GDPR-relevant → data-model (then consider dpia — its mandatory
  inputs are data-model + requirements)
- strategic build-vs-buy → wardley (value-chain first, then map)
- concrete decisions taken → adr (one per decision)
- system shape communication → diagram / dfd

## procurement — sow | dos | gcloud-search | tenders (skippable for in-house builds)

sow for RFP-style procurement, dos for UK Digital Outcomes, gcloud-search
requirements for G-Cloud, tenders for market intelligence. evaluate/
gcloud-clarify follow once responses exist (their mandatory inputs chain).

## design-review — hld-review (skippable when no external design exists yet)

Review the vendor/team HLD against principles and requirements; verdict per
concern with severity. dld-review follows the same pattern at detail level.

## delivery — backlog (skippable for procurement-only projects)

Epics → user stories with acceptance criteria, mapped from requirements (every
FR/NFR lands in ≥1 story), sprint-organized.

## operations — operationalize | servicenow | devops | traceability (skippable pre-delivery)

operationalize for runbooks/DR/on-call, servicenow for ITSM design, devops for
CI/CD + IaC, traceability for the requirements→design→test matrix.

## assurance — analyze (+ tcop & secure on uk-gov, mod-secure on mod, ai-playbook & atrs on ai)

analyze is the cross-artifact governance quality report: coverage, consistency,
traceability breaks, gaps — cite artifact IDs as evidence. Compliance
assessments score each principle/control with evidence and remediation.

## story — story (skippable)

Project narrative for the governance record: timeline from artifact history,
decisions, outcomes vs stakeholder goals.
