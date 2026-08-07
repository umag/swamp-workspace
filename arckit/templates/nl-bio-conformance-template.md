# NL BIO2 Conformance Assessment

> **Template Origin**: Community Overlay (nl-gov) | **ArcKit Version**:
> [VERSION] | **Command**: `/arckit:nl-bio`

> ⚠️ **NOT OFFICIALLY VALIDATED.** This is a community jurisdiction overlay
> template for the ArcKit swamp port. It is not reviewed or endorsed by the
> OBDO, BZK, or any Dutch government body. **Verify every citation against the
> primary source (the published BIO2 text and its overheidsmaatregelen) before
> relying on this document for a real assurance decision.**

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time to _partials/document-control-nl.md (default for the nl-gov profile), or _partials/document-control-uk.md / _partials/document-control-uae.md based on plugin userConfig classification_scheme + governance_framework. See _partials/RENDERING.md (when present). -->

## Revision History

| Version   | Date   | Author    | Changes                                        | Approved By | Approval Date |
| --------- | ------ | --------- | ---------------------------------------------- | ----------- | ------------- |
| [VERSION] | [DATE] | ArcKit AI | Initial creation from `/arckit:nl-bio` command | [PENDING]   | [PENDING]     |

## Legal & Policy Grounding

| Instrument                    | Date / Reference                                                     | Relevance                                                                                  |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **BIO2**                      | Vastgesteld by OBDO **23 September 2025**; v1.3 dated **2026-01-09** | Primary instrument scored in this document.                                                |
| **NEN-EN-ISO/IEC 27001:2023** | —                                                                    | Information security management system standard BIO2 is built on.                          |
| **NEN-EN-ISO/IEC 27002:2022** | —                                                                    | Control-catalogue standard BIO2's overheidsmaatregelen (government measures) are built on. |

**Note**: BIO2 does **not** mandate ISO/IEC 27001 certification. The
**overheidsmaatregelen** (government-specific measures layered on top of the ISO
base) **are mandatory where applicable** — certification status and
overheidsmaatregelen conformance are tracked separately in this document (§4).

## Document Purpose

[Brief description: this document assesses the system/service's conformance to
BIO2, organised by the four ISO/IEC 27002:2022 control themes, records which
BIO2 overheidsmaatregelen apply and their conformance status, and notes
certification status separately from conformance.]

---

## Executive Summary

**System/service assessed**: [SYSTEM/SERVICE NAME]

**Overall BIO2 conformance**: [N] controls assessed

| Status            | Count | Percentage | Description                                    |
| ----------------- | ----- | ---------- | ---------------------------------------------- |
| 🟢 CONFORMANT     | [N]   | [%]        | Control implemented with evidence              |
| 🟠 PARTIAL        | [N]   | [%]        | Partially implemented, remediation plan exists |
| 🔴 NON-CONFORMANT | [N]   | [%]        | Control not implemented or evidence missing    |
| ⚪ NOT APPLICABLE | [N]   | [%]        | Scoped out — justification recorded            |

**ISO/IEC 27001:2023 certification status**: [Not sought — BIO2 does not mandate
certification / Certified — cert ref / In progress]

**Mandatory overheidsmaatregelen conformance**: [X]% ([N] of [M] applicable
measures conformant)

**Recommendation**: [PROCEED / PROCEED WITH CONDITIONS / DO NOT PROCEED —
ESCALATE]

---

## 1. BIO2 Scope & Applicability

**Organisation**: [ORGANISATION_NAME]

**BIO2 version assessed against**: v1.3, 2026-01-09 (vastgesteld by OBDO 23
September 2025)

**Scoping statement**: [Which parts of BIO2 apply to this system/service — e.g.
full scope, or a subset justified by the TBB/rubricering determination in
`nl-tbb`]

**Cross-reference**: BIO2 controls are typically scoped/weighted by the BIV/TBB
classification determined in `nl-tbb-classification-template.md`
(`ARC-{ID}-NLTBB-v*.md`) — higher TBB categories generally require stronger
implementation evidence, not different controls.

---

## 2. Conformance Scorecard (by ISO/IEC 27002:2022 Control Theme)

