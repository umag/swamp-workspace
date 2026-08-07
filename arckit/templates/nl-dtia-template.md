# NL Data Transfer Impact Assessment (DTIA)

> **Template Origin**: Community Overlay (nl-gov) | **ArcKit Version**:
> [VERSION] | **Command**: `/arckit:nl-dtia`

> ⚠️ **NOT OFFICIALLY VALIDATED.** This is a community jurisdiction overlay
> template for the ArcKit swamp port. It is not reviewed or endorsed by the
> Autoriteit Persoonsgegevens, EZK, BZK, or any Dutch government body. **Verify
> every citation against the primary source before relying on this document for
> a real transfer decision.** This template is **not gated by any phase** — it
> is produced on demand as a mandatory input wherever a third-country transfer
> without an adequacy decision is in scope (see §1).

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time to _partials/document-control-nl.md (default for the nl-gov profile), or _partials/document-control-uk.md / _partials/document-control-uae.md based on plugin userConfig classification_scheme + governance_framework. See _partials/RENDERING.md (when present). -->

## Revision History

| Version   | Date   | Author    | Changes                                         | Approved By | Approval Date |
| --------- | ------ | --------- | ----------------------------------------------- | ----------- | ------------- |
| [VERSION] | [DATE] | ArcKit AI | Initial creation from `/arckit:nl-dtia` command | [PENDING]   | [PENDING]     |

## Legal & Policy Grounding

| Instrument                                                         | Date / Reference                                                                                | Relevance                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Herziening rijksbreed cloudbeleid 2026, §3.1**                   | Ministerie van EZK, 3 juli 2026, definitief                                                     | Requires a DTIA as part of the integral risk assessment when there is a third-country transfer without an adequacy decision. |
| **UAVG** (Uitvoeringswet Algemene verordening gegevensbescherming) | Dutch GDPR implementing act — **verify exact citation before relying on any article reference** | General framework for personal-data transfer outside the EEA; not independently verified for this template beyond its name.  |
| **GDPR / AVG, Chapter V** (international transfers)                | —                                                                                               | Adequacy decisions, SCCs, BCRs, derogations — the transfer-mechanism vocabulary used in §3.                                  |

> ⚠️ This template's legal grounding for the transfer mechanisms in §3 rests on
> general GDPR Chapter V vocabulary (adequacy / SCCs / BCRs / derogations),
> which is **not** independently re-verified against UAVG article numbers as
> part of this task's verified-source set — confirm against the current UAVG
> text before citing a specific article.

## Document Purpose

[Brief description: this document assesses whether a specific data transfer to a
third country (a country outside the EEA and Switzerland) without an adequacy
decision can proceed, what legal transfer mechanism and supplementary measures
apply, and what residual risk of unauthorized government access remains.]

---

## Executive Summary

**Transfer assessed**: [Data categories] from [ORGANISATION_NAME] to [RECIPIENT]
in [DESTINATION COUNTRY]

**Adequacy decision in place for the destination country?**: [Yes — cite
decision / No]

**Transfer mechanism relied on** (if no adequacy decision): [Standard
Contractual Clauses / Binding Corporate Rules / Derogation — specify / None
identified — transfer cannot proceed as scoped]

**Overall transfer risk (residual, after supplementary measures)**: [LOW /
MEDIUM / HIGH / VERY HIGH]

**Conclusion**: [TRANSFER PERMITTED / TRANSFER PERMITTED WITH SUPPLEMENTARY
MEASURES / TRANSFER NOT PERMITTED — escalate]

---

## 1. Screening — Is This DTIA Required?

| Question                                                                                                    | Answer   | Evidence                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| Does this service/system transfer personal or governmental data to a country outside the EEA + Switzerland? | [Ja/Nee] | [Evidence, cross-ref data-model + `nl-cloud` §5 `supplierJurisdiction`/`processingRegion`] |
| Is there an EU adequacy decision covering the destination country?                                          | [Ja/Nee] | [Cite the adequacy decision, or its absence]                                               |

**Determination**: [DTIA REQUIRED — no adequacy decision covers this transfer /
DTIA NOT REQUIRED — adequacy decision in place, record it and stop here / DTIA
NOT REQUIRED — no third-country transfer exists]

If NOT REQUIRED, record the reason and skip to §8.

---

## 2. Transfer Description

**Mandatory inputs for this section**: `data-model` (`ARC-{ID}-DATA-v*.md`) and
`requirements` (`ARC-{ID}-REQ-v*.md`).

| Field                                     | Value                                                   |
| ----------------------------------------- | ------------------------------------------------------- |
| Data categories transferred               | [From data-model — list entities/fields]                |
| Personal data included?                   | [Yes/No — special category?]                            |
| Recipient(s)                              | [Name(s), role — controller/processor/sub-processor]    |
| Destination country / countries           | [Country]                                               |
| Purpose of the transfer                   | [Why the transfer is necessary — from requirements]     |
| Volume / frequency                        | [Records, frequency]                                    |
| Alternative to transferring (considered?) | [Was in-EEA/EU processing considered and rejected? Why] |

