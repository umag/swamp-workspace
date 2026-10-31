<!-- arckit-overlay-template: uk-mdr-classification-template.md -->

# UK MDR + EU MDR Software-as-Medical-Device Classification — [PRODUCT_NAME]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-mdr-classification`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                       | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:uk-mdr-classification` command | PENDING     | PENDING       |

---

## Statutory currency

This assessment is pinned to:

- UK MDR 2002 as amended through the Medical Devices (Amendment) (Great Britain)
  Regulations 2024 (and any subsequent published amendments at the assessment
  date below)
- EU MDR 2017/745 (current text)
- MHRA Software and AI as a Medical Device Programme — work packages published
  as of the assessment date below

**Assessment date**: [YYYY-MM-DD]

> The MHRA AIaMD Programme is publishing work packages incrementally. Re-run
> `/arckit:uk-mdr-classification` when material MHRA updates are published. UK
> MDR reform is in train — verify the legal text against legislation.gov.uk
> before reliance.

---

## Executive Summary

| Field                                     | Value                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| **Is this product a medical device?**     | [Yes / No / Borderline — see §1]                                    |
| **UK MDR 2002 class (if yes)**            | [I / IIa / IIb / III / N/A]                                         |
| **EU MDR 2017/745 class (if yes)**        | [I / IIa / IIb / III / N/A]                                         |
| **Marking pathway**                       | [UKCA only / UKCA + UKNI / UKCA + UKNI + CE / CE only via NI / N/A] |
| **Conformity-assessment route**           | [Self-declaration / Approved Body / Notified Body / N/A]            |
| **Quality Management System expectation** | [ISO 13485 / N/A]                                                   |
| **Standards alignment expected**          | [ISO 14971, IEC 62304, IEC 62366-1, ISO/IEC 27001, others]          |

[One paragraph: classification rationale in plain English, what this means for
product placement, recommended next regulatory step.]

---

## 1. Scope determination — is this a medical device?

### 1.1 Intended-purpose statement (verbatim from upstream artefacts)

> [Quote the intended-purpose / intended-use statement from the project's REQ /
> SAFETY-CASE / similar. This is the load-bearing input. Small wording changes
> materially change the classification.]

### 1.2 UK MDR 2002 regulation 2 definition test

The product is a medical device if it is intended by the manufacturer to be used
for human beings for the purpose of:

- diagnosis, prevention, monitoring, treatment or alleviation of disease
- diagnosis, monitoring, treatment, alleviation of or compensation for an injury
  or handicap
- investigation, replacement, or modification of the anatomy or of a
  physiological process
- control of conception

…and which does not achieve its principal intended action by pharmacological,
immunological or metabolic means.

| Test point                                                                            | Applies?   | Notes |
| ------------------------------------------------------------------------------------- | ---------- | ----- |
| Diagnosis / prevention / monitoring / treatment / alleviation of disease              | [Yes / No] |       |
| Diagnosis / monitoring / treatment / alleviation / compensation for injury / handicap | [Yes / No] |       |
| Investigation / replacement / modification of anatomy or physiological process        | [Yes / No] |       |
| Control of conception                                                                 | [Yes / No] |       |
| Principal action NOT pharmacological / immunological / metabolic                      | [Yes / No] |       |

### 1.3 MHRA stand-alone software decision tree

| Decision point                                                                                                 | Outcome    |
| -------------------------------------------------------------------------------------------------------------- | ---------- |
| Does the software perform an action on data different from storage, archival, communication, simple search?    | [Yes / No] |
| Is the action performed for the benefit of an individual patient?                                              | [Yes / No] |
| If both Yes → likely medical device (continue to §2). If either No → likely not a medical device (skip to §5). |            |

### 1.4 Borderline rationale (if applicable)

[If the case is borderline, document the rationale here, citing the MHRA
Borderline Manual examples that are closest. Recommend MHRA pre-submission
borderline review. State explicitly that the assessment proceeds on the
assumption [Yes / No], and the consequences if MHRA reaches a different
conclusion.]

### 1.5 Determination

> **Determination**: This product **[IS / IS NOT / IS BORDERLINE]** a medical
> device under UK MDR 2002 and EU MDR 2017/745.

If **IS NOT**: skip to §5 (Not-a-medical-device closure). If **IS** or **IS
BORDERLINE**: continue.

---

## 2. UK MDR 2002 classification

### 2.1 Classification rules applied

[Identify which classification rules from UK MDR 2002 Schedule 9 (as amended)
apply. For SaMD, this is typically driven by the corresponding rule on
stand-alone software. State the rule + reasoning.]

### 2.2 Determination

> **UK MDR 2002 Class**: [I / IIa / IIb / III]

### 2.3 Subclass flags

| Flag                         | Applicable?               | Rationale |
| ---------------------------- | ------------------------- | --------- |
| Sterile                      | [Yes / No / N/A for SaMD] |           |
| Measuring function           | [Yes / No]                |           |
| Reusable surgical instrument | [Yes / No / N/A for SaMD] |           |

### 2.4 Self-certification eligibility

| Eligibility                                                        | Status      | Notes |
| ------------------------------------------------------------------ | ----------- | ----- |
| Self-certification permitted (Class I, non-sterile, non-measuring) | [Yes / No]  |       |
| If self-certified, manufacturer registration with MHRA required    | [Yes / N/A] |       |

---

## 3. EU MDR 2017/745 classification (for NI placement and EU market access)

### 3.1 Rule 11 application (software)

[Apply Rule 11 with explicit reasoning. Walk through the decision points: does
the software provide information used to take decisions with diagnostic /
therapeutic purposes? Could those decisions cause death / irreversible
deterioration → Class III. Could they cause serious deterioration or surgical
intervention → Class IIb. Otherwise → Class IIa. Or: software intended to
monitor physiological processes → Class IIa, except monitoring of vital
physiological parameters where variations could cause immediate danger → Class
IIb. All other software → Class I.]

### 3.2 Other rules considered

[If any other classification rule applies (e.g. rule for software intended to
drive or influence active device, rule for software involving liquids in contact
with human body), state the rule and outcome.]

### 3.3 Determination

> **EU MDR 2017/745 Class**: [I / IIa / IIb / III]

### 3.4 Divergence from UK MDR

|                  | UK MDR 2002 | EU MDR 2017/745     |
| ---------------- | ----------- | ------------------- |
| Class            | [Class]     | [Class]             |
| Conformity route | [Route]     | [Route]             |
| Marking          | UKCA        | CE (or UKNI for NI) |

[If the two classifications diverge, explain why and which is more
conservative.]

---

## 4. Marking pathway

| Pathway                                                                  | Required?                     | Conditions                                                             |
| ------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------- |
| **UKCA marking** (Great Britain placement)                               | [Yes / No]                    | MHRA registration; Approved Body involvement if Class IIa+             |
| **UKNI marking** (Northern Ireland placement of GB-manufactured)         | [Yes / No / N/A]              | Notified Body involvement required; UKNI alone not valid in rest of EU |
| **CE marking** (NI placement under Windsor Framework + EU market access) | [Yes / No]                    | Notified Body in NI or EU; EUDAMED registration                        |
| **Recognition of CE marking in GB** (transitional)                       | [Applicable / Not applicable] | Transitional arrangements have moved repeatedly — verify against MHRA  |

### 4.1 Recommended routing

