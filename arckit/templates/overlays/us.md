<!-- arckit-overlay-template: us-ai-impact-template.md -->

# AI Impact Assessment (OMB M-24-10 + M-25-21)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-ai-impact`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                              | Approved By | Approval Date |
| --------- | ------------ | --------- | ---------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-ai-impact` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: AI use case, rights-impacting / safety-impacting
determination per OMB M-24-10, M-24-10 §5 risk-management practices status,
M-25-21 acquisition controls (if procured), and CAIO sign-off status.]

---

## 1. AI Use Case Description

| Field                                | Value                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| **Use Case Name**                    | [Name]                                                                             |
| **Agency / Bureau**                  | [Agency]                                                                           |
| **Federal AI Use Case Inventory ID** | [If listed on federal.ai.gov — entry ID; otherwise PENDING]                        |
| **Purpose**                          | [What problem the AI solves]                                                       |
| **Decision Context**                 | [What decision is informed or made by the AI]                                      |
| **Data Inputs**                      | [Data types, sources, sensitivity, PII?]                                           |
| **Outputs**                          | [What the AI produces and how it is used downstream]                               |
| **Automation Level**                 | [Decision-support / Decision-making with human review / Decision-making automated] |
| **AI Capability Type**               | [Predictive / Classification / Generative / Decision-Support]                      |
| **Population Affected**              | [Federal employees / public / regulated cohort]                                    |
| **Build / Buy / GenAI Wrapper**      | [In-house / Vendor-built / Off-the-shelf with custom prompts]                      |
| **Cross-ref AI RMF**                 | [ARC-{P}-AIRMF-v*]                                                                 |
| **Cross-ref PIA (if PII)**           | [ARC-{P}-USPIA-v*]                                                                 |
| **CAIO**                             | [Name + role]                                                                      |
| **Use-Case Owner**                   | [Name + role]                                                                      |
| **Assessment Date**                  | [YYYY-MM-DD]                                                                       |

---

## 2. Rights-Impacting / Safety-Impacting Determination

Per OMB M-24-10 Appendix I, certain categories of AI use are _presumed_ to be
rights-impacting or safety-impacting. Determine applicability for this use case.

### 2.1 Safety-Impacting Determination (M-24-10 Appendix I §1)

| Presumed Safety-Impacting Category                                                                                             | Applies?   | Rationale   |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------- |
| Controls safety-critical functions of dams, emergency services, electrical grids, fire safety, financial systems, water supply | [Yes / No] | [Rationale] |
| Maintains civilian working conditions or worker safety in regulated environments                                               | [Yes / No] | [Rationale] |
| Conducts biometric identification (real-time or post-hoc) in public spaces                                                     | [Yes / No] | [Rationale] |
| Detects fraud in benefits programmes resulting in benefit denial                                                               | [Yes / No] | [Rationale] |
| Conducts medical diagnostics or treatment decisions                                                                            | [Yes / No] | [Rationale] |
| Controls physical movement of robots in workspaces accessible to humans                                                        | [Yes / No] | [Rationale] |
| Controls industrial / manufacturing emissions or hazardous materials                                                           | [Yes / No] | [Rationale] |
| Controls life-safety functions in transport (autonomous vehicles, aviation, rail)                                              | [Yes / No] | [Rationale] |
| Conducts safety-related law-enforcement functions                                                                              | [Yes / No] | [Rationale] |

**Safety-Impacting Determination**: **[Yes / No]**

[Narrative: if any of the above rows is Yes, the system is presumed
safety-impacting. CAIO concurrence is required to override the presumption.]

### 2.2 Rights-Impacting Determination (M-24-10 Appendix I §2)

| Presumed Rights-Impacting Category                                                             | Applies?   | Rationale   |
| ---------------------------------------------------------------------------------------------- | ---------- | ----------- |
| Determines eligibility, access, or denial of federal benefits or services                      | [Yes / No] | [Rationale] |
| Generates risk assessments used in criminal or civil legal proceedings                         | [Yes / No] | [Rationale] |
| Detects fraud in benefits programmes (where outcome affects individuals)                       | [Yes / No] | [Rationale] |
| Monitors / detects student academic conduct or wellness                                        | [Yes / No] | [Rationale] |
| Monitors employees in ways that affect employment outcomes                                     | [Yes / No] | [Rationale] |
| Makes housing / loan / employment / insurance access decisions                                 | [Yes / No] | [Rationale] |
| Conducts biometric identification or surveillance of public spaces                             | [Yes / No] | [Rationale] |
| Detects emotion, sentiment, or affect in regulated decision-making                             | [Yes / No] | [Rationale] |
| Translates / generates content used in legal, medical, or benefits proceedings                 | [Yes / No] | [Rationale] |
| Detects or generates content used in censorship / content-moderation by the federal government | [Yes / No] | [Rationale] |
| Conducts immigration / asylum / refugee decision-making                                        | [Yes / No] | [Rationale] |
| Determines firearm-purchase / background-check eligibility                                     | [Yes / No] | [Rationale] |
| Conducts predictive policing                                                                   | [Yes / No] | [Rationale] |
| Determines child welfare interventions                                                         | [Yes / No] | [Rationale] |

**Rights-Impacting Determination**: **[Yes / No]**

### 2.3 CAIO Concurrence

[If the determination contests a presumed category — i.e., you assert "No"
against a presumed Yes — the agency CAIO must concur per M-24-10 §5. Document
the CAIO's rationale and signature in the Approvals section.]

**Determination Contested?**: [Yes — CAIO concurrence required / No]

---

## 3. Minimum Risk-Management Practices Checklist

Per OMB M-24-10 §5 + Appendix II. Required for any AI determined
rights-impacting or safety-impacting.

| #  | Practice                                                                                                                                                           | Status                                     | Evidence                          | Action   |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------- | -------- |
| 1  | Complete AI Impact Assessment (this artefact)                                                                                                                      | [Met / Partial / Not Met / Not Applicable] | [Self-reference]                  | [N/A]    |
| 2  | Test the AI for performance in a real-world context                                                                                                                | [Met / Partial / Not Met / Not Applicable] | [Test report ref]                 | [Action] |
| 3  | Independently evaluate the AI                                                                                                                                      | [Met / Partial / Not Met / Not Applicable] | [Evaluator + report ref]          | [Action] |
| 4  | Conduct ongoing monitoring                                                                                                                                         | [Met / Partial / Not Met / Not Applicable] | [Monitoring plan ref]             | [Action] |
| 5  | Regularly evaluate risks from the AI's use                                                                                                                         | [Met / Partial / Not Met / Not Applicable] | [Reassessment cadence]            | [Action] |
| 6  | Mitigate emerging risks to rights and safety                                                                                                                       | [Met / Partial / Not Met / Not Applicable] | [Mitigation register]             | [Action] |
| 7  | Ensure adequate human training and assessment for AI use                                                                                                           | [Met / Partial / Not Met / Not Applicable] | [Training records]                | [Action] |
| 8  | Provide additional human oversight, intervention, and accountability as part of decisions or actions that could result in a significant impact on rights or safety | [Met / Partial / Not Met / Not Applicable] | [Oversight design]                | [Action] |
| 9  | Provide public notice and plain-language documentation through the agency's AI use-case inventory                                                                  | [Met / Partial / Not Met / Not Applicable] | [federal.ai.gov entry]            | [Action] |
| 10 | Notify negatively affected individuals — provide a means to opt-out where practicable and a means to access human consideration and remedy                         | [Met / Partial / Not Met / Not Applicable] | [Notice text + opt-out mechanism] | [Action] |
| 11 | Maintain options to opt-out from the AI-enabled decision in favour of a human alternative (where practicable)                                                      | [Met / Partial / Not Met / Not Applicable] | [Opt-out design]                  | [Action] |
| 12 | Provide consultation and feedback opportunities for the public and affected communities                                                                            | [Met / Partial / Not Met / Not Applicable] | [Consultation record]             | [Action] |
| 13 | Maintain consistency with broader privacy and civil-rights laws (Privacy Act, ADA, Title VI, etc.)                                                                 | [Met / Partial / Not Met / Not Applicable] | [Legal review]                    | [Action] |
| 14 | Conduct an equity assessment for disparate impact on protected populations                                                                                         | [Met / Partial / Not Met / Not Applicable] | [Equity assessment ref]           | [Action] |

---

## 4. Waiver Posture

[Complete one row for every Section 3 practice marked Partial or Not Met that
the agency intends to proceed without. If none, state "No waivers sought".]

**Basis**: the agency CAIO may waive one or more minimum practices for a
specific AI application or component only by a written determination, based on a
system-specific and context-specific risk assessment, that meeting the practice
would increase risks to safety or rights overall, or would create an
unacceptable impediment to critical agency operations. The CAIO may not delegate
this. Each waiver is tracked centrally, reassessed when the conditions or
context of use change significantly, reported to OMB within 30 days of being
granted or revoked, certified as still valid every year, and summarised publicly
with its justification. Source: OMB M-24-10 §5(a)(ii) and §5(c)(iii); OMB
M-25-21 (April 2025), which rescinded and replaced M-24-10, keeps the same test
in §4(a)(ii)–(iv).

**Waivers Sought**: [Yes — N practices / No waivers sought]

| Practice # (Section 3) | Practice Waived | Ground (Increases Risk to Safety or Rights Overall / Unacceptable Impediment to Critical Operations) | Risk Assessment Reference | CAIO Written Determination (Date, Reference) | Compensating Measures                                  | OMB Report Date (≤ 30 Days) | Annual Certification Due | Public Summary  | Revocation Triggers                                              |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------- | ------------------------------------------------------ | --------------------------- | ------------------------ | --------------- | ---------------------------------------------------------------- |
| [#]                    | [Practice]      | [Ground]                                                                                             | [Ref]                     | [YYYY-MM-DD, ref]                            | [Measures that reduce the risk the practice addressed] | [YYYY-MM-DD]                | [YYYY-MM-DD]             | [URL / Pending] | [Changes in conditions or context that would force reassessment] |

---

## 5. M-25-21 Acquisition Controls

[Applies when the AI system is procured rather than built in-house. Document
contract clauses, evaluation criteria, and vendor obligations per OMB M-25-21.]

**AI Procured?**: [Yes / No]

| Acquisition Control                                                                                        | Status      | Notes   |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ------- |
| Solicitation includes plain-language description of intended use                                           | [Met / Gap] | [Notes] |
| Evaluation criteria assess vendor AI-risk-management maturity                                              | [Met / Gap] | [Notes] |
| Contract clause: vendor disclosure of training data sources                                                | [Met / Gap] | [Notes] |
| Contract clause: vendor disclosure of model architecture and any base models                               | [Met / Gap] | [Notes] |
| Contract clause: vendor model documentation (model card / system card)                                     | [Met / Gap] | [Notes] |
| Contract clause: agency audit rights over vendor AI lifecycle                                              | [Met / Gap] | [Notes] |
| Contract clause: data rights — agency retains rights to its data + derivatives                             | [Met / Gap] | [Notes] |
| Contract clause: IP — clear ownership of agency-generated content, prompts, embeddings, fine-tuned weights | [Met / Gap] | [Notes] |
| Contract clause: vendor commitment to update / patch / decommission cadence                                | [Met / Gap] | [Notes] |
| Contract clause: vendor incident-disclosure obligations (AI incidents, safety failures)                    | [Met / Gap] | [Notes] |
| Contract clause: prohibition on training vendor models with agency data without explicit permission        | [Met / Gap] | [Notes] |
| Contract clause: vendor must support agency M-24-10 minimum practices                                      | [Met / Gap] | [Notes] |
| Vendor management plan in place                                                                            | [Met / Gap] | [Notes] |

---

## 6. Public Disclosure Obligations

| Element                                                | Status                                                         | Notes                   |
| ------------------------------------------------------ | -------------------------------------------------------------- | ----------------------- |
| Entry in agency AI Use Case Inventory (federal.ai.gov) | [Posted / Pending / N/A]                                       | [URL / target date]     |
| Plain-language description on agency website           | [Posted / Pending / N/A]                                       | [URL / target date]     |
| Notice to affected individuals at point of contact     | [Implemented / Planned]                                        | [Notice text reference] |
| Opt-out mechanism communicated                         | [Implemented / Planned / Not practicable — narrative required] | [Mechanism]             |
| Appeals / human-review mechanism communicated          | [Implemented / Planned]                                        | [Mechanism]             |

**Federal AI Use Case Inventory Entry** (draft):

| Field                  | Value                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Use case title         | [Title]                                                                                                                   |
| Agency                 | [Agency]                                                                                                                  |
| Bureau                 | [Bureau]                                                                                                                  |
| Mission area           | [Mission area]                                                                                                            |
| Stage                  | [Initiated / Acquisition and/or Development / Implementation and Assessment / Operation and Maintenance / Decommissioned] |
| Plain-language summary | [Two-sentence summary of what the AI does and for whom]                                                                   |
| Rights-impacting       | [Yes / No]                                                                                                                |
| Safety-impacting       | [Yes / No]                                                                                                                |
| Date last updated      | [YYYY-MM-DD]                                                                                                              |

---

## 7. Agency CAIO Sign-Off

| Sign-Off Item                                         | CAIO Statement                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Determination of rights-/safety-impacting concurred   | [Concur / Concur with conditions / Do not concur]              |
| Minimum risk-management practices reviewed            | [Reviewed and approved / Conditional / Returned for revision]  |
| Waivers (Section 4) determined in writing by the CAIO | [None sought / N granted — determination references / Refused] |
| Acquisition controls (where applicable) reviewed      | [Reviewed and approved / Conditional / N/A]                    |
| Public disclosure plan reviewed                       | [Reviewed and approved / Conditional]                          |

**CAIO Signature**: [Name + signature + date]

---

## 8. References

| Reference      | Citation                                                                                        | URL                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OMB M-24-10    | Advancing Governance, Innovation, and Risk Management for Agency Use of Artificial Intelligence | <https://www.whitehouse.gov/wp-content/uploads/2024/03/M-24-10-Advancing-Governance-Innovation-and-Risk-Management-for-Agency-Use-of-Artificial-Intelligence.pdf> |
| OMB M-25-21    | Acquisition of Artificial Intelligence in the Federal Government                                | <https://www.whitehouse.gov/omb/>                                                                                                                                 |
| NIST AI 600-1  | AI RMF: Generative AI Profile                                                                   | <https://doi.org/10.6028/NIST.AI.600-1>                                                                                                                           |
| federal.ai.gov | Federal AI Use Case Inventory                                                                   | <https://ai.gov/ai-use-cases/>                                                                                                                                    |

---

## 9. Approvals

| Role                                      | Name   | Signature   | Date         |
| ----------------------------------------- | ------ | ----------- | ------------ |
| AI Use-Case Owner                         | [Name] | [Signature] | [YYYY-MM-DD] |
| Chief AI Officer (CAIO)                   | [Name] | [Signature] | [YYYY-MM-DD] |
| Senior Agency Official for Privacy (SAOP) | [Name] | [Signature] | [YYYY-MM-DD] |
| Agency General Counsel (or designee)      | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-ai-impact` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]

<!-- arckit-overlay-template: us-ai-rmf-template.md -->

# NIST AI Risk Management Framework Assessment

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-ai-rmf`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                           | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-ai-rmf` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: AI system, intended use, AI RMF 1.0 four-function
maturity, GenAI applicability, top three residual risks, and recommended
treatment.]

---

## 1. AI System Description

| Field                               | Value                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------- |
| **System Name**                     | [Name]                                                                     |
| **Intended Use**                    | [Specific purpose, decision context, automation level]                     |
| **AI Capability Type**              | [Predictive / Classification / Generative / Decision-Support / Autonomous] |
| **GenAI in Use?**                   | [Yes — see Section 6 / No]                                                 |
| **Training Data Sources**           | [Public / proprietary / mixed; data classification]                        |
| **Model Architecture**              | [E.g., gradient-boosted trees / transformer 7B / RAG over agency corpus]   |
| **Foundation Model (if any)**       | [Vendor + version, e.g., Claude Opus 4 / GPT-4o / Llama 3.1 70B]           |
| **Deployment Context**              | [Internal / customer-facing / inter-agency]                                |
| **Population Affected**             | [Federal employees / public / regulated cohort]                            |
| **Decisions Affecting Individuals** | [Yes — describe / No / Decision-support only]                              |
| **Human-in-the-Loop Posture**       | [Always / Threshold-triggered / None]                                      |
| **Cross-ref AI Impact Assessment**  | [ARC-{P}-AIIA-v*]                                                          |
| **Assessment Date**                 | [YYYY-MM-DD]                                                               |
| **Chief AI Officer (CAIO)**         | [Name + role]                                                              |

---

## 2. Govern Function

Cultivate a culture of risk management. AI RMF 1.0 Govern function
sub-categories.