---

## 3. Legal Basis for Transfer

**For countries WITH an EU adequacy decision**:

- [ ] No additional safeguards required beyond standard data-protection
      measures. Adequacy decision reference: [CITE]

**For countries WITHOUT an adequacy decision**:

- [ ] **Standard Contractual Clauses (SCCs)** — version: [EU SCCs / UK
      IDTA+Addendum, if relevant to a mixed chain]. Date signed: [DATE].
      Recipient guarantees: [Summary]
- [ ] **Binding Corporate Rules (BCRs)** — approval date: [DATE], reference:
      [REF]
- [ ] **Derogation** (exceptional circumstances only) — basis: [Explicit consent
      / Necessary for contract performance / Necessary for legal claims /
      Important public interest — cite]

**Chosen mechanism and justification**: [DETAILED EXPLANATION]

---

## 4. Destination Country Legal Assessment

Assess the destination country's legal regime for government access to data,
independent of the contractual mechanism chosen in §3 (a Schrems-II-style
assessment).

| Factor                                                                                                                  | Assessment                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Does the destination country have laws compelling disclosure to government/intelligence authorities?                    | [Describe]                                                              |
| Is there judicial or independent oversight of such access?                                                              | [Describe]                                                              |
| Do data subjects have an effective remedy/redress mechanism in that country?                                            | [Describe]                                                              |
| Has the recipient received any such government access request historically (if known/disclosed)?                        | [Describe / Unknown — not disclosed]                                    |
| Is the recipient itself subject to conflicting legal obligations (e.g. extraterritorial law from a third jurisdiction)? | [Describe — cross-ref `eu-sovereignty` §4 SOV-2 Legal & Jurisdictional] |

**Conclusion on destination-country risk**: [LOW / MEDIUM / HIGH / VERY HIGH]

---

## 5. Supplementary Measures

Where §4 identifies material risk, record supplementary measures beyond the base
transfer mechanism.

**Technical measures**:

- [ ] Encryption in transit and at rest, with keys held **outside** the
      destination jurisdiction (cross-ref `nl-cloud` §5 §4.6 key-management
      control)
- [ ] Pseudonymization/anonymization before transfer where feasible
- [ ] Split processing (only the minimum necessary data crosses the border)

**Contractual measures**:

- [ ] Recipient contractually obligated to challenge unlawful government access
      requests and notify the controller
- [ ] Audit rights over the recipient's handling of access requests

**Organisational measures**:

- [ ] Internal policy restricting further onward transfer
- [ ] Regular review of the destination country's legal regime for change

---

## 6. Risk Assessment

| Risk                                                          | Likelihood        | Impact                      | Residual Risk (after §5 measures) |
| ------------------------------------------------------------- | ----------------- | --------------------------- | --------------------------------- |
| Unauthorized government access to transferred data            | [Low/Medium/High] | [Low/Medium/High/Very High] | [LOW/MEDIUM/HIGH/VERY HIGH]       |
| Recipient unable to notify due to gag order/secrecy provision | [Low/Medium/High] | [Low/Medium/High/Very High] | [LOW/MEDIUM/HIGH/VERY HIGH]       |
| Onward transfer to a further, unassessed jurisdiction         | [Low/Medium/High] | [Low/Medium/High/Very High] | [LOW/MEDIUM/HIGH/VERY HIGH]       |

---

## 7. Conclusion

**Decision**: [TRANSFER PERMITTED / TRANSFER PERMITTED WITH SUPPLEMENTARY
MEASURES (list required before go-live) / TRANSFER NOT PERMITTED]

**Rationale**: [Summary justification]

**Conditions (if any)**:

1. [Condition]
2. [Condition]

**Feeds into**: `nl-cloud-assessment-template.md` §3 (integral risk assessment)
and, where a discouraged/prohibited-entity check applies, the
`nlCloudEligibility` method's `supplierJurisdiction` argument.

---

## 8. Review Triggers

- [ ] Destination country's legal regime changes (new surveillance law,
      loss/gain of adequacy decision)
- [ ] Recipient or its sub-processors change
- [ ] Transfer volume or data categories change materially
- [ ] A government access request is received and disclosed
- [ ] Periodic review date reached: [DATE]

---

## Sign-Off

| Role                     | Name   | Date | Signature |
| ------------------------ | ------ | ---- | --------- |
| Author / Assessor        | [Name] |      |           |
| Data Protection Officer  | [Name] |      |           |
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

**Generated by**: ArcKit `/arckit:nl-dtia` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]