[State the practical routing for this product given its intended markets. E.g.
"UKCA + CE for full UK + EU coverage", "UKCA only for GB-only product", "UKCA +
UKNI for UK-only product including NI".]

### 4.2 Registration obligations

| Obligation                                                    | Status                      | Notes |
| ------------------------------------------------------------- | --------------------------- | ----- |
| MHRA Device Online Registration System (DORS)                 | [In place / PENDING]        |       |
| EUDAMED registration (if CE-marked)                           | [In place / PENDING]        |       |
| UK Responsible Person (if non-UK manufacturer)                | [Appointed / PENDING / N/A] |       |
| EU Authorised Representative (if non-EU manufacturer with CE) | [Appointed / PENDING / N/A] |       |

---

## 5. Conformity-assessment route

| Class                                             | UK route         | EU route         |
| ------------------------------------------------- | ---------------- | ---------------- |
| Class I (non-sterile, non-measuring)              | Self-declaration | Self-declaration |
| Class I (sterile / measuring / reusable surgical) | Approved Body    | Notified Body    |
| Class IIa                                         | Approved Body    | Notified Body    |
| Class IIb                                         | Approved Body    | Notified Body    |
| Class III                                         | Approved Body    | Notified Body    |

| Conformity item                       | Status                  | Notes                                                   |
| ------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Technical documentation prepared      | [PASS / FAIL / PENDING] | Annex II / Annex III equivalents                        |
| Quality Management System (ISO 13485) | [PASS / FAIL / PENDING] | Required for non-Class I; signposted not generated here |
| Clinical evaluation                   | [PASS / FAIL / PENDING] | Literature route / clinical investigation / PMCF        |
| Declaration of Conformity             | [PASS / FAIL / PENDING] |                                                         |

### Not-a-medical-device closure (only if §1 reached IS NOT)

[Provide the explicit reasoning that this product is not a medical device,
citing the MHRA Borderline Manual example closest to this product. Identify the
responsible person at the manufacturer who signs off this determination. Record
that the manufacturer will not place this product as a medical device and will
not represent it as such in marketing or instructions.]

---

## 6. MHRA SaMD / AIaMD Programme considerations

| MHRA Change Programme Work Package           | Applicable to this product? | Status / commitment |
| -------------------------------------------- | --------------------------- | ------------------- |
| WP1 Qualification                            | [Yes / N/A]                 |                     |
| WP2 Classification                           | [Yes / N/A]                 |                     |
| WP3 Premarket requirements                   | [Yes / N/A]                 |                     |
| WP4 Post Market                              | [Yes / N/A]                 |                     |
| WP5 Cyber Secure Medical Devices             | [Yes / N/A]                 |                     |
| WP9 AI Rigour                                | [Yes / N/A — if AI/ML]      |                     |
| WP10 Project Glass Box (AI interpretability) | [Yes / N/A — if AI/ML]      |                     |
| WP11 Project Ship of Theseus (AI adaptivity) | [Yes / N/A — if AI/ML]      |                     |

[Work package names follow the MHRA Software and AI as a Medical Device Change
Programme roadmap. WP6–WP8 have no discrete deliverables; their content was
absorbed into the others. Update the WP list and status from the roadmap at the
assessment date; the programme is publishing incrementally.]

---

## 7. Standards alignment

| Standard                              | Applicable?                           | Status                  | Notes                                                                 |
| ------------------------------------- | ------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| ISO 14971 (risk management)           | Yes                                   | [PASS / FAIL / PENDING] | Cross-reference DCB0129 hazard log at `clinical-safety/HAZARD-LOG.md` |
| IEC 62304 (software lifecycle)        | Yes                                   | [PASS / FAIL / PENDING] | Software safety class A / B / C from hazard analysis: [class]         |
| ISO 13485 (QMS)                       | [If Class IIa+ or chosen for Class I] | [PASS / FAIL / PENDING] | Signposted only                                                       |
| IEC 62366-1 (usability engineering)   | [If safety-critical UI]               | [PASS / FAIL / PENDING] |                                                                       |
| ISO/IEC 27001 (information security)  | Yes                                   | [PASS / FAIL / PENDING] | Cross-reference `/arckit:secure` output                               |
| ISO/IEC 25010 (software quality)      | Recommended                           | [PASS / FAIL / PENDING] |                                                                       |
| ISO/IEC TR 24028 (AI trustworthiness) | [If AIaMD]                            | [PASS / FAIL / PENDING] |                                                                       |
| BS EN 82304-1 (health software)       | Recommended                           | [PASS / FAIL / PENDING] |                                                                       |

---

## 8. Post-market obligations

### 8.1 Post-market surveillance (PMS) plan

[Outline the PMS plan: data sources, cadence, escalation triggers, reporting
cadence. Required for all classes; depth scales with class.]

### 8.2 Vigilance reporting

| Event                                 | Reporting timeline                                                                                                                                              | Recipient                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Serious incident (UK)                 | No later than 15 days after awareness (10 days for death or unanticipated serious deterioration; 2 days for a serious public health threat)                     | MHRA                            |
| Serious incident (EU)                 | No later than 15 days after awareness (10 days for death or unanticipated serious deterioration; 2 days for a serious public health threat) — EU MDR Article 87 | Competent Authority via EUDAMED |
| Field Safety Corrective Action (FSCA) | Without undue delay                                                                                                                                             | MHRA / Competent Authority      |

### 8.3 Periodic Safety Update Report (PSUR)

| Class     | Cadence (EU MDR Article 86)                              |
| --------- | -------------------------------------------------------- |
| Class III | At least annually                                        |
| Class IIb | At least annually                                        |
| Class IIa | When necessary and at least every two years              |
| Class I   | Not required (but PMS report under EU MDR Article 85 is) |

[For GB placement, confirm the periodic reporting schedule against the MHRA
post-market surveillance requirements in force from 16 June 2025.]

### 8.4 Trend reporting

[State the trend-reporting approach for statistically significant increases in
non-serious incidents.]

### 8.5 AIaMD substantial-change handling (if AI)

[For AI products, the line between "expected adaptation" and "substantial change
requiring reassessment" is regulator-defined. State the threshold, the
monitoring approach, and the change-control process.]

---

## 9. Substantial change triggers

| Trigger                                              | Action                                                 | Notes                         |
| ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------- |
| Change of intended purpose                           | Reassess classification                                | Material risk of class change |
| New clinical indication                              | Reassess classification and clinical evaluation        |                               |
| Change of risk profile                               | Reassess risk file (ISO 14971) and clinical evaluation |                               |
| Change of intended-user population                   | Reassess usability evaluation and clinical evaluation  |                               |
| Change of intended patient population                | Reassess clinical evaluation                           |                               |
| Change of operating principle (e.g. rule-based → ML) | Reassess software safety class and AIaMD applicability |                               |

---

## 10. Open regulatory risks

| Risk                                              | Status  | Mitigation                                                             |
| ------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| MHRA reform of UK MDR is in flight                | Active  | Pin assessment date; subscribe to MHRA news; re-run on material change |
| CE-marking recognition in GB has moved repeatedly | Active  | Verify against MHRA news at every product release                      |
| MHRA AIaMD Programme publishing incrementally     | Active  | Re-run on each new WP publication that may apply                       |
| Windsor Framework arrangements may change         | Monitor | Check NI placement route at each release                               |

---

## External References

### Authoritative Sources

| Doc ID          | Title                                                | Source             | Used in              |
| --------------- | ---------------------------------------------------- | ------------------ | -------------------- |
| UK-MDR-2002     | Medical Devices Regulations 2002 (as amended)        | legislation.gov.uk | Throughout           |
| EU-MDR-2017-745 | EU MDR 2017/745                                      | EUR-Lex            | §3                   |
| MHRA-SAMD       | MHRA Guidance on Medical Device Stand-Alone Software | MHRA               | §1                   |
| MHRA-AIAMD      | MHRA Software and AI as a Medical Device Programme   | MHRA               | §6                   |
| MHRA-BORDERLINE | MHRA Borderline Manual                               | MHRA               | §1.4 (if borderline) |
| ISO-14971       | Application of risk management to medical devices    | BSI                | §7                   |
| IEC-62304       | Medical-device software lifecycle                    | BSI                | §7                   |
| ISO-13485       | Medical-device QMS                                   | BSI                | §7                   |
| IEC-62366-1     | Usability engineering for medical devices            | BSI                | §7 (if applicable)   |

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

## Important

This classification assessment is **not** regulatory advice. The output MUST be
reviewed and signed off by a qualified Regulatory Affairs Specialist or
notified-body / approved-body advisor before being used to make product,
procurement, or market-access decisions. Misclassification has material legal,
commercial, and patient-safety consequences.

---

**Generated by**: ArcKit `/arckit:uk-mdr-classification` command **Generated
on**: [YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: uk-nhs-dcb0129-case-template.md -->

# Clinical Safety Case Report — [PRODUCT_NAME]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0129` | **Filename**: `SAFETY-CASE.md` (DCB0129
> manufacturer case)

## Document Control

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Document ID**      | `SAFETY-CASE.md` (Marcus Baw SAFETY.md spec convention; no ARC- prefix) |
| **Document Type**    | Clinical Safety Case Report (DCB0129 manufacturer)                      |
| **Project**          | [PROJECT_NAME] (Project [PROJECT_ID])                                   |
| **Classification**   | [OFFICIAL / OFFICIAL-SENSITIVE]                                         |
| **Status**           | DRAFT                                                                   |
| **Version**          | [VERSION]                                                               |
| **Created Date**     | [YYYY-MM-DD]                                                            |
| **Last Modified**    | [YYYY-MM-DD]                                                            |
| **Review Cycle**     | Quarterly (recommended); on every material product change               |
| **Next Review Date** | [YYYY-MM-DD]                                                            |
| **Owner**            | [PRODUCT_OWNER_NAME_AND_ROLE]                                           |
| **Reviewed By**      | [PENDING — CSO]                                                         |
| **Approved By**      | [PENDING — CSO sign-off in §6 below]                                    |
| **Distribution**     | [DISTRIBUTION_LIST]                                                     |

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:uk-nhs-dcb0129` command | PENDING     | PENDING       |

---

## Risk scoring scales (DCB0129 convention)

| Scale          | 1            | 2     | 3            | 4           | 5        |
| -------------- | ------------ | ----- | ------------ | ----------- | -------- |
| **Severity**   | Catastrophic | Major | Considerable | Significant | Minor    |
| **Likelihood** | Very High    | High  | Medium       | Low         | Very Low |

**Risk levels**: `unacceptable` · `high` · `medium` · `low` **Hazard status**:
`open` · `mitigated` · `accepted` · `closed`

> ⚠️ **Numbering note (ArcKit encoding, not DCB0129).** ArcKit numbers the
> DCB0129 labels 1 (worst) to 5 (least) purely to store them. DCB0129 itself
> puts no numbers on the severity/likelihood axes - they are word-labelled. The
> only numbers in the standard are the Risk Class cells (1-5, where 5 =
> unacceptable/highest, the conventional direction), so these ordinals run
> opposite to both the usual risk-register convention and DCB0129's own risk
> classes. Take care when cross-referencing project risk registers.

---

## 1. Intended Use

[State the product's clinical purpose, indications, contraindications, intended
user population (specific clinical roles, patient populations), and intended
clinical context. Be precise — the intended-use statement is load-bearing for
medical-device classification (`/arckit:uk-mdr-classification`) and for
clinical-safety scope.]

### What this product is

[Describe the product in plain English. One paragraph.]

### What this product is not

[Explicit out-of-scope statements. Lists what this product does _not_ do, _not_
claim, and is _not_ intended for. Pre-empts misuse claims.]

### Intended users

[Specific clinical roles — e.g. "registered medical practitioners in NHS
secondary care", "registered children's nurses in NHS paediatric inpatient
settings". Avoid "any clinician".]

### Intended patient population

[Specific patient population — age range, condition, care setting.]

### Intended clinical context

[Specific clinical setting — inpatient / outpatient / community / home; acute /
chronic / preventive; emergency / planned.]

---

## 2. Scope

### In scope for this safety case

[What clinical activities and product features are covered by this safety case.]

### Out of scope for this safety case

[What is explicitly NOT covered. Often includes: deployment-specific
arrangements (covered by DCB0160), third-party integrations not maintained by
the manufacturer, off-label clinical uses.]

### Deployment assumptions

[What the manufacturer assumes about the deployment environment. These
assumptions become the obligations on the deploying organisation's DCB0160
case.]

---

## 3. Safety Argument

Top-level claim:

> **G1: [PRODUCT_NAME] is acceptably safe for use by [intended users] in
> [intended clinical context] when used as intended.**

This claim is supported by the sub-claims below. Each sub-claim references
hazards (H-ID) from the [Hazard Log](./HAZARD-LOG.md) and the controls (C-ID)
that mitigate them.

### G1.1 — Clinical hazards are systematically identified and managed

Evidence:

- Hazard identification workshops with clinical SMEs ([list dates /
  participants])
- Hazard Log [HAZARD-LOG.md](./HAZARD-LOG.md) maintained as a living document
- Cross-referenced with the project risk register and DPIA where overlap exists

### G1.2 — Identified hazards are reduced to acceptable residual risk

Evidence:

- Each hazard in the Hazard Log has documented controls (C-IDs)
- Residual-risk severity × likelihood reassessed after controls
- Residual `unacceptable` and `high` risks have explicit CSO acceptance with
  justification

### G1.3 — Clinical decisions made by users of the product are based on accurate, current, and relevant data

Evidence:

- [Identity-matching controls — reference H-IDs]
- [Data-currency controls — reference H-IDs]
- [Source-of-truth controls — reference H-IDs]

### G1.4 — The product fails safely

Evidence:

- [Graceful-degradation behaviour — reference H-IDs]
- [Fallback to safe states under failure — reference H-IDs]
- [Notification of failure to clinicians — reference H-IDs]

### G1.5 — Misuse is mitigated by design

Evidence:

- [Usability engineering evidence per IEC 62366-1 if applicable]
- [Authorisation / role-based access design]
- [In-context warnings and decision support]

### G1.6 — Clinical workflow integration is safe

Evidence:

- [Workflow analysis with clinical SMEs]
- [Integration test evidence]
- [Training-and-deployment guidance to deploying organisations]

[Add or remove G-sub-claims to reflect the actual product. Each should reference
real H-IDs in the Hazard Log.]

---

## 4. Evidence

### Testing strategy

[Summary of the testing approach: unit / integration / system /
clinical-acceptance. Reference the V&V plan if one exists.]

### Clinical validation

[Clinical evaluation evidence: literature review, retrospective evaluation,
prospective study, clinical investigation. State the level of evidence
available.]

### Usability evidence (IEC 62366-1 alignment, if applicable)

[Formative and summative usability evaluation evidence.]

### Real-world performance monitoring

[Post-deployment monitoring plan — what metrics, what cadence, what triggers a
hazard log update.]

---

## 5. Residual Risk

### Accepted residual risks

| H-ID | Residual Severity | Residual Likelihood | Residual Risk         | Justification for acceptance                                  |
| ---- | ----------------- | ------------------- | --------------------- | ------------------------------------------------------------- |
| H001 | [N]               | [N]                 | [low / medium / high] | [Why this residual risk is acceptable given clinical benefit] |
| ...  |                   |                     |                       |                                                               |

[Each accepted residual risk above `low` requires explicit CSO sign-off with
justification proportionate to the residual severity.]

### Overall residual risk position

[CSO's overall judgment that the product, with controls in place, is acceptably
safe for its intended use. One paragraph.]

### Re-review triggers

This safety case must be re-reviewed by the Clinical Safety Officer when a
change touches any of the following. Record the change and the re-review outcome
in the Revision History.

- Calculation, threshold, score, rounding, unit, or clinical rule
- Patient identity, record matching, demographics, or clinical context
- Data model, terminology, coding, validation, migration, or persistence
- API, integration, interoperability, cache, queue, sync, or source-of-truth
  behaviour
- Alerting, notification, escalation, prioritisation, or acknowledgement
- User workflow, UI copy, warnings, confirmations, or accessibility
- Authentication, authorisation, legitimate relationship, audit logging, or
  break-glass
- Deployment configuration, feature flags, environment, infrastructure,
  failover, or backups
- Monitoring, incident response, support, downtime, or decommissioning
- AI/ML model, prompt, training data, calibration, drift, or human oversight

---

## 6. CSO Sign-off

| Field            | Value                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CSO Name**     | [PENDING]                                                                                                                                                                                                                                                                                                       |
| **Registration** | [GMC / NMC / HCPC / GPhC number — PENDING]                                                                                                                                                                                                                                                                      |
| **Date**         | [PENDING]                                                                                                                                                                                                                                                                                                       |
| **Statement**    | I have reviewed this Clinical Safety Case Report and the associated Hazard Log. I am satisfied that the clinical hazards have been systematically identified and that residual risks are at an acceptable level given the intended clinical benefit of the product. I approve this safety case. **— [PENDING]** |
| **Signature**    | [PENDING]                                                                                                                                                                                                                                                                                                       |

---

## External References

| Doc ID         | Title                                                                             | Source                   | Used in                                                                  |
| -------------- | --------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| DCB0129        | Clinical Risk Management: its Application in the Manufacture of Health IT Systems | NHS England              | This document, throughout                                                |
| SAFETY-MD-SPEC | SAFETY.md spec v2.0.0-draft                                                       | Marcus Baw / pacharanero | Document structure, hazard-log YAML format                               |
| ISO-14971      | Application of risk management to medical devices                                 | BSI                      | §1, §3, §5 (cross-referenced with `uk-mdr-classification` if applicable) |
| IEC-62304      | Medical-device software lifecycle processes                                       | BSI                      | §1, §4 (cross-referenced with `uk-mdr-classification` if applicable)     |
| IEC-62366-1    | Application of usability engineering to medical devices                           | BSI                      | §3 G1.5, §4                                                              |

---

**Generated by**: ArcKit `/arckit:uk-nhs-dcb0129` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL] **Spec lineage**:
[Marcus Baw SAFETY.md v2.0.0-draft](https://github.com/pacharanero/SAFETY.md)

<!-- arckit-overlay-template: uk-nhs-dcb0129-hazard-template.md -->

---
hazards:
  - id: H001
    description: "Incorrect patient identity loaded into the product context (wrong-patient hazard)"
    cause: "Identity lookup mismatches similar names / DOBs; failure to confirm NHS Number; clinician selects wrong record from a search result"
    effect: "Clinical decisions or data entries applied to the wrong patient"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - C001
      - C002
    residual-severity: 2
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: H002
    description: "Stale clinical data displayed (cache or sync failure)"
    cause: "Local cache served when upstream system has more recent data; eventual-consistency lag exceeds clinical-relevance window"
    effect: "Clinician acts on out-of-date information, e.g. ordering a duplicate test or missing a critical result"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - C003
      - C004
    residual-severity: 2
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: H003
    description: "Missing or incomplete audit trail of clinical decision"
    cause: "Logging not enabled on a code path; log destination unavailable at time of write; PII redaction strips clinical context"
    effect: "Inability to reconstruct what data the clinician saw at the time of decision; harms patient safety investigation and clinician indemnity"
    severity: 3
    likelihood: 3
    risk: medium
    controls:
      - C005
    residual-severity: 3
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: H004
    description: "Authorisation bypass — clinician sees patient data outside their legitimate clinical relationship"
    cause: "RBAC misconfiguration; role/permission mapping defect; legitimate-relationship check missing on a code path"
    effect: "Confidentiality breach; potential GMC/NMC referral against the clinician; UK GDPR Article 5(1)(f) breach"
    severity: 3
    likelihood: 3
    risk: medium
    controls:
      - C006
      - C007
    residual-severity: 3
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: H005
    description: "Notification or alert failure (urgent clinical communication not delivered)"
    cause: "Push notification provider outage; user opted out of notifications and not warned of clinical relevance; alert ranking buries critical alert in a queue"
    effect: "Time-critical clinical action delayed or missed"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - C008
      - C009
    residual-severity: 2
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: H006
    description: "Data integrity loss on write (clinical record corruption)"
    cause: "Concurrent-write race condition; partial write under failure; ORM defect serialising clinical data; encoding mismatch"
    effect: "Clinical record becomes inaccurate, incomplete, or unreadable; downstream clinical decisions based on corrupted data"
    severity: 2
    likelihood: 4
    risk: medium
    controls:
      - C010
      - C011
    residual-severity: 2
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:

controls:
  - id: C001
    description: "NHS Number is the canonical identifier on every clinical record; PDS lookup with demographic trace required for new-record creation; UI shows NHS Number + DOB + name + first line of address before any clinical action."
  - id: C002
    description: "Two-factor patient identification on search result selection — clinician must confirm NHS Number or scan a wristband/barcode before the patient context loads."
  - id: C003
    description: "Cache TTLs configured per data class with clinical-relevance windows (e.g. observations: 30s, allergies: 5min, demographics: 1hr). Cache age visible to clinician for any non-real-time data shown."
  - id: C004
    description: "Synchronous read-through cache for safety-critical data classes (current medications, active allergies, current observations); cache miss falls back to source-of-truth read, not silent stale return."
  - id: C005
    description: "Append-only audit log written before the clinical action is presented in the UI; log includes user, patient context, data class, action taken, and timestamp. Independent storage from the primary database with retention ≥ 8 years per NHS records management code of practice."
  - id: C006
    description: "Role-based access control enforced at the API layer (not only the UI); RBAC unit tests cover all roles × all resource types; periodic access review."
  - id: C007
    description: "Legitimate-relationship check (or sealed-envelope-style equivalent) on every patient-context load; non-relationship access permitted only via explicit break-glass with audit and notification."
  - id: C008
    description: "Critical clinical alerts use in-app delivery with synchronous acknowledgement, not only push notifications; non-acknowledged critical alerts escalate to a different recipient within a defined SLA."
  - id: C009
    description: "Alert ranking and presentation tested with clinical SMEs to avoid alert fatigue; critical alerts visually distinct and not collapsible."
  - id: C010
    description: "All clinical writes are transactional with optimistic concurrency control on a row-version field; conflicting writes return an explicit clinical-context error to the clinician (not a silent overwrite)."
  - id: C011
    description: "Daily integrity check across clinical record store with automated alerting on hash mismatch; backups verified by restore test on a recurring schedule."
---

# Hazard Log — [PRODUCT_NAME]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0129` | **Filename**: `HAZARD-LOG.md` (DCB0129
> manufacturer)

## Document Control

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Document ID**      | `HAZARD-LOG.md` (Marcus Baw SAFETY.md spec convention; no ARC- prefix) |
| **Document Type**    | Hazard Log (DCB0129 manufacturer)                                      |
| **Project**          | [PROJECT_NAME] (Project [PROJECT_ID])                                  |
| **Classification**   | [OFFICIAL / OFFICIAL-SENSITIVE]                                        |
| **Status**           | DRAFT                                                                  |
| **Version**          | [VERSION]                                                              |
| **Created Date**     | [YYYY-MM-DD]                                                           |
| **Last Modified**    | [YYYY-MM-DD]                                                           |
| **Review Cycle**     | Monthly (hazard logs are _living_ documents)                           |
| **Next Review Date** | [YYYY-MM-DD]                                                           |
| **Owner**            | [PRODUCT_OWNER_NAME_AND_ROLE]                                          |
| **Reviewed By**      | [PENDING — CSO]                                                        |
| **Approved By**      | [PENDING — CSO]                                                        |
| **Distribution**     | [DISTRIBUTION_LIST]                                                    |

## Risk scoring scales (DCB0129 convention)

- **Severity**: `1` Catastrophic | `2` Major | `3` Considerable | `4`
  Significant | `5` Minor
- **Likelihood**: `1` Very High | `2` High | `3` Medium | `4` Low | `5` Very Low
- **Risk level**: `unacceptable` | `high` | `medium` | `low`
- **Status**: `open` | `mitigated` | `accepted` | `closed`

> ⚠️ **Numbering note (ArcKit encoding, not DCB0129).** ArcKit numbers the
> DCB0129 labels 1 (worst) to 5 (least) purely to store them. DCB0129 itself
> puts no numbers on the severity/likelihood axes - they are word-labelled. The
> only numbers in the standard are the Risk Class cells (1-5, where 5 =
> unacceptable/highest, the conventional direction), so the ordinals above run
> opposite to both the usual risk-register convention and DCB0129's own risk
> classes. Take care when cross-referencing the project risk register.

---

## Hazards

_Rendered from the structured YAML at the top of this file. Keep in sync — edit
YAML first, then re-render this table (the `/arckit:uk-nhs-dcb0129` command
regenerates both together)._

| ID   | Description                                                           | Sev | Like | Risk   | Controls   | Residual Risk | Status |
| ---- | --------------------------------------------------------------------- | --- | ---- | ------ | ---------- | ------------- | ------ |
| H001 | Incorrect patient identity loaded (wrong-patient hazard)              | 2   | 3    | HIGH   | C001, C002 | LOW           | Open   |
| H002 | Stale clinical data displayed (cache / sync failure)                  | 2   | 3    | HIGH   | C003, C004 | MEDIUM        | Open   |
| H003 | Missing or incomplete audit trail of clinical decision                | 3   | 3    | MEDIUM | C005       | LOW           | Open   |
| H004 | Authorisation bypass — clinician sees data outside their relationship | 3   | 3    | MEDIUM | C006, C007 | LOW           | Open   |
| H005 | Notification / alert failure (urgent communication not delivered)     | 2   | 3    | HIGH   | C008, C009 | MEDIUM        | Open   |
| H006 | Data integrity loss on write (clinical record corruption)             | 2   | 4    | MEDIUM | C010, C011 | LOW           | Open   |

## Controls

| ID   | Description                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------- |
| C001 | NHS Number canonical; PDS lookup on new records; UI shows NHS Number + DOB + name + address before action |
| C002 | Two-factor patient ID on search-result selection (NHS Number confirm or barcode scan)                     |
| C003 | Per-data-class cache TTLs (observations 30s, allergies 5min, demographics 1hr); cache age visible         |
| C004 | Synchronous read-through cache for safety-critical data; cache miss falls back to source-of-truth         |
| C005 | Append-only audit log written before clinical action presented; independent storage; ≥ 8yr retention      |
| C006 | RBAC enforced at API layer (not only UI); RBAC unit tests cover all roles × resources                     |
| C007 | Legitimate-relationship check on every patient-context load; break-glass explicit and audited             |
| C008 | Critical alerts use in-app sync acknowledgement; non-ack escalates to different recipient on SLA          |
| C009 | Alert ranking and presentation usability-tested; critical alerts visually distinct and non-collapsible    |
| C010 | Clinical writes transactional with optimistic concurrency control; conflicts return explicit error        |
| C011 | Daily integrity check with hash mismatch alerting; backups verified by recurring restore test             |

---

## How to extend this hazard log

- Add new hazards to the `hazards:` array in the YAML frontmatter
- Add new controls to the `controls:` array
- Re-render the Markdown tables (or re-run `/arckit:uk-nhs-dcb0129` which
  regenerates both)
- Have the CSO review each new hazard before flipping `cso-reviewed: true`
- Move hazards through statuses (`open` → `mitigated` → `closed`) as controls
  are evidenced
- For accepted residual risks above `low`, capture the acceptance rationale in
  `SAFETY-CASE.md` §5

---

## Important

The six hazards above are a **starter set** drawn from common patterns in NHS
digital health products. They are not a substitute for project-specific hazard
identification by the CSO and clinical SMEs. Many real products have 30–80
hazards in their log after a proper identification workshop. **A short hazard
log is more often a sign of insufficient analysis than of a safe product.**

---

**Generated by**: ArcKit `/arckit:uk-nhs-dcb0129` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL] **Spec lineage**:
[Marcus Baw SAFETY.md v2.0.0-draft](https://github.com/pacharanero/SAFETY.md)

<!-- arckit-overlay-template: uk-nhs-dcb0129-safety-template.md -->

# Clinical Safety — [PRODUCT_NAME]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0129` | **Filename**: `SAFETY.md` (DCB0129 manufacturer
> anchor)