| Sub-category                                                                                                                                                                                      | Maturity                                    | Evidence   | Action   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------- | -------- |
| Govern 1.1 — Legal and regulatory requirements involving AI are understood, managed, and documented                                                                                               | [Not in Place / Partially / Mostly / Fully] | [Evidence] | [Action] |
| Govern 1.2 — Characteristics of trustworthy AI are integrated into organisational policies, processes, and procedures                                                                             | [Maturity]                                  | [Evidence] | [Action] |
| Govern 1.3 — Processes, procedures, and practices are in place to determine the needed level of risk management activities based on the AI system's risk                                          | [Maturity]                                  | [Evidence] | [Action] |
| Govern 1.4 — The risk management process and its outcomes are established through transparent policies, procedures, and other controls                                                            | [Maturity]                                  | [Evidence] | [Action] |
| Govern 1.5 — Ongoing monitoring and periodic review of the risk management process and its outcomes are planned                                                                                   | [Maturity]                                  | [Evidence] | [Action] |
| Govern 1.6 — Mechanisms are in place to inventory AI systems and are resourced according to organisational risk priorities                                                                        | [Maturity]                                  | [Evidence] | [Action] |
| Govern 1.7 — Processes and procedures are in place for decommissioning and phasing out AI systems safely                                                                                          | [Maturity]                                  | [Evidence] | [Action] |
| Govern 2.1 — Roles, responsibilities, and lines of communication related to mapping, measuring, and managing AI risks are documented                                                              | [Maturity]                                  | [Evidence] | [Action] |
| Govern 2.2 — The organisation's personnel and partners receive AI risk-management training                                                                                                        | [Maturity]                                  | [Evidence] | [Action] |
| Govern 2.3 — Executive leadership of the organisation takes responsibility for decisions about risks associated with AI system development and deployment                                         | [Maturity]                                  | [Evidence] | [Action] |
| Govern 3.1 — Decision-making related to mapping, measuring, and managing AI risks throughout the lifecycle is informed by a diverse team                                                          | [Maturity]                                  | [Evidence] | [Action] |
| Govern 3.2 — Policies and procedures are in place to define and differentiate roles and responsibilities for human-AI configurations and oversight                                                | [Maturity]                                  | [Evidence] | [Action] |
| Govern 4.1 — Organisational policies and practices foster a critical thinking and safety-first mindset                                                                                            | [Maturity]                                  | [Evidence] | [Action] |
| Govern 4.2 — Organisational teams document the risks and potential impacts of AI technology they design, develop, deploy, evaluate, and use                                                       | [Maturity]                                  | [Evidence] | [Action] |
| Govern 4.3 — Organisational practices are in place to enable AI testing, identification of incidents, and information sharing                                                                     | [Maturity]                                  | [Evidence] | [Action] |
| Govern 5.1 — Organisational policies and practices are in place to collect, consider, prioritise, and integrate feedback from those external to the team that developed or deployed the AI system | [Maturity]                                  | [Evidence] | [Action] |
| Govern 5.2 — Mechanisms are established to enable AI actors to regularly incorporate adjudicated feedback from relevant AI actors into system design and implementation                           | [Maturity]                                  | [Evidence] | [Action] |
| Govern 6.1 — Policies and procedures are in place that address AI risks associated with third-party entities                                                                                      | [Maturity]                                  | [Evidence] | [Action] |
| Govern 6.2 — Contingency processes are in place to handle failures or incidents in third-party data or AI systems deemed to be high-risk                                                          | [Maturity]                                  | [Evidence] | [Action] |

---

## 3. Map Function

Establish context and identify risks. AI RMF 1.0 Map function sub-categories.

| Sub-category                                                                                                                                                                                                                                                                                                                       | Maturity   | Evidence   | Action   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | -------- |
| Map 1.1 — Intended purposes, potentially beneficial uses, context-specific laws, norms, and expectations, and prospective settings in which the AI system will be deployed are understood and documented                                                                                                                           | [Maturity] | [Evidence] | [Action] |
| Map 1.2 — Inter-disciplinary AI actors, competencies, skills, and capacities for establishing context reflect demographic diversity and broad domain and user experience expertise                                                                                                                                                 | [Maturity] | [Evidence] | [Action] |
| Map 1.3 — The organisation's mission and relevant goals for the AI technology are understood and documented                                                                                                                                                                                                                        | [Maturity] | [Evidence] | [Action] |
| Map 1.4 — The business value or context of business use has been clearly defined or, in the case of assessing existing AI systems, re-evaluated                                                                                                                                                                                    | [Maturity] | [Evidence] | [Action] |
| Map 1.5 — Organisational risk tolerances are determined and documented                                                                                                                                                                                                                                                             | [Maturity] | [Evidence] | [Action] |
| Map 1.6 — System requirements are documented; AI actor expectations of stakeholders are determined                                                                                                                                                                                                                                 | [Maturity] | [Evidence] | [Action] |
| Map 2.1 — The specific tasks and methods used to implement the tasks that the AI system will support are defined                                                                                                                                                                                                                   | [Maturity] | [Evidence] | [Action] |
| Map 2.2 — Information about the AI system's knowledge limits and how system output may be utilised and overseen by humans is documented                                                                                                                                                                                            | [Maturity] | [Evidence] | [Action] |
| Map 2.3 — Scientific integrity and TEVV considerations are identified and documented, including those related to experimental design, data collection and selection, system trustworthiness, and construct validation                                                                                                              | [Maturity] | [Evidence] | [Action] |
| Map 3.1 — Potential benefits of intended AI system functionality and performance are examined and documented                                                                                                                                                                                                                       | [Maturity] | [Evidence] | [Action] |
| Map 3.2 — Potential costs, including non-monetary costs, that result from expected or realised AI errors or system functionality and trustworthiness — as connected to organisational risk tolerance — are examined and documented                                                                                                 | [Maturity] | [Evidence] | [Action] |
| Map 3.3 — Targeted application scope is specified and documented based on the system's capability, established context, and AI system categorization                                                                                                                                                                               | [Maturity] | [Evidence] | [Action] |
| Map 3.4 — Processes for operator and practitioner proficiency with AI system performance and trustworthiness — and relevant technical standards and certifications — are defined, assessed, and documented                                                                                                                         | [Maturity] | [Evidence] | [Action] |
| Map 3.5 — Processes for human oversight, in accordance with organisational policies from Govern, are defined, assessed, and documented                                                                                                                                                                                             | [Maturity] | [Evidence] | [Action] |
| Map 4.1 — Approaches for mapping AI technology and legal risks of its components — including the use of third-party data or software — are in place, followed, and documented                                                                                                                                                      | [Maturity] | [Evidence] | [Action] |
| Map 4.2 — Internal risk controls for components of the AI system, including third-party AI technologies, are identified and documented                                                                                                                                                                                             | [Maturity] | [Evidence] | [Action] |
| Map 5.1 — Likelihood and magnitude of each identified impact (both potentially beneficial and harmful) based on expected use, past uses of AI systems in similar contexts, public incident reports, feedback from those external to the team that developed or deployed the AI system, or other data are identified and documented | [Maturity] | [Evidence] | [Action] |
| Map 5.2 — Practices and personnel for supporting regular engagement with relevant AI actors and integrating feedback about positive, negative, and unanticipated impacts are in place and documented                                                                                                                               | [Maturity] | [Evidence] | [Action] |

---

## 4. Measure Function

Use quantitative, qualitative, or mixed-method tools to analyse, assess, and
monitor AI risks.

| Sub-category                                                                                                                                                                                                                                                | Maturity   | Evidence   | Action   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | -------- |
| Measure 1.1 — Approaches and metrics for measurement of AI risks enumerated during the Map function are selected for implementation starting with the most significant AI risks                                                                             | [Maturity] | [Evidence] | [Action] |
| Measure 1.2 — Appropriateness of AI metrics and effectiveness of existing controls are regularly assessed and updated, including reports of errors and potential impacts                                                                                    | [Maturity] | [Evidence] | [Action] |
| Measure 1.3 — Internal experts who did not serve as front-line developers for the system and/or independent assessors are involved in regular assessments and updates                                                                                       | [Maturity] | [Evidence] | [Action] |
| Measure 2.1 — Test sets, metrics, and details about the tools used during TEVV are documented                                                                                                                                                               | [Maturity] | [Evidence] | [Action] |
| Measure 2.2 — Evaluations involving human subjects meet applicable requirements and are representative of the relevant population                                                                                                                           | [Maturity] | [Evidence] | [Action] |
| Measure 2.3 — AI system performance or assurance criteria are measured qualitatively or quantitatively and demonstrated for conditions similar to deployment setting(s)                                                                                     | [Maturity] | [Evidence] | [Action] |
| Measure 2.4 — The functionality and behaviour of the AI system and its components — as identified in the Map function — are monitored when in production                                                                                                    | [Maturity] | [Evidence] | [Action] |
| Measure 2.5 — The AI system to be deployed is demonstrated to be valid and reliable                                                                                                                                                                         | [Maturity] | [Evidence] | [Action] |
| Measure 2.6 — The AI system is evaluated regularly for safety risks                                                                                                                                                                                         | [Maturity] | [Evidence] | [Action] |
| Measure 2.7 — AI system security and resilience are evaluated and documented                                                                                                                                                                                | [Maturity] | [Evidence] | [Action] |
| Measure 2.8 — Risks associated with transparency and accountability are examined and documented                                                                                                                                                             | [Maturity] | [Evidence] | [Action] |
| Measure 2.9 — The AI model is explained, validated, and documented; AI system output is interpreted within its context and to inform responsible use and governance                                                                                         | [Maturity] | [Evidence] | [Action] |
| Measure 2.10 — Privacy risk of the AI system is examined and documented                                                                                                                                                                                     | [Maturity] | [Evidence] | [Action] |
| Measure 2.11 — Fairness and bias — as identified in the Map function — are evaluated and documented                                                                                                                                                         | [Maturity] | [Evidence] | [Action] |
| Measure 2.12 — Environmental impact and sustainability of AI model training and management activities are assessed and documented                                                                                                                           | [Maturity] | [Evidence] | [Action] |
| Measure 2.13 — Effectiveness of the employed TEVV metrics and processes in the Measure function are evaluated and documented                                                                                                                                | [Maturity] | [Evidence] | [Action] |
| Measure 3.1 — Approaches, personnel, and documentation are in place to regularly identify and track existing, unanticipated, and emergent AI risks based on factors such as intended and actual performance in deployed contexts                            | [Maturity] | [Evidence] | [Action] |
| Measure 3.2 — Risk tracking approaches are considered for settings where AI risks are difficult to assess using currently available measurement techniques or where metrics are not yet available                                                           | [Maturity] | [Evidence] | [Action] |
| Measure 3.3 — Feedback processes for end users and impacted communities to report problems and appeal system outcomes are established and integrated into AI system evaluation metrics                                                                      | [Maturity] | [Evidence] | [Action] |
| Measure 4.1 — Measurement approaches for identifying AI risks are connected to deployment context(s) and informed through consultation with domain experts and other end users                                                                              | [Maturity] | [Evidence] | [Action] |
| Measure 4.2 — Measurement results regarding AI system trustworthiness in deployment context(s) and across the AI lifecycle are informed by input from domain experts and relevant AI actors                                                                 | [Maturity] | [Evidence] | [Action] |
| Measure 4.3 — Measurable performance improvements or declines based on consultations with relevant AI actors, including affected communities, and field data about context-relevant risks and trustworthiness characteristics are identified and documented | [Maturity] | [Evidence] | [Action] |

---

## 5. Manage Function

Allocate risk resources to mapped and measured risks on a regular basis.

| Sub-category                                                                                                                                                                                                                                                       | Maturity   | Evidence   | Action   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------- | -------- |
| Manage 1.1 — A determination is made as to whether the AI system achieves its intended purposes and stated objectives and whether its development or deployment should proceed                                                                                     | [Maturity] | [Evidence] | [Action] |
| Manage 1.2 — Treatment of documented AI risks is prioritised based on impact, likelihood, and available resources or methods                                                                                                                                       | [Maturity] | [Evidence] | [Action] |
| Manage 1.3 — Responses to the AI risks deemed high priority — as identified by the Map function — including response, recovery, and communication plans are planned and documented                                                                                 | [Maturity] | [Evidence] | [Action] |
| Manage 1.4 — Negative residual risks (defined as the sum of all unmitigated risks) to both downstream acquirers of AI systems and end users are documented                                                                                                         | [Maturity] | [Evidence] | [Action] |
| Manage 2.1 — Resources required to manage AI risks are taken into account, along with viable non-AI alternative systems, approaches, or methods — to reduce the magnitude or likelihood of potential impacts                                                       | [Maturity] | [Evidence] | [Action] |
| Manage 2.2 — Mechanisms are in place and applied to sustain the value of deployed AI systems                                                                                                                                                                       | [Maturity] | [Evidence] | [Action] |
| Manage 2.3 — Procedures are followed to respond to and recover from a previously unknown risk when it is identified                                                                                                                                                | [Maturity] | [Evidence] | [Action] |
| Manage 2.4 — Mechanisms are in place and applied, and responsibilities are assigned and understood, to supersede, disengage, or deactivate AI systems that demonstrate performance or outcomes inconsistent with intended use                                      | [Maturity] | [Evidence] | [Action] |
| Manage 3.1 — AI risks and benefits from third-party resources are regularly monitored and risk controls are applied and documented                                                                                                                                 | [Maturity] | [Evidence] | [Action] |
| Manage 3.2 — Pre-trained models that are used for development are monitored as part of AI system regular monitoring and maintenance                                                                                                                                | [Maturity] | [Evidence] | [Action] |
| Manage 4.1 — Post-deployment AI system monitoring plans are implemented, including mechanisms for capturing and evaluating input from users and other relevant AI actors, appeal and override, decommissioning, incident response, recovery, and change management | [Maturity] | [Evidence] | [Action] |
| Manage 4.2 — Measurable activities for continual improvements are integrated into AI system updates and include regular engagement with interested parties, including relevant AI actors                                                                           | [Maturity] | [Evidence] | [Action] |
| Manage 4.3 — Incidents and errors are communicated to relevant AI actors, including affected communities; processes for tracking, responding to, and recovering from incidents and errors are followed and documented                                              | [Maturity] | [Evidence] | [Action] |

---

## 6. Generative AI Profile (NIST AI 600-1)

[If GenAI is in use, complete this section. If not, mark "Not Applicable" and
explain.]

**GenAI Applicability**: [Yes / No]

If yes, score the 12 GenAI-specific risk categories from NIST AI 600-1:

| GenAI Risk                                                                    | Maturity   | Evidence   | Action   |
| ----------------------------------------------------------------------------- | ---------- | ---------- | -------- |
| Confabulation (hallucination of false content)                                | [Maturity] | [Evidence] | [Action] |
| Dangerous, Violent, or Hateful Content                                        | [Maturity] | [Evidence] | [Action] |
| Data Privacy (training-data memorisation; inference-time leakage)             | [Maturity] | [Evidence] | [Action] |
| Environmental Impact (training + inference energy / water / carbon)           | [Maturity] | [Evidence] | [Action] |
| Harmful Bias or Homogenization                                                | [Maturity] | [Evidence] | [Action] |
| Human-AI Configuration (over-reliance, automation bias)                       | [Maturity] | [Evidence] | [Action] |
| Information Integrity (mis/disinformation amplification)                      | [Maturity] | [Evidence] | [Action] |
| Information Security (prompt injection, model extraction, adversarial inputs) | [Maturity] | [Evidence] | [Action] |
| Intellectual Property (training-data copyright; output IP)                    | [Maturity] | [Evidence] | [Action] |
| Obscene, Degrading, and/or Abusive Content                                    | [Maturity] | [Evidence] | [Action] |
| Toxicity, Bias, and Homogenization in outputs                                 | [Maturity] | [Evidence] | [Action] |
| Value Chain and Component Integration (third-party model risks)               | [Maturity] | [Evidence] | [Action] |

---

## 7. Residual Risk Register

| Risk ID | Description        | Likelihood         | Impact             | Treatment                              | Owner  |
| ------- | ------------------ | ------------------ | ------------------ | -------------------------------------- | ------ |
| AIR-001 | [Risk description] | [Low / Med / High] | [Low / Med / High] | [Accept / Mitigate / Transfer / Avoid] | [Role] |

---

## 8. Control-to-RMF-Function Crosswalk

Map NIST SP 800-53 controls to AI RMF functions.

| 800-53 Control | AI RMF Function | Sub-category | Notes                                |
| -------------- | --------------- | ------------ | ------------------------------------ |
| RA-3           | Map             | Map 5.1      | [Risk assessment of AI system harms] |
| RA-5           | Measure         | Measure 2.7  | [Vulnerability monitoring]           |
| SI-4           | Manage          | Manage 4.1   | [System monitoring during operation] |
| CA-7           | Manage          | Manage 4.1   | [Continuous monitoring]              |
| PT-1           | Govern          | Govern 1.1   | [PII processing policy]              |
| AT-2           | Govern          | Govern 2.2   | [AI awareness training]              |
| SR-3           | Govern          | Govern 6.1   | [Third-party AI supply chain]        |
| SA-11          | Measure         | Measure 2.5  | [Developer testing]                  |
| IR-4           | Manage          | Manage 4.3   | [AI incident handling]               |

---

## 9. References

| Reference       | Citation                                                                   | URL                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NIST AI RMF 1.0 | Artificial Intelligence Risk Management Framework 1.0                      | <https://doi.org/10.6028/NIST.AI.100-1>                                                                                                                           |
| AI RMF Playbook | Playbook for the AI RMF                                                    | <https://airc.nist.gov/AI_RMF_Knowledge_Base/Playbook>                                                                                                            |
| NIST AI 600-1   | AI RMF: Generative AI Profile                                              | <https://doi.org/10.6028/NIST.AI.600-1>                                                                                                                           |
| OMB M-24-10     | Advancing Governance, Innovation, and Risk Management for Agency Use of AI | <https://www.whitehouse.gov/wp-content/uploads/2024/03/M-24-10-Advancing-Governance-Innovation-and-Risk-Management-for-Agency-Use-of-Artificial-Intelligence.pdf> |

---

## 10. Approvals

