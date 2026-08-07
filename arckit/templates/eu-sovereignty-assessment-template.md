# EU Cloud Sovereignty Assessment

> **Template Origin**: Community Overlay (nl-gov) | **ArcKit Version**:
> [VERSION] | **Command**: `/arckit:eu-sovereignty`

> ⚠️ **NOT OFFICIALLY VALIDATED.** This is a community jurisdiction overlay
> template for the ArcKit swamp port. It is not reviewed or endorsed by the
> European Commission, EZK, BZK, the NDS Cloudprogramma, or any Dutch government
> body. **Verify every citation against the primary source before relying on
> this document for a real procurement or tender decision.** **This template
> records an ASSESSMENT, not a CERTIFICATION** — see §3.

## Document Control

<!-- DOC-CONTROL-HEADER -->
<!-- Resolved at command-execution time to _partials/document-control-nl.md (default for the nl-gov profile), or _partials/document-control-uk.md / _partials/document-control-uae.md based on plugin userConfig classification_scheme + governance_framework. See _partials/RENDERING.md (when present). -->

## Revision History

| Version   | Date   | Author    | Changes                                                | Approved By | Approval Date |
| --------- | ------ | --------- | ------------------------------------------------------ | ----------- | ------------- |
| [VERSION] | [DATE] | ArcKit AI | Initial creation from `/arckit:eu-sovereignty` command | [PENDING]   | [PENDING]     |

## Legal & Policy Grounding

| Instrument                                                      | Date / Reference                                       | Relevance                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **EU Cloud Sovereignty Framework v1.2.1**                       | European Commission, **October 2025**                  | Primary scoring instrument for this document — 8 objectives, SEAL0–4, score formula.            |
| **Notitie: Verkenning Overheidsbrede Soevereine Clouddiensten** | NDS Cloudprogramma, v1.0, **11 juni 2026**, definitief | Dutch adoption of the EU CSF as its official sovereignty yardstick — see §2.                    |
| **OBDO Cloud definities en begrippenlijst**                     | Approved **16 april 2026**                             | Definitional deference (via `nl-cloud-assessment-template.md`).                                 |
| **Herziening rijksbreed cloudbeleid 2026**                      | Ministerie van EZK, 3 juli 2026, definitief            | Cites the EU CSF as its sovereignty measure — see `nl-cloud-assessment-template.md`.            |
| **Kamerstukken II 2024/25, 36 574, nr. 5**                      | —                                                      | Tweede Kamer wish: ≥30% of Rijksoverheid cloud services from Nederlands-Europese bodem by 2029. |

**Related drivers** (named in the approved plan's source research; **not
detailed in this template beyond title** — read the primary source before citing
their content): Nationale Digitaliseringsstrategie (NDS); Visie Digitale
Autonomie en Soevereiniteit van de Overheid; Cybersecuritybeeld Nederland
(CSBN) 2025.

## Document Purpose

[Brief description: this document records a Sovereignty Score for [SUBJECT — the
cloud service or provider under assessment] against the EU Cloud Sovereignty
Framework v1.2.1, with per-objective evidence, and checks that score against any
caller-supplied minimum SEAL floors from the tender/requirement.]

---

## Executive Summary

**Subject assessed**: [SERVICE OR PROVIDER NAME]

**Sovereignty Score**: **[SCORE]** / 100

**Floors evaluated?**: [Yes — floors supplied by the tender/requirement in §5 /
No — no floor check performed]

**Floors passed?**: [PASS / FAIL — objective(s) below floor: list, or "n/a"]

**Headline SEAL achieved (lowest across scored objectives)**: [SEAL0 / SEAL1 /
SEAL2 / SEAL3 / SEAL4]

> This is a computed score from operator-supplied evidence, **not a
> certification**. See §3 and §8 before using this score in a procurement
> decision.

---

## 1. Framework Overview

The EU Cloud Sovereignty Framework v1.2.1 (European Commission, October 2025)
scores a cloud service/provider against **eight weighted Sovereignty
Objectives**, summing to exactly 100%:

| Objective | Name                         | Weight   |
| --------- | ---------------------------- | -------- |
| SOV-1     | Strategic                    | 15%      |
| SOV-2     | Legal & Jurisdictional       | 10%      |
| SOV-3     | Data & AI                    | 10%      |
| SOV-4     | Operational                  | 15%      |
| SOV-5     | Supply Chain                 | 20%      |
| SOV-6     | Technology                   | 15%      |
| SOV-7     | Security & Compliance        | 10%      |
| SOV-8     | Environmental Sustainability | 5%       |
| **Total** |                              | **100%** |