## Document Control

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Document ID**      | `SAFETY.md` (Marcus Baw SAFETY.md spec convention; no ARC- prefix) |
| **Document Type**    | Clinical Safety Anchor (DCB0129 manufacturer)                      |
| **Project**          | [PROJECT_NAME] (Project [PROJECT_ID])                              |
| **Classification**   | [PUBLIC / OFFICIAL / OFFICIAL-SENSITIVE]                           |
| **Status**           | DRAFT                                                              |
| **Version**          | [VERSION]                                                          |
| **Created Date**     | [YYYY-MM-DD]                                                       |
| **Last Modified**    | [YYYY-MM-DD]                                                       |
| **Review Cycle**     | Quarterly (recommended for active products)                        |
| **Next Review Date** | [YYYY-MM-DD]                                                       |
| **Owner**            | [OWNER_NAME_AND_ROLE]                                              |
| **Reviewed By**      | [PENDING]                                                          |
| **Approved By**      | [PENDING]                                                          |
| **Distribution**     | [DISTRIBUTION_LIST]                                                |

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:uk-nhs-dcb0129` command | PENDING     | PENDING       |

---

## Required SAFETY.md fields (Marcus Baw SAFETY.md spec v2.0.0)

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| `product-name`            | [PRODUCT_NAME]                                                 |
| `version`                 | [PRODUCT_VERSION]                                              |
| `standard`                | DCB0129                                                        |
| `clinical-safety-officer` | [PENDING — CSO name and GMC/NMC/HCPC/GPhC registration number] |
| `organisation`            | [MANUFACTURER_LEGAL_ENTITY]                                    |
| `safety-case-status`      | draft                                                          |
| `hazard-log-url`          | [./HAZARD-LOG.md](./HAZARD-LOG.md)                             |
| `last-reviewed`           | [YYYY-MM-DD]                                                   |

---

## Summary

[One to two paragraphs: what the product does, intended clinical context, scope
of the safety claim, summary of safety approach. Plain English — this is the
front door to the safety case for anyone reviewing the product (procurement,
CSO, MHRA, NHS England, patients).]

---

## Documents

- [Clinical Safety Case Report](./SAFETY-CASE.md) — the substantive safety
  argument
- [Hazard Log](./HAZARD-LOG.md) — the YAML-frontmatter hazard register with
  rendered table
- [Clinical Risk Management Plan](./SAFETY-PLAN.md) — _(optional, Tier 3 / SaMD
  products only — generate manually if needed)_

---

## Applicable standards and assurance domains

Clinical safety evidence sits alongside wider information-standard evidence.
Under the Data (Use and Access) Act 2025 (amending the Health and Social Care
Act 2012 Part 9 information-standards framework), standards can reach IT,
software, interoperability, portability, information access, and security. This
register records which domains apply, where the evidence lives, and who owns it.
The Clinical Safety Officer owns the clinical-safety row and cross-references
the others where a failure in that domain could cause patient harm; the CSO does
not own every domain below.

| Domain                                    | Standard / framework                       | Applies?     | Evidence location      | Owner             |
| ----------------------------------------- | ------------------------------------------ | ------------ | ---------------------- | ----------------- |
| Clinical risk management (manufacture)    | DCB0129                                    | [YES]        | `SAFETY-CASE.md`       | Manufacturer CSO  |
| Clinical risk management (deployment/use) | DCB0160                                    | [YES/NO/TBD] | Deployment safety case | Deployer CSO      |
| Health/care information standards         | HSC Act 2012 Part 9 as amended (DUAA 2025) | [TBD]        | Evidence pack          | Responsible owner |
| Interoperability / connectivity           | [e.g. FHIR UK Core, NHS Number, SNOMED CT] | [TBD]        | [TBD]                  | Technical owner   |
| Data protection / secondary use           | UK GDPR / DPA 2018 / DUAA 2025 context     | [TBD]        | DPIA / IG evidence     | IG lead           |
| Information security                      | [e.g. DSPT, NCSC CAF, Cyber Essentials]    | [TBD]        | [TBD]                  | Security owner    |
| Portability / storage / access            | [TBD]                                      | [TBD]        | [TBD]                  | [TBD]             |

---

## Roles and responsibilities

The Data (Use and Access) Act 2025 "relevant IT provider" concept can bring
suppliers, operators, and maintainers into the information-standards compliance
picture, not only the deploying organisation. Record who holds each role so that
clinical-risk ownership across the lifecycle is unambiguous.

| Role                             | Applies? | Organisation / person | Evidence               |
| -------------------------------- | -------- | --------------------- | ---------------------- |
| Manufacturer / supplier          | [YES/NO] | [ORGANISATION]        | `SAFETY-CASE.md`       |
| Deployer / health organisation   | [YES/NO] | [ORGANISATION]        | Deployment safety case |
| Operator                         | [YES/NO] | [ORGANISATION]        | [TBD]                  |
| Maintainer                       | [YES/NO] | [ORGANISATION]        | [TBD]                  |
| Relevant IT provider (DUAA 2025) | [YES/NO] | [ORGANISATION]        | Evidence pack          |

---

## Tier

This product is assessed as Marcus Baw SAFETY.md **Tier 2** by default (3-file
set). Adjust to Tier 1 (consolidate into this single file) for low-risk
reference or information-only tools where the CSO judges a separate case +
hazard log to be disproportionate. Adjust to Tier 3 (add `SAFETY-PLAN.md`) for
SaMD products and any product where the manufacturer needs to evidence a
separate Clinical Risk Management Plan to MHRA or a Notified Body.

---

## Important

This document is **not** clinical, legal, or regulatory advice. It is a
generated starting point that MUST be reviewed, materially supplemented, and
signed off by a qualified Clinical Safety Officer (CSO) holding current GMC /
NMC / HCPC / GPhC registration before the product is placed into clinical use.

---

**Generated by**: ArcKit `/arckit:uk-nhs-dcb0129` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL] **Spec lineage**:
[Marcus Baw SAFETY.md v2.0.0-draft](https://github.com/pacharanero/SAFETY.md)

<!-- arckit-overlay-template: uk-nhs-dcb0129-template.md -->

# NHS DCB0129 Clinical Safety Case — Wrapper Template

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0129`