| Role                                      | Name   | Signature   | Date         |
| ----------------------------------------- | ------ | ----------- | ------------ |
| Chief AI Officer (CAIO)                   | [Name] | [Signature] | [YYYY-MM-DD] |
| AI Use-Case Owner                         | [Name] | [Signature] | [YYYY-MM-DD] |
| CISO                                      | [Name] | [Signature] | [YYYY-MM-DD] |
| Senior Agency Official for Privacy (SAOP) | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-ai-rmf` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]

<!-- arckit-overlay-template: us-fedramp-readiness-template.md -->

# FedRAMP Readiness Self-Assessment (3PAO RAR Format)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-fedramp-readiness`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                      | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-fedramp-readiness` command | PENDING     | PENDING       |

---

## Executive Summary

> **Status of this document**: an internal self-assessment prepared by the CSP
> in the format of the FedRAMP Readiness Assessment Report (RAR). It is not the
> official RAR, which a FedRAMP-recognized 3PAO prepares, owns and attests, and
> it cannot confer FedRAMP Ready or any other FedRAMP status. FedRAMP has
> accepted no new FedRAMP Ready submissions since 28 July 2026 (FedRAMP
> Consolidated Rules for 2026).

[Two to three paragraphs: CSO under assessment, baseline targeted, who prepared
this self-assessment, the 3PAO engaged or planned (if any), the readiness
verdict for 3PAO assessment (Ready / Conditionally Ready / Not Ready), and the
top three gaps by severity.]

---

## 1. Capability Statement

| Field                                    | Value                                                |
| ---------------------------------------- | ---------------------------------------------------- |
| **Cloud Service Offering (CSO)**         | [CSO name]                                           |
| **CSP**                                  | [CSP organisation]                                   |
| **Service Model**                        | [IaaS / PaaS / SaaS]                                 |
| **Baseline Targeted**                    | [Moderate / High]                                    |
| **Authorisation Path**                   | [Agency / JAB / Tailored]                            |
| **Prepared By**                          | [CSP readiness lead — name + role]                   |
| **3PAO Engaged (planned or contracted)** | [3PAO name + A2LA accreditation # / Not yet engaged] |
| **Self-Assessment Period**               | [YYYY-MM-DD to YYYY-MM-DD]                           |
| **Sponsoring Agency** (if Agency path)   | [Agency]                                             |
| **Target ATO Date**                      | [YYYY-MM-DD]                                         |

### What the CSO Provides

[Two-paragraph description of the service, customer use cases, and key
capabilities relevant to federal customers.]

### Customer Responsibility Matrix (Summary)

| Control Family | CSO Provides           | Customer Responsibility            |
| -------------- | ---------------------- | ---------------------------------- |
| AC             | [What the CSO handles] | [What the customer must configure] |
| AU             | [What the CSO handles] | [What the customer must configure] |
| CM             | [What the CSO handles] | [What the customer must configure] |
| IR             | [What the CSO handles] | [What the customer must configure] |
| SC             | [What the CSO handles] | [What the customer must configure] |
| SI             | [What the CSO handles] | [What the customer must configure] |

[Full CRM is a separate deliverable; this is a summary view for the RAR.]

---

## 2. Authorisation Path Recommendation

| Path                                   | Recommended? | Rationale                                                                                 |
| -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| **Agency ATO**                         | [Yes / No]   | [Single sponsoring agency identified; suits CSOs with a primary federal customer.]        |
| **JAB P-ATO**                          | [Yes / No]   | [Multi-agency demand; suits widely-used CSOs.]                                            |
| **FedRAMP Tailored (Low-Impact SaaS)** | [Yes / No]   | [LI-SaaS only; suits collaboration / productivity tools with no PII / no sensitive data.] |

**Recommendation**: [Agency / JAB / Tailored] — [Rationale narrative]

---

## 3. Gap Register

Gaps identified during the readiness assessment that must be remediated before
authorisation.

| Control ID | Gap Description                                                                     | Severity (Critical / High / Moderate / Low) | Mitigation Plan                                                | Target Completion (POA&M Target) | Owner           |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- | -------------------------------- | --------------- |
| [AC-2]     | [Account management process not fully automated; manual provisioning steps remain.] | [Moderate]                                  | [Automate provisioning via IdP workflow; remove manual steps.] | [YYYY-MM-DD]                     | [Platform team] |
| [AU-6]     | [Audit log review cadence not documented for the application tier.]                 | [Low]                                       | [Document review SOP; SOC ack daily.]                          | [YYYY-MM-DD]                     | [SOC]           |
| [SC-7]     | [WAF rule set not validated against OWASP top 10.]                                  | [High]                                      | [Engage AppSec; tune WAF; rerun validation.]                   | [YYYY-MM-DD]                     | [AppSec]        |
| [SR-3]     | [SBOM not yet produced for one third-party dependency.]                             | [Moderate]                                  | [Engage vendor; produce CycloneDX SBOM.]                       | [YYYY-MM-DD]                     | [SecOps]        |

---

## 4. Evidence Inventory

| Artefact                                       | Control ID(s)   | Evidence Status (Complete / Partial / Missing)     | Location / Link      |
| ---------------------------------------------- | --------------- | -------------------------------------------------- | -------------------- |
| System Security Plan (SSP)                     | [All]           | [Complete]                                         | [ARC-{P}-FRSSP-v*]   |
| FIPS 199 Categorization                        | [RA-2]          | [Complete]                                         | [ARC-{P}-FIPS199-v*] |
| Tailored 800-53 Control Set                    | [All]           | [Complete]                                         | [ARC-{P}-NIST-v*]    |
| Privacy Impact Assessment                      | [PT family]     | [Complete]                                         | [ARC-{P}-USPIA-v*]   |
| Contingency Plan                               | [CP-2]          | [Complete]                                         | [Reference]          |
| Incident Response Plan                         | [IR-8]          | [Complete]                                         | [Reference]          |
| Configuration Management Plan                  | [CM-9]          | [Complete]                                         | [Reference]          |
| ConMon Plan                                    | [CA-7]          | [Partial — pending FedRAMP PMO template alignment] | [Reference]          |
| POA&M (initial)                                | [CA-5]          | [Complete]                                         | [Reference]          |
| Vulnerability Scan (authenticated)             | [RA-5]          | [Complete — last scan YYYY-MM-DD]                  | [Scan report ref]    |
| Penetration Test Report                        | [CA-8]          | [Complete — last test YYYY-MM-DD]                  | [Pentest report ref] |
| Customer Responsibility Matrix (CRM)           | [All inherited] | [Complete]                                         | [Reference]          |
| FIPS 140-3 Validation Certs for crypto modules | [SC-13]         | [Complete — CMVP cert NNNN]                        | [CMVP cert link]     |
| SSDF Self-Attestation (EO 14028)               | [SR family]     | [Complete]                                         | [ARC-{P}-SBOM-v*]    |

---

## 5. Readiness Criteria Checklist

### 5.1 Federal Mandates (RAR §4.1)

The six Federal Mandates in the FedRAMP Moderate and High RAR templates. Answer
Yes only if the mandate is fully and strictly met; an alternative implementation
is a No. A 3PAO will not submit a RAR while any answer is No.

| # | Federal Mandate                                                                                                                             | Fully Met? | Evidence / Notes |
| - | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| 1 | FIPS 140-validated cryptographic modules used everywhere cryptography is required (SC-13), including all SC-8, SC-8(1) and SC-28 encryption | [Yes / No] | [Notes]          |
| 2 | System fully supports user authentication with agency PIV or CAC credentials                                                                | [Yes / No] | [Notes]          |
| 3 | System operates at Digital Identity Level 2 or higher (Moderate) / Level 3 (High)                                                           | [Yes / No] | [Notes]          |
| 4 | CSP consistently remediates High vulnerabilities within 30 days, Moderate within 90 and Low within 180                                      | [Yes / No] | [Notes]          |
| 5 | CSP and system meet federal records management requirements (record holds, NARA, FOIA)                                                      | [Yes / No] | [Notes]          |
| 6 | External DNS supports DNSSEC for origin authentication and integrity (SC-20, SC-21, SC-22)                                                  | [Yes / No] | [Notes]          |

### 5.2 Further Readiness Checks

ArcKit's pre-assessment checks, covering ground the RAR assesses under FedRAMP
Requirements (§4.2) and Additional Capabilities (§4.3), plus federal
requirements the RAR does not test (row 13).

| #  | Criterion                                                           | Status          | Notes   |
| -- | ------------------------------------------------------------------- | --------------- | ------- |
| 1  | CSO is fully described (architecture, boundary, components)         | [Met / Not Met] | [Notes] |
| 2  | Authorisation boundary diagram approved                             | [Met / Not Met] | [Notes] |
| 3  | Data flow diagram approved                                          | [Met / Not Met] | [Notes] |
| 4  | All controls implemented or have POA&M target dates                 | [Met / Not Met] | [Notes] |
| 5  | Leveraged services are FedRAMP Authorized (not In Process or Ready) | [Met / Not Met] | [Notes] |
| 6  | Multi-factor authentication implemented (AAL2 minimum)              | [Met / Not Met] | [Notes] |
| 7  | Continuous monitoring strategy documented                           | [Met / Not Met] | [Notes] |
| 8  | Initial vulnerability scan completed; results in evidence           | [Met / Not Met] | [Notes] |
| 9  | Initial POA&M populated                                             | [Met / Not Met] | [Notes] |
| 10 | Incident response capability validated by tabletop exercise         | [Met / Not Met] | [Notes] |
| 11 | All cryptographic key management implemented per SC-12              | [Met / Not Met] | [Notes] |
| 12 | CRM completed and signed by CSP                                     | [Met / Not Met] | [Notes] |
| 13 | SSDF / EO 14028 self-attestation submitted to CISA                  | [Met / Not Met] | [Notes] |

**Readiness Verdict for 3PAO Assessment**: [Ready / Conditionally Ready / Not
Ready]

---

## 6. Penetration Testing Summary

[The RAR does not require a penetration test, though the 3PAO reviews any
existing results when it assesses separation measures; the full initial
assessment of a Moderate or High system does require one. Record the latest test
here, or "None yet" with the planned date.]

| Field                 | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| **Test Firm**         | [Firm name]                                                   |
| **Test Period**       | [YYYY-MM-DD to YYYY-MM-DD]                                    |
| **Scope**             | [In-scope assets, applications, APIs]                         |
| **Methodology**       | [PTES / OWASP WSTG / NIST SP 800-115]                         |
| **Critical Findings** | [Count + status]                                              |
| **High Findings**     | [Count + status]                                              |
| **Medium Findings**   | [Count + status]                                              |
| **Low Findings**      | [Count + status]                                              |
| **Retest Date**       | [YYYY-MM-DD]                                                  |
| **Final Status**      | [All criticals remediated / N criticals open with mitigation] |

---

## 7. Continuous Monitoring Readiness

| Element                                                       | Status                   | Notes       |
| ------------------------------------------------------------- | ------------------------ | ----------- |
| ConMon Plan documented                                        | [Complete / In progress] | [Reference] |
| Monthly POA&M ready for FedRAMP PMO submission                | [Yes / No]               | [Notes]     |
| Authenticated scan cadence proven (≥ 4 weeks history)         | [Yes / No]               | [Notes]     |
| IR drill (tabletop or functional) completed in last 12 months | [Yes / No]               | [Notes]     |
| Annual assessment scope agreed with AO                        | [Yes / No]               | [Notes]     |

---

## 8. Remediation Roadmap

```text
Month 1     |================================|  Address all High gaps
Month 2     |================================|  Address Moderate gaps
Month 3     |================================|  3PAO assessment (official RAR or full initial assessment)
Month 4     |================================|  Submit package to FedRAMP PMO
Month 5-6   |================================|  ATO process (Agency or JAB review)
```

[Replace with project-specific timeline. Include milestone gates: gap closure →
3PAO assessment → package submission → AO review → ATO issued.]

| Milestone                        | Target Date  | Owner          | Status        |
| -------------------------------- | ------------ | -------------- | ------------- |
| All High gaps closed             | [YYYY-MM-DD] | [Owner]        | [Open / Done] |
| All Moderate gaps closed         | [YYYY-MM-DD] | [Owner]        | [Open / Done] |
| 3PAO assessment complete         | [YYYY-MM-DD] | [3PAO]         | [Open / Done] |
| Package submitted to FedRAMP PMO | [YYYY-MM-DD] | [System Owner] | [Open / Done] |
| ATO issued                       | [YYYY-MM-DD] | [AO]           | [Open / Done] |

---

## 9. References

| Reference                                    | Citation                                                             | URL                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| FedRAMP 3PAO RAR Template                    | Readiness Assessment Report Template (Moderate v2.1, May 2024; High) | <https://www.fedramp.gov/documents-templates/>                                                    |
| FedRAMP Consolidated Rules for 2026          | Important dates — FedRAMP Ready retired 28 July 2026                 | <https://www.fedramp.gov/2026/timeline/>                                                          |
| FedRAMP Agency Authorization Playbook        | Agency Authorization Playbook                                        | <https://www.fedramp.gov/agency-authorization/>                                                   |
| FedRAMP JAB Prioritisation Criteria          | JAB Prioritisation Criteria                                          | <https://www.fedramp.gov/jab-prioritization/>                                                     |
| FedRAMP Continuous Monitoring Strategy Guide | ConMon Strategy Guide                                                | <https://www.fedramp.gov/assets/resources/documents/CSP_Continuous_Monitoring_Strategy_Guide.pdf> |
| A2LA 3PAO Directory                          | Accredited 3PAO Directory                                            | <https://customer.a2la.org/index.cfm?event=directory.search>                                      |

---

## 10. Approvals

[Internal approval of the self-assessment. A 3PAO signs only the official RAR it
prepares, never this document.]

| Role                          | Name   | Signature   | Date         |
| ----------------------------- | ------ | ----------- | ------------ |
| CSP Readiness Lead (preparer) | [Name] | [Signature] | [YYYY-MM-DD] |
| CSP System Owner              | [Name] | [Signature] | [YYYY-MM-DD] |
| CSP CISO                      | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-fedramp-readiness` command **Generated
on**: [DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: us-fedramp-ssp-template.md -->

# FedRAMP System Security Plan (Moderate / High Baseline)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-fedramp-ssp`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-fedramp-ssp` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: cloud service offering (CSO) being described, baseline
being targeted (Moderate / High), authorisation path (Agency / JAB / Tailored),
current readiness state, and target ATO timeline.]

> **Structure**: this plan has 14 sections. Each one feeds a section or appendix
> of the FedRAMP Rev 5 SSP template (12 front-matter sections, Appendices A–Q);
> Section 14 maps every appendix to its source. FedRAMP marked that template
> legacy on 23 June 2026 under the FedRAMP Consolidated Rules for 2026 — confirm
> the template your submission must use on fedramp.gov.

---

## Section 1 — System Identification

| Field                                 | Value                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------- |
| **Cloud Service Offering (CSO) Name** | [CSO name]                                                              |
| **CSO Identifier**                    | [Unique product identifier]                                             |
| **Cloud Service Provider (CSP) Name** | [CSP organisation]                                                      |
| **FedRAMP Package ID**                | [FR-MOD-NNNNN — assigned upon submission]                               |
| **CSO Type**                          | [IaaS / PaaS / SaaS]                                                    |
| **Deployment Model**                  | [Government Community Cloud / Private Cloud / Hybrid]                   |
| **Authorisation Path**                | [Agency ATO / JAB P-ATO / FedRAMP Tailored Low-Impact SaaS]             |
| **Sponsoring Agency**                 | [Agency name (Agency path only)]                                        |
| **Baseline Targeted**                 | [Moderate / High]                                                       |
| **Digital Identity Level**            | [IAL2/AAL2/FAL2 / IAL3/AAL3/FAL3 — from the Digital Identity Worksheet] |
| **Operational Status**                | [Operational / Under Development / Major Modification]                  |
| **Fully Operational as of**           | [YYYY-MM-DD]                                                            |
| **Authorisation Boundary Diagram**    | [Reference: ARC-{P}-DIAG-NNN-v*]                                        |
| **Data Flow Diagram**                 | [Reference: ARC-{P}-DIAG-NNN-v*]                                        |

---

## Section 2 — System Categorization

[Cross-reference the FIPS 199 categorization artefact (`ARC-{P}-FIPS199-v*`).
Summarise the high-water mark and the driving information types.]

| CIA Objective                 | Impact Level                |
| ----------------------------- | --------------------------- |
| Confidentiality               | [Low / Moderate / High]     |
| Integrity                     | [Low / Moderate / High]     |
| Availability                  | [Low / Moderate / High]     |
| **Overall (High-Water Mark)** | **[LOW / MODERATE / HIGH]** |

---

## Section 3 — System Owner & Authorising Official

| Role                              | Name   | Title   | Organisation | Email   | Phone   |
| --------------------------------- | ------ | ------- | ------------ | ------- | ------- |
| System Owner                      | [Name] | [Title] | [Org]        | [Email] | [Phone] |
| Authorising Official (AO)         | [Name] | [Title] | [Org]        | [Email] | [Phone] |
| CSP Point of Contact (Technical)  | [Name] | [Title] | [CSP]        | [Email] | [Phone] |
| CSP Point of Contact (Management) | [Name] | [Title] | [CSP]        | [Email] | [Phone] |
| ISSO                              | [Name] | [Title] | [Org]        | [Email] | [Phone] |
| ISSM                              | [Name] | [Title] | [Org]        | [Email] | [Phone] |
| CISO                              | [Name] | [Title] | [Org]        | [Email] | [Phone] |
| 3PAO Lead                         | [Name] | [Title] | [3PAO firm]  | [Email] | [Phone] |

### Separation of Duties

[Security control AC-5. One row per duty, one column per role with access to the
system; mark X where a role performs the duty. Add roles and duties as the
system requires.]

| Duty                                            | Information Owner | Security Officer | Privacy Officer | System Administrator | Agency Administrator | Agency Customer |
| ----------------------------------------------- | ----------------- | ---------------- | --------------- | -------------------- | -------------------- | --------------- |
| Adds / removes privileged administrators        | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |
| Adds / removes non-privileged administrators    | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |
| Adds / removes customer administrators          | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |
| Enforces physical access authorisations         | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |
| Defines least privilege needed to perform tasks | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |
| Reviews / approves policy                       | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |
| Enforces policy                                 | [ ]               | [ ]              | [ ]             | [ ]                  | [ ]                  | [ ]             |

---

## Section 4 — System Description

### Concept of Operations

[Describe what the system does, how it serves federal agency customers, and the
operational model. Include the mission statement, primary use cases, and target
user populations.]

### Customer Use Cases

| Use Case ID | Description | Customer Type                  | Data Sensitivity       |
| ----------- | ----------- | ------------------------------ | ---------------------- |
| UC-001      | [Use case]  | [Federal civilian / DoD / SLT] | [Public / CUI / Other] |

### Customer Sectors Targeted

[Federal civilian, DoD, intelligence community, state/local/tribal, federal
contractors, etc.]

---

## Section 5 — System Environment

### Architecture Overview