**Score formula**: for each objective,
`contribution = (score / maxScore) *
weight`, rounded to 2 decimal places; the
total **Sovereignty Score** is the sum of all eight contributions.

**SEAL0–SEAL4** (Sovereignty Effectiveness Assurance Level) — official Dutch
renderings from the Verkenning notitie (§2):

| SEAL  | English                    | Officiële Nederlandse benaming    |
| ----- | -------------------------- | --------------------------------- |
| SEAL0 | No sovereignty             | Geen soevereiniteit               |
| SEAL1 | Jurisdictional sovereignty | Jurisdictionele soevereiniteit    |
| SEAL2 | Data sovereignty           | Data-soevereiniteit               |
| SEAL3 | Digital resilience         | Digitale veerkracht               |
| SEAL4 | Full digital sovereignty   | Volledige digitale soevereiniteit |

**Minimum SEAL per objective is set by the requirement/tender — never by the
framework itself.** Do not hardcode a floor here; record the tender-supplied
floor(s) in §5.

---

## 2. Dutch Adoption (Verkenning Overheidsbrede Soevereine Clouddiensten, 11 juni 2026)

The NDS Cloudprogramma's Verkenning notitie (v1.0, 11 juni 2026, definitief)
adopts the EU CSF as **"de maat van soevereiniteit"** (the measure of
sovereignty) for Dutch government cloud policy:

- **SEAL4 is the stated doelstelling** (objective) for the overheidsbrede
  soevereine clouddienst.
- SEAL is used **demand-side**: e.g. "een werkplek op SEAL3 vereist dan het
  gebruiken van clouddienst die tenminste ook SEAL3 behaalt" — a consuming
  workload's required SEAL sets a minimum floor on the clouddienst it may use.
  Record any such demand-side floor in §5.
- The sovereign cloud is to be housed in **existing ODC's** (Overheids
  Datacenters).
- A proof-of-concept is planned at **Digilab**.
- Design must satisfy **BIO2, Cbw and NIS2 from the start** (not retrofitted).
- The target platform is an **open source, Haven-compliant container platform**.

| Dutch-adoption fact                                             | Applies to this assessment? |
| --------------------------------------------------------------- | --------------------------- |
| Demand-side SEAL floor from a consuming workload                | [Ja/Nee — value: SEAL_]     |
| Subject is/relates to the overheidsbrede soevereine clouddienst | [Ja/Nee]                    |
| Housed in an existing ODC                                       | [Ja/Nee]                    |
| BIO2/Cbw/NIS2-by-design confirmed                               | [Ja/Nee]                    |
| Haven-compliant open source container platform                  | [Ja/Nee/N.v.t.]             |

---

## 3. Evidence Standard (read before scoring)

> **This template does NOT cite vendor-analyst market reports (Gartner or
> similar) as evidence — not even a study annexed to a government notitie.** One
> of the headline claims in the study annexed to the Verkenning notitie is
> itself footnoted to a LinkedIn post; analyst quadrant/market-positioning
> claims are not a sound basis for a compliance record.

Instead, evidence for each objective must be **observable and checkable**,
derived from the EU CSF's own per-objective **contributing factors**:

- Who holds **decisive authority** over the service (ownership, control, ability
  to compel changes)?
- Which **legal system** governs the service's operations and contracts?
- Does the **customer alone** hold cryptographic access (key management)?
- Where do **support staff** sit, and under which jurisdiction?
- What is the **provenance** of hardware, firmware and software, including
  sub-suppliers?
- Do the **APIs and licences** permit exit (data portability, no
  lock-in-by-design)?

**A supplier's self-declared SEAL is an UNVERIFIED CLAIM until the assessor
records evidence per objective.** This document is not valid evidence for a SEAL
claim until every scored objective's `evidence` field below is filled with
something checkable against the factors above — not a vendor marketing
statement.

---

## 4. Per-Objective Scoring (with Evidence Column)

Score exactly the eight objectives SOV-1..SOV-8, any order. `score` and
`maxScore` are caller-defined for this assessment's rubric (e.g. a 0–10 scale
per sub-criterion, summed); `seal`, if assessed, is one of SEAL0–SEAL4.