This wrapper exists only for `/arckit:customize list` and the documentation
site. The actual generated outputs are three files:

1. [`uk-nhs-dcb0129-safety-template.md`](./uk-nhs-dcb0129-safety-template.md) —
   renders to `clinical-safety/SAFETY.md`
2. [`uk-nhs-dcb0129-case-template.md`](./uk-nhs-dcb0129-case-template.md) —
   renders to `clinical-safety/SAFETY-CASE.md`
3. [`uk-nhs-dcb0129-hazard-template.md`](./uk-nhs-dcb0129-hazard-template.md) —
   renders to `clinical-safety/HAZARD-LOG.md`

The three files together implement the NHS DCB0129 manufacturer-side
documentation expected by NHS England under section 250 of the Health and Social
Care Act 2012 (Part 9 information-standards framework, as amended by the Data
(Use and Access) Act 2025). They follow Dr Marcus Baw's
[SAFETY.md spec v2.0.0-draft](https://github.com/pacharanero/SAFETY.md) for
filenames and YAML-frontmatter structure, prefixed with an ArcKit Document
Control block.

To customise: run `/arckit:customize uk-nhs-dcb0129-safety` (or `-case`, or
`-hazard`) to copy individual sub-templates into `.arckit/templates-custom/` for
editing.

<!-- arckit-overlay-template: uk-nhs-dcb0160-deployment-case-template.md -->

# Deployment Clinical Safety Case Report — [PRODUCT_NAME] at [DEPLOYING_ORGANISATION]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0160` | **Filename**: `DEPLOYMENT-SAFETY-CASE.md` (DCB0160
> deployer)