| Theme                         | Controls in scope | Conformant | Partial | Non-Conformant | N/A |
| ----------------------------- | ----------------- | ---------- | ------- | -------------- | --- |
| **Organizational**            | [N]               | [N]        | [N]     | [N]            | [N] |
| **People**                    | [N]               | [N]        | [N]     | [N]            | [N] |
| **Physical**                  | [N]               | [N]        | [N]     | [N]            | [N] |
| **Technological**             | [N]               | [N]        | [N]     | [N]            | [N] |
| **BIO2 overheidsmaatregelen** | [N]               | [N]        | [N]     | [N]            | [N] |

---

## 3. Detailed Control Assessment

### 3.1 Organizational Controls (ISO/IEC 27002:2022, clauses 5.x)

| Control   | Description                                    | BIO2 overheidsmaatregel? | Status     | Evidence                                                      |
| --------- | ---------------------------------------------- | ------------------------ | ---------- | ------------------------------------------------------------- |
| 5.1       | Policies for information security              | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence]                                                    |
| 5.9       | Inventory of information and assets            | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence]                                                    |
| 5.19      | Information security in supplier relationships | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence — cross-ref `eu-sovereignty` §4 SOV-5 supply chain] |
| 5.23      | Information security for cloud services        | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence — cross-ref `nl-cloud`]                             |
| 5.30      | ICT readiness for business continuity          | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence — cross-ref `nl-exit`]                              |
| [more...] |                                                |                          |            |                                                               |

### 3.2 People Controls (clauses 6.x)

| Control   | Description                                            | BIO2 overheidsmaatregel? | Status     | Evidence   |
| --------- | ------------------------------------------------------ | ------------------------ | ---------- | ---------- |
| 6.1       | Screening                                              | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence] |
| 6.3       | Information security awareness, education and training | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence] |
| [more...] |                                                        |                          |            |            |

### 3.3 Physical Controls (clauses 7.x)

| Control   | Description                  | BIO2 overheidsmaatregel? | Status     | Evidence                                                             |
| --------- | ---------------------------- | ------------------------ | ---------- | -------------------------------------------------------------------- |
| 7.1       | Physical security perimeters | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence — data centre location, cross-ref `nl-cloud` §5 residency] |
| 7.4       | Physical security monitoring | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence]                                                           |
| [more...] |                              |                          |            |                                                                      |

### 3.4 Technological Controls (clauses 8.x)

| Control   | Description             | BIO2 overheidsmaatregel? | Status     | Evidence                                                       |
| --------- | ----------------------- | ------------------------ | ---------- | -------------------------------------------------------------- |
| 8.5       | Secure authentication   | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence]                                                     |
| 8.12      | Data leakage prevention | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence]                                                     |
| 8.24      | Use of cryptography     | [Ja/Nee]                 | [🟢🟠🔴⚪] | [Evidence — cross-ref `nl-cloud` §5 encryption/key management] |
| [more...] |                         |                          |            |                                                                |

**Assessor note**: this template lists illustrative controls only. Enumerate the
FULL applicable control set from the published BIO2 v1.3 text before treating
this scorecard as complete — do not treat the rows above as exhaustive.

---

## 4. Certification vs Conformance

BIO2 does **not** mandate ISO/IEC 27001 certification. Track the two separately:

| Field                                                              | Value                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| ISO/IEC 27001:2023 certification pursued?                          | [Yes/No]                                                    |
| Certification status                                               | [N/A — not pursued / In progress / Certified — ref, expiry] |
| BIO2 overheidsmaatregelen conformance (mandatory where applicable) | [X]% — see §2                                               |

---

## 5. Findings & Remediation Plan

| # | Control      | Finding       | Impact                      | Remediation                  | Owner  | Deadline |
| - | ------------ | ------------- | --------------------------- | ---------------------------- | ------ | -------- |
| 1 | [Control ID] | [Description] | [Business/technical impact] | [Specific remediation steps] | [Role] | [Date]   |

---

## Sign-Off

| Role                         | Name   | Date | Signature |
| ---------------------------- | ------ | ---- | --------- |
| Author / Assessor            | [Name] |      |           |
| Information Security Officer | [Name] |      |           |
| Senior Responsible Owner     | [Name] |      |           |

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

**Generated by**: ArcKit `/arckit:nl-bio` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]