[High-level narrative of the system architecture. Reference the
authorisation-boundary diagram and the data-flow diagram.]

**Authorisation Boundary Diagram**: [Embed or reference]

**Data Flow Diagram**: [Embed or reference]

### Components Inventory

| Component   | Function   | Vendor / Version   | Hosted In    | FedRAMP Inherited?      |
| ----------- | ---------- | ------------------ | ------------ | ----------------------- |
| [Component] | [Function] | [Vendor + version] | [CSP region] | [Yes — Package ID / No] |

### Hardware / Software / Network Inventory

[Reference the full hardware, software, and network inventory artefact
maintained per CM-8. Summarise the count of each asset class within the
authorisation boundary.]

---

## Section 6 — System Interconnections

### 6.1 Leveraged FedRAMP-Authorized Services

[Only services listed as Authorized on the FedRAMP Marketplace belong here; "In
Process" and "FedRAMP Ready" are not authorizations. Leverage services at the
same or a higher impact level.]

| CSP / CSO Name (as on the Marketplace) | Services and Features Used | Authorization Type and FedRAMP Package ID | Nature of Agreement     | Impact Level                      | Data Types             | Authorized Users / Authentication |
| -------------------------------------- | -------------------------- | ----------------------------------------- | ----------------------- | --------------------------------- | ---------------------- | --------------------------------- |
| [CSP / CSO]                            | [Services]                 | [Agency / JAB — FR-NNNNN]                 | [EULA / SLA / contract] | [High / Moderate / Low / LI-SaaS] | [SP 800-60 data types] | [Roles + authentication method]   |

### 6.2 External Systems and Services Without FedRAMP Authorization

[Every connection to a system, service, API or CLI that lacks a FedRAMP
authorization at the same or higher impact level, including corporate shared
services and update services. No overlap with 6.1.]

| System / Service / API / CLI | Category (Non-FedRAMP Cloud / Corporate Shared / Update Service) | Connection Details (Inbound / Outbound) | Data Types and Categorization        | Other Compliance Programs  | Risk / Impact / Mitigation                   |
| ---------------------------- | ---------------------------------------------------------------- | --------------------------------------- | ------------------------------------ | -------------------------- | -------------------------------------------- |
| [Name + vendor]              | [Category]                                                       | [Direction + method]                    | [Data types — Low / Moderate / High] | [SOC 2 / ISO 27001 / none] | [Risk if its CIA is compromised; mitigation] |

### 6.3 Boundary Interconnections

| Interconnected System | Owning Org | FedRAMP Package ID | Agreement (ICA / MOU / ISA) | Data Direction              | Ports / Protocols | Data Exchanged and Sensitivity | Authorisation Status |
| --------------------- | ---------- | ------------------ | --------------------------- | --------------------------- | ----------------- | ------------------------------ | -------------------- |
| [System]              | [Org]      | [FR-NNNNN / N/A]   | [ISA-NNN / MOU-NNN]         | [Inbound / Outbound / Both] | [TCP 443 / HTTPS] | [Data type + classification]   | [ATO date / Pending] |

[List every interconnection that crosses the authorisation boundary.]

---

## Section 7 — Applicable Laws and Regulations

| Citation                          | Title                                                                      | Applicability                                 |
| --------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| FISMA 2014                        | Federal Information Security Modernization Act                             | [Applies — all federal info systems]          |
| FedRAMP                           | Federal Risk and Authorization Management Program                          | [Applies — CSP authorisation]                 |
| EO 14028                          | Improving the Nation's Cybersecurity                                       | [Applies — secure software, SBOM, EDR]        |
| OMB M-22-09                       | Federal Zero Trust Strategy                                                | [Applies — ZTMM uplift required]              |
| OMB M-22-18                       | Enhancing the Security of the Software Supply Chain                        | [Applies — SSDF self-attestation]             |
| OMB M-23-16                       | Update on M-22-18 attestation                                              | [Applies — attestation deadlines + CISA form] |
| OMB M-24-10                       | Advancing Governance, Innovation, and Risk Management for Agency Use of AI | [Applies — if AI in use]                      |
| OMB M-25-21                       | Acquisition of AI in the Federal Government                                | [Applies — if AI procured]                    |
| Privacy Act of 1974 (5 USC §552a) | Privacy Act                                                                | [Applies — if SoR triggered]                  |
| E-Government Act §208             | Privacy Impact Assessment requirement                                      | [Applies — if PII processed]                  |
| FIPS 199 / FIPS 200               | Categorization + Minimum Security Requirements                             | [Applies]                                     |
| Agency-Specific                   | [Departmental policy citation]                                             | [Applies as overlay]                          |

---

## Section 8 — Minimum Security Controls

[Cross-reference the tailored 800-53 control set artefact (`ARC-{P}-NIST-v*`).
Summarise the baseline selection and the count of controls implemented /
inherited / hybrid / not-applicable / planned. The full Tailoring Matrix lives
in the 800-53 artefact; do not duplicate it here.]

| Source                                      | Count   |
| ------------------------------------------- | ------- |
| FedRAMP [Moderate / High] baseline controls | [Count] |
| Implemented                                 | [Count] |
| Inherited from CSP                          | [Count] |
| Hybrid                                      | [Count] |
| Planned (POA&M tracked)                     | [Count] |
| Not Applicable                              | [Count] |

### Control Origination and Customer Responsibility

[One row for every control that is not wholly Service Provider originated. This
feeds the FedRAMP CIS/CRM Workbook (Appendix J).]

| Control ID | Implementation Status             | Control Origination                                                                                                    | Customer Responsibility                                                |
| ---------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [AC-2]     | [Implemented / Partial / Planned] | [Service Provider Corporate / SP System Specific / Configured by Customer / Provided by Customer / Shared / Inherited] | [What the customer agency must do — required for every Shared control] |

---

## Section 9 — Types of Users

| User Role     | Description             | Internal / External   | Privileged?            | Clearance / Citizenship Requirement | Authentication Mechanism       | Authentication Assurance (IAL / AAL / FAL) | Training Required           |
| ------------- | ----------------------- | --------------------- | ---------------------- | ----------------------------------- | ------------------------------ | ------------------------------------------ | --------------------------- |
| [Role]        | [Description]           | [Internal / External] | [Yes / No]             | [None / Public Trust / US Persons]  | [PIV / login.gov / federated]  | [IAL2 / AAL2 / FAL2]                       | [Annual privacy + security] |
| Administrator | [System administration] | [Internal]            | [Yes]                  | [Per agency requirement]            | [PIV / phishing-resistant MFA] | [IAL3 / AAL3 / FAL2]                       | [Annual + role-specific]    |
| End User      | [Customer agency user]  | [External]            | [No]                   | [Per agency requirement]            | [PIV / federated]              | [IAL2 / AAL2 / FAL2]                       | [Agency-managed]            |
| Auditor       | [3PAO / IG]             | [External]            | [Read-only Privileged] | [Per agency requirement]            | [PIV / federated]              | [IAL3 / AAL3 / FAL2]                       | [Annual]                    |

---

## Section 10 — Network Architecture

### Subnet / Segmentation Diagram

[Reference diagram artefact. Show VPC / VNet, subnet tiers (public, private,
data), security groups, and trust zones.]

### Segmentation Strategy

| Zone             | Purpose               | Trust Level              | Inbound          | Outbound                   |
| ---------------- | --------------------- | ------------------------ | ---------------- | -------------------------- |
| Public DMZ       | [Load balancers, WAF] | [Low — Internet-exposed] | [HTTPS 443]      | [Restricted to app tier]   |
| Application Tier | [Workloads]           | [Moderate]               | [From DMZ only]  | [Data tier + egress proxy] |
| Data Tier        | [Databases]           | [High]                   | [App tier only]  | [None — except backup]     |
| Management Tier  | [Admin jump hosts]    | [High]                   | [VPN / SSO only] | [Restricted to mgmt plane] |

[Describe encryption-in-transit posture (TLS 1.2 minimum, TLS 1.3 preferred),
east-west encryption strategy, and any private-link / service-endpoint
configurations.]

### Services, Ports, and Protocols

[Every service, port and transport protocol enabled in the CSO (CM-7, CM-7(1)).
Keep it consistent with the diagrams and Section 6.]