## Document Control

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Document ID**      | `DEPLOYMENT-SAFETY-CASE.md` (Marcus Baw SAFETY.md spec convention)     |
| **Document Type**    | Deployment Clinical Safety Case Report (DCB0160 deployer)              |
| **Project**          | [PROJECT_NAME] (Project [PROJECT_ID])                                  |
| **Classification**   | [OFFICIAL / OFFICIAL-SENSITIVE]                                        |
| **Status**           | DRAFT                                                                  |
| **Version**          | [VERSION]                                                              |
| **Created Date**     | [YYYY-MM-DD]                                                           |
| **Last Modified**    | [YYYY-MM-DD]                                                           |
| **Review Cycle**     | Quarterly (or on any material deployment / workflow / training change) |
| **Next Review Date** | [YYYY-MM-DD]                                                           |
| **Owner**            | [DEPLOYING_ORGANISATION_PROJECT_OWNER]                                 |
| **Reviewed By**      | [PENDING — deploying-organisation CSO]                                 |
| **Approved By**      | [PENDING — deploying-organisation CSO sign-off in §7 below]            |
| **Distribution**     | [DISTRIBUTION_LIST]                                                    |

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:uk-nhs-dcb0160` command | PENDING     | PENDING       |

---

## 1. Deployment Context

| Field                             | Value                                                             |
| --------------------------------- | ----------------------------------------------------------------- |
| **Deploying Organisation**        | [NHS Trust / ICS / GP federation / mental health trust / etc.]    |
| **Clinical Service Affected**     | [e.g. Paediatric Outpatients, Emergency Department, Primary Care] |
| **Sites**                         | [List of sites or sites-pattern; "all sites within X Trust"]      |
| **Patient Population**            | [Demographic / clinical population affected]                      |
| **Estimated Patient Volume**      | [Patients per month / year affected]                              |
| **Project Sponsor**               | [Executive sponsor at deploying organisation]                     |
| **Local Implementation Lead**     | [Name / role]                                                     |
| **CSO at Deploying Organisation** | [PENDING — name + GMC/NMC/HCPC/GPhC registration]                 |
| **Caldicott Guardian Sign-off**   | [PENDING]                                                         |
| **SIRO Sign-off**                 | [PENDING]                                                         |

---

## 2. Scope

### In scope

[Which sites / services / user populations / use cases the deployment covers.]

### Out of scope

[Explicit out-of-scope statements — sites not in this rollout, use cases not in
this rollout, legacy systems not being replaced.]

### Phasing

| Phase        | Sites  | Users   | Patient cohort | Go-live | Go / No-Go criteria |
| ------------ | ------ | ------- | -------------- | ------- | ------------------- |
| Pilot        | [site] | [users] | [cohort]       | [date]  | [criteria]          |
| Wave 1       |        |         |                |         |                     |
| Wave 2       |        |         |                |         |                     |
| Full rollout |        |         |                |         |                     |

---

## 3. Manufacturer Case Acceptance

The deploying organisation has reviewed the manufacturer's DCB0129 case at
[manufacturer SAFETY-CASE.md link] dated [YYYY-MM-DD] and:

- ☐ Accepts the manufacturer's intended-use statement as applicable to this
  deployment
- ☐ Accepts the manufacturer's residual-risk position as documented in §5 of the
  manufacturer case
- ☐ Has identified the additional deployment-specific risks in §4 below

If any of the above are NOT acceptable, the deployment is **not safe to
proceed** until resolved. Document any disagreements with the manufacturer here,
including the resolution path (additional local controls / configuration change
/ request product change from manufacturer / abandon deployment).

---

## 4. Deployment Safety Argument

Top-level claim:

> **G1: The deployment of [PRODUCT_NAME] at [DEPLOYING_ORGANISATION] is
> acceptably safe for the affected patient population and clinical workflows,
> given the manufacturer's case and the local controls documented below.**

Sub-claims:

### G1.1 — Clinicians using the system are adequately trained

Evidence:

- Training plan: [link or describe]
- Super-user identification and training: [link]
- Competence assessment before clinical use: [pass criteria]
- Cross-references: D-HAZ-001 (inadequate training)

### G1.2 — The product integrates safely with existing local clinical workflows

Evidence:

- Workflow mapping with clinical SMEs at the deploying organisation: [link]
- Integration with parallel systems (EPR, results, prescribing): [list]
- Handover-of-care points covered: [list]
- Cross-references: D-HAZ-002 (workflow gap), D-HAZ-003 (integration failure)

### G1.3 — The deployment has adequate business continuity if the product is unavailable

Evidence:

- Manual fallback workflow documented and tested: [link]
- BC drill evidence: [date / outcome]
- Cross-references: D-HAZ-004 (BC failure)

### G1.4 — Transition risks from legacy systems are mitigated

Evidence:

- Parallel-running plan: [link]
- Data migration plan and validation: [link]
- Legacy decommission plan: [link]
- Cross-references: D-HAZ-005 (parallel-running confusion), D-HAZ-006 (data
  migration error)

### G1.5 — Local configuration is correct and verified

Evidence:

- Configuration document: [link]
- Configuration verification process: [who verifies, against what reference]
- Cross-references: D-HAZ-007 (configuration error), D-HAZ-008
  (terminology/coding mismatch), D-HAZ-009 (RBAC misalignment)

### G1.6 — Local incident reporting and post-deployment monitoring is in place

Evidence:

- Local incident reporting route into Datix / equivalent
- Cadence of post-deployment monitoring
- Trigger criteria for hazard log update / safety case revision
- Cross-references: D-HAZ-010 (failure to learn from incidents)

[Add or remove G-sub-claims to reflect the actual deployment. Each should
reference real D-HAZ-IDs in the Deployment Hazard Log.]

---

## 5. Local Evidence

### Local clinical user testing

[Sessions held, clinical roles tested, outcomes summary.]

### Super-user training records

[Number of super-users trained, attendance, competence assessment outcomes.]

### Integration test evidence

[Local integration test plan and outcomes — interface engine, identity, results,
prescribing.]

### Parallel-running evidence

[If parallel running with a legacy system, summary of issues found and
resolved.]

---

## 6. Residual Deployment Risk

| D-HAZ-ID  | Residual Severity | Residual Likelihood | Residual Risk         | Justification for acceptance                                                       |
| --------- | ----------------- | ------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| D-HAZ-001 | [N]               | [N]                 | [low / medium / high] | [Why this residual risk is acceptable given clinical benefit at this organisation] |
| ...       |                   |                     |                       |                                                                                    |

### Overall deployment residual risk position

[Deploying organisation CSO's overall judgment that the deployment, with
controls in place, is acceptably safe.]

### Re-review triggers

This safety case must be re-reviewed by the Clinical Safety Officer when a
change touches any of the following. Record the change and the re-review outcome
in the Revision History.

- Calculation, threshold, score, rounding, unit, or clinical rule
- Patient identity, record matching, demographics, or clinical context
- Data model, terminology, coding, validation, migration, or persistence
- API, integration, interoperability, cache, queue, sync, or source-of-truth
  behaviour
- Alerting, notification, escalation, prioritisation, or acknowledgement
- User workflow, UI copy, warnings, confirmations, or accessibility
- Authentication, authorisation, legitimate relationship, audit logging, or
  break-glass
- Deployment configuration, feature flags, environment, infrastructure,
  failover, or backups
- Monitoring, incident response, support, downtime, or decommissioning
- AI/ML model, prompt, training data, calibration, drift, or human oversight

---

## 7. Deploying-Organisation CSO Sign-off

| Field                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploying Organisation** | [DEPLOYING_NHS_ORGANISATION]                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **CSO Name**               | [PENDING]                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Registration**           | [GMC / NMC / HCPC / GPhC number — PENDING]                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Date**                   | [PENDING]                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Statement**              | I am the Clinical Safety Officer at [DEPLOYING_NHS_ORGANISATION]. I have reviewed this Deployment Clinical Safety Case Report and the associated Deployment Hazard Log, and the manufacturer's DCB0129 case it references. I am satisfied that the deployment of [PRODUCT_NAME] in our clinical context, with the local controls documented in this case, is acceptably safe for our patients and clinicians. I approve this deployment safety case. **— [PENDING]** |
| **Signature**              | [PENDING]                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## External References

| Doc ID         | Title                                                                                    | Source                   | Used in                   |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------ | ------------------------- |
| DCB0160        | Clinical Risk Management: its Application in the Deployment and Use of Health IT Systems | NHS England              | This document, throughout |
| DCB0129        | Manufacturer Clinical Risk Management for Health IT (cross-referenced manufacturer case) | NHS England              | §3, throughout            |
| SAFETY-MD-SPEC | SAFETY.md spec v2.0.0-draft                                                              | Marcus Baw / pacharanero | Document structure        |

---

**Generated by**: ArcKit `/arckit:uk-nhs-dcb0160` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL] **Spec lineage**:
[Marcus Baw SAFETY.md v2.0.0-draft](https://github.com/pacharanero/SAFETY.md)

<!-- arckit-overlay-template: uk-nhs-dcb0160-deployment-hazard-template.md -->

---
hazards:
  - id: D-HAZ-001
    description: "Inadequate clinician training leading to misuse of the product"
    cause: "Training scheduled too far ahead of go-live; clinicians joining post go-live miss formal training; high churn in agency / locum cover; super-user model not embedded"
    effect: "Clinicians use the product incorrectly, with patient safety, data quality, and workflow consequences"
    severity: 3
    likelihood: 2
    risk: high
    controls:
      - DC001
      - DC002
    residual-severity: 3
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-002
    description: "Workflow integration gap — clinical task falls between this product and another system"
    cause: "Workflow mapping missed an edge case; handover-of-care point unclear; ambiguous ownership of a clinical action"
    effect: "Clinical action delayed or not performed; risk of duplicate action by multiple clinicians each assuming the other will act"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC003
      - DC004
    residual-severity: 2
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-003
    description: "Integration failure with another local system (interface engine outage, HL7 / FHIR message loss)"
    cause: "Interface engine outage; message validation rejection; partner system maintenance window; certificate expiry"
    effect: "Clinical data not propagated where expected (orders not actioned, results not visible, alerts not triggered)"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC005
      - DC006
    residual-severity: 2
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-004
    description: "Business-continuity failure when the product is unavailable (planned or unplanned)"
    cause: "Cloud provider outage; deployment downtime; failed change; cyber incident; network outage"
    effect: "Clinicians cannot perform clinical workflow; if no manual fallback, patient care delayed or compromised"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC007
      - DC008
    residual-severity: 2
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-005
    description: "Confusion during parallel running with a legacy system"
    cause: "Two systems show different clinical data; clinicians unclear which is authoritative; data entered into legacy not reflected in new system or vice versa"
    effect: "Clinical decisions made against an incomplete or out-of-date view"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC009
    residual-severity: 2
    residual-likelihood: 4
    residual-risk: medium
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-006
    description: "Data migration error — legacy records not faithfully transferred to the new product"
    cause: "Source-target field mapping incomplete; truncation; encoding mismatch; coded data not back-mapped where target uses different vocabulary"
    effect: "Historical clinical data lost or distorted; clinicians act without full clinical history"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC010
    residual-severity: 2
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-007
    description: "Local configuration error (e.g. wrong drug formulary, wrong age-band thresholds, wrong reference ranges)"
    cause: "Configuration imported from a different organisation without local verification; reference data updated upstream not propagated; defect in the configuration UI"
    effect: "Clinical decision support gives wrong recommendation; alerts mis-fire or miss-fire"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC011
      - DC012
    residual-severity: 2
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-008
    description: "Local terminology / coding mismatch (e.g. local SNOMED subset diverges from product expectations)"
    cause: "Local SNOMED subset not aligned with product's expected subset; legacy local codes used; dm+d updates not synced"
    effect: "Clinical concepts mis-interpreted by the product (e.g. allergy not recognised); decision support fails silently"
    severity: 2
    likelihood: 3
    risk: high
    controls:
      - DC013
    residual-severity: 2
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-009
    description: "Authorisation / role-mapping error (local RBAC misaligned with intended product RBAC)"
    cause: "Local roles do not map cleanly to product roles; local administrator over-provisions for convenience; role review not embedded"
    effect: "Confidentiality breach or, conversely, clinical action blocked when it should be allowed"
    severity: 3
    likelihood: 3
    risk: medium
    controls:
      - DC014
    residual-severity: 3
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:
  - id: D-HAZ-010
    description: "Failure to capture and act on local incidents involving the product"
    cause: "No clear local reporting route into Datix or equivalent; clinical staff unaware that product incidents should be reported; no escalation path to the manufacturer"
    effect: "Recurring safety issues not surfaced, not addressed, and not fed back to the manufacturer; latent failure to learn"
    severity: 3
    likelihood: 3
    risk: medium
    controls:
      - DC015
      - DC016
    residual-severity: 3
    residual-likelihood: 5
    residual-risk: low
    status: open
    cso-reviewed: false
    date-raised: "[YYYY-MM-DD]"
    date-closed:

controls:
  - id: DC001
    description: "Training plan published before go-live; mandatory completion gate before clinician account activation; competence assessment built into onboarding."
  - id: DC002
    description: "Super-user model embedded per ward/team; super-users have additional time-allocation for floor support; refresh training on each major release."
  - id: DC003
    description: "Workflow mapping signed off by clinical leads in each affected service before deployment; explicit handover-of-care responsibility statements per workflow step."
  - id: DC004
    description: "Daily safety huddle during pilot and first 30 days of full rollout to surface and resolve workflow gaps quickly."
  - id: DC005
    description: "Interface monitoring with alerting on message-rate drop / error spike; on-call procedure for interface engine failure; documented fallback for clinical-priority interfaces."
  - id: DC006
    description: "Message replay capability for transient failures; reconciliation reports for batch-processed clinical data."
  - id: DC007
    description: "Manual fallback workflow documented per clinical service; printed quick-reference cards held at clinical bases; tested at deployment and refreshed annually."
  - id: DC008
    description: "Business continuity drill before go-live and at agreed cadence thereafter; outcomes reviewed by CSO."
  - id: DC009
    description: "Single source of truth declared per data class during parallel running, with prominent UI signalling in both systems; minimal parallel-running window; explicit cut-over date communicated."
  - id: DC010
    description: "Data migration validation: sample-based clinical review of migrated records; reconciliation of record counts and key fields; rollback plan defined if validation fails."
  - id: DC011
    description: "Local configuration sign-off by clinical lead AND CSO; configuration changes peer-reviewed; release-notes review at each product version uplift."
  - id: DC012
    description: "Reference data (formularies, age bands, reference ranges) sourced from authoritative upstream where possible (dm+d, NHS BSA, etc.) with automated freshness monitoring."
  - id: DC013
    description: "Local SNOMED / coding subset verified against product's expected subset before go-live; gap analysis documented; on-going monitoring of SNOMED release impact."
  - id: DC014
    description: "Local role-to-product-role mapping reviewed by deploying-organisation IG lead and CSO; quarterly RBAC review embedded; break-glass usage audited."
  - id: DC015
    description: "Local incident reporting route documented and communicated; product-specific Datix category created; routine review of Datix entries tagged to this product."
  - id: DC016
    description: "Escalation path to the manufacturer documented (vendor contact, response SLA, vigilance reporting trigger if the product is a medical device)."
---

# Deployment Hazard Log — [PRODUCT_NAME] at [DEPLOYING_ORGANISATION]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0160` | **Filename**: `DEPLOYMENT-HAZARD-LOG.md` (DCB0160
> deployer)

