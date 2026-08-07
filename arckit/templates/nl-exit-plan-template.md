# NL Cloud Exit Plan

> **Template Origin**: Community Overlay (nl-gov) | **ArcKit Version**:
> [VERSION] | **Command**: `/arckit:nl-exit`

> ⚠️ **NOT OFFICIALLY VALIDATED.** This is a community jurisdiction overlay
> template for the ArcKit swamp port. It is not reviewed or endorsed by EZK,
> BZK, or CISO Rijk. **Verify every citation against the primary source before
> relying on this document for a real continuity decision.**

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time to _partials/document-control-nl.md (default for the nl-gov profile), or _partials/document-control-uk.md / _partials/document-control-uae.md based on plugin userConfig classification_scheme + governance_framework. See _partials/RENDERING.md (when present). -->

## Revision History

| Version   | Date   | Author    | Changes                                         | Approved By | Approval Date |
| --------- | ------ | --------- | ----------------------------------------------- | ----------- | ------------- |
| [VERSION] | [DATE] | ArcKit AI | Initial creation from `/arckit:nl-exit` command | [PENDING]   | [PENDING]     |

## Legal & Policy Grounding

| Instrument                                       | Date / Reference                            | Relevance                                                                  |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------- |
| **Herziening rijksbreed cloudbeleid 2026, §3.2** | Ministerie van EZK, 3 juli 2026, definitief | Primary instrument — mandates this exit plan for materieel cloudgebruik.   |
| **`nl-cloud-assessment-template.md`**            | This project's `ARC-{ID}-NLCLD-v*.md`       | Mandatory input — this exit plan cannot be written before that assessment. |

## Document Purpose

[Brief description: this document is the mandatory, self-tested exit plan for
[SYSTEM/SERVICE NAME]'s public-cloud use, required by §3.2 of the Herziening
rijksbreed cloudbeleid 2026 whenever the linked `nl-cloud` assessment's verdict
is not `prohibited`. It covers two scenarios — a planned exit and a disruptive
interruption — plus data destruction after migration, and is reviewed annually.]

---

## Executive Summary

**System/service**: [SYSTEM/SERVICE NAME]

**Linked cloud eligibility assessment**: `ARC-{ID}-NLCLD-v*.md`, verdict:
**[ALLOWED / CONDITIONAL / DISCOURAGED]**

**Exit plan status**: [Drafted / Self-tested — date / Overdue for annual review]

**Last self-test date**: [DATE]

**Next mandatory annual review**: [DATE]

**Recommendation**: [Exit plan is adequate / Exit plan requires remediation
before the linked cloud use can proceed — see §5 findings]

---

## 1. Scope

**Service(s) covered by this exit plan**: [List — must match the scope of the
linked `nl-cloud` assessment]

**Data covered**: [Describe the data categories in scope, cross-referencing the
data-model artifact]

**Why an exit plan is required**: §3.2 requires an exit plan for materieel
cloudgebruik whenever public-cloud use is not prohibited outright (a
`prohibited` verdict from `nlCloudEligibility` means the service cannot be
placed on public cloud at all, so no exit plan is needed for it).

---

## 2. Scenario A — Planned Exit

A planned, voluntary migration away from the current provider (e.g. contract
end, better alternative, policy change).

| Field                               | Value                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| Trigger conditions                  | [e.g. contract expiry, strategic decision]                                            |
| Target destination                  | [Alternative provider / on-premise / ODC]                                             |
| Estimated migration duration        | [N weeks/months]                                                                      |
| Data migration approach             | [Bulk export, incremental sync, cutover method]                                       |
| Data format / portability           | [Format(s), API/licence exit rights — cross-ref `eu-sovereignty` §4 SOV-5/exit check] |
| Service continuity during migration | [How service level is maintained]                                                     |
| Rollback plan if migration fails    | [Describe]                                                                            |
| Owner                               | [Role]                                                                                |

**Step-by-step plan**:

1. [Step]
2. [Step]
3. [Step]