| Service Name | Port # | Transport Protocol | Ref #                                      | Purpose      | Used By      |
| ------------ | ------ | ------------------ | ------------------------------------------ | ------------ | ------------ |
| [HTTPS]      | [443]  | [TCP]              | [Ref # in the cryptographic modules table] | [Web access] | [Components] |

### Cryptographic Modules for Data at Rest and Data in Transit

[Every place cryptography protects federal data: data at rest, data in transit
across and within the boundary, remote access and key management (SC-8, SC-8(1),
SC-13, SC-28, SC-28(1)). Raise a POA&M item for any area without FIPS
140-validated cryptography. Feeds FedRAMP Appendix Q.]

| Ref # | Data Area or Flow         | Source → Destination | Cryptographic Module    | FIPS 140 Certificate # | Approved Mode Confirmed? |
| ----- | ------------------------- | -------------------- | ----------------------- | ---------------------- | ------------------------ |
| [1]   | [Data at rest — database] | [N/A]                | [Module name + version] | [CMVP #NNNN]           | [Yes / No — POA&M ref]   |

---

## Section 11 — Control Implementations

For each control family, document implementation narratives. Full
control-by-control narrative lives in Appendix A or the OSCAL representation;
this section is a per-family summary.

NIST SP 800-53 Rev 5 has 20 control families. The FedRAMP Rev 5 baselines draw
their controls from 18 of them: they include no PM (Program Management) or PT
(PII Processing and Transparency) controls. Complete PM and PT only where the
sponsoring agency assigns those controls — FedRAMP treats PM as an agency
responsibility and leaves privacy controls to the agency, according to the data
the system holds.

### AC — Access Control

[Narrative summarising the family-level implementation: identity store, MFA
posture, account lifecycle, privileged access. Reference ICAM artefact.]

### AT — Awareness and Training

[Annual security + privacy training programme, role-based training, phishing
simulations.]

### AU — Audit and Accountability

[Audit log collection, SIEM, retention, SOC review cadence.]

### CA — Assessment, Authorization, and Monitoring

[Assessment cadence, ConMon plan, ATO timeline.]

### CM — Configuration Management

[Baseline configurations, change management, configuration drift detection.]

### CP — Contingency Planning

[Contingency plan, backups, DR exercises, RTO/RPO.]

### IA — Identification and Authentication

[IdP, MFA, FIPS 140-3 validated cryptographic modules.]

### IR — Incident Response

[IR plan, IR team, US-CERT reporting cadence, IR testing.]

### MA — Maintenance

[Maintenance windows, remote maintenance controls.]

### MP — Media Protection

[Media handling, sanitisation, encryption-at-rest.]

### PE — Physical and Environmental Protection

[Inherited from CSP — reference CSP physical security attestation.]

### PL — Planning

[SSP, ConMon plan, IR plan, contingency plan, configuration management plan.]

### PM — Program Management

[Information security programme, risk management strategy.]

### PS — Personnel Security

[Background checks, position risk designation, separation procedures.]

### PT — PII Processing and Transparency

[Cross-ref PIA artefact (`ARC-{P}-USPIA-v*`). Privacy notices, consent,
opt-out.]

### RA — Risk Assessment

[Risk assessment cadence, vulnerability scanning, threat modelling.]

### SA — System and Services Acquisition

[SDLC, secure development, supply-chain risk, EO 14028 SSDF self-attestation.]

### SC — System and Communications Protection

[Boundary protection, encryption, key management, DNSSEC.]

### SI — System and Information Integrity

[Flaw remediation, malware protection, monitoring, input validation.]

### SR — Supply Chain Risk Management

[SBOM, vendor assessment, EO 14028 attestations, FedRAMP-authorised
dependencies.]

---

## Section 12 — Configuration Management

| Element                             | Reference                            |
| ----------------------------------- | ------------------------------------ |
| Configuration Management Plan (CMP) | [Reference: CMP-NNN]                 |
| Baseline Configuration Definitions  | [DISA STIG / CIS Benchmarks Level 1] |
| Change Control Board                | [Cadence; voting members]            |
| Configuration Item (CI) Inventory   | [Reference]                          |
| Drift Detection Tool                | [Tool name]                          |
| Drift Review Frequency              | [Daily / Weekly]                     |

---

## Section 13 — Continuous Monitoring

| Activity                           | Frequency               | Reporting Audience        |
| ---------------------------------- | ----------------------- | ------------------------- |
| Authenticated vulnerability scan   | [Weekly]                | [SOC + AO]                |
| External / unauthenticated scan    | [Monthly]               | [SOC]                     |
| Web application scan               | [Monthly]               | [SOC + AppSec]            |
| Container image scan               | [Monthly / every build] | [SOC + Platform team]     |
| Database scan                      | [Monthly]               | [SOC + Data team]         |
| Configuration compliance scan      | [Quarterly]             | [Platform team + AO]      |
| Penetration test                   | [Annual]                | [AO + FedRAMP PMO]        |
| POA&M review                       | [Monthly]               | [AO + sponsoring agency]  |
| Annual assessment (1/3 controls)   | [Annual]                | [AO + 3PAO + FedRAMP PMO] |
| ConMon deliverables to FedRAMP PMO | [Monthly]               | [FedRAMP PMO]             |

[Cross-ref the POA&M artefact for open findings.]

---

## Section 14 — Appendices Inventory

The appendices the FedRAMP Rev 5 SSP template lists in its Section 12, with the
source of each. Appendices C, D, F, G, H and I are not required for LI-SaaS.

| Appendix | Document Title                                                                         | Source in This Plan | Location / Reference                          |
| -------- | -------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------- |
| A        | FedRAMP Security Controls (one template per baseline)                                  | Sections 8 and 11   | [ARC-{P}-NIST-v*] + [Appendix A file]         |
| B        | Related Acronyms                                                                       | —                   | [Reference]                                   |
| C        | Information Security Policies and Procedures                                           | —                   | [Reference]                                   |
| D        | User Guide                                                                             | —                   | [Reference]                                   |
| E        | Digital Identity Worksheet                                                             | Section 9           | [ARC-{P}-ICAM-v*]                             |
| F        | Rules of Behavior (RoB)                                                                | —                   | [Reference]                                   |
| G        | Information System Contingency Plan (ISCP)                                             | —                   | [Reference]                                   |
| H        | Configuration Management Plan (CMP)                                                    | Section 12          | [Reference]                                   |
| I        | Incident Response Plan (IRP)                                                           | —                   | [Reference]                                   |
| J        | Control Implementation Summary (CIS) and Customer Responsibility Matrix (CRM) Workbook | Section 8           | [Reference]                                   |
| K        | FIPS 199 Categorization                                                                | Section 2           | [ARC-{P}-FIPS199-v*]                          |
| L        | CSO-Specific Laws and Regulations                                                      | Section 7           | [Reference]                                   |
| M        | Integrated Inventory Workbook (IIW)                                                    | Section 5           | [Reference]                                   |
| N        | Continuous Monitoring Plan                                                             | Section 13          | [Reference]                                   |
| O        | Plan of Action and Milestones (POA&M)                                                  | Section 13          | [Reference]                                   |
| P        | Supply Chain Risk Management Plan (SCRMP)                                              | —                   | [Reference; SBOM evidence in ARC-{P}-SBOM-v*] |
| Q        | Cryptographic Modules Table                                                            | Section 10          | [Reference]                                   |

[The Rev 5 template has no Privacy Impact Assessment appendix. Where the agency
requires its E-Government Act §208 PIA alongside the package, reference it
separately: ARC-{P}-USPIA-v*.]

---

## References

| Reference                               | Citation                              | URL                                                                                      |
| --------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| FedRAMP SSP Template (Rev 5)            | FedRAMP System Security Plan Template | <https://www.fedramp.gov/documents-templates/>                                           |
| FedRAMP Authorization Boundary Guidance | Authorization Boundary Guidance       | <https://www.fedramp.gov/assets/resources/documents/Authorization_Boundary_Guidance.pdf> |
| NIST SP 800-37 Rev 2                    | Risk Management Framework             | <https://doi.org/10.6028/NIST.SP.800-37r2>                                               |
| NIST SP 800-53 Rev 5                    | Controls Catalog                      | <https://doi.org/10.6028/NIST.SP.800-53r5>                                               |
| NIST SP 800-18 Rev 1                    | Guide for Developing Security Plans   | <https://doi.org/10.6028/NIST.SP.800-18r1>                                               |

---

## Approvals

| Role                      | Name   | Signature   | Date         |
| ------------------------- | ------ | ----------- | ------------ |
| System Owner              | [Name] | [Signature] | [YYYY-MM-DD] |
| ISSO                      | [Name] | [Signature] | [YYYY-MM-DD] |
| ISSM                      | [Name] | [Signature] | [YYYY-MM-DD] |
| CISO                      | [Name] | [Signature] | [YYYY-MM-DD] |
| Authorising Official (AO) | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-fedramp-ssp` command **Generated on**:
[DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**:
[AI_MODEL]

<!-- arckit-overlay-template: us-fisma-categorization-template.md -->

# FIPS 199 System Categorization (NIST SP 800-60)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-fisma-categorization`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                         | Approved By | Approval Date |
| --------- | ------------ | --------- | --------------------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-fisma-categorization` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: system under categorization, mission criticality, the
FIPS 199 high-water mark determination (Low / Moderate / High), and a brief
justification linking the categorization to downstream control-baseline
selection in `/arckit:us-nist-800-53`.]

---

## 1. System Boundary Description

| Field                              | Value                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| **System Name**                    | [System name]                                                                |
| **System Acronym**                 | [Acronym used in agency inventory]                                           |
| **System Type**                    | [Major Application / General Support System / Minor Application]             |
| **Agency**                         | [Department / Agency]                                                        |
| **Bureau / Component**             | [Sub-agency]                                                                 |
| **System Owner**                   | [Name + role]                                                                |
| **Authorising Official (AO)**      | [Name + role]                                                                |
| **System Categorization Date**     | [YYYY-MM-DD]                                                                 |
| **Authorisation Boundary Diagram** | [Reference to diagram artefact — `ARC-{P}-DIAG-NNN-v*`]                      |
| **Cloud Service Provider(s)**      | [AWS GovCloud / Azure Government / GCP Assured Workloads / On-prem / Hybrid] |
| **FedRAMP Inheritance**            | [Yes — Package ID(s) / No]                                                   |

### Authorisation Boundary Narrative

[Describe what is in-scope and what is out-of-scope for this authorisation
boundary. List all components, networks, data stores, and supporting
infrastructure within the boundary. Identify any shared services or general
support systems the boundary inherits from.]

### Interconnections Summary

| Interconnected System | Owning Org | Connection Type              | Data Exchanged | ISA / MoU Reference |
| --------------------- | ---------- | ---------------------------- | -------------- | ------------------- |
| [System]              | [Org]      | [API / VPN / Direct Connect] | [Data type]    | [Reference]         |

---

## 2. Information Types Inventory

Categorize each information type processed, stored, or transmitted by the system
per NIST SP 800-60 Vol 2 Rev 1.

| SP 800-60 Type ID | Description                            | Confidentiality | Integrity  | Availability | Rationale                                 |
| ----------------- | -------------------------------------- | --------------- | ---------- | ------------ | ----------------------------------------- |
| C.2.8.12          | [General Information — Public Affairs] | [Low]           | [Low]      | [Low]        | [Public-facing information; no PII]       |
| C.3.5.1           | [Personal Identity and Authentication] | [Moderate]      | [Moderate] | [Low]        | [Contains PII used for identity proofing] |
| C.3.5.8           | [Income Information]                   | [Moderate]      | [Moderate] | [Low]        | [Financial PII; harm if disclosed]        |
| D.14.2            | [System Development]                   | [Low]           | [Moderate] | [Low]        | [Internal development artefacts]          |

[Add additional rows for every information type the system processes. Reference
SP 800-60 Vol 2 Rev 1 Appendix C / D for the canonical type catalogue.]

---

## 3. CIA Impact Matrix per Information Type

Summarise the per-type CIA scores and the resulting per-type high-water mark.

| Information Type        | C       | I       | A       | Type High-Water Mark | Notes   |
| ----------------------- | ------- | ------- | ------- | -------------------- | ------- |
| [Type ID — Description] | [L/M/H] | [L/M/H] | [L/M/H] | [L/M/H]              | [Notes] |

---

## 4. High-Water-Mark Categorization

| CIA Objective       | Impact Level            | Driving Information Type(s) |
| ------------------- | ----------------------- | --------------------------- |
| **Confidentiality** | [Low / Moderate / High] | [Type ID(s)]                |
| **Integrity**       | [Low / Moderate / High] | [Type ID(s)]                |
| **Availability**    | [Low / Moderate / High] | [Type ID(s)]                |

**Overall System Categorization (High-Water Mark)**: **[LOW / MODERATE / HIGH]**

[Narrative justification: the overall categorization is driven by the highest
impact level across any single CIA objective for any single information type
processed by the system. Explain which type drives the mark and why.]

---

## 5. Supporting Rationale

### Confidentiality Rationale

[Why this impact level was selected. Reference unauthorised disclosure
scenarios, regulatory citations (Privacy Act, HIPAA, CUI categories), and
business-impact narratives.]

### Integrity Rationale

[Why this impact level was selected. Reference unauthorised modification
scenarios, data-trust requirements, and downstream-system dependencies on data
quality.]

### Availability Rationale

[Why this impact level was selected. Reference outage tolerance, mission impact
of unavailability, RTO/RPO requirements, and downstream-system dependencies.]

---

## 6. Agency-Specific Overlays

[Identify any departmental or bureau tailoring that adjusts the categorization
above the FIPS 199 default. Common drivers include CUI safeguarding obligations
(NIST SP 800-171), agency-specific high-value-asset (HVA) designation, OMB
Circular A-130 special factors, and mission-specific overlays.]

| Overlay Source            | Tailoring Applied | Justification   |
| ------------------------- | ----------------- | --------------- |
| [Agency policy reference] | [Adjustment]      | [Justification] |

---

## 7. References

| Reference                  | Citation                                                                              | URL                                              |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| FIPS 199                   | Standards for Security Categorization of Federal Information and Information Systems  | <https://doi.org/10.6028/NIST.FIPS.199>          |
| NIST SP 800-60 Vol 1 Rev 1 | Guide for Mapping Types of Information and Information Systems to Security Categories | <https://doi.org/10.6028/NIST.SP.800-60v1r1>     |
| NIST SP 800-60 Vol 2 Rev 1 | Appendices to Guide for Mapping Types of Information                                  | <https://doi.org/10.6028/NIST.SP.800-60v2r1>     |
| NIST SP 800-37 Rev 2       | Risk Management Framework for Information Systems and Organizations                   | <https://doi.org/10.6028/NIST.SP.800-37r2>       |
| OMB Circular A-130         | Managing Information as a Strategic Resource                                          | <https://www.whitehouse.gov/omb/circulars-a130/> |

---

## 8. Approvals

| Role                                      | Name   | Signature   | Date         |
| ----------------------------------------- | ------ | ----------- | ------------ |
| System Owner                              | [Name] | [Signature] | [YYYY-MM-DD] |
| Senior Agency Official for Privacy (SAOP) | [Name] | [Signature] | [YYYY-MM-DD] |
| Authorising Official (AO)                 | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-fisma-categorization` command **Generated
on**: [DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME]
**Model**: [AI_MODEL]

<!-- arckit-overlay-template: us-icam-template.md -->

# ICAM Architecture (OMB M-19-17 / NIST SP 800-63-3)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-icam`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                         | Approved By | Approval Date |
| --------- | ------------ | --------- | ----------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-icam` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: scope of the ICAM design, target user populations
(employees, contractors, citizens, partners), federation pattern, IAL/AAL/FAL
targets, and key implementation decisions (PIV vs derived credentials, login.gov
vs Entra ID Gov, SAML vs OIDC).]

---

## 1. Identity Use Cases

| Use Case ID | Description                             | User Population        | IAL  | AAL  | FAL  | Rationale                                                            |
| ----------- | --------------------------------------- | ---------------------- | ---- | ---- | ---- | -------------------------------------------------------------------- |
| UC-001      | Federal employee SSO to internal apps   | [Federal employees]    | IAL3 | AAL3 | FAL2 | [PIV-mandated by HSPD-12; AAL3 driven by privileged data access]     |
| UC-002      | Contractor SSO to internal apps         | [Contractors]          | IAL3 | AAL3 | FAL2 | [PIV-I or equivalent per HSPD-12 contractor guidance]                |
| UC-003      | Public citizen account on agency portal | [Citizens]             | IAL2 | AAL2 | FAL2 | [Verified citizen identity required for benefits; login.gov default] |
| UC-004      | Partner agency federation               | [Partner agency staff] | IAL3 | AAL2 | FAL2 | [Inter-agency federation; partner asserts IAL]                       |
| UC-005      | Privileged administrator                | [Internal IT admins]   | IAL3 | AAL3 | FAL2 | [Phishing-resistant MFA; just-in-time elevation]                     |

---

## 2. Identity Proofing Flow

### 2.1 Federal Employees and Contractors

[For federal employees, identity proofing is performed during PIV enrolment per
FIPS 201-3. Reference the agency's HSPD-12 sponsor / registrar / issuer roles.
Derived PIV credentials (NIST SP 800-157) may be issued for mobile devices once
the primary PIV is established.]

```text
Sponsor → Registrar (proofing — I-9 docs, biometrics) → Issuer (PIV card) → Activator → Cardholder
```

### 2.2 Public Citizens (login.gov)

[Identity proofing for citizen-facing systems is performed by login.gov per
GSA's IAL2 process. Agencies do not perform direct identity proofing for the
public.]

```text
Citizen → login.gov account creation → IAL2 proofing (ID upload + selfie or in-person USPS PostalProof) → AAL2 authenticator binding → Agency RP receives proofed assertion
```

---

## 3. Identity Provider Selection

| IdP Option                             | Use Case                                      | Rationale                                                                     | Status               |
| -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | -------------------- |
| **PIV / PIV-D (agency PKI)**           | Federal employees + contractors               | [Mandated by HSPD-12; provides AAL3 phishing-resistant authenticator]         | [Selected — primary] |
| **login.gov**                          | Public citizens                               | [GSA-operated; IAL2 + AAL2 default; no agency-side proofing burden]           | [Selected — citizen] |
| **Microsoft Entra ID Government**      | Federal employees if Microsoft-centric agency | [Tight integration with M365 GCC / GCC-High; supports FIDO2 + PIV federation] | [Conditional]        |
| **Okta Identity Cloud for Government** | Federal employees                             | [FedRAMP-Moderate authorised; broad SaaS connector library]                   | [Conditional]        |
| **Agency-internal SAML / OIDC IdP**    | Bespoke internal use                          | [When PIV is the trust anchor but additional attribute store needed]          | [Conditional]        |

[Document the selected IdP per use case with FedRAMP authorisation reference,
supported authenticators, and any custom claims required.]

---

## 4. PIV Integration Architecture (Federal Employees)

| Element                                | Selection                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------- |
| **Primary credential**                 | [PIV card per FIPS 201-3]                                                 |
| **Mobile credential**                  | [Derived PIV per NIST SP 800-157 / SP 800-157A]                           |
| **Card lifecycle**                     | [Agency HSPD-12 issuer; revocation via OCSP / CRL]                        |
| **Federation point**                   | [Agency SAML IdP fronting PIV; or direct PIV-Auth via PKINIT to Entra ID] |
| **Browser support**                    | [Smart-card middleware: ActivClient / native macOS / Linux pcsc-lite]     |
| **Derived credential issuer**          | [Agency-internal CA or commercial issuer (Entrust, IdenTrust, etc.)]      |
| **Fallback for PIV-incompatible apps** | [Reverse-proxy with PIV-to-OIDC bridge]                                   |

---

## 5. login.gov Integration Architecture (Public Citizens)

| Element                         | Selection                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| **Federation protocol**         | [SAML 2.0 or OIDC — OIDC preferred for new integrations]                            |
| **IAL target**                  | [IAL1 (no proofing) / IAL2 (verified)]                                              |
| **AAL target**                  | [AAL2]                                                                              |
| **Attribute mapping**           | [email, sub, given_name, family_name, ssn (IAL2), birthdate (IAL2), address (IAL2)] |
| **Account linking strategy**    | [login.gov sub claim as primary key; legacy account migration plan]                 |
| **PII minimisation**            | [Request only attributes the agency needs; document lawful authority for each]      |
| **Sandbox URL**                 | [https://idp.int.identitysandbox.gov/]                                              |
| **Production URL**              | [https://secure.login.gov/]                                                         |
| **Integration agreement (IAA)** | [GSA login.gov IAA reference]                                                       |

---

## 6. Federation Pattern

| Pattern                                    | Choice                                         | Rationale                                                |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| **Employee → Internal apps**               | [SAML 2.0 / OIDC]                              | [SAML where SaaS support is mature; OIDC for new builds] |
| **Citizen → Citizen-facing apps**          | [OIDC]                                         | [login.gov OIDC support; mobile-friendly]                |
| **Inter-agency federation**                | [SAML 2.0]                                     | [FICAM Trust Framework Solutions (TFS) certified]        |
| **Workload identity (service-to-service)** | [SPIFFE / mTLS / OAuth 2.0 client_credentials] | [Per Zero Trust apps & workloads pillar]                 |

---

## 7. Credential Lifecycle

| Stage          | Process                                                                        | Owner                           |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| **Issuance**   | [PIV: HSPD-12 enrolment; login.gov: GSA-managed; agency: IT onboarding]        | [HSPD-12 issuer / GSA / IT ops] |
| **Activation** | [In-person PIV activation; login.gov: self-service email + phone]              | [Cardholder / user]             |
| **Use**        | [Daily authentication; MFA challenge per AAL]                                  | [User]                          |
| **Suspension** | [Lost-card / compromised-credential workflow; immediate OCSP revocation]       | [HSPD-12 issuer / login.gov]    |
| **Revocation** | [Separation, role-change-to-non-eligible, fraud — irreversible]                | [HSPD-12 issuer]                |
| **Recovery**   | [Reissue per agency policy; identity proofing repeated if > 12 months elapsed] | [HSPD-12 issuer / login.gov]    |

---

## 8. Privileged Access Management (PAM)

| Capability                 | Implementation                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| **Break-glass accounts**   | [Documented owners; checked into vault; alarm on use; quarterly review] |
| **Just-in-time elevation** | [PAM tool with approval workflow; max session 4 hours]                  |
| **MFA for privileged**     | [Phishing-resistant AAL3 — PIV or FIDO2 WebAuthn only; no SMS / TOTP]   |
| **Session recording**      | [Full keystroke + video for privileged sessions; retain ≥ 1 year]       |
| **Vaulted credentials**    | [PAM vault — service-account creds rotated daily; never in scripts]     |
| **Logging**                | [PAM logs forwarded to SIEM; SOC alert on anomalous patterns]           |

---

## 9. Compliance to NIST SP 800-63-3

### Volume A (Identity Proofing)

| Requirement                                        | IAL2 Status | IAL3 Status               |
| -------------------------------------------------- | ----------- | ------------------------- |
| Identity evidence (strong + superior or 2× strong) | [Met / Gap] | [N/A — IAL3 via PIV]      |
| Address confirmation                               | [Met / Gap] | [N/A]                     |
| Knowledge-based verification (where used)          | [Met / Gap] | [N/A]                     |
| Biometric capture (IAL3)                           | [N/A]       | [Met / Gap]               |
| Trusted referee allowed                            | [Yes / No]  | [Yes — supervised remote] |

### Volume B (Authenticators and Lifecycle)

| Requirement                                                | AAL2 Status   | AAL3 Status                       |
| ---------------------------------------------------------- | ------------- | --------------------------------- |
| Multi-factor (something you have + something you know/are) | [Met]         | [Met]                             |
| Phishing resistance                                        | [Recommended] | [Required — PIV / FIDO2 WebAuthn] |
| Verifier-impersonation resistance                          | [Recommended] | [Required]                        |
| Replay resistance                                          | [Required]    | [Required]                        |
| Cryptographic authenticator                                | [Recommended] | [Required]                        |

### Volume C (Federation Assertion)

| Requirement                                | FAL2 Status                         |
| ------------------------------------------ | ----------------------------------- |
| Bearer assertion with audience restriction | [Met / Gap]                         |
| Encrypted assertion (or transport TLS)     | [Met — TLS 1.2+]                    |
| Holder-of-key assertion (FAL3)             | [Conditional — only where required] |
| Replay protection on assertion             | [Met]                               |

---

## 10. Compliance Crosswalk

| Framework Requirement                | ICAM Element Satisfying                  |
| ------------------------------------ | ---------------------------------------- |
| OMB M-19-17 — ICAM modernisation     | [Federation architecture; IdP selection] |
| OMB M-22-09 — phishing-resistant MFA | [PIV + FIDO2 mandate]                    |
| HSPD-12                              | [PIV issuance per FIPS 201-3]            |
| FIPS 201-3                           | [PIV card spec]                          |
| NIST SP 800-63-3                     | [IAL / AAL / FAL targets]                |
| NIST SP 800-157 / 157A               | [Derived PIV]                            |

---

## 11. References

| Reference                | Citation                                                                               | URL                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OMB M-19-17              | Enabling Mission Delivery through Improved Identity, Credential, and Access Management | <https://www.whitehouse.gov/wp-content/uploads/2019/05/M-19-17.pdf> |
| NIST SP 800-63-3         | Digital Identity Guidelines                                                            | <https://pages.nist.gov/800-63-3/>                                  |
| NIST SP 800-63A          | Enrollment and Identity Proofing                                                       | <https://pages.nist.gov/800-63-3/sp800-63a.html>                    |
| NIST SP 800-63B          | Authentication and Lifecycle Management                                                | <https://pages.nist.gov/800-63-3/sp800-63b.html>                    |
| NIST SP 800-63C          | Federation and Assertions                                                              | <https://pages.nist.gov/800-63-3/sp800-63c.html>                    |
| FIPS 201-3               | Personal Identity Verification (PIV) of Federal Employees and Contractors              | <https://doi.org/10.6028/NIST.FIPS.201-3>                           |
| NIST SP 800-157          | Derived PIV Credentials                                                                | <https://doi.org/10.6028/NIST.SP.800-157>                           |
| login.gov developer docs | login.gov developer documentation                                                      | <https://developers.login.gov/>                                     |
| FICAM                    | Federal Identity, Credential, and Access Management                                    | <https://www.idmanagement.gov/>                                     |

---

## 12. Approvals

| Role                   | Name   | Signature   | Date         |
| ---------------------- | ------ | ----------- | ------------ |
| ICAM Programme Lead    | [Name] | [Signature] | [YYYY-MM-DD] |
| CISO                   | [Name] | [Signature] | [YYYY-MM-DD] |
| Privacy Officer (SAOP) | [Name] | [Signature] | [YYYY-MM-DD] |
| CIO                    | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-icam` command **Generated on**: [DATE]
**ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**: [AI_MODEL]

<!-- arckit-overlay-template: us-nist-800-53-template.md -->

# NIST SP 800-53 Rev 5 Tailored Control Set

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-nist-800-53`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-nist-800-53` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: scope of the tailored control set, the baseline
selected (Low / Moderate / High), the catalog used (FedRAMP Rev 5 vs Agency Rev
5), summary of inherited vs implemented controls, and any significant tailoring
decisions (controls added, removed, or compensated).]

---

## 1. Baseline Selection

| Field                          | Value                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| **FIPS 199 High-Water Mark**   | [LOW / MODERATE / HIGH — cross-ref `ARC-{P}-FIPS199-v*`]                            |
| **Selected Control Baseline**  | [Low / Moderate / High]                                                             |
| **Baseline Source**            | [NIST SP 800-53B / FedRAMP Rev 5 / Agency Overlay]                                  |
| **Catalog Version**            | [NIST SP 800-53 Rev 5.1.1 / FedRAMP Rev 5 Baselines vNN]                            |
| **Total Controls in Baseline** | [Count]                                                                             |
| **Tailoring Rationale**        | [Brief narrative — why this baseline matches the system's risk profile and mission] |

---

## 2. FedRAMP vs Agency Baseline

| Aspect                              | Selection                               | Rationale                                                                                                   |
| ----------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Catalog tailored against**        | [FedRAMP Rev 5 / Agency Rev 5 / Hybrid] | [Why]                                                                                                       |
| **CSP-hosted?**                     | [Yes — CSP name / No]                   | [If CSP-hosted and pursuing FedRAMP authorisation, the FedRAMP baseline is the canonical tailoring source.] |
| **Agency-specific overlay applied** | [Yes — overlay reference / No]          | [E.g., DoD CC SRG IL2/IL4/IL5, IRS Pub 1075, CJIS, HHS ePHI]                                                |

---

## 3. Control Family Summary

| Family Code | Family Name                               | Baseline Controls | Implemented | Inherited | Hybrid  | Not Applicable | Planned |
| ----------- | ----------------------------------------- | ----------------- | ----------- | --------- | ------- | -------------- | ------- |
| AC          | Access Control                            | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| AT          | Awareness and Training                    | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| AU          | Audit and Accountability                  | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| CA          | Assessment, Authorization, and Monitoring | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| CM          | Configuration Management                  | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| CP          | Contingency Planning                      | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| IA          | Identification and Authentication         | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| IR          | Incident Response                         | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| MA          | Maintenance                               | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| MP          | Media Protection                          | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| PE          | Physical and Environmental Protection     | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| PL          | Planning                                  | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| PM          | Program Management                        | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| PS          | Personnel Security                        | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| PT          | PII Processing and Transparency           | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| RA          | Risk Assessment                           | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| SA          | System and Services Acquisition           | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| SC          | System and Communications Protection      | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| SI          | System and Information Integrity          | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |
| SR          | Supply Chain Risk Management              | [Count]           | [Count]     | [Count]   | [Count] | [Count]        | [Count] |

---

## 4. Tailoring Matrix

| Control ID | Control Title                                        | Baseline | Implementation Status | Inheritance Source                  | Parameter Assignments                                              | Compensating Controls | Notes                                           |
| ---------- | ---------------------------------------------------- | -------- | --------------------- | ----------------------------------- | ------------------------------------------------------------------ | --------------------- | ----------------------------------------------- |
| AC-2       | Account Management                                   | [Mod]    | [Implemented]         | [N/A]                               | [Account types: Individual, Shared, Service, Application]          | [None]                | [Cross-ref ICAM artefact]                       |
| AC-2(2)    | Automated Temporary and Emergency Account Management | [Mod]    | [Implemented]         | [N/A]                               | [Org-defined period: 30 days]                                      | [None]                | [Inactive accounts disabled at 30 days]         |
| AC-17      | Remote Access                                        | [Mod]    | [Hybrid]              | [CSP: AWS GovCloud — VPN substrate] | [Authorised remote access: VPN, BeyondCorp]                        | [None]                | [Customer responsibility: device posture]       |
| AU-2       | Event Logging                                        | [Mod]    | [Implemented]         | [Partial — CSP logs network plane]  | [Auditable events: §AU-2.a]                                        | [None]                | [Cross-ref ConMon plan]                         |
| AU-6       | Audit Record Review, Analysis, and Reporting         | [Mod]    | [Implemented]         | [N/A]                               | [Review frequency: daily; reporting: weekly to SOC]                | [None]                | [SIEM-driven; alerts triaged in-platform]       |
| CM-6       | Configuration Settings                               | [Mod]    | [Implemented]         | [N/A]                               | [Common Secure Configurations: DISA STIG / CIS Benchmarks Level 1] | [None]                | [Compliance scanner: quarterly]                 |
| CP-9       | System Backup                                        | [Mod]    | [Inherited]           | [CSP: AWS Backup cross-region]      | [Frequency: daily; retention: 90 days]                             | [None]                | [Customer validates restore quarterly]          |
| IA-2(1)    | MFA to Privileged Accounts                           | [Mod]    | [Implemented]         | [N/A]                               | [Phishing-resistant authenticator required]                        | [None]                | [Cross-ref Zero Trust Identity pillar]          |
| IR-4       | Incident Handling                                    | [Mod]    | [Implemented]         | [N/A]                               | [Incident response plan reference]                                 | [None]                | [US-CERT reporting: 1 hour]                     |
| RA-5       | Vulnerability Monitoring and Scanning                | [Mod]    | [Implemented]         | [N/A]                               | [Scan frequency: weekly authenticated; monthly external]           | [None]                | [Cross-ref ConMon]                              |
| SC-7       | Boundary Protection                                  | [Mod]    | [Hybrid]              | [CSP: AWS WAF / Shield]             | [Egress filtering: deny-by-default]                                | [None]                | [Customer responsibility: WAF rules]            |
| SI-2       | Flaw Remediation                                     | [Mod]    | [Implemented]         | [N/A]                               | [Patch windows: High = 30 days, Med = 90 days]                     | [None]                | [Tracked via vulnerability-management platform] |

[Continue for every control in the baseline. For inherited controls, identify
the FedRAMP-authorised CSP and the customer responsibility carry-over per the
CRM.]

---

## 5. Parameter Assignments by Family

### AC — Access Control

| Control | Parameter                            | Org-Defined Value                |
| ------- | ------------------------------------ | -------------------------------- |
| AC-2(2) | Account inactivity period            | [30 days]                        |
| AC-2(3) | Disable accounts after inactivity    | [60 days]                        |
| AC-7    | Failed login attempts                | [5 attempts; lockout 15 minutes] |
| AC-11   | Session lock after inactivity        | [15 minutes]                     |
| AC-12   | Session termination after inactivity | [60 minutes]                     |

### AU — Audit and Accountability

| Control | Parameter                  | Org-Defined Value                           |
| ------- | -------------------------- | ------------------------------------------- |
| AU-4    | Audit log storage capacity | [Retain online ≥ 90 days; archive ≥ 1 year] |
| AU-5    | Audit failure response     | [Alert SOC; shift to backup logging]        |
| AU-11   | Audit record retention     | [3 years per NARA / agency schedule]        |

### CP — Contingency Planning

| Control | Parameter                          | Org-Defined Value                            |
| ------- | ---------------------------------- | -------------------------------------------- |
| CP-2    | Contingency plan review frequency  | [Annual + after material change]             |
| CP-4    | Contingency plan testing frequency | [Annual tabletop + every 3 years functional] |
| CP-9    | Backup frequency                   | [Daily incremental; weekly full]             |

### IA — Identification and Authentication

| Control | Parameter           | Org-Defined Value                       |
| ------- | ------------------- | --------------------------------------- |
| IA-2    | MFA assurance level | [AAL2 standard users / AAL3 privileged] |
| IA-5    | Password complexity | [NIST SP 800-63B Section 5.1.1.2]       |

### IR — Incident Response

| Control | Parameter                            | Org-Defined Value                          |
| ------- | ------------------------------------ | ------------------------------------------ |
| IR-2    | Incident response training frequency | [Annual + on role change]                  |
| IR-3    | Incident response testing frequency  | [Annual + after major change]              |
| IR-6    | Incident reporting timeframes        | [US-CERT: 1 hour; Agency CISO: 30 minutes] |

### SI — System and Information Integrity

| Control | Parameter                   | Org-Defined Value                                       |
| ------- | --------------------------- | ------------------------------------------------------- |
| SI-2    | Flaw remediation timeframes | [Critical = 15 days; High = 30 days; Med = 90 days]     |
| SI-4    | System monitoring           | [Continuous (24/7); detection signatures updated daily] |

---

## 6. Compensating Controls Register

When a baseline control cannot be implemented as written, document the
alternative.

| Control ID | Reason Not Implemented | Compensating Control | Equivalent Risk Mitigation | Owner  | Approval      |
| ---------- | ---------------------- | -------------------- | -------------------------- | ------ | ------------- |
| [Control]  | [Reason]               | [Alternative]        | [Equivalence narrative]    | [Role] | [AO sign-off] |

---

## 7. Cloud Service Provider Inheritance

### Inherited FedRAMP-Authorised Services

| CSP                | Service   | FedRAMP Authorisation ID | Baseline          | Customer Responsibility Matrix Reference |
| ------------------ | --------- | ------------------------ | ----------------- | ---------------------------------------- |
| [AWS GovCloud]     | [Service] | [FR-MOD-NNNNN]           | [Moderate / High] | [CRM URL / artefact]                     |
| [Azure Government] | [Service] | [FR-MOD-NNNNN]           | [Moderate / High] | [CRM URL / artefact]                     |

### Customer Responsibility Matrix (Summary)

| Control Family | Provider Provides           | Customer Configures                             | Joint                      |
| -------------- | --------------------------- | ----------------------------------------------- | -------------------------- |
| AC             | [Authentication primitives] | [Account lifecycle, role definitions]           | [SSO integration]          |
| AU             | [Network plane logs]        | [Application-tier logs, retention]              | [Aggregation]              |
| SC             | [Encryption primitives]     | [Encryption-key policy, certificate management] | [WAF rules]                |
| SI             | [Patching the platform]     | [Patching customer workloads]                   | [Vulnerability disclosure] |

[Full CRM mapping per inherited CSP referenced in `external/` or vendor portal.]

---

## 8. Continuous Monitoring Strategy Summary

| Activity                           | Frequency                  | Owner           | Output              |
| ---------------------------------- | -------------------------- | --------------- | ------------------- |
| Authenticated vulnerability scan   | [Weekly]                   | [SOC / SecOps]  | [Scan report]       |
| External attack-surface scan       | [Monthly]                  | [SOC]           | [External scan]     |
| Configuration compliance scan      | [Quarterly]                | [Platform team] | [Drift report]      |
| POA&M review                       | [Monthly]                  | [ISSO]          | [POA&M update]      |
| Control assessment (annual subset) | [Annual — 1/3 of controls] | [AO + 3PAO]     | [Assessment report] |
| Penetration test                   | [Annual]                   | [3PAO]          | [Pentest report]    |

[Cross-ref `/arckit:us-fedramp-ssp` Section 13 for full ConMon plan.]

---

## 9. References

| Reference               | Citation                                                                | URL                                            |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| NIST SP 800-53 Rev 5    | Security and Privacy Controls for Information Systems and Organizations | <https://doi.org/10.6028/NIST.SP.800-53r5>     |
| NIST SP 800-53B         | Control Baselines for Information Systems and Organizations             | <https://doi.org/10.6028/NIST.SP.800-53B>      |
| FedRAMP Rev 5 Baselines | FedRAMP Moderate / High / Low Baselines                                 | <https://www.fedramp.gov/baselines/>           |
| OSCAL                   | Open Security Controls Assessment Language                              | <https://pages.nist.gov/OSCAL/>                |
| FedRAMP CRM Template    | Customer Responsibility Matrix Template                                 | <https://www.fedramp.gov/documents-templates/> |

---

## 10. Approvals

| Role                                       | Name   | Signature   | Date         |
| ------------------------------------------ | ------ | ----------- | ------------ |
| System Owner                               | [Name] | [Signature] | [YYYY-MM-DD] |
| Information System Security Officer (ISSO) | [Name] | [Signature] | [YYYY-MM-DD] |
| Authorising Official (AO)                  | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-nist-800-53` command **Generated on**:
[DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**:
[AI_MODEL]

<!-- arckit-overlay-template: us-privacy-pia-template.md -->

# Privacy Impact Assessment (E-Government Act §208)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-privacy-pia`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-privacy-pia` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: system being assessed, PII processed, lawful
authority, Privacy Act applicability (SoR? new SORN required?), residual privacy
risks, and SAOP sign-off status.]

---

## 1. System Overview

| Field                                           | Value                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| **System Name**                                 | [Name]                                                                       |
| **System Acronym**                              | [Acronym]                                                                    |
| **Agency**                                      | [Agency]                                                                     |
| **Bureau / Component**                          | [Bureau]                                                                     |
| **System Owner**                                | [Name + role]                                                                |
| **Senior Agency Official for Privacy (SAOP)**   | [Name + role]                                                                |
| **Project Phase**                               | [Initiation / Development / Operations / Decommissioned]                     |
| **Project Purpose**                             | [What the system does]                                                       |
| **PIA Trigger**                                 | [New system / Substantial change / Periodic review / Privacy Act SoR change] |
| **Cross-ref FIPS 199 Categorization**           | [ARC-{P}-FIPS199-v*]                                                         |
| **Cross-ref AI Impact Assessment (if AI used)** | [ARC-{P}-AIIA-v*]                                                            |
| **Assessment Date**                             | [YYYY-MM-DD]                                                                 |

---

## 2. PII Inventory

| Data Element                                  | Source                                        | Lawful Authority                      | Use                                          | Disclosure                                   | Retention                                           | Disposal Method                                                     |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------------------- | -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Full name                                     | [Individual / agency partner]                 | [Statutory citation]                  | [Identity proofing; correspondence]          | [Internal only; SOR routine use #1]          | [Per NARA schedule N1-NNN]                          | [Cryptographic erasure]                                             |
| Social Security Number (SSN)                  | [Individual / IRS / SSA]                      | [E.g., 26 USC §6109; Pub L 93-579 §7] | [Benefits eligibility verification]          | [SSA matching agreement; SOR routine use #2] | [7 years post-decision]                             | [Cryptographic erasure + NIST SP 800-88 sanitisation]               |
| Date of birth                                 | [Individual]                                  | [Statutory citation]                  | [Identity proofing; eligibility]             | [Internal only]                              | [Per NARA schedule N1-NNN]                          | [Cryptographic erasure]                                             |
| Residential address                           | [Individual]                                  | [Statutory citation]                  | [Correspondence; jurisdictional eligibility] | [USPS for mailing only]                      | [Per NARA schedule N1-NNN]                          | [Cryptographic erasure]                                             |
| Email address                                 | [Individual]                                  | [Statutory citation]                  | [Service notifications; account recovery]    | [None — internal only]                       | [Per NARA schedule N1-NNN]                          | [Cryptographic erasure]                                             |
| Biometric data (facial template, fingerprint) | [Individual via login.gov / agency enrolment] | [HSPD-12 / agency-specific authority] | [Identity proofing IAL3]                     | [None — held only by issuer]                 | [Per FIPS 201-3 — lifetime of credential + N years] | [Crypto-erasure + physical destruction of biometric template store] |

[Add additional rows for every PII element processed.]

---

## 3. Lawful Authority

| Authority Type          | Citation                                                  | Applies To                         |
| ----------------------- | --------------------------------------------------------- | ---------------------------------- |
| Statute                 | [E.g., 5 USC §301; 31 USC §3101; agency enabling statute] | [Collection of named PII elements] |
| Executive Order         | [EO citation]                                             | [Specific elements / processing]   |
| Agency Regulation       | [CFR citation]                                            | [Specific processing]              |
| OMB Memorandum          | [OMB memo citation]                                       | [Specific processing]              |
| Privacy Act Routine Use | [SOR citation + routine use number]                       | [Specific disclosures]             |

[Document the complete legal basis for each PII collection and processing
activity.]

---

## 4. Privacy Act (5 USC §552a) Alignment

| Question                                                 | Answer                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Is this a System of Records (SoR) under the Privacy Act? | [Yes / No]                                                                                     |
| If Yes, applicable SORN(s)                               | [Agency-XX-NNN; published Federal Register YYYY-MM-DD]                                         |
| If Yes, are records retrieved by personal identifier?    | [Yes — identifiers listed]                                                                     |
| If new SoR being created — SORN drafting plan            | [Target Federal Register publication date; OMB / Congressional notice 60-day clock start date] |
| If existing SoR being modified — modification plan       | [Modified SORN draft; OMB / Congressional notice timing]                                       |
| Privacy Act §(e)(3) notice provided at collection?       | [Yes — notice text linked / No — justification]                                                |
| Privacy Act §(e)(10) safeguards?                         | [Cross-ref security controls in 800-53 artefact]                                               |
| Routine uses documented?                                 | [Yes — list / No — gap to close]                                                               |

[A SORN is required for any system of records covered by the Privacy Act before
any record can be collected. Plan the publication timeline accordingly.]

---

## 5. SORN Trigger Check (OMB M-03-22 Decision Tree)

| Question                                                                                        | Answer                 |
| ----------------------------------------------------------------------------------------------- | ---------------------- |
| 1. Does the system collect, maintain, use, or disseminate information about individuals?        | [Yes / No]             |
| 2. Is the information about _federal employees, federal contractors, or members of the public_? | [Yes / No]             |
| 3. Will records be retrieved by a personal identifier (name, SSN, biometric, employee ID)?      | [Yes / No]             |
| 4. Is this system already covered by an existing published SORN?                                | [Yes — cite SORN / No] |

**SORN Outcome**: [No new SORN required (covered by existing SORN X) / Existing
SORN modification required / New SORN required] — [Rationale]

---

## 6. OMB M-03-22 Conformance Checklist

| Privacy Principle                                   | Status      | Evidence                             | Gap   | Action   |
| --------------------------------------------------- | ----------- | ------------------------------------ | ----- | -------- |
| Notice                                              | [Met / Gap] | [Notice text + posting location]     | [Gap] | [Action] |
| Choice (opt-in / opt-out where applicable)          | [Met / Gap] | [Mechanism]                          | [Gap] | [Action] |
| Access (individual's right to inspect their record) | [Met / Gap] | [Process + form]                     | [Gap] | [Action] |
| Security (cross-ref 800-53 controls)                | [Met / Gap] | [Cross-ref ARC-{P}-NIST-v*]          | [Gap] | [Action] |
| Accountability (designated SAOP, training, audit)   | [Met / Gap] | [SAOP designation; training records] | [Gap] | [Action] |
| Data Quality (accuracy, completeness, timeliness)   | [Met / Gap] | [Validation processes]               | [Gap] | [Action] |
| Transparency (publication of PIA + SORN)            | [Met / Gap] | [Publication URL]                    | [Gap] | [Action] |

---

## 7. Privacy Risk Analysis

| Risk ID | Risk Description                                                  | Likelihood | Impact | Mitigation                                                                  | Residual Risk | Owner             |
| ------- | ----------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------- | ------------- | ----------------- |
| PR-001  | [Unauthorised disclosure of SSN via misconfigured S3 bucket]      | [Low]      | [High] | [SSE-KMS + bucket policy + drift detection + DLP scanning]                  | [Low]         | [Platform team]   |
| PR-002  | [Aggregation enabling re-identification of de-identified records] | [Medium]   | [Med]  | [Differential privacy on aggregated outputs; minimum cell-size suppression] | [Low]         | [Data team]       |
| PR-003  | [Cross-system data flow disclosing PII outside lawful authority]  | [Low]      | [High] | [Data-loss-prevention + interconnection security agreements]                | [Low]         | [Privacy office]  |
| PR-004  | [Retention beyond NARA schedule]                                  | [Medium]   | [Low]  | [Automated retention enforcement; quarterly disposal report]                | [Low]         | [Records officer] |

---

## 8. Mitigation Tracker

| Mitigation ID | Linked Risk | Mitigation Description                | Target Date  | Owner   | Status                        |
| ------------- | ----------- | ------------------------------------- | ------------ | ------- | ----------------------------- |
| MT-001        | PR-001      | [Implement DLP across object storage] | [YYYY-MM-DD] | [Owner] | [Open / In Progress / Closed] |

---

## 9. Agency SAOP Sign-Off

| Sign-Off Item                                                       | SAOP Statement                               |
| ------------------------------------------------------------------- | -------------------------------------------- |
| PII inventory complete and accurate                                 | [Concur / Concur with conditions / Returned] |
| Lawful authority documented for every PII element                   | [Concur / Concur with conditions / Returned] |
| Privacy Act / SORN compliance confirmed                             | [Concur / Concur with conditions / Returned] |
| OMB M-03-22 principles satisfied                                    | [Concur / Concur with conditions / Returned] |
| Privacy risks identified and mitigated to acceptable residual level | [Concur / Concur with conditions / Returned] |

**SAOP Signature**: [Name + signature + date]

---

## 10. Public Posting Plan

| Element                                     | Status                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| PIA approved for public posting?            | [Yes / No — partial redaction]                           |
| If partial redaction, citation of exception | [E.g., 6 USC §1523(b)(3)(C) — law-enforcement-sensitive] |
| Target publication URL                      | [https://www.agency.gov/privacy/pias/...]                |
| Target publication date                     | [YYYY-MM-DD]                                             |
| Linked SORN published in Federal Register   | [Yes — citation / No — pending]                          |

---

## 11. References

| Reference                     | Citation                                                                                     | URL                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-Government Act of 2002 §208 | Privacy Impact Assessment requirement                                                        | <https://www.congress.gov/107/plaws/publ347/PLAW-107publ347.pdf>                                                                                               |
| OMB M-03-22                   | Guidance for Implementing the Privacy Provisions of the E-Government Act of 2002             | <https://www.whitehouse.gov/wp-content/uploads/2017/11/203-M-03-22-OMB-Guidance-for-Implementing-the-Privacy-Provisions-of-the-E-Government-Act-of-2002-1.pdf> |
| Privacy Act of 1974           | 5 USC §552a                                                                                  | <https://www.justice.gov/opcl/privacy-act-1974>                                                                                                                |
| NIST SP 800-122               | Guide to Protecting the Confidentiality of PII                                               | <https://doi.org/10.6028/NIST.SP.800-122>                                                                                                                      |
| OMB Circular A-108            | Federal Agency Responsibilities for Review, Reporting, and Publication under the Privacy Act | <https://www.whitehouse.gov/wp-content/uploads/legacy_drupal_files/omb/circulars/A108/omb_circular_a-108.pdf>                                                  |

---

## 12. Approvals

| Role                                      | Name   | Signature   | Date         |
| ----------------------------------------- | ------ | ----------- | ------------ |
| System Owner                              | [Name] | [Signature] | [YYYY-MM-DD] |
| Privacy Officer                           | [Name] | [Signature] | [YYYY-MM-DD] |
| Senior Agency Official for Privacy (SAOP) | [Name] | [Signature] | [YYYY-MM-DD] |
| Agency General Counsel                    | [Name] | [Signature] | [YYYY-MM-DD] |
| Authorising Official (AO)                 | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-privacy-pia` command **Generated on**:
[DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**:
[AI_MODEL]

<!-- arckit-overlay-template: us-sbom-eo-14028-template.md -->

# EO 14028 Secure-Software Self-Attestation + SBOM

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-sbom-eo-14028`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                                  | Approved By | Approval Date |
| --------- | ------------ | --------- | -------------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-sbom-eo-14028` command | PENDING     | PENDING       |

---

## Executive Summary

[Two paragraphs: software being attested, SSDF practices attested, SBOM
coverage, and submission status to the CISA Repository for Software Attestation
and Artifacts.]

---

## 1. Producer / Software Information

| Field                                       | Value                                             |
| ------------------------------------------- | ------------------------------------------------- |
| **Software Producer (Vendor)**              | [Organisation name]                               |
| **Producer UEI / SAM Identifier**           | [UEI from SAM.gov]                                |
| **Software Product Name**                   | [Product name]                                    |
| **Product Version Attested**                | [Version + build identifier]                      |
| **Software Identifier (CPE / PURL / SWID)** | [Identifier]                                      |
| **Federal Customer (Agency)**               | [Agency receiving the attestation]                |
| **Attestation Scope**                       | [Specific product / all products / version range] |
| **Attestation Type**                        | [Self-attestation / Third-party assessment]       |
| **CISA Form Submission Date**               | [YYYY-MM-DD]                                      |

---

## 2. CISA Self-Attestation Form Fields

Per OMB M-22-18 and M-23-16, complete each field of the CISA Secure Software
Development Attestation Form.

### Section 1 — Software Producer

| Field                              | Value                  |
| ---------------------------------- | ---------------------- |
| Producer name                      | [Name]                 |
| Producer address                   | [Address]              |
| Producer UEI                       | [UEI]                  |
| Producer point of contact          | [Name + email + phone] |
| Signing official (CEO or designee) | [Name + title]         |

### Section 2 — Software Identification

| Field                                   | Value                                          |
| --------------------------------------- | ---------------------------------------------- |
| Software product name                   | [Name]                                         |
| Software version(s)                     | [Version(s)]                                   |
| Software identifier (CPE / PURL / SWID) | [Identifier]                                   |
| Software type                           | [On-prem / Cloud-hosted / Embedded / Firmware] |

### Section 3 — Federal Customer

| Field                   | Value             |
| ----------------------- | ----------------- |
| Agency                  | [Agency]          |
| Contract / Order #      | [Contract number] |
| Agency point of contact | [Name + email]    |

### Section 4 — Attestation Statement

[The signing official affirms that the software is developed in conformance with
the secure development practices identified in Section 5 of this artefact,
derived from NIST SSDF SP 800-218.]

**Signing official**: [Name + title + date + signature]

---

## 3. Secure Development Practices Attested (NIST SSDF SP 800-218)

Map attestation to the four NIST SSDF practice groups: Prepare the Organisation
(PO), Protect the Software (PS), Produce Well-Secured Software (PW), Respond to
Vulnerabilities (RV).

### PO — Prepare the Organisation

| SSDF Practice                                                            | Attested?            | Evidence   |
| ------------------------------------------------------------------------ | -------------------- | ---------- |
| PO.1 Define Security Requirements for Software Development               | [Yes / No / Partial] | [Evidence] |
| PO.2 Implement Roles and Responsibilities                                | [Yes / No / Partial] | [Evidence] |
| PO.3 Implement Supporting Toolchains                                     | [Yes / No / Partial] | [Evidence] |
| PO.4 Define and Use Criteria for Software Security Checks                | [Yes / No / Partial] | [Evidence] |
| PO.5 Implement and Maintain Secure Environments for Software Development | [Yes / No / Partial] | [Evidence] |

### PS — Protect the Software

| SSDF Practice                                                         | Attested?            | Evidence   |
| --------------------------------------------------------------------- | -------------------- | ---------- |
| PS.1 Protect All Forms of Code from Unauthorised Access and Tampering | [Yes / No / Partial] | [Evidence] |
| PS.2 Provide a Mechanism for Verifying Software Release Integrity     | [Yes / No / Partial] | [Evidence] |
| PS.3 Archive and Protect Each Software Release                        | [Yes / No / Partial] | [Evidence] |

### PW — Produce Well-Secured Software

| SSDF Practice                                                                               | Attested?            | Evidence   |
| ------------------------------------------------------------------------------------------- | -------------------- | ---------- |
| PW.1 Design Software to Meet Security Requirements and Mitigate Security Risks              | [Yes / No / Partial] | [Evidence] |
| PW.2 Review the Software Design to Verify Compliance with Security Requirements             | [Yes / No / Partial] | [Evidence] |
| PW.4 Reuse Existing, Well-Secured Software When Feasible                                    | [Yes / No / Partial] | [Evidence] |
| PW.5 Create Source Code by Adhering to Secure Coding Practices                              | [Yes / No / Partial] | [Evidence] |
| PW.6 Configure Compilation, Interpreter, and Build Processes to Improve Executable Security | [Yes / No / Partial] | [Evidence] |
| PW.7 Review and/or Analyse Human-Readable Code to Identify Vulnerabilities                  | [Yes / No / Partial] | [Evidence] |
| PW.8 Test Executable Code to Identify Vulnerabilities and Verify Compliance                 | [Yes / No / Partial] | [Evidence] |
| PW.9 Configure Software to Have Secure Settings by Default                                  | [Yes / No / Partial] | [Evidence] |

### RV — Respond to Vulnerabilities

| SSDF Practice                                                 | Attested?            | Evidence   |
| ------------------------------------------------------------- | -------------------- | ---------- |
| RV.1 Identify and Confirm Vulnerabilities on an Ongoing Basis | [Yes / No / Partial] | [Evidence] |
| RV.2 Assess, Prioritise, and Remediate Vulnerabilities        | [Yes / No / Partial] | [Evidence] |
| RV.3 Analyse Vulnerabilities to Identify Their Root Causes    | [Yes / No / Partial] | [Evidence] |

---

## 4. SBOM Metadata

| Field                    | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| **SBOM Format**          | [CycloneDX 1.5 / SPDX 2.3]                                             |
| **Schema Version**       | [Schema version]                                                       |
| **Generation Tool**      | [Tool name + version — e.g., Syft 0.NN / cdxgen / SPDX SBOM Generator] |
| **Generation Method**    | [Build-time / Source-analysis / Binary-analysis]                       |
| **SBOM Identifier**      | [URN / UUID]                                                           |
| **SBOM Author**          | [Name + organisation]                                                  |
| **Generation Timestamp** | [YYYY-MM-DDTHH:MM:SSZ]                                                 |
| **SBOM Hash**            | [SHA-256 of the SBOM file]                                             |
| **SBOM Location**        | [Repository URL / artefact reference]                                  |

---

## 5. SBOM Minimum Elements Checklist (NTIA)

Per the NTIA "Minimum Elements for a Software Bill of Materials" published
July 2021.

| NTIA Element                                     | Required Value                                | Present? Y/N | Notes   |
| ------------------------------------------------ | --------------------------------------------- | ------------ | ------- |
| Supplier Name                                    | [Vendor producing the component]              | [Y/N]        | [Notes] |
| Component Name                                   | [Component name]                              | [Y/N]        | [Notes] |
| Version of Component                             | [SemVer / vendor-specific version]            | [Y/N]        | [Notes] |
| Other Unique Identifiers (e.g., PURL, CPE, SWID) | [PURL preferred]                              | [Y/N]        | [Notes] |
| Dependency Relationships                         | [Graph of upstream / downstream dependencies] | [Y/N]        | [Notes] |
| Author of SBOM Data                              | [Person / system generating the SBOM]         | [Y/N]        | [Notes] |
| Timestamp (when SBOM was created)                | [Generation timestamp]                        | [Y/N]        | [Notes] |

**Coverage Summary**:

| Metric                                       | Value       |
| -------------------------------------------- | ----------- |
| Total components in SBOM                     | [Count]     |
| Components with full NTIA element coverage   | [Count + %] |
| Components missing one or more NTIA elements | [Count + %] |
| Direct dependencies                          | [Count]     |
| Transitive dependencies                      | [Count]     |

---

## 6. Provenance Attestations

| Field                         | Value                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| **SLSA Level Achieved**       | [SLSA 1 / 2 / 3 / 4]                                        |
| **SLSA Provenance Format**    | [in-toto Statement v1]                                      |
| **Provenance Signed By**      | [Signing identity — Sigstore / GPG key ID]                  |
| **Signature Verified**        | [Yes — verification command + output]                       |
| **Build Platform**            | [GitHub Actions / Tekton Chains / Buildkit / other]         |
| **Build Trigger**             | [Tag / commit SHA]                                          |
| **Builder Identity**          | [Builder image + digest]                                    |
| **In-toto Attestation Chain** | [Chain reference — attesting layers: source, build, deploy] |

[Reference the actual SLSA provenance document / in-toto attestation chain in
`external/` or vendor portal.]

---

## 7. Exception Request

[If a secure development practice cannot be attested, an exception with a Plan
of Action and Milestones (POA&M) is required per M-22-18 / M-23-16.]

**Exception Required?**: [Yes / No]

| Practice Not Attested | Reason                   | POA&M ID   | Remediation Plan | Target Completion |
| --------------------- | ------------------------ | ---------- | ---------------- | ----------------- |
| [SSDF practice]       | [Why cannot be attested] | [POA&M ID] | [Plan]           | [YYYY-MM-DD]      |

---

## 8. Cross-Reference to NIST 800-53 SR (Supply Chain Risk) Family

| 800-53 Control                                  | Mapping                                     | Notes   |
| ----------------------------------------------- | ------------------------------------------- | ------- |
| SR-1 Policy and Procedures                      | [Cross-ref organisational SCRM policy]      | [Notes] |
| SR-2 Supply Chain Risk Management Plan          | [Cross-ref SCRM plan]                       | [Notes] |
| SR-3 Supply Chain Controls and Processes        | [SSDF practices PO + PS]                    | [Notes] |
| SR-4 Provenance                                 | [SLSA provenance + in-toto]                 | [Notes] |
| SR-5 Acquisition Strategies, Tools, and Methods | [Procurement contract clauses]              | [Notes] |
| SR-6 Supplier Assessments and Reviews           | [Vendor security review]                    | [Notes] |
| SR-8 Notification Agreements                    | [Vendor vulnerability-disclosure agreement] | [Notes] |
| SR-11 Component Authenticity                    | [Signed artefacts; signature verification]  | [Notes] |

---

## 9. Distribution

| Recipient                                                     | Submission Method                     | Date         | Reference         |
| ------------------------------------------------------------- | ------------------------------------- | ------------ | ----------------- |
| CISA Repository for Software Attestation and Artifacts (RSAA) | [Form upload via repository.cisa.gov] | [YYYY-MM-DD] | [Submission ID]   |
| Agency Contracting Officer                                    | [Contract delivery]                   | [YYYY-MM-DD] | [Contract / DO #] |
| Agency CISO                                                   | [Email / portal]                      | [YYYY-MM-DD] | [Reference]       |

---

## 10. References

| Reference                      | Citation                                                                                          | URL                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| EO 14028                       | Improving the Nation's Cybersecurity                                                              | <https://www.federalregister.gov/d/2021-10460>                                                                     |
| OMB M-22-18                    | Enhancing the Security of the Software Supply Chain through Secure Software Development Practices | <https://www.whitehouse.gov/wp-content/uploads/2022/09/M-22-18.pdf>                                                |
| OMB M-23-16                    | Update to Memorandum M-22-18                                                                      | <https://www.whitehouse.gov/wp-content/uploads/2023/06/M-23-16-Update-to-M-22-18-Enhancing-Software-Security-.pdf> |
| CISA Self-Attestation Form     | Secure Software Development Attestation Form                                                      | <https://www.cisa.gov/secure-software-attestation-form>                                                            |
| NTIA Minimum Elements for SBOM | The Minimum Elements For a Software Bill of Materials                                             | <https://www.ntia.doc.gov/files/ntia/publications/sbom_minimum_elements_report.pdf>                                |
| NIST SP 800-218                | Secure Software Development Framework (SSDF)                                                      | <https://doi.org/10.6028/NIST.SP.800-218>                                                                          |
| SLSA                           | Supply-chain Levels for Software Artifacts                                                        | <https://slsa.dev/>                                                                                                |
| CycloneDX                      | CycloneDX SBOM Standard                                                                           | <https://cyclonedx.org/>                                                                                           |
| SPDX                           | SPDX SBOM Standard                                                                                | <https://spdx.dev/>                                                                                                |

---

## 11. Approvals

| Role                               | Name           | Signature   | Date         |
| ---------------------------------- | -------------- | ----------- | ------------ |
| Software Producer Signing Official | [Name + title] | [Signature] | [YYYY-MM-DD] |
| Producer Security Officer          | [Name]         | [Signature] | [YYYY-MM-DD] |
| Agency Contracting Officer         | [Name]         | [Signature] | [YYYY-MM-DD] |
| Agency CISO (receipt)              | [Name]         | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-sbom-eo-14028` command **Generated on**:
[DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**:
[AI_MODEL]

<!-- arckit-overlay-template: us-zero-trust-template.md -->

# CISA Zero Trust Maturity Assessment (v2.0)

> **Template Origin**: Community | **ArcKit Version**: [VERSION] | **Command**:
> `/arckit:us-zero-trust`

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time per _partials/RENDERING.md. -->

## Revision History

| Version   | Date         | Author    | Changes                                               | Approved By | Approval Date |
| --------- | ------------ | --------- | ----------------------------------------------------- | ----------- | ------------- |
| [VERSION] | [YYYY-MM-DD] | ArcKit AI | Initial creation from `/arckit:us-zero-trust` command | PENDING     | PENDING       |

---

## Executive Summary

[Two to three paragraphs: scope of the assessment, current overall maturity,
target overall maturity (Advanced is the OMB M-22-09 end-state expectation by
FY2024 across all pillars), top three uplift priorities, and the estimated
effort to reach target.]

---

## 1. Scope

| Field                       | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| **System / Programme**      | [Name]                                                  |
| **Agency**                  | [Agency]                                                |
| **Assessment Date**         | [YYYY-MM-DD]                                            |
| **In-Scope Environments**   | [Cloud / On-prem / Hybrid; named CSPs and data centres] |
| **Out-of-Scope**            | [Anything explicitly excluded]                          |
| **Assessment Lead**         | [Name + role]                                           |
| **OMB M-22-09 Target Date** | [Original FY2024 — current re-baselined date if any]    |

---

## 2. Five-Pillar Scoring Matrix

Score current and target maturity for each of the five CISA ZTMM pillars.

| Pillar                       | Traditional   | Initial       | Advanced      | Optimal       | Current | Target  |
| ---------------------------- | ------------- | ------------- | ------------- | ------------- | ------- | ------- |
| **Identity**                 | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |
| **Devices**                  | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |
| **Networks**                 | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |
| **Applications & Workloads** | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |
| **Data**                     | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |

### Pillar Stage Reference

- **Traditional**: Manual processes, perimeter-centric, broad implicit trust.
- **Initial**: Some automation; basic visibility; least-privilege beginning.
- **Advanced**: Risk-informed adaptive controls; broad telemetry; automated
  policy enforcement.
- **Optimal**: Continuous adaptive risk-and-trust evaluation across all pillars;
  dynamic policy.

---

## 3. Cross-Cut Scoring Matrix

CISA ZTMM v2.0 cross-cutting capabilities applied across all five pillars.

| Cross-Cut                      | Traditional   | Initial       | Advanced      | Optimal       | Current | Target  |
| ------------------------------ | ------------- | ------------- | ------------- | ------------- | ------- | ------- |
| **Visibility & Analytics**     | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |
| **Automation & Orchestration** | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |
| **Governance**                 | [Description] | [Description] | [Description] | [Description] | [Stage] | [Stage] |

---

## 4. Maturity Heatmap

### 4.1 Summary by Pillar and Cross-Cut

| Dimension                  | Current Overall | Target Overall | Gap   |
| -------------------------- | --------------- | -------------- | ----- |
| Identity                   | [Stage]         | [Stage]        | [Gap] |
| Devices                    | [Stage]         | [Stage]        | [Gap] |
| Networks                   | [Stage]         | [Stage]        | [Gap] |
| Applications & Workloads   | [Stage]         | [Stage]        | [Gap] |
| Data                       | [Stage]         | [Stage]        | [Gap] |
| Visibility & Analytics     | [Stage]         | [Stage]        | [Gap] |
| Automation & Orchestration | [Stage]         | [Stage]        | [Gap] |
| Governance                 | [Stage]         | [Stage]        | [Gap] |

**Overall Current Maturity**: [Stage] · **Overall Target Maturity**: [Advanced —
OMB M-22-09]

### 4.2 Function Heatmap — Current State

One row per pillar, one cell per ZTMM v2.0 function (Tables 2–7 of the model).
Cell code: **T** Traditional · **I** Initial · **A** Advanced · **O** Optimal ·
**—** no such function in that row. Each code must match the function scores in
Section 5 and, for the Cross-Cutting Capabilities row, Section 3. The last three
columns are the Visibility & Analytics, Automation & Orchestration and
Governance capabilities the model scores within each pillar.

| Pillar                         | Function 1                                            | Function 2                                      | Function 3                         | Function 4                                                      | Function 5                              | Visibility & Analytics | Automation & Orchestration | Governance |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- | --------------------------------------- | ---------------------- | -------------------------- | ---------- |
| **Identity**                   | Authentication: [T/I/A/O]                             | Identity Stores: [T/I/A/O]                      | Risk Assessments: [T/I/A/O]        | Access Management: [T/I/A/O]                                    | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Devices**                    | Policy Enforcement & Compliance Monitoring: [T/I/A/O] | Asset & Supply Chain Risk Management: [T/I/A/O] | Resource Access: [T/I/A/O]         | Device Threat Protection: [T/I/A/O]                             | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Networks**                   | Network Segmentation: [T/I/A/O]                       | Network Traffic Management: [T/I/A/O]           | Traffic Encryption: [T/I/A/O]      | Network Resilience: [T/I/A/O]                                   | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Applications & Workloads**   | Application Access: [T/I/A/O]                         | Application Threat Protections: [T/I/A/O]       | Accessible Applications: [T/I/A/O] | Secure Application Development & Deployment Workflow: [T/I/A/O] | Application Security Testing: [T/I/A/O] | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Data**                       | Data Inventory Management: [T/I/A/O]                  | Data Categorization: [T/I/A/O]                  | Data Availability: [T/I/A/O]       | Data Access: [T/I/A/O]                                          | Data Encryption: [T/I/A/O]              | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Cross-Cutting Capabilities** | —                                                     | —                                               | —                                  | —                                                               | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |

### 4.3 Function Heatmap — Target State

Same rows and columns as 4.2, with the target stage for each function. No target
may sit below its current stage.

| Pillar                         | Function 1                                            | Function 2                                      | Function 3                         | Function 4                                                      | Function 5                              | Visibility & Analytics | Automation & Orchestration | Governance |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- | --------------------------------------- | ---------------------- | -------------------------- | ---------- |
| **Identity**                   | Authentication: [T/I/A/O]                             | Identity Stores: [T/I/A/O]                      | Risk Assessments: [T/I/A/O]        | Access Management: [T/I/A/O]                                    | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Devices**                    | Policy Enforcement & Compliance Monitoring: [T/I/A/O] | Asset & Supply Chain Risk Management: [T/I/A/O] | Resource Access: [T/I/A/O]         | Device Threat Protection: [T/I/A/O]                             | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Networks**                   | Network Segmentation: [T/I/A/O]                       | Network Traffic Management: [T/I/A/O]           | Traffic Encryption: [T/I/A/O]      | Network Resilience: [T/I/A/O]                                   | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Applications & Workloads**   | Application Access: [T/I/A/O]                         | Application Threat Protections: [T/I/A/O]       | Accessible Applications: [T/I/A/O] | Secure Application Development & Deployment Workflow: [T/I/A/O] | Application Security Testing: [T/I/A/O] | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Data**                       | Data Inventory Management: [T/I/A/O]                  | Data Categorization: [T/I/A/O]                  | Data Availability: [T/I/A/O]       | Data Access: [T/I/A/O]                                          | Data Encryption: [T/I/A/O]              | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |
| **Cross-Cutting Capabilities** | —                                                     | —                                               | —                                  | —                                                               | —                                       | [T/I/A/O]              | [T/I/A/O]                  | [T/I/A/O]  |

---

## 5. Pillar-Specific Findings

Score every ZTMM v2.0 function in each pillar, including the pillar's own
Visibility & Analytics, Automation & Orchestration and Governance capabilities.
Stages: Traditional / Initial / Advanced / Optimal.

### 5.1 Identity

**Current State**: [Describe IdP, MFA posture, account lifecycle,
phishing-resistant authenticator coverage, privileged access management.]

| Function                   | Current Stage | Evidence        | Target Stage | Gap Actions |
| -------------------------- | ------------- | --------------- | ------------ | ----------- |
| Authentication             | [Stage]       | [1–2 sentences] | [Stage]      | [Actions]   |
| Identity Stores            | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Risk Assessments           | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Access Management          | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Visibility & Analytics     | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Automation & Orchestration | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Governance                 | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |

**Uplift Opportunities**:

- [ ] Adopt phishing-resistant MFA (PIV / FIDO2 WebAuthn) for all users.
- [ ] Continuous identity-risk evaluation tied to step-up authentication.
- [ ] Just-in-time privileged access with full session recording.
- [Other]

### 5.2 Devices

**Current State**: [Describe device inventory, EDR coverage, device-health
attestation, BYOD posture.]

| Function                                   | Current Stage | Evidence        | Target Stage | Gap Actions |
| ------------------------------------------ | ------------- | --------------- | ------------ | ----------- |
| Policy Enforcement & Compliance Monitoring | [Stage]       | [1–2 sentences] | [Stage]      | [Actions]   |
| Asset & Supply Chain Risk Management       | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Resource Access                            | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Device Threat Protection                   | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Visibility & Analytics                     | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Automation & Orchestration                 | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Governance                                 | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |

**Uplift Opportunities**:

- [ ] Real-time device-health attestation as a condition of access (NIST SP
      800-207 §2.1).
- [ ] EDR on 100% of endpoints per EO 14028.
- [ ] Mobile-device management (MDM) integration with policy decision point.
- [Other]

### 5.3 Networks

**Current State**: [Describe segmentation strategy, east-west encryption
posture, micro-segmentation maturity, software-defined perimeter adoption.]

| Function                   | Current Stage | Evidence        | Target Stage | Gap Actions |
| -------------------------- | ------------- | --------------- | ------------ | ----------- |
| Network Segmentation       | [Stage]       | [1–2 sentences] | [Stage]      | [Actions]   |
| Network Traffic Management | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Traffic Encryption         | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Network Resilience         | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Visibility & Analytics     | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Automation & Orchestration | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Governance                 | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |

**Uplift Opportunities**:

- [ ] Micro-segmentation per workload identity.
- [ ] Encrypt all east-west traffic (mTLS / SMB encryption / IPsec).
- [ ] Replace VPN with identity-aware proxy / service-mesh ingress.
- [Other]

### 5.4 Applications & Workloads

**Current State**: [Describe workload identity, secrets management,
application-layer authentication, runtime protection.]

| Function                                             | Current Stage | Evidence        | Target Stage | Gap Actions |
| ---------------------------------------------------- | ------------- | --------------- | ------------ | ----------- |
| Application Access                                   | [Stage]       | [1–2 sentences] | [Stage]      | [Actions]   |
| Application Threat Protections                       | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Accessible Applications                              | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Secure Application Development & Deployment Workflow | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Application Security Testing                         | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Visibility & Analytics                               | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Automation & Orchestration                           | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Governance                                           | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |

**Uplift Opportunities**:

- [ ] Workload identity per service (SPIFFE / X.509 SVIDs).
- [ ] Secrets management via vault with short-lived dynamic credentials.
- [ ] Runtime application self-protection (RASP) / web application firewall
      (WAF).
- [Other]

### 5.5 Data

**Current State**: [Describe data classification, encryption-at-rest, DLP,
data-access monitoring.]

| Function                   | Current Stage | Evidence        | Target Stage | Gap Actions |
| -------------------------- | ------------- | --------------- | ------------ | ----------- |
| Data Inventory Management  | [Stage]       | [1–2 sentences] | [Stage]      | [Actions]   |
| Data Categorization        | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Data Availability          | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Data Access                | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Data Encryption            | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Visibility & Analytics     | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Automation & Orchestration | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |
| Governance                 | [Stage]       | [Evidence]      | [Stage]      | [Actions]   |

**Uplift Opportunities**:

- [ ] Automated data classification at ingest.
- [ ] Encryption with FIPS 140-3 validated modules; customer-managed keys for
      high-impact data.
- [ ] Data-access analytics (UEBA on data plane).
- [Other]

---

## 6. Cross-Cut Findings

### 6.1 Visibility & Analytics

**Current State**: [SIEM coverage, telemetry pipelines, UEBA, dashboards.]

**Uplift Opportunities**:

- [ ] Unified telemetry across identity, device, network, application, data
      planes.
- [ ] ML-driven anomaly detection.
- [Other]

### 6.2 Automation & Orchestration

**Current State**: [SOAR adoption, automated incident response, policy-as-code
maturity.]

**Uplift Opportunities**:

- [ ] Automated response playbooks for top-N incident types.
- [ ] Policy-as-code with version control and CI gates.
- [Other]

### 6.3 Governance

**Current State**: [Policy ownership, audit cadence, control attestation
maturity.]

**Uplift Opportunities**:

- [ ] Continuous control monitoring with OSCAL.
- [ ] Quarterly ZT maturity re-assessment integrated into ConMon.
- [Other]

---

## 7. Prioritised Uplift Roadmap

| Initiative                       | Pillar(s)          | Target Stage | Estimated Effort (FTE-months) | Dependencies                          | Owner           | Target Date  |
| -------------------------------- | ------------------ | ------------ | ----------------------------- | ------------------------------------- | --------------- | ------------ |
| Roll out phishing-resistant MFA  | [Identity]         | [Advanced]   | [N]                           | [PIV / FIDO2 IdP capability]          | [Identity team] | [YYYY-MM-DD] |
| Deploy EDR enterprise-wide       | [Devices]          | [Advanced]   | [N]                           | [EDR procurement; FedRAMP-authorised] | [SecOps]        | [YYYY-MM-DD] |
| Micro-segmentation pilot         | [Networks]         | [Advanced]   | [N]                           | [Service-mesh selection]              | [Platform team] | [YYYY-MM-DD] |
| Workload-identity pilot (SPIFFE) | [Apps & Workloads] | [Advanced]   | [N]                           | [Service-mesh]                        | [Platform team] | [YYYY-MM-DD] |
| Data classification automation   | [Data]             | [Advanced]   | [N]                           | [Classifier tooling; data inventory]  | [Data team]     | [YYYY-MM-DD] |
| Telemetry unification            | [Visibility]       | [Advanced]   | [N]                           | [SIEM / data-lake selection]          | [SOC]           | [YYYY-MM-DD] |

---

## 8. Alignment to OMB M-22-09 End-State

| OMB M-22-09 Action                                                   | Status                                | Notes   |
| -------------------------------------------------------------------- | ------------------------------------- | ------- |
| Enforce phishing-resistant MFA for federal staff and contractors     | [Implemented / In progress / Planned] | [Notes] |
| Encrypt all DNS requests + HTTP traffic                              | [Implemented / In progress / Planned] | [Notes] |
| Inventory every device authorised + operated; treat as untrusted     | [Implemented / In progress / Planned] | [Notes] |
| Reliable asset + vulnerability management; EDR per CISA OMB guidance | [Implemented / In progress / Planned] | [Notes] |
| Categorize data by sensitivity; encrypt accordingly                  | [Implemented / In progress / Planned] | [Notes] |
| Application security testing throughout SDLC                         | [Implemented / In progress / Planned] | [Notes] |

---

## 9. NIST SP 800-53 Rev 5 Control Linkage

Map every ZTMM function to the NIST SP 800-53 Rev 5 controls that evidence it,
and record each control's status in the NIST 800-53 artefact
(`ARC-{P}-NIST-v*`). Flag for re-tailoring any control whose function sits below
its target stage, or that the artefact does not yet carry. Three rows carry
example control IDs; replace every row with the system's own mapping.

| Pillar / Cross-Cut       | ZTMM Function                                        | NIST SP 800-53 Rev 5 Controls             | Status in NIST Artefact                                        | Re-tailoring Needed? |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- | -------------------- |
| Identity                 | Authentication                                       | [e.g. IA-2, IA-2(1), IA-2(2), IA-5, IA-8] | [Implemented / Inherited / Hybrid / Planned / Not in artefact] | [Yes / No — reason]  |
| Identity                 | Identity Stores                                      | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Identity                 | Risk Assessments                                     | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Identity                 | Access Management                                    | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Devices                  | Policy Enforcement & Compliance Monitoring           | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Devices                  | Asset & Supply Chain Risk Management                 | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Devices                  | Resource Access                                      | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Devices                  | Device Threat Protection                             | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Networks                 | Network Segmentation                                 | [e.g. SC-7, SC-7(4), SC-7(5), SC-7(8)]    | [Status]                                                       | [Yes / No]           |
| Networks                 | Network Traffic Management                           | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Networks                 | Traffic Encryption                                   | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Networks                 | Network Resilience                                   | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Applications & Workloads | Application Access                                   | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Applications & Workloads | Application Threat Protections                       | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Applications & Workloads | Accessible Applications                              | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Applications & Workloads | Secure Application Development & Deployment Workflow | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Applications & Workloads | Application Security Testing                         | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Data                     | Data Inventory Management                            | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Data                     | Data Categorization                                  | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Data                     | Data Availability                                    | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Data                     | Data Access                                          | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Data                     | Data Encryption                                      | [e.g. SC-13, SC-28, SC-28(1)]             | [Status]                                                       | [Yes / No]           |
| Cross-Cut                | Visibility & Analytics                               | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Cross-Cut                | Automation & Orchestration                           | [Control IDs]                             | [Status]                                                       | [Yes / No]           |
| Cross-Cut                | Governance                                           | [Control IDs]                             | [Status]                                                       | [Yes / No]           |

---

## 10. References

| Reference       | Citation                                                              | URL                                                                 |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| CISA ZTMM v2.0  | Zero Trust Maturity Model v2.0                                        | <https://www.cisa.gov/zero-trust-maturity-model>                    |
| OMB M-22-09     | Moving the U.S. Government Toward Zero Trust Cybersecurity Principles | <https://www.whitehouse.gov/wp-content/uploads/2022/01/M-22-09.pdf> |
| NIST SP 800-207 | Zero Trust Architecture                                               | <https://doi.org/10.6028/NIST.SP.800-207>                           |
| EO 14028        | Improving the Nation's Cybersecurity                                  | <https://www.federalregister.gov/d/2021-10460>                      |

---

## 11. Approvals

| Role            | Name   | Signature   | Date         |
| --------------- | ------ | ----------- | ------------ |
| Assessment Lead | [Name] | [Signature] | [YYYY-MM-DD] |
| CISO            | [Name] | [Signature] | [YYYY-MM-DD] |
| CIO             | [Name] | [Signature] | [YYYY-MM-DD] |

---

**Generated by**: ArcKit `/arckit:us-zero-trust` command **Generated on**:
[DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**:
[AI_MODEL]
