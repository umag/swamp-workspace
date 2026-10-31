<!-- arckit-overlay-template: eu-ai-act-template.md -->

# EU AI Act Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-ai-act`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                   | Approved By | Approval Date |
| --------- | ------------ | --------- | ----------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-ai-act` | [PENDING]   | [PENDING]     |

## Executive Summary

| Area                     | Risk Class                              | Status                      | Key Findings |
| ------------------------ | --------------------------------------- | --------------------------- | ------------ |
| Risk Classification      | [Prohibited / High / Limited / Minimal] | [Compliant / Partial / Gap] | [Summary]    |
| Transparency Obligations | [Required / N/A]                        | [Compliant / Partial / Gap] | [Summary]    |
| Technical Requirements   | [Applicable / N/A]                      | [Compliant / Partial / Gap] | [Summary]    |
| GPAI Obligations         | [Applicable / N/A]                      | [Compliant / Partial / Gap] | [Summary]    |

---

## 1. AI System Classification

### 1.1 Is this an AI System under the AI Act?

| Criterion                                                                              | Assessment |
| -------------------------------------------------------------------------------------- | ---------- |
| Machine-based system infers outputs (predictions, recommendations, decisions, content) | ☐ Yes ☐ No |
| Operates with varying degrees of autonomy                                              | ☐ Yes ☐ No |
| Designed for explicit or implicit objectives                                           | ☐ Yes ☐ No |
| Output influences physical or virtual environments                                     | ☐ Yes ☐ No |

**In scope**: ☐ Yes ☐ No (if No, stop here)

### 1.2 GPAI Model Assessment

| Criterion                                                                        | Assessment |
| -------------------------------------------------------------------------------- | ---------- |
| General-purpose AI model (trained on broad data, capable of wide range of tasks) | ☐ Yes ☐ No |
| Systemic risk model (> 10²⁵ FLOPs training compute)                              | ☐ Yes ☐ No |

**GPAI model**: ☐ Yes — apply Section 5 | ☐ No

### 1.3 Risk Classification

| Risk Level                                            | Category                                                                                                                                                                                                                                                            | Applicable |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Prohibited** (Article 5)                            | Social scoring by public authorities; exploitation of vulnerabilities; subliminal manipulation; real-time remote biometric ID in public spaces (with exceptions); emotion recognition in workplace/education; biometric categorisation on sensitive characteristics | ☐          |
| **High Risk — Annex I** (safety component of product) | Machinery, toys, medical devices, aviation, vehicles covered by sector legislation                                                                                                                                                                                  | ☐          |
| **High Risk — Annex III** (standalone AI)             | Critical infrastructure; education/vocational training; employment and worker management; essential private/public services; law enforcement; migration/border control; administration of justice; democratic processes                                             | ☐          |
| **Limited Risk**                                      | Chatbots, deepfake generation, emotion recognition, biometric categorisation                                                                                                                                                                                        | ☐          |
| **Minimal Risk**                                      | AI-enabled video games, spam filters, recommendation systems (non-high-risk)                                                                                                                                                                                        | ☐          |

**Classification**: [Prohibited / High Risk / Limited Risk / Minimal Risk]

## 2. Prohibited AI Practices (Article 5)

[Complete if prohibited classification possible — if confirmed prohibited, the
system cannot be placed on the EU market]

| Prohibited Practice                                                                        | Applicable | Assessment |
| ------------------------------------------------------------------------------------------ | ---------- | ---------- |
| Social scoring by public authorities                                                       | ☐          |            |
| Exploitation of psychological/physical vulnerabilities                                     | ☐          |            |
| Subliminal manipulation beyond person's consciousness                                      | ☐          |            |
| Real-time remote biometric identification in public spaces (with limited exceptions)       | ☐          |            |
| Post-remote biometric identification (except for serious crimes)                           | ☐          |            |
| Emotion recognition in workplace or educational institutions                               | ☐          |            |
| Biometric categorisation based on sensitive characteristics (politics, religion, sex life) | ☐          |            |

## 3. High-Risk AI Requirements (Articles 8–17)

[Complete if classified as High Risk]

### 3.1 Risk Management System (Article 9)

| Requirement                                                            | Status | Evidence |
| ---------------------------------------------------------------------- | ------ | -------- |
| Risk management system established and maintained throughout lifecycle | ☐      |          |
| Risks to health, safety, and fundamental rights identified             | ☐      |          |
| Risk estimation and evaluation conducted                               | ☐      |          |
| Residual risk levels acceptable                                        | ☐      |          |

### 3.2 Data Governance (Article 10)

| Requirement                                                               | Status |
| ------------------------------------------------------------------------- | ------ |
| Training, validation, and testing datasets identified                     | ☐      |
| Data governance practices documented                                      | ☐      |
| Training data relevant, sufficiently representative, and free from errors | ☐      |
| Biases identified and addressed                                           | ☐      |
| Special category data in training sets handled appropriately              | ☐      |

### 3.3 Technical Documentation (Article 11 + Annex IV)

| Document                                    | Status |
| ------------------------------------------- | ------ |
| General description of AI system            | ☐      |
| Development process and testing methodology | ☐      |
| Monitoring, functioning, and control        | ☐      |
| Computational requirements                  | ☐      |
| Risk management system documentation        | ☐      |
| Changes to pre-trained models               | ☐      |
| EU Declaration of Conformity                | ☐      |

### 3.4 Record-Keeping / Logging (Article 12)

| Requirement                                          | Status |
| ---------------------------------------------------- | ------ |
| Automatic logging enabled                            | ☐      |
| Logs retained for at least 6 months (or as required) | ☐      |
| Logs accessible to deployer and authority            | ☐      |

### 3.5 Transparency and Information to Deployers (Article 13)

| Requirement                                             | Status |
| ------------------------------------------------------- | ------ |
| Instructions for use provided to deployers              | ☐      |
| Capabilities and limitations disclosed                  | ☐      |
| Intended purpose documented                             | ☐      |
| Performance metrics on specific persons/groups included | ☐      |

### 3.6 Human Oversight (Article 14)

| Requirement                                       | Status |
| ------------------------------------------------- | ------ |
| Human oversight measures designed into the system | ☐      |
| Natural persons assigned to oversee identified    | ☐      |
| Ability to understand output                      | ☐      |
| Ability to disregard/override/intervene           | ☐      |
| Ability to stop operation                         | ☐      |

### 3.7 Accuracy, Robustness, and Cybersecurity (Article 15)

| Requirement                                   | Status |
| --------------------------------------------- | ------ |
| Appropriate accuracy levels documented        | ☐      |
| Robustness against errors and inconsistencies | ☐      |
| Resilience against adversarial manipulation   | ☐      |
| Cybersecurity measures proportionate to risk  | ☐      |

## 4. Transparency Obligations for Limited Risk (Articles 50–52)

[Complete for chatbots, synthetic content, emotion recognition, biometric
categorisation]

| Obligation                                              | Applicable AI Type  | Status |
| ------------------------------------------------------- | ------------------- | ------ |
| Disclose AI interaction to users (chatbots)             | Chatbots            | ☐      |
| Label AI-generated content (deepfakes, synthetic media) | Generative AI       | ☐      |
| Disclose emotion recognition use                        | Emotion recognition | ☐      |
| Disclose biometric categorisation use                   | Biometric systems   | ☐      |

## 5. GPAI Model Obligations (Articles 53–55)

[Complete if the system uses or is a General-Purpose AI model]

### 5.1 Standard GPAI Obligations (Article 53)

| Obligation                                   | Status |
| -------------------------------------------- | ------ |
| Technical documentation maintained           | ☐      |
| Copyright compliance policy in place         | ☐      |
| Summary of training data published           | ☐      |
| Information provided to downstream providers | ☐      |

### 5.2 Systemic Risk GPAI (Article 55) — Models > 10²⁵ FLOPs

| Obligation                                  | Status |
| ------------------------------------------- | ------ |
| Adversarial testing (red-teaming) conducted | ☐      |
| Serious incident reporting to AI Office     | ☐      |
| Cybersecurity measures for model weights    | ☐      |
| Energy efficiency metrics reported          | ☐      |

## 6. Conformity Assessment and Registration

### 6.1 Conformity Assessment Route (High Risk only)

| Route                                      | Applicable To                                 | Notified Body Required |
| ------------------------------------------ | --------------------------------------------- | ---------------------- |
| Internal control (Annex VI)                | High-risk AI not in Annex I product           | No                     |
| Third-party assessment (Annex VII)         | High-risk AI in Annex I product category      | Yes                    |
| Quality management system (Annex VII/VIII) | High-risk AI where harmonised standards apply | Depends                |

### 6.2 EU AI Act Registration (Article 49)

| Requirement                                                                       | Status |
| --------------------------------------------------------------------------------- | ------ |
| System registered in EU AI Act database (if high risk, deployer in public sector) | ☐      |
| CE marking affixed (if high risk, Article 48)                                     | ☐      |
| EU Declaration of Conformity issued                                               | ☐      |

## 7. French Market Context

| Authority                 | Role                                                          |
| ------------------------- | ------------------------------------------------------------- |
| ANSSI                     | Cybersecurity requirements for AI systems; technical advisory |
| CNIL                      | GDPR interface with AI Act; AI and fundamental rights         |
| French AI Office (future) | Market surveillance for AI Act                                |
| Comité National de l'IA   | Government AI strategy coordination                           |

## 8. Gap Analysis and Roadmap

| Gap               | Article   | Priority | Owner  | AI Act Deadline |
| ----------------- | --------- | -------- | ------ | --------------- |
| [Gap description] | [Art. XX] | 🔴 High  | [Role] | [Date]          |

**Key AI Act application dates** (Article 113 as amended by Regulation (EU)
2026/1744):

- 2 February 2025: Prohibited AI practices and AI literacy apply
- 2 August 2025: GPAI model obligations, governance and penalties apply
- 2 August 2026: General application, including Article 50 transparency
  obligations
- 2 December 2026: Article 5(1)(ba)–(bb) prohibitions apply; Article 50(2)
  marking deadline for generative AI systems placed on the market before 2
  August 2026
- 2 August 2027: GPAI models placed on the market before 2 August 2025 must
  comply
- 2 December 2027: High-risk AI (Annex III) obligations apply
- 2 August 2028: High-risk AI (Annex I products) obligations apply
- 2 August 2030: Pre-existing high-risk AI systems used by public authorities
  must comply

---

**Generated by**: ArcKit `/arckit:eu-ai-act` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-cloud-sovereignty-template.md -->

# EU Cloud Sovereignty Framework Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-cloud-sovereignty`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                              | Approved By | Approval Date |
| --------- | ------------ | --------- | ---------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-cloud-sovereignty` | [PENDING]   | [PENDING]     |

## Executive Summary

**Assessment context**: [Tender minimum-setting / Candidate service assessment /
Both]

**Framework version**: EU Cloud Sovereignty Framework v1.2.1 (October 2025)

**Overall SEAL**: [SEAL-0 to SEAL-4] — the lowest SEAL evidenced across all
eight objectives, a minimum never an average or mode (Implementation guidance
p.9). Governing objective: [SOV-n — objective name]. Governing criterion:
[contributing factor that set the minimum]. This is the framework's actual
rejection gate — see Section 3.3.

**Sovereignty Score**: [N]% (weighted award-criterion contribution, used only to
compare offers that have already reached the minimum SEAL — see Section 3)

**Verification status**: [N] of 8 objectives evidenced; [N] remain
self-declared/unverified claims

| Objective                                | Weight | SEAL Claimed       | SEAL Evidenced     | Minimum SEAL (tender) | Meets Minimum? |
| ---------------------------------------- | ------ | ------------------ | ------------------ | --------------------- | -------------- |
| SOV-1 Strategic Sovereignty              | 20%    | [SEAL-0 to SEAL-4] | [SEAL-0 to SEAL-4] | [SEAL / Not yet set]  | ☐              |
| SOV-2 Legal & Jurisdictional Sovereignty | 10%    | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |
| SOV-3 Data & AI Sovereignty              | 10%    | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |
| SOV-4 Operational Sovereignty            | 15%    | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |
| SOV-5 Supply Chain Sovereignty           | 10%    | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |
| SOV-6 Technology Sovereignty             | 15%    | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |
| SOV-7 Security & Compliance Sovereignty  | 15%    | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |
| SOV-8 Environmental Sustainability       | 5%     | [SEAL]             | [SEAL]             | [SEAL / Not yet set]  | ☐              |

> ⚠️ This document is an **assessment record**, not a certification. There is no
> published EU list of providers assessed against this framework — no commercial
> cloud provider is named as sovereign, compliant, or achieving any SEAL level
> in this document.

---

## 1. Procurement Context and Scope

### 1.1 Assessment Context

[Describe whether this document defines minimum SEAL levels for a forthcoming
tender specification, assesses an already-specified or candidate service, or
both]

### 1.2 Cloud Service and Workload

| Attribute                               | Value                                       |
| --------------------------------------- | ------------------------------------------- |
| Cloud service type                      | [IaaS / PaaS / SaaS / Edge]                 |
| Workload description                    | [Description]                               |
| Data sensitivity classification         | [Classification]                            |
| Member state(s) of operation            | [Member state(s)]                           |
| National sovereignty programme (if any) | [e.g. NDS Cloudprogramma / None identified] |

## 2. Minimum Assurance Levels (Tender Specification)

> ⚠️ **Critical distinction**: Minimum SEAL levels below are set by the
> **contracting authority** in the tender specification as a Minimum Assurance
> Level. They are **not** fixed by the EU Cloud Sovereignty Framework itself —
> the framework defines the objectives, weights, and SEAL scale, not the pass
> threshold for any given procurement. A tender that does not consistently reach
> the required minimum across all objectives is rejected.

| Objective                                | Minimum SEAL Required                                     | Source                               |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| SOV-1 Strategic Sovereignty              | [SEAL-0 to SEAL-4 / Not yet set by contracting authority] | [Tender specification reference / —] |
| SOV-2 Legal & Jurisdictional Sovereignty | [SEAL]                                                    | [Source]                             |
| SOV-3 Data & AI Sovereignty              | [SEAL]                                                    | [Source]                             |
| SOV-4 Operational Sovereignty            | [SEAL]                                                    | [Source]                             |
| SOV-5 Supply Chain Sovereignty           | [SEAL]                                                    | [Source]                             |
| SOV-6 Technology Sovereignty             | [SEAL]                                                    | [Source]                             |
| SOV-7 Security & Compliance Sovereignty  | [SEAL]                                                    | [Source]                             |
| SOV-8 Environmental Sustainability       | [SEAL]                                                    | [Source]                             |

## 3. Sovereignty Score — Methodology and Result

### 3.0 SEAL Level Definitions

> **Source**: reproduced verbatim from the Cloud Sovereignty Framework
> Implementation guidance (pp.2–3). SEAL-2's "with material dependencies remain"
> is the source's own wording. Framework v1.2.1 (October 2025, p.3) words the
> levels differently — SEAL-2 "EU law applicable and enforceable, with material
> non-EU dependencies remaining", and SEAL-3 is named _Digital Resilience_ — a
> tender specification written against v1.2.1 may use those terms.

| Level  | Name                       | Definition                                                                                                                                                       |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEAL-0 | No Sovereignty             | Service, technology or operations under exclusive control of non-EU third parties, governed entirely by non-EU jurisdictions                                     |
| SEAL-1 | Jurisdictional Sovereignty | EU law formally applies with limited practical enforceability; service, technology or operations under exclusive control of non-EU third parties                 |
| SEAL-2 | Data Sovereignty           | EU jurisdictions apply, with material dependencies remain; service, technology or operations under indirect control of non-EU third parties                      |
| SEAL-3 | Technological Sovereignty  | EU jurisdictions apply, EU actors exercising meaningful but not full influence; service, technology or operations under marginal control of non-EU third parties |
| SEAL-4 | Full Digital Sovereignty   | Technology and operations under complete EU control, subject only to EU jurisdiction, with no critical non-EU dependencies                                       |

### 3.0b Per-Objective SEAL Requirements (SEAL-2 to SEAL-4)

> **Note**: This table reproduces Implementation guidance p.10 and starts at
> SEAL-2 because SEAL-2 was the minimum level set for the Commission's own
> competition — the table below is that worked example's requirements, not a
> floor the framework itself imposes. A tender with a lower stated minimum
> (SEAL-0 or SEAL-1) is still assessable: fall back to the general SEAL level
> definitions in 3.0 for those levels rather than reading the missing rows as
> "not assessable."

| Objective                                | SEAL-2                                                                                                                                                                                                                     | SEAL-3                                                                                                                                             | SEAL-4                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SOV-1 Strategic Sovereignty              | An autonomous entity in its organization, but not in its technical choices. The service continues but no longer has access to updates and security patches in the event of a break in access to the underlying technology. | Access to the roadmap. Complete guarantee of operations continuity.                                                                                | Decision-making centres exclusively in the EU. Priority European customers in roadmap arbitrations.                                                              |
| SOV-2 Legal & Jurisdictional Sovereignty | Isolation by creating separate entities. Limited exposure to export control-type measures.                                                                                                                                 | Complete insulation guaranteeing the inapplicability of non-EU legislation. No exposure of Member States to export control measures.               | Operations are designed and carried out exclusively in the EU. Protection of international institutions against export control measures.                         |
| SOV-3 Data & AI Sovereignty              | Full control of the data, including encryption control, data localization and deletion guarantee. Logs available.                                                                                                          | EU design AI. Logs recorded in real time in the EU.                                                                                                | Immutability of logs, audits carried out by European teams.                                                                                                      |
| SOV-4 Operational Sovereignty            | Operations carried out and documented locally. Expertise from outside the EU may be necessary. Open and documented alternatives exist.                                                                                     | Availability of expertise in Europe, including subcontractors. Processes are designed and documented locally.                                      | Complete European autonomy, including security clearances and the integration of key skills of subcontractors.                                                   |
| SOV-5 Supply Chain Sovereignty           | Majority of the supply chains are documented. Deployments are carried out locally, according to procedures that can be external. Critical suppliers and subcontractors can be audited.                                     | The majority of services are designed in the EU. They are deployed and orchestrated locally. No subcontractors involved in critical services.      | EU-certified components origin. EU design, build and compliance check. No dependence on non-EU suppliers. Complete auditability of suppliers and subcontractors. |
| SOV-6 Technology Sovereignty             | The services are partially interoperable. HPC is hosted on-premises.                                                                                                                                                       | European and public standards for core services. Open-source majority and predominance of European contributors. Auditability of the architecture. | Full compliance: EU Open AI, public standard, open source.                                                                                                       |
| SOV-7 Security & Compliance Sovereignty  | EAL2 level security. Local operations, transparent and immediate feedback of information, audits allowed.                                                                                                                  | ELA 3.                                                                                                                                             | EAL 4-5, ENISA integration, immutable logs.                                                                                                                      |
| SOV-8 Environmental Sustainability       | Documented and transparent approach.                                                                                                                                                                                       | _(not specified in source)_                                                                                                                        | EU-certified lifecycle, EU-audited reporting.                                                                                                                    |

**Score(SOVn)** = the SUM of the `value` fields of the answers selected for
objective n's criteria, sourced from the calculator catalogue
(`csf-criteria-calculator-2026-06-01.json`; see Appendix A). An unanswered
criterion contributes nothing and is recorded as a gap, not a zero-value answer.

**Max.Score(SOVn)** = a NOMINAL **1000** for every objective (n = 1 to 8), by
construction — not each objective's own computed maximum. Each objective's
actual maximum (summing its criteria's highest-value answers) is 1000.03 /
1002.00 / 1000.00 / 1002.00 / 1001.00 / 1000.00 / 1001.00 / 1000.00 for SOV-1 to
SOV-8 respectively — the workbook rounds individual answer values to 2 decimal
places, so these do not land on exactly 1000. That is recorded for verification
only: the formula below always divides by the shared nominal 1000, never by an
objective's own actual maximum.

**Formula**: Sovereignty Score = Σ over the eight objectives of (Score(SOVn)
/ 1000) × Weight(SOVn), expressed as a percentage. Because each objective's
actual maximum slightly exceeds 1000, a **maximal response scores 100.0756%, not
100%** — this is the framework's own rounding behaviour, reported faithfully
rather than clamped.

**SEAL is not an input to the Score, and the Score does not determine SEAL.**
Per the Implementation guidance (p.9), the same 48 answers determine both
readings independently — each answer carries its own Score value and its own
SEAL level. The Overall SEAL above is `SEAL-{N}` where N is the **minimum** SEAL
level across every answered criterion in the whole assessment, not an average
and not derived from the weighted Score.

**Adaptability caveats**: answer values "can be adapted by contracting
authorities" per the guidance; the calculator's weight column is captioned
"Score (examples)," not a mandated regulatory weighting; the calculator's own
worked example column holds fictitious illustrative values that must never be
presented as a real provider assessment.

### 3.1 Objective Weights

| Objective                                | Weight   |
| ---------------------------------------- | -------- |
| SOV-1 Strategic Sovereignty              | 20%      |
| SOV-2 Legal & Jurisdictional Sovereignty | 10%      |
| SOV-3 Data & AI Sovereignty              | 10%      |
| SOV-4 Operational Sovereignty            | 15%      |
| SOV-5 Supply Chain Sovereignty           | 10%      |
| SOV-6 Technology Sovereignty             | 15%      |
| SOV-7 Security & Compliance Sovereignty  | 15%      |
| SOV-8 Environmental Sustainability       | 5%       |
| **Total**                                | **100%** |

### 3.2 Scored Result

`Max Score` is the shared nominal 1000 for every objective (see above) — never
an objective's own actual maximum. Each `Score` below must equal the sum of that
objective's rows in Appendix A; if it does not, the arithmetic is wrong, not the
appendix.

| Objective                                | Score   | Max Score | Weight | Weighted Contribution |
| ---------------------------------------- | ------- | --------- | ------ | --------------------- |
| SOV-1 Strategic Sovereignty              | [Score] | 1000      | 20%    | [%]                   |
| SOV-2 Legal & Jurisdictional Sovereignty | [Score] | 1000      | 10%    | [%]                   |
| SOV-3 Data & AI Sovereignty              | [Score] | 1000      | 10%    | [%]                   |
| SOV-4 Operational Sovereignty            | [Score] | 1000      | 15%    | [%]                   |
| SOV-5 Supply Chain Sovereignty           | [Score] | 1000      | 10%    | [%]                   |
| SOV-6 Technology Sovereignty             | [Score] | 1000      | 15%    | [%]                   |
| SOV-7 Security & Compliance Sovereignty  | [Score] | 1000      | 15%    | [%]                   |
| SOV-8 Environmental Sustainability       | [Score] | 1000      | 5%     | [%]                   |
| **Sovereignty Score**                    |         |           |        | **[N]%**              |

> **Context**: The Sovereignty Score contributes to the tender's quality score
> as an **award criterion**. This is separate from, and does not override, the
> minimum-SEAL rejection gate in Section 2 — a high Sovereignty Score does not
> excuse failing a stated minimum SEAL on any single objective.
>
> **Note**: a maximal response (every criterion at its highest-value answer)
> scores 100.0756%, not 100% — the framework's own 2dp answer-value rounding,
> not an error. Do not clamp a computed score to 100%.

### 3.3 Overall SEAL Determination

The framework defines an aggregate SEAL, and it is a **minimum** — never an
average and never a mode. Two levels of the derivation apply, cited separately:

- **Per-objective SEAL** = the minimum SEAL across every criterion answered
  within that objective (see each objective's "SEAL evidenced" in Section 4).
  This level is a property of the framework; the Annex calculator does not
  compute it, and the workbook holds no per-objective SEAL cell.
- **Overall SEAL** = the minimum SEAL evidenced across all eight objectives.
  Implementation guidance p.9, quoted verbatim: "The overall SEAL level is **the
  lowest SEAL level achieved in any of the objectives**." The Annex calculator
  XLSX implements exactly this at cell F2: `="SEAL-"&MIN(H5:H251)` — the
  workbook's only `MIN()`, spanning every answer row across all eight
  objectives, where each row's SEAL is `=IF(E<n>,1*F<n>,"")`.

These two levels agree only because an objective's SEAL is itself the minimum
across its criteria — the Overall SEAL is a minimum-of-minimums.

> **Inert-criterion property** (Implementation guidance p.9, quoted verbatim):
> "When all responses grant SEAL-4, it must be understood that the criterion has
> no impact on the SEAL calculation." A criterion whose every recorded answer is
> SEAL-4 can never bind the minimum and can never be the governing criterion
> below — it still contributes to the weighted Sovereignty Score in Section 3.2,
> but it is inert for this gate.

> **Prevalence of SEAL over Sovereignty Score** (Implementation guidance p.10,
> quoted verbatim): "It is important to emphasize the prevalence of the SEAL
> criterion over the Sovereignty Score. In the context of cloud services
> procurement, the Contracting Authority decides what is the minimum SEAL
> required. Sovereignty score is used to compare the offers that have reached
> the minimum required SEAL." The **Overall SEAL below, not the Sovereignty
> Score above, is the framework's actual rejection gate** against the tender's
> stated minimum.

| Field               | Value                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| **Overall SEAL**    | [SEAL-0 to SEAL-4]                                                         |
| Governing objective | [SOV-n — objective name]                                                   |
| Governing criterion | [Contributing factor within that objective that set the minimum]           |
| Basis               | [Cross-reference to the governing objective's evidence table in Section 4] |

> **SEAL-4 attainability caveat** — European Commission, Implementation guidance
> for the EU Cloud Sovereignty Framework, "Lessons learnt" (p.13, published 1
> June 2026), quoted verbatim: "The level SEAL-4, however relevant, since it
> describes the highest level of Sovereignty, is not today relevant in the
> context of EU Sovereignty considering existing dependence to specific supply
> chains (chips, hardware). Relaxing the level SEAL-4, at least temporarily,
> would allow to make more difference between providers, especially when it
> comes to sensitiveness to hostile take-overs." The Commission frames this as a
> limitation of the current framework version that it proposes to revisit, not a
> permanent property of SEAL-4 — it does not change how the Overall SEAL above
> is computed.

## 4. Objective-by-Objective Assessment

> **SEAL evidenced**, per objective below, is the minimum SEAL across every
> contributing factor evidenced in that objective's table — never an average.
> Name the binding contributing factor explicitly where it is not obvious;
> Section 3.3 cites it as the "governing criterion" for whichever objective sets
> the Overall SEAL.

### 4.1 SOV-1 Strategic Sovereignty (Weight: 20%)

**SEAL claimed**: [SEAL-0 to SEAL-4] | **SEAL evidenced**: [SEAL-0 to SEAL-4]

| Contributing Factor                                                                                     | Evidence   | Status |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| EU jurisdiction of bodies with decisive authority over the service                                      | [Evidence] | ☐      |
| Assurances against change of control                                                                    | [Evidence] | ☐      |
| Reliance on EU-sourced financing                                                                        | [Evidence] | ☐      |
| Investment, jobs and value creation in the EU                                                           | [Evidence] | ☐      |
| Ability to sustain secure operations against cessation/suspension requests or vendor support withdrawal | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.2 SOV-2 Legal & Jurisdictional Sovereignty (Weight: 10%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                                            | Evidence   | Status |
| ---------------------------------------------------------------------------------------------- | ---------- | ------ |
| National legal system governing operations and contracts                                       | [Evidence] | ☐      |
| Exposure to non-EU laws with cross-border reach (e.g. US CLOUD Act, Chinese Cybersecurity Law) | [Evidence] | ☐      |
| Legal, contractual or technical channels for non-EU compelled access                           | [Evidence] | ☐      |
| Applicability of international regimes restricting usage or transfer                           | [Evidence] | ☐      |
| Location and jurisdiction of IP creation and registration                                      | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.3 SOV-3 Data & AI Sovereignty (Weight: 10%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                                                                         | Evidence   | Status |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| Only the customer holds effective cryptographic access to their data                                                        | [Evidence] | ☐      |
| Visibility into when/where/by whom data is accessed, incl. AI model usage auditability and verifiable irreversible deletion | [Evidence] | ☐      |
| Strict confinement of storage/processing to European jurisdictions, no third-country fallback                               | [Evidence] | ☐      |
| Extent of EU control over AI model and data pipeline development, training, hosting and governance                          | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.4 SOV-4 Operational Sovereignty (Weight: 15%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                                    | Evidence   | Status |
| -------------------------------------------------------------------------------------- | ---------- | ------ |
| Ease of migrating workloads to alternative EU-controlled solutions without lock-in     | [Evidence] | ☐      |
| EU operator capacity to manage, maintain and support without non-EU vendor involvement | [Evidence] | ☐      |
| EU-based talent pool                                                                   | [Evidence] | ☐      |
| Operational support delivered from within the EU under EU legal frameworks             | [Evidence] | ☐      |
| Availability of full documentation, source code and operational know-how               | [Evidence] | ☐      |
| Location and legal control of critical suppliers and subcontractors                    | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.5 SOV-5 Supply Chain Sovereignty (Weight: 10%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                                | Evidence   | Status |
| ---------------------------------------------------------------------------------- | ---------- | ------ |
| Geographic source of key physical parts and manufacturing location                 | [Evidence] | ☐      |
| Jurisdiction and provenance of embedded code controlling hardware and firmware     | [Evidence] | ☐      |
| Where and by whom software is architected, packaged, distributed and updated       | [Evidence] | ☐      |
| Reliance on non-EU vendors, facilities or proprietary technologies                 | [Evidence] | ☐      |
| Visibility into the entire supplier and sub-supplier chain, including audit rights | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.6 SOV-6 Technology Sovereignty (Weight: 15%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                                     | Evidence   | Status |
| --------------------------------------------------------------------------------------- | ---------- | ------ |
| Integration through well-documented non-proprietary APIs and protocols                  | [Evidence] | ☐      |
| Adherence to publicly governed standards                                                | [Evidence] | ☐      |
| Accessibility under open licences with rights to audit, modify and redistribute         | [Evidence] | ☐      |
| Visibility into design and functioning, incl. architecture documentation and data flows | [Evidence] | ☐      |
| EU independence in high-performance computing, processors and accelerators              | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.7 SOV-7 Security & Compliance Sovereignty (Weight: 15%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                                        | Evidence   | Status |
| ------------------------------------------------------------------------------------------ | ---------- | ------ |
| EU and internationally recognised certifications (ISO, ENISA schemes)                      | [Evidence] | ☐      |
| Adherence to GDPR, NIS2, DORA and other EU frameworks                                      | [Evidence] | ☐      |
| Security operations centres and response teams operating exclusively under EU jurisdiction | [Evidence] | ☐      |
| Customer/EU-authority ability to oversee logs, alerts and monitoring directly              | [Evidence] | ☐      |
| Transparent EU-compliant breach reporting                                                  | [Evidence] | ☐      |
| Capacity to develop, test and apply security patches independently of non-EU vendors       | [Evidence] | ☐      |
| Independent EU security and compliance audits with full access                             | [Evidence] | ☐      |

**Gaps**: [Gap description]

### 4.8 SOV-8 Environmental Sustainability (Weight: 5%)

**SEAL claimed**: [SEAL] | **SEAL evidenced**: [SEAL]

| Contributing Factor                                                          | Evidence   | Status |
| ---------------------------------------------------------------------------- | ---------- | ------ |
| Energy-efficient infrastructure with measurable improvement targets          | [Evidence] | ☐      |
| Circular-economy practices for hardware reuse, refurbishment and end-of-life | [Evidence] | ☐      |
| Transparent disclosure of carbon emissions and water usage                   | [Evidence] | ☐      |
| Sourcing of renewable or low-carbon energy                                   | [Evidence] | ☐      |

**Gaps**: [Gap description]

## 5. Evidence Basis and Verification Status

> ⚠️ **A self-declared SEAL is an unverified claim** until this assessment
> records supporting evidence per objective. This document records an
> assessment; it does not certify.
>
> ⚠️ **No published EU list of assessed providers exists.** No commercial cloud
> provider is named as sovereign, compliant, or achieving any SEAL level in this
> document.

| Objective | Evidence Reviewed | Source   | Assessor | Date         |
| --------- | ----------------- | -------- | -------- | ------------ |
| SOV-1     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-2     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-3     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-4     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-5     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-6     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-7     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |
| SOV-8     | [Evidence]        | [Source] | [Name]   | [YYYY-MM-DD] |

## 6. Member State Adoption Context

The EU Cloud Sovereignty Framework is being adopted as a national yardstick by
member states. The Netherlands is the worked example documented here:

| Instrument                                                  | Detail                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notitie: Verkenning Overheidsbrede Soevereine Clouddiensten | NDS Cloudprogramma, v1.0, 11 June 2026 — adopts the framework as its sovereignty measure                                                                       |
| Dutch SEAL rendering                                        | SEAL0 Geen soevereiniteit; SEAL1 Jurisdictionele soevereiniteit; SEAL2 Data-soevereiniteit; SEAL3 Digitale veerkracht; SEAL4 Volledige digitale soevereiniteit |
| Target                                                      | SEAL4 for a government-wide sovereign cloud service                                                                                                            |
| Application                                                 | Demand-side: a workplace requiring SEAL3 requires a cloud service reaching at least SEAL3                                                                      |
| Herziening rijksbreed cloudbeleid 2026                      | Cites the framework as the instrument for limiting the risk of foreign-government interference in supplier selection                                           |

[If this project is Dutch: state applicability directly. If not: note this
section is for context/comparison and identify the relevant national programme
if supplied by the user.]

## 7. Gap Analysis and Remediation Plan

| Gap               | Objective | Against                                                      | Priority | Owner   | Target Date |
| ----------------- | --------- | ------------------------------------------------------------ | -------- | ------- | ----------- |
| [Gap description] | [SOV-x]   | [Minimum SEAL — rejection risk / Target SEAL — aspirational] | 🔴 High  | [Owner] | [Date]      |

## 8. Recommendation

**Status**: This document is an assessment record, not a certification.

**Recommendation**: [Proceed / Proceed conditionally / Do not proceed] with
[rationale]

**Next steps**: [Legal/procurement counsel review / Formal evidence collection /
Re-assessment cadence]

## 9. External References

### Document Register

| Doc ID | Filename                                 | Type    | Source Location | Description                                                                                                                   |
| ------ | ---------------------------------------- | ------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| WEB-1  | [full URL of the framework as published] | Web URL | [domain]        | EU Cloud Sovereignty Framework v1.2.1 (October 2025) — sovereignty objectives, weights, and SEAL scale. Verified [YYYY-MM-DD] |

### Citations

| Citation ID | Doc ID | Page/Section | Category | Quoted Passage |
| ----------- | ------ | ------------ | -------- | -------------- |
| —           | —      | —            | —        | —              |

### Unreferenced Documents

| Filename | Source Location | Reason |
| -------- | --------------- | ------ |
| —        | —               | —      |

## Appendix A: Per-Criterion Scoring Detail

> This appendix is what makes the Section 3.2 Scored Result table checkable
> **without** re-running the scorer: every `Score(SOVn)` above must equal the
> sum of that objective's `Score value` column below. Every description, answer
> label, value, and SEAL level is sourced from
> `csf-criteria-calculator-2026-06-01.json` — none are invented here. A
> criterion with no evidence is recorded as `Unanswered / gap`, not defaulted to
> a zero-value answer.

### A.1 SOV-1 Strategic Sovereignty (8 criteria)

| # | Criterion                                  | Selected Answer             | Score Value | SEAL  |
| - | ------------------------------------------ | --------------------------- | ----------- | ----- |
| 1 | EU/EEA legal entity control                | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Change of Control Risk                     | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Control Over Roadmap                       | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Financial independence from non-EU capital | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | EU economic contribution                   | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 6 | Participation in EU strategic programs     | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 7 | Alignment with EU industrial strategies    | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 8 | Resilience to Cut-off                      | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                            | **Score(SOV-1)**            | **[Sum]**   |       |

### A.2 SOV-2 Legal & Jurisdictional Sovereignty (6 criteria)

| # | Criterion                   | Selected Answer             | Score Value | SEAL  |
| - | --------------------------- | --------------------------- | ----------- | ----- |
| 1 | Primary Legal Jurisdiction  | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Extraterritorial Laws       | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Data Access Pathways        | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Export Control Restrictions | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | Origin of IP                | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 6 | IP Holder Jurisdiction      | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                             | **Score(SOV-2)**            | **[Sum]**   |       |

### A.3 SOV-3 Data & AI Sovereignty (5 criteria)

| # | Criterion                                  | Selected Answer             | Score Value | SEAL  |
| - | ------------------------------------------ | --------------------------- | ----------- | ----- |
| 1 | Customer control over encryption keys      | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Transparent data flows & access logs       | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Secure deletion & proof of erasure of data | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Data location strictly in EU/EEA           | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | AI services                                | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                            | **Score(SOV-3)**            | **[Sum]**   |       |

### A.4 SOV-4 Operational Sovereignty (6 criteria)

| # | Criterion                                       | Selected Answer             | Score Value | SEAL  |
| - | ----------------------------------------------- | --------------------------- | ----------- | ----- |
| 1 | Portability & Interoperability                  | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Ability to Operate Without Foreign Dependencies | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Skill Availability                              | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Support Channels                                | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | Documentation & Knowledge Transfer              | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 6 | Subcontractor & Suppliers jurisdiction          | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                                 | **Score(SOV-4)**            | **[Sum]**   |       |

### A.5 SOV-5 Supply Chain Sovereignty (7 criteria)

| # | Criterion                                                       | Selected Answer             | Score Value | SEAL  |
| - | --------------------------------------------------------------- | --------------------------- | ----------- | ----- |
| 1 | Origin of Components                                            | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Origin of Components: Manufacturing Location                    | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Origin of Components: embedded code jurisdiction                | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Origin of Software                                              | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | Origin of Software: packaging/distribution/updates jurisdiction | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 6 | Single Point of Dependency                                      | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 7 | Supply Chain Transparency                                       | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                                                 | **Score(SOV-5)**            | **[Sum]**   |       |

### A.6 SOV-6 Technology Sovereignty (5 criteria)

| # | Criterion                          | Selected Answer             | Score Value | SEAL  |
| - | ---------------------------------- | --------------------------- | ----------- | ----- |
| 1 | Interoperability & Open interfaces | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Open Standards Compliance          | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Open Source Availability           | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Service Architecture Transparency  | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | HPC Sovereignty                    | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                    | **Score(SOV-6)**            | **[Sum]**   |       |

### A.7 SOV-7 Security & Compliance Sovereignty (7 criteria)

| # | Criterion                                | Selected Answer             | Score Value | SEAL  |
| - | ---------------------------------------- | --------------------------- | ----------- | ----- |
| 1 | Security Certification                   | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | EU Regulatory compliance                 | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | EU-based SOC & incident handling         | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Control over security monitoring/logging | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 5 | Disclosure of incidents                  | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 6 | Maintenance Autonomy                     | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 7 | Auditability                             | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                          | **Score(SOV-7)**            | **[Sum]**   |       |

### A.8 SOV-8 Environmental Sustainability (4 criteria)

| # | Criterion                      | Selected Answer             | Score Value | SEAL  |
| - | ------------------------------ | --------------------------- | ----------- | ----- |
| 1 | Energy efficiency              | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 2 | Hardware reuse & recycling     | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 3 | Environmental impact reporting | [Answer / Unanswered — gap] | [Value]     | [0-4] |
| 4 | Energy supplies                | [Answer / Unanswered — gap] | [Value]     | [0-4] |
|   |                                | **Score(SOV-8)**            | **[Sum]**   |       |

**Overall SEAL** = `SEAL-{MIN(SEAL column across every answered row above)}` —
the minimum across all 48 criteria, computed here directly rather than from the
per-objective SEAL-evidenced values in Section 4.

---

**Generated by**: ArcKit `/arckit:eu-cloud-sovereignty` command **Generated
on**: [YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-cra-template.md -->

# EU Cyber Resilience Act Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-cra`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                | Approved By | Approval Date |
| --------- | ------------ | --------- | -------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-cra` | [PENDING]   | [PENDING]     |

## Executive Summary

| Area                     | Classification                 | Status                      | Key Gaps |
| ------------------------ | ------------------------------ | --------------------------- | -------- |
| Product Scope            | [In scope / Out of scope]      | —                           | —        |
| Risk Classification      | [Default / Class I / Class II] | [Compliant / Partial / Gap] | [Count]  |
| Security by Design       | —                              | [Compliant / Partial / Gap] | [Count]  |
| Vulnerability Management | —                              | [Compliant / Partial / Gap] | [Count]  |
| Reporting Capability     | —                              | [Compliant / Partial / Gap] | [Count]  |
| Conformity Assessment    | —                              | [Compliant / Partial / Gap] | [Count]  |

---

## 1. Scope and Classification

### 1.1 In-Scope Assessment

| Criterion                                                                                                 | Assessment                                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Product with digital elements (hardware or software)                                                      | ☐ Yes ☐ No                                   |
| Placed or made available on EU market                                                                     | ☐ Yes ☐ No                                   |
| Excluded category (medical devices, aviation, automotive, marine, civil aviation regulated by sector law) | ☐ Yes ☐ No — if yes, check sector regulation |

**CRA In Scope**: ☐ Yes ☐ No

### 1.2 Risk Classification

| Class                   | Annex              | Description                       | Examples                                                                                                                             | Conformity Route                          |
| ----------------------- | ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Default**             | —                  | All products not in Class I or II | Most software, consumer IoT                                                                                                          | Internal self-assessment                  |
| **Important (Class I)** | Annex III, Part I  | Higher cybersecurity risk         | Identity management software, browsers, password managers, VPNs, network monitoring, industrial control systems, smart home security | Self-assessment with harmonised standards |
| **Critical (Class II)** | Annex III, Part II | Highest cybersecurity risk        | HSMs, secure elements, smart meters, critical infrastructure components, industrial automation, card readers                         | Third-party assessment (notified body)    |

**Product Classification**: ☐ Default | ☐ Important (Class I) | ☐ Critical
(Class II)

### 1.3 Open Source Assessment

| Scenario                                      | CRA Applicability                                          |
| --------------------------------------------- | ---------------------------------------------------------- |
| Purely open source, no commercial activity    | Out of scope                                               |
| Open source with paid support/services        | In scope for supported product                             |
| Integrating open source in commercial product | In scope — manufacturer responsible for full product       |
| Open source foundation / steward              | Lighter obligations (security policies, CVE participation) |

**Open source scenario**: [Scenario] | **CRA applicability**: [Yes / No /
Partial]

## 2. Security Requirements by Design (Annex I, Part I)

| Requirement                            | Description                                                                      | Status | Gap | Remediation |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------ | --- | ----------- |
| No known exploitable vulnerabilities   | Place on market without known exploitable vulnerabilities                        | ☐      |     |             |
| Secure by default configuration        | Products delivered with secure default settings, no unnecessary features enabled | ☐      |     |             |
| Protection against unauthorised access | Authentication, access control, attack surface reduction                         | ☐      |     |             |
| Data confidentiality and integrity     | Encryption of data at rest and in transit                                        | ☐      |     |             |
| Minimal data collection                | Process only data strictly necessary for intended purpose                        | ☐      |     |             |
| Availability protection                | Measures against DoS attacks                                                     | ☐      |     |             |
| Limit attack surface                   | Disable unused interfaces; minimise exposed components                           | ☐      |     |             |
| Reduce exploitable vulnerabilities     | Least privilege, defence in depth, secure coding                                 | ☐      |     |             |
| Integrity monitoring                   | Verify integrity of software and data                                            | ☐      |     |             |
| Security audit logging                 | Log security-relevant events, tamper-resistant logs                              | ☐      |     |             |
| Secure update mechanism                | Signed updates, rollback capability                                              | ☐      |     |             |
| End-of-support transparency            | Communicate end-of-support date to users                                         | ☐      |     |             |

## 3. Vulnerability Management Requirements (Annex I, Part II)

| Requirement                           | Description                                                           | Status | Gap |
| ------------------------------------- | --------------------------------------------------------------------- | ------ | --- |
| Vulnerability disclosure policy (VDP) | Published, accessible VDP with contact mechanism                      | ☐      |     |
| SBOM (Software Bill of Materials)     | Machine-readable SBOM covering top-level dependencies (minimum)       | ☐      |     |
| CVE registry participation            | Register CVEs in MITRE/NVD for product vulnerabilities                | ☐      |     |
| Free security updates                 | Provide security updates throughout support lifetime at no extra cost | ☐      |     |
| Coordinated disclosure                | Responsibly disclose to national CSIRT and ENISA                      | ☐      |     |
| 24-hour incident reporting            | Report actively exploited vulnerabilities to ENISA and national CSIRT | ☐      |     |
| Documented support period             | End-of-life date communicated to users                                | ☐      |     |

### 3.1 SBOM Requirements

| SBOM Element                              | Status |
| ----------------------------------------- | ------ |
| Top-level component inventory             | ☐      |
| Machine-readable format (SPDX, CycloneDX) | ☐      |
| Dependency relationships documented       | ☐      |
| License information included              | ☐      |
| Known vulnerabilities linked (CVE IDs)    | ☐      |

## 4. Reporting Obligations

| Event                                         | Deadline                              | Recipient                            | Status |
| --------------------------------------------- | ------------------------------------- | ------------------------------------ | ------ |
| Awareness of actively exploited vulnerability | **24 hours** — early warning          | ENISA + national CSIRT (FR: CERT-FR) | ☐      |
| Incident with impact on security of product   | **24 hours** — early warning          | ENISA + national CSIRT               | ☐      |
| Full incident notification                    | **72 hours**                          | ENISA + national CSIRT               | ☐      |
| Final incident report                         | **14 days** after mitigation deployed | ENISA + national CSIRT               | ☐      |

**24-hour reporting capability in place**: ☐ Yes ☐ No

## 5. Conformity Assessment

### 5.1 Conformity Route

| Product Class                                      | Conformity Route            | Notified Body Required | Status |
| -------------------------------------------------- | --------------------------- | ---------------------- | ------ |
| Default                                            | Module A (internal control) | No                     | ☐      |
| Important (Class I) — with harmonised standards    | Module A with standards     | No                     | ☐      |
| Important (Class I) — without harmonised standards | Module B + C                | Yes                    | ☐      |
| Critical (Class II)                                | Module B + C or H           | Yes                    | ☐      |

### 5.2 Technical Documentation (Required Before Market Placement)

- [ ] Product description and intended use
- [ ] Design and manufacturing documentation
- [ ] Cybersecurity risk assessment
- [ ] SBOM
- [ ] Security testing results
- [ ] Vulnerability handling procedures
- [ ] EU Declaration of Conformity (Annex V)
- [ ] CE marking

### 5.3 CE Marking

| Requirement                                        | Status |
| -------------------------------------------------- | ------ |
| CE marking affixed to product                      | ☐      |
| EU Declaration of Conformity issued                | ☐      |
| Declaration references applicable CRA requirements | ☐      |
| Notified body (if required) certificate obtained   | ☐      |

## 6. French Market Surveillance

| Authority | Role                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------- |
| ANSSI     | Technical lead for cybersecurity aspects; designated market surveillance authority for CRA in France |
| DGCCRF    | General consumer protection market surveillance; coordination with ANSSI                             |
| CERT-FR   | Receives vulnerability and incident reports under CRA Articles 14–15                                 |

## 7. Gap Analysis and Timeline

| Requirement                           | Status | Gap Description | Remediation Action | CRA Deadline                   |
| ------------------------------------- | ------ | --------------- | ------------------ | ------------------------------ |
| Secure by default                     | ☐      | [Description]   | [Action]           | Dec 2027                       |
| SBOM generation                       | ☐      | [Description]   | [Action]           | Dec 2027                       |
| VDP published                         | ☐      | [Description]   | [Action]           | Dec 2027                       |
| 24h reporting capability              | ☐      | [Description]   | [Action]           | Dec 2027                       |
| Technical documentation               | ☐      | [Description]   | [Action]           | Dec 2027                       |
| CE marking process                    | ☐      | [Description]   | [Action]           | Dec 2027                       |
| Notified body engaged (if Class I/II) | ☐      | [Description]   | [Action]           | Sep 2026 (notification bodies) |

**Key CRA dates**:

- 11 September 2026: Notification body obligations apply
- 11 December 2027: Full CRA obligations apply

---

**Generated by**: ArcKit `/arckit:eu-cra` command **Generated on**: [YYYY-MM-DD]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-data-act-template.md -->

# EU Data Act Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-data-act`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                     | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-data-act` | [PENDING]   | [PENDING]     |

## Executive Summary

| Obligation Area                  | Status                            | Critical Gaps |
| -------------------------------- | --------------------------------- | ------------- |
| Role Determination               | [Classified]                      | —             |
| Connected Product Data Sharing   | [Compliant / Partial / Gap / N/A] | [Count]       |
| B2B Data Sharing                 | [Compliant / Partial / Gap / N/A] | [Count]       |
| Public Sector Exceptional Access | [Compliant / Partial / Gap / N/A] | [Count]       |
| Cloud Switching (DAPS)           | [Compliant / Partial / Gap / N/A] | [Count]       |
| Trade Secrets Protection         | [Compliant / Partial / Gap / N/A] | [Count]       |
| Interoperability                 | [Compliant / Partial / Gap / N/A] | [Count]       |

---

## 1. Role Determination and Scope

### 1.1 Role in the Data Value Chain

| Role                                    | Definition                                                        | Applicable |
| --------------------------------------- | ----------------------------------------------------------------- | ---------- |
| Manufacturer of a connected product     | Makes/imports product that generates data                         | ☐          |
| Provider of related service             | Provides digital service related to connected product             | ☐          |
| Data holder                             | Person/entity that has right or obligation to make data available | ☐          |
| Data recipient                          | Entity to whom data is made available                             | ☐          |
| Data processing service provider (DAPS) | IaaS, PaaS, SaaS, edge cloud provider                             | ☐          |
| Public sector body                      | Government / public body requesting emergency data access         | ☐          |

### 1.2 Connected Product Assessment

[Complete if manufacturing or selling connected products — IoT devices, smart
appliances, industrial machinery, vehicles, medical devices, etc.]

| Criterion                                                | Assessment |
| -------------------------------------------------------- | ---------- |
| Product generates data by virtue of its use              | ☐ Yes ☐ No |
| Data is collected by the manufacturer or related service | ☐ Yes ☐ No |
| Product placed on EU market                              | ☐ Yes ☐ No |

**Connected product in scope**: ☐ Yes ☐ No

## 2. User Data Access Rights (Chapter II, Articles 4–6)

[Complete if Manufacturer / Provider of related service / Data holder]

### 2.1 Access Rights for Users

| Obligation                                                          | Article   | Status | Gap |
| ------------------------------------------------------------------- | --------- | ------ | --- |
| Users informed before purchase of data generated by product         | Art. 3    | ☐      |     |
| Users can access data generated by their use in real time           | Art. 4    | ☐      |     |
| Data provided free of charge to users                               | Art. 4(1) | ☐      |     |
| Data provided in structured, commonly used, machine-readable format | Art. 4(1) | ☐      |     |
| Contact point established for data access requests                  | Art. 4(3) | ☐      |     |

### 2.2 Third-Party Sharing at User Request (Article 5)

| Obligation                                            | Status |
| ----------------------------------------------------- | ------ |
| User can instruct sharing with designated third party | ☐      |
| Data shared under same conditions as to the user      | ☐      |
| Sharing request fulfilled without undue delay         | ☐      |
| Trade secret protection mechanism in place            | ☐      |

## 3. B2B Data Sharing Obligations (Chapter III, Articles 8–12)

[Complete if Data holder obliged to share with data recipient]

| Obligation                                                       | Article   | Status |
| ---------------------------------------------------------------- | --------- | ------ |
| Data sharing agreement in place                                  | Art. 8    | ☐      |
| Data sharing terms fair, reasonable, non-discriminatory (FRAND)  | Art. 8(1) | ☐      |
| SME protection — compensation capped at cost of sharing          | Art. 9    | ☐      |
| Dispute resolution mechanism available                           | Art. 10   | ☐      |
| Trade secrets protected in shared data                           | Art. 12   | ☐      |
| Use restriction clauses: no re-identification, no use to compete | Art. 8(4) | ☐      |

## 4. Public Sector Exceptional Access (Chapter V, Articles 14–22)

[Complete if operating in sector with public interest data — emergency
situations]

| Situation                                                  | Article | Applicable | Status |
| ---------------------------------------------------------- | ------- | ---------- | ------ |
| Exceptional necessity (public emergency, natural disaster) | Art. 15 | ☐          |        |
| Specific real and immediate need (disaster response)       | Art. 15 | ☐          |        |
| Data cannot be obtained otherwise                          | Art. 15 | ☐          |        |

| Obligation for Data Holders                              | Status |
| -------------------------------------------------------- | ------ |
| Response to public sector request within reasonable time | ☐      |
| Provide data in machine-readable format                  | ☐      |
| Compensation at cost recovery only (no profit)           | ☐      |

## 5. Data Processing Service Switching (Chapter VI, Articles 23–31)

[Complete if operating cloud / data processing services (IaaS, PaaS, SaaS,
edge)]

### 5.1 Switching Obligations (DAPS)

| Obligation                                              | Article | Status | Gap |
| ------------------------------------------------------- | ------- | ------ | --- |
| Switching process (from one DAPS to equivalent) enabled | Art. 23 | ☐      |     |
| Maximum 30-day notice for switching initiation          | Art. 25 | ☐      |     |
| Switching completed within maximum 180 days             | Art. 25 | ☐      |     |
| No financial/technical barriers to switching            | Art. 25 | ☐      |     |
| Customer data exported in interoperable format          | Art. 26 | ☐      |     |
| Egress charges eliminated by September 2027             | Art. 29 | ☐      |     |

### 5.2 Functional Equivalence

| Requirement                                                      | Status |
| ---------------------------------------------------------------- | ------ |
| Register of services published with interoperability information | ☐      |
| Technical means to export data documented                        | ☐      |

## 6. International Data Transfer Restrictions (Article 27)

| Obligation                                                                 | Status |
| -------------------------------------------------------------------------- | ------ |
| Non-EU government access without lawful EU/member state basis prohibited   | ☐      |
| Technical, organisational, and legal measures to prevent unlawful transfer | ☐      |
| Unlawful transfer requests contested (with authority notification)         | ☐      |

> **Context**: The Data Act restricts cloud providers from providing non-EU
> government authorities access to EU data (analogous to SecNumCloud and DINUM
> cloud doctrine in France). This complements GDPR Chapter V transfer
> restrictions.

## 7. Interoperability Requirements (Chapter VII, Articles 33–38)

| Obligation                                                                | Article | Status |
| ------------------------------------------------------------------------- | ------- | ------ |
| Open interoperability specifications for data exchange                    | Art. 33 | ☐      |
| Smart contracts — essential requirements met                              | Art. 36 | ☐      |
| Automated data sharing through smart contracts enabled (where applicable) | Art. 37 | ☐      |

## 8. Trade Secret Protection (Articles 4(6)–(9), 5(9)–(11) and 8(6))

| Safeguard                                                                     | Status |
| ----------------------------------------------------------------------------- | ------ |
| Data holder may refuse sharing if trade secret at risk (with justification)   | ☐      |
| Confidentiality agreement required of data recipients before access           | ☐      |
| Technical and organisational measures to protect trade secrets in shared data | ☐      |
| Process to identify and flag trade secrets in data sets                       | ☐      |

## 9. Gap Analysis and Action Plan

| Gap               | Article   | Priority | Owner  | Data Act Deadline |
| ----------------- | --------- | -------- | ------ | ----------------- |
| [Gap description] | [Art. XX] | 🔴 High  | [Role] | [Date]            |

**Key Data Act dates**:

- 12 September 2025: Most Data Act obligations apply
- 12 September 2027: Egress charge elimination for switching

---

**Generated by**: ArcKit `/arckit:eu-data-act` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-dora-template.md -->

# DORA Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-dora`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                 | Approved By | Approval Date |
| --------- | ------------ | --------- | --------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-dora` | [PENDING]   | [PENDING]     |

## Executive Summary

| Pillar                         | Current Maturity (L1–L5) | Required | Gap           | Priority |
| ------------------------------ | ------------------------ | -------- | ------------- | -------- |
| ICT Risk Management            | [L1–L5]                  | L3+      | [Description] | 🔴/🟠/🟡 |
| Incident Reporting (4h/72h/1m) | [L1–L5]                  | L4       | [Description] | 🔴       |
| Resilience Testing             | [L1–L5]                  | L3       | [Description] | 🟠       |
| Third-Party Management         | [L1–L5]                  | L3+      | [Description] | 🔴       |
| Concentration Risk             | [L1–L5]                  | L2       | [Description] | 🟠       |

Maturity scale: L1 = Initial / L2 = Developing / L3 = Defined / L4 = Managed /
L5 = Optimising

---

## 1. Entity Scoping (Article 2)

### 1.1 In-Scope Entity Types

| Entity Type                                | In Scope | Supervisory Authority (FR) |
| ------------------------------------------ | -------- | -------------------------- |
| Credit institutions                        | ☐        | ACPR                       |
| Payment institutions                       | ☐        | ACPR                       |
| Electronic money institutions              | ☐        | ACPR                       |
| Investment firms                           | ☐        | AMF / ACPR                 |
| Crypto-asset service providers (MiCA)      | ☐        | AMF                        |
| Insurance undertakings                     | ☐        | ACPR                       |
| Insurance intermediaries (> 250 employees) | ☐        | ACPR                       |
| Pension funds (> 15 members)               | ☐        | ACPR                       |
| Central counterparties (CCPs)              | ☐        | AMF                        |
| Trading venues                             | ☐        | AMF                        |
| ICT third-party service providers          | ☐        | ESA-designated oversight   |
| Credit rating agencies                     | ☐        | ESMA                       |

### 1.2 Proportionality

| Criterion                                           | Assessment                          |
| --------------------------------------------------- | ----------------------------------- |
| Microenterprise (< 10 employees, < €2M turnover)    | ☐ Yes — simplified regime may apply |
| Simplified ICT risk framework eligible (Article 16) | ☐ Yes ☐ No                          |

## 2. ICT Risk Management Framework (Articles 5–16)

| Requirement                                             | Article   | Status | Gap |
| ------------------------------------------------------- | --------- | ------ | --- |
| ICT risk management framework documented and maintained | Art. 5    | ☐      |     |
| Management body accountability for ICT risk             | Art. 5(2) | ☐      |     |
| ICT risk tolerance statement defined                    | Art. 6(8) | ☐      |     |
| Asset identification and classification                 | Art. 8    | ☐      |     |
| Protection and prevention measures                      | Art. 9    | ☐      |     |
| Detection mechanisms                                    | Art. 10   | ☐      |     |
| Response and recovery plans                             | Art. 11   | ☐      |     |
| Backup policies and recovery procedures                 | Art. 12   | ☐      |     |
| Communication plan for ICT incidents                    | Art. 14   | ☐      |     |
| Learning and evolving — post-incident review            | Art. 15   | ☐      |     |

## 3. ICT-Related Incident Management (Articles 17–23)

### 3.1 Incident Classification

| Criterion                   | Major Incident Threshold      |
| --------------------------- | ----------------------------- |
| Clients affected            | [Number or % of client base]  |
| Transaction volume affected | [Volume and value]            |
| Duration                    | [Hours of unavailability]     |
| Reputational impact         | [Media, regulatory attention] |
| Geographical spread         | [Single / multi-member state] |
| Economic impact             | [Amount or % of capital]      |

**Incident classification procedure in place**: ☐ Yes ☐ No

### 3.2 Reporting Timeline (Major ICT Incidents)

| Report               | Deadline                                                            | Recipient  | Content                                                    |
| -------------------- | ------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| Initial notification | **4 hours** after classification as major (max 24h after detection) | ACPR / AMF | Incident summary, impact assessment                        |
| Intermediate report  | **72 hours** after initial notification                             | ACPR / AMF | Updated details, preliminary root cause                    |
| Final report         | **1 month** after resolution                                        | ACPR / AMF | Full root cause, impact, cross-border effects, remediation |

### 3.3 Reporting Readiness

| Capability                                        | Status |
| ------------------------------------------------- | ------ |
| Major incident classification criteria documented | ☐      |
| 4-hour reporting capability established           | ☐      |
| ACPR/AMF reporting portal registered              | ☐      |
| Incident response team identified                 | ☐      |
| Voluntary cyber threat reporting process defined  | ☐      |

## 4. Digital Operational Resilience Testing (Articles 24–27)

| Testing Type                          | Frequency         | Scope                                        | Status |
| ------------------------------------- | ----------------- | -------------------------------------------- | ------ |
| Vulnerability assessment              | Annual            | All in-scope ICT systems                     | ☐      |
| Open-source analysis                  | Annual            | Software components                          | ☐      |
| Network security assessment           | Annual            | Network infrastructure                       | ☐      |
| Gap analysis                          | Annual            | Controls vs requirements                     | ☐      |
| Source code review (where applicable) | Annual            | Critical applications                        | ☐      |
| Scenario-based tests                  | Annual            | Business continuity scenarios                | ☐      |
| TLPT (Threat-Led Penetration Testing) | Every **3 years** | Critical systems (significant entities only) | ☐      |

### 4.1 TLPT Requirements (Article 26) — Significant Entities Only

| Requirement                             | Status |
| --------------------------------------- | ------ |
| Based on TIBER-EU framework             | ☐      |
| Certified external testers engaged      | ☐      |
| Scope defined with competent authority  | ☐      |
| Results shared with competent authority | ☐      |
| Remediation plan prepared and executed  | ☐      |

## 5. ICT Third-Party Risk Management (Articles 28–44)

### 5.1 Register of ICT Arrangements (Article 28)

| Provider         | Service          | Criticality               | Contractual Requirements Met | Last Review |
| ---------------- | ---------------- | ------------------------- | ---------------------------- | ----------- |
| [Cloud provider] | [IaaS/PaaS/SaaS] | ☐ Critical ☐ Non-critical | ☐                            | [Date]      |
| [SaaS provider]  | [Core system]    | ☐ Critical ☐ Non-critical | ☐                            | [Date]      |

### 5.2 Mandatory Contract Provisions (Article 30)

All ICT contracts must include:

- [ ] Service level descriptions with quantitative/qualitative performance
      targets
- [ ] Notice periods and reporting obligations to financial entity
- [ ] Data processing location (country/region)
- [ ] Cooperation with supervisory authorities
- [ ] Termination rights (including orderly exit)
- [ ] Audit rights and right of access (including sub-contractor audits)
- [ ] Business continuity provisions

### 5.3 Critical ITPP Oversight (Article 31+)

If using a provider designated as **critical ICT third-party provider** (CITPP)
by ESAs:

- [ ] Enhanced contractual requirements applied
- [ ] Lead overseer cooperation established
- [ ] Participation in ESA oversight activities committed

### 5.4 Concentration Risk (Article 29)

| Requirement                                                            | Status |
| ---------------------------------------------------------------------- | ------ |
| ICT concentration risk assessed                                        | ☐      |
| Over-reliance on single provider identified and managed                | ☐      |
| Multi-cloud or multi-provider strategy documented (if risk identified) | ☐      |
| Exit strategy documented for each critical provider                    | ☐      |

## 6. French Supervisory Authority Context

| Authority        | Role                                              | DORA Powers                                                                                    |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ACPR             | Supervises banks, insurance, payment institutions | Incident notification recipient; resilience testing oversight; ICT third-party register access |
| AMF              | Supervises investment firms, CCPs, trading venues | Same as ACPR for in-scope entities                                                             |
| Banque de France | Central bank; systemic risk coordination          | Coordination with ACPR; systemic risk monitoring                                               |
| ANSSI            | National cybersecurity authority                  | Technical input on incidents; SecNumCloud guidance for cloud providers                         |

### 6.1 ACPR DORA Implementation Notes

- [ ] ACPR DORA circulaires reviewed
- [ ] Pre-DORA ACPR ICT/cloud requirements supersession confirmed
- [ ] French transposition specifics assessed

## 7. Gap Analysis and Roadmap

| Pillar                 | Gap Description | Priority  | Owner  | Deadline |
| ---------------------- | --------------- | --------- | ------ | -------- |
| ICT Risk Management    | [Gap]           | 🔴 High   | [Role] | [Date]   |
| Incident Reporting     | [Gap]           | 🔴 High   | [Role] | [Date]   |
| Resilience Testing     | [Gap]           | 🟠 Medium | [Role] | [Date]   |
| Third-Party Management | [Gap]           | 🔴 High   | [Role] | [Date]   |
| Concentration Risk     | [Gap]           | 🟠 Medium | [Role] | [Date]   |

---

**Generated by**: ArcKit `/arckit:eu-dora` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-dsa-template.md -->

# EU Digital Services Act Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-dsa`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                | Approved By | Approval Date |
| --------- | ------------ | --------- | -------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-dsa` | [PENDING]   | [PENDING]     |

## Executive Summary

| Obligation Area              | Status                      | Critical Gaps |
| ---------------------------- | --------------------------- | ------------- |
| Provider Classification      | [Classified]                | —             |
| Transparency Reporting       | [Compliant / Partial / Gap] | [Count]       |
| Content Moderation           | [Compliant / Partial / Gap] | [Count]       |
| Algorithmic Transparency     | [Compliant / Partial / Gap] | [Count]       |
| Risk Assessment (VLOP/VLOSE) | [Compliant / Partial / N/A] | [Count]       |
| Data Access for Researchers  | [Compliant / Partial / N/A] | [Count]       |

---

## 1. Provider Classification (Article 2 and Chapter III)

### 1.1 Service Type Determination

| Service Type                            | Definition                                              | Applicable |
| --------------------------------------- | ------------------------------------------------------- | ---------- |
| Mere conduit                            | Network access or transmission                          | ☐          |
| Caching                                 | Automatic, intermediate, temporary storage              | ☐          |
| Hosting                                 | Storage of information provided by recipients           | ☐          |
| Online platform                         | Hosting + dissemination to the public (not micro/small) | ☐          |
| Very Large Online Platform (VLOP)       | Online platform with ≥ 45M average monthly EU users     | ☐          |
| Very Large Online Search Engine (VLOSE) | Search engine with ≥ 45M average monthly EU users       | ☐          |

**Classification**: [Service type]

### 1.2 Size Thresholds

| Threshold                | Value                                 | This Provider                      |
| ------------------------ | ------------------------------------- | ---------------------------------- |
| Micro/small enterprise   | < 50 employees and < €10M turnover    | ☐ (exempted from some obligations) |
| Standard online platform | ≥ 50 employees or ≥ €10M turnover     | ☐                                  |
| VLOP / VLOSE             | ≥ 45M average monthly EU active users | ☐                                  |

> **Note**: Micro and small enterprises are exempt from certain obligations
> (e.g., online dispute settlement, statement of reasons for content
> moderation). Commission publishes formal VLOP/VLOSE designations.

### 1.3 Designated VLOP/VLOSE Status

| Provider      | Designated | Designation Date |
| ------------- | ---------- | ---------------- |
| This provider | ☐ Yes ☐ No | [If yes: date]   |

Formally designated VLOPs/VLOSEs are supervised directly by the European
Commission.

## 2. General Obligations — All Intermediary Services (Chapter II)

| Obligation                                     | Article   | Status | Gap |
| ---------------------------------------------- | --------- | ------ | --- |
| Transparency reports published                 | Art. 15   | ☐      |     |
| Complaints-handling mechanism                  | Art. 20   | ☐      |     |
| Out-of-court dispute settlement                | Art. 21   | ☐      |     |
| Cooperation with authorities upon lawful order | Art. 9-10 | ☐      |     |
| Single point of contact designated             | Art. 11   | ☐      |     |
| Legal representative designated (if non-EU)    | Art. 13   | ☐      |     |
| Terms of service clear and accessible          | Art. 14   | ☐      |     |

## 3. Hosting Provider Obligations (Article 16)

[Complete if provider stores content on behalf of users]

| Obligation                                                    | Status |
| ------------------------------------------------------------- | ------ |
| Notice and action mechanism in place (report illegal content) | ☐      |
| Illegal content reports acknowledged and processed            | ☐      |
| Reporters notified of decisions                               | ☐      |
| Illegal content flagged to law enforcement if serious crime   | ☐      |

## 4. Online Platform Obligations (Articles 17–28)

[Complete if classified as online platform — not micro/small enterprise]

### 4.1 Content Moderation Transparency

| Obligation                                             | Article | Status |
| ------------------------------------------------------ | ------- | ------ |
| Terms of service restrictions clearly stated           | Art. 14 | ☐      |
| Statement of reasons provided for content restrictions | Art. 17 | ☐      |
| Internal complaint-handling system                     | Art. 20 | ☐      |
| Out-of-court dispute settlement                        | Art. 21 | ☐      |
| Trusted flaggers programme                             | Art. 22 | ☐      |
| Repeat infringer policy documented                     | Art. 23 | ☐      |
| Dark patterns prohibited                               | Art. 25 | ☐      |
| Advertising transparency — no profiling of minors      | Art. 26 | ☐      |
| Recommender systems transparency                       | Art. 27 | ☐      |

### 4.2 Recommender Systems (Article 27)

| Requirement                                        | Status |
| -------------------------------------------------- | ------ |
| Recommender systems disclosed in terms of service  | ☐      |
| Main parameters explained to users                 | ☐      |
| At least one option not based on profiling offered | ☐      |

## 5. VLOP / VLOSE Additional Obligations (Chapter IV, Articles 33–43)

[Complete only if designated VLOP or VLOSE by the Commission]

### 5.1 Annual Risk Assessment (Article 34)

| Systemic Risk Area                                           | Assessment Required | Status |
| ------------------------------------------------------------ | ------------------- | ------ |
| Dissemination of illegal content                             | ☐                   |        |
| Actual or foreseeable negative effects on fundamental rights | ☐                   |        |
| Civic discourse and electoral processes                      | ☐                   |        |
| Public security                                              | ☐                   |        |
| Gender-based violence / protection of minors                 | ☐                   |        |

### 5.2 Risk Mitigation Measures (Article 35)

| Measure                                           | Status |
| ------------------------------------------------- | ------ |
| Adapting content moderation systems               | ☐      |
| Adapting recommender systems                      | ☐      |
| Adapting advertising systems                      | ☐      |
| Reinforcing internal processes (crisis protocols) | ☐      |
| Cooperation with trusted flaggers                 | ☐      |

### 5.3 Independent Audit (Article 37)

| Requirement                                           | Status |
| ----------------------------------------------------- | ------ |
| Annual independent audit conducted                    | ☐      |
| Audit report shared with Digital Services Coordinator | ☐      |
| Audit methodology: ISAE 3000 or equivalent            | ☐      |

### 5.4 Algorithmic Transparency (Article 40)

| Requirement                                              | Status |
| -------------------------------------------------------- | ------ |
| Access to recommender system data granted to researchers | ☐      |
| Compliance repository publicly accessible                | ☐      |
| Non-profiling option for recommender systems             | ☐      |

### 5.5 Data Access for Researchers (Article 40)

| Requirement                                    | Status |
| ---------------------------------------------- | ------ |
| Vetted researcher access mechanism established | ☐      |
| Data access protocol documented                | ☐      |
| Privacy-preserving data access implemented     | ☐      |

## 6. French Digital Services Coordinator — ARCOM

| Aspect              | Detail                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| DSC for France      | ARCOM (Autorité de régulation de la communication audiovisuelle et numérique) |
| ARCOM role          | Supervises non-VLOP/VLOSE online platforms established in France              |
| Complaint mechanism | Recipients of French services can complain to ARCOM                           |
| Enforcement         | ARCOM can impose fines up to 6% of global annual turnover                     |
| Cooperation         | ARCOM participates in European Board for Digital Services                     |

## 7. Gap Analysis and Action Plan

| Gap               | Article   | Priority | Owner  | Deadline |
| ----------------- | --------- | -------- | ------ | -------- |
| [Gap description] | [Art. XX] | 🔴 High  | [Role] | [Date]   |

---

**Generated by**: ArcKit `/arckit:eu-dsa` command **Generated on**: [YYYY-MM-DD]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-nis2-template.md -->

# NIS2 Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-nis2`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                 | Approved By | Approval Date |
| --------- | ------------ | --------- | --------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-nis2` | [PENDING]   | [PENDING]     |

## Executive Summary

| Pillar              | Status                                 | Critical Gaps |
| ------------------- | -------------------------------------- | ------------- |
| Entity Scoping      | [Essential / Important / Out of scope] | [Count]       |
| Governance          | [Compliant / Partial / Gap]            | [Count]       |
| Risk Management     | [Compliant / Partial / Gap]            | [Count]       |
| Incident Reporting  | [Compliant / Partial / Gap]            | [Count]       |
| Supply Chain        | [Compliant / Partial / Gap]            | [Count]       |
| Business Continuity | [Compliant / Partial / Gap]            | [Count]       |

---

## 1. Entity Scoping

### 1.1 Sector Classification (Annex I — Essential / Annex II — Important)

| Sector                                                  | Sub-sector                                    | Annex | Applicable |
| ------------------------------------------------------- | --------------------------------------------- | ----- | ---------- |
| Energy                                                  | Electricity, gas, oil, hydrogen               | I     | ☐          |
| Transport                                               | Air, rail, water, road                        | I     | ☐          |
| Banking                                                 | Credit institutions                           | I     | ☐          |
| Financial market infrastructure                         | Trading venues, CCPs                          | I     | ☐          |
| Health                                                  | Healthcare providers, EU reference labs       | I     | ☐          |
| Drinking water                                          | —                                             | I     | ☐          |
| Wastewater                                              | —                                             | I     | ☐          |
| Digital infrastructure                                  | IXPs, DNS, TLD, cloud, CDN, datacentres       | I     | ☐          |
| ICT service management (B2B)                            | Managed service providers                     | I     | ☐          |
| Public administration                                   | Central / regional government                 | I     | ☐          |
| Space                                                   | —                                             | I     | ☐          |
| Postal and courier                                      | —                                             | II    | ☐          |
| Waste management                                        | —                                             | II    | ☐          |
| Chemicals                                               | —                                             | II    | ☐          |
| Food                                                    | —                                             | II    | ☐          |
| Manufacturing (medical, computers, transport equipment) | —                                             | II    | ☐          |
| Digital providers                                       | Marketplaces, search engines, social networks | II    | ☐          |
| Research                                                | —                                             | II    | ☐          |

### 1.2 Size Thresholds

| Criterion                               | Essential Entity | Important Entity |
| --------------------------------------- | ---------------- | ---------------- |
| Employees                               | > 250            | 50–250           |
| Annual turnover                         | > €50M           | €10–50M          |
| Balance sheet                           | > €43M           | €10–43M          |
| Or: Critical infrastructure designation | —                | —                |

**Entity classification**: ☐ Essential Entity | ☐ Important Entity | ☐ Out of
scope

### 1.3 National Competent Authority

| Member State | NIS2 Authority    | Contact                 |
| ------------ | ----------------- | ----------------------- |
| France       | ANSSI             | cert.fr / anssi.gouv.fr |
| Germany      | BSI               | bsi.bund.de             |
| Netherlands  | NCSC-NL           | ncsc.nl                 |
| Spain        | CCN-CERT / INCIBE | ccn-cert.cni.es         |
| Italy        | ACN               | acn.gov.it              |
| Belgium      | CCB               | ccb.belgium.be          |
| [Other]      | [Authority]       | [URL]                   |

**Applicable authority**: [Name]

## 2. Governance Obligations (Article 20)

| Requirement                                                     | Status | Evidence |
| --------------------------------------------------------------- | ------ | -------- |
| Management body approves cybersecurity risk management measures | ☐      |          |
| Management body oversees implementation                         | ☐      |          |
| Management body members trained in cybersecurity                | ☐      |          |
| Management body personally liable for compliance                | ☐      |          |

## 3. Risk Management Measures (Article 21)

### 3.1 Minimum Security Measures

| Measure                                                          | Article 21(2) | Status | Gap |
| ---------------------------------------------------------------- | ------------- | ------ | --- |
| Policies on risk analysis and IS security                        | (a)           | ☐      |     |
| Incident handling                                                | (b)           | ☐      |     |
| Business continuity and crisis management                        | (c)           | ☐      |     |
| Supply chain security (ICT suppliers)                            | (d)           | ☐      |     |
| Security in network and IS acquisition, development, maintenance | (e)           | ☐      |     |
| Policies and procedures for effectiveness assessment             | (f)           | ☐      |     |
| Basic cyber hygiene and training                                 | (g)           | ☐      |     |
| Cryptography and encryption policies                             | (h)           | ☐      |     |
| HR security, access control, asset management                    | (i)           | ☐      |     |
| Multi-factor authentication (MFA)                                | (j)           | ☐      |     |
| Secure communications (voice, video, text)                       | (j)           | ☐      |     |
| Secure emergency communication systems                           | (j)           | ☐      |     |

### 3.2 Proportionality Assessment

| Factor                         | Assessment               |
| ------------------------------ | ------------------------ |
| Entity size                    | [Large / Medium / Small] |
| Risk exposure                  | [High / Medium / Low]    |
| Measures proportionate to risk | ☐ Yes ☐ No               |
| All-hazards approach applied   | ☐ Yes ☐ No               |

## 4. Incident Reporting (Articles 23–24)

### 4.1 Significant Incident Definition

An incident is **significant** if it causes or could cause:

- Severe operational disruption or financial loss
- Impact on other natural or legal persons (physical, material, or non-material
  damage)

### 4.2 Reporting Timeline

| Report                                                          | Deadline                                                                                                      | Recipient                            | Content                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| Early warning                                                   | **24 hours** from awareness                                                                                   | National CSIRT + Competent Authority | Incident occurred, possibly malicious, possibly cross-border                 |
| Incident notification                                           | **72 hours** from awareness                                                                                   | National CSIRT + Competent Authority | Initial assessment, severity, indicators of compromise                       |
| Intermediate report (if requested)                              | On request                                                                                                    | Authority                            | Status update                                                                |
| Final report                                                    | No later than **one month** after the incident notification (Art. 23(4)(d))                                   | National CSIRT + Competent Authority | Full description, type, root cause, applied mitigations, cross-border impact |
| Progress report (incident ongoing at the final-report deadline) | At the final-report deadline; final report within **one month** of the incident being handled (Art. 23(4)(e)) | National CSIRT + Competent Authority | Status and mitigation to date                                                |

### 4.3 Reporting Readiness

| Capability                                   | Status |
| -------------------------------------------- | ------ |
| 24-hour reporting capability established     | ☐      |
| CSIRT contact details known                  | ☐      |
| Incident classification procedure documented | ☐      |
| Reporting templates prepared                 | ☐      |
| Crisis communication plan in place           | ☐      |

## 5. Supply Chain Security (Article 21(2)(d) + Article 22)

| Requirement                                               | Status | Notes |
| --------------------------------------------------------- | ------ | ----- |
| ICT supplier inventory maintained                         | ☐      |       |
| Supplier cybersecurity clauses in contracts               | ☐      |       |
| Critical supplier risk assessments conducted              | ☐      |       |
| ENISA ICT supply chain risk framework applied             | ☐      |       |
| EU coordinated risk assessment outcomes reviewed          | ☐      |       |
| 5G network equipment restrictions applied (if applicable) | ☐      |       |

## 6. Business Continuity (Article 21(2)(c))

| Requirement                              | Status |
| ---------------------------------------- | ------ |
| Business continuity plan documented      | ☐      |
| Backup and restoration procedures tested | ☐      |
| Crisis management procedures defined     | ☐      |
| Recovery time objectives (RTO) defined   | ☐      |
| Recovery point objectives (RPO) defined  | ☐      |

## 7. Member State Specifics

### 7.1 France (ANSSI)

[Complete if operating under French jurisdiction]

| Requirement                                          | Status |
| ---------------------------------------------------- | ------ |
| ANSSI sector-specific requirements (OIV/OSE) applied | ☐      |
| CERT-FR incident notification portal registered      | ☐      |
| LPM Article 22 obligations assessed (if OIV)         | ☐      |
| ANSSI SecNumCloud evaluated for cloud services       | ☐      |

### 7.2 Other Member States

[Add sections for each relevant jurisdiction]

## 8. Gap Analysis and Roadmap

| Gap               | Article   | Priority | Owner  | Deadline |
| ----------------- | --------- | -------- | ------ | -------- |
| [Gap description] | [Art. XX] | 🔴 High  | [Role] | [Date]   |

---

**Generated by**: ArcKit `/arckit:eu-nis2` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: eu-rgpd-template.md -->

# GDPR Compliance Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:eu-rgpd`
>
> ⚠️ **Community-contributed** — not yet validated against current ANSSI/CNIL/EU
> regulatory text. Verify all citations before relying on output.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                 | Approved By | Approval Date |
| --------- | ------------ | --------- | --------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:eu-rgpd` | [PENDING]   | [PENDING]     |

## Executive Summary

| Area                    | Status                                | Key Findings |
| ----------------------- | ------------------------------------- | ------------ |
| Lawful Basis            | [Established / Partial / Gap]         | [Summary]    |
| Data Subject Rights     | [Implemented / Partial / Gap]         | [Summary]    |
| International Transfers | [Compliant / Partial / Gap]           | [Summary]    |
| DPIA Requirement        | [Required / Not required / Conducted] | [Summary]    |
| DPO                     | [Designated / Not required / Gap]     | [Summary]    |
| Breach Notification     | [Process in place / Gap]              | [Summary]    |

---

## 1. Scope and Role Determination

### 1.1 Role of the Organisation

| Role                 | Definition                                                | Applicable |
| -------------------- | --------------------------------------------------------- | ---------- |
| **Data Controller**  | Determines purposes and means of processing               | ☐          |
| **Data Processor**   | Processes on behalf of a controller                       | ☐          |
| **Joint Controller** | Jointly determines purposes and means with another entity | ☐          |
| **Sub-processor**    | Engaged by a processor                                    | ☐          |

### 1.2 Data Categories Processed

| Data Category                      | GDPR Reference | Present in System | Lawful Basis                |
| ---------------------------------- | -------------- | ----------------- | --------------------------- |
| Standard personal data             | Art. 6         | ☐                 | [Article 6(1)(?) basis]     |
| Special category data              | Art. 9         | ☐                 | [Article 9(2)(?) condition] |
| — Health data                      | Art. 9(1)      | ☐                 |                             |
| — Biometric data (for ID purposes) | Art. 9(1)      | ☐                 |                             |
| — Genetic data                     | Art. 9(1)      | ☐                 |                             |
| — Racial/ethnic origin             | Art. 9(1)      | ☐                 |                             |
| — Political opinions               | Art. 9(1)      | ☐                 |                             |
| — Religious/philosophical beliefs  | Art. 9(1)      | ☐                 |                             |
| — Trade union membership           | Art. 9(1)      | ☐                 |                             |
| — Sexual orientation/sex life      | Art. 9(1)      | ☐                 |                             |
| Criminal conviction data           | Art. 10        | ☐                 |                             |

## 2. Lawful Basis Assessment

### 2.1 Article 6 Basis Mapping (Standard Personal Data)

| Processing Activity | Data Subjects | Lawful Basis (Art. 6(1)) | Rationale     |
| ------------------- | ------------- | ------------------------ | ------------- |
| [Activity 1]        | [Category]    | [a/b/c/d/e/f]            | [Explanation] |
| [Activity 2]        | [Category]    | [a/b/c/d/e/f]            | [Explanation] |

Lawful basis codes: (a) Consent | (b) Contract | (c) Legal obligation | (d)
Vital interests | (e) Public task | (f) Legitimate interests

### 2.2 Article 9 Conditions (Special Category Data)

| Processing Activity | Special Category | Article 9(2) Condition | Safeguards            |
| ------------------- | ---------------- | ---------------------- | --------------------- |
| [Activity]          | [Category]       | [Condition letter]     | [Safeguards in place] |

### 2.3 Consent Management (if applicable)

| Requirement                                           | Status |
| ----------------------------------------------------- | ------ |
| Consent freely given, specific, informed, unambiguous | ☐      |
| Withdrawal as easy as giving                          | ☐      |
| Consent records maintained                            | ☐      |
| Consent age-appropriate (member state minimum)        | ☐      |
| Consent not bundled with unrelated conditions         | ☐      |

## 3. Privacy by Design and Default (Article 25)

| Principle                                                    | Implementation | Status |
| ------------------------------------------------------------ | -------------- | ------ |
| Data minimisation — collect only what is necessary           | [Description]  | ☐      |
| Purpose limitation — use only for stated purposes            | [Description]  | ☐      |
| Storage limitation — retain only as long as necessary        | [Description]  | ☐      |
| Pseudonymisation applied where possible                      | [Description]  | ☐      |
| Privacy-friendly defaults (most private settings by default) | [Description]  | ☐      |
| Data protection integrated in system design                  | [Description]  | ☐      |

## 4. Data Subject Rights (Articles 15–22)

| Right                          | Article | Mechanism Implemented | Response Time         | Status |
| ------------------------------ | ------- | --------------------- | --------------------- | ------ |
| Right of access (SAR)          | 15      | [Description]         | 1 month               | ☐      |
| Right to rectification         | 16      | [Description]         | 1 month               | ☐      |
| Right to erasure               | 17      | [Description]         | 1 month               | ☐      |
| Right to restriction           | 18      | [Description]         | Notify before lifting | ☐      |
| Right to portability           | 20      | [Description]         | 1 month               | ☐      |
| Right to object                | 21      | [Description]         | Immediately           | ☐      |
| Rights re: automated decisions | 22      | [Description]         | —                     | ☐      |

## 5. Records of Processing Activities (Article 30)

| Requirement                                        | Status |
| -------------------------------------------------- | ------ |
| RoPA (Record of Processing Activities) maintained  | ☐      |
| RoPA includes all mandatory fields (Art. 30)       | ☐      |
| RoPA kept up to date                               | ☐      |
| RoPA available to supervisory authority on request | ☐      |

**RoPA location**: [File path / system name]

## 6. Data Protection Impact Assessment (Article 35)

### 6.1 DPIA Triggers

| Trigger                                                     | Present | Assessment |
| ----------------------------------------------------------- | ------- | ---------- |
| Systematic and extensive profiling with significant effects | ☐       |            |
| Large-scale processing of special category data             | ☐       |            |
| Systematic monitoring of public areas                       | ☐       |            |
| Other high-risk processing (EDPB list)                      | ☐       |            |

**DPIA Required**: ☐ Yes ☐ No

### 6.2 DPIA Status

| DPIA                  | Conducted | Date   | Outcome   |
| --------------------- | --------- | ------ | --------- |
| [Processing activity] | ☐         | [Date] | [Summary] |

## 7. Data Processors and Sub-Processors (Article 28)

| Processor  | Service   | DPA in Place | Binding Commitments | Review Date |
| ---------- | --------- | ------------ | ------------------- | ----------- |
| [Provider] | [Service] | ☐            | ☐                   | [Date]      |

Data Processing Agreement (DPA) must include:

- [ ] Processing only on controller's instructions
- [ ] Confidentiality obligations on authorised persons
- [ ] Appropriate security measures (Article 32)
- [ ] Sub-processor controls and notification
- [ ] Assistance with data subject rights
- [ ] Deletion/return on contract end
- [ ] Audit cooperation

## 8. International Transfers (Articles 44–49)

| Transfer    | Destination Country | Adequacy Decision | Safeguard                        | Transfer Impact Assessment | Status |
| ----------- | ------------------- | ----------------- | -------------------------------- | -------------------------- | ------ |
| [Data type] | [Country]           | ☐ Yes ☐ No        | [SCC / BCR / Art. 49 derogation] | ☐ Conducted                | ☐      |

## 9. Breach Notification (Articles 33–34)

| Requirement                                  | Deadline            | Recipient            | Status |
| -------------------------------------------- | ------------------- | -------------------- | ------ |
| Notification to supervisory authority        | **72 hours**        | Lead DPA             | ☐      |
| Notification to data subjects (if high risk) | Without undue delay | Affected individuals | ☐      |
| Breach documented in internal register       | Ongoing             | Internal             | ☐      |

**Breach notification process in place**: ☐ Yes ☐ No

## 10. National Supervisory Authority Context

| Member State | Supervisory Authority | National Specificities                                                                          |
| ------------ | --------------------- | ----------------------------------------------------------------------------------------------- |
| France       | CNIL                  | Age of consent: 15; digital legacy rights; Délibération cookies 2020-091. See `/arckit:fr-rgpd` |
| Germany      | BfDI + 16 Länder DPAs | Federal structure; stricter employee data rules                                                 |
| Netherlands  | AP                    | Strict enforcement on cookies and scoping                                                       |
| Spain        | AGPD                  | Specific requirements for public sector                                                         |
| Italy        | Garante               | Additional provisions on profiling                                                              |
| Belgium      | APD                   | Enforcement on legitimate interests                                                             |
| Ireland      | DPC                   | Lead DPA for major tech companies                                                               |
| Sweden       | IMY                   | Strong anonymisation requirements                                                               |
| [Other]      | [Authority]           | [Specificities]                                                                                 |

> **Note**: For French deployments, run `/arckit:fr-rgpd` to cover CNIL-specific
> obligations (cookies guidelines, HDS, DPO registration, post-mortem rights).

## 11. Gap Analysis and Action Plan

| Gap               | Reference      | Priority | Owner  | Deadline |
| ----------------- | -------------- | -------- | ------ | -------- |
| [Gap description] | [GDPR Article] | 🔴 High  | [Role] | [Date]   |

## 12. External References

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

**Generated by**: ArcKit `/arckit:eu-rgpd` command **Generated on**:
[YYYY-MM-DD] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]