| Objective | Name                         | Score | Max Score | Weight | Contribution | Achieved SEAL | Evidence (contributing factors, §3 — NOT a vendor report)                     |
| --------- | ---------------------------- | ----- | --------- | ------ | ------------ | ------------- | ----------------------------------------------------------------------------- |
| SOV-1     | Strategic                    | [n]   | [n]       | 15     | [computed]   | [SEALn]       | [Who holds decisive authority over the service, and how was that established] |
| SOV-2     | Legal & Jurisdictional       | [n]   | [n]       | 10     | [computed]   | [SEALn]       | [Which legal system governs operations and contracts]                         |
| SOV-3     | Data & AI                    | [n]   | [n]       | 10     | [computed]   | [SEALn]       | [Cryptographic key holder; data/AI model residency]                           |
| SOV-4     | Operational                  | [n]   | [n]       | 15     | [computed]   | [SEALn]       | [Support-staff location and jurisdiction]                                     |
| SOV-5     | Supply Chain                 | [n]   | [n]       | 20     | [computed]   | [SEALn]       | [Hardware/firmware/software provenance incl. sub-suppliers]                   |
| SOV-6     | Technology                   | [n]   | [n]       | 15     | [computed]   | [SEALn]       | [Technology stack sovereignty — open standards, dependency chain]             |
| SOV-7     | Security & Compliance        | [n]   | [n]       | 10     | [computed]   | [SEALn]       | [BIO2/Cbw/NIS2 conformance evidence — cross-ref `nl-bio`]                     |
| SOV-8     | Environmental Sustainability | [n]   | [n]       | 5      | [computed]   | [SEALn]       | [Energy/carbon evidence for the hosting facility]                             |

**Weight sum check**: 15 + 10 + 10 + 15 + 20 + 15 + 10 + 5 = **100** ✓ — flag
and stop if this template's copy of the weights above has been edited to
anything else.

**API/licence exit check** (last contributing factor, §3): [Do the APIs and
licences permit exit? Ja/Nee — evidence]

---

## 5. Minimum SEAL Floors (Caller-Supplied)

Floors are **never hardcoded by the framework or this template** — they come
from the tender specification or, per §2, a consuming workload's demand-side
requirement.

| Objective | Minimum SEAL floor | Source of the floor                 |
| --------- | ------------------ | ----------------------------------- |
| SOV-1     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-2     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-3     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-4     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-5     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-6     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-7     | [SEALn or "none"]  | [Tender ref / demand-side workload] |
| SOV-8     | [SEALn or "none"]  | [Tender ref / demand-side workload] |

If no floors apply, omit `sealFloors` from the method call in §6 entirely —
omitting it performs no floor check, rather than passing an empty/permissive
floor.

---

## 6. `euSovereigntyScore` Method Call

```bash
swamp model method run governance euSovereigntyScore \
  --input subject="[SERVICE OR PROVIDER NAME]" --input project="[PROJECT_DIR]" \
  --input objectives='[
    {"id":"SOV-1","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-2","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-3","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-4","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-5","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-6","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-7","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"},
    {"id":"SOV-8","score":[n],"maxScore":[n],"seal":"[SEALn]","evidence":"[...]"}
  ]' \
  --input sealFloors='{"SOV-5":"SEAL3"}'   # omit entirely if no floors apply
```

The method **fail-closes**: it rejects a missing objective, a negative score, a
score exceeding its `maxScore`, or a `maxScore <= 0` — fix the input in §4
rather than expecting the method to tolerate it.

---

## 7. Result

| Field                  | Value             |
| ---------------------- | ----------------- |
| Sovereignty Score      | [SCORE]           |
| Floors evaluated?      | [true/false]      |
| Floors passed?         | [true/false]      |
| Objectives below floor | [List, or "none"] |
| Assessed at            | [TIMESTAMP]       |

---

## 8. Assessment, Not Certification

This document — and the `euSovereigntyScore` method that backs it — **computes
and reports; it does not certify.** The written record carries no
attestation/certification field. Treat the Sovereignty Score as an input to a
procurement decision, subject to the same scrutiny as any other self-reported
technical claim, and re-run this assessment when the underlying facts
(ownership, jurisdiction, key management, staff location, supply chain, exit
terms) change materially.

---

## Sign-Off

| Role                     | Name   | Date | Signature |
| ------------------------ | ------ | ---- | --------- |
| Author / Assessor        | [Name] |      |           |
| Procurement lead         | [Name] |      |           |
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

**Generated by**: ArcKit `/arckit:eu-sovereignty` command **Generated on**:
[DATE] **ArcKit Version**: [VERSION] **Project**: [PROJECT_NAME] **Model**:
[AI_MODEL]