---

## 3. Scenario B — Disruptive Interruption

An unplanned, forced exit (e.g. provider insolvency, sanctions, sudden
jurisdiction change, service withdrawal, extra-territorial legal compulsion
affecting the supplier).

| Field                          | Value                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Trigger conditions             | [e.g. provider ceases operations, sanctions regime change, forced data disclosure to a foreign authority]         |
| Detection mechanism            | [How the organisation would learn of this in time to act]                                                         |
| Maximum tolerable downtime     | [RTO]                                                                                                             |
| Maximum tolerable data loss    | [RPO]                                                                                                             |
| Emergency data recovery source | [Backup location, escrow arrangement, replicated copy]                                                            |
| Interim continuity arrangement | [Fallback service/manual process while migrating]                                                                 |
| Communication plan             | [Who is notified — CISO Rijk melding per §3.3 of the linked `nl-cloud` assessment, stakeholders, Woo obligations] |
| Owner                          | [Role]                                                                                                            |

**Step-by-step plan**:

1. [Step]
2. [Step]
3. [Step]

---

## 4. Data Destruction After Migration

§3.2 requires data destruction after migration completes (either scenario).

| Field                                           | Value                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Destruction method                              | [Cryptographic erasure / certified wipe / physical destruction — specify] |
| Destruction confirmation evidence               | [Provider attestation, audit log, certificate of destruction]             |
| Retention exceptions (if any, with legal basis) | [e.g. Archiefwet retention requirement — cite]                            |
| Verification owner                              | [Role]                                                                    |
| Verification deadline after cutover             | [N days]                                                                  |

---

## 5. Self-Test Record

§3.2 requires the exit plan to be **self-tested**, not merely written.

| Test date | Scenario tested                | Test type                                             | Result              | Findings   | Remediation                              |
| --------- | ------------------------------ | ----------------------------------------------------- | ------------------- | ---------- | ---------------------------------------- |
| [DATE]    | [A — Planned / B — Disruptive] | [Tabletop exercise / Partial live drill / Full drill] | [Pass/Fail/Partial] | [Findings] | [Remediation actions + owner + deadline] |

**Untested scenario risk**: [If either scenario has never been tested, state
this explicitly and record a remediation deadline — a written-but-untested exit
plan does not satisfy §3.2.]

---

## 6. Annual Review Schedule

§3.2 requires review **annually**.

| Review date | Reviewer | Changes since last review | Outcome                                                   |
| ----------- | -------- | ------------------------- | --------------------------------------------------------- |
| [DATE]      | [Role]   | [Summary]                 | [Plan confirmed current / Updated — see revision history] |

**Next mandatory review**: [DATE — no more than 12 months from the last review]

---

## 7. Rubricering & Woo Note (§4.4)

Per §4.4 of the Herziening rijksbreed cloudbeleid 2026, this exit plan may
itself carry a rubricering and is subject to Woo (Wet open overheid) publication
obligations subject to that rubricering — see the Document Control block above
for this document's own rubricering.

---

## Sign-Off

| Role                     | Name   | Date | Signature |
| ------------------------ | ------ | ---- | --------- |
| Author                   | [Name] |      |           |
| CISO / equivalent        | [Name] |      |           |
| Senior Responsible Owner | [Name] |      |           |

---

## External References

> This section provides traceability from generated content back to source
> documents. Follow citation instructions in the project's citation reference
> guide.

### Document Register

| Doc ID          | Filename | Type | Source Location | Description |
| --------------- | -------- | ---- | --------------- | ----------- |
| _None provided_ | —        | —    | —               | —           |

### Citations

| Citation ID | Doc ID | Page/Section | Category | Quoted Passage |
| ----------- | ------ | ------------ | -------- | -------------- |
| —           | —      | —            | —        | —              |

### Unreferenced Documents

| Filename | Source Location | Reason |
| -------- | --------------- | ------ |
| —        | —               | —      |

---

**Generated by**: ArcKit `/arckit:nl-exit` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]