## Document Control

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| **Document ID**      | `DEPLOYMENT-HAZARD-LOG.md` (Marcus Baw SAFETY.md spec convention) |
| **Document Type**    | Deployment Hazard Log (DCB0160 deployer)                          |
| **Project**          | [PROJECT_NAME] (Project [PROJECT_ID])                             |
| **Classification**   | [OFFICIAL / OFFICIAL-SENSITIVE]                                   |
| **Status**           | DRAFT                                                             |
| **Version**          | [VERSION]                                                         |
| **Created Date**     | [YYYY-MM-DD]                                                      |
| **Last Modified**    | [YYYY-MM-DD]                                                      |
| **Review Cycle**     | Monthly during pilot and first 90 days; quarterly thereafter      |
| **Next Review Date** | [YYYY-MM-DD]                                                      |
| **Owner**            | [DEPLOYING_ORGANISATION_PROJECT_OWNER]                            |
| **Reviewed By**      | [PENDING — deploying-organisation CSO]                            |
| **Approved By**      | [PENDING — deploying-organisation CSO]                            |
| **Distribution**     | [DISTRIBUTION_LIST]                                               |

## Risk scoring scales (DCB0129 / DCB0160 convention)

- **Severity**: `1` Catastrophic | `2` Major | `3` Considerable | `4`
  Significant | `5` Minor
- **Likelihood**: `1` Very High | `2` High | `3` Medium | `4` Low | `5` Very Low
- **Risk level**: `unacceptable` | `high` | `medium` | `low`
- **Status**: `open` | `mitigated` | `accepted` | `closed`

> ⚠️ **Numbering note (ArcKit encoding, not DCB0129/0160).** ArcKit numbers the
> DCB0129/0160 labels 1 (worst) to 5 (least) purely to store them. The standard
> itself puts no numbers on the severity/likelihood axes - they are
> word-labelled. The only numbers in DCB0129/0160 are the Risk Class cells (1-5,
> where 5 = unacceptable/highest, the conventional direction), so the ordinals
> above run opposite to both the usual risk-register convention and the
> standard's own risk classes. Take care when cross-referencing the project risk
> register.

---

## Deployment Hazards

_Rendered from the structured YAML at the top of this file. Keep in sync._

| ID        | Description                                   | Sev | Like | Risk   | Controls     | Residual Risk | Status |
| --------- | --------------------------------------------- | --- | ---- | ------ | ------------ | ------------- | ------ |
| D-HAZ-001 | Inadequate clinician training                 | 3   | 2    | HIGH   | DC001, DC002 | MEDIUM        | Open   |
| D-HAZ-002 | Workflow integration gap                      | 2   | 3    | HIGH   | DC003, DC004 | MEDIUM        | Open   |
| D-HAZ-003 | Integration failure with another local system | 2   | 3    | HIGH   | DC005, DC006 | MEDIUM        | Open   |
| D-HAZ-004 | Business-continuity failure                   | 2   | 3    | HIGH   | DC007, DC008 | MEDIUM        | Open   |
| D-HAZ-005 | Parallel-running confusion                    | 2   | 3    | HIGH   | DC009        | MEDIUM        | Open   |
| D-HAZ-006 | Data migration error                          | 2   | 3    | HIGH   | DC010        | LOW           | Open   |
| D-HAZ-007 | Local configuration error                     | 2   | 3    | HIGH   | DC011, DC012 | LOW           | Open   |
| D-HAZ-008 | Local terminology / coding mismatch           | 2   | 3    | HIGH   | DC013        | LOW           | Open   |
| D-HAZ-009 | RBAC misalignment                             | 3   | 3    | MEDIUM | DC014        | LOW           | Open   |
| D-HAZ-010 | Failure to capture / act on local incidents   | 3   | 3    | MEDIUM | DC015, DC016 | LOW           | Open   |

## Controls

| ID    | Description                                                                       |
| ----- | --------------------------------------------------------------------------------- |
| DC001 | Training plan + mandatory completion gate + competence assessment                 |
| DC002 | Super-user model embedded with refresh training on releases                       |
| DC003 | Workflow sign-off + explicit handover-of-care responsibility                      |
| DC004 | Daily safety huddle during pilot + first 30 days                                  |
| DC005 | Interface monitoring + on-call + clinical-priority fallback                       |
| DC006 | Message replay + reconciliation reports                                           |
| DC007 | Manual fallback workflow + printed reference cards, tested                        |
| DC008 | BC drill before go-live + on cadence, reviewed by CSO                             |
| DC009 | Source-of-truth declared per data class + UI signalling + minimal parallel window |
| DC010 | Migration validation: sample review + reconciliation + rollback                   |
| DC011 | Configuration sign-off by clinical lead + CSO; peer review                        |
| DC012 | Reference data sourced from authoritative upstream with freshness monitoring      |
| DC013 | SNOMED / coding subset verified against product expectation                       |
| DC014 | Local role-to-product-role mapping reviewed by IG + CSO, quarterly review         |
| DC015 | Local incident reporting route + product Datix category + routine review          |
| DC016 | Escalation path to manufacturer + vigilance trigger if medical device             |

---

## Important

The ten hazards above are a **starter set** drawn from common patterns in NHS
health IT deployments. They are not a substitute for deployment-specific hazard
identification by the deploying organisation's CSO and clinical SMEs. Many real
deployments add 10–30 site-specific hazards (e.g. specific clinical service edge
cases, specific local integrations, specific patient-population considerations).

---

**Generated by**: ArcKit `/arckit:uk-nhs-dcb0160` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL] **Spec lineage**:
[Marcus Baw SAFETY.md v2.0.0-draft](https://github.com/pacharanero/SAFETY.md)

<!-- arckit-overlay-template: uk-nhs-dcb0160-deployment-safety-template.md -->

# Deployment Clinical Safety — [PRODUCT_NAME] at [DEPLOYING_ORGANISATION]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0160` | **Filename**: `SAFETY.md` (DCB0160 deployer anchor)

## Document Control

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Document ID**      | `SAFETY.md` (deployment) — Marcus Baw SAFETY.md spec convention; no ARC- prefix |
| **Document Type**    | Clinical Safety Anchor (DCB0160 deployer)                                       |
| **Project**          | [PROJECT_NAME] (Project [PROJECT_ID])                                           |
| **Classification**   | [OFFICIAL / OFFICIAL-SENSITIVE]                                                 |
| **Status**           | DRAFT                                                                           |
| **Version**          | [VERSION]                                                                       |
| **Created Date**     | [YYYY-MM-DD]                                                                    |
| **Last Modified**    | [YYYY-MM-DD]                                                                    |
| **Review Cycle**     | Quarterly (or on any material deployment change)                                |
| **Next Review Date** | [YYYY-MM-DD]                                                                    |
| **Owner**            | [DEPLOYING_ORGANISATION_PROJECT_OWNER]                                          |
| **Reviewed By**      | [PENDING — deploying-organisation CSO]                                          |
| **Approved By**      | [PENDING — deploying-organisation CSO]                                          |
| **Distribution**     | [DISTRIBUTION_LIST]                                                             |

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:uk-nhs-dcb0160` command | PENDING     | PENDING       |

---

## Required SAFETY.md fields (Marcus Baw SAFETY.md spec v2.0.0, deployer adaptation)

| Field                     | Value                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| `product-name`            | [PRODUCT_NAME]                                                                    |
| `version`                 | [PRODUCT_VERSION_BEING_DEPLOYED]                                                  |
| `standard`                | DCB0160                                                                           |
| `deployment-organisation` | [DEPLOYING_NHS_ORGANISATION]                                                      |
| `clinical-safety-officer` | [PENDING — deploying-organisation CSO name and GMC/NMC/HCPC/GPhC registration]    |
| `manufacturer-case-url`   | [../SAFETY-CASE.md](../SAFETY-CASE.md) _(or external URL if third-party product)_ |
| `hazard-log-url`          | [./DEPLOYMENT-HAZARD-LOG.md](./DEPLOYMENT-HAZARD-LOG.md)                          |
| `safety-case-status`      | draft                                                                             |
| `last-reviewed`           | [YYYY-MM-DD]                                                                      |

---

## Summary

[One to two paragraphs: deployment context (which clinical service, which sites,
which patient population), the deploying NHS organisation, summary of
deployment-specific safety arrangements (training, fallback, integration,
business continuity), phasing if applicable (pilot / staged rollout /
decommission of legacy).]

---

## Documents

- [Deployment Clinical Safety Case Report](./DEPLOYMENT-SAFETY-CASE.md) —
  substantive deployer safety argument
- [Deployment Hazard Log](./DEPLOYMENT-HAZARD-LOG.md) — deployment-specific
  hazards (YAML frontmatter + rendered table)
- [Manufacturer SAFETY-CASE.md](../SAFETY-CASE.md) — upstream manufacturer
  DCB0129 case _(if same repo)_

---

## Applicable standards and assurance domains

Clinical safety evidence sits alongside wider information-standard evidence.
Under the Data (Use and Access) Act 2025 (amending the Health and Social Care
Act 2012 Part 9 information-standards framework), standards can reach IT,
software, interoperability, portability, information access, and security. This
register records which domains apply, where the evidence lives, and who owns it.
The Clinical Safety Officer owns the clinical-safety row and cross-references
the others where a failure in that domain could cause patient harm; the CSO does
not own every domain below.

| Domain                                    | Standard / framework                       | Applies? | Evidence location                                    | Owner             |
| ----------------------------------------- | ------------------------------------------ | -------- | ---------------------------------------------------- | ----------------- |
| Clinical risk management (manufacture)    | DCB0129                                    | [YES/NO] | received from manufacturer (see `../SAFETY-CASE.md`) | Manufacturer CSO  |
| Clinical risk management (deployment/use) | DCB0160                                    | [YES]    | this deployment safety case                          | Deployer CSO      |
| Health/care information standards         | HSC Act 2012 Part 9 as amended (DUAA 2025) | [TBD]    | Evidence pack                                        | Responsible owner |
| Interoperability / connectivity           | [e.g. FHIR UK Core, NHS Number, SNOMED CT] | [TBD]    | [TBD]                                                | Technical owner   |
| Data protection / secondary use           | UK GDPR / DPA 2018 / DUAA 2025 context     | [TBD]    | DPIA / IG evidence                                   | IG lead           |
| Information security                      | [e.g. DSPT, NCSC CAF, Cyber Essentials]    | [TBD]    | [TBD]                                                | Security owner    |
| Portability / storage / access            | [TBD]                                      | [TBD]    | [TBD]                                                | [TBD]             |

---

## Roles and responsibilities

The Data (Use and Access) Act 2025 "relevant IT provider" concept can bring
suppliers, operators, and maintainers into the information-standards compliance
picture, not only the deploying organisation. Record who holds each role so that
clinical-risk ownership across the lifecycle is unambiguous.

| Role                             | Applies? | Organisation / person | Evidence               |
| -------------------------------- | -------- | --------------------- | ---------------------- |
| Manufacturer / supplier          | [YES/NO] | [ORGANISATION]        | `SAFETY-CASE.md`       |
| Deployer / health organisation   | [YES]    | [ORGANISATION]        | Deployment safety case |
| Operator                         | [YES/NO] | [ORGANISATION]        | [TBD]                  |
| Maintainer                       | [YES/NO] | [ORGANISATION]        | [TBD]                  |
| Relevant IT provider (DUAA 2025) | [YES/NO] | [ORGANISATION]        | Evidence pack          |

---

## Relationship to manufacturer case

The deploying organisation has reviewed the manufacturer's DCB0129 Clinical
Safety Case Report and accepted its residual risks **in the context of this
specific deployment**. Deployment-specific hazards (training inadequacy,
workflow integration, business continuity, local configuration) are documented
in this case and are **not** covered by the manufacturer case.

If material residual risks from the manufacturer case are _not_ acceptable to
the deploying organisation in its local context, the deployment is **not safe to
proceed** until those risks are addressed — typically by additional local
controls, by configuration changes, or by requesting product changes from the
manufacturer.

---

## Important

This document is **not** clinical, legal, or regulatory advice. It is a
generated starting point that MUST be reviewed, materially supplemented, and
signed off by the **deploying organisation's** Clinical Safety Officer (NOT the
manufacturer's CSO) before the product is deployed into clinical use at this
organisation.

---

**Generated by**: ArcKit `/arckit:uk-nhs-dcb0160` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL] **Spec lineage**:
[Marcus Baw SAFETY.md v2.0.0-draft](https://github.com/pacharanero/SAFETY.md)

<!-- arckit-overlay-template: uk-nhs-dcb0160-template.md -->

# NHS DCB0160 Deployment Clinical Safety Case — Wrapper Template

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dcb0160`

This wrapper exists only for `/arckit:customize list` and the documentation
site. The actual generated outputs are three files under
`clinical-safety/deployment/`:

1. [`uk-nhs-dcb0160-deployment-safety-template.md`](./uk-nhs-dcb0160-deployment-safety-template.md)
   — renders to `clinical-safety/deployment/SAFETY.md`
2. [`uk-nhs-dcb0160-deployment-case-template.md`](./uk-nhs-dcb0160-deployment-case-template.md)
   — renders to `clinical-safety/deployment/DEPLOYMENT-SAFETY-CASE.md`
3. [`uk-nhs-dcb0160-deployment-hazard-template.md`](./uk-nhs-dcb0160-deployment-hazard-template.md)
   — renders to `clinical-safety/deployment/DEPLOYMENT-HAZARD-LOG.md`

The three files together implement the NHS DCB0160 deployer-side documentation
expected by NHS England under section 250 of the Health and Social Care Act 2012
(Part 9 information-standards framework, as amended by the Data (Use and Access)
Act 2025). They follow Dr Marcus Baw's
[SAFETY.md spec v2.0.0-draft](https://github.com/pacharanero/SAFETY.md) for
filenames and YAML-frontmatter structure, prefixed with an ArcKit Document
Control block.

DCB0160 sits alongside DCB0129 — neither replaces the other. The manufacturer's
DCB0129 case is the input; the deployer's DCB0160 case argues that _this
specific deployment_ of the product, with this organisation's clinicians,
workflows, integrations, training, and business continuity, is acceptably safe.

<!-- arckit-overlay-template: uk-nhs-dtac-template.md -->

# NHS Digital Technology Assessment Criteria (DTAC v3) — [PRODUCT_NAME]

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:uk-nhs-dtac`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                             | Approved By | Approval Date |
| --------- | ------------ | --------- | --------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:uk-nhs-dtac` command | PENDING     | PENDING       |

---

## DTAC Version

DTAC **v3** (current as at 2026-05). Verify against
<https://transform.england.nhs.uk/key-tools-and-info/digital-technology-assessment-criteria-dtac/>
before submission to an NHS buyer or assurance team — if a newer version is
published, the section structure may have changed.

---

## Executive Summary

[One to two paragraphs: product under assessment, target NHS context, overall
DTAC status (e.g. "passes 4 of 5 sections; Section 1 PENDING DCB0129 sign-off"),
key gaps, and the recommended next assurance steps.]

### Pass / partial / fail by section

| Section                                              | Status                                  | Notes |
| ---------------------------------------------------- | --------------------------------------- | ----- |
| 1. Clinical Safety (DCB0129 / DCB0160)               | [PASS / PARTIAL / FAIL / PENDING]       |       |
| 2. Data Protection (UK GDPR / DPA 2018 / DSPT)       | [PASS / PARTIAL / FAIL / PENDING]       |       |
| 3. Technical Assurance (security, lifecycle, BC/DR)  | [PASS / PARTIAL / FAIL / PENDING]       |       |
| 4. Interoperability (FHIR UK Core, SNOMED, NHS APIs) | [PASS / PARTIAL / FAIL / PENDING]       |       |
| 5. Usability and Accessibility (WCAG 2.2 AA)         | [PASS / PARTIAL / FAIL / PENDING]       |       |
| AI annex (if applicable)                             | [N/A / PASS / PARTIAL / FAIL / PENDING] |       |

---

## Product summary

| Field                           | Value                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| **Product Name**                | [PRODUCT_NAME]                                                               |
| **Manufacturer**                | [MANUFACTURER_LEGAL_ENTITY]                                                  |
| **Product Version**             | [VERSION]                                                                    |
| **Target NHS Context**          | [Primary care / Secondary care / Community / Mental health / ICS / National] |
| **Intended Users**              | [Clinical roles]                                                             |
| **Intended Patient Population** | [Population]                                                                 |
| **Medical Device?**             | [Yes — Class / No / Borderline — cross-ref `/arckit:uk-mdr-classification`]  |
| **Uses AI / ML?**               | [Yes — describe / No]                                                        |
| **Hosting**                     | [Cloud provider + region / On-premise]                                       |
| **Assessment Date**             | [YYYY-MM-DD]                                                                 |

---

## Section 1 — Clinical Safety

### 1.1 DCB0129 Manufacturer Case

| Criterion                                             | Status                  | Evidence / cross-reference                                                 |
| ----------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| Clinical Safety Officer appointed (named, registered) | [PASS / FAIL / PENDING] | [CSO name + registration in `clinical-safety/SAFETY.md`]                   |
| Clinical Risk Management Plan documented              | [PASS / FAIL]           | [`clinical-safety/SAFETY.md` summary / `SAFETY-PLAN.md` if Tier 3]         |
| Clinical Safety Case Report present and current       | [PASS / FAIL / PENDING] | [`clinical-safety/SAFETY-CASE.md`]                                         |
| Hazard Log maintained                                 | [PASS / FAIL]           | [`clinical-safety/HAZARD-LOG.md` — N open hazards, highest open risk: ___] |
| CSO sign-off in place                                 | [PASS / PENDING]        | [Sign-off section in `SAFETY-CASE.md`]                                     |

### 1.2 DCB0160 Deployer Case (if applicable to assessment context)

| Criterion                                        | Status                                             | Evidence / cross-reference                               |
| ------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| Deployer CSO appointed at deploying organisation | [PASS / FAIL / N/A — manufacturer assessment only] |                                                          |
| Deployment Clinical Safety Case Report           | [PASS / FAIL / N/A]                                | [`clinical-safety/deployment/DEPLOYMENT-SAFETY-CASE.md`] |
| Deployment Hazard Log                            | [PASS / FAIL / N/A]                                | [`clinical-safety/deployment/DEPLOYMENT-HAZARD-LOG.md`]  |

> If `clinical-safety/SAFETY-CASE.md` or `clinical-safety/HAZARD-LOG.md` are
> absent, run `/arckit:uk-nhs-dcb0129` to seed them before completing this
> section.

---

## Section 2 — Data Protection

### 2.1 UK GDPR / DPA 2018 lawful basis

| Criterion                                                   | Status        | Evidence                                         |
| ----------------------------------------------------------- | ------------- | ------------------------------------------------ |
| Article 6 lawful basis identified                           | [PASS / FAIL] | [Lawful basis + rationale]                       |
| Article 9 special-category basis identified (if applicable) | [PASS / N/A]  | [Basis + rationale]                              |
| Common Law Duty of Confidentiality satisfied                | [PASS / FAIL] | [Caldicott / consent / s251 / direct care basis] |

### 2.2 DPIA

| Criterion                    | Status                  | Evidence                                |
| ---------------------------- | ----------------------- | --------------------------------------- |
| DPIA conducted and current   | [PASS / FAIL / PENDING] | [Cross-reference `ARC-{PID}-DPIA-*.md`] |
| High-risk findings mitigated | [PASS / FAIL]           | [Mitigation tracker]                    |

### 2.3 NHS Data Security and Protection Toolkit (DSPT)

| Criterion                   | Status                                                | Evidence                        |
| --------------------------- | ----------------------------------------------------- | ------------------------------- |
| DSPT submission in date     | [PASS / FAIL / PENDING — organisation responsibility] | [Submission reference + expiry] |
| DSPT 'Standards Met' status | [PASS / FAIL / PENDING]                               |                                 |

### 2.4 Sub-processors and cross-border transfers

| Sub-processor | Service | Location | Transfer mechanism | UK addendum / IDTA |
| ------------- | ------- | -------- | ------------------ | ------------------ |
|               |         |          |                    |                    |

### 2.5 Data subject rights

| Right                      | Implementation                                         |
| -------------------------- | ------------------------------------------------------ |
| Access (Article 15)        | [How exercised]                                        |
| Rectification (Article 16) |                                                        |
| Erasure (Article 17)       | [If applicable — note exemptions for clinical records] |
| Restriction (Article 18)   |                                                        |
| Portability (Article 20)   | [If applicable]                                        |
| Objection (Article 21)     |                                                        |

---

## Section 3 — Technical Assurance

### 3.1 Hosting

| Criterion                      | Status                   | Evidence                                       |
| ------------------------------ | ------------------------ | ---------------------------------------------- |
| Cloud provider                 |                          | [AWS / Azure / Google Cloud / UKCloud / Other] |
| UK region status               | [PASS / FAIL]            | [Region + data-residency commitment]           |
| Sovereign cloud considerations | [Document if applicable] |                                                |

### 3.2 Security certifications

| Criterion             | Status                  | Evidence                  |
| --------------------- | ----------------------- | ------------------------- |
| Cyber Essentials      | [PASS / FAIL / PENDING] | [Certificate + expiry]    |
| Cyber Essentials Plus | [PASS / FAIL / N/A]     |                           |
| ISO 27001             | [PASS / FAIL / N/A]     | [Scope + certifying body] |
| SOC 2 Type II         | [PASS / FAIL / N/A]     |                           |

### 3.3 Software lifecycle

| Criterion                         | Status        | Evidence                 |
| --------------------------------- | ------------- | ------------------------ |
| Documented SDLC                   | [PASS / FAIL] |                          |
| Code review on every change       | [PASS / FAIL] |                          |
| Dependency scanning               | [PASS / FAIL] | [Tool + cadence]         |
| Software Bill of Materials (SBOM) | [PASS / FAIL] | [Format + accessibility] |

### 3.4 Encryption

| Criterion                                       | Status        | Evidence            |
| ----------------------------------------------- | ------------- | ------------------- |
| In transit (TLS 1.2 minimum, TLS 1.3 preferred) | [PASS / FAIL] |                     |
| At rest (AES-256 or equivalent)                 | [PASS / FAIL] |                     |
| Key management                                  | [PASS / FAIL] | [KMS / HSM details] |

### 3.5 Penetration testing

| Criterion                                        | Status                  | Evidence            |
| ------------------------------------------------ | ----------------------- | ------------------- |
| Independent pen test conducted in last 12 months | [PASS / FAIL / PENDING] | [Test date + scope] |
| All HIGH findings remediated or risk-accepted    | [PASS / FAIL]           | [Remediation log]   |

### 3.6 Business continuity / disaster recovery

| Criterion                      | Target              | Evidence                   |
| ------------------------------ | ------------------- | -------------------------- |
| Recovery Time Objective (RTO)  | [hours]             |                            |
| Recovery Point Objective (RPO) | [hours]             |                            |
| BC test cadence                | [annual / biannual] | [Last test date + outcome] |

### 3.7 Vulnerability management

| Criterion                                   | Status        | Evidence                                   |
| ------------------------------------------- | ------------- | ------------------------------------------ |
| CVSS-rated SLAs for patching                | [PASS / FAIL] | [HIGH within X days, MEDIUM within Y days] |
| Cross-reference Secure by Design assessment | [PASS / FAIL] | [`ARC-{PID}-SECD-*.md`]                    |

---

## Section 4 — Interoperability

### 4.1 Standards adopted

| Standard                       | Version / scope | Status                       |
| ------------------------------ | --------------- | ---------------------------- |
| FHIR UK Core                   | [version]       | [Conformant / Partial / N/A] |
| SNOMED CT UK Edition           | [release]       |                              |
| dm+d (if prescribing)          | [release]       |                              |
| HL7 v2 (if legacy integration) | [profile]       |                              |

### 4.2 NHS Number handling

| Criterion                                        | Status        | Evidence |
| ------------------------------------------------ | ------------- | -------- |
| NHS Number is canonical patient identifier       | [PASS / FAIL] |          |
| PDS lookup with demographic trace on new records | [PASS / FAIL] |          |
| NHS Number validation (Mod 11 check)             | [PASS / FAIL] |          |

### 4.3 NHS APIs

| API                                  | Use                                            | Status               |
| ------------------------------------ | ---------------------------------------------- | -------------------- |
| Personal Demographics Service (PDS)  | [Lookup / trace]                               | [Live / Pilot / N/A] |
| e-Referral Service (e-RS)            |                                                |                      |
| GP Connect                           | [Access record / Appointments / Send Document] |                      |
| NHS App Connect                      |                                                |                      |
| NHS login                            | [Identity verification]                        |                      |
| BARS (Booking and Referral Standard) |                                                |                      |
| IM1 (where applicable)               |                                                |                      |

### 4.4 Open standards conformance

| Criterion                                                                  | Status        | Evidence              |
| -------------------------------------------------------------------------- | ------------- | --------------------- |
| OpenAPI specification published                                            | [PASS / FAIL] | [URL]                 |
| API documentation accessible                                               | [PASS / FAIL] | [URL]                 |
| Implementation guide aligned with NHS Interoperability Standards Catalogue | [PASS / FAIL] | [Catalogue reference] |

---

## Section 5 — Usability and Accessibility

### 5.1 NHS Service Standard alignment

| Service Standard point                                               | Status              | Evidence                 |
| -------------------------------------------------------------------- | ------------------- | ------------------------ |
| Understand users and their needs                                     | [PASS / FAIL]       | [User research evidence] |
| Solve a whole problem for users                                      | [PASS / FAIL]       |                          |
| Provide a joined-up experience across channels                       | [PASS / FAIL]       |                          |
| Make the service simple to use                                       | [PASS / FAIL]       |                          |
| Make sure everyone can use the service                               | [PASS / FAIL]       |                          |
| Have a multi-disciplinary team                                       | [PASS / FAIL]       |                          |
| Use agile ways of working                                            | [PASS / FAIL]       |                          |
| Iterate and improve frequently                                       | [PASS / FAIL]       |                          |
| Create a secure service which protects users' privacy                | [Cross-ref §2 + §3] |                          |
| Define what success looks like and publish performance data          | [PASS / FAIL]       |                          |
| Choose the right tools and technology                                | [Cross-ref §3]      |                          |
| Make new source code open                                            | [PASS / FAIL / N/A] |                          |
| Use and contribute to open standards, common components and patterns | [PASS / FAIL]       |                          |
| Operate a reliable service                                           | [Cross-ref §3]      |                          |

### 5.2 WCAG 2.2 AA accessibility

| Criterion                                         | Status                   | Evidence               |
| ------------------------------------------------- | ------------------------ | ---------------------- |
| Independent accessibility audit in last 12 months | [PASS / FAIL / PENDING]  | [Audit date + auditor] |
| All Level A criteria pass                         | [PASS / FAIL]            |                        |
| All Level AA criteria pass                        | [PASS / FAIL]            |                        |
| Accessibility statement published                 | [PASS / FAIL]            | [URL]                  |
| Screen reader tested (NVDA + VoiceOver + JAWS)    | [PASS / FAIL]            |                        |
| Keyboard-only navigation supported                | [PASS / FAIL]            |                        |
| Colour contrast ≥ 4.5:1 for normal text           | [PASS / FAIL]            |                        |
| Plain English / reading age                       | [Reading age target met] |                        |

---

## AI Annex (DTAC AI Module)

> Complete this annex only if the product uses AI / ML for any
> clinically-relevant function. Otherwise state: "No AI / ML components — annex
> N/A."

### A.1 AI usage

| Field                             | Value                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Uses AI / ML?                     | [Yes / No — if No, annex is N/A]                                             |
| Model class                       | [Rule-based / Classical ML / Deep learning / Foundation model / Agentic LLM] |
| Clinical function performed by AI | [Decision support / triage / risk score / summarisation / etc.]              |
| Vendor of AI component            | [In-house / named third party]                                               |

### A.2 Model governance

| Criterion                                              | Status                  | Evidence                |
| ------------------------------------------------------ | ----------------------- | ----------------------- |
| Training-data provenance documented                    | [PASS / FAIL]           |                         |
| Training-data consent basis                            | [PASS / FAIL]           |                         |
| Training-data clinical representativeness assessed     | [PASS / FAIL]           |                         |
| Model card published                                   | [PASS / FAIL]           | [URL]                   |
| ATRS record published (cross-reference `/arckit:atrs`) | [PASS / FAIL / PENDING] | [`ARC-{PID}-ATRS-*.md`] |

### A.3 Fairness and bias

| Criterion                                                       | Status        | Evidence               |
| --------------------------------------------------------------- | ------------- | ---------------------- |
| Protected characteristics evaluated (sex, age, ethnicity, etc.) | [PASS / FAIL] |                        |
| Performance parity across groups                                | [PASS / FAIL] | [Metrics + thresholds] |
| Bias mitigation actions documented                              | [PASS / FAIL] |                        |

### A.4 Operational monitoring

| Criterion                                    | Status        | Evidence                                        |
| -------------------------------------------- | ------------- | ----------------------------------------------- |
| Model drift monitoring approach              | [PASS / FAIL] | [Metrics + cadence + thresholds]                |
| Human-in-the-loop / human-on-the-loop design | [PASS / FAIL] | [Where humans intervene]                        |
| Substantial-change handling                  | [PASS / FAIL] | [What triggers reassessment under MDR if AIaMD] |

### A.5 Transparency

| Criterion                                         | Status        | Evidence |
| ------------------------------------------------- | ------------- | -------- |
| Plain-English explanation available to clinicians | [PASS / FAIL] |          |
| Plain-English explanation available to patients   | [PASS / FAIL] |          |
| Confidence / uncertainty surfaced in the UI       | [PASS / FAIL] |          |

### A.6 MHRA AIaMD Programme alignment

| MHRA Change Programme WP                     | Applicability | Status |
| -------------------------------------------- | ------------- | ------ |
| WP5 Cyber Secure Medical Devices             |               |        |
| WP9 AI Rigour                                |               |        |
| WP10 Project Glass Box (AI interpretability) |               |        |
| WP11 Project Ship of Theseus (AI adaptivity) |               |        |

---

## External References

### Authoritative Sources

| Doc ID      | Title                                               | Source                                 | Used in    |
| ----------- | --------------------------------------------------- | -------------------------------------- | ---------- |
| DTAC-V3     | NHS Digital Technology Assessment Criteria v3       | NHS England Transformation Directorate | Throughout |
| DCB0129     | Clinical Risk Management — Manufacture of Health IT | NHS England                            | §1         |
| DCB0160     | Clinical Risk Management — Deployment               | NHS England                            | §1         |
| UK-GDPR     | UK General Data Protection Regulation               | Information Commissioner               | §2         |
| DPA-2018    | Data Protection Act 2018                            | UK Parliament                          | §2         |
| DSPT        | NHS Data Security and Protection Toolkit            | NHS Digital                            | §2         |
| WCAG-2.2    | Web Content Accessibility Guidelines 2.2            | W3C                                    | §5         |
| NHS-SVC-STD | NHS Service Standard                                | NHS Service Manual                     | §5         |
| ATRS        | Algorithmic Transparency Recording Standard         | CDEI / DSIT                            | AI annex   |
| MHRA-AIAMD  | MHRA Software and AI as a Medical Device Programme  | MHRA                                   | AI annex   |

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

**Generated by**: ArcKit `/arckit:uk-nhs-dtac` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]
